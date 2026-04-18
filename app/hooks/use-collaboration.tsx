/**
 * use-collaboration — React context and provider for Yjs collaborative editing.
 *
 * Provides a Y.Doc and WebsocketProvider to all child routes via React context.
 * The WebSocket connects to the ProjectCollaborationDO at /ws/:projectId on mount
 * and disconnects on unmount. Offline edits queue automatically via y-websocket's
 * built-in reconnect/backoff behaviour.
 *
 * Exports: CollaborationContext, CollaborationProvider, useCollaborationContext,
 *          CollaborationContextValue, AwarenessUser, useSetAwarenessLocation
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

/**
 * Identity and location state for a remote collaborator in awareness.
 */
export interface AwarenessUser {
  clientId: number;
  user: { githubId: number; name: string; color: string };
  location: { route: string; storyId: string | null; fieldKey: string | null } | null;
}

export interface CollaborationContextValue {
  ydoc: Y.Doc | null;
  provider: WebsocketProvider | null;
  connected: boolean;
  /** Three-state connection status. Replaces the binary `connected` boolean for UI. */
  connectionStatus: "connected" | "connecting" | "offline";
  isPublishing: boolean;
  publishError: boolean;
  setIsPublishing: (v: boolean) => void;
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
   * Consumed by the sidebar donut (plan 28-04).
   */
  contributionsByUser: Map<number, { fields_edited: number }>;
}

const defaultValue: CollaborationContextValue = {
  ydoc: null,
  provider: null,
  connected: false,
  connectionStatus: "offline",
  isPublishing: false,
  publishError: false,
  setIsPublishing: () => {},
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
  return (location: { route: string; storyId: string | null; fieldKey: string | null }) => {
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
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<"connected" | "connecting" | "offline">("connecting");
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState(false);
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
      let hasError = false;
      // upgrading is display-only — any client can broadcast it, but the
      // actual upgrade commit is gated by the owner role check in the upgrade route
      // action. Spoofed upgrading=true can only trigger a freeze modal locally.
      let upgrading = false;
      let hasUpgradeError = false;
      const collaborators: AwarenessUser[] = [];
      states.forEach((state: Record<string, unknown>, clientId: number) => {
        if (state.publishing) publishing = true;
        if (state.publishError) hasError = true;
        if (state.upgrading) upgrading = true;
        if (state.upgradeError) hasUpgradeError = true;
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
      setPublishError(hasError);
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
  // The manager is created only after the provider reports `sync`: creating it
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
      um = new Y.UndoManager(
        [
          ydoc.getArray("stories"),
          ydoc.getArray("objects"),
          ydoc.getArray("glossary"),
          ydoc.getArray("pages"),
        ],
        { captureTimeout: 500 }
      );
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
      publishError,
      setIsPublishing,
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
      publishError,
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
