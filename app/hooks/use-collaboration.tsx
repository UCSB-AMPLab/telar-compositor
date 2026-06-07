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
 * @version v1.3.0-beta
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import * as decoding from "lib0/decoding";
import { useTranslation } from "react-i18next";
import { useToast } from "~/hooks/use-toast";
import { createUndoManager } from "~/lib/undo-manager";

// Bespoke session-control protocol (mirrors workers/collaboration.ts).
// Wire format = varuint(2) + uint8(subtype). Server→client only.
//
// Note on y-websocket compatibility (verified by y-websocket source
// inspection 2026-05-10): y-websocket's own dispatch reserves index
// 2 for `messageAuth` (server-sent auth-deny). Telar's
// server never sends auth messages on the WS — auth is a one-shot
// cookie/token check at the upgrade step, after which the socket is
// either accepted or refused with HTTP 401. Replacing
// `provider.messageHandlers[2]` is therefore safe in this codebase, and
// the override is documented at the install site.
const MSG_SESSION_CONTROL = 2;
const SUB_PROJECT_DELETED = 0x01;
const SUB_REMOVED_FROM_PROJECT = 0x02;

/**
 * Identity and location state for a remote collaborator in awareness.
 */
export interface AwarenessUser {
  clientId: number;
  user: { githubId: number; name: string; color: string };
  location: { route: string | null; storyId: string | null; fieldKey: string | null } | null;
}

export interface CollaborationContextValue {
  ydoc: Y.Doc | null;
  provider: WebsocketProvider | null;
  connected: boolean;
  /** Three-state connection status. Replaces the binary `connected` boolean for UI. */
  connectionStatus: "connected" | "connecting" | "offline";
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
  setIsPublishing: (v: boolean) => void;
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
  setIsUpgrading: (v: boolean) => void;
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
  isPublishing: false,
  isBuilding: false,
  publishError: false,
  setIsPublishing: () => {},
  publishSha: null,
  publishCommitUrl: null,
  isUpgrading: false,
  upgradeError: false,
  setIsUpgrading: () => {},
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
  userGithubId,
  userName,
  presenceColor,
  projectMembers,
  children,
}: {
  projectId: number | null;
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
  const { t } = useTranslation("account");

  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<"connected" | "connecting" | "offline">("connecting");
  const [isPublishing, setIsPublishing] = useState(false);
  const [isBuilding, setIsBuilding] = useState(false);
  const [publishError, setPublishError] = useState(false);
  const [publishSha, setPublishSha] = useState<string | null>(null);
  const [publishCommitUrl, setPublishCommitUrl] = useState<string | null>(null);
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [upgradeError, setUpgradeError] = useState(false);
  const [remoteCollaborators, setRemoteCollaborators] = useState<AwarenessUser[]>([]);
  const [lastEditorByField, setLastEditorByField] = useState<Map<string, { name: string; color: string }>>(new Map());
  const [undoManager, setUndoManager] = useState<Y.UndoManager | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Create Y.Doc and WebsocketProvider when projectId is available
  useEffect(() => {
    if (typeof window === "undefined" || !projectId) return;

    const doc = new Y.Doc();
    const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
    const wsProvider = new WebsocketProvider(wsUrl, `ws/${projectId}`, doc, {
      connect: false,
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
    // y-websocket auth messages.
    //
    // Defensive guard: some test harnesses mock `WebsocketProvider`
    // without a `messageHandlers` array. Skip the install when the array
    // is missing rather than crash those suites — production always has
    // the real provider with its pre-populated handler array.
    type WsProviderWithHandlers = {
      messageHandlers?: Array<
        (
          encoder: unknown,
          decoder: ReturnType<typeof decoding.createDecoder>,
          provider: unknown,
          emitSynced: boolean,
          messageType: number,
        ) => void
      >;
    };
    const handlers = (wsProvider as unknown as WsProviderWithHandlers)
      .messageHandlers;
    if (Array.isArray(handlers)) {
      handlers[MSG_SESSION_CONTROL] = (
        _encoder,
        decoder,
        _provider,
        _emitSynced,
        _messageType,
      ) => {
        const subtype = decoding.readUint8(decoder);
        const goToDashboard = () => {
          if (typeof window !== "undefined") {
            window.location.assign("/dashboard");
          }
        };
        if (subtype === SUB_PROJECT_DELETED) {
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
        } else if (subtype === SUB_REMOVED_FROM_PROJECT) {
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
        }
      };
    }

    wsProvider.connect();
    setYdoc(doc);
    setProvider(wsProvider);

    return () => {
      wsProvider.disconnect();
      wsProvider.destroy();
      doc.destroy();
      setYdoc(null);
      setProvider(null);
      setConnected(false);
      setConnectionStatus("connecting");
    };
  }, [projectId]);

  // Listen for publish-freeze flag broadcast via Yjs awareness, and track remote collaborators
  useEffect(() => {
    if (!provider) return;
    const awareness = provider.awareness;
    const handleChange = () => {
      const states = awareness.getStates();
      let publishing = false;
      let building = false;
      let hasError = false;
      // upgrading is display-only — any client can broadcast it, but the
      // actual upgrade commit is gated by the owner role check in the upgrade
      // route action. Spoofed upgrading=true can only trigger a freeze modal
      // locally.
      let upgrading = false;
      let hasUpgradeError = false;
      // The publish SHA/commit URL are broadcast by whichever client is running
      // the publish (the publish route's awareness effect). The pill reads them
      // off-route so its PublishingPopover can poll from anywhere.
      let sha: string | null = null;
      let commitUrl: string | null = null;
      const collaborators: AwarenessUser[] = [];
      states.forEach((state: Record<string, unknown>, clientId: number) => {
        if (state.publishing) publishing = true;
        if (state.building) building = true;
        if (state.publishError) hasError = true;
        if (state.upgrading) upgrading = true;
        if (state.upgradeError) hasUpgradeError = true;
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
      setIsPublishing(publishing);
      setIsBuilding(building);
      setPublishError(hasError);
      setPublishSha(sha);
      setPublishCommitUrl(commitUrl);
      setIsUpgrading(upgrading);
      setUpgradeError(hasUpgradeError);
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
    return () => awareness.off("change", handleChange);
  }, [provider]);

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
      isPublishing,
      isBuilding,
      publishError,
      setIsPublishing,
      publishSha,
      publishCommitUrl,
      isUpgrading,
      upgradeError,
      setIsUpgrading,
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
      isPublishing,
      isBuilding,
      publishError,
      publishSha,
      publishCommitUrl,
      isUpgrading,
      upgradeError,
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
