/**
 * Object detail page — IIIF viewer + metadata editor.
 *
 * Layout: two-column — viewer (left ~60%) + scrollable metadata form (right ~40%).
 * Constructs manifest URLs from project config (url + baseurl) for self-hosted
 * objects, or uses source_url directly for external IIIF objects.
 *
 * @version v1.5.0-beta
 */

import { eq, and } from "drizzle-orm";
import { objectsSheetOrder } from "~/lib/objects.server";
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, useFetcher, useNavigate, redirect, useRouteError, isRouteErrorResponse } from "react-router";
import { ArrowLeft, GraduationCap, Trash2, Video, Music } from "lucide-react";
import type { Route } from "./+types/_app.objects.$objectId";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { readSiteTelarVersion } from "~/lib/site-version.server";
import { objects, project_config, projects, steps, stories } from "~/db/schema";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { gatePageSite } from "~/lib/page-site-gate.server";
import { setObjectFeatured } from "~/lib/object-featured.server";
import { getUserRole } from "~/lib/membership.server";
import { useSiteFetcher } from "~/lib/page-site";
import { deriveStatus } from "~/lib/iiif-types";
import { Switch } from "~/components/ui/Switch";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { InlineTextArea } from "~/components/ui/InlineTextArea";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { findYMapById, getYText } from "~/lib/yjs-helpers";
import * as Y from "yjs";
import { readProjectObjectsHeader } from "~/lib/objects-sheet-header.server";
import { ObjectCustomFields } from "~/components/features/objects/ObjectCustomFields";
import { IiifViewer } from "~/components/features/objects/IiifViewer";
import { detectMediaType, extractVideoId } from "~/lib/media-type";
import { iiifUrlsFor, isExternalSource, stepObjectResolver } from "~/lib/object-id";
import { VideoEmbed } from "~/components/features/editor/VideoEmbed";
import { AudioPlayer } from "~/components/features/editor/AudioPlayer";
import { CommitAndBuildModal } from "~/components/features/objects/CommitAndBuildModal";
import { decrypt } from "~/lib/crypto.server";
import { recordError } from "~/lib/error-capture";
import { githubHeaders } from "~/lib/github.server";
import { dispatchWorkflow, getJobSteps, mapStepsToBuildPhases } from "~/lib/commit.server";
import { bumpProjectHeadFrom } from "~/lib/github-status.server";
import type { WorkflowRun } from "~/lib/commit.server";
import { resolveProjectToken } from "~/lib/github-app.server";
import { deleteObjectWithRecord } from "~/lib/object-repo-delete.server";
import type { RecordedDeleteResult } from "~/lib/object-repo-delete.server";
import { removeThroughCommittedRecord, type RemovalTarget } from "~/lib/pending-object-ops.server";
import { holdOperationLease } from "~/lib/operation-lease.server";
import { readRepoWriteRefusal } from "~/lib/upgrade-gate.server";
import { renameObjectFromPage } from "~/lib/object-rename.server";
import { objectRenameFacts } from "~/lib/object-rename-id";
import { REPO_WRITE_REFUSAL_KEYS } from "~/lib/repo-write-refusal-keys";
import { ObjectIdField } from "~/components/features/objects/ObjectIdField";

export const handle = { i18n: ["common", "objects"] };

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  // Get active project
  const resolved = await resolveActiveProjectFromRequest(request, env, user.id);
  if (!resolved) throw redirect("/onboarding");
  const { project: activeProject, userRole } = resolved;

  // Fetch the object
  const [object] = await db
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.project_id, activeProject.id),
        eq(objects.object_id, params.objectId)
      )
    )
    .limit(1);

  if (!object) throw new Response("Not found", { status: 404 });

  // Fetch project config for site URL
  const [config] = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, activeProject.id))
    .limit(1);

  // Construct IIIF URLs — skip for video/audio objects (they don't have tiles)
  const loaderMediaType = detectMediaType(object.source_url, object.object_id);
  const isMediaObject = loaderMediaType === "youtube" || loaderMediaType === "vimeo"
    || loaderMediaType === "google-drive" || loaderMediaType === "audio";

  const isExternal = isExternalSource(object.source_url);
  const frameworkVersion = config?.telar_version ?? null;

  let manifestUrl: string | null = null;
  let infoJsonUrl: string | null = null;

  if (!isMediaObject) {
    const siteBase = config?.url ? `${config.url}${config.baseurl ?? ""}` : null;
    ({ manifestUrl, infoJsonUrl } = iiifUrlsFor(object, siteBase, frameworkVersion));
  }

  // The steps the site shows this object for: each step's `object` matched
  // against every object of the project as the framework matches it, so a
  // step naming `map` is a use of `map.jpg`. In objects.csv order, which
  // decides the row a step shows where two share the site's id.
  const [projectObjectIds, candidateSteps] = await Promise.all([
    db
      .select({ object_id: objects.object_id })
      .from(objects)
      .where(eq(objects.project_id, activeProject.id))
      .orderBy(objectsSheetOrder()),
    db
      .select({
        story_id: steps.story_id,
        step_number: steps.step_number,
        object_id: steps.object_id,
      })
      .from(steps)
      .innerJoin(stories, eq(steps.story_id, stories.id))
      .where(eq(stories.project_id, activeProject.id)),
  ]);
  const showsFor = stepObjectResolver(projectObjectIds, frameworkVersion);
  const stepRefs = candidateSteps.filter((s) => showsFor(s.object_id)?.object_id === object.object_id);
  const rename = objectRenameFacts(
    object,
    { sheet: projectObjectIds, d1: projectObjectIds, version: frameworkVersion },
    candidateSteps.map((s) => s.object_id),
  );

  const storyIds = [...new Set(stepRefs.map((r) => r.story_id))];
  let storyTitles: Record<number, string | null> = {};
  if (storyIds.length > 0) {
    const storyRows = await db
      .select({ id: stories.id, title: stories.title })
      .from(stories)
      .where(eq(stories.project_id, activeProject.id));
    storyTitles = Object.fromEntries(storyRows.map((s) => [s.id, s.title]));
  }

  const usedInStories = stepRefs.map((ref) => ({
    storyTitle: storyTitles[ref.story_id] ?? null,
    stepNumber: ref.step_number,
  }));

  // Construct site base URL for audio file access
  const siteBase = config?.url
    ? `${config.url}${config.baseurl ?? ""}`
    : null;

  // The sheet's header, for the order of the custom fields: one strict read of
  // objects.csv at the recorded head, and null (the order the blobs imply) on
  // any failure.
  let sheetHeader: string[] | null = null;
  try {
    const sheetUserToken = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
    sheetHeader = await readProjectObjectsHeader(env, activeProject, sheetUserToken, userRole);
  } catch {
    sheetHeader = null;
  }

  return {
    object,
    sheetHeader,
    manifestUrl,
    infoJsonUrl,
    isExternal,
    usedInStories,
    rename,
    siteBase,
    userRole,
    currentUserId: user.id,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, params, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Intents skipped by the page-site check below: each acts on the object
  // row's own site.
  const PAGE_SITE_EXEMPT = ["autosave-object-featured", "delete-object", "rename-object"];

  // Every other intent acts on the session's site, and only when the page
  // that posted it showed that site. `null` is the no-project case, which each
  // intent answers in its own shape.
  const gate = await gatePageSite(request, env, user.id, formData, intent, PAGE_SITE_EXEMPT);
  if (gate.refused) return gate.refused;
  const page = gate.page;

  switch (intent) {
    case "autosave-object-featured":
      await setObjectFeatured(
        db,
        user.id,
        Number(formData.get("entityId")),
        formData.get("value") === "true",
      );
      return { ok: true, intent: "autosave-object-featured" };

    case "delete-object": {
      const objectDbId = Number(formData.get("objectDbId"));
      const fromRepo = formData.get("fromRepo") === "true";

      // Look up the object to get object_id and source_url
      const [targetObject] = await db
        .select()
        .from(objects)
        .where(eq(objects.id, objectDbId))
        .limit(1);

      if (!targetObject) throw redirect("/objects");

      // The object's own site, which is the one the page showed it on, and
      // the caller's standing there. A course-derived object is its own
      // `project_id`'s, never `course_project_id`'s. A caller with no
      // membership on that site is sent back to the grid.
      const [objectProject] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, targetObject.project_id))
        .limit(1);
      if (!objectProject) throw redirect("/objects");
      const objectRole = await getUserRole(db, objectProject.id, user.id);
      if (objectRole === null) throw redirect("/objects");
      const resolved = { project: objectProject, userRole: objectRole };

      // Standing, not just membership — and two different standings, because
      // the two buttons in the delete dialog are two different operations.
      //
      // Removing the object from the compositor is the collaborative
      // document's own delete, whose model is stated in `use-structural-ops`
      // and enforced in the Durable Object: the convenor deletes anything, a
      // collaborator or instructor deletes only what they created. The grid
      // honours exactly that, so the detail page must too, or the same object
      // is deletable from the list and not from its own page.
      //
      // `fromRepo` is the narrower operation — it removes the object's image
      // files and its objects.csv record from the published site — and the
      // repository is the convenor's to change, so that half admits the
      // convenor alone even on an object a collaborator created.
      //
      // The membership read above establishes membership only, so the role it
      // reports is what these predicates read.
      const isConvenor = resolved.userRole === "convenor";
      const createdByCaller = targetObject.created_by === user.id;
      if (fromRepo ? !isConvenor : !(isConvenor || createdByCaller)) {
        return { ok: false, error: "forbidden", objectDbId };
      }

      // Course items are undeletable on every path while the marker is set,
      // the convenor included. Refused before the repo branch so a forbidden
      // delete never commits a CSV rewrite it would then have to undo.
      if (targetObject.course_project_id != null) {
        return { ok: false, error: "course_item_delete_refused", objectDbId };
      }

      if (fromRepo) {
        // The repository half rewrites objects.csv and the site rebuilds from
        // it, so a site behind the latest release, or one whose release
        // cannot be read, is refused before anything is read or committed.
        const repoRefusal = await readRepoWriteRefusal(db, env, {
          project: resolved.project,
          userRole: resolved.userRole,
          encryptedToken: user.encrypted_access_token,
        });
        if (repoRefusal) return { ok: false, error: repoRefusal, objectDbId };
      }

      // Both halves are done here, under the objects lease, before the
      // answer: the removal goes through the collaboration object by the
      // object's D1 id, which removes its Y.Map and lets the flush take the
      // row. Waiting on the page for the document half left an object
      // deleted from the repository and standing in the Compositor whenever
      // the tab closed after the answer, and a publish that read D1 in
      // between wrote its row back into objects.csv.
      const target = { object_id: targetObject.object_id, doc_id: targetObject.id };
      const held = await holdOperationLease(env, resolved.project.id, user.id, "objects", async (landed) => {
        const answer = fromRepo
          ? await deleteFromRepositoryAndDocument(env, db, user, resolved, target)
          : await deleteFromDocument(env, db, resolved.project.id, user.id, target);
        if (answer.ok) landed();
        return answer;
      });
      if (held.refused) return { ok: false, error: "operation_in_progress", objectDbId };
      if (!held.value.ok) return { ok: false, error: held.value.error, objectDbId };
      // `pending`: the repository half is done and the document half is not
      // yet; its record finishes it.
      return { ok: true, intent: "delete-object", objectDbId, pending: held.value.pending };
    }

    case "rename-object":
      return renameFromForm(env, db, user, formData);

    case "poll-build": {
      const runIdParam = formData.get("runId") as string | null;
      if (!runIdParam) {
        return { ok: false, intent: "poll-build", error: "missing_run_id" };
      }

      // Membership-aware (member-level: polling is read-only build status) —
      // no first-owned-project fallback.
      const resolvedPoll = page;
      if (!resolvedPoll) {
        return { ok: false, intent: "poll-build", error: "no_project" };
      }
      const activeProjectPoll = resolvedPoll.project;

      try {
        // A collaborator's own token may have no read access to a private
        // repo — polling under it here would otherwise fail every attempt
        // with poll_failed, matching the bug already fixed in
        // _app.objects.tsx's own poll-build case.
        const pollUserToken = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const tokenPoll = await resolveProjectToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          activeProjectPoll.installation_id,
          pollUserToken,
          resolvedPoll.userRole,
        );
        const [ownerPoll, repoPoll] = activeProjectPoll.github_repo_full_name.split("/");

        const runId = Number(runIdParam);
        const runRes = await fetch(
          `https://api.github.com/repos/${ownerPoll}/${repoPoll}/actions/runs/${runId}`,
          { headers: githubHeaders(tokenPoll) },
        );
        if (!runRes.ok) {
          return { ok: false, intent: "poll-build", error: "poll_failed" };
        }
        const run = (await runRes.json()) as WorkflowRun;
        const jobSteps = await getJobSteps(tokenPoll, ownerPoll, repoPoll, runId);
        const phases = mapStepsToBuildPhases(jobSteps);
        return {
          ok: true,
          intent: "poll-build",
          buildStatus: run.status,
          buildConclusion: run.conclusion,
          buildUrl: run.html_url,
          runId: run.id,
          phases,
        };
      } catch {
        return { ok: false, intent: "poll-build", error: "poll_failed" };
      }
    }

    case "dispatch-iiif": {
      // Dispatch full site build to generate tiles (tiles are deployed via Pages, not git)
      // Membership-aware (member-level: the Generate-tiles button renders for
      // any project member; dispatching a rebuild is non-destructive) — no
      // first-owned-project fallback.
      const resolved3 = page;
      if (!resolved3) {
        return { ok: false, intent: "dispatch-iiif", error: "no_project" };
      }
      const activeProject3 = resolved3.project;

      try {
        // A collaborator's own token has no write access to the convenor's
        // repository, and on a private repo may have no read access either —
        // falling back to it unconditionally on a mint failure would trade a
        // clear failure for a confusing GitHub error. The user token is a
        // fallback for the convenor only, matching every other dispatch in
        // this app.
        const token3 = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
        const [owner3, repo3] = activeProject3.github_repo_full_name.split("/");

        const dispatchToken = await resolveProjectToken(
          env.GITHUB_APP_ID,
          env.GITHUB_PRIVATE_KEY,
          activeProject3.installation_id,
          token3,
          resolved3.userRole,
        );
        const dispatch = await dispatchWorkflow(
          dispatchToken, owner3, repo3, "build.yml",
        );
        return {
          ok: true,
          intent: "dispatch-iiif",
          runId: dispatch.runId || null,
          htmlUrl: dispatch.htmlUrl || null,
        };
      } catch (err) {
        // Standardised error code — the raw err.message was previously
        // returned AS the code, which no client map could handle.
        return {
          ok: false,
          intent: "dispatch-iiif",
          error: "dispatch_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    default:
      throw new Response("Bad request", { status: 400 });
  }
}

/**
 * The `rename-object` form, done on the server (`renameObjectFromPage`). An
 * object or site that is gone, or a caller with no membership on it, is sent
 * back to the grid, as the delete sends them.
 */
async function renameFromForm(
  env: Env,
  db: ReturnType<typeof getDb>,
  user: { id: number; encrypted_access_token: string },
  formData: FormData,
) {
  const answer = await renameObjectFromPage(env, db, user, {
    objectDbId: Number(formData.get("objectDbId")),
    shownObjectId: String(formData.get("shownObjectId") ?? ""),
    newId: String(formData.get("newId") ?? ""),
    disableSheets: formData.get("disableSheets") === "true",
    confirmedFacts: String(formData.get("confirmedFacts") ?? ""),
  });
  if (answer === "not_found") throw redirect("/objects");
  return answer;
}

// ---------------------------------------------------------------------------
// Delete, on the server
// ---------------------------------------------------------------------------

type ServerDeleteAnswer = { ok: true; pending: boolean } | { ok: false; error: string };

/**
 * A deletion from the Compositor alone: the document half, as an operation
 * of its own (`removeThroughCommittedRecord`).
 */
async function deleteFromDocument(
  env: Env,
  db: ReturnType<typeof getDb>,
  projectId: number,
  actorId: number,
  target: RemovalTarget,
): Promise<ServerDeleteAnswer> {
  return removeThroughCommittedRecord(env, db, projectId, actorId, target);
}

/**
 * A deletion from the repository: the repository half and the document half,
 * under a `remove` record (`deleteObjectWithRecord`).
 *
 * decrypt and the installation-token lookup can throw. They answer
 * `delete_failed` rather than escaping, because an uncaught throw reaches the
 * client as an opaque 500 and the modal reads structured failures only. Both
 * the read and the write run on the installation token: this branch is
 * convenor-only, and the user token is a fallback for the convenor only,
 * matching every other project-repo read and write in this app.
 */
async function deleteFromRepositoryAndDocument(
  env: Env,
  db: ReturnType<typeof getDb>,
  user: { id: number; encrypted_access_token: string },
  resolved: { project: { id: number; github_repo_full_name: string; installation_id: number }; userRole: string },
  target: RemovalTarget,
): Promise<ServerDeleteAnswer> {
  let result: RecordedDeleteResult;
  try {
    const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
    const [owner, repo] = resolved.project.github_repo_full_name.split("/");
    const repoToken = await resolveProjectToken(
      env.GITHUB_APP_ID,
      env.GITHUB_PRIVATE_KEY,
      resolved.project.installation_id,
      token,
      resolved.userRole,
    );
    result = await deleteObjectWithRecord(env, db, resolved.project.id, user.id, {
      readToken: repoToken,
      commitToken: repoToken,
      owner,
      repo,
      objectId: target.object_id,
      d1FrameworkVersion: await readSiteTelarVersion(db, resolved.project.id),
    }, target);
  } catch {
    return { ok: false, error: "delete_failed" };
  }
  if (!result.ok) return result;

  // Recording the head sits outside the commit's failure handling on
  // purpose: the repository WAS updated, and the next commit resolves the
  // head afresh when no override is given, so a bookkeeping failure must not
  // turn a landed commit into delete_failed. The head advances only from the
  // revision the commit was built on: any other parent is a GitHub edit the
  // Compositor has not read, left for the next refresh or check.
  if (result.headSha !== null) {
    try {
      await bumpProjectHeadFrom(db, resolved.project.id, result.parentSha, result.headSha);
    } catch (err) {
      console.error(`delete-object: head bump failed after ${result.headSha}`, err);
    }
  }
  return { ok: true, pending: result.pending };
}

// ---------------------------------------------------------------------------
// Delete answer
// ---------------------------------------------------------------------------

/** The request one of the delete forms made, held until its answer arrives. */
interface DeleteRequest {
  objectDbId: number;
  projectId: number;
  fromRepo: boolean;
}

/** What the `delete-object` action answers, either half. */
type DeleteAnswer =
  | { ok: true; intent: "delete-object"; objectDbId: number; pending?: boolean }
  | { ok: false; error: string; objectDbId: number };

/** What the page does with one answer. */
type DeleteOutcome =
  | { kind: "ignore" }
  | { kind: "message"; key: string }
  | { kind: "leave" };

/**
 * The line a refused delete puts under the modal's description. The forbidden
 * copy names the operation, because the two buttons take two different
 * standings and only one of them is the convenor's alone.
 */
function deleteFailureKey(error: string, fromRepo: boolean): string {
  if (error === "forbidden") {
    return fromRepo ? "delete_forbidden_repo" : "delete_forbidden_compositor";
  }
  if (error === "stale_head") return "delete_stale_head";
  if (error === "course_item_delete_refused") return "course_item_delete_refused";
  if (error === "operation_in_progress") return "delete_operation_in_progress";
  return REPO_WRITE_REFUSAL_KEYS.get(error) ?? "delete_failed";
}

/**
 * Reads one answer against the request that produced it.
 *
 * An answer is acted on only when it belongs to this page's own request, for
 * the object still displayed, in the project it was displayed under; anything
 * else answers a page that has moved on and is ignored.
 *
 * The server has done both halves before it answers, so an accepted delete
 * leaves the page. `pending` is the one accepted answer that stays: the
 * Compositor half is still owed, after the repository half when there was
 * one, and its record finishes it. Which message says so follows the form the
 * page posted.
 */
function readDeleteAnswer(
  answer: DeleteAnswer,
  request: DeleteRequest | null,
  displayed: { id: number; projectId: number },
): DeleteOutcome {
  if (!request) return { kind: "ignore" };
  if (answer.objectDbId !== request.objectDbId) return { kind: "ignore" };
  if (request.objectDbId !== displayed.id) return { kind: "ignore" };
  if (request.projectId !== displayed.projectId) return { kind: "ignore" };

  if (!answer.ok) {
    return { kind: "message", key: deleteFailureKey(answer.error, request.fromRepo) };
  }
  if (answer.pending) {
    return {
      kind: "message",
      key: request.fromRepo ? "delete_document_pending" : "delete_compositor_pending",
    };
  }
  return { kind: "leave" };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ObjectDetailPage({ loaderData }: Route.ComponentProps) {
  const { object, sheetHeader, manifestUrl, infoJsonUrl, isExternal, usedInStories, rename, siteBase, userRole, currentUserId } =
    loaderData;
  const { t } = useTranslation("objects");
  const navigate = useNavigate();

  // The same predicate the delete and rename actions apply, so the page never
  // offers a gesture the server refuses: the convenor, or whoever created
  // this object.
  // The course-item case is handled separately below — a marked object is
  // undeletable for everyone, the convenor included.
  const canDeleteObject =
    userRole === "convenor" || object.created_by === currentUserId;
  const deleteFetcher = useFetcher();
  const dispatchFetcher = useSiteFetcher();
  const featuredFetcher = useFetcher();
  const [featured, setFeatured] = useState(object.featured ?? false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteMessageKey, setDeleteMessageKey] = useState<string | null>(null);
  const [buildModalOpen, setBuildModalOpen] = useState(false);
  const [dispatchRunId, setDispatchRunId] = useState<number | null>(null);
  const [dispatchHtmlUrl, setDispatchHtmlUrl] = useState<string | null>(null);

  const { ydoc } = useCollaborationContext();

  // Resolve Y.Text instances for each editable object field from the Yjs doc
  const objectsArray = ydoc?.getArray<Y.Map<unknown>>("objects") ?? null;
  const objectYMap = objectsArray ? findYMapById(objectsArray, object.id) : null;
  const titleYText = getYText(objectYMap, "title");
  const descriptionYText = getYText(objectYMap, "description");
  const creatorYText = getYText(objectYMap, "creator");
  const periodYText = getYText(objectYMap, "period");
  const yearYText = getYText(objectYMap, "year");
  const objectTypeYText = getYText(objectYMap, "object_type");
  const subjectsYText = getYText(objectYMap, "subjects");
  const sourceYText = getYText(objectYMap, "source");
  const creditYText = getYText(objectYMap, "credit");
  const altTextYText = getYText(objectYMap, "alt_text");

  const mediaType = detectMediaType(object.source_url, object.object_id);
  const isMedia = mediaType === "youtube" || mediaType === "vimeo" || mediaType === "google-drive" || mediaType === "audio";
  const hasExternalManifest = !!(object.source_url && /manifest/.test(object.source_url));
  const status = deriveStatus({
    title: object.title,
    image_available: object.image_available || hasExternalManifest,
    missing_from_repo: object.missing_from_repo,
    skipImageCheck: isMedia,
  });

  const isDeleting = deleteFetcher.state !== "idle";

  // A course item cannot be deleted by anyone while the marker is set, so the
  // page offers no delete affordance at all — the DO would revert it and, on
  // the third attempt in a minute, close the socket.
  const isCourseItem = object.course_project_id != null;

  const isDispatching = dispatchFetcher.state !== "idle";

  // Handle dispatch result — open build modal with run ID
  const dispatchData = dispatchFetcher.data as
    | { ok: true; intent: "dispatch-iiif"; runId: number | null; htmlUrl: string | null }
    | { ok: false; intent: "dispatch-iiif"; error: string }
    | null
    | undefined;

  useEffect(() => {
    if (dispatchData?.ok && dispatchData.intent === "dispatch-iiif") {
      setDispatchRunId(dispatchData.runId);
      setDispatchHtmlUrl(dispatchData.htmlUrl);
      setBuildModalOpen(true);
    }
  }, [dispatchData]);

  // The request the page made, and the answer it has already acted on. The
  // once-guard is the response object's identity: the fetcher hands back the
  // same `data` object across re-renders until the next submission replaces
  // it, so comparing identity is what keeps one answer from being acted on
  // twice.
  const deleteRequestRef = useRef<DeleteRequest | null>(null);
  const handledDeleteAnswerRef = useRef<DeleteAnswer | null>(null);
  const deleteAnswer = deleteFetcher.data as DeleteAnswer | undefined;

  function recordDeleteRequest(fromRepo: boolean) {
    deleteRequestRef.current = {
      objectDbId: object.id,
      projectId: object.project_id,
      fromRepo,
    };
    setDeleteMessageKey(null);
  }

  useEffect(() => {
    if (!deleteAnswer) return;
    if (handledDeleteAnswerRef.current === deleteAnswer) return;

    const outcome = readDeleteAnswer(
      deleteAnswer,
      deleteRequestRef.current,
      { id: object.id, projectId: object.project_id },
    );
    if (outcome.kind === "ignore") return;
    handledDeleteAnswerRef.current = deleteAnswer;

    if (outcome.kind === "message") {
      setDeleteMessageKey(outcome.key);
      return;
    }

    deleteRequestRef.current = null;
    navigate("/objects");
  }, [deleteAnswer, navigate, object.id, object.project_id]);

  function handleGenerateTiles() {
    dispatchFetcher.submit(
      { intent: "dispatch-iiif" },
      { method: "post" },
    );
  }

  function handleFeaturedToggle(checked: boolean) {
    setFeatured(checked);
    // Y.Doc is the source of truth for object metadata; snapshotToD1 reconciles.
    // The D1-only fetcher would be clobbered.
    if (ydoc && objectYMap) {
      ydoc.transact(() => {
        objectYMap.set("featured", checked);
      });
      return;
    }
    featuredFetcher.submit(
      { intent: "autosave-object-featured", entityId: String(object.id), value: String(checked) },
      { method: "post" },
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)]">
      {/* Breadcrumb bar */}
      <div className="flex items-center gap-3 mb-4 shrink-0">
        <Link
          to="/objects"
          className="inline-flex items-center gap-1.5 font-heading text-sm text-gray-500 hover:text-charcoal transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          {t("breadcrumb_objects")}
        </Link>
        <span className="text-gray-300">/</span>
        <span className="font-heading text-sm font-semibold text-charcoal truncate flex-1">
          {object.title || object.object_id}
        </span>
        {isCourseItem ? (
          <span
            className="inline-flex items-center gap-1.5 font-body text-xs rounded-full px-2.5 py-0.5 bg-anil-pale text-anil-ink"
            title={t("course_item_delete_refused")}
          >
            <GraduationCap className="w-3 h-3 shrink-0" />
            {t("course_item_badge")}
          </span>
        ) : canDeleteObject ? (
          // Mirrors the action's predicate, and `canDeleteYMap`'s: the
          // convenor, or whoever created this object.
          <button
            type="button"
            onClick={() => setShowDeleteConfirm(true)}
            className="p-2 rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
            title={t("delete_button")}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        ) : null}
      </div>

      {/* Audio: stacked layout (player top, metadata below) */}
      {isMedia && mediaType === "audio" && (
        <div className="shrink-0 mb-4">
          {siteBase && object.source_url ? (
            <AudioPlayer
              audioUrl={`${siteBase}/telar-content/objects/${object.source_url}`}
            />
          ) : (
            <div className="w-full rounded-lg bg-anil p-6 flex flex-col items-center justify-center gap-2 text-charcoal/50">
              <Music className="w-10 h-10" />
              <p className="font-body text-sm">{t("type_audio")}</p>
            </div>
          )}
        </div>
      )}

      {/* Layout: side-by-side for IIIF/video, full-width for audio */}
      <div className={`flex gap-6 flex-1 min-h-0 ${mediaType === "audio" ? "flex-col" : "flex-col lg:flex-row"}`}>
        {/* Viewer — hidden for audio (shown above), shown for IIIF/video.
            Stacks above the form below lg (no room for side-by-side on a
            phone/tablet-portrait); fixed 50dvh tall when stacked. */}
        {mediaType !== "audio" && (
        <div className="w-full lg:w-3/5 shrink-0 min-h-[50dvh] lg:min-h-0">
          {isMedia && (mediaType === "youtube" || mediaType === "vimeo" || mediaType === "google-drive") && object.source_url ? (
            <div className="w-full h-full rounded-xl bg-cream-dark flex items-center justify-center p-4">
              <VideoEmbed
                type={mediaType}
                videoId={extractVideoId(mediaType, object.source_url) ?? ""}
              />
            </div>
          ) : (
            <IiifViewer
              manifestUrl={manifestUrl}
              infoJsonUrl={infoJsonUrl}
              isSelfHosted={!isExternal}
              alt={object.title ?? object.object_id}
              className="w-full h-full"
              onGenerateTiles={!isExternal ? handleGenerateTiles : undefined}
              isGenerating={isDispatching}
            />
          )}
        </div>
        )}

        {/* Metadata editor */}
        <div className={`overflow-y-auto bg-white rounded-xl border border-gray-100 ${mediaType === "audio" ? "w-full" : "w-full lg:w-2/5 flex-1 lg:flex-none min-h-0"}`}>
          <div className={`p-6 space-y-4 ${mediaType === "audio" ? "columns-2 gap-8 [&>*]:break-inside-avoid [&>hr]:break-after-column" : ""}`}>
              {/* Status badge */}
              <StatusBadge status={status} />

              <ObjectIdField
                objectDbId={object.id}
                objectId={object.object_id}
                canRename={canDeleteObject}
                isCourseItem={isCourseItem}
                facts={rename}
              />

              {/* Title */}
              <div>
                <FieldLabel htmlFor="field-title" required>
                  {t("field_title")}
                </FieldLabel>
                <p className="font-body text-xs text-gray-400 mb-1">{t("field_title_help")}</p>
                <InlineTextField
                  initialValue={object.title ?? ""}
                  yText={titleYText}
                  inputClassName="font-body text-sm text-charcoal"
                  bordered
                  fieldKey={`object-${object.object_id}-title`}
                />
              </div>

              {/* Description */}
              <div>
                <FieldLabel htmlFor="field-description">
                  {t("field_description")}
                </FieldLabel>
                <p className="font-body text-xs text-gray-400 mb-1">{t("field_description_help")}</p>
                <InlineTextArea
                  initialValue={object.description ?? ""}
                  yText={descriptionYText}
                  inputClassName="font-body text-sm text-charcoal"
                  rows={3}
                  bordered
                  fieldKey={`object-${object.object_id}-description`}
                />
              </div>

              {/* Creator */}
              <div>
                <FieldLabel htmlFor="field-creator">
                  {t("field_creator")}
                </FieldLabel>
                <p className="font-body text-xs text-gray-400 mb-1">{t("field_creator_help")}</p>
                <InlineTextField
                  initialValue={object.creator ?? ""}
                  yText={creatorYText}
                  inputClassName="font-body text-sm text-charcoal"
                  bordered
                  fieldKey={`object-${object.object_id}-creator`}
                />
              </div>

              {/* Period + Year */}
              <div className="grid grid-cols-2 gap-3 items-end">
                <div>
                  <FieldLabel htmlFor="field-period">
                    {t("field_period")}
                  </FieldLabel>
                  <p className="font-body text-xs text-gray-400 mb-1">{t("field_period_help")}</p>
                  <InlineTextField
                    initialValue={object.period ?? ""}
                    yText={periodYText}
                    inputClassName="font-body text-sm text-charcoal"
                    bordered
                    fieldKey={`object-${object.object_id}-period`}
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="field-year">
                    {t("field_year")}
                  </FieldLabel>
                  <p className="font-body text-xs text-gray-400 mb-1">{t("field_year_help")}</p>
                  <InlineTextField
                    initialValue={object.year ?? ""}
                    yText={yearYText}
                    inputClassName="font-body text-sm text-charcoal"
                    bordered
                    fieldKey={`object-${object.object_id}-year`}
                  />
                </div>
              </div>

              {/* Object Type */}
              <div>
                <FieldLabel htmlFor="field-object-type">
                  {t("field_object_type")}
                </FieldLabel>
                <p className="font-body text-xs text-gray-400 mb-1">{t("field_object_type_help")}</p>
                <InlineTextField
                  initialValue={object.object_type ?? ""}
                  yText={objectTypeYText}
                  inputClassName="font-body text-sm text-charcoal"
                  bordered
                  fieldKey={`object-${object.object_id}-object_type`}
                />
              </div>

              {/* Subjects */}
              <div>
                <FieldLabel htmlFor="field-subjects">
                  {t("field_subjects")}
                </FieldLabel>
                <p className="font-body text-xs text-gray-400 mb-1">{t("field_subjects_help")}</p>
                <InlineTextField
                  initialValue={object.subjects ?? ""}
                  yText={subjectsYText}
                  inputClassName="font-body text-sm text-charcoal"
                  bordered
                  fieldKey={`object-${object.object_id}-subjects`}
                />
              </div>

              {/* Source */}
              <div>
                <FieldLabel htmlFor="field-source">
                  {t("field_source")}
                </FieldLabel>
                <p className="font-body text-xs text-gray-400 mb-1">{t("field_source_help")}</p>
                <InlineTextField
                  initialValue={object.source ?? ""}
                  yText={sourceYText}
                  inputClassName="font-body text-sm text-charcoal"
                  bordered
                  fieldKey={`object-${object.object_id}-source`}
                />
              </div>

              {/* Credit */}
              <div>
                <FieldLabel htmlFor="field-credit">
                  {t("field_credit")}
                </FieldLabel>
                <p className="font-body text-xs text-gray-400 mb-1">{t("field_credit_help")}</p>
                <InlineTextField
                  initialValue={object.credit ?? ""}
                  yText={creditYText}
                  inputClassName="font-body text-sm text-charcoal"
                  bordered
                  fieldKey={`object-${object.object_id}-credit`}
                />
              </div>

              {/* Source URL — read-only */}
              {object.source_url && (
                <div>
                  <FieldLabel htmlFor="field-source-url">
                    {t("field_source_url")}
                  </FieldLabel>
                  <p
                    id="field-source-url"
                    className="font-body text-sm text-gray-500 bg-gray-100 px-3 py-2 rounded-lg truncate"
                    title={object.source_url}
                  >
                    {object.source_url}
                  </p>
                </div>
              )}

              {/* Featured toggle */}
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="field-featured">
                  {t("field_featured")}
                </FieldLabel>
                <Switch
                  checked={featured}
                  onChange={handleFeaturedToggle}
                  label={t("mark_featured")}
                />
              </div>

              {/* Custom columns of the sheet, in its order */}
              <ObjectCustomFields
                objectDbId={object.id}
                storedBlob={object.extra_columns}
                objectId={object.object_id}
                sheetHeader={sheetHeader}
              />

              {/* Accessibility section */}
              <hr className="border-gray-100 my-4" />
              <h3 className="font-heading font-semibold text-sm text-charcoal mb-1">
                {t("section_accessibility")}
              </h3>
              <p className="font-body text-xs text-gray-500 mb-3">
                {t("field_alt_text_help")}
              </p>
              <div>
                <FieldLabel htmlFor="field-alt-text">
                  {t("field_alt_text")}
                </FieldLabel>
                <InlineTextArea
                  initialValue={object.alt_text ?? ""}
                  yText={altTextYText}
                  placeholder={t("field_alt_text_placeholder")}
                  inputClassName="font-body text-sm text-gray-500"
                  rows={3}
                  bordered
                  fieldKey={`object-${object.object_id}-alt_text`}
                />
              </div>

              {/* Story usage */}
              {usedInStories.length > 0 && (
                <div>
                  <hr className="border-gray-100 my-4" />
                  <h3 className="font-heading font-semibold text-sm text-charcoal mb-1">
                    {t("used_in_stories")}
                  </h3>
                  <ul className="space-y-1">
                    {usedInStories.map((ref: { storyTitle: string | null; stepNumber: number }, i: number) => (
                      <li
                        key={i}
                        className="font-body text-xs text-gray-500 bg-gray-50 px-3 py-1.5 rounded"
                      >
                        {t("used_in_step", { title: ref.storyTitle || t("untitled_story"), step: ref.stepNumber })}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
          </div>

          {/* Delete confirmation modal */}
          {showDeleteConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
              <div className="bg-white rounded-xl shadow-lg p-6 max-w-sm w-full mx-4">
                <h3 className="font-heading font-semibold text-lg text-charcoal mb-2">
                  {t("delete_title")}
                </h3>
                <p className="font-body text-sm text-gray-600 mb-5">
                  {t("delete_description", { title: object.title || object.object_id })}
                </p>
                {deleteMessageKey && (
                  <p className="font-body text-sm text-red-600 mb-5">
                    {t(deleteMessageKey)}
                    {deleteMessageKey === "repo_write_upgrade_required" && (
                      <>
                        {" "}
                        <Link to="/upgrade?from=/objects" className="text-blue-600 hover:underline">
                          {t("upload_upgrade_link")}
                        </Link>
                      </>
                    )}
                  </p>
                )}
                <div className="flex flex-col gap-2">
                  {/* Both forms wait for the answer, which the effect above
                      reads: the server does the whole deletion. */}
                  <>
                      {/* Remove from compositor only */}
                      <deleteFetcher.Form
                        method="post"
                        onSubmit={() => recordDeleteRequest(false)}
                      >
                        <input type="hidden" name="intent" value="delete-object" />
                        <input type="hidden" name="objectDbId" value={object.id} />
                        <button
                          type="submit"
                          disabled={isDeleting}
                          className="w-full font-heading font-semibold text-sm uppercase tracking-wider border border-red-300 text-red-700 rounded-full px-6 py-2.5 hover:bg-red-50 transition-colors disabled:text-fg-disabled"
                        >
                          {t("delete_remove_compositor")}
                        </button>
                      </deleteFetcher.Form>
                      {/* Delete from repo — self-hosted objects only, and the
                          repo cleanup behind it is convenor-only. */}
                      {!isExternal && userRole === "convenor" && (
                        <deleteFetcher.Form
                          method="post"
                          onSubmit={() => recordDeleteRequest(true)}
                        >
                          <input type="hidden" name="intent" value="delete-object" />
                          <input type="hidden" name="objectDbId" value={object.id} />
                          <input type="hidden" name="fromRepo" value="true" />
                          <button
                            type="submit"
                            disabled={isDeleting}
                            className="w-full font-heading font-semibold text-sm uppercase tracking-wider bg-red-500 hover:bg-red-600 text-white rounded-full px-6 py-2.5 transition-colors disabled:bg-disabled disabled:text-fg-disabled"
                          >
                            {t("delete_remove_repo")}
                          </button>
                        </deleteFetcher.Form>
                      )}
                  </>
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(false)}
                    disabled={isDeleting}
                    className="w-full font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-6 py-2.5 hover:bg-cream transition-colors disabled:text-fg-disabled"
                  >
                    {t("delete_cancel")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Build progress modal (tile generation) */}
      <CommitAndBuildModal
        open={buildModalOpen}
        sheetsEnabled={false}
        urlMismatch={null}
        pendingObjects={[]}
        skipCommit={true}
        dispatchRunId={dispatchRunId}
        dispatchHtmlUrl={dispatchHtmlUrl}
        onClose={() => setBuildModalOpen(false)}
        onBuildSuccess={() => {
          setBuildModalOpen(false);
          setDispatchRunId(null);
          setDispatchHtmlUrl(null);
          // Reload to pick up tile availability
          window.location.reload();
        }}
        onBuildFailed={() => {
          setBuildModalOpen(false);
          setDispatchRunId(null);
          setDispatchHtmlUrl(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers (local to this route)
// ---------------------------------------------------------------------------


function FieldLabel({
  htmlFor,
  required,
  children,
}: {
  htmlFor: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="block font-body text-xs font-medium text-gray-600 mb-1"
    >
      {children}
      {required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  );
}

function StatusBadge({
  status,
}: {
  status: ReturnType<typeof deriveStatus>;
}) {
  const { t } = useTranslation("objects");

  const config: Record<
    ReturnType<typeof deriveStatus>,
    { label: string; dotClass: string; badgeClass: string }
  > = {
    ready: {
      label: t("status_ready"),
      dotClass: "bg-green-500",
      badgeClass: "bg-green-50 text-green-700",
    },
    no_metadata: {
      label: t("status_no_metadata"),
      dotClass: "bg-amber-400",
      badgeClass: "bg-amber-50 text-amber-700",
    },
    image_missing: {
      label: t("status_image_missing"),
      dotClass: "bg-gray-400",
      badgeClass: "bg-gray-100 text-gray-600",
    },
    missing_from_repo: {
      label: t("status_missing_from_repo"),
      dotClass: "bg-red-500",
      badgeClass: "bg-red-50 text-red-700",
    },
  };

  const { label, dotClass, badgeClass } = config[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs rounded-full px-2.5 py-0.5 ${badgeClass}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
      {label}
    </span>
  );
}


/**
 * ErrorBoundary — mirrors the story editor's boundary (_app.stories.$storyId.tsx).
 * Without it, a 404 from the loader (an object present in the Y.Array list but
 * not yet snapshotted to D1, or a stranded object) bubbles to the root boundary
 * and renders the whole-app crash screen — and floods the crash buffer for what
 * is normal not-yet-snapshotted navigation. Here we catch it in-shell:
 *   - 404 is the expected transient "not snapshotted yet" state — recoverable,
 *     not reported (reporting would flood the buffer with normal navigation).
 *   - Any non-404 is a real failure — reported via the same recordError the root
 *     boundary uses (browser-only via useEffect), rendered as a generic card.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const { t } = useTranslation("objects");
  const is404 = isRouteErrorResponse(error) && error.status === 404;

  useEffect(() => {
    if (!is404) recordError(error, "boundary");
  }, [error, is404]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white rounded-lg shadow-md p-6 text-center">
        <h1 className="font-heading text-xl font-semibold text-charcoal">
          {is404 ? t("error.not_available_title") : t("error.generic_title")}
        </h1>
        <p className="font-body text-sm text-gray-600 mt-3">
          {is404 ? t("error.not_available_body") : t("error.generic_body")}
        </p>
        <div className="flex gap-3 justify-center mt-6">
          <Link
            to="/objects"
            className="font-heading text-sm uppercase tracking-wider px-4 py-2 rounded text-charcoal bg-gray-100 hover:bg-gray-200 transition-colors"
          >
            {t("error.back_to_objects")}
          </Link>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="font-heading text-sm uppercase tracking-wider px-4 py-2 rounded text-white bg-terracotta hover:bg-terracotta/90 transition-colors"
          >
            {t("error.retry")}
          </button>
        </div>
      </div>
    </div>
  );
}
