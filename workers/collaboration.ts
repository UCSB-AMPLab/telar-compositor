/**
 * This file is the Durable Object class behind real-time Yjs
 * collaboration — one DO instance per project, with periodic D1
 * snapshots so a server restart doesn't lose anyone's work.
 *
 * Each project's edit session lives inside a single
 * `ProjectCollaborationDO` instance. The DO hosts the Yjs document
 * in memory, relays sync messages between connected editors, and
 * snapshots both ways: a binary blob into `projects.yjs_state` for
 * fast warm restart, and row-level data into the entity tables
 * (stories, steps, layers, objects, config, glossary, pages) so
 * the publish pipeline can keep reading from D1 unchanged.
 *
 * Authentication runs at the WebSocket handshake: the browser
 * sends its session cookie value as `?token=`, the DO resolves it
 * to a user id, and project membership is checked in D1 before the
 * socket is accepted. A bespoke session-control protocol on top
 * of the y-websocket message channel lets the server push a
 * "project deleted" or "you've been removed" disconnect to every
 * client when a convenor takes a destructive action.
 *
 * Cold start: when no `yjs_state` blob exists for the project,
 * the DO builds the Y.Doc from D1 rows on first connection. That
 * makes the DO durable against forced eviction without any state
 * loss beyond the in-flight edit window.
 *
 * @version v1.3.5-beta
 */

import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { DurableObject } from "cloudflare:workers";
import { makeAfterTransactionHandler, buildContributionUpdate, buildActivityRows, ACTIVITY_RETENTION_CAP, yTextToString, resolveActivityEntity } from "./collaboration-helpers";
import {
  parseSessionCookie,
  getUserIdFromToken as getUserIdFromTokenShared,
  verifyInternalMarker,
} from "./auth";
import {
  getUserContext,
  makeCanDeleteHandler,
  makeViolationCounter,
} from "./can-delete";
import { makeUniqueTermId } from "~/lib/glossary-slug";

// y-websocket message type constants (must match client)
const messageSync = 0;
const messageAwareness = 1;

// Bespoke session-control protocol for server-initiated
// disconnects (project deleted by convenor; collaborator left from another
// tab). Wire format = varuint(2) + uint8(subtype). Server→client only —
// the existing webSocketMessage handler still silently ignores unknown
// msgTypes, so no client→server path exists.
//
// Note: y-protocols today only uses 0/1 at the
// top level, so 2 is safe; re-evaluate if the project ever bumps to a
// y-protocols major that adds new top-level types.
const messageSessionControl = 2;
const subProjectDeleted = 0x01;
const subRemovedFromProject = 0x02;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SocketAttachment {
  userId: number;
  projectId: number;
  role: "convenor" | "collaborator";
  awarenessClientId?: number;
}

// Row shapes returned by raw D1 queries
interface StoryRow {
  id: number;
  story_id: string;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  order: number;
  private: number;
  draft: number;
  show_sections: number;
  created_by: number | null;
}

interface StepRow {
  id: number;
  story_id: number;
  step_number: number;
  kind: string;
  object_id: string | null;
  x: number | null;
  y: number | null;
  zoom: number | null;
  page: string | null;
  question: string | null;
  answer: string | null;
  alt_text: string | null;
  clip_start: string | null;
  clip_end: string | null;
  loop: string | null;
  created_by: number | null;
}

interface LayerRow {
  id: number;
  step_id: number;
  layer_number: number;
  title: string | null;
  button_label: string | null;
  content: string | null;
  created_by: number | null;
}

interface ObjectRow {
  id: number;
  object_id: string;
  title: string | null;
  creator: string | null;
  description: string | null;
  alt_text: string | null;
  source_url: string | null;
  period: string | null;
  year: string | null;
  object_type: string | null;
  subjects: string | null;
  source: string | null;
  credit: string | null;
  thumbnail: string | null;
  dimensions: string | null;
  extra_columns: string | null;
  featured: number;
  image_available: number;
  created_by: number | null;
}

interface GlossaryRow {
  id: number;
  term_id: string;
  title: string | null;
  definition: string | null;
  created_by: number | null;
}

interface PageRow {
  id: number;
  title: string | null;
  slug: string;
  body: string | null;
  order: number;
  created_by: number | null;
}

interface ConfigRow {
  title: string | null;
  lang: string | null;
  description: string | null;
  author: string | null;
  email: string | null;
  logo: string | null;
  baseurl: string | null;
  url: string | null;
  telar_version: string | null;
  theme: string | null;
  include_demo_content: number | null;
  google_sheets_enabled: number | null;
  google_sheets_published_url: string | null;
  show_on_homepage: number | null;
  show_story_steps: number | null;
  show_object_credits: number | null;
  browse_and_search: number | null;
  show_link_on_homepage: number | null;
  show_sample_on_homepage: number | null;
  collection_mode: number | null;
  featured_count: number | null;
  story_key: string | null;
  navigation_json: string | null;
}

interface LandingRow {
  stories_heading: string | null;
  stories_intro: string | null;
  objects_heading: string | null;
  objects_intro: string | null;
  welcome_body: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// yTextToString lives in collaboration-helpers.ts (shared with the activity
// resolver) and is imported above.

// ---------------------------------------------------------------------------
// Durable Object class
// ---------------------------------------------------------------------------

export class ProjectCollaborationDO extends DurableObject<Env> {
  private ydoc: Y.Doc;
  private awareness: awarenessProtocol.Awareness;
  private projectId: number | null = null;
  private docLoaded = false;
  private userFieldSets: Map<number, Set<string>> = new Map();
  private newSessions: Set<number> = new Set();
  // Per-user set of `collection:id` entity keys already emitted to activity_log
  // this DO lifetime. userFieldSets accumulates across snapshots and is never
  // cleared, so without this tracker every 30s snapshot would re-INSERT a row
  // for every entity ever touched. We emit one coarse activity row per
  // (user, entity) the first time it appears, then record it here so later
  // snapshots skip it. Resets on cold start (a returning editor emits afresh).
  private activityEmitted: Map<number, Set<string>> = new Map();
  private isSnapshotting = false;
  // Re-entrancy guard for the unauthorised-delete revert handler. The
  // revert itself fires afterTransaction; we must not recurse into the
  // canDelete check on our own revert transaction.
  private isReverting = false;
  // Per-socket sliding-window violation tracker. Initialised in the
  // constructor so the WeakMap state is owned by the factory and the DO
  // exposes a stable function reference to the canDelete handler.
  private recordViolation: (ws: WebSocket) => boolean = () => false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ydoc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);

    // Attach afterTransaction field-path accumulator. Uses the WebSocket
    // reference in tr.origin (set by readSyncMessage) to recover the userId
    // via socket attachment.
    this.ydoc.on("afterTransaction", makeAfterTransactionHandler(
      this.ydoc,
      this.userFieldSets,
      (origin: unknown) => getUserContext(origin)?.userId ?? null,
    ));

    // Server-side canDelete enforcement. Walks tr.deleteSet and reverts
    // unauthorised collaborator deletes. Registered
    // AFTER the contribution-tracking handler so the contribution handler
    // runs first; both are independent (contribution reads tr.changed; this
    // reads tr.deleteSet). Convenor deletes pass through unchanged. The
    // re-entrancy guard (this.isReverting) prevents the revert transaction
    // from re-firing this handler on itself.
    this.recordViolation = makeViolationCounter();
    this.ydoc.on("afterTransaction", makeCanDeleteHandler({
      ydoc: this.ydoc,
      isSnapshotting: () => this.isSnapshotting,
      isReverting: () => this.isReverting,
      setReverting: (v) => { this.isReverting = v; },
      getSockets: () => this.ctx.getWebSockets(),
      broadcastUpdate: (msg) => {
        for (const client of this.ctx.getWebSockets()) {
          try { client.send(msg); } catch { /* client may have disconnected */ }
        }
      },
      recordViolation: (ws) => this.recordViolation(ws),
    }));

    // Restore in-memory state after hibernation wake.
    // If sockets are present, the DO was evicted and is now waking up —
    // we need the Y.Doc ready immediately via blockConcurrencyWhile.
    const sockets = this.ctx.getWebSockets();
    if (sockets.length > 0) {
      // Recover projectId from the first attachment
      const firstAttachment = sockets[0].deserializeAttachment() as SocketAttachment | null;
      if (firstAttachment) {
        this.projectId = firstAttachment.projectId;
      }
      // Block until the doc is loaded so webSocketMessage never races ahead
      this.ctx.blockConcurrencyWhile(async () => {
        await this.ensureDocLoaded();
      });
    }
  }

  // -------------------------------------------------------------------------
  // fetch — WebSocket upgrade entry point
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // HTTP POST /snapshot — forced snapshot before the publish pipeline runs.
    // Called by the publish route action immediately before committing to GitHub.
    // Returns 200 OK on success; the DO must have a projectId set (i.e. at least
    // one client has connected) otherwise we skip — the doc is not dirty.
    if (url.pathname.endsWith("/snapshot") && request.method === "POST") {
      // Same signed-marker check as /reset — direct reaches that bypass the
      // worker entry lack the marker and are rejected with 401.
      const markerError = await verifyInternalMarker(request, this.env.SESSION_SECRET, "snapshot");
      if (markerError) return markerError;

      if (this.projectId !== null) {
        try {
          await this.ctx.blockConcurrencyWhile(async () => {
            await this.ensureDocLoaded();
            await this.snapshotToD1();
          });
        } catch (err) {
          // Fix #13(B): a thrown D1-batch failure here would otherwise reject
          // the DO fetch, and the publish action's outer catch swallows it and
          // ships stale D1. Convert the throw into a non-200 the action can
          // distinguish from a genuine "DO unreachable" fetch rejection.
          console.error("[snapshot] forced snapshot failed", err);
          return new Response("snapshot_failed", { status: 500 });
        }
      }
      return new Response("OK", { status: 200 });
    }

    // POST /reset — destroy the in-memory Y.Doc, clear the D1 blob, rebuild
    // from D1 entity rows, and close all connected sockets so clients reconnect
    // with clean state. Convenor-only — gating happens in workers/app.ts; here
    // we verify the signed internal marker the worker entry sets so the DO
    // cannot be reached directly from outside.
    if (url.pathname.endsWith("/reset") && request.method === "POST") {
      // Verify the signed internal marker workers/app.ts attaches via the
      // X-Internal-Auth / X-Internal-Timestamp / X-Internal-Project headers.
      // Direct reaches that bypass the worker entry lack the marker and are
      // rejected with 401.
      const markerError = await verifyInternalMarker(request, this.env.SESSION_SECRET, "reset");
      if (markerError) return markerError;

      if (this.projectId !== null) {
        await this.ctx.blockConcurrencyWhile(async () => {
          // 1. Clear the D1 blob so a future cold-start also gets clean state
          await this.env.DB
            .prepare("UPDATE projects SET yjs_state = NULL, updated_at = ? WHERE id = ?")
            .bind(new Date().toISOString(), this.projectId)
            .run();

          // 2. Destroy and rebuild the in-memory Y.Doc
          this.ydoc.destroy();
          this.ydoc = new Y.Doc();
          this.docLoaded = false;
          this.awareness = new awarenessProtocol.Awareness(this.ydoc);
          await this.ensureDocLoaded(); // rebuilds from D1 rows

          // 3. Close all connected sockets — they'll reconnect and get clean state
          const sockets = this.ctx.getWebSockets();
          for (const ws of sockets) {
            try { ws.close(1012, "State reset"); } catch { /* already closed */ }
          }
        });
      }
      return new Response("OK", { status: 200 });
    }

    // POST /notify-deleted — broadcast a session-
    // control message to connected clients then close their sockets.
    //
    // No `?userId=` param  → subtype 0x01 (project_deleted) to ALL sockets
    //                        (convenor delete-project: every collaborator
    //                        currently editing must be evicted).
    // With `?userId=N`     → subtype 0x02 (removed_from_project) to ONLY
    //                        the sockets whose attachment.userId === N
    //                        (collaborator-left-from-another-tab variant;
    //                        future "remove collaborator" flows reuse this).
    //
    // Order constraint: the route action MUST run the D1 cascade
    // BEFORE invoking this endpoint so any reconnect attempt fails fast
    // against the missing project_members row (graceful no-op end state).
    if (url.pathname.endsWith("/notify-deleted") && request.method === "POST") {
      const targetUserId = url.searchParams.get("userId");
      const markerError = await verifyInternalMarker(
        request,
        this.env.SESSION_SECRET,
        "notify-deleted",
        targetUserId,
      );
      if (markerError) return markerError;

      const subtype = targetUserId ? subRemovedFromProject : subProjectDeleted;
      const closeReason = targetUserId ? "removed_from_project" : "project_deleted";

      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, messageSessionControl);
      encoding.writeUint8(enc, subtype);
      const msg = encoding.toUint8Array(enc);

      for (const ws of this.ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() as SocketAttachment | null;
        if (targetUserId && att?.userId !== Number(targetUserId)) continue;
        try { ws.send(msg); } catch { /* socket may have disconnected */ }
        try { ws.close(1000, closeReason); } catch { /* already closed */ }
      }
      return new Response("OK", { status: 200 });
    }

    // GET /active-ws-count — live socket count for the
    // convenor's pre-flight modal. Authoritative answer (D1's
    // awareness_state may lag); informational, NOT a gate (the convenor
    // can confirm regardless of count or fetch failure).
    if (url.pathname.endsWith("/active-ws-count") && request.method === "GET") {
      // Count distinct OTHER users with live sockets, excluding the
      // requester. The warning text ("N collaborators are editing right
      // now") is about people the convenor will disconnect — they
      // themselves aren't disconnecting themselves, and a single user
      // with several tabs is still one collaborator.
      const exceptUserIdParam = url.searchParams.get("exceptUserId");
      const markerError = await verifyInternalMarker(
        request,
        this.env.SESSION_SECRET,
        "active-ws-count",
        exceptUserIdParam,
      );
      if (markerError) return markerError;
      const exceptUserId =
        exceptUserIdParam !== null ? Number(exceptUserIdParam) : NaN;
      const otherUserIds = new Set<number>();
      for (const ws of this.ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() as SocketAttachment | null;
        if (!att?.userId) continue;
        if (Number.isFinite(exceptUserId) && att.userId === exceptUserId) continue;
        otherUserIds.add(att.userId);
      }
      return Response.json({ count: otherUserIds.size });
    }

    // POST /restore-orphans — route Restore-as-drafts
    // through the Y.doc instead of writing D1 directly. The original
    // design wrote rows to D1, but the next snapshotToD1 reconciliation
    // (line ~1289) treated them as orphan-from-Y.doc and deleted them.
    // Routing through the Y.doc means the existing INSERT path in
    // snapshotToD1 picks the new entries up correctly. HMAC-marker gated
    // identically to /snapshot and /reset.
    //
    // Body: { stories: Array<{ storyId, steps[], layers[] }> }
    //   step:  { step_number, kind, object_id, x, y, zoom, page,
    //            question, answer, clip_start, clip_end, loop }
    //   layer: { step_index, layer_number, title, button_label, content }
    // Title defaults to storyId; subtitle/byline default to empty
    // (per-story CSVs do not carry these fields). draft is always true
    // on restore. Order is computed as max(existing order) + 1 + i so
    // restored entries push onto the end of the array deterministically.
    if (url.pathname.endsWith("/restore-orphans") && request.method === "POST") {
      const markerError = await verifyInternalMarker(request, this.env.SESSION_SECRET, "restore-orphans");
      if (markerError) return markerError;

      let payload: {
        stories: Array<{
          storyId: string;
          steps: Array<{
            step_number?: number;
            kind?: string;
            object_id?: string;
            x?: number | null;
            y?: number | null;
            zoom?: number | null;
            page?: string;
            question?: string;
            answer?: string;
            clip_start?: string;
            clip_end?: string;
            loop?: string;
          }>;
          layers: Array<{
            step_index: number;
            layer_number: number;
            title?: string;
            button_label?: string;
            content?: string;
          }>;
        }>;
      };
      try {
        payload = await request.json();
      } catch {
        return new Response("Invalid JSON body", { status: 400 });
      }
      if (!payload || !Array.isArray(payload.stories)) {
        return new Response("Missing stories array", { status: 400 });
      }

      // Empty array: nothing to do — return early without firing
      // snapshotToD1 (no-op should not pay the snapshot cost).
      if (payload.stories.length === 0) {
        return Response.json({ restored: 0 });
      }

      // Load the Y.doc and mutate inside blockConcurrencyWhile so the
      // snapshot writeback and broadcast happen atomically w.r.t. other
      // operations on this DO (internal-marker consistency).
      let restored = 0;
      await this.ctx.blockConcurrencyWhile(async () => {
        await this.ensureDocLoaded();

        const storiesArray = this.ydoc.getArray<Y.Map<unknown>>("stories");
        // Compute the starting order so restored entries push onto the
        // end of the existing list deterministically.
        let maxOrder = -1;
        for (let i = 0; i < storiesArray.length; i++) {
          const existing = storiesArray.get(i);
          const order = existing.get("order");
          if (typeof order === "number" && order > maxOrder) maxOrder = order;
        }
        let nextOrder = maxOrder + 1;

        this.ydoc.transact(() => {
          for (const story of payload.stories) {
            // Remove any pre-existing Y.Map(s) with the same story_id.
            // A stale entry with an invalid _id (pointing at a deleted
            // D1 row) would otherwise win the deduplicateYArray pass
            // in snapshotToD1 and our fresh _id=null Y.Map would be
            // discarded, leaving D1 without the row. Walk the array in
            // reverse so deletions don't shift indices we still need.
            for (let i = storiesArray.length - 1; i >= 0; i--) {
              const existing = storiesArray.get(i);
              if (existing.get("story_id") === story.storyId) {
                storiesArray.delete(i, 1);
              }
            }

            const storyMap = new Y.Map<unknown>();
            storyMap.set("_id", null);
            storyMap.set("story_id", story.storyId);
            // title default = storyId (the per-story CSV has no title
            // column; user can rename in /stories). subtitle/byline are
            // not in the per-story CSV either — default to empty Y.Text.
            storyMap.set("title", new Y.Text(story.storyId));
            storyMap.set("subtitle", new Y.Text(""));
            storyMap.set("byline", new Y.Text(""));
            storyMap.set("order", nextOrder++);
            storyMap.set("private", false);
            storyMap.set("draft", true);
            storyMap.set("show_sections", false);

            // Pre-allocate one Y.Array<layer Y.Map> per step (indexed by
            // the step's position in the input array) so we can thread
            // layers without a second pass.
            const stepsArray = new Y.Array<Y.Map<unknown>>();
            const stepLayerArrays: Array<Y.Array<Y.Map<unknown>>> = [];
            for (const step of story.steps ?? []) {
              const stepMap = new Y.Map<unknown>();
              stepMap.set("_id", null);
              stepMap.set("step_number", step.step_number ?? 0);
              stepMap.set("kind", step.kind ?? "media");
              stepMap.set("object_id", step.object_id ?? "");
              stepMap.set("x", step.x ?? null);
              stepMap.set("y", step.y ?? null);
              stepMap.set("zoom", step.zoom ?? null);
              stepMap.set("page", step.page ?? "");
              stepMap.set("question", new Y.Text(step.question ?? ""));
              stepMap.set("answer", new Y.Text(step.answer ?? ""));
              // alt_text is not in the per-story CSV schema (mapStoryCsv
              // does not populate it); restore with empty Y.Text so the
              // Y.Map shape matches buildFromD1Rows exactly.
              stepMap.set("alt_text", new Y.Text(""));
              stepMap.set("clip_start", step.clip_start ?? "");
              stepMap.set("clip_end", step.clip_end ?? "");
              stepMap.set("loop", step.loop ?? "");
              const layersArr = new Y.Array<Y.Map<unknown>>();
              stepLayerArrays.push(layersArr);
              stepMap.set("layers", layersArr);
              stepsArray.push([stepMap]);
            }

            // Thread layers under their parent step by step_index.
            for (const layer of story.layers ?? []) {
              const targetArr = stepLayerArrays[layer.step_index];
              if (!targetArr) continue; // out-of-range step_index — skip silently
              const layerMap = new Y.Map<unknown>();
              layerMap.set("_id", null);
              layerMap.set("layer_number", layer.layer_number);
              layerMap.set("title", new Y.Text(layer.title ?? ""));
              layerMap.set("button_label", new Y.Text(layer.button_label ?? ""));
              layerMap.set("content", new Y.Text(layer.content ?? ""));
              targetArr.push([layerMap]);
            }

            storyMap.set("steps", stepsArray);
            storiesArray.push([storyMap]);
            restored += 1;
          }
        });

        // Persist immediately so the dashboard loader's post-action
        // revalidation sees the new D1 rows on its next orphan scan.
        await this.snapshotToD1();
      });

      // Broadcast the full state to connected /stories editors so they
      // see the new draft(s) appear in real time (mirrors the ID-backfill
      // broadcast at ~line 1578).
      const updateEncoder = encoding.createEncoder();
      encoding.writeVarUint(updateEncoder, messageSync);
      syncProtocol.writeSyncStep2(updateEncoder, this.ydoc);
      const updateMsg = encoding.toUint8Array(updateEncoder);
      for (const client of this.ctx.getWebSockets()) {
        try {
          client.send(updateMsg);
        } catch {
          // Client may have disconnected; ignore.
        }
      }

      return Response.json({ restored });
    }

    // Only accept WebSocket upgrades for all other paths
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    // Extract projectId from /ws/:projectId
    const segments = url.pathname.split("/");
    const projectIdStr = segments[2];
    const projectId = parseInt(projectIdStr ?? "", 10);
    if (isNaN(projectId) || projectId <= 0) {
      return new Response("Invalid project ID", { status: 400 });
    }

    // Authenticate via session cookie or query-string token fallback.
    // The browser sends the httpOnly __compositor_session cookie on WebSocket
    // upgrade requests automatically. Query-string ?token= is kept as a fallback.
    const cookieToken = parseSessionCookie(request.headers.get("Cookie"));
    const token = cookieToken ?? url.searchParams.get("token");
    if (!token) {
      return new Response("Missing auth token", { status: 401 });
    }

    const userId = await this.getUserIdFromToken(token);
    if (!userId) {
      return new Response("Invalid or expired session", { status: 401 });
    }

    // Verify project membership (parameterised query)
    const memberRow = await this.env.DB
      .prepare("SELECT role FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(projectId, userId)
      .first<{ role: string }>();

    if (!memberRow) {
      return new Response("Not a project member", { status: 403 });
    }

    const role = memberRow.role as "convenor" | "collaborator";

    // Store projectId (idempotent — same value for all connections to this DO instance)
    if (!this.projectId) {
      this.projectId = projectId;
    }

    // Serialise cold-start initialisation to prevent race conditions
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ensureDocLoaded();
    });

    // Upgrade the WebSocket connection using the hibernation API
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);

    const attachment: SocketAttachment = { userId, projectId, role };
    server.serializeAttachment(attachment);

    // After acceptWebSocket -- record new session for deferred D1 write
    this.newSessions.add(userId);

    // Send sync step 1 using y-protocols framing so the WebsocketProvider
    // can parse it correctly (message type prefix byte + sync protocol data).
    const syncEncoder = encoding.createEncoder();
    encoding.writeVarUint(syncEncoder, messageSync);
    syncProtocol.writeSyncStep1(syncEncoder, this.ydoc);
    server.send(encoding.toUint8Array(syncEncoder));

    // Send sync step 2 (the full state) so the client is immediately up to date
    const stateEncoder = encoding.createEncoder();
    encoding.writeVarUint(stateEncoder, messageSync);
    syncProtocol.writeSyncStep2(stateEncoder, this.ydoc);
    server.send(encoding.toUint8Array(stateEncoder));

    // Send current awareness state of all connected clients
    const awarenessStates = this.awareness.getStates();
    if (awarenessStates.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, messageAwareness);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(
          this.awareness,
          Array.from(awarenessStates.keys()),
        ),
      );
      server.send(encoding.toUint8Array(awarenessEncoder));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------
  // WebSocket lifecycle handlers (hibernation API)
  // -------------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Normalise to Uint8Array
    const data: Uint8Array =
      typeof message === "string"
        ? new TextEncoder().encode(message)
        : new Uint8Array(message as ArrayBuffer);

    // Parse the y-protocols message type (first varuint byte)
    const decoder = decoding.createDecoder(data);
    const msgType = decoding.readVarUint(decoder);

    if (msgType === messageSync) {
      // Sync protocol message — process and generate response
      const responseEncoder = encoding.createEncoder();
      encoding.writeVarUint(responseEncoder, messageSync);
      const syncMessageType = syncProtocol.readSyncMessage(
        decoder,
        responseEncoder,
        this.ydoc,
        ws,
      );

      // If readSyncMessage produced a response (e.g. sync step 2 reply to step 1),
      // send it back to the requesting client
      if (encoding.length(responseEncoder) > 1) {
        ws.send(encoding.toUint8Array(responseEncoder));
      }

      // Relay sync messages to all other clients
      for (const client of this.ctx.getWebSockets()) {
        if (client !== ws) {
          try {
            client.send(data);
          } catch {
            // Client may have disconnected
          }
        }
      }

      // Schedule the 30-second alarm if not already set
      this.scheduleSnapshot();

      // Emit activity rows NOW, while this instance is warm and the edit's
      // actor is attributable. The snapshot alarm above is only a backstop —
      // hibernation usually evicts this instance before it fires, so the
      // snapshot would otherwise run cold with an empty userFieldSets and lose
      // the edit. Best-effort and non-throwing (see flushActivityRows).
      await this.flushActivityRows();
    } else if (msgType === messageAwareness) {
      // Awareness protocol message — apply to server awareness and relay to all others
      const update = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, ws);

      // Track the awareness clientID on the socket attachment so we can
      // clean up when the WebSocket closes (see webSocketClose)
      const attachment = ws.deserializeAttachment() as SocketAttachment;
      if (attachment && !attachment.awarenessClientId) {
        // The first awareness update from this client contains their clientID.
        // Decode it to extract the clientID for cleanup on disconnect.
        try {
          const updateDecoder = decoding.createDecoder(update);
          const len = decoding.readVarUint(updateDecoder);
          if (len > 0) {
            const clientId = decoding.readVarUint(updateDecoder);
            attachment.awarenessClientId = clientId;
            ws.serializeAttachment(attachment);
          }
        } catch {
          // Non-critical — awareness cleanup on disconnect will be best-effort
        }
      }

      // Relay awareness to all other connected clients (unchanged binary is fine)
      for (const client of this.ctx.getWebSockets()) {
        if (client !== ws) {
          try {
            client.send(data);
          } catch {
            // Client may have disconnected
          }
        }
      }
    }
    // Unknown message types are silently ignored
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // Remove the disconnected client's awareness state and broadcast removal
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.awarenessClientId) {
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [attachment.awarenessClientId],
        "client disconnected",
      );
      // Broadcast awareness removal to remaining clients
      const removalEncoder = encoding.createEncoder();
      encoding.writeVarUint(removalEncoder, messageAwareness);
      encoding.writeVarUint8Array(
        removalEncoder,
        awarenessProtocol.encodeAwarenessUpdate(
          this.awareness,
          [attachment.awarenessClientId],
        ),
      );
      const removalMsg = encoding.toUint8Array(removalEncoder);
      for (const client of this.ctx.getWebSockets()) {
        if (client !== ws) {
          try {
            client.send(removalMsg);
          } catch {
            // Client may have disconnected
          }
        }
      }
    }

    try {
      ws.close(code);
    } catch {
      // Already closed
    }

    // On last-client disconnect, snapshot immediately. Best-effort: a thrown
    // D1 failure here must not surface as an unhandled rejection that could
    // crash the DO. Retry happens on the next connect/forced/publish
    // snapshot, or via the alarm doSnapshot reschedules on a batch failure
    // (note: the periodic alarm does not re-fire once all clients have
    // disconnected).
    if (this.ctx.getWebSockets().length === 0) {
      try {
        await this.snapshotToD1();
      } catch (err) {
        console.error("[snapshot] last-disconnect snapshot failed", err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Alarm — 30-second periodic snapshot
  // -------------------------------------------------------------------------

  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) {
      await this.snapshotToD1();
      // Re-schedule for the next interval while clients remain connected
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
    // If no clients remain, stop the alarm cycle — next connect will reschedule
  }

  // -------------------------------------------------------------------------
  // Public API — called by publish pipeline
  // -------------------------------------------------------------------------

  async forceSnapshot(): Promise<void> {
    await this.snapshotToD1();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Schedule a snapshot alarm 30 seconds from now, unless one is already pending.
   */
  private scheduleSnapshot(): void {
    this.ctx.storage.getAlarm().then((alarm) => {
      if (alarm === null) {
        this.ctx.storage.setAlarm(Date.now() + 30_000);
      }
    });
  }

  /**
   * Ensure the Y.Doc is loaded. Must be called inside blockConcurrencyWhile()
   * to prevent race conditions on cold start.
   */
  private async ensureDocLoaded(): Promise<void> {
    if (this.docLoaded) return;
    if (!this.projectId) return;

    const row = await this.env.DB
      .prepare("SELECT yjs_state FROM projects WHERE id = ?")
      .bind(this.projectId)
      .first<{ yjs_state: ArrayBuffer | null }>();

    if (row?.yjs_state) {
      // Warm restart — restore from binary blob (fastest path)
      Y.applyUpdate(this.ydoc, new Uint8Array(row.yjs_state));
      // Old blobs were serialized before object_type/subjects/source/credit (and
      // config.collection_mode) round-tripped through the snapshot, so their
      // Y.Maps lack those keys. getYText() returns null for a missing key, so
      // the editor's edits to those fields go nowhere (telar-compositor#23), and
      // the snapshot would otherwise clobber D1 with empty/default values. Seed
      // the missing keys from D1 here so existing projects self-heal on load.
      await this.backfillBlobGaps();
    } else {
      // Cold start — build from D1 rows (already includes every field)
      await this.buildFromD1Rows();
    }

    this.docLoaded = true;
  }

  /**
   * Seed Y.Doc keys that pre-date their addition to the snapshot round-trip onto
   * a blob-restored doc, reading current values from D1. Idempotent and
   * non-destructive: only fills a key when it is absent, never overwriting a
   * value already in the live doc (which may hold an unsaved edit). Runs under a
   * null-origin transaction so it is not attributed to any user (no activity /
   * contribution). Without this, an established project (which always restores
   * from the blob, not buildFromD1Rows) would never gain the new keys.
   */
  private async backfillBlobGaps(): Promise<void> {
    if (!this.projectId) return;

    // Objects: the four editable Y.Text fields + the three import passthroughs.
    const objectsArray = this.ydoc.getArray<Y.Map<unknown>>("objects");
    let objectRows: { results: ObjectRow[] } = { results: [] };
    if (objectsArray.length > 0) {
      objectRows = await this.env.DB
        .prepare(
          "SELECT id, object_type, subjects, source, credit, thumbnail, dimensions, " +
          "extra_columns FROM objects WHERE project_id = ?",
        )
        .bind(this.projectId)
        .all<ObjectRow>();
    }
    const objectById = new Map(objectRows.results.map((r) => [r.id, r]));

    // Config: collection_mode is the one toggle missing from older blobs.
    const configRow = await this.env.DB
      .prepare("SELECT collection_mode FROM project_config WHERE project_id = ? LIMIT 1")
      .bind(this.projectId)
      .first<{ collection_mode: number | null }>();

    this.ydoc.transact(() => {
      for (let i = 0; i < objectsArray.length; i++) {
        const o = objectsArray.get(i);
        const id = o.get("_id") as number | null;
        const r = id !== null && id !== undefined ? objectById.get(id) : undefined;
        // Editable Y.Text fields — create only when absent so a live edit wins.
        if (!(o.get("object_type") instanceof Y.Text)) o.set("object_type", new Y.Text(r?.object_type ?? ""));
        if (!(o.get("subjects") instanceof Y.Text)) o.set("subjects", new Y.Text(r?.subjects ?? ""));
        if (!(o.get("source") instanceof Y.Text)) o.set("source", new Y.Text(r?.source ?? ""));
        if (!(o.get("credit") instanceof Y.Text)) o.set("credit", new Y.Text(r?.credit ?? ""));
        // Passthrough values.
        if (o.get("thumbnail") === undefined) o.set("thumbnail", r?.thumbnail ?? "");
        if (o.get("dimensions") === undefined) o.set("dimensions", r?.dimensions ?? "");
        if (o.get("extra_columns") === undefined) o.set("extra_columns", r?.extra_columns ?? "");
      }

      const config = this.ydoc.getMap<unknown>("config");
      if (config.get("collection_mode") === undefined) {
        config.set("collection_mode", configRow?.collection_mode === 1);
      }
    }, null);
  }

  /**
   * Build the Y.Doc from D1 rows on cold start.
   * Populates config, stories (with steps and layers), objects, and glossary.
   */
  private async buildFromD1Rows(): Promise<void> {
    if (!this.projectId) return;

    // Fetch all data in parallel
    const [configRow, landingRow, stories, steps, layers, objects, glossary, pages] =
      await Promise.all([
        this.env.DB
          .prepare("SELECT * FROM project_config WHERE project_id = ? LIMIT 1")
          .bind(this.projectId)
          .first<ConfigRow>(),
        this.env.DB
          .prepare("SELECT * FROM project_landing WHERE project_id = ? LIMIT 1")
          .bind(this.projectId)
          .first<LandingRow>(),
        this.env.DB
          .prepare("SELECT * FROM stories WHERE project_id = ? ORDER BY \"order\" ASC")
          .bind(this.projectId)
          .all<StoryRow>(),
        this.env.DB
          .prepare(
            "SELECT st.* FROM steps st " +
            "INNER JOIN stories s ON st.story_id = s.id " +
            "WHERE s.project_id = ? ORDER BY st.story_id ASC, st.step_number ASC",
          )
          .bind(this.projectId)
          .all<StepRow>(),
        this.env.DB
          .prepare(
            "SELECT l.* FROM layers l " +
            "INNER JOIN steps st ON l.step_id = st.id " +
            "INNER JOIN stories s ON st.story_id = s.id " +
            "WHERE s.project_id = ? ORDER BY l.step_id ASC, l.layer_number ASC",
          )
          .bind(this.projectId)
          .all<LayerRow>(),
        this.env.DB
          .prepare(
            "SELECT id, object_id, title, creator, description, alt_text, source_url, " +
            "period, year, object_type, subjects, source, credit, thumbnail, dimensions, " +
            "extra_columns, featured, image_available, created_by FROM objects WHERE project_id = ? ORDER BY id ASC",
          )
          .bind(this.projectId)
          .all<ObjectRow>(),
        this.env.DB
          .prepare("SELECT * FROM glossary_terms WHERE project_id = ? ORDER BY id ASC")
          .bind(this.projectId)
          .all<GlossaryRow>(),
        this.env.DB
          .prepare("SELECT id, title, slug, body, \"order\", created_by FROM project_pages WHERE project_id = ? ORDER BY \"order\" ASC")
          .bind(this.projectId)
          .all<PageRow>(),
      ]);

    // Build lookup maps for steps and layers
    const stepsByStoryId = new Map<number, StepRow[]>();
    for (const step of steps.results) {
      const arr = stepsByStoryId.get(step.story_id) ?? [];
      arr.push(step);
      stepsByStoryId.set(step.story_id, arr);
    }

    const layersByStepId = new Map<number, LayerRow[]>();
    for (const layer of layers.results) {
      const arr = layersByStepId.get(layer.step_id) ?? [];
      arr.push(layer);
      layersByStepId.set(layer.step_id, arr);
    }

    // Populate everything in a single transaction to avoid multiple observer fires
    this.ydoc.transact(() => {
      // ---- meta ----
      const meta = this.ydoc.getMap<unknown>("meta");
      meta.set("projectId", this.projectId);

      // ---- config ----
      const config = this.ydoc.getMap<unknown>("config");
      if (configRow) {
        // Text fields — use Y.Text for character-level merging
        const titleText = new Y.Text(configRow.title ?? "");
        config.set("title", titleText);
        const descText = new Y.Text(configRow.description ?? "");
        config.set("description", descText);
        const authorText = new Y.Text(configRow.author ?? "");
        config.set("author", authorText);
        const emailText = new Y.Text(configRow.email ?? "");
        config.set("email", emailText);

        // Scalar fields — plain values (atomically replaced)
        config.set("lang", configRow.lang ?? "en");
        config.set("baseurl", configRow.baseurl ?? "");
        config.set("url", configRow.url ?? "");
        config.set("telar_version", configRow.telar_version ?? "");
        config.set("theme", configRow.theme ?? "");
        config.set("logo", configRow.logo ?? "");
        config.set("include_demo_content", configRow.include_demo_content === 1);
        config.set("google_sheets_enabled", configRow.google_sheets_enabled === 1);
        config.set("google_sheets_published_url", configRow.google_sheets_published_url ?? "");
        config.set("show_on_homepage", configRow.show_on_homepage !== 0);
        config.set("show_story_steps", configRow.show_story_steps !== 0);
        config.set("show_object_credits", configRow.show_object_credits !== 0);
        config.set("browse_and_search", configRow.browse_and_search !== 0);
        config.set("show_link_on_homepage", configRow.show_link_on_homepage !== 0);
        config.set("show_sample_on_homepage", configRow.show_sample_on_homepage === 1);
        config.set("collection_mode", configRow.collection_mode === 1);
        config.set("featured_count", configRow.featured_count ?? 4);
        config.set("story_key", configRow.story_key ?? "");
      }

      // ---- landing (nested map inside config) ----
      const landing = new Y.Map<unknown>();
      if (landingRow) {
        landing.set("stories_heading", new Y.Text(landingRow.stories_heading ?? ""));
        landing.set("stories_intro", new Y.Text(landingRow.stories_intro ?? ""));
        landing.set("objects_heading", new Y.Text(landingRow.objects_heading ?? ""));
        landing.set("objects_intro", new Y.Text(landingRow.objects_intro ?? ""));
        landing.set("welcome_body", new Y.Text(landingRow.welcome_body ?? ""));
      }
      config.set("landing", landing);

      // ---- navigation (Y.Array of plain objects inside config map) ----
      const navJson = configRow?.navigation_json ?? null;
      let navItems: unknown[];
      if (navJson) {
        try { navItems = JSON.parse(navJson); } catch { navItems = []; }
      } else {
        // Build default navigation from already-fetched pages + built-in sections
        // (pages is fetched in the parallel Promise.all above — no DB call needed here)
        navItems = [];
        // Built-in sections match Telar site nav order: Home, Objects, Glossary
        navItems.push({ type: "builtin", key: "home", label: "Home", visible: true });
        navItems.push({ type: "builtin", key: "collection", label: "Objects", visible: true });
        navItems.push({ type: "builtin", key: "glossary", label: "Glossary", visible: true });
        // Pages from D1 in order
        for (const page of pages.results) {
          navItems.push({ type: "page", slug: page.slug, label: page.title || page.slug, visible: true });
        }
      }
      const navArray = new Y.Array<unknown>();
      navArray.push(navItems);
      config.set("navigation", navArray);

      // ---- stories ----
      const storiesArray = this.ydoc.getArray<Y.Map<unknown>>("stories");
      for (const story of stories.results) {
        const storyMap = new Y.Map<unknown>();
        storyMap.set("_id", story.id);
        storyMap.set("story_id", story.story_id);
        storyMap.set("title", new Y.Text(story.title ?? ""));
        storyMap.set("subtitle", new Y.Text(story.subtitle ?? ""));
        storyMap.set("byline", new Y.Text(story.byline ?? ""));
        storyMap.set("order", story.order ?? 0);
        storyMap.set("private", story.private === 1);
        storyMap.set("draft", story.draft === 1);
        storyMap.set("show_sections", story.show_sections === 1);
        storyMap.set("created_by", story.created_by ?? null);

        // ---- steps ----
        const stepsArray = new Y.Array<Y.Map<unknown>>();
        for (const step of stepsByStoryId.get(story.id) ?? []) {
          const stepMap = new Y.Map<unknown>();
          stepMap.set("_id", step.id);
          stepMap.set("step_number", step.step_number);
          stepMap.set("kind", step.kind ?? "media");
          stepMap.set("object_id", step.object_id ?? "");
          stepMap.set("x", step.x ?? null);
          stepMap.set("y", step.y ?? null);
          stepMap.set("zoom", step.zoom ?? null);
          stepMap.set("page", step.page ?? "");
          stepMap.set("question", new Y.Text(step.question ?? ""));
          stepMap.set("answer", new Y.Text(step.answer ?? ""));
          stepMap.set("alt_text", new Y.Text(step.alt_text ?? ""));
          stepMap.set("clip_start", step.clip_start ?? "");
          stepMap.set("clip_end", step.clip_end ?? "");
          stepMap.set("loop", step.loop ?? "");
          stepMap.set("created_by", step.created_by ?? null);

          // ---- layers ----
          const layersArray = new Y.Array<Y.Map<unknown>>();
          for (const layer of layersByStepId.get(step.id) ?? []) {
            const layerMap = new Y.Map<unknown>();
            layerMap.set("_id", layer.id);
            layerMap.set("layer_number", layer.layer_number);
            layerMap.set("title", new Y.Text(layer.title ?? ""));
            layerMap.set("button_label", new Y.Text(layer.button_label ?? ""));
            layerMap.set("content", new Y.Text(layer.content ?? ""));
            layerMap.set("created_by", layer.created_by ?? null);
            layersArray.push([layerMap]);
          }
          stepMap.set("layers", layersArray);
          stepsArray.push([stepMap]);
        }
        storyMap.set("steps", stepsArray);
        storiesArray.push([storyMap]);
      }

      // ---- objects ----
      const objectsArray = this.ydoc.getArray<Y.Map<unknown>>("objects");
      for (const obj of objects.results) {
        const objMap = new Y.Map<unknown>();
        objMap.set("_id", obj.id);
        objMap.set("object_id", obj.object_id);
        objMap.set("title", new Y.Text(obj.title ?? ""));
        objMap.set("creator", new Y.Text(obj.creator ?? ""));
        objMap.set("description", new Y.Text(obj.description ?? ""));
        objMap.set("alt_text", new Y.Text(obj.alt_text ?? ""));
        objMap.set("source_url", obj.source_url ?? "");
        objMap.set("period", new Y.Text(obj.period ?? ""));
        objMap.set("year", new Y.Text(obj.year ?? ""));
        // object_type/subjects/source/credit are edited as Y.Text on the detail
        // page; they MUST be loaded here or getYText() returns null and edits go
        // nowhere (telar-compositor#23). thumbnail/dimensions/extra_columns are
        // repo-import passthrough — carried as plain values so the snapshot
        // INSERT/UPDATE round-trips them instead of resetting them.
        objMap.set("object_type", new Y.Text(obj.object_type ?? ""));
        objMap.set("subjects", new Y.Text(obj.subjects ?? ""));
        objMap.set("source", new Y.Text(obj.source ?? ""));
        objMap.set("credit", new Y.Text(obj.credit ?? ""));
        objMap.set("thumbnail", obj.thumbnail ?? "");
        objMap.set("dimensions", obj.dimensions ?? "");
        objMap.set("extra_columns", obj.extra_columns ?? "");
        objMap.set("featured", obj.featured === 1);
        objMap.set("image_available", obj.image_available === 1);
        objMap.set("created_by", obj.created_by ?? null);
        objectsArray.push([objMap]);
      }

      // ---- glossary ----
      const glossaryArray = this.ydoc.getArray<Y.Map<unknown>>("glossary");
      for (const term of glossary.results) {
        const termMap = new Y.Map<unknown>();
        termMap.set("_id", term.id);
        termMap.set("term_id", term.term_id);
        termMap.set("title", new Y.Text(term.title ?? ""));
        termMap.set("definition", new Y.Text(term.definition ?? ""));
        termMap.set("created_by", term.created_by ?? null);
        glossaryArray.push([termMap]);
      }

      // ---- pages ----
      const pagesArray = this.ydoc.getArray<Y.Map<unknown>>("pages");
      for (const pg of pages.results) {
        const pageMap = new Y.Map<unknown>();
        pageMap.set("_id", pg.id);
        pageMap.set("title", new Y.Text(pg.title ?? ""));
        pageMap.set("slug", pg.slug);
        pageMap.set("body", new Y.Text(pg.body ?? ""));
        pageMap.set("order", pg.order ?? 0);
        pageMap.set("created_by", pg.created_by ?? null);
        pagesArray.push([pageMap]);
      }
    });
  }

  /**
   * Snapshot the Y.Doc to D1 — writes both the binary blob and all entity rows.
   * Uses D1 batch for atomicity.
   *
   * Handles INSERT for new Y.Array items (with _id === null) and DELETE for D1
   * rows absent from the Y.Array. For INSERTs, the auto-incremented D1 ID is
   * written back to the Y.Map via ydoc.transact() and broadcast to connected
   * clients so all peers converge on the canonical ID.
   *
   * Protected by isSnapshotting lock to prevent concurrent snapshot invocations
   * (alarm vs. disconnect vs. forceSnapshot) from issuing duplicate INSERTs.
   */
  /**
   * Remove duplicate entries from a Y.Array before snapshot. Duplicates are
   * detected by _id (D1 primary key) and by a secondary entity key (e.g.
   * story_id, object_id). The first occurrence wins; later duplicates are
   * deleted from the Y.Array inside a transaction.
   */
  /**
   * Remove (or re-key) duplicate entries from a top-level Y.Array<Y.Map> keyed
   * by `entityKey`. `mode` decides how a same-key NON-keeper with a distinct _id
   * is handled:
   *   - "delete" (default): the loser is removed. Used for stories/objects/pages
   *     whose key is an FK-like reference (story_id/object_id/slug) — removing a
   *     stray duplicate is correct there.
   *   - "re-key": the loser's `entityKey` is rewritten to a unique value via
   *     makeUniqueTermId so BOTH rows survive. Used for glossary ONLY, where
   *     deleting the loser was a LIVE data-loss bug: the deleted Y.Map then fell
   *     out of the snapshot and its D1 row (definition + related_terms) was
   *     orphan-deleted. A re-key preserves both terms and makes them
   *     constraint-safe ahead of UNIQUE(project_id, term_id).
   * Exact-_id duplicates (two Y.Maps sharing one _id = the same persisted row)
   * always COLLAPSE via delete, in both modes.
   * Returns true iff it re-keyed at least one entry, so the caller can broadcast
   * the mutated Y.Doc to connected clients (otherwise a peer's stale key
   * resurrects the collision via Yjs last-write-wins).
   */
  private deduplicateYArray(
    arrayName: string,
    entityKey: string,
    mode: "delete" | "re-key" = "delete",
  ): boolean {
    const yArray = this.ydoc.getArray<Y.Map<unknown>>(arrayName);
    if (yArray.length === 0) return false;

    // First pass: choose the keeper index per human key. Prefer the entry that
    // already carries a non-null _id (the persisted copy) over an _id=null
    // duplicate — otherwise dedup could drop the live row and keep the null one,
    // re-keying the entity and orphan-deleting its D1 row (FK breakage).
    const keeperByKey = new Map<string, number>();
    for (let i = 0; i < yArray.length; i++) {
      const yMap = yArray.get(i);
      const key = String(yMap.get(entityKey) ?? "");
      if (!key) continue; // empty keys: new items not yet keyed — never key-deduped
      const id = yMap.get("_id") as number | null;
      const thisHasId = id !== null && id !== undefined;
      const current = keeperByKey.get(key);
      if (current === undefined) {
        keeperByKey.set(key, i);
      } else {
        const currentId = yArray.get(current).get("_id") as number | null;
        const currentHasId = currentId !== null && currentId !== undefined;
        // Upgrade only when the current keeper lacks an _id and this one has it
        // (first non-null _id wins; otherwise first occurrence wins).
        if (!currentHasId && thisHasId) keeperByKey.set(key, i);
      }
    }

    // Second pass: classify each non-keeper. An exact _id duplicate (same _id as
    // an already-seen entry = the same persisted row) always collapses via
    // delete. A key-collision non-keeper with a distinct _id is RE-KEYED in
    // re-key mode (both rows kept) or deleted otherwise.
    const seenIds = new Set<number>();
    const indicesToDelete: number[] = [];
    const indicesToRekey: number[] = [];
    for (let i = 0; i < yArray.length; i++) {
      const yMap = yArray.get(i);
      const id = yMap.get("_id") as number | null;
      const key = String(yMap.get(entityKey) ?? "");

      // Exact _id duplicate (same persisted row) collapses first, in BOTH modes —
      // re-keying same-_id Y.Maps would mint a phantom row. The keeper for any
      // _id is always at a lower index (first occurrence / first-with-_id), so it
      // was already recorded in seenIds before this loser is reached.
      if (id !== null && id !== undefined && seenIds.has(id)) {
        indicesToDelete.push(i);
        continue;
      }

      if (key && keeperByKey.get(key) !== i) {
        if (mode === "re-key") {
          indicesToRekey.push(i);
          // The re-keyed loser is kept and is a distinct live row, so track its
          // _id (delete-mode leaves it untracked, since the loser is removed).
          if (id !== null && id !== undefined) seenIds.add(id);
        } else {
          indicesToDelete.push(i);
        }
        continue;
      }
      if (id !== null && id !== undefined) seenIds.add(id);
    }

    if (indicesToRekey.length === 0 && indicesToDelete.length === 0) return false;

    // Re-keys must avoid EVERY live key, so seed the taken set with all keeper
    // keys and grow it as each loser is assigned a fresh, collision-free key.
    const takenKeys = new Set<string>(keeperByKey.keys());
    this.ydoc.transact(() => {
      // Re-key first (no length change), then delete in reverse (indices shift).
      for (const i of indicesToRekey) {
        const yMap = yArray.get(i);
        const current = String(yMap.get(entityKey) ?? "");
        const fresh = makeUniqueTermId(current, [...takenKeys]);
        takenKeys.add(fresh);
        yMap.set(entityKey, fresh);
      }
      for (let i = indicesToDelete.length - 1; i >= 0; i--) {
        yArray.delete(indicesToDelete[i], 1);
      }
    });

    // Dedup runs as a recovery path; surface as a warning so a real bug
    // producing dupes is distinguishable from idle snapshot traffic.
    if (indicesToRekey.length > 0) {
      console.warn(
        `[snapshot] Deduplicated ${arrayName}: re-keyed ${indicesToRekey.length} duplicate(s) to a unique ${entityKey} (content preserved)`,
      );
    }
    if (indicesToDelete.length > 0) {
      console.warn(
        `[snapshot] Deduplicated ${arrayName}: removed ${indicesToDelete.length} duplicate(s)`,
      );
    }
    return indicesToRekey.length > 0;
  }

  /**
   * Remove duplicate entries from a Y.Array<Y.Map> by _id in place.
   * The first occurrence wins; later duplicates are appended to toDelete and
   * removed synchronously (caller is responsible for wrapping in a transact).
   * Items with a null/undefined _id are distinct pending inserts — never removed.
   */
  private dedupeByIdInPlace(arr: Y.Array<Y.Map<unknown>>): void {
    const seen = new Set<number>();
    const toDelete: number[] = [];
    for (let i = 0; i < arr.length; i++) {
      const id = arr.get(i).get("_id") as number | null | undefined;
      if (id !== null && id !== undefined) {
        if (seen.has(id)) {
          toDelete.push(i);
          continue;
        }
        seen.add(id);
      }
    }
    // Delete in reverse order so earlier indices stay valid
    for (let i = toDelete.length - 1; i >= 0; i--) {
      arr.delete(toDelete[i], 1);
    }
    if (toDelete.length > 0) {
      console.warn(
        `[snapshot] Deduplicated nested array: removed ${toDelete.length} duplicate(s)`,
      );
    }
  }

  /**
   * Walk each story's `steps` array (and each step's `layers` array) and
   * remove entries whose `_id` already appeared (first occurrence wins).
   * Mirrors `deduplicateYArray` for the nested level that the top-level pass
   * cannot reach.
   *
   * All mutations are wrapped in a single ydoc.transact so peers receive one
   * atomic update rather than a delete per duplicate.
   */
  private deduplicateNestedStepArrays(): void {
    const storiesArray = this.ydoc.getArray<Y.Map<unknown>>("stories");
    if (storiesArray.length === 0) return;

    this.ydoc.transact(() => {
      for (let s = 0; s < storiesArray.length; s++) {
        const stepsArr = storiesArray.get(s).get("steps");
        if (!(stepsArr instanceof Y.Array)) continue;

        const steps = stepsArr as Y.Array<Y.Map<unknown>>;
        this.dedupeByIdInPlace(steps);

        for (let i = 0; i < steps.length; i++) {
          const layersArr = steps.get(i).get("layers");
          if (layersArr instanceof Y.Array) {
            this.dedupeByIdInPlace(layersArr as Y.Array<Y.Map<unknown>>);
          }
        }
      }
    });
  }

  async snapshotToD1(): Promise<void> {
    if (!this.projectId || !this.docLoaded) return;
    if (this.isSnapshotting) return; // Prevent duplicate INSERTs from concurrent calls
    this.isSnapshotting = true;
    try {
      await this.doSnapshot();
    } finally {
      this.isSnapshotting = false;
    }
  }

  /**
   * Sections 3+4: project_config + project_landing. These are singleton rows
   * (one per project). They are normally created at import/onboarding, but if a
   * project ever reaches the DO without one, a plain UPDATE would match zero rows
   * and silently drop every config/landing edit forever (the same strand class
   * as Fix A). So we SELECT-guard: UPDATE when the row exists, INSERT-on-missing
   * otherwise. `project_config`/`project_landing` have no UNIQUE(project_id)
   * index, hence the explicit existence check rather than ON CONFLICT.
   */
  private async snapshotConfig(statements: D1PreparedStatement[], now: string): Promise<void> {
    // 3. Snapshot config
    const config = this.ydoc.getMap<unknown>("config");
    const landing = config.get("landing") as Y.Map<unknown> | undefined;

    const configVals: unknown[] = [
      yTextToString(config.get("title")),
      yTextToString(config.get("description")),
      yTextToString(config.get("author")),
      yTextToString(config.get("email")),
      String(config.get("lang") ?? "en"),
      String(config.get("baseurl") ?? ""),
      String(config.get("url") ?? ""),
      String(config.get("theme") ?? ""),
      String(config.get("logo") ?? ""),
      config.get("include_demo_content") ? 1 : 0,
      config.get("google_sheets_enabled") ? 1 : 0,
      String(config.get("google_sheets_published_url") ?? ""),
      config.get("show_on_homepage") !== false ? 1 : 0,
      config.get("show_story_steps") !== false ? 1 : 0,
      config.get("show_object_credits") !== false ? 1 : 0,
      config.get("browse_and_search") !== false ? 1 : 0,
      config.get("show_link_on_homepage") !== false ? 1 : 0,
      config.get("show_sample_on_homepage") ? 1 : 0,
      config.get("collection_mode") ? 1 : 0,
      Number(config.get("featured_count") ?? 4),
      String(config.get("story_key") ?? ""),
      JSON.stringify((config.get("navigation") as Y.Array<unknown>)?.toArray() ?? []),
      now,
    ];
    const configExists = await this.env.DB
      .prepare("SELECT id FROM project_config WHERE project_id = ?")
      .bind(this.projectId)
      .first<{ id: number }>();
    if (configExists) {
      statements.push(
        this.env.DB
          .prepare(
            "UPDATE project_config SET " +
            "title = ?, description = ?, author = ?, email = ?, lang = ?, " +
            "baseurl = ?, url = ?, theme = ?, logo = ?, " +
            "include_demo_content = ?, google_sheets_enabled = ?, google_sheets_published_url = ?, " +
            "show_on_homepage = ?, show_story_steps = ?, show_object_credits = ?, " +
            "browse_and_search = ?, show_link_on_homepage = ?, show_sample_on_homepage = ?, " +
            "collection_mode = ?, featured_count = ?, story_key = ?, navigation_json = ?, updated_at = ? " +
            "WHERE project_id = ?",
          )
          .bind(...configVals, this.projectId),
      );
    } else {
      statements.push(
        this.env.DB
          .prepare(
            "INSERT INTO project_config (project_id, " +
            "title, description, author, email, lang, baseurl, url, theme, logo, " +
            "include_demo_content, google_sheets_enabled, google_sheets_published_url, " +
            "show_on_homepage, show_story_steps, show_object_credits, browse_and_search, " +
            "show_link_on_homepage, show_sample_on_homepage, collection_mode, featured_count, story_key, " +
            "navigation_json, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(this.projectId, ...configVals),
      );
    }

    // 4. Snapshot landing (project_landing)
    if (landing) {
      const landingVals: unknown[] = [
        yTextToString(landing.get("stories_heading")),
        yTextToString(landing.get("stories_intro")),
        yTextToString(landing.get("objects_heading")),
        yTextToString(landing.get("objects_intro")),
        yTextToString(landing.get("welcome_body")),
        now,
      ];
      const landingExists = await this.env.DB
        .prepare("SELECT id FROM project_landing WHERE project_id = ?")
        .bind(this.projectId)
        .first<{ id: number }>();
      if (landingExists) {
        statements.push(
          this.env.DB
            .prepare(
              "UPDATE project_landing SET " +
              "stories_heading = ?, stories_intro = ?, objects_heading = ?, " +
              "objects_intro = ?, welcome_body = ?, updated_at = ? " +
              "WHERE project_id = ?",
            )
            .bind(...landingVals, this.projectId),
        );
      } else {
        statements.push(
          this.env.DB
            .prepare(
              "INSERT INTO project_landing (project_id, " +
              "stories_heading, stories_intro, objects_heading, objects_intro, welcome_body, updated_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(this.projectId, ...landingVals),
        );
      }
    }
  }

  /**
   * INSERT one story row. Crash-proof: a failure never throws out of the
   * snapshot — it logs and reschedules instead.
   *   - explicitId undefined → new Y.Map: autoincrement INSERT + backfill `_id`.
   *   - explicitId set → re-create a stranded row WITH the same id (Y.Doc `_id`
   *     stays valid, FK children stay attached). On a constraint failure, retry
   *     once as a fresh autoincrement row + backfill the new id. If that also
   *     fails (e.g. a UNIQUE story_id collision), warn + reschedule and return
   *     id 0 so the caller skips this story's children this pass.
   * Returns the id actually used (0 on terminal failure) and whether `_id` was
   * backfilled (so the caller can broadcast).
   */
  private async insertStoryRow(
    storyMap: Y.Map<unknown>,
    order: number,
    now: string,
    explicitId?: number,
  ): Promise<{ id: number; backfilled: boolean }> {
    const run = async (withId: boolean): Promise<number> => {
      const sql = withId
        ? 'INSERT INTO stories (id, project_id, story_id, title, subtitle, byline, "order", private, draft, show_sections, created_by, updated_at) ' +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        : 'INSERT INTO stories (project_id, story_id, title, subtitle, byline, "order", private, draft, show_sections, created_by, updated_at) ' +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
      const base = [
        this.projectId,
        String(storyMap.get("story_id") ?? ""),
        yTextToString(storyMap.get("title")),
        yTextToString(storyMap.get("subtitle")),
        yTextToString(storyMap.get("byline")),
        order,
        storyMap.get("private") ? 1 : 0,
        storyMap.get("draft") ? 1 : 0,
        storyMap.get("show_sections") ? 1 : 0,
        (storyMap.get("created_by") as number | null) ?? null,
        now,
      ];
      const res = await this.env.DB.prepare(sql).bind(...(withId ? [explicitId, ...base] : base)).run();
      return withId ? (explicitId as number) : (res.meta.last_row_id as number);
    };
    const backfill = (id: number) => { this.ydoc.transact(() => { storyMap.set("_id", id); }); };

    if (explicitId !== undefined) {
      try {
        return { id: await run(true), backfilled: false }; // re-created same id; _id already correct
      } catch {
        try {
          const id = await run(false);
          backfill(id);
          return { id, backfilled: true };
        } catch {
          console.warn(
            `[snapshot] story "${String(storyMap.get("story_id") ?? "")}" insert blocked (likely slug collision) — manual remediation needed`,
          );
          this.scheduleSnapshot();
          return { id: 0, backfilled: false };
        }
      }
    }
    try {
      const id = await run(false);
      backfill(id);
      return { id, backfilled: true };
    } catch {
      console.warn(`[snapshot] new story "${String(storyMap.get("story_id") ?? "")}" insert failed`);
      this.scheduleSnapshot();
      return { id: 0, backfilled: false };
    }
  }

  /** INSERT one step row. Crash-proof; explicit id re-creates a stranded step. */
  private async insertStepRow(
    stepMap: Y.Map<unknown>,
    storyId: number,
    stepNumber: number,
    now: string,
    explicitId?: number,
  ): Promise<{ id: number; backfilled: boolean }> {
    const run = async (withId: boolean): Promise<number> => {
      const sql = withId
        ? "INSERT INTO steps (id, story_id, step_number, kind, object_id, x, y, zoom, page, question, answer, alt_text, clip_start, clip_end, loop, created_by, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        : "INSERT INTO steps (story_id, step_number, kind, object_id, x, y, zoom, page, question, answer, alt_text, clip_start, clip_end, loop, created_by, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
      const base = [
        storyId,
        stepNumber,
        String(stepMap.get("kind") ?? "media"),
        String(stepMap.get("object_id") ?? ""),
        stepMap.get("x") as number | null,
        stepMap.get("y") as number | null,
        stepMap.get("zoom") as number | null,
        String(stepMap.get("page") ?? ""),
        yTextToString(stepMap.get("question")),
        yTextToString(stepMap.get("answer")),
        yTextToString(stepMap.get("alt_text")),
        String(stepMap.get("clip_start") ?? ""),
        String(stepMap.get("clip_end") ?? ""),
        String(stepMap.get("loop") ?? ""),
        (stepMap.get("created_by") as number | null) ?? null,
        now,
      ];
      const res = await this.env.DB.prepare(sql).bind(...(withId ? [explicitId, ...base] : base)).run();
      return withId ? (explicitId as number) : (res.meta.last_row_id as number);
    };
    const backfill = (id: number) => { this.ydoc.transact(() => { stepMap.set("_id", id); }); };

    if (explicitId !== undefined) {
      try {
        return { id: await run(true), backfilled: false };
      } catch {
        try {
          const id = await run(false);
          backfill(id);
          return { id, backfilled: true };
        } catch {
          console.warn("[snapshot] step insert blocked — manual remediation needed");
          this.scheduleSnapshot();
          return { id: 0, backfilled: false };
        }
      }
    }
    try {
      const id = await run(false);
      backfill(id);
      return { id, backfilled: true };
    } catch {
      console.warn("[snapshot] new step insert failed");
      this.scheduleSnapshot();
      return { id: 0, backfilled: false };
    }
  }

  /** INSERT one layer row. Crash-proof; explicit id re-creates a stranded layer. */
  private async insertLayerRow(
    layerMap: Y.Map<unknown>,
    stepId: number,
    layerNumber: number,
    now: string,
    explicitId?: number,
  ): Promise<{ id: number; backfilled: boolean }> {
    const run = async (withId: boolean): Promise<number> => {
      const sql = withId
        ? "INSERT INTO layers (id, step_id, layer_number, title, button_label, content, created_by, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        : "INSERT INTO layers (step_id, layer_number, title, button_label, content, created_by, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)";
      const base = [
        stepId,
        layerNumber,
        yTextToString(layerMap.get("title")),
        yTextToString(layerMap.get("button_label")),
        yTextToString(layerMap.get("content")),
        (layerMap.get("created_by") as number | null) ?? null,
        now,
      ];
      const res = await this.env.DB.prepare(sql).bind(...(withId ? [explicitId, ...base] : base)).run();
      return withId ? (explicitId as number) : (res.meta.last_row_id as number);
    };
    const backfill = (id: number) => { this.ydoc.transact(() => { layerMap.set("_id", id); }); };

    if (explicitId !== undefined) {
      try {
        return { id: await run(true), backfilled: false };
      } catch {
        try {
          const id = await run(false);
          backfill(id);
          return { id, backfilled: true };
        } catch {
          console.warn("[snapshot] layer insert blocked — manual remediation needed");
          this.scheduleSnapshot();
          return { id: 0, backfilled: false };
        }
      }
    }
    try {
      const id = await run(false);
      backfill(id);
      return { id, backfilled: true };
    } catch {
      console.warn("[snapshot] new layer insert failed");
      this.scheduleSnapshot();
      return { id: 0, backfilled: false };
    }
  }

  /**
   * Section 5: stories + nested steps + layers. INSERT (with _id backfill),
   * UPDATE, DELETE, and the story→steps→layers cascade. Returns whether any
   * INSERT backfilled an _id onto a Y.Map (the caller's didBackfill).
   */
  private async snapshotStories(
    statements: D1PreparedStatement[],
    now: string,
  ): Promise<boolean> {
    let didBackfill = false;
    // 5. Snapshot stories, steps, and layers — handles INSERT for new Y.Maps
    //    (with _id === null), UPDATE for existing ones, DELETE for D1 rows
    //    absent from the Y.Array, and cascade deletes (story → steps → layers).
    const storiesArray = this.ydoc.getArray<Y.Map<unknown>>("stories");

    // Fetch all D1 story IDs for this project so we can detect orphans
    const d1StoriesResult = await this.env.DB
      .prepare("SELECT id FROM stories WHERE project_id = ?")
      .bind(this.projectId)
      .all<{ id: number }>();
    const d1StoryIds = new Set(d1StoriesResult.results.map((r) => r.id));

    for (let si = 0; si < storiesArray.length; si++) {
      const storyMap = storiesArray.get(si);
      let storyId = storyMap.get("_id") as number | null;

      if (storyId === null || storyId === undefined) {
        // New Y.Map — INSERT (autoincrement) + backfill the canonical id.
        const r = await this.insertStoryRow(storyMap, si, now);
        if (r.backfilled) didBackfill = true;
        storyId = r.id;
        if (!storyId) continue; // INSERT failed (crash-proofed); retry next snapshot
      } else if (!d1StoryIds.has(storyId)) {
        // Stale _id: the D1 row was deleted out from under this Y.Map. Stories own
        // FK children (steps/layers), so we do NOT adopt a same-slug live row
        // (that would clobber the live row's children). Re-INSERT with the SAME
        // id so the children's story_id FK stays valid; on a constraint failure
        // insertStoryRow falls back to a new id, and a same-slug collision
        // degrades to caught+logged+stranded (no crash, no silent clobber).
        const r = await this.insertStoryRow(storyMap, si, now, storyId);
        if (r.backfilled) didBackfill = true;
        storyId = r.id;
        if (!storyId) continue; // re-INSERT blocked; left stranded for remediation
      } else {
        statements.push(
          this.env.DB
            .prepare(
              // story_id is INTENTIONALLY not in this SET clause (unlike
              // glossary.term_id / objects.object_id). Stories have no rename UI
              // (story_id is set once at creation), and stories(project_id,
              // story_id) is UNIQUE (migration 0002). This UPDATE runs inside the
              // atomic D1 batch, so a story_id write that ever collided would
              // discard EVERY entity's writes in the snapshot — all downside, no
              // benefit. Do not "complete the symmetry" by adding it.
              "UPDATE stories SET title = ?, subtitle = ?, byline = ?, " +
              "\"order\" = ?, private = ?, draft = ?, show_sections = ?, updated_at = ? WHERE id = ?",
            )
            .bind(
              yTextToString(storyMap.get("title")),
              yTextToString(storyMap.get("subtitle")),
              yTextToString(storyMap.get("byline")),
              si, // order from Y.Array index (keeps D1 aligned with Yjs position)
              storyMap.get("private") ? 1 : 0,
              storyMap.get("draft") ? 1 : 0,
              storyMap.get("show_sections") ? 1 : 0,
              now,
              storyId,
            ),
        );
        d1StoryIds.delete(storyId);
      }

      // --- steps for this story ---
      const stepsArray = storyMap.get("steps") as Y.Array<Y.Map<unknown>> | undefined;
      const d1StepsResult = await this.env.DB
        .prepare("SELECT id FROM steps WHERE story_id = ?")
        .bind(storyId)
        .all<{ id: number }>();
      const d1StepIds = new Set(d1StepsResult.results.map((r) => r.id));

      if (stepsArray) {
        for (let sti = 0; sti < stepsArray.length; sti++) {
          const stepMap = stepsArray.get(sti);
          let stepId = stepMap.get("_id") as number | null;

          if (stepId === null || stepId === undefined) {
            const r = await this.insertStepRow(stepMap, storyId, sti + 1, now);
            if (r.backfilled) didBackfill = true;
            stepId = r.id;
            if (!stepId) continue; // INSERT failed (crash-proofed); skip its layers
          } else if (!d1StepIds.has(stepId)) {
            // Stale _id: the D1 row was deleted (e.g. cascade when its story was
            // orphaned, then undo restored the Y.Map). Re-INSERT with the same id
            // so the layers' step_id FK stays valid. No human key → no adopt.
            const r = await this.insertStepRow(stepMap, storyId, sti + 1, now, stepId);
            if (r.backfilled) didBackfill = true;
            stepId = r.id;
            if (!stepId) continue;
          } else {
            statements.push(
              this.env.DB
                .prepare(
                  "UPDATE steps SET step_number = ?, kind = ?, object_id = ?, x = ?, y = ?, zoom = ?, " +
                  "page = ?, question = ?, answer = ?, alt_text = ?, " +
                  "clip_start = ?, clip_end = ?, loop = ?, updated_at = ? WHERE id = ?",
                )
                .bind(
                  sti + 1, // step_number normalised from Y.Array index
                  String(stepMap.get("kind") ?? "media"),
                  String(stepMap.get("object_id") ?? ""),
                  stepMap.get("x") as number | null,
                  stepMap.get("y") as number | null,
                  stepMap.get("zoom") as number | null,
                  String(stepMap.get("page") ?? ""),
                  yTextToString(stepMap.get("question")),
                  yTextToString(stepMap.get("answer")),
                  yTextToString(stepMap.get("alt_text")),
                  String(stepMap.get("clip_start") ?? ""),
                  String(stepMap.get("clip_end") ?? ""),
                  String(stepMap.get("loop") ?? ""),
                  now,
                  stepId,
                ),
            );
            d1StepIds.delete(stepId);
          }

          // --- layers for this step ---
          const layersArray = stepMap.get("layers") as Y.Array<Y.Map<unknown>> | undefined;
          const d1LayersResult = await this.env.DB
            .prepare("SELECT id FROM layers WHERE step_id = ?")
            .bind(stepId)
            .all<{ id: number }>();
          const d1LayerIds = new Set(d1LayersResult.results.map((r) => r.id));

          if (layersArray) {
            for (let li = 0; li < layersArray.length; li++) {
              const layerMap = layersArray.get(li);
              let layerId = layerMap.get("_id") as number | null;

              if (layerId === null || layerId === undefined) {
                const r = await this.insertLayerRow(layerMap, stepId, li + 1, now);
                if (r.backfilled) didBackfill = true;
              } else if (!d1LayerIds.has(layerId)) {
                // Stale _id: re-INSERT with the same id (no human key → no adopt).
                const r = await this.insertLayerRow(layerMap, stepId, li + 1, now, layerId);
                if (r.backfilled) didBackfill = true;
              } else {
                statements.push(
                  this.env.DB
                    .prepare(
                      "UPDATE layers SET layer_number = ?, title = ?, button_label = ?, " +
                      "content = ?, updated_at = ? WHERE id = ?",
                    )
                    .bind(
                      li + 1,
                      yTextToString(layerMap.get("title")),
                      yTextToString(layerMap.get("button_label")),
                      yTextToString(layerMap.get("content")),
                      now,
                      layerId,
                    ),
                );
                d1LayerIds.delete(layerId);
              }
            }
          }

          // DELETE orphan layers for this step
          for (const orphanLayerId of d1LayerIds) {
            statements.push(
              this.env.DB
                .prepare("DELETE FROM layers WHERE id = ?")
                .bind(orphanLayerId),
            );
          }
        }
      }

      // DELETE orphan steps for this story (cascade to their layers first)
      for (const orphanStepId of d1StepIds) {
        statements.push(
          this.env.DB
            .prepare("DELETE FROM layers WHERE step_id = ?")
            .bind(orphanStepId),
        );
        statements.push(
          this.env.DB
            .prepare("DELETE FROM steps WHERE id = ?")
            .bind(orphanStepId),
        );
      }
    }

    // DELETE orphan stories (cascade: layers → steps → story)
    for (const orphanStoryId of d1StoryIds) {
      const orphanStepsResult = await this.env.DB
        .prepare("SELECT id FROM steps WHERE story_id = ?")
        .bind(orphanStoryId)
        .all<{ id: number }>();
      for (const s of orphanStepsResult.results) {
        statements.push(
          this.env.DB
            .prepare("DELETE FROM layers WHERE step_id = ?")
            .bind(s.id),
        );
      }
      statements.push(
        this.env.DB
          .prepare("DELETE FROM steps WHERE story_id = ?")
          .bind(orphanStoryId),
      );
      statements.push(
        this.env.DB
          .prepare("DELETE FROM stories WHERE id = ?")
          .bind(orphanStoryId),
      );
    }
    return didBackfill;
  }

  /**
   * INSERT one object row. Crash-proof, mirroring `insertStoryRow`:
   * explicitId undefined → new autoincrement row + backfill; explicitId set →
   * re-create a stranded row with the same id, falling back to autoincrement +
   * backfill on a constraint failure, and to a logged no-op (id 0) if that also
   * fails. Carries every content column the Y.Map holds — including
   * object_type/subjects/source/credit (editable) and thumbnail/dimensions/
   * extra_columns (import passthrough), all loaded by buildFromD1Rows — so a
   * re-INSERT preserves them instead of resetting them. origin defaults and
   * missing_from_repo=0 on a fresh insert.
   */
  private async insertObjectRow(
    objMap: Y.Map<unknown>,
    now: string,
    explicitId?: number,
  ): Promise<{ id: number; backfilled: boolean }> {
    const run = async (withId: boolean): Promise<number> => {
      const sql = withId
        ? "INSERT INTO objects (id, project_id, object_id, title, creator, description, alt_text, source_url, period, year, object_type, subjects, source, credit, thumbnail, dimensions, extra_columns, featured, image_available, origin, missing_from_repo, created_by, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        : "INSERT INTO objects (project_id, object_id, title, creator, description, alt_text, source_url, period, year, object_type, subjects, source, credit, thumbnail, dimensions, extra_columns, featured, image_available, origin, missing_from_repo, created_by, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
      const base = [
        this.projectId,
        String(objMap.get("object_id") ?? ""),
        yTextToString(objMap.get("title")),
        yTextToString(objMap.get("creator")),
        yTextToString(objMap.get("description")),
        yTextToString(objMap.get("alt_text")),
        String(objMap.get("source_url") ?? ""),
        yTextToString(objMap.get("period")),
        yTextToString(objMap.get("year")),
        yTextToString(objMap.get("object_type")),
        yTextToString(objMap.get("subjects")),
        yTextToString(objMap.get("source")),
        yTextToString(objMap.get("credit")),
        String(objMap.get("thumbnail") ?? ""),
        String(objMap.get("dimensions") ?? ""),
        String(objMap.get("extra_columns") ?? ""),
        objMap.get("featured") ? 1 : 0,
        objMap.get("image_available") ? 1 : 0,
        String(objMap.get("origin") ?? "iiif"),
        0, // missing_from_repo = false on insert
        (objMap.get("created_by") as number | null) ?? null,
        now,
      ];
      const res = await this.env.DB.prepare(sql).bind(...(withId ? [explicitId, ...base] : base)).run();
      return withId ? (explicitId as number) : (res.meta.last_row_id as number);
    };
    const backfill = (id: number) => { this.ydoc.transact(() => { objMap.set("_id", id); }); };

    if (explicitId !== undefined) {
      try {
        return { id: await run(true), backfilled: false };
      } catch {
        try {
          const id = await run(false);
          backfill(id);
          return { id, backfilled: true };
        } catch {
          console.warn(
            `[snapshot] object "${String(objMap.get("object_id") ?? "")}" insert blocked — manual remediation needed`,
          );
          this.scheduleSnapshot();
          return { id: 0, backfilled: false };
        }
      }
    }
    try {
      const id = await run(false);
      backfill(id);
      return { id, backfilled: true };
    } catch {
      console.warn(`[snapshot] new object "${String(objMap.get("object_id") ?? "")}" insert failed`);
      this.scheduleSnapshot();
      return { id: 0, backfilled: false };
    }
  }

  /** Section 6: objects INSERT (with _id backfill) / UPDATE / DELETE. */
  private async snapshotObjects(
    statements: D1PreparedStatement[],
    now: string,
  ): Promise<boolean> {
    let didBackfill = false;
    // 6. Snapshot objects — INSERT for new IIIF items (with _id === null),
    //    UPDATE for existing ones, DELETE for orphans. Objects with
    //    _validation_state === "pending" are skipped so the object does
    //    not persist to D1 until the IIIF manifest has been validated.
    //    Order column is written from the Y.Array index.
    const objectsArray = this.ydoc.getArray<Y.Map<unknown>>("objects");
    const d1ObjectsResult = await this.env.DB
      .prepare("SELECT id, object_id FROM objects WHERE project_id = ?")
      .bind(this.projectId)
      .all<{ id: number; object_id: string }>();
    const d1ObjectIds = new Set(d1ObjectsResult.results.map((r) => r.id));
    const d1ObjectKeyToId = new Map(
      d1ObjectsResult.results.filter((r) => r.object_id).map((r) => [r.object_id, r.id]),
    );

    // Push the object UPDATE bound to a target row id (used for both an in-place
    // update and an adopt onto a live same-object_id row).
    const pushObjectUpdate = (m: Y.Map<unknown>, targetId: number) => {
      statements.push(
        this.env.DB
          .prepare(
            // object_id IS written here for symmetry with the glossary fix:
            // object_id has no UNIQUE index, so persisting the human key on
            // UPDATE is constraint-free and keeps D1 faithful to the Y.Doc.
            "UPDATE objects SET title = ?, object_id = ?, creator = ?, description = ?, alt_text = ?, " +
            "source_url = ?, period = ?, year = ?, object_type = ?, subjects = ?, " +
            "source = ?, credit = ?, thumbnail = ?, dimensions = ?, extra_columns = ?, " +
            "featured = ?, image_available = ?, updated_at = ? WHERE id = ?",
          )
          .bind(
            yTextToString(m.get("title")),
            String(m.get("object_id") ?? ""),
            yTextToString(m.get("creator")),
            yTextToString(m.get("description")),
            yTextToString(m.get("alt_text")),
            String(m.get("source_url") ?? ""),
            yTextToString(m.get("period")),
            yTextToString(m.get("year")),
            yTextToString(m.get("object_type")),
            yTextToString(m.get("subjects")),
            yTextToString(m.get("source")),
            yTextToString(m.get("credit")),
            String(m.get("thumbnail") ?? ""),
            String(m.get("dimensions") ?? ""),
            String(m.get("extra_columns") ?? ""),
            m.get("featured") ? 1 : 0,
            m.get("image_available") ? 1 : 0,
            now,
            targetId,
          ),
      );
    };

    for (let oi = 0; oi < objectsArray.length; oi++) {
      const objMap = objectsArray.get(oi);
      let objId = objMap.get("_id") as number | null;

      // Skip pending-validation IIIF objects — they are not yet ready to persist
      if (objMap.get("_validation_state") === "pending") {
        // If a previously-inserted object has regressed to "pending", leave its
        // D1 row alone (unlikely path, but be conservative).
        if (typeof objId === "number") d1ObjectIds.delete(objId);
        continue;
      }

      if (objId === null || objId === undefined) {
        const r = await this.insertObjectRow(objMap, now);
        if (r.backfilled) didBackfill = true;
      } else if (d1ObjectIds.has(objId)) {
        pushObjectUpdate(objMap, objId);
        d1ObjectIds.delete(objId);
      } else {
        // Stale _id: the D1 row was deleted out from under this Y.Map. Objects
        // have no FK children, so adopt a live same-object_id row when one exists
        // (UPDATE it — the Y.Map now carries every content column, including
        // object_type/subjects/source/credit/thumbnail/dimensions/extra_columns,
        // so the UPDATE writes them faithfully; only origin and missing_from_repo
        // are D1-only and preserved by omission). Otherwise re-INSERT with the
        // same id; only origin (default) and missing_from_repo (0) reset.
        const key = String(objMap.get("object_id") ?? "");
        const liveId = key ? d1ObjectKeyToId.get(key) : undefined;
        if (liveId !== undefined) {
          pushObjectUpdate(objMap, liveId);
          const adoptId = liveId;
          this.ydoc.transact(() => { objMap.set("_id", adoptId); });
          didBackfill = true;
          d1ObjectIds.delete(liveId);
        } else {
          const r = await this.insertObjectRow(objMap, now, objId);
          if (r.backfilled) didBackfill = true;
        }
      }
    }

    // DELETE orphan objects
    for (const orphanObjId of d1ObjectIds) {
      statements.push(
        this.env.DB
          .prepare("DELETE FROM objects WHERE id = ?")
          .bind(orphanObjId),
      );
    }
    return didBackfill;
  }

  /**
   * INSERT one glossary term. Crash-proof, mirroring `insertObjectRow`. The
   * term_id resolution (slugify on a brand-new term, keep the existing slug for a
   * re-created stranded term) is shared by both paths: a stranded term already
   * carries its term_id, so `resolvedTermId` is that existing value.
   */
  private async insertGlossaryRow(
    termMap: Y.Map<unknown>,
    now: string,
    explicitId?: number,
  ): Promise<{ id: number; backfilled: boolean }> {
    const existingTermId = termMap.get("term_id") as string | undefined;
    const tempId = termMap.get("_temp_id") as string | undefined;
    const titleStr = yTextToString(termMap.get("title"));
    const slugBase = titleStr.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const resolvedTermId = existingTermId
      ? existingTermId
      : slugBase
        ? `${slugBase}-${(tempId ?? crypto.randomUUID()).slice(0, 8)}`
        : (tempId ?? crypto.randomUUID());

    const run = async (withId: boolean): Promise<number> => {
      const sql = withId
        ? "INSERT INTO glossary_terms (id, project_id, term_id, title, definition, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        : "INSERT INTO glossary_terms (project_id, term_id, title, definition, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)";
      const base = [
        this.projectId,
        resolvedTermId,
        titleStr,
        yTextToString(termMap.get("definition")),
        (termMap.get("created_by") as number | null) ?? null,
        now,
      ];
      const res = await this.env.DB.prepare(sql).bind(...(withId ? [explicitId, ...base] : base)).run();
      return withId ? (explicitId as number) : (res.meta.last_row_id as number);
    };
    const backfill = (id: number) => {
      this.ydoc.transact(() => {
        termMap.set("_id", id);
        if (!existingTermId) termMap.set("term_id", resolvedTermId);
      });
    };

    if (explicitId !== undefined) {
      try {
        return { id: await run(true), backfilled: false };
      } catch {
        try {
          const id = await run(false);
          backfill(id);
          return { id, backfilled: true };
        } catch {
          console.warn(`[snapshot] glossary term "${resolvedTermId}" insert blocked — manual remediation needed`);
          this.scheduleSnapshot();
          return { id: 0, backfilled: false };
        }
      }
    }
    try {
      const id = await run(false);
      backfill(id);
      return { id, backfilled: true };
    } catch {
      console.warn(`[snapshot] new glossary term "${resolvedTermId}" insert failed`);
      this.scheduleSnapshot();
      return { id: 0, backfilled: false };
    }
  }

  /** Section 7: glossary_terms INSERT (with _id backfill) / UPDATE / DELETE. */
  private async snapshotGlossary(
    statements: D1PreparedStatement[],
    now: string,
  ): Promise<boolean> {
    let didBackfill = false;
    // 7. Snapshot glossary — INSERT / UPDATE / DELETE.
    //    term_id on INSERT: slugify the title if present, otherwise fall back
    //    to the Y.Map's _temp_id (UUID) so the NOT NULL constraint is satisfied.
    const glossaryArray = this.ydoc.getArray<Y.Map<unknown>>("glossary");
    const d1GlossaryResult = await this.env.DB
      .prepare("SELECT id, term_id FROM glossary_terms WHERE project_id = ?")
      .bind(this.projectId)
      .all<{ id: number; term_id: string }>();
    const d1GlossaryIds = new Set(d1GlossaryResult.results.map((r) => r.id));
    const d1GlossaryKeyToId = new Map(
      d1GlossaryResult.results.filter((r) => r.term_id).map((r) => [r.term_id, r.id]),
    );

    const pushGlossaryUpdate = (m: Y.Map<unknown>, targetId: number) => {
      statements.push(
        this.env.DB
          .prepare(
            // term_id IS written here (unlike stories.story_id): the glossary
            // editor lets users rename a term's id, and term_id has no UNIQUE
            // index, so persisting it on UPDATE can never collide/abort the batch.
            "UPDATE glossary_terms SET title = ?, term_id = ?, definition = ?, updated_at = ? WHERE id = ?",
          )
          .bind(
            yTextToString(m.get("title")),
            // term_id is a plain-string Y.Map field (not a Y.Text), so bind it
            // with String(...) like the page slug — yTextToString would emit
            // "[object Object]" on a non-Y.Text value.
            String(m.get("term_id") ?? ""),
            yTextToString(m.get("definition")),
            now,
            targetId,
          ),
      );
    };

    for (let gi = 0; gi < glossaryArray.length; gi++) {
      const termMap = glossaryArray.get(gi);
      const termId = termMap.get("_id") as number | null;

      if (termId === null || termId === undefined) {
        const r = await this.insertGlossaryRow(termMap, now);
        if (r.backfilled) didBackfill = true;
      } else if (d1GlossaryIds.has(termId)) {
        pushGlossaryUpdate(termMap, termId);
        d1GlossaryIds.delete(termId);
      } else {
        // Stale _id: adopt a live same-term_id row when one exists, else
        // re-INSERT with the same id (term_id has no UNIQUE constraint).
        const key = String(termMap.get("term_id") ?? "");
        const liveId = key ? d1GlossaryKeyToId.get(key) : undefined;
        if (liveId !== undefined) {
          pushGlossaryUpdate(termMap, liveId);
          const adoptId = liveId;
          this.ydoc.transact(() => { termMap.set("_id", adoptId); });
          didBackfill = true;
          d1GlossaryIds.delete(liveId);
        } else {
          const r = await this.insertGlossaryRow(termMap, now, termId);
          if (r.backfilled) didBackfill = true;
        }
      }
    }

    // DELETE orphan glossary terms
    for (const orphanTermId of d1GlossaryIds) {
      statements.push(
        this.env.DB
          .prepare("DELETE FROM glossary_terms WHERE id = ?")
          .bind(orphanTermId),
      );
    }
    return didBackfill;
  }

  /** INSERT one project_pages row. Crash-proof, mirroring `insertObjectRow`. */
  private async insertPageRow(
    pageMap: Y.Map<unknown>,
    order: number,
    now: string,
    explicitId?: number,
  ): Promise<{ id: number; backfilled: boolean }> {
    const run = async (withId: boolean): Promise<number> => {
      const sql = withId
        ? 'INSERT INTO project_pages (id, project_id, title, slug, body, "order", created_by, updated_at) ' +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        : 'INSERT INTO project_pages (project_id, title, slug, body, "order", created_by, updated_at) ' +
          "VALUES (?, ?, ?, ?, ?, ?, ?)";
      const base = [
        this.projectId,
        yTextToString(pageMap.get("title")),
        String(pageMap.get("slug") ?? ""),
        yTextToString(pageMap.get("body")),
        order,
        (pageMap.get("created_by") as number | null) ?? null,
        now,
      ];
      const res = await this.env.DB.prepare(sql).bind(...(withId ? [explicitId, ...base] : base)).run();
      return withId ? (explicitId as number) : (res.meta.last_row_id as number);
    };
    const backfill = (id: number) => { this.ydoc.transact(() => { pageMap.set("_id", id); }); };

    if (explicitId !== undefined) {
      try {
        return { id: await run(true), backfilled: false };
      } catch {
        try {
          const id = await run(false);
          backfill(id);
          return { id, backfilled: true };
        } catch {
          console.warn(`[snapshot] page "${String(pageMap.get("slug") ?? "")}" insert blocked — manual remediation needed`);
          this.scheduleSnapshot();
          return { id: 0, backfilled: false };
        }
      }
    }
    try {
      const id = await run(false);
      backfill(id);
      return { id, backfilled: true };
    } catch {
      console.warn(`[snapshot] new page "${String(pageMap.get("slug") ?? "")}" insert failed`);
      this.scheduleSnapshot();
      return { id: 0, backfilled: false };
    }
  }

  /** Section 8: project_pages INSERT (with _id backfill) / UPDATE / DELETE. */
  private async snapshotPages(
    statements: D1PreparedStatement[],
    now: string,
  ): Promise<boolean> {
    let didBackfill = false;
    // 8. Snapshot pages — INSERT / UPDATE / DELETE. Order written from Y.Array
    //    index so D1 stays aligned with the Yjs position.
    const pagesArray = this.ydoc.getArray<Y.Map<unknown>>("pages");
    const d1PagesResult = await this.env.DB
      .prepare("SELECT id, slug FROM project_pages WHERE project_id = ?")
      .bind(this.projectId)
      .all<{ id: number; slug: string }>();
    const d1PageIds = new Set(d1PagesResult.results.map((r) => r.id));
    const d1PageKeyToId = new Map(
      d1PagesResult.results.filter((r) => r.slug).map((r) => [r.slug, r.id]),
    );

    const pushPageUpdate = (m: Y.Map<unknown>, order: number, targetId: number) => {
      statements.push(
        this.env.DB
          .prepare(
            'UPDATE project_pages SET title = ?, slug = ?, body = ?, ' +
            '"order" = ?, updated_at = ? WHERE id = ?',
          )
          .bind(
            yTextToString(m.get("title")),
            String(m.get("slug") ?? ""),
            yTextToString(m.get("body")),
            order,
            now,
            targetId,
          ),
      );
    };

    for (let pi = 0; pi < pagesArray.length; pi++) {
      const pageMap = pagesArray.get(pi);
      const pageId = pageMap.get("_id") as number | null;

      if (pageId === null || pageId === undefined) {
        const r = await this.insertPageRow(pageMap, pi, now);
        if (r.backfilled) didBackfill = true;
      } else if (d1PageIds.has(pageId)) {
        pushPageUpdate(pageMap, pi, pageId);
        d1PageIds.delete(pageId);
      } else {
        // Stale _id: adopt a live same-slug row when one exists (UNIQUE-safe),
        // else re-INSERT with the same id.
        const key = String(pageMap.get("slug") ?? "");
        const liveId = key ? d1PageKeyToId.get(key) : undefined;
        if (liveId !== undefined) {
          pushPageUpdate(pageMap, pi, liveId);
          const adoptId = liveId;
          this.ydoc.transact(() => { pageMap.set("_id", adoptId); });
          didBackfill = true;
          d1PageIds.delete(liveId);
        } else {
          const r = await this.insertPageRow(pageMap, pi, now, pageId);
          if (r.backfilled) didBackfill = true;
        }
      }
    }

    // DELETE orphan pages
    for (const orphanPageId of d1PageIds) {
      statements.push(
        this.env.DB
          .prepare("DELETE FROM project_pages WHERE id = ?")
          .bind(orphanPageId),
      );
    }
    return didBackfill;
  }

  /**
   * Section 9: project_members contribution UPDATEs + activity_log INSERTs +
   * retention prune. Returns the activity keys to commit to `activityEmitted`
   * only AFTER the batch succeeds (the caller owns that deferral).
   */
  private async snapshotContributions(
    statements: D1PreparedStatement[],
    now: string,
  ): Promise<Array<{ actorUserId: number; entityKey: string }>> {
    // 9. Snapshot contribution data to project_members.
    // fields_edited is sourced from userFieldSets.get(userId).size (unique-field
    // Set semantics). The Set is NOT cleared after snapshot — it keeps accumulating
    // within the DO's lifetime (accepted behaviour).
    // Contribution UPDATE statements are added to the same batch for atomicity.
    //
    // Deferred in-memory mutations (E2 fix): activityEmitted and newSessions are
    // updated only AFTER the batch succeeds. Declared here so they remain in
    // scope at the commit point after the try/catch.
    const newlyEmittedKeys: Array<{ actorUserId: number; entityKey: string }> = [];
    if (this.projectId) {
      const allUserIds = new Set<number>([...this.userFieldSets.keys(), ...this.newSessions]);
      // Include all users with field edits or new sessions
      const activeUserIds = [...allUserIds].filter((uid) =>
        (this.userFieldSets.get(uid)?.size ?? 0) > 0 || this.newSessions.has(uid)
      );

      if (activeUserIds.length > 0) {
        // Batch all contribution reads into a single query
        const placeholders = activeUserIds.map(() => "?").join(", ");
        const existingRows = await this.env.DB
          .prepare(
            `SELECT user_id, contributions FROM project_members WHERE project_id = ? AND user_id IN (${placeholders})`,
          )
          .bind(this.projectId, ...activeUserIds)
          .all<{ user_id: number; contributions: string | null }>();

        const existingMap = new Map(
          existingRows.results.map((r) => [r.user_id, r.contributions]),
        );

        for (const userId of activeUserIds) {
          const fieldSet = this.userFieldSets.get(userId);
          const isNewSession = this.newSessions.has(userId);
          const raw = existingMap.get(userId) ?? null;
          const prev = raw ? JSON.parse(raw) : {};
          const updated = buildContributionUpdate(prev, fieldSet, isNewSession);
          if (fieldSet && fieldSet.size > 0) {
            updated.last_active = now;
          }
          statements.push(
            this.env.DB
              .prepare("UPDATE project_members SET contributions = ? WHERE project_id = ? AND user_id = ?")
              .bind(JSON.stringify(updated), this.projectId, userId),
          );
        }

        // Emit coarse activity rows for editor edits. The build/dedup/prune
        // logic is extracted into buildActivityStatements so the SAME code runs
        // from two callers: here (the snapshot, a backstop) and eagerly from
        // flushActivityRows on the warm webSocketMessage path. The warm path is
        // the PRIMARY emitter — the snapshot usually runs cold after hibernation
        // eviction with an empty userFieldSets, so deferring emission to it lost
        // nearly every editor edit. In-memory activityEmitted dedups across both
        // callers within a DO instance, so there is no double-emit. These rows
        // ride the same atomic batch as the contribution UPDATEs.
        const built = this.buildActivityStatements(now);
        statements.push(...built.inserts);
        newlyEmittedKeys.push(...built.newlyEmittedKeys);
      }
      // userFieldSets Sets are NOT cleared — they keep accumulating.
      // NOTE: newSessions.clear() and activityEmitted updates are deferred;
      // they happen after the batch succeeds (below).
    }
    return newlyEmittedKeys;
  }

  /**
   * Build the activity_log INSERT statements (+ retention prune) for the
   * field-paths accumulated in userFieldSets, deduped against activityEmitted
   * and a per-call seenKeys set. Pure w.r.t. D1: it returns prepared statements
   * and the keys to commit to activityEmitted AFTER the caller's batch succeeds
   * (never mutates activityEmitted membership itself — it only creates the
   * per-user Set so it exists at commit time). Shared by snapshotContributions
   * (backstop) and flushActivityRows (the warm primary emitter).
   *
   * buildActivityRows derives one coarse row per (user, entity) touched. We
   * resolve each row's field-path id to the entity's human slug + title
   * (entity_id / entity_label) and dedup on the RESOLVED slug, so a same-session
   * add (temp-uuid id) and a later edit (numeric id) of one entity collapse to a
   * single feed row. Actor is the server-resolved userId, never client-supplied.
   */
  private buildActivityStatements(
    now: string,
  ): { inserts: D1PreparedStatement[]; newlyEmittedKeys: Array<{ actorUserId: number; entityKey: string }> } {
    const inserts: D1PreparedStatement[] = [];
    const newlyEmittedKeys: Array<{ actorUserId: number; entityKey: string }> = [];
    if (!this.projectId) return { inserts, newlyEmittedKeys };

    const userIds = [...this.userFieldSets.keys()];
    const activityRows = buildActivityRows(userIds, this.userFieldSets, this.projectId);
    const seenKeys = new Set<string>();
    for (const row of activityRows) {
      let emitted = this.activityEmitted.get(row.actorUserId);
      if (!emitted) {
        emitted = new Set<string>();
        this.activityEmitted.set(row.actorUserId, emitted);
      }
      const resolved = resolveActivityEntity(this.ydoc, row.entityType, row.entityId);
      const entityKey = `${row.entityType}:${resolved.entityId ?? row.entityId}`;
      if (emitted.has(entityKey) || seenKeys.has(entityKey)) continue; // already recorded
      seenKeys.add(entityKey);
      newlyEmittedKeys.push({ actorUserId: row.actorUserId, entityKey });
      inserts.push(
        this.env.DB
          .prepare(
            "INSERT INTO activity_log (project_id, actor_user_id, verb, entity_type, entity_id, entity_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            this.projectId,
            row.actorUserId,
            row.verb,
            row.entityType,
            resolved.entityId ?? row.entityId,
            resolved.entityLabel,
            now,
          ),
      );
    }

    // Opportunistic prune: editor edits are the high-volume activity producer
    // and write the raw INSERTs above (NOT recordActivity), so the per-project
    // retention cap must be enforced here too. Shares ACTIVITY_RETENTION_CAP as
    // the single source of truth. Rides AFTER the inserts in the same batch (D1
    // batch is sequential+transactional, so the subquery sees the new rows).
    // Only when rows were inserted, to avoid a needless DELETE.
    if (inserts.length > 0) {
      inserts.push(
        this.env.DB
          .prepare(
            `DELETE FROM activity_log
                 WHERE project_id = ?
                   AND id NOT IN (
                     SELECT id FROM activity_log
                     WHERE project_id = ?
                     ORDER BY created_at DESC, id DESC
                     LIMIT ?
                   )`,
          )
          .bind(this.projectId, this.projectId, ACTIVITY_RETENTION_CAP),
      );
    }

    return { inserts, newlyEmittedKeys };
  }

  /**
   * Emit pending editor-edit activity rows NOW, while the DO instance is warm.
   *
   * Called from webSocketMessage the moment an edit applies — the only point at
   * which getUserContext(ws) can attribute the edit and the Y.Doc is guaranteed
   * loaded. This is the PRIMARY activity emitter: deferring emission to the +30s
   * alarm snapshot lost nearly every edit because the DO hibernates between
   * events and the snapshot runs cold with an empty userFieldSets. Writes its
   * own small batch (the activity feed is append-only — it does not need to be
   * atomic with the yjs_state blob). Best-effort: a D1 failure is logged and the
   * keys are NOT committed, so the snapshot backstop can retry them. Never
   * throws — it must not break the realtime message path.
   */
  private async flushActivityRows(): Promise<void> {
    if (!this.projectId || !this.docLoaded) return;
    const now = new Date().toISOString();
    const { inserts, newlyEmittedKeys } = this.buildActivityStatements(now);
    if (inserts.length === 0) return;
    // Commit the dedup keys SYNCHRONOUSLY — before the await below — so that
    // concurrent webSocketMessage handlers (which interleave only at awaits)
    // can't each slip past the dedup check and re-emit the same entity once per
    // keystroke. Deferring the commit to after the await (as the snapshot path
    // safely does, because it runs single-shot) produced a per-keystroke flood
    // under real concurrent typing. On a write failure we roll the keys back so
    // a later edit can re-emit; losing one coarse row on a rare D1 error is
    // acceptable for an append-only feed.
    for (const { actorUserId, entityKey } of newlyEmittedKeys) {
      this.activityEmitted.get(actorUserId)?.add(entityKey);
    }
    try {
      await this.env.DB.batch(inserts);
    } catch (err) {
      for (const { actorUserId, entityKey } of newlyEmittedKeys) {
        this.activityEmitted.get(actorUserId)?.delete(entityKey);
      }
      console.error("[activity] eager flush failed; will retry on next edit", err);
    }
  }

  private async doSnapshot(): Promise<void> {
    if (!this.projectId || !this.docLoaded) return;

    // --- Corruption guard: deduplicate Y.Arrays before snapshot ---
    // If a bug (e.g. broken reorder) introduced duplicate entries, remove them
    // here to prevent the corruption from persisting to D1. Duplicates are
    // detected by _id (D1 primary key) for existing items, and by entity key
    // (story_id, object_id) for all items. The first occurrence wins.
    // Track whether the Y.Doc was mutated in a way connected clients must adopt —
    // either an INSERT backfilled a canonical _id, or the glossary dedup re-keyed
    // a duplicate term_id. Either way we broadcast the updated state at the end;
    // without it a peer's stale value resurrects the problem via Yjs LWW.
    let didBackfill = false;

    this.deduplicateYArray("stories", "story_id");
    this.deduplicateYArray("objects", "object_id");
    // Glossary re-keys (not deletes) same-term_id duplicates; a re-key mutates
    // the doc and MUST be broadcast so peers adopt the new term_id.
    if (this.deduplicateYArray("glossary", "term_id", "re-key")) didBackfill = true;
    this.deduplicateYArray("pages", "slug");
    this.deduplicateNestedStepArrays();
    const now = new Date().toISOString();

    const statements: D1PreparedStatement[] = [];

    // NOTE: projects.yjs_state blob write is appended at the end of this method
    // so the encoded state includes any INSERT ID backfills applied by sections
    // 5-8. Otherwise a cold-start restore from the blob would see _id: null
    // items that have already been INSERTed to D1 and would re-INSERT them.

    await this.snapshotConfig(statements, now);

    if (await this.snapshotStories(statements, now)) didBackfill = true;

    if (await this.snapshotObjects(statements, now)) didBackfill = true;

    if (await this.snapshotGlossary(statements, now)) didBackfill = true;

    if (await this.snapshotPages(statements, now)) didBackfill = true;

    const newlyEmittedKeys = await this.snapshotContributions(statements, now);

    // Encode the full Y.Doc state as a binary blob AFTER all backfills so the
    // restored state on cold start matches the D1 rows inserted above.
    //
    // Write the blob standalone FIRST so it always reflects the entity INSERTs
    // already committed above (and their backfilled _ids). If the UPDATE/DELETE
    // batch later fails, the blob + INSERTs stay consistent and a cold-start
    // restore won't orphan-delete the new entities.
    const blob = Y.encodeStateAsUpdate(this.ydoc);
    await this.env.DB
      .prepare("UPDATE projects SET yjs_state = ?, updated_at = ? WHERE id = ?")
      .bind(blob, now, this.projectId)
      .run();
    if (statements.length > 0) {
      try {
        await this.env.DB.batch(statements);
      } catch (err) {
        // INSERTs and the blob are durable and consistent; the failed
        // UPDATE/DELETE batch will be retried on the next snapshot.
        this.scheduleSnapshot();
        throw err;
      }
    }

    // Commit deferred in-memory mutations — only reached when the batch
    // succeeded (the catch above rethrows, so any code here is success-only).
    // Mutating these before the batch would permanently mark entities as
    // emitted and clear session counts even when the DB writes failed (E2 fix).
    for (const { actorUserId, entityKey } of newlyEmittedKeys) {
      this.activityEmitted.get(actorUserId)?.add(entityKey);
    }
    this.newSessions.clear();

    // Broadcast ID-backfill updates to all connected clients.
    // The DO's in-memory Y.Doc received ydoc.transact() mutations during INSERT
    // to write the canonical D1 IDs back to each Y.Map, but the sync relay only
    // forwards client-originated messages. Without an explicit broadcast here,
    // peers would keep their local _id: null sentinels until their next full
    // sync (page refresh). Re-encoding the full state is safe — Yjs peers
    // idempotently merge updates they already have.
    if (didBackfill) {
      const updateEncoder = encoding.createEncoder();
      encoding.writeVarUint(updateEncoder, messageSync);
      syncProtocol.writeSyncStep2(updateEncoder, this.ydoc);
      const updateMsg = encoding.toUint8Array(updateEncoder);
      for (const client of this.ctx.getWebSockets()) {
        try {
          client.send(updateMsg);
        } catch {
          // Client may have disconnected; ignore
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Session token validation
  // -------------------------------------------------------------------------

  /**
   * Validate the session token from the WebSocket query string.
   *
   * Thin wrapper around the shared `getUserIdFromToken` helper in
   * `workers/auth.ts`; kept as a method so existing call sites remain
   * unchanged. The shared helper accepts the SESSION_SECRET as an argument
   * so the module is decoupled from `this.env`.
   */
  private async getUserIdFromToken(token: string): Promise<number | null> {
    return getUserIdFromTokenShared(token, this.env.SESSION_SECRET);
  }
}
