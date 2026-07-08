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
 * @version v1.4.2-beta
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
// Ingest wire shapes (shared by /restore-orphans and /ingest-sync)
// ---------------------------------------------------------------------------
//
// The route action owns all CSV/YAML parsing and sends fully resolved, typed
// values; the DO stays parser-free. Step and layer shapes are shared verbatim
// between the two endpoints.

interface IngestStep {
  step_number?: number;
  kind?: string;
  object_id?: string;
  x?: number | null;
  y?: number | null;
  zoom?: number | null;
  page?: string;
  question?: string;
  answer?: string;
  alt_text?: string;
  clip_start?: string;
  clip_end?: string;
  loop?: string;
}

interface IngestLayer {
  step_index: number;
  layer_number: number;
  title?: string;
  button_label?: string;
  content?: string;
}

/** Object insert row — mirrors the objects Y.Map shape buildFromD1Rows builds. */
interface IngestObjectInsert {
  object_id: string;
  title?: string | null;
  featured?: boolean;
  creator?: string | null;
  description?: string | null;
  source_url?: string | null;
  period?: string | null;
  year?: string | null;
  object_type?: string | null;
  subjects?: string | null;
  source?: string | null;
  credit?: string | null;
  thumbnail?: string | null;
  alt_text?: string | null;
  dimensions?: string | null;
  extra_columns?: string | null;
  image_available?: boolean;
}

/** Object update field keys the DO recognises (subset of objects.csv columns). */
type IngestObjectField =
  | "title" | "creator" | "description" | "period" | "year" | "object_type"
  | "dimensions" | "subjects" | "source" | "credit" | "featured" | "alt_text"
  | "source_url" | "thumbnail" | "extra_columns";

interface SyncIngestPayload {
  /** Managed config fields, keyed by D1 column name (identical to the Y keys). */
  config: Array<{ key: string; value: string | boolean | number }>;
  /** Present only on an "ahead" version heal — keeps the Y config aligned with
   *  the D1 heal (snapshotConfig deliberately omits telar_version). */
  telarVersion?: string;
  stories: {
    update: Array<{
      storyId: string; title: string; subtitle: string; byline: string;
      isPrivate: boolean; showSections: boolean;
    }>;
    insert: Array<{
      storyId: string; title: string; subtitle: string; byline: string;
      isPrivate: boolean; showSections: boolean;
      steps: IngestStep[]; layers: IngestLayer[];
    }>;
  };
  objects: {
    update: Array<{ objectId: string; fields: Partial<Record<IngestObjectField, string | boolean | null>> }>;
    insert: IngestObjectInsert[];
    remove: string[];
  };
  glossary: {
    update: Array<{ termId: string; title: string; definition: string }>;
    insert: Array<{ termId: string; title: string; definition: string }>;
  };
}

// Config keys carried as Y.Text (character-level merge); the rest are plain
// scalars/booleans/number. Object fields split the same way. Both mirror
// buildFromD1Rows so an ingested value round-trips through the snapshot.
const CONFIG_YTEXT_KEYS: ReadonlySet<string> = new Set(["title", "description", "author", "email"]);
// Plain config keys the ingest may set. Together with CONFIG_YTEXT_KEYS this
// is the full set of managed config fields; an unlisted key is REFUSED rather
// than set — a stray key like "navigation" or "landing" would replace a
// Y.Array/Y.Map with a scalar and break every future snapshotConfig read.
const CONFIG_PLAIN_KEYS: ReadonlySet<string> = new Set([
  "lang", "baseurl", "url", "theme", "logo", "story_key",
  "collection_mode", "include_demo_content", "show_on_homepage",
  "show_story_steps", "show_object_credits", "browse_and_search",
  "show_link_on_homepage", "show_sample_on_homepage", "featured_count",
]);
const OBJECT_YTEXT_FIELDS: ReadonlySet<string> = new Set([
  "title", "creator", "description", "alt_text", "period", "year",
  "object_type", "subjects", "source", "credit",
]);
const OBJECT_BOOL_FIELDS: ReadonlySet<string> = new Set(["featured"]);
// Plain-string object fields the ingest may set; anything not in one of the
// three object sets is ignored (e.g. "_id", "object_id", or an unknown key).
const OBJECT_PLAIN_FIELDS: ReadonlySet<string> = new Set([
  "source_url", "thumbnail", "dimensions", "extra_columns",
]);

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
          // A thrown D1-batch failure here would otherwise reject the DO
          // fetch, and the publish action's outer catch swallows it and
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
    //            question, answer, alt_text, clip_start, clip_end, loop }
    //   layer: { step_index, layer_number, title, button_label, content }
    // Title defaults to storyId; subtitle/byline default to empty
    // (per-story CSVs do not carry these fields). draft is always true
    // on restore. Order is computed as max(existing order) + 1 + i so
    // restored entries push onto the end of the array deterministically.
    if (url.pathname.endsWith("/restore-orphans") && request.method === "POST") {
      const markerError = await verifyInternalMarker(request, this.env.SESSION_SECRET, "restore-orphans");
      if (markerError) return markerError;
      const bindError = this.bindProjectIdFromMarker(request);
      if (bindError) return bindError;

      let payload: {
        stories: Array<{
          storyId: string;
          steps: IngestStep[];
          layers: IngestLayer[];
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

      // Drain any in-flight alarm snapshot BEFORE entering the gate. This must
      // sit OUTSIDE blockConcurrencyWhile: the gate blocks delivery of every
      // event not initiated inside its callback — including the in-flight
      // snapshot's own D1 responses — so a drain inside the gate would spin
      // until the runtime resets the DO. Out here the snapshot's awaits still
      // complete. No new snapshot can start between the loop observing false
      // and the gate closing: snapshot starters (alarm, last-disconnect,
      // forced) set isSnapshotting synchronously on delivery, and the
      // check-to-gate transition below has no await for them to interleave in.
      while (this.isSnapshotting) await new Promise((r) => setTimeout(r, 25));

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
            // Restore defaults: title = storyId (the per-story CSV has no title
            // column; user can rename in /stories), subtitle/byline empty (not
            // in the per-story CSV), draft = true (a restored orphan is a draft).
            this.buildStoryYMap(storiesArray, {
              storyId: story.storyId,
              title: story.storyId,
              subtitle: "",
              byline: "",
              order: nextOrder++,
              isPrivate: false,
              draft: true,
              showSections: false,
              steps: story.steps ?? [],
              layers: story.layers ?? [],
            });
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

    // POST /ingest-sync — apply an accepted full-sync diff THROUGH the Y.Doc.
    // The action resolves every repo value (CSV/YAML parse, type coercion) and
    // sends fully typed values; the DO mutates the doc, snapshots to D1 in the
    // same call, and broadcasts the new state to connected editors. Routing the
    // writes through the doc means the snapshot pipeline itself persists them,
    // so the next reconciliation cannot revert them. Marker-gated identically
    // to /snapshot, /reset, and /restore-orphans.
    //
    // All mutations run in ONE ydoc.transact inside blockConcurrencyWhile, with
    // an in-flight-snapshot drain first (same reason as /restore-orphans). Y
    // types match buildFromD1Rows exactly: Y.Text fields are replaced in place
    // (delete + insert) so bound editors update live; scalars/booleans/number
    // are plain sets. Updates skip a missing entity, inserts skip a present one
    // (idempotent retry), and both counts land in the JSON response.
    if (url.pathname.endsWith("/ingest-sync") && request.method === "POST") {
      const markerError = await verifyInternalMarker(request, this.env.SESSION_SECRET, "ingest-sync");
      if (markerError) return markerError;
      const bindError = this.bindProjectIdFromMarker(request);
      if (bindError) return bindError;

      let payload: SyncIngestPayload;
      try {
        payload = await request.json();
      } catch {
        return new Response("Invalid JSON body", { status: 400 });
      }
      if (!payload || typeof payload !== "object") {
        return new Response("Missing payload", { status: 400 });
      }
      const configEntries = Array.isArray(payload.config) ? payload.config : [];
      const storyUpdates = payload.stories?.update ?? [];
      const storyInserts = payload.stories?.insert ?? [];
      const objectUpdates = payload.objects?.update ?? [];
      const objectInserts = payload.objects?.insert ?? [];
      const objectRemoves = payload.objects?.remove ?? [];
      const glossaryUpdates = payload.glossary?.update ?? [];
      const glossaryInserts = payload.glossary?.insert ?? [];

      const applied = {
        config: 0, storyUpdate: 0, storyInsert: 0, objectUpdate: 0,
        objectInsert: 0, objectRemove: 0, glossaryUpdate: 0, glossaryInsert: 0,
      };
      const skipped = {
        config: [] as string[],
        storyUpdate: [] as string[], objectUpdate: [] as string[],
        objectInsert: [] as string[], objectRemove: [] as string[],
        glossaryUpdate: [] as string[], glossaryInsert: [] as string[],
      };

      // Drain any in-flight alarm snapshot BEFORE entering the gate — see the
      // same wait (and the gate-semantics constraint it documents) in
      // /restore-orphans. Draining out here lets the in-flight snapshot's D1
      // responses deliver; inside the gate they would be blocked and the loop
      // could never observe the flag clearing.
      while (this.isSnapshotting) await new Promise((r) => setTimeout(r, 25));

      await this.ctx.blockConcurrencyWhile(async () => {
        await this.ensureDocLoaded();

        const configMap = this.ydoc.getMap<unknown>("config");
        const storiesArray = this.ydoc.getArray<Y.Map<unknown>>("stories");
        const objectsArray = this.ydoc.getArray<Y.Map<unknown>>("objects");
        const glossaryArray = this.ydoc.getArray<Y.Map<unknown>>("glossary");

        // New stories append at the end so their Y.Array index (which the
        // snapshot writes as D1 "order") sorts them last.
        let maxOrder = -1;
        for (let i = 0; i < storiesArray.length; i++) {
          const order = storiesArray.get(i).get("order");
          if (typeof order === "number" && order > maxOrder) maxOrder = order;
        }
        let nextOrder = maxOrder + 1;

        this.ydoc.transact(() => {
          // --- config fields (allowlisted — unknown keys are refused) ---
          for (const { key, value } of configEntries) {
            if (CONFIG_YTEXT_KEYS.has(key)) {
              this.replaceYText(configMap, key, String(value ?? ""));
            } else if (CONFIG_PLAIN_KEYS.has(key)) {
              configMap.set(key, value);
            } else {
              skipped.config.push(key);
              continue;
            }
            applied.config += 1;
          }
          // telar_version rides here so the doc agrees with the D1 heal the
          // action performs directly (snapshotConfig omits the column).
          if (typeof payload.telarVersion === "string") {
            configMap.set("telar_version", payload.telarVersion);
          }

          // --- story updates ---
          for (const upd of storyUpdates) {
            const m = this.findByKey(storiesArray, "story_id", upd.storyId);
            if (!m) { skipped.storyUpdate.push(upd.storyId); continue; }
            this.replaceYText(m, "title", upd.title);
            this.replaceYText(m, "subtitle", upd.subtitle);
            this.replaceYText(m, "byline", upd.byline);
            m.set("private", upd.isPrivate);
            m.set("show_sections", upd.showSections);
            // order is deliberately untouched — sync excludes it and D1 order
            // comes from the Y.Array index at snapshot time.
            applied.storyUpdate += 1;
          }

          // --- story inserts (dedup-before-insert, draft=false) ---
          for (const ins of storyInserts) {
            this.buildStoryYMap(storiesArray, {
              storyId: ins.storyId,
              title: ins.title,
              subtitle: ins.subtitle,
              byline: ins.byline,
              order: nextOrder++,
              isPrivate: ins.isPrivate,
              // Presence in project.csv is the not-a-draft encoding.
              draft: false,
              showSections: ins.showSections,
              steps: ins.steps ?? [],
              layers: ins.layers ?? [],
              carryExistingId: true,
            });
            applied.storyInsert += 1;
          }

          // --- object updates ---
          for (const upd of objectUpdates) {
            const m = this.findByKey(objectsArray, "object_id", upd.objectId);
            if (!m) { skipped.objectUpdate.push(upd.objectId); continue; }
            for (const [field, value] of Object.entries(upd.fields ?? {})) {
              if (OBJECT_YTEXT_FIELDS.has(field)) {
                this.replaceYText(m, field, String(value ?? ""));
              } else if (OBJECT_BOOL_FIELDS.has(field)) {
                m.set(field, Boolean(value));
              } else if (OBJECT_PLAIN_FIELDS.has(field)) {
                m.set(field, String(value ?? ""));
              }
              // Unlisted field keys are ignored — never set from the wire.
            }
            applied.objectUpdate += 1;
          }

          // --- object inserts (skip-if-present) ---
          for (const ins of objectInserts) {
            if (this.findByKey(objectsArray, "object_id", ins.object_id)) {
              skipped.objectInsert.push(ins.object_id);
              continue;
            }
            objectsArray.push([this.buildObjectYMap(ins)]);
            applied.objectInsert += 1;
          }

          // --- object removes ---
          for (const objectId of objectRemoves) {
            const idx = this.indexByKey(objectsArray, "object_id", objectId);
            if (idx < 0) { skipped.objectRemove.push(objectId); continue; }
            objectsArray.delete(idx, 1);
            applied.objectRemove += 1;
          }

          // --- glossary updates ---
          for (const upd of glossaryUpdates) {
            const m = this.findByKey(glossaryArray, "term_id", upd.termId);
            if (!m) { skipped.glossaryUpdate.push(upd.termId); continue; }
            this.replaceYText(m, "title", upd.title);
            this.replaceYText(m, "definition", upd.definition);
            applied.glossaryUpdate += 1;
          }

          // --- glossary inserts (skip-if-present) ---
          for (const ins of glossaryInserts) {
            if (this.findByKey(glossaryArray, "term_id", ins.termId)) {
              skipped.glossaryInsert.push(ins.termId);
              continue;
            }
            const termMap = new Y.Map<unknown>();
            termMap.set("_id", null);
            // insertGlossaryRow keeps an existing term_id verbatim, so the
            // repo id survives the snapshot INSERT.
            termMap.set("term_id", ins.termId);
            termMap.set("title", new Y.Text(ins.title ?? ""));
            termMap.set("definition", new Y.Text(ins.definition ?? ""));
            termMap.set("created_by", null);
            glossaryArray.push([termMap]);
            applied.glossaryInsert += 1;
          }
        });

        // Persist through the snapshot pipeline — still inside the block so no
        // alarm can race between the mutation and the write.
        await this.snapshotToD1();
      });

      // Broadcast the full state to connected editors (verbatim /restore-orphans
      // tail) so they see the accepted changes live.
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

      return Response.json({ applied, skipped });
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
  // Ingest helpers (shared by /restore-orphans and /ingest-sync)
  // -------------------------------------------------------------------------

  /**
   * Bind this.projectId from the HMAC-verified X-Internal-Project header when
   * the DO woke with no live sockets (the constructor only restores projectId
   * from socket attachments). Without this, ensureDocLoaded and snapshotToD1
   * both early-return on the null projectId and an ingest would mutate an
   * UNLOADED doc, report success, and persist nothing — while polluting the
   * in-memory doc with entries the next blob load would merge on top of.
   * Must be called AFTER verifyInternalMarker (the header is signed).
   * Returns an error Response on a malformed or mismatched header, else null.
   */
  private bindProjectIdFromMarker(request: Request): Response | null {
    const markerProjectId = Number(request.headers.get("X-Internal-Project"));
    if (!Number.isInteger(markerProjectId) || markerProjectId <= 0) {
      return new Response("Invalid project marker", { status: 400 });
    }
    if (this.projectId === null) {
      this.projectId = markerProjectId;
    } else if (this.projectId !== markerProjectId) {
      // idFromName(projectId) makes this unreachable in practice; refuse
      // rather than write one project's data under another's id.
      return new Response("Project marker mismatch", { status: 409 });
    }
    return null;
  }

  /**
   * Replace a Y.Text value in place (delete + insert) so bound editors merge
   * the new value live and instance identity is preserved. Defensive: when the
   * key is absent or not a Y.Text (an older blob predating the field), set a
   * fresh Y.Text — matching the buildFromD1Rows type for these keys.
   */
  private replaceYText(map: Y.Map<unknown>, key: string, value: string): void {
    const cur = map.get(key);
    if (cur instanceof Y.Text) {
      cur.delete(0, cur.length);
      if (value.length > 0) cur.insert(0, value);
    } else {
      map.set(key, new Y.Text(value));
    }
  }

  /** Index of the first Y.Map in `array` whose `key` equals `value`; -1 if none. */
  private indexByKey(array: Y.Array<Y.Map<unknown>>, key: string, value: string): number {
    for (let i = 0; i < array.length; i++) {
      if (array.get(i).get(key) === value) return i;
    }
    return -1;
  }

  /** The first Y.Map in `array` whose `key` equals `value`, or null. */
  private findByKey(
    array: Y.Array<Y.Map<unknown>>,
    key: string,
    value: string,
  ): Y.Map<unknown> | null {
    const idx = this.indexByKey(array, key, value);
    return idx < 0 ? null : array.get(idx);
  }

  /**
   * Build one object Y.Map (_id = null) mirroring the buildFromD1Rows object
   * shape — Y.Text for the editable text fields, plain strings for the import
   * passthroughs, booleans for featured/image_available. origin is D1-only
   * (never on the Y.Map): the snapshot INSERT defaults it and the action then
   * patches origin = "repo" directly to D1.
   */
  private buildObjectYMap(p: IngestObjectInsert): Y.Map<unknown> {
    const m = new Y.Map<unknown>();
    m.set("_id", null);
    m.set("object_id", p.object_id);
    m.set("title", new Y.Text(p.title ?? ""));
    m.set("creator", new Y.Text(p.creator ?? ""));
    m.set("description", new Y.Text(p.description ?? ""));
    m.set("alt_text", new Y.Text(p.alt_text ?? ""));
    m.set("source_url", p.source_url ?? "");
    m.set("period", new Y.Text(p.period ?? ""));
    m.set("year", new Y.Text(p.year ?? ""));
    m.set("object_type", new Y.Text(p.object_type ?? ""));
    m.set("subjects", new Y.Text(p.subjects ?? ""));
    m.set("source", new Y.Text(p.source ?? ""));
    m.set("credit", new Y.Text(p.credit ?? ""));
    m.set("thumbnail", p.thumbnail ?? "");
    m.set("dimensions", p.dimensions ?? "");
    m.set("extra_columns", p.extra_columns ?? "");
    m.set("featured", Boolean(p.featured));
    m.set("image_available", Boolean(p.image_available));
    m.set("created_by", null);
    return m;
  }

  /**
   * Construct one story Y.Map (with nested steps and layers) and push it onto
   * the stories Y.Array, first removing any pre-existing entry with the same
   * story_id. Shared by /restore-orphans and /ingest-sync — they differ only in
   * the scalar defaults passed via `spec`. Must be called inside a
   * ydoc.transact; mutates the array in place.
   *
   * The same-story_id dedup runs first so a stale entry with an invalid _id
   * (pointing at a deleted D1 row) cannot win the snapshot's deduplicate pass
   * and strand the fresh _id = null Y.Map. Y.Text is used for the text fields to
   * match buildFromD1Rows, so bound editors merge live.
   */
  private buildStoryYMap(
    storiesArray: Y.Array<Y.Map<unknown>>,
    spec: {
      storyId: string;
      title: string;
      subtitle: string;
      byline: string;
      order: number;
      isPrivate: boolean;
      draft: boolean;
      showSections: boolean;
      steps: IngestStep[];
      layers: IngestLayer[];
      /**
       * Carry a replaced same-story_id entry's numeric _id onto the fresh map
       * (sync ingest). With _id = null the snapshot would INSERT while the old
       * row still exists — stories(project_id, story_id) is UNIQUE, so the
       * INSERT is rejected-and-swallowed and the batched orphan-DELETE then
       * removes the old row: the story vanishes from D1 until a later snapshot
       * re-inserts it. Carrying the id routes the snapshot onto its UPDATE
       * branch instead (row preserved, steps/layers replaced). Restore-orphans
       * must NOT carry: there the old _id points at a known-deleted D1 row.
       */
      carryExistingId?: boolean;
    },
  ): void {
    // Walk in reverse so deletions don't shift indices we still need.
    let carriedId: number | null = null;
    for (let i = storiesArray.length - 1; i >= 0; i--) {
      const existing = storiesArray.get(i);
      if (existing.get("story_id") === spec.storyId) {
        if (spec.carryExistingId) {
          const existingId = existing.get("_id");
          if (typeof existingId === "number") carriedId = existingId;
        }
        storiesArray.delete(i, 1);
      }
    }

    const storyMap = new Y.Map<unknown>();
    storyMap.set("_id", carriedId);
    storyMap.set("story_id", spec.storyId);
    storyMap.set("title", new Y.Text(spec.title));
    storyMap.set("subtitle", new Y.Text(spec.subtitle));
    storyMap.set("byline", new Y.Text(spec.byline));
    storyMap.set("order", spec.order);
    storyMap.set("private", spec.isPrivate);
    storyMap.set("draft", spec.draft);
    storyMap.set("show_sections", spec.showSections);

    // Pre-allocate one layer Y.Array per step (indexed by the step's position)
    // so layers thread onto their parent without a second pass.
    const stepsArray = new Y.Array<Y.Map<unknown>>();
    const stepLayerArrays: Array<Y.Array<Y.Map<unknown>>> = [];
    for (const step of spec.steps) {
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
      stepMap.set("alt_text", new Y.Text(step.alt_text ?? ""));
      stepMap.set("clip_start", step.clip_start ?? "");
      stepMap.set("clip_end", step.clip_end ?? "");
      stepMap.set("loop", step.loop ?? "");
      const layersArr = new Y.Array<Y.Map<unknown>>();
      stepLayerArrays.push(layersArr);
      stepMap.set("layers", layersArr);
      stepsArray.push([stepMap]);
    }

    for (const layer of spec.layers) {
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
   * Crash-proof INSERT for one entity row, shared by all six snapshot pipelines
   * (stories, steps, layers, objects, glossary terms, pages). This is the ONE
   * place the insert-retry policy lives — read it here once, not six times:
   *
   *   - No explicit id (a brand-new Y.Map): one autoincrement INSERT, then
   *     `backfill` the returned id onto the Y.Map. On failure: warn, reschedule
   *     a retry, return id 0 — never throw, because a snapshot must not abort
   *     mid-flush.
   *   - Explicit id (re-creating a row stranded by an out-from-under DELETE):
   *     INSERT with that same id so the Y.Doc `_id` and any FK children stay
   *     valid; do NOT backfill (the id is already correct). On a constraint
   *     failure retry ONCE as a fresh autoincrement row + backfill the new id;
   *     if that also fails (e.g. a UNIQUE human-key collision) warn, reschedule,
   *     return id 0 so the caller skips this row's children this pass.
   *
   * Does insert retry on collision? Yes — exactly once, and only in the
   * explicit-id path, degrading to a logged no-op. The plain new-insert path
   * does not retry. The id-bearing and autoincrement SQL variants are generated
   * from the one `columns` list so they can never drift apart. The per-entity
   * table, columns, bound values, the `_id` backfill (plus any second-key
   * backfill — see glossary's term_id), and the two warn strings come from the
   * six thin wrappers below.
   */
  private async insertRow(
    table: string,
    columns: string[],
    binds: unknown[],
    explicitId: number | undefined,
    backfill: (id: number) => void,
    warnBlocked: string,
    warnNew: string,
  ): Promise<{ id: number; backfilled: boolean }> {
    const run = async (withId: boolean): Promise<number> => {
      const cols = withId ? ["id", ...columns] : columns;
      const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
      const res = await this.env.DB
        .prepare(sql)
        .bind(...(withId ? [explicitId, ...binds] : binds))
        .run();
      return withId ? (explicitId as number) : (res.meta.last_row_id as number);
    };

    if (explicitId !== undefined) {
      try {
        return { id: await run(true), backfilled: false }; // re-created same id; _id already correct
      } catch {
        try {
          const id = await run(false);
          backfill(id);
          return { id, backfilled: true };
        } catch {
          console.warn(warnBlocked);
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
      console.warn(warnNew);
      this.scheduleSnapshot();
      return { id: 0, backfilled: false };
    }
  }

  /**
   * INSERT one story row. Thin wrapper over `insertRow` (retry policy lives
   * there). `order` is threaded from the enclosing Y.Array index.
   */
  private async insertStoryRow(
    storyMap: Y.Map<unknown>,
    order: number,
    now: string,
    explicitId?: number,
  ): Promise<{ id: number; backfilled: boolean }> {
    const slug = String(storyMap.get("story_id") ?? "");
    const columns = [
      "project_id", "story_id", "title", "subtitle", "byline", '"order"',
      "private", "draft", "show_sections", "created_by", "updated_at",
    ];
    const binds = [
      this.projectId,
      slug,
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
    return this.insertRow(
      "stories",
      columns,
      binds,
      explicitId,
      (id) => { this.ydoc.transact(() => { storyMap.set("_id", id); }); },
      `[snapshot] story "${slug}" insert blocked (likely slug collision) — manual remediation needed`,
      `[snapshot] new story "${slug}" insert failed`,
    );
  }

  /**
   * INSERT one step row. Thin wrapper over `insertRow`. `storyId` is the injected
   * FK parent; `stepNumber` the enclosing Y.Array index (1-based).
   */
  private async insertStepRow(
    stepMap: Y.Map<unknown>,
    storyId: number,
    stepNumber: number,
    now: string,
    explicitId?: number,
  ): Promise<{ id: number; backfilled: boolean }> {
    const columns = [
      "story_id", "step_number", "kind", "object_id", "x", "y", "zoom", "page",
      "question", "answer", "alt_text", "clip_start", "clip_end", "loop",
      "created_by", "updated_at",
    ];
    const binds = [
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
    return this.insertRow(
      "steps",
      columns,
      binds,
      explicitId,
      (id) => { this.ydoc.transact(() => { stepMap.set("_id", id); }); },
      "[snapshot] step insert blocked — manual remediation needed",
      "[snapshot] new step insert failed",
    );
  }

  /**
   * INSERT one layer row. Thin wrapper over `insertRow`. `stepId` is the injected
   * FK parent; `layerNumber` the enclosing Y.Array index (1-based).
   */
  private async insertLayerRow(
    layerMap: Y.Map<unknown>,
    stepId: number,
    layerNumber: number,
    now: string,
    explicitId?: number,
  ): Promise<{ id: number; backfilled: boolean }> {
    const columns = [
      "step_id", "layer_number", "title", "button_label", "content",
      "created_by", "updated_at",
    ];
    const binds = [
      stepId,
      layerNumber,
      yTextToString(layerMap.get("title")),
      yTextToString(layerMap.get("button_label")),
      yTextToString(layerMap.get("content")),
      (layerMap.get("created_by") as number | null) ?? null,
      now,
    ];
    return this.insertRow(
      "layers",
      columns,
      binds,
      explicitId,
      (id) => { this.ydoc.transact(() => { layerMap.set("_id", id); }); },
      "[snapshot] layer insert blocked — manual remediation needed",
      "[snapshot] new layer insert failed",
    );
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
   * INSERT one object row. Thin wrapper over `insertRow`. Carries every content
   * column the Y.Map holds — including object_type/subjects/source/credit
   * (editable) and thumbnail/dimensions/extra_columns (import passthrough), all
   * loaded by buildFromD1Rows — so a re-INSERT preserves them instead of
   * resetting them. origin defaults to "iiif" and missing_from_repo=0 on a fresh
   * insert (both D1-only, not round-tripped through the Y.Map).
   */
  private async insertObjectRow(
    objMap: Y.Map<unknown>,
    now: string,
    explicitId?: number,
    preserved?: Record<string, unknown>,
  ): Promise<{ id: number; backfilled: boolean }> {
    const slug = String(objMap.get("object_id") ?? "");
    const columns = [
      "project_id", "object_id", "title", "creator", "description", "alt_text",
      "source_url", "period", "year", "object_type", "subjects", "source",
      "credit", "thumbnail", "dimensions", "extra_columns", "featured",
      "image_available", "origin", "missing_from_repo", "created_by", "updated_at",
    ];
    const binds = [
      this.projectId,
      slug,
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
      // origin is D1-only (the cold build never loads it onto the Y.Map). On a
      // stale-id re-INSERT, `preserved` carries the surviving row's origin so a
      // repo/compositor object is not silently reclassified as "iiif".
      String(preserved?.origin ?? objMap.get("origin") ?? "iiif"),
      0, // missing_from_repo = false on insert
      (objMap.get("created_by") as number | null) ?? null,
      now,
    ];
    return this.insertRow(
      "objects",
      columns,
      binds,
      explicitId,
      (id) => { this.ydoc.transact(() => { objMap.set("_id", id); }); },
      `[snapshot] object "${slug}" insert blocked — manual remediation needed`,
      `[snapshot] new object "${slug}" insert failed`,
    );
  }

  /**
   * Sections 6–8: the flat single-table pipelines — objects, glossary terms,
   * pages — share ONE INSERT / UPDATE / DELETE shape with a stale-`_id`
   * "adopt-or-re-INSERT" branch, walked here once.
   *
   * Only these three flat pipelines belong here. stories/steps/layers do NOT:
   * they own FK children and cascade-delete, and they DELIBERATELY never adopt a
   * live same-key row (adopting would silently clobber the live row's children) —
   * see snapshotStories, which keeps its own nested walker.
   *
   * Per-entity divergences are explicit parameters, not hidden in shared code:
   *   - `skip`       — objects skip a `_validation_state === "pending"` row so an
   *                    unvalidated IIIF manifest never persists; if such a row
   *                    already has a D1 id, that id is dropped from the orphan set
   *                    so the row is left alone rather than deleted. Objects only.
   *   - `pushUpdate` — the in-place UPDATE. It writes the human key (object_id /
   *                    term_id / slug) because none of these columns has a UNIQUE
   *                    index — unlike stories.story_id, which is omitted there.
   *                    `index` is the Y.Array position (pages thread it into the
   *                    `"order"` column; objects/glossary ignore it).
   *   - `insert`     — the crash-proof insert wrapper (order-aware for pages).
   * The stale-`_id` else-branch adopts a live same-key row (UPDATE it + backfill
   * `_id`) when one exists, else re-INSERTs under the stale id.
   */
  private async snapshotFlatEntity(
    statements: D1PreparedStatement[],
    cfg: {
      arrayName: string;
      table: string;
      keyField: string;
      skip?: (m: Y.Map<unknown>) => boolean;
      pushUpdate: (m: Y.Map<unknown>, index: number, targetId: number) => void;
      // D1-only columns that the Y.Map never carries (object.origin,
      // glossary.related_terms). On a stale-`_id` re-INSERT they must be read
      // back from D1 so the recreated row keeps them instead of resetting to
      // the insert default — see the re-INSERT branch below.
      preserveColumns?: string[];
      insert: (
        m: Y.Map<unknown>,
        index: number,
        explicitId?: number,
        preserved?: Record<string, unknown>,
      ) => Promise<{ id: number; backfilled: boolean }>;
    },
  ): Promise<boolean> {
    let didBackfill = false;
    const array = this.ydoc.getArray<Y.Map<unknown>>(cfg.arrayName);
    const d1Result = await this.env.DB
      .prepare(`SELECT id, ${cfg.keyField} FROM ${cfg.table} WHERE project_id = ?`)
      .bind(this.projectId)
      .all<Record<string, unknown>>();
    const d1Ids = new Set(d1Result.results.map((r) => r.id as number));
    const d1KeyToId = new Map<string, number>();
    for (const r of d1Result.results) {
      const k = r[cfg.keyField];
      if (k) d1KeyToId.set(k as string, r.id as number);
    }

    for (let i = 0; i < array.length; i++) {
      const m = array.get(i);

      if (cfg.skip?.(m)) {
        const existing = m.get("_id");
        if (typeof existing === "number") d1Ids.delete(existing);
        continue;
      }

      const id = m.get("_id") as number | null;
      if (id === null || id === undefined) {
        const r = await cfg.insert(m, i);
        if (r.backfilled) didBackfill = true;
      } else if (d1Ids.has(id)) {
        cfg.pushUpdate(m, i, id);
        d1Ids.delete(id);
      } else {
        // Stale _id: adopt a live same-key row when one exists, else re-INSERT
        // with the same id. (The flat trio's key columns have no UNIQUE index,
        // so the adopt UPDATE is collision-free.)
        const key = String(m.get(cfg.keyField) ?? "");
        const liveId = key ? d1KeyToId.get(key) : undefined;
        if (liveId !== undefined) {
          cfg.pushUpdate(m, i, liveId);
          const adoptId = liveId;
          this.ydoc.transact(() => { m.set("_id", adoptId); });
          didBackfill = true;
          d1Ids.delete(liveId);
        } else {
          // Re-INSERT under the stale id. The Y.Map does not carry every D1
          // column — object.origin and glossary.related_terms live only in D1 —
          // so rebuilding the row from the Y.Map alone would reset them to their
          // INSERT defaults. When a row for this id still survives, read those
          // columns back and hand them to the insert so the recreation stays
          // faithful; otherwise the insert falls back to its default.
          let preserved: Record<string, unknown> | undefined;
          if (cfg.preserveColumns?.length) {
            const oldRow = await this.env.DB
              .prepare(
                `SELECT ${cfg.preserveColumns.join(", ")} FROM ${cfg.table} WHERE id = ? AND project_id = ?`,
              )
              .bind(id, this.projectId)
              .first<Record<string, unknown>>();
            if (oldRow) preserved = oldRow;
          }
          const r = await cfg.insert(m, i, id, preserved);
          if (r.backfilled) didBackfill = true;
        }
      }
    }

    for (const orphanId of d1Ids) {
      statements.push(
        this.env.DB.prepare(`DELETE FROM ${cfg.table} WHERE id = ?`).bind(orphanId),
      );
    }
    return didBackfill;
  }

  /** Section 6: objects INSERT (with _id backfill) / UPDATE / DELETE. */
  private snapshotObjects(
    statements: D1PreparedStatement[],
    now: string,
  ): Promise<boolean> {
    return this.snapshotFlatEntity(statements, {
      arrayName: "objects",
      table: "objects",
      keyField: "object_id",
      // Pending-validation IIIF objects are not yet ready to persist (objects
      // only — no other flat pipeline has this guard).
      skip: (m) => m.get("_validation_state") === "pending",
      pushUpdate: (m, _index, targetId) => {
        statements.push(
          this.env.DB
            .prepare(
              // object_id IS written here (unlike stories.story_id): object_id
              // has no UNIQUE index, so persisting the human key on UPDATE is
              // constraint-free and keeps D1 faithful to the Y.Doc. origin and
              // missing_from_repo are D1-only and preserved by omission.
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
      },
      // origin is D1-only; carry it across a stale-id re-INSERT (missing_from_repo
      // is likewise D1-only but is re-derived by the next repo sync, so it is
      // left to default here).
      preserveColumns: ["origin"],
      insert: (m, _index, explicitId, preserved) =>
        this.insertObjectRow(m, now, explicitId, preserved),
    });
  }

  /**
   * INSERT one glossary term. Thin wrapper over `insertRow`, with the glossary's
   * one divergence: it derives a `resolvedTermId` (slugify the title + an 8-char
   * suffix for a brand-new term; keep the existing slug for a re-created stranded
   * term, whose term_id is already set) ONCE — a fresh `crypto.randomUUID()` must
   * not be recomputed between the INSERT bind and the backfill — and its backfill
   * writes that second key onto the Y.Map when it was newly generated. No other
   * pipeline computes or backfills a second identity field.
   */
  private async insertGlossaryRow(
    termMap: Y.Map<unknown>,
    now: string,
    explicitId?: number,
    preserved?: Record<string, unknown>,
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

    // related_terms is a D1-only passthrough column — it is not part of the
    // Y.Doc glossary shape, so the compositor never edits it. On a stale-id
    // re-INSERT, `preserved` carries the surviving row's value so it is not
    // dropped; a brand-new term has none, binding NULL (schema-nullable).
    const columns = ["project_id", "term_id", "title", "definition", "related_terms", "created_by", "updated_at"];
    const binds = [
      this.projectId,
      resolvedTermId,
      titleStr,
      yTextToString(termMap.get("definition")),
      (preserved?.related_terms as string | null) ?? null,
      (termMap.get("created_by") as number | null) ?? null,
      now,
    ];
    return this.insertRow(
      "glossary_terms",
      columns,
      binds,
      explicitId,
      (id) => {
        this.ydoc.transact(() => {
          termMap.set("_id", id);
          if (!existingTermId) termMap.set("term_id", resolvedTermId);
        });
      },
      `[snapshot] glossary term "${resolvedTermId}" insert blocked — manual remediation needed`,
      `[snapshot] new glossary term "${resolvedTermId}" insert failed`,
    );
  }

  /** Section 7: glossary_terms INSERT (with _id backfill) / UPDATE / DELETE. */
  private snapshotGlossary(
    statements: D1PreparedStatement[],
    now: string,
  ): Promise<boolean> {
    return this.snapshotFlatEntity(statements, {
      arrayName: "glossary",
      table: "glossary_terms",
      keyField: "term_id",
      pushUpdate: (m, _index, targetId) => {
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
      },
      // related_terms is a D1-only passthrough; carry it across a stale-id
      // re-INSERT so the recreated term keeps it (the Y.Doc never holds it).
      preserveColumns: ["related_terms"],
      insert: (m, _index, explicitId, preserved) =>
        this.insertGlossaryRow(m, now, explicitId, preserved),
    });
  }

  /**
   * INSERT one project_pages row. Thin wrapper over `insertRow`. `order` is
   * threaded from the enclosing Y.Array index.
   */
  private async insertPageRow(
    pageMap: Y.Map<unknown>,
    order: number,
    now: string,
    explicitId?: number,
  ): Promise<{ id: number; backfilled: boolean }> {
    const slug = String(pageMap.get("slug") ?? "");
    const columns = ["project_id", "title", "slug", "body", '"order"', "created_by", "updated_at"];
    const binds = [
      this.projectId,
      yTextToString(pageMap.get("title")),
      slug,
      yTextToString(pageMap.get("body")),
      order,
      (pageMap.get("created_by") as number | null) ?? null,
      now,
    ];
    return this.insertRow(
      "project_pages",
      columns,
      binds,
      explicitId,
      (id) => { this.ydoc.transact(() => { pageMap.set("_id", id); }); },
      `[snapshot] page "${slug}" insert blocked — manual remediation needed`,
      `[snapshot] new page "${slug}" insert failed`,
    );
  }

  /** Section 8: project_pages INSERT (with _id backfill) / UPDATE / DELETE. */
  private snapshotPages(
    statements: D1PreparedStatement[],
    now: string,
  ): Promise<boolean> {
    return this.snapshotFlatEntity(statements, {
      arrayName: "pages",
      table: "project_pages",
      keyField: "slug",
      // Pages are the one flat pipeline with a positional column: the Y.Array
      // index threads into "order" so D1 stays aligned with the Yjs position.
      pushUpdate: (m, index, targetId) => {
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
              index,
              now,
              targetId,
            ),
        );
      },
      insert: (m, index, explicitId) => this.insertPageRow(m, index, now, explicitId),
    });
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
