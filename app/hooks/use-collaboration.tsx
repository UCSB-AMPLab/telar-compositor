/**
 * This file is the React context and provider for Yjs collaborative
 * editing — every authenticated route sits inside its provider, so
 * components below can pull the shared `Y.Doc`, awareness state,
 * presence colour, and publishing lock from one place.
 *
 * Provides a `Y.Doc` and `WebsocketProvider` to all child routes
 * via React context. The WebSocket connects to the
 * `ProjectCollaborationDO` at `/ws/:projectId` on mount and
 * disconnects on unmount. Offline edits queue automatically via
 * y-websocket's built-in reconnect/backoff behaviour.
 *
 * @version v1.5.0-beta
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import * as decoding from "lib0/decoding";
import { useTranslation } from "react-i18next";
import { useToast } from "~/hooks/use-toast";
import { createUndoManager } from "~/lib/undo-manager";
import { watchLiveness } from "~/lib/connection-liveness";
import { watchPresenceExpiry } from "~/lib/presence-expiry";
import {
  EMPTY_FREEZE_VIEW,
  applyFreezeFrame,
  dismissFreezeError,
  expireFreeze,
  nextFreezeDeadline,
  parseFreezeFrame,
  readFreezeView,
  readLockHolder,
  type FreezeFrame,
  type FreezeKind,
  type FreezeView,
} from "~/lib/freeze-view";

// Bespoke session-control protocol (mirrors workers/collaboration.ts).
// Wire format = varuint(2) + uint8(subtype). Server→client only.
//
// Note on y-websocket compatibility: y-websocket's own dispatch reserves
// index 2 for `messageAuth` (server-sent auth-deny). Telar's server never
// sends auth messages on the WS — auth is a one-shot cookie/token check at
// the upgrade step, after which the socket is either accepted or refused
// with HTTP 401. Replacing `provider.messageHandlers[2]` is therefore safe
// in this codebase; the override is installed by
// `installSessionControlHandler` below.
//
// This was verified against the vendored y-websocket source on 2026-05-10
// and is now pinned by tests (tests/y-websocket-slot-pin.test.ts, added
// 2026-07-06): the reserved slot index, the per-instance handler array, and
// the installed package version are all asserted against the real
// y-websocket. A future upgrade that renumbers the auth slot or reshapes the
// handler array therefore fails CI instead of silently dropping eviction
// notifications — the previous failure mode had no throw and no console line.
const MSG_SESSION_CONTROL = 2;
const SUB_PROJECT_DELETED = 0x01;
const SUB_REMOVED_FROM_PROJECT = 0x02;
// The server has rebuilt this project's document from D1. The document held
// here predates that rebuild and must not reach the server: y-websocket
// reconnects after any close code and answers the server's sync step 1 with
// everything it still holds, which merges the discarded state straight back in.
// Both subtypes below carry a varuint generation after the subtype byte.
const SUB_STATE_RESET = 0x03;
// The generation the document just received belongs to. Echoed back as `?gen=`
// on every later connection so the server can recognise a document from before
// a reset — including one held by a client that was offline throughout the
// reset and so never saw SUB_STATE_RESET.
const SUB_DOC_GENERATION = 0x04;
// The freeze leases standing on this project and the operations that ended
// recently, as a JSON string after the subtype byte (`~/lib/freeze-view`).
// The only source this client reads a freeze from.
const SUB_FREEZE = 0x05;
/**
 * Connection query-string parameter declaring this client's awareness client
 * id, which is the one entry the server lets this socket set. Kept in step
 * with `workers/collaboration.ts`.
 */
const AWARENESS_CLIENT_PARAM = "aw";
/** Connection query-string parameter carrying the generation above. */
const GENERATION_PARAM = "gen";
// What this client presents for a document it has just built and has not yet
// synced. The server refuses a socket that claims nothing once the project has
// been reset, because a stale document and a fresh one both arrive silent;
// stating the claim is what keeps a first connection, a new tab and the
// post-reset rebuild admissible. Kept in step with `workers/collaboration.ts`.
const FRESH_DOCUMENT_GENERATION = "new";

/**
 * Install the session-control handler onto a WebsocketProvider's per-instance
 * `messageHandlers` array, claiming the reserved `messageAuth` slot (index 2).
 * See the compatibility notes above for why that is safe in this codebase.
 *
 * The install is a deliberate no-op when the array is absent: some test
 * harnesses mock `WebsocketProvider` without a `messageHandlers` property, and
 * skipping is preferable to crashing those suites — production always ships the
 * real provider with its pre-populated handler array.
 *
 * Exported so the slot-pin tests can drive this exact code against both a real
 * provider and a provider-shaped fixture; the assumptions it rests on are
 * otherwise unguarded and fail silently.
 */
export function installSessionControlHandler(
  provider: Pick<WebsocketProvider, "messageHandlers">,
  callbacks: {
    onProjectDeleted: () => void;
    onRemovedFromProject: () => void;
    onStateReset: (generation: number | null) => void;
    onDocGeneration: (generation: number) => void;
    onFreeze?: (frame: FreezeFrame) => void;
  },
): void {
  const handlers = provider.messageHandlers;
  if (!Array.isArray(handlers)) return;
  handlers[MSG_SESSION_CONTROL] = (
    _encoder,
    decoder,
    _provider,
    emitSynced,
    _messageType,
  ) => {
    const subtype = decoding.readUint8(decoder);
    // The trailing generation is read defensively: a frame that carries none,
    // or a truncated one, still has to dispatch. Dropping a state-reset frame
    // over a malformed tail would leave the discarded document connected.
    const readGeneration = (): number | null => {
      try {
        return decoding.readVarUint(decoder);
      } catch {
        return null;
      }
    };
    if (subtype === SUB_PROJECT_DELETED) {
      callbacks.onProjectDeleted();
    } else if (subtype === SUB_REMOVED_FROM_PROJECT) {
      callbacks.onRemovedFromProject();
    } else if (subtype === SUB_STATE_RESET) {
      callbacks.onStateReset(readGeneration());
    } else if (subtype === SUB_DOC_GENERATION) {
      const generation = readGeneration();
      if (generation !== null) callbacks.onDocGeneration(generation);
    } else if (subtype === SUB_FREEZE && emitSynced) {
      // Only from the socket: y-websocket runs BroadcastChannel messages
      // through these same handlers with `emitSynced` false, and a freeze
      // another tab could raise or end would be one the server did not hold.
      // The provider is built with BroadcastChannel off; this holds if it is
      // ever turned on.
      let json: string | null = null;
      try {
        json = decoding.readVarString(decoder);
      } catch {
        json = null;
      }
      const frame = json === null ? null : parseFreezeFrame(json);
      if (frame !== null) callbacks.onFreeze?.(frame);
    }
  };
}

/**
 * Identity and location state for a remote collaborator in awareness.
 */
export interface AwarenessUser {
  clientId: number;
  user: { githubId: number; name: string; color: string };
  location: { route: string | null; storyId: string | null; fieldKey: string | null } | null;
}

/**
 * Fallback colour for the structural-highlight flash when a freshly-arrived
 * item can't be attributed to a specific remote collaborator's assigned
 * colour (`AwarenessUser.user.color`). This is the Trama lavender identity
 * token (`#C6D0F8`) at 0.9 alpha, matching the `--structural-highlight-color`
 * default baked into the keyframes in `app/styles/app.css`. Lives here beside
 * the awareness colour it stands in for, so the two stay in sync.
 */
export const FALLBACK_HIGHLIGHT_COLOR = "rgba(198, 208, 248, 0.9)";

export interface CollaborationContextValue {
  ydoc: Y.Doc | null;
  provider: WebsocketProvider | null;
  connected: boolean;
  /** Three-state connection status. Replaces the binary `connected` boolean for UI. */
  connectionStatus: "connected" | "connecting" | "offline";
  /**
   * Counts the generation handshakes this provider has received, and so counts
   * the times the server has proved it is serving the document to this client.
   *
   * `connected` does not prove that: a client at a stale generation is admitted
   * temporarily just to receive the reset frame, and `y-websocket` reports
   * `connected` at `onopen`, before any frame arrives. The server sends
   * SUB_DOC_GENERATION only after a real admission, so a consumer that has to
   * know the document is being served — the halted site-status state, which
   * nothing else clears — watches this instead. It increments on every
   * handshake, including one naming a generation it already held.
   */
  admissionEpoch: number;
  isPublishing: boolean;
  /**
   * The GitHub Actions build is still running after a successful commit
   * (broadcast by the publish route from commit-success until build-complete).
   * Separate from isPublishing — which flips false on commit return and keeps
   * the freeze/disable semantics — so the Site Status pill can stay in
   * "publishing" through the build without freezing the whole UI.
   */
  isBuilding: boolean;
  publishError: boolean;
  /** A publish another user started is running; the freeze modal shows. */
  publishHeldByOther: boolean;
  /** The user running that publish, or null. */
  publishHeldBy: number | null;
  dismissPublishError: () => void;
  /**
   * The commit SHA of the in-flight publish, broadcast off-route via awareness
   * so the global Site Status pill's PublishingPopover can drive the existing
   * poll-build loop from any route. null when no SHA
   * has been produced yet (the popover then renders a generic in-progress row).
   */
  publishSha: string | null;
  /** Direct GitHub commit URL for the in-flight publish (paired with publishSha). */
  publishCommitUrl: string | null;
  isUpgrading: boolean;
  upgradeError: boolean;
  /** An upgrade another user started is running; the freeze modal shows. */
  upgradeHeldByOther: boolean;
  /** The user running that upgrade, or null. */
  upgradeHeldBy: number | null;
  dismissUpgradeError: () => void;
  /** An upgrade another user started, which this page saw running, has succeeded. */
  upgradeSucceeded: boolean;
  /**
   * Who else is committing new objects on the Objects page, holding the
   * operation lock without freezing anyone; null when nobody is.
   */
  objectsHeldBy: number | null;
  remoteCollaborators: AwarenessUser[];
  lastEditorByField: Map<string, { name: string; color: string }>;
  undoManager: Y.UndoManager | null;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  userGithubId: number | null;
  /**
   * Per-user lifetime contribution data, keyed by userId (D1 integer ID).
   * Built from the authenticated projectMembers loader — only members with a
   * project_members row appear here (defence-in-depth).
   * Consumed by the sidebar donut.
   */
  contributionsByUser: Map<number, { fields_edited: number }>;
}

const defaultValue: CollaborationContextValue = {
  ydoc: null,
  provider: null,
  connected: false,
  connectionStatus: "offline",
  admissionEpoch: 0,
  isPublishing: false,
  isBuilding: false,
  publishError: false,
  publishHeldByOther: false,
  publishHeldBy: null,
  dismissPublishError: () => {},
  publishSha: null,
  publishCommitUrl: null,
  isUpgrading: false,
  upgradeError: false,
  upgradeHeldByOther: false,
  upgradeHeldBy: null,
  dismissUpgradeError: () => {},
  upgradeSucceeded: false,
  objectsHeldBy: null,
  remoteCollaborators: [],
  lastEditorByField: new Map(),
  undoManager: null,
  canUndo: false,
  canRedo: false,
  undo: () => {},
  redo: () => {},
  userGithubId: null,
  contributionsByUser: new Map(),
};

export const CollaborationContext =
  createContext<CollaborationContextValue>(defaultValue);

/**
 * useCollaborationContext — consume the collaboration context.
 *
 * Does NOT throw when null — components must handle null ydoc gracefully
 * (SSR and pre-connection states). Returns default values when no provider
 * is in the tree.
 */
export function useCollaborationContext(): CollaborationContextValue {
  return useContext(CollaborationContext);
}

/**
 * useSetAwarenessLocation — returns a setter for the local client's location field.
 *
 * Child routes call this to update their current location (route, storyId, fieldKey)
 * in the shared awareness state so other clients can show where users are.
 */
export function useSetAwarenessLocation() {
  const { provider } = useCollaborationContext();
  // `route` accepts null so a route can clear its awareness location on teardown
  // without reading the global window.location. Consumers (TabNav,
  // PresenceBar) already guard with `location?.route` falsy checks.
  return (location: { route: string | null; storyId: string | null; fieldKey: string | null }) => {
    provider?.awareness.setLocalStateField("location", location);
  };
}

/**
 * CollaborationProvider — creates and manages the Y.Doc and WebsocketProvider
 * lifecycle for a given projectId.
 *
 * Mount: creates Y.Doc and WebsocketProvider, connects to /ws/:projectId.
 * Unmount: disconnects WebSocket, destroys provider and doc.
 * Reconnect and offline queuing are handled by WebsocketProvider automatically.
 *
 * On WebSocket connect, broadcasts user identity (githubId, name, color) via awareness.
 * Maintains remoteCollaborators state computed from other clients' awareness states.
 */
export function CollaborationProvider({
  projectId,
  userId = null,
  userGithubId,
  userName,
  presenceColor,
  projectMembers,
  children,
}: {
  projectId: number | null;
  /** The signed-in user's D1 id, which the freeze leases name their holders by. */
  userId?: number | null;
  userGithubId: number | null;
  userName: string | null;
  presenceColor: string | null;
  /** Authenticated project members from the loader — used to build contributionsByUser. */
  projectMembers?: Array<{
    userId: number;
    contributions: { fields_edited?: number } | null;
  }>;
  children: React.ReactNode;
}) {
  // Session-control message side-effects (toast + redirect).
  //
  // We deliberately use `window.location.assign(...)` for the redirect
  // rather than `useNavigate()` — the latter requires a Router context
  // and would crash the existing `tests/use-collaboration.test.tsx` +
  // `tests/upgrade-collaboration.test.ts` harnesses, which render
  // `CollaborationProvider` without a Router. A full document navigation
  // is also semantically correct here: the user is being kicked off the
  // project, the WS just closed, and we want a clean re-entry into
  // /dashboard with a fresh loader run rather than a soft route swap
  // that might leave Yjs context state lingering.
  const { showToast } = useToast();
  // Read by the frame handler, which is installed once per connection and so
  // closes over the render it was installed in.
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  const { t } = useTranslation("account");

  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<"connected" | "connecting" | "offline">("connecting");
  const [admissionEpoch, setAdmissionEpoch] = useState(0);
  // The freeze as the server last described it, for the project it describes.
  // It outlives the provider on purpose: the revisions it has seen are what
  // let a replayed end be told from one this page has not witnessed, across
  // reconnections. It does not outlive the project, because revisions are
  // numbered per project, and one seen in another would match an end here
  // that this page never saw begin.
  const [freeze, setFreeze] = useState<{ projectId: number | null; view: FreezeView }>({
    projectId,
    view: EMPTY_FREEZE_VIEW,
  });
  const freezeView = freeze.projectId === projectId ? freeze.view : EMPTY_FREEZE_VIEW;
  const updateFreezeView = useCallback(
    (forProject: number | null, update: (view: FreezeView) => FreezeView) => {
      setFreeze((current) => ({
        projectId: forProject,
        view: update(current.projectId === forProject ? current.view : EMPTY_FREEZE_VIEW),
      }));
    },
    [],
  );
  const [isBuilding, setIsBuilding] = useState(false);
  const [publishSha, setPublishSha] = useState<string | null>(null);
  const [publishCommitUrl, setPublishCommitUrl] = useState<string | null>(null);
  const [remoteCollaborators, setRemoteCollaborators] = useState<AwarenessUser[]>([]);
  const [lastEditorByField, setLastEditorByField] = useState<Map<string, { name: string; color: string }>>(new Map());
  const [undoManager, setUndoManager] = useState<Y.UndoManager | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  // Bumped when the server reports that it has rebuilt the project document.
  // It is a dependency of the effect below, so a bump tears the current Y.Doc
  // and provider down and builds a fresh pair — the only way to stop the
  // discarded document being re-offered to the server on reconnection.
  const [docGeneration, setDocGeneration] = useState(0);

  // Create Y.Doc and WebsocketProvider when projectId is available
  useEffect(() => {
    if (typeof window === "undefined" || !projectId) return;

    const doc = new Y.Doc();
    const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
    // y-websocket keeps this object and re-encodes it into the URL on every
    // connection, so writing into it below is what reaches the next socket. It
    // starts on the fresh-document claim: the document built on the line above
    // belongs to no generation until the server names one, and saying so is
    // what admits it to a project that has been reset.
    const connectionParams: Record<string, string> = {
      [GENERATION_PARAM]: FRESH_DOCUMENT_GENERATION,
      [AWARENESS_CLIENT_PARAM]: String(doc.clientID),
    };
    // `disableBc`: the same browser's other tabs reach this one through the
    // server, as tabs in any other browser do. Over BroadcastChannel a tab
    // applies a sibling's document updates with none of the server's checks
    // (membership, the revert of a refused edit, the generation fence), and a
    // tab whose socket closes publishes the removal of every collaborator it
    // holds, which only its siblings receive. The cost: a tab whose socket
    // is down neither receives its siblings' edits nor passes on its own
    // until it reconnects; its edits are kept in its document meanwhile.
    const wsProvider = new WebsocketProvider(wsUrl, `ws/${projectId}`, doc, {
      connect: false,
      disableBc: true,
      params: connectionParams,
    });

    wsProvider.on("status", (event: { status: string }) => {
      const next: "connected" | "connecting" | "offline" =
        event.status === "connected"
          ? "connected"
          : event.status === "connecting"
            ? "connecting"
            : "offline";
      setConnectionStatus(next);
      setConnected(next === "connected");
      if (next === "connected" && presenceColor && userGithubId && userName) {
        wsProvider.awareness.setLocalStateField("user", {
          githubId: userGithubId,
          name: userName,
          color: presenceColor,
        });
      }
    });

    // Install the session-control handler BEFORE connect()
    // so any control message that arrives in the same tick as the upgrade
    // is routed through our handler, not y-websocket's default
    // messageAuth handler. See protocol notes at the top of this file —
    // overriding index 2 is safe because Telar's server never sends
    // y-websocket auth messages, and the assumption is pinned by tests.
    const goToDashboard = () => {
      if (typeof window !== "undefined") {
        window.location.assign("/dashboard");
      }
    };
    installSessionControlHandler(wsProvider, {
      onProjectDeleted: () => {
        // Convenor deleted the project. Sticky destructive toast
        // because the user is being kicked off and must read the
        // message; critical: true → role="alert" so screen readers
        // announce immediately. Then redirect to /dashboard so the
        // user lands somewhere sensible.
        showToast({
          message: t("project_deleted_ws_toast", {
            defaultValue:
              "This project was deleted by the convenor — your unsaved changes are lost.",
          }),
          type: "destructive",
          autoDismissMs: null,
          critical: true,
        });
        goToDashboard();
      },
      onRemovedFromProject: () => {
        // Single-socket variant: the user left the project from
        // another tab; this tab disconnects gracefully with the
        // default 5s info toast.
        showToast({
          message: t("removed_from_project_ws_toast", {
            defaultValue: "You left this project from another tab.",
          }),
          type: "info",
        });
        goToDashboard();
      },
      onStateReset: () => {
        // Disconnect before anything else. y-websocket schedules its own
        // reconnection as soon as the socket closes, and that reconnection
        // would carry this document back to the server; the teardown below
        // runs on React's commit, which is later than that.
        wsProvider.disconnect();
        showToast({
          message: t("state_reset_ws_toast", {
            defaultValue:
              "This project was rebuilt from its last saved version — your unsaved changes in this tab are lost.",
          }),
          type: "destructive",
          autoDismissMs: null,
          critical: true,
        });
        setDocGeneration((n) => n + 1);
      },
      onDocGeneration: (generation) => {
        connectionParams[GENERATION_PARAM] = String(generation);
        // The handshake is the one proof that this connection is being served
        // the document, so it is counted separately from `docGeneration`, which
        // drives document destruction and must not move for a repeat of the
        // generation the client already holds.
        setAdmissionEpoch((n) => n + 1);
      },
      onFreeze: (frame) => {
        updateFreezeView(projectId, (view) => applyFreezeFrame(view, frame, userIdRef.current, Date.now()));
      },
    });

    // In place of y-websocket's own silence check, which reconnects a hidden
    // tab whose timers the browser throttles (see connection-liveness).
    const stopLiveness = watchLiveness(wsProvider, document);
    // In place of the awareness's own expiry, which drops a collaborator whose
    // hidden tab renews too rarely (see presence-expiry).
    const stopPresenceExpiry = watchPresenceExpiry(wsProvider.awareness, document);
    wsProvider.connect();
    setYdoc(doc);
    setProvider(wsProvider);

    return () => {
      stopLiveness();
      stopPresenceExpiry();
      wsProvider.disconnect();
      wsProvider.destroy();
      doc.destroy();
      setYdoc(null);
      setProvider(null);
      setConnected(false);
      setConnectionStatus("connecting");
    };
  }, [projectId, docGeneration]);

  // Listen for publish-freeze flag broadcast via Yjs awareness, and track remote collaborators
  useEffect(() => {
    if (!provider) return;
    const awareness = provider.awareness;
    const handleChange = () => {
      const states = awareness.getStates();
      let building = false;
      // The publish SHA/commit URL are broadcast by whichever client is running
      // the publish (the publish route's awareness effect). The pill reads them
      // off-route so its PublishingPopover can poll from anywhere.
      let sha: string | null = null;
      let commitUrl: string | null = null;
      const collaborators: AwarenessUser[] = [];
      states.forEach((state: Record<string, unknown>, clientId: number) => {
        if (state.building) building = true;
        if (typeof state.publishSha === "string") sha = state.publishSha;
        if (typeof state.publishCommitUrl === "string") commitUrl = state.publishCommitUrl;
        if (clientId !== awareness.clientID && state.user) {
          const user = state.user as AwarenessUser["user"];
          collaborators.push({
            clientId,
            user,
            location: (state.location as AwarenessUser["location"]) ?? null,
          });
        }
      });
      setIsBuilding(building);
      setPublishSha(sha);
      setPublishCommitUrl(commitUrl);
      setRemoteCollaborators(collaborators);
      // Build lastEditorByField from awareness location state (session-scoped)
      const newEditorMap = new Map<string, { name: string; color: string }>();
      states.forEach((state: Record<string, unknown>, clientId: number) => {
        if (clientId !== awareness.clientID && state.user) {
          const user = state.user as AwarenessUser["user"];
          const loc = state.location as AwarenessUser["location"];
          if (loc?.fieldKey) {
            newEditorMap.set(loc.fieldKey, { name: user.name, color: user.color });
          }
        }
      });
      setLastEditorByField(newEditorMap);
    };
    awareness.on("change", handleChange);
    return () => {
      awareness.off("change", handleChange);
    };
  }, [provider]);

  // Lift a lease at its local deadline. Nothing is broadcast when a lease runs
  // out, so without a timer an expired freeze would lift only when the next
  // frame happened to arrive. One timeout, for the nearest deadline; none
  // while nothing stands.
  useEffect(() => {
    const deadline = nextFreezeDeadline(freezeView);
    if (deadline === null) return;
    const timer = setTimeout(
      () => updateFreezeView(projectId, (view) => expireFreeze(view, Date.now())),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [freezeView, projectId, updateFreezeView]);

  const publishFreeze = readFreezeView(freezeView, "publish", userId);
  const upgradeFreeze = readFreezeView(freezeView, "upgrade", userId);
  const objectsHeldBy = readLockHolder(freezeView, "objects", userId);
  const isPublishing = publishFreeze.frozen;
  const isUpgrading = upgradeFreeze.frozen;
  const dismissError = useCallback(
    (kind: FreezeKind) => updateFreezeView(projectId, (view) => dismissFreezeError(view, kind)),
    [projectId, updateFreezeView],
  );
  const dismissPublishError = useCallback(() => dismissError("publish"), [dismissError]);
  const dismissUpgradeError = useCallback(() => dismissError("upgrade"), [dismissError]);

  // Unified Yjs UndoManager: scoped to all root Y.Arrays so that structural
  // operations (add/delete/reorder of stories, steps, layers, pages, objects, glossary)
  // and text edits inside those Y.Maps share one undo history per session.
  //
  // The manager is created only after the provider reports `sync` — creating it
  // before the initial sync would make the cold-start population of the Y.Arrays
  // undoable, so a Ctrl+Z would wipe the project content.
  //
  // The manager is destroyed when the provider changes (page refresh / reconnect) —
  // undo history persists across route navigation within one CollaborationProvider
  // instance, then resets on refresh. This is the desired behaviour.
  useEffect(() => {
    if (!provider || !ydoc) return;

    let um: Y.UndoManager | null = null;

    const updateStacks = () => {
      if (!um) return;
      setCanUndo(um.undoStack.length > 0);
      setCanRedo(um.redoStack.length > 0);
    };

    const handleSync = (isSynced: boolean) => {
      if (!isSynced || um) return;
      um = createUndoManager([
        ydoc.getArray("stories"),
        ydoc.getArray("objects"),
        ydoc.getArray("glossary"),
        ydoc.getArray("pages"),
      ]);
      um.on("stack-item-added", updateStacks);
      um.on("stack-item-popped", updateStacks);
      um.on("stack-cleared", updateStacks);
      setUndoManager(um);
      updateStacks();
    };

    provider.on("sync", handleSync);
    // Reconnect scenario: provider is already synced when this effect runs
    if (provider.synced) handleSync(true);

    return () => {
      provider.off("sync", handleSync);
      if (um) {
        um.off("stack-item-added", updateStacks);
        um.off("stack-item-popped", updateStacks);
        um.off("stack-cleared", updateStacks);
        um.destroy();
      }
      setUndoManager(null);
      setCanUndo(false);
      setCanRedo(false);
    };
  }, [provider, ydoc]);

  const undo = useCallback(() => {
    undoManager?.undo();
  }, [undoManager]);
  const redo = useCallback(() => {
    undoManager?.redo();
  }, [undoManager]);

  // Build contributionsByUser from the authenticated loader data.
  // Only project_members rows appear in this map — awareness client IDs that
  // are not in project_members are excluded.
  const contributionsByUser = useMemo((): Map<number, { fields_edited: number }> => {
    const map = new Map<number, { fields_edited: number }>();
    for (const member of projectMembers ?? []) {
      map.set(member.userId, {
        fields_edited: member.contributions?.fields_edited ?? 0,
      });
    }
    return map;
  }, [projectMembers]);

  const value = useMemo(
    () => ({
      ydoc,
      provider,
      connected,
      connectionStatus,
      admissionEpoch,
      isPublishing,
      isBuilding,
      publishError: publishFreeze.error,
      publishHeldByOther: publishFreeze.heldByOther,
      publishHeldBy: publishFreeze.heldBy,
      dismissPublishError,
      publishSha,
      publishCommitUrl,
      isUpgrading,
      upgradeError: upgradeFreeze.error,
      upgradeHeldByOther: upgradeFreeze.heldByOther,
      upgradeHeldBy: upgradeFreeze.heldBy,
      dismissUpgradeError,
      upgradeSucceeded: freezeView.upgradeSucceeded,
      objectsHeldBy,
      remoteCollaborators,
      lastEditorByField,
      undoManager,
      canUndo,
      canRedo,
      undo,
      redo,
      userGithubId,
      contributionsByUser,
    }),
    [
      ydoc,
      provider,
      connected,
      connectionStatus,
      admissionEpoch,
      isPublishing,
      isBuilding,
      publishFreeze.error,
      publishFreeze.heldByOther,
      publishFreeze.heldBy,
      dismissPublishError,
      publishSha,
      publishCommitUrl,
      isUpgrading,
      upgradeFreeze.error,
      upgradeFreeze.heldByOther,
      upgradeFreeze.heldBy,
      dismissUpgradeError,
      freezeView.upgradeSucceeded,
      objectsHeldBy,
      remoteCollaborators,
      lastEditorByField,
      undoManager,
      canUndo,
      canRedo,
      undo,
      redo,
      userGithubId,
      contributionsByUser,
    ]
  );

  return (
    <CollaborationContext.Provider value={value}>
      {children}
    </CollaborationContext.Provider>
  );
}
