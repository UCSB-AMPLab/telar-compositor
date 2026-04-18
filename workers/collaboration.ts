/**
 * ProjectCollaborationDO — Durable Object class for real-time collaborative editing.
 *
 * One instance per project. Hosts a Yjs document in memory, accepts WebSocket
 * connections from authenticated project members, relays Yjs sync messages between
 * clients, and snapshots the document to D1 every 30 seconds via alarm and on
 * last-client disconnect.
 *
 * Authentication: Validates a short-lived session token passed in the `?token=`
 * query parameter (the browser sends its session cookie value). The DO checks project
 * membership in D1 before accepting any WebSocket connection.
 *
 * Persistence strategy:
 *   - Binary blob  → projects.yjs_state (fast warm restart via Y.applyUpdate)
 *   - Row-level data → entity tables (stories, steps, layers, objects, config, glossary)
 *     so the publish pipeline reads from D1 unchanged
 *
 * Cold start:
 *   - When no yjs_state blob exists, the DO builds the Y.Doc from D1 rows.
 */

import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { DurableObject } from "cloudflare:workers";
import { makeAfterTransactionHandler, buildContributionUpdate } from "./collaboration-helpers";

// y-websocket message type constants (must match client)
const messageSync = 0;
const messageAwareness = 1;

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
}

interface StepRow {
  id: number;
  story_id: number;
  step_number: number;
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
}

interface LayerRow {
  id: number;
  step_id: number;
  layer_number: number;
  title: string | null;
  button_label: string | null;
  content: string | null;
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
  featured: number;
  image_available: number;
}

interface GlossaryRow {
  id: number;
  term_id: string;
  title: string | null;
  definition: string | null;
}

interface PageRow {
  id: number;
  title: string | null;
  slug: string;
  body: string | null;
  order: number;
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

/**
 * Return the string value of a Y.Text or plain string/number/null.
 * Prevents "[object Object]" in D1 rows (Pitfall 4).
 */
function yTextToString(val: unknown): string {
  if (val instanceof Y.Text) return val.toString();
  return String(val ?? "");
}

/**
 * Parse a cookie header and return the value for the given name, or null.
 */
function parseCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k.trim() === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

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
  private isSnapshotting = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ydoc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);

    // Attach afterTransaction field-path accumulator.
    // Uses the WebSocket reference in tr.origin (set by readSyncMessage) to
    // recover the userId via socket attachment (A2 verified in plan 28-03 tests).
    this.ydoc.on("afterTransaction", makeAfterTransactionHandler(
      this.ydoc,
      this.userFieldSets,
      (origin: unknown) => {
        if (!origin || typeof origin !== "object") return null;
        try {
          const att = (origin as { deserializeAttachment?: () => SocketAttachment | null })
            .deserializeAttachment?.() as SocketAttachment | null;
          return att?.userId ?? null;
        } catch {
          return null;
        }
      }
    ));

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
      if (this.projectId !== null) {
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.ensureDocLoaded();
          await this.snapshotToD1();
        });
      }
      return new Response("OK", { status: 200 });
    }

    // POST /reset — destroy the in-memory Y.Doc, clear the D1 blob, rebuild
    // from D1 entity rows, and close all connected sockets so clients reconnect
    // with clean state. Convenor-only (checked via session cookie).
    if (url.pathname.endsWith("/reset") && request.method === "POST") {
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
    const cookieHeader = request.headers.get("Cookie") ?? "";
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)__compositor_session=([^;]+)/);
    const rawCookieValue = cookieMatch?.[1] ?? null;
    const token = rawCookieValue ? decodeURIComponent(rawCookieValue) : url.searchParams.get("token");
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

    // Serialise cold-start initialisation to prevent race conditions (Pitfall 3)
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

    // On last-client disconnect, snapshot immediately
    if (this.ctx.getWebSockets().length === 0) {
      await this.snapshotToD1();
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
   * to prevent race conditions on cold start (Pitfall 3).
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
    } else {
      // Cold start — build from D1 rows
      await this.buildFromD1Rows();
    }

    this.docLoaded = true;
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
            "period, year, featured, image_available FROM objects WHERE project_id = ? ORDER BY id ASC",
          )
          .bind(this.projectId)
          .all<ObjectRow>(),
        this.env.DB
          .prepare("SELECT * FROM glossary_terms WHERE project_id = ? ORDER BY id ASC")
          .bind(this.projectId)
          .all<GlossaryRow>(),
        this.env.DB
          .prepare("SELECT id, title, slug, body, \"order\" FROM project_pages WHERE project_id = ? ORDER BY \"order\" ASC")
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

        // ---- steps ----
        const stepsArray = new Y.Array<Y.Map<unknown>>();
        for (const step of stepsByStoryId.get(story.id) ?? []) {
          const stepMap = new Y.Map<unknown>();
          stepMap.set("_id", step.id);
          stepMap.set("step_number", step.step_number);
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

          // ---- layers ----
          const layersArray = new Y.Array<Y.Map<unknown>>();
          for (const layer of layersByStepId.get(step.id) ?? []) {
            const layerMap = new Y.Map<unknown>();
            layerMap.set("_id", layer.id);
            layerMap.set("layer_number", layer.layer_number);
            layerMap.set("title", new Y.Text(layer.title ?? ""));
            layerMap.set("button_label", new Y.Text(layer.button_label ?? ""));
            layerMap.set("content", new Y.Text(layer.content ?? ""));
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
        objMap.set("featured", obj.featured === 1);
        objMap.set("image_available", obj.image_available === 1);
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
  private deduplicateYArray(arrayName: string, entityKey: string): void {
    const yArray = this.ydoc.getArray<Y.Map<unknown>>(arrayName);
    if (yArray.length === 0) return;

    const seenIds = new Set<number>();
    const seenKeys = new Set<string>();
    const indicesToDelete: number[] = [];

    for (let i = 0; i < yArray.length; i++) {
      const yMap = yArray.get(i);
      const id = yMap.get("_id") as number | null;
      const key = String(yMap.get(entityKey) ?? "");

      // Duplicate by D1 id
      if (id !== null && id !== undefined && seenIds.has(id)) {
        indicesToDelete.push(i);
        continue;
      }
      // Duplicate by entity key (skip empty keys — new items may not have one yet)
      if (key && seenKeys.has(key)) {
        indicesToDelete.push(i);
        continue;
      }

      if (id !== null && id !== undefined) seenIds.add(id);
      if (key) seenKeys.add(key);
    }

    if (indicesToDelete.length > 0) {
      // Delete in reverse order so indices stay valid
      this.ydoc.transact(() => {
        for (let i = indicesToDelete.length - 1; i >= 0; i--) {
          yArray.delete(indicesToDelete[i], 1);
        }
      });
      console.log(
        `[snapshot] Deduplicated ${arrayName}: removed ${indicesToDelete.length} duplicate(s)`,
      );
    }
  }

  async snapshotToD1(): Promise<void> {
    if (!this.projectId || !this.docLoaded) return;
    if (this.isSnapshotting) return; // Pitfall 2: prevent duplicate INSERTs from concurrent calls
    this.isSnapshotting = true;
    try {
      await this.doSnapshot();
    } finally {
      this.isSnapshotting = false;
    }
  }

  private async doSnapshot(): Promise<void> {
    if (!this.projectId || !this.docLoaded) return;

    // --- Corruption guard: deduplicate Y.Arrays before snapshot ---
    // If a bug (e.g. broken reorder) introduced duplicate entries, remove them
    // here to prevent the corruption from persisting to D1. Duplicates are
    // detected by _id (D1 primary key) for existing items, and by entity key
    // (story_id, object_id) for all items. The first occurrence wins.
    this.deduplicateYArray("stories", "story_id");
    this.deduplicateYArray("objects", "object_id");
    this.deduplicateYArray("glossary", "term_id");
    this.deduplicateYArray("pages", "slug");

    // Track whether we performed any INSERTs that backfilled _id onto Y.Maps —
    // if so, broadcast the updated Y.Doc state to all connected clients at the
    // end so they converge on the canonical D1 IDs.
    let didBackfill = false;
    const now = new Date().toISOString();

    const statements: D1PreparedStatement[] = [];

    // NOTE: projects.yjs_state blob write is appended at the end of this method
    // so the encoded state includes any INSERT ID backfills applied by sections
    // 5-8. Otherwise a cold-start restore from the blob would see _id: null
    // items that have already been INSERTed to D1 and would re-INSERT them.

    // 3. Snapshot config
    const config = this.ydoc.getMap<unknown>("config");
    const landing = config.get("landing") as Y.Map<unknown> | undefined;
    statements.push(
      this.env.DB
        .prepare(
          "UPDATE project_config SET " +
          "title = ?, description = ?, author = ?, email = ?, lang = ?, " +
          "baseurl = ?, url = ?, theme = ?, logo = ?, " +
          "include_demo_content = ?, google_sheets_enabled = ?, google_sheets_published_url = ?, " +
          "show_on_homepage = ?, show_story_steps = ?, show_object_credits = ?, " +
          "browse_and_search = ?, show_link_on_homepage = ?, show_sample_on_homepage = ?, " +
          "featured_count = ?, story_key = ?, navigation_json = ?, updated_at = ? " +
          "WHERE project_id = ?",
        )
        .bind(
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
          Number(config.get("featured_count") ?? 4),
          String(config.get("story_key") ?? ""),
          JSON.stringify((config.get("navigation") as Y.Array<unknown>)?.toArray() ?? []),
          now,
          this.projectId,
        ),
    );

    // 4. Snapshot landing (project_landing)
    if (landing) {
      statements.push(
        this.env.DB
          .prepare(
            "UPDATE project_landing SET " +
            "stories_heading = ?, stories_intro = ?, objects_heading = ?, " +
            "objects_intro = ?, welcome_body = ?, updated_at = ? " +
            "WHERE project_id = ?",
          )
          .bind(
            yTextToString(landing.get("stories_heading")),
            yTextToString(landing.get("stories_intro")),
            yTextToString(landing.get("objects_heading")),
            yTextToString(landing.get("objects_intro")),
            yTextToString(landing.get("welcome_body")),
            now,
            this.projectId,
          ),
      );
    }

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
        // INSERT — await individually so we can capture last_row_id for backfill
        const storyResult = await this.env.DB
          .prepare(
            'INSERT INTO stories (project_id, story_id, title, subtitle, byline, "order", private, draft, updated_at) ' +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            this.projectId,
            String(storyMap.get("story_id") ?? ""),
            yTextToString(storyMap.get("title")),
            yTextToString(storyMap.get("subtitle")),
            yTextToString(storyMap.get("byline")),
            si, // order from Y.Array index
            storyMap.get("private") ? 1 : 0,
            storyMap.get("draft") ? 1 : 0,
            now,
          )
          .run();
        storyId = storyResult.meta.last_row_id as number;
        // Backfill the canonical D1 ID onto the Y.Map so all peers converge
        const insertedStoryId = storyId;
        this.ydoc.transact(() => { storyMap.set("_id", insertedStoryId); });
        didBackfill = true;
      } else {
        statements.push(
          this.env.DB
            .prepare(
              "UPDATE stories SET title = ?, subtitle = ?, byline = ?, " +
              "\"order\" = ?, private = ?, draft = ?, updated_at = ? WHERE id = ?",
            )
            .bind(
              yTextToString(storyMap.get("title")),
              yTextToString(storyMap.get("subtitle")),
              yTextToString(storyMap.get("byline")),
              si, // order from Y.Array index (keeps D1 aligned with Yjs position)
              storyMap.get("private") ? 1 : 0,
              storyMap.get("draft") ? 1 : 0,
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
            const stepResult = await this.env.DB
              .prepare(
                "INSERT INTO steps (story_id, step_number, object_id, x, y, zoom, page, question, answer, alt_text, clip_start, clip_end, loop, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              )
              .bind(
                storyId,
                sti + 1, // step_number is 1-based
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
              )
              .run();
            stepId = stepResult.meta.last_row_id as number;
            const insertedStepId = stepId;
            this.ydoc.transact(() => { stepMap.set("_id", insertedStepId); });
            didBackfill = true;
          } else {
            statements.push(
              this.env.DB
                .prepare(
                  "UPDATE steps SET step_number = ?, object_id = ?, x = ?, y = ?, zoom = ?, " +
                  "page = ?, question = ?, answer = ?, alt_text = ?, " +
                  "clip_start = ?, clip_end = ?, loop = ?, updated_at = ? WHERE id = ?",
                )
                .bind(
                  sti + 1, // step_number normalised from Y.Array index
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
                const layerResult = await this.env.DB
                  .prepare(
                    "INSERT INTO layers (step_id, layer_number, title, button_label, content, updated_at) " +
                    "VALUES (?, ?, ?, ?, ?, ?)",
                  )
                  .bind(
                    stepId,
                    li + 1, // layer_number is 1-based
                    yTextToString(layerMap.get("title")),
                    yTextToString(layerMap.get("button_label")),
                    yTextToString(layerMap.get("content")),
                    now,
                  )
                  .run();
                layerId = layerResult.meta.last_row_id as number;
                const insertedLayerId = layerId;
                this.ydoc.transact(() => { layerMap.set("_id", insertedLayerId); });
                didBackfill = true;
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

    // 6. Snapshot objects — INSERT for new IIIF items (with _id === null),
    //    UPDATE for existing ones, DELETE for orphans. Objects with
    //    _validation_state === "pending" are skipped so the object does
    //    not persist to D1 until the IIIF manifest has been validated.
    //    Order column is written from the Y.Array index.
    const objectsArray = this.ydoc.getArray<Y.Map<unknown>>("objects");
    const d1ObjectsResult = await this.env.DB
      .prepare("SELECT id FROM objects WHERE project_id = ?")
      .bind(this.projectId)
      .all<{ id: number }>();
    const d1ObjectIds = new Set(d1ObjectsResult.results.map((r) => r.id));

    for (let oi = 0; oi < objectsArray.length; oi++) {
      const objMap = objectsArray.get(oi);
      let objId = objMap.get("_id") as number | null;

      // skip pending-validation IIIF objects — they are not yet ready to persist
      if (objMap.get("_validation_state") === "pending") {
        // If a previously-inserted object has regressed to "pending", leave its
        // D1 row alone (unlikely path, but be conservative).
        if (typeof objId === "number") d1ObjectIds.delete(objId);
        continue;
      }

      if (objId === null || objId === undefined) {
        const objResult = await this.env.DB
          .prepare(
            'INSERT INTO objects (project_id, object_id, title, creator, description, alt_text, source_url, period, year, featured, image_available, origin, missing_from_repo, "order", updated_at) ' +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            this.projectId,
            String(objMap.get("object_id") ?? ""),
            yTextToString(objMap.get("title")),
            yTextToString(objMap.get("creator")),
            yTextToString(objMap.get("description")),
            yTextToString(objMap.get("alt_text")),
            String(objMap.get("source_url") ?? ""),
            yTextToString(objMap.get("period")),
            yTextToString(objMap.get("year")),
            objMap.get("featured") ? 1 : 0,
            objMap.get("image_available") ? 1 : 0,
            String(objMap.get("origin") ?? "iiif"),
            0, // missing_from_repo = false on insert
            oi, // order from Y.Array index
            now,
          )
          .run();
        objId = objResult.meta.last_row_id as number;
        const insertedObjId = objId;
        this.ydoc.transact(() => { objMap.set("_id", insertedObjId); });
        didBackfill = true;
      } else {
        statements.push(
          this.env.DB
            .prepare(
              'UPDATE objects SET title = ?, creator = ?, description = ?, alt_text = ?, ' +
              'source_url = ?, period = ?, year = ?, featured = ?, image_available = ?, ' +
              '"order" = ?, updated_at = ? WHERE id = ?',
            )
            .bind(
              yTextToString(objMap.get("title")),
              yTextToString(objMap.get("creator")),
              yTextToString(objMap.get("description")),
              yTextToString(objMap.get("alt_text")),
              String(objMap.get("source_url") ?? ""),
              yTextToString(objMap.get("period")),
              yTextToString(objMap.get("year")),
              objMap.get("featured") ? 1 : 0,
              objMap.get("image_available") ? 1 : 0,
              oi, // order from Y.Array index
              now,
              objId,
            ),
        );
        d1ObjectIds.delete(objId);
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

    // 7. Snapshot glossary — INSERT / UPDATE / DELETE.
    //    term_id on INSERT: slugify the title if present, otherwise fall back
    //    to the Y.Map's _temp_id (UUID) so the NOT NULL constraint is satisfied.
    const glossaryArray = this.ydoc.getArray<Y.Map<unknown>>("glossary");
    const d1GlossaryResult = await this.env.DB
      .prepare("SELECT id FROM glossary_terms WHERE project_id = ?")
      .bind(this.projectId)
      .all<{ id: number }>();
    const d1GlossaryIds = new Set(d1GlossaryResult.results.map((r) => r.id));

    for (let gi = 0; gi < glossaryArray.length; gi++) {
      const termMap = glossaryArray.get(gi);
      let termId = termMap.get("_id") as number | null;

      if (termId === null || termId === undefined) {
        const existingTermId = termMap.get("term_id") as string | undefined;
        const tempId = termMap.get("_temp_id") as string | undefined;
        const titleStr = yTextToString(termMap.get("title"));
        const slugBase = titleStr.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const resolvedTermId = existingTermId
          ? existingTermId
          : slugBase
            ? `${slugBase}-${(tempId ?? crypto.randomUUID()).slice(0, 8)}`
            : (tempId ?? crypto.randomUUID());

        const termResult = await this.env.DB
          .prepare(
            "INSERT INTO glossary_terms (project_id, term_id, title, definition, updated_at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(
            this.projectId,
            resolvedTermId,
            titleStr,
            yTextToString(termMap.get("definition")),
            now,
          )
          .run();
        termId = termResult.meta.last_row_id as number;
        const insertedTermId = termId;
        this.ydoc.transact(() => {
          termMap.set("_id", insertedTermId);
          if (!existingTermId) termMap.set("term_id", resolvedTermId);
        });
        didBackfill = true;
      } else {
        statements.push(
          this.env.DB
            .prepare(
              "UPDATE glossary_terms SET title = ?, definition = ?, updated_at = ? WHERE id = ?",
            )
            .bind(
              yTextToString(termMap.get("title")),
              yTextToString(termMap.get("definition")),
              now,
              termId,
            ),
        );
        d1GlossaryIds.delete(termId);
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

    // 8. Snapshot pages — INSERT / UPDATE / DELETE. Order written from Y.Array
    //    index so D1 stays aligned with the Yjs position.
    const pagesArray = this.ydoc.getArray<Y.Map<unknown>>("pages");
    const d1PagesResult = await this.env.DB
      .prepare("SELECT id FROM project_pages WHERE project_id = ?")
      .bind(this.projectId)
      .all<{ id: number }>();
    const d1PageIds = new Set(d1PagesResult.results.map((r) => r.id));

    for (let pi = 0; pi < pagesArray.length; pi++) {
      const pageMap = pagesArray.get(pi);
      let pageId = pageMap.get("_id") as number | null;

      if (pageId === null || pageId === undefined) {
        const pageResult = await this.env.DB
          .prepare(
            'INSERT INTO project_pages (project_id, title, slug, body, "order", updated_at) ' +
            "VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(
            this.projectId,
            yTextToString(pageMap.get("title")),
            String(pageMap.get("slug") ?? ""),
            yTextToString(pageMap.get("body")),
            pi, // order from Y.Array index
            now,
          )
          .run();
        pageId = pageResult.meta.last_row_id as number;
        const insertedPageId = pageId;
        this.ydoc.transact(() => { pageMap.set("_id", insertedPageId); });
        didBackfill = true;
      } else {
        statements.push(
          this.env.DB
            .prepare(
              'UPDATE project_pages SET title = ?, slug = ?, body = ?, ' +
              '"order" = ?, updated_at = ? WHERE id = ?',
            )
            .bind(
              yTextToString(pageMap.get("title")),
              String(pageMap.get("slug") ?? ""),
              yTextToString(pageMap.get("body")),
              pi, // order from Y.Array index
              now,
              pageId,
            ),
        );
        d1PageIds.delete(pageId);
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

    // 9. Snapshot contribution data to project_members
    // fields_edited is sourced from userFieldSets.get(userId).size (unique-field
    // Set semantics). The Set is NOT cleared after snapshot — it keeps accumulating
    // within the DO's lifetime (pitfall 5 accepted behaviour).
    // Contribution UPDATE statements are added to the same batch for atomicity (Pitfall 6).
    if (this.projectId) {
      const allUserIds = new Set<number>([...this.userFieldSets.keys(), ...this.newSessions]);
      // Include all users with field edits or new sessions
      const activeUserIds = [...allUserIds].filter((uid) =>
        (this.userFieldSets.get(uid)?.size ?? 0) > 0 || this.newSessions.has(uid)
      );

      if (activeUserIds.length > 0) {
        // CR-01 fix: batch all contribution reads into a single query
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
      }
      // userFieldSets Sets are NOT cleared — they keep accumulating.
      this.newSessions.clear();
    }

    // Encode the full Y.Doc state as a binary blob AFTER all backfills so the
    // restored state on cold start matches the D1 rows inserted above.
    const blob = Y.encodeStateAsUpdate(this.ydoc);
    statements.push(
      this.env.DB
        .prepare("UPDATE projects SET yjs_state = ?, updated_at = ? WHERE id = ?")
        .bind(blob, now, this.projectId),
    );

    // Execute all updates atomically (Pitfall 6)
    await this.env.DB.batch(statements);

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
   * The token is the raw value of the __compositor_session cookie.
   * React Router's cookie session storage uses HMAC-signed cookies whose payload
   * is base64-encoded JSON. We parse it directly here since the DO runs outside
   * React Router context.
   *
   * Format: base64url(<json payload>).<base64url(<hmac signature>)>
   *
   * Returns userId if valid, null if invalid or expired.
   */
  private async getUserIdFromToken(token: string): Promise<number | null> {
    try {
      // React Router's createCookieSessionStorage produces cookies in the format:
      // <base64url(JSON)>.<base64url(HMAC-SHA256 signature)>
      // Split on the last dot to separate payload from signature
      const lastDot = token.lastIndexOf(".");
      if (lastDot === -1) return null;

      const payloadB64 = token.slice(0, lastDot);
      const sigB64 = token.slice(lastDot + 1);

      // Verify HMAC-SHA256 signature
      const secret = this.env.SESSION_SECRET;
      const keyData = new TextEncoder().encode(secret);
      const key = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );

      const signedData = new TextEncoder().encode(payloadB64);
      const signature = base64urlDecode(sigB64);

      const valid = await crypto.subtle.verify("HMAC", key, signature as BufferSource, signedData);
      if (!valid) return null;

      // Decode payload
      const payloadJson = new TextDecoder().decode(base64urlDecode(payloadB64));
      const payload = JSON.parse(payloadJson) as Record<string, unknown>;

      // Check session expiry if present in the payload
      const expires = payload["expires"] as string | undefined;
      if (expires && new Date(expires) < new Date()) return null;

      // Fallback: reject tokens older than 7 days (matches cookie maxAge)
      const createdAt = payload["createdAt"] as string | undefined;
      if (createdAt && Date.now() - new Date(createdAt).getTime() > 7 * 24 * 60 * 60 * 1000) return null;

      // Extract userId — React Router stores it under the key used in the session
      const userId = payload["userId"] as number | undefined;
      if (typeof userId !== "number") return null;

      return userId;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Utility — base64url decode (no Node.js Buffer available in Workers)
// ---------------------------------------------------------------------------

function base64urlDecode(input: string): Uint8Array {
  // Convert base64url to standard base64
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
