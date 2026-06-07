/**
 * This file is the Upgrade route — surfaces version info, release
 * notes, and the file-change summary the user sees before clicking
 * Upgrade. The button commits framework files atomically against
 * the user's repo.
 *
 * Loader fetches the latest framework release and computes the
 * upgrade diff between the user's repo and that release.
 *
 * Action handles three intents:
 *   - `upgrade` — commits framework files atomically, updates D1
 *   - `poll-build` — polls GitHub Actions for build progress
 *   - `compute-diff` — recomputes the diff (refresh / retry)
 *
 * Renders a 4-stage state machine — review | upgrading | building |
 * done.
 *
 * @version v1.3.0-beta
 */

import { redirect, useFetcher } from "react-router";
import { eq } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useIsConvenor } from "~/hooks/use-role";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Database,
  ExternalLink,
  FileCode,
  FileText,
  GitBranch,
  Loader2,
  Palette,
  Terminal,
  XCircle,
} from "lucide-react";
import type { Route } from "./+types/_app.upgrade";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { projects, project_config } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { decrypt } from "~/lib/crypto.server";
import { getRepoTree, getRepoHead, getFileContent } from "~/lib/github.server";
import { requireOwner, resolveActiveProject } from "~/lib/membership.server";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import {
  fetchLatestRelease,
  fetchAllReleases,
  computeUpgradeDiff,
  updateTelarVersionInConfig,
  compareVersions,
  checkTelarVersion,
  MIN_SUPPORTED_VERSION,
  categorizeFrameworkPath,
  loadManifestChain,
  collectFilesReferencedByChain,
} from "~/lib/upgrade.server";
import type { UpgradeDiff, TelarRelease, UpgradeSummary } from "~/lib/upgrade.server";
import { applyManifestChain } from "~/lib/manifest-runner.server";
import type { ManifestApplyResult } from "~/lib/manifest-runner.server";
import { applyV130Transforms } from "~/lib/v130-ingest.server";
import type { V130IngestResult } from "~/lib/v130-ingest.server";
import type { Manifest, ManualStep } from "~/lib/manifest-schema.server";
import {
  commitFilesToRepo,
  listWorkflowRunsBySha,
  getJobSteps,
  mapStepsToBuildPhases,
  StaleHeadError,
} from "~/lib/commit.server";
import { getInstallationToken } from "~/lib/github-app.server";
import type { BuildPhaseStatus } from "~/lib/commit.server";
import { bumpProjectHead } from "~/lib/github-status.server";
import { marked, Renderer } from "marked";
import { sanitiseHtml } from "~/lib/sanitise-html";
import { Button } from "~/components/ui/Button";

export const handle = { i18n: ["common", "upgrade", "team"] };

// ---------------------------------------------------------------------------
// Build phases — mirrors commit.server.ts BUILD_PHASES (no server import)
// ---------------------------------------------------------------------------

const BUILD_PHASE_IDS = [
  "setup",
  "build-js",
  "process-data",
  "build-site",
  "iiif",
  "deploy",
] as const;

type BuildPhaseId = typeof BUILD_PHASE_IDS[number];

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
  if (!resolved) {
    // No active project — onboarding, not /dashboard (which loops via /objects).
    throw redirect("/onboarding");
  }
  const { project: activeProject } = resolved;

  const configRows = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, activeProject.id))
    .limit(1);
  const config = configRows[0] ?? null;
  const siteVersion = config?.telar_version ?? null;

  const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
  const [owner, repo] = activeProject.github_repo_full_name.split("/");

  // Check minimum version support
  const siteTag = siteVersion
    ? siteVersion.startsWith("v") ? siteVersion : `v${siteVersion}`
    : null;
  const isBelowMinimum = siteTag
    ? compareVersions(siteTag, MIN_SUPPORTED_VERSION) < 0
    : false;

  try {
    // The three independent GitHub calls (latest release, user's repo tree,
    // user's _config.yml) fan out in parallel. Previously these were
    // sequential, which pushed cold page loads past 5 seconds and users
    // perceived the page as frozen. Promise.all cuts the cold load to
    // roughly the slowest single call (~2-3s for getRepoTree on large repos).
    const [latestRelease, treeResult, configContent] = await Promise.all([
      fetchLatestRelease(token),
      getRepoTree(token, owner, repo),
      getFileContent(token, owner, repo, "_config.yml"),
    ]);
    const { tree: userTree } = treeResult;

    // Fetch release notes for all versions newer than current site version.
    // Runs in parallel with computeUpgradeDiff because they share no state.
    //
    // computeUpgradeDiff is called with fetchContent:false — the review page
    // only needs paths and categories. Content for the commit is fetched
    // later inside runUpgradePrepare when the user clicks Upgrade. Skipping
    // content here avoids N sequential GitHub API calls (50-100+ on a full
    // framework upgrade) that previously dominated page load time.
    const [allReleasesData, diff] = await Promise.all([
      siteTag && compareVersions(siteTag, latestRelease.tagName) < 0
        ? fetchAllReleases(token)
        : Promise.resolve(null),
      computeUpgradeDiff(token, userTree, latestRelease.tagName, { fetchContent: false }),
    ]);

    let releaseNotes: string = latestRelease.body;
    let releaseCount = 1;
    if (allReleasesData) {
      const newerReleases = allReleasesData.filter(
        (r) => siteTag ? compareVersions(r.tagName, siteTag) > 0 : true,
      );
      releaseCount = newerReleases.length;
      if (newerReleases.length > 1) {
        releaseNotes = newerReleases
          .map((r) => `## ${r.tagName}\n\n${r.body}`)
          .join("\n\n---\n\n");
      }
    }

    // Check the actual repo version — D1 may be stale if a previous upgrade
    // committed successfully but the D1 update failed.
    let effectiveVersion = siteTag;
    if (configContent) {
      const versionMatch = configContent.match(/^\s*version:\s*["']?([^\s"'#]+)/m);
      if (versionMatch) {
        const repoVersion = versionMatch[1].startsWith("v") ? versionMatch[1] : `v${versionMatch[1]}`;
        if (effectiveVersion && compareVersions(repoVersion, effectiveVersion) > 0) {
          // Repo is ahead of D1 — heal D1 silently
          effectiveVersion = repoVersion;
          try {
            const now = new Date().toISOString();
            await db
              .update(project_config)
              .set({ telar_version: repoVersion.replace(/^v/, ""), updated_at: now })
              .where(eq(project_config.project_id, activeProject.id));
          } catch {
            // Best-effort D1 heal
          }
        }
      }
    }

    const needsUpgrade = effectiveVersion
      ? compareVersions(effectiveVersion, latestRelease.tagName) < 0
      : false;

    // If the repo is already up to date (e.g. D1 was stale), redirect away
    if (!needsUpgrade && !isBelowMinimum) {
      const url = new URL(request.url);
      const from = url.searchParams.get("from");
      throw redirect(from ?? "/objects");
    }

    // Convert markdown release notes to HTML (with heading IDs for anchor links)
    const renderer = new Renderer();
    // Defence-in-depth: even though the slug regex below restricts characters
    // to letters/digits/hyphens, escape the value before inlining it into an
    // attribute so a future regex change can't open an injection path.
    const escapeAttr = (s: string) =>
      s.replace(
        /[&<>"']/g,
        (c) =>
          ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
      );
    renderer.heading = ({ text, depth }: { text: string; depth: number }) => {
      const slug = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-").trim();
      return `<h${depth} id="${escapeAttr(slug)}">${text}</h${depth}>`;
    };
    // Sanitise marked output before it reaches
    // dangerouslySetInnerHTML. Heading IDs from the custom Renderer above
    // survive sanitisation because the sanitiser allowlist permits id on h1-h6.
    const releaseNotesHtml = sanitiseHtml(
      (await marked.parse(releaseNotes, { async: false, gfm: true, renderer })) as string,
    );

    // Group file paths by category for the expandable file list
    const filesByCategory: Record<string, string[]> = {};
    for (const file of diff.additions) {
      const cat = categorizeFrameworkPath(file.path);
      (filesByCategory[cat] ??= []).push(file.path);
    }
    if (diff.deletions.length > 0) {
      filesByCategory.deletions = diff.deletions;
    }

    return {
      siteVersion,
      latestRelease,
      releaseNotes: releaseNotesHtml as string,
      releaseCount,
      diff,
      filesByCategory,
      configContent: configContent ?? "",
      isBelowMinimum,
      needsUpgrade,
      googleSheetsEnabled: Boolean(config?.google_sheets_enabled),
      project: {
        id: activeProject.id,
        github_pages_url: activeProject.github_pages_url,
        github_repo_full_name: activeProject.github_repo_full_name,
      },
    };
  } catch (err) {
    // React Router throws Response objects for redirects and explicit
    // status responses — re-throw so the framework can act on them.
    if (err instanceof Response) throw err;
    // GitHub API unavailable — show minimal page
    console.error("Upgrade loader error:", err);
    return {
      siteVersion,
      latestRelease: null,
      releaseNotes: "",
      releaseCount: 0,
      diff: null,
      configContent: "",
      isBelowMinimum,
      needsUpgrade: false,
      googleSheetsEnabled: Boolean(config?.google_sheets_enabled),
      project: {
        id: activeProject.id,
        github_pages_url: activeProject.github_pages_url,
        github_repo_full_name: activeProject.github_repo_full_name,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
  if (!resolved) {
    return { ok: false, intent, error: "no_project" };
  }
  const { project: activeProject } = resolved;

  // Guard: only owners may upgrade
  await requireOwner(db, activeProject.id, user.id);

  const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
  const [owner, repo] = activeProject.github_repo_full_name.split("/");

  // runUpgradePrepare — collects everything needed to commit the upgrade:
  // framework tree-diff, manifest chain, referenced file contents, and the
  // expected HEAD OID. All network I/O happens here; the returned prepared
  // state is safe to round-trip through the client (owners could always edit
  // their own repos anyway, so no tamper risk model is violated).
  async function runUpgradePrepare(): Promise<
    | { ok: true; prepared: PreparedUpgrade }
    | { ok: false; error: string; message?: string }
  > {
    try {
      const latestRelease = await fetchLatestRelease(token);
      const { tree: userTree } = await getRepoTree(token, owner, repo);
      // Capture HEAD OID here; pass to commitFilesToRepo below to
      // prevent a second upgrade path (e.g. GitHub Actions, another client)
      // from racing this commit.
      const expectedHeadOid = await getRepoHead(token, owner, repo, "main");
      const diff = await computeUpgradeDiff(token, userTree, latestRelease.tagName);

      const configContent = await getFileContent(token, owner, repo, "_config.yml");
      if (!configContent) {
        return {
          ok: false,
          error: "upgrade_failed",
          message:
            "_config.yml not found — upgrade requires a valid site configuration.",
        };
      }

      const releaseDate = latestRelease.publishedAt.slice(0, 10);
      // The framework's _config.yml convention is `version: "X.Y.Z"` without
      // the "v" prefix — matches historical migration.json from/to values, D1
      // storage, and the manual scripts/upgrade.py writer. latestRelease.tagName
      // carries the GitHub tag format ("v1.2.0"); strip the leading v before
      // writing into the telar block. (Previous behaviour wrote "v1.2.0"
      // into _config.yml, diverging from the convention.)
      const patchedConfig = updateTelarVersionInConfig(
        configContent,
        latestRelease.tagName.replace(/^v/, ""),
        releaseDate,
      );

      const configRows = await db
        .select({ telar_version: project_config.telar_version })
        .from(project_config)
        .where(eq(project_config.project_id, activeProject.id))
        .limit(1);
      const oldVersion = configRows[0]?.telar_version ?? "unknown";

      // Exact-string-equality chain discovery — normalise both sides.
      const fromVersion = (oldVersion ?? "").replace(/^v/, "");
      const toVersion = latestRelease.tagName.replace(/^v/, "");

      let manifestChain: Manifest[];
      try {
        manifestChain = await loadManifestChain(token, fromVersion, toVersion);
      } catch (err) {
        // Missing release-asset manifest — fail closed, no commit.
        console.error(
          `[runUpgradePrepare] loadManifestChain failed (${fromVersion} -> ${toVersion}):`,
          err,
        );
        return {
          ok: false,
          error: "missing_manifest",
          message: err instanceof Error ? err.message : "Missing migration manifest",
        };
      }

      const langMatch = patchedConfig.match(/^\s*telar_language:\s*["']?([a-z]{2})/m);
      const language: "en" | "es" = langMatch?.[1] === "es" ? "es" : "en";

      // BLOCKER fix: seed _config.yml with patchedConfig (version-bumped),
      // NOT configContent (pre-upgrade). The manifest runner's output therefore
      // carries BOTH the telar.version bump AND the DSL transforms.
      const manifestFiles = new Map<string, string>();
      manifestFiles.set("_config.yml", patchedConfig);

      const referenced = collectFilesReferencedByChain(manifestChain);
      for (const path of referenced) {
        if (manifestFiles.has(path)) continue;
        const content = await getFileContent(token, owner, repo, path);
        if (content !== null) manifestFiles.set(path, content);
      }

      let manifestResult: ManifestApplyResult;
      try {
        manifestResult = applyManifestChain(manifestChain, manifestFiles, language);
      } catch (err) {
        // Runner scope allowlist or other runtime error — fail closed.
        console.error(
          `[runUpgradePrepare] applyManifestChain failed (${fromVersion} -> ${toVersion}):`,
          err,
        );
        return {
          ok: false,
          error: "manifest_failed",
          message: err instanceof Error ? err.message : "Manifest application failed",
        };
      }

      // v1.3.0 ingest: when target version >= 1.3.0, run
      // bespoke transforms over the same virtual filesystem. v1.3.0's release
      // manifest is operations:[] — the Python reference migration's three
      // conditional transforms (A/B/C) live in v130-ingest.server.ts.
      //
      // Use compareVersions, not string compare. compareVersions
      // strips the "v" prefix internally but expects parseable input.
      let v130Result: V130IngestResult | null = null;
      if (compareVersions(`v${toVersion}`, "v1.3.0") >= 0) {
        // Preload the four content files (plus the acerca.md probe) into the
        // Map. collectFilesReferencedByChain does NOT enumerate these for the
        // bespoke transforms — preload here. Missing files (404 → null) leave
        // the Map slot empty; Transform A returns { changed:false, reason:
        // "missing" }. The user OAuth token works for user-repo reads.
        for (const path of [
          "index.md",
          "pages/glossary.md",
          "pages/objects.md",
          "telar-content/texts/pages/about.md",
          "telar-content/texts/pages/acerca.md",
        ]) {
          if (!manifestResult.files.has(path)) {
            const content = await getFileContent(token, owner, repo, path);
            if (content !== null) manifestResult.files.set(path, content);
          }
        }
        v130Result = await applyV130Transforms(manifestResult.files, language);
        // v130Result.files === manifestResult.files (mutated in place); the
        // additions merge below picks up Transform A replacements + Transform
        // C's silent acerca.md creation automatically.
        if (v130Result.changes.length > 0) {
          console.log(
            `[runUpgradePrepare] v130 ingest applied ${v130Result.changes.length} change(s):`,
            v130Result.changes,
          );
        }
      }

      // Merge additions: framework tree-diff first, then manifest-runner output
      // overwrites on path conflict (version-bumped _config.yml is preserved).
      const additionsMap = new Map<string, string>();
      for (const add of diff.additions) additionsMap.set(add.path, add.content);
      for (const [path, content] of manifestResult.files.entries()) {
        additionsMap.set(path, content);
      }
      const mergedAdditions = Array.from(additionsMap.entries()).map(
        ([path, content]) => ({ path, content }),
      );

      const mergedDeletions = Array.from(
        new Set([...(diff.deletions ?? []), ...manifestResult.deletions]),
      );

      return {
        ok: true,
        prepared: {
          additions: mergedAdditions,
          deletions: mergedDeletions,
          expectedHeadOid,
          commitMessage: `Upgrade Telar from ${oldVersion} to ${toVersion}`,
          commitBody: `Upgraded via Telar Compositor\n\nSee release notes: https://github.com/UCSB-AMPLab/telar/releases/tag/${latestRelease.tagName}`,
          newVersion: latestRelease.tagName,
          toVersion,
          manualSteps: manifestResult.manualSteps,
          installationId: activeProject.installation_id,
        },
      };
    } catch (err) {
      console.error("[runUpgradePrepare] unhandled error:", err);
      return {
        ok: false,
        error: "upgrade_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      };
    }
  }

  // runUpgradeCommit — takes a prepared upgrade payload and performs the
  // installation-token commit + D1 updates. StaleHeadError surfaces as a
  // typed error so the client can offer re-sync.
  async function runUpgradeCommit(prepared: PreparedUpgrade): Promise<
    | {
        ok: true;
        newHeadSha: string;
        newVersion: string;
        owner: string;
        repo: string;
        manualSteps: ManualStep[];
      }
    | { ok: false; error: string; message?: string; reauthUrl?: string }
  > {
    try {
      const installToken = await getInstallationToken(
        env.GITHUB_APP_ID,
        env.GITHUB_PRIVATE_KEY,
        prepared.installationId,
      );

      const result = await commitFilesToRepo(
        installToken,
        owner,
        repo,
        "main",
        prepared.additions,
        prepared.commitMessage,
        prepared.commitBody,
        prepared.deletions,
        undefined, // skipCi
        prepared.expectedHeadOid,
      );

      const newHeadSha = result.newHeadSha;
      const now = new Date().toISOString();

      // Commit already landed; D1 failure must not report upgrade_failed.
      try {
        await db
          .update(project_config)
          .set({ telar_version: prepared.toVersion, updated_at: now })
          .where(eq(project_config.project_id, activeProject.id));
        await bumpProjectHead(db, activeProject.id, newHeadSha);
      } catch (d1Err) {
        console.error("D1 update after upgrade commit failed:", d1Err);
      }

      // The cleanProjectLanding helper was removed 2026-05-11 in favour of a
      // display-layer treatment in `_app.homepage.tsx`'s loader: it surfaces
      // the lang-pack canned text whenever landing.welcome_body is empty,
      // the v1.3.0 liquid block, or the legacy v1.2.1 English literal. The publish
      // (publish defensive gate) still prevents stale D1 from re-emitting
      // English on the next publish. Import liquid-block recognition
      // keeps D1 clean on natural re-sync after upgrade. Publish-time leak closure
      // on the live site comes from the v1.3.0 framework upgrade itself.
      return {
        ok: true,
        newHeadSha,
        newVersion: prepared.newVersion,
        owner,
        repo,
        manualSteps: prepared.manualSteps,
      };
    } catch (err) {
      if (err instanceof StaleHeadError) {
        console.error("[runUpgradeCommit] stale head:", err.message);
        return { ok: false, error: "stale_head" };
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      // GitHub returns "Resource not accessible by integration" when the App
      // lacks a permission required for the commit (e.g. workflows: write).
      // Surface a targeted error with a per-install re-auth URL so the client
      // can route the user to the permissions review screen instead of a
      // generic failure.
      if (message.includes("Resource not accessible by integration")) {
        return {
          ok: false,
          error: "insufficient_permissions",
          reauthUrl: `https://github.com/settings/installations/${prepared.installationId}/permissions`,
        };
      }
      console.error("[runUpgradeCommit] unhandled error:", err);
      return {
        ok: false,
        error: "upgrade_failed",
        message,
      };
    }
  }

  // Owner gate — enforced above via requireOwner(). No spoofable path.
  switch (intent) {
    case "upgrade-prepare": {
      const res = await runUpgradePrepare();
      if (!res.ok) return { ok: false, intent: "upgrade-prepare", error: res.error, message: res.message };
      return { ok: true, intent: "upgrade-prepare", prepared: res.prepared };
    }

    case "upgrade-commit": {
      const preparedJson = formData.get("preparedState") as string | null;
      if (!preparedJson) {
        return { ok: false, intent: "upgrade-commit", error: "missing_prepared_state" };
      }
      let prepared: PreparedUpgrade;
      try {
        prepared = JSON.parse(preparedJson) as PreparedUpgrade;
      } catch {
        return { ok: false, intent: "upgrade-commit", error: "invalid_prepared_state" };
      }
      const res = await runUpgradeCommit(prepared);
      if (!res.ok) return { ok: false, intent: "upgrade-commit", error: res.error, message: res.message, reauthUrl: res.reauthUrl };
      const { newHeadSha, newVersion, manualSteps } = res;
      return { ok: true, intent: "upgrade-commit", newHeadSha, newVersion, owner, repo, manualSteps };
    }

    // Legacy single-shot upgrade — preserved so existing tests still exercise
    // the full pipeline through one intent. The client uses the split pair
    // (upgrade-prepare + upgrade-commit) to drive the two-step progress UI.
    case "upgrade": {
      const prep = await runUpgradePrepare();
      if (!prep.ok) return { ok: false, intent: "upgrade", error: prep.error, message: prep.message };
      const res = await runUpgradeCommit(prep.prepared);
      if (!res.ok) return { ok: false, intent: "upgrade", error: res.error, message: res.message, reauthUrl: res.reauthUrl };
      const { newHeadSha, newVersion, manualSteps } = res;
      return { ok: true, intent: "upgrade", newHeadSha, newVersion, owner, repo, manualSteps };
    }

    case "poll-build": {
      const sha = formData.get("sha") as string | null;
      const runIdParam = formData.get("runId") as string | null;

      if (!sha) {
        return { ok: false, intent: "poll-build", error: "missing_sha" };
      }

      try {
        const runs = await listWorkflowRunsBySha(token, owner, repo, sha);

        if (runs.length === 0) {
          return {
            ok: true,
            intent: "poll-build",
            buildStatus: "pending",
            buildConclusion: null,
            buildUrl: null,
            runId: null,
            phases: null,
          };
        }

        const run = runs[0];

        if (runIdParam) {
          const jobSteps = await getJobSteps(token, owner, repo, Number(runIdParam));
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
        }

        return {
          ok: true,
          intent: "poll-build",
          buildStatus: run.status,
          buildConclusion: run.conclusion,
          buildUrl: run.html_url,
          runId: run.id,
          phases: null,
        };
      } catch (err) {
        return {
          ok: false,
          intent: "poll-build",
          error: "poll_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    case "compute-diff": {
      // Re-fetch diff for refresh/retry
      try {
        const latestRelease = await fetchLatestRelease(token);
        const { tree: userTree } = await getRepoTree(token, owner, repo);
        const diff = await computeUpgradeDiff(token, userTree, latestRelease.tagName);
        return { ok: true, intent: "compute-diff", diff, latestRelease };
      } catch (err) {
        return {
          ok: false,
          intent: "compute-diff",
          error: "compute_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
    }

    default:
      return { ok: false, intent, error: "unknown_intent" };
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PreparedUpgrade {
  additions: Array<{ path: string; content: string }>;
  deletions: string[];
  expectedHeadOid: string;
  commitMessage: string;
  commitBody: string;
  newVersion: string;
  toVersion: string;
  manualSteps: ManualStep[];
  installationId: number;
}

type UpgradeActionData =
  | { ok: true; intent: "upgrade"; newHeadSha: string; newVersion: string; owner: string; repo: string; manualSteps: ManualStep[] }
  | { ok: false; intent: "upgrade"; error: string; message?: string; reauthUrl?: string }
  | { ok: true; intent: "upgrade-prepare"; prepared: PreparedUpgrade }
  | { ok: false; intent: "upgrade-prepare"; error: string; message?: string }
  | { ok: true; intent: "upgrade-commit"; newHeadSha: string; newVersion: string; owner: string; repo: string; manualSteps: ManualStep[] }
  | { ok: false; intent: "upgrade-commit"; error: string; message?: string; reauthUrl?: string }
  | { ok: true; intent: "poll-build"; buildStatus: string; buildConclusion: string | null; buildUrl: string | null; runId: number | null; phases: BuildPhaseStatus[] | null }
  | { ok: false; intent: "poll-build"; error: string; message?: string }
  | { ok: true; intent: "compute-diff"; diff: UpgradeDiff; latestRelease: TelarRelease }
  | { ok: false; intent: "compute-diff"; error: string; message?: string }
  | { ok: false; intent: string; error: string }
  | null
  | undefined;

type UpgradeStage = "review" | "upgrading" | "building" | "done";
type UpgradeSubStage = "preparing" | "committing";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function VersionBadge({ label, version, variant }: { label: string; version: string; variant: "current" | "target" }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="font-body text-xs text-gray-500 uppercase tracking-wider">{label}</span>
      <span
        className={`font-heading font-semibold text-sm px-4 py-1.5 rounded-full ${
          variant === "target"
            ? "bg-terracotta text-cream"
            : "bg-cream-dark text-charcoal"
        }`}
      >
        {version}
      </span>
    </div>
  );
}

function PhaseCircle({ phase }: { phase: BuildPhaseStatus }) {
  if (phase.status === "in_progress") {
    return (
      <div className="w-8 h-8 rounded-full flex items-center justify-center bg-blue-100">
        <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
      </div>
    );
  }
  if (phase.status === "completed") {
    if (phase.conclusion === "failure") {
      return (
        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-red-100">
          <XCircle className="w-4 h-4 text-red-600" />
        </div>
      );
    }
    if (phase.conclusion === "skipped") {
      return (
        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-gray-50">
          <span className="text-gray-300 font-heading font-semibold text-sm">–</span>
        </div>
      );
    }
    return (
      <div className="w-8 h-8 rounded-full flex items-center justify-center bg-green-100">
        <CheckCircle2 className="w-4 h-4 text-green-600" />
      </div>
    );
  }
  // queued
  return (
    <div className="w-8 h-8 rounded-full flex items-center justify-center bg-gray-100">
      <span className="font-heading font-semibold text-xs text-gray-400">
        {BUILD_PHASE_IDS.findIndex((id) => id === phase.id) + 1}
      </span>
    </div>
  );
}

function connectorClass(phase: BuildPhaseStatus): string {
  if (phase.status === "completed" && phase.conclusion !== "failure") return "bg-green-300";
  if (phase.status === "in_progress") return "bg-blue-200";
  return "bg-gray-200";
}

const CATEGORY_ICONS = {
  layouts: FileCode,
  includes: FileText,
  stylesheets: Palette,
  scripts: Terminal,
  workflows: GitBranch,
  dataFiles: Database,
  other: FileText,
} as const;

function CategoryCard({
  icon: Icon,
  label,
  count,
  countLabel,
  files,
  variant = "default",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
  countLabel: string;
  files: string[];
  variant?: "default" | "danger";
}) {
  const [open, setOpen] = useState(false);
  const bg = variant === "danger" ? "bg-red-50" : "bg-cream-dark";
  const iconColor = variant === "danger" ? "text-red-400" : "text-terracotta";

  return (
    <div className={`${bg} rounded-lg overflow-hidden`}>
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:opacity-80 transition-opacity"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon className={`w-4 h-4 ${iconColor} shrink-0`} />
        <div className="min-w-0 flex-1">
          <p className="font-heading font-semibold text-xs text-charcoal leading-tight">
            {label}
          </p>
          <p className="font-body text-xs text-gray-500">{countLabel}</p>
        </div>
        <ChevronDown className={`w-3 h-3 text-gray-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && files.length > 0 && (
        <div className="px-3 pb-2">
          <ul className="font-body text-xs text-gray-600 space-y-0.5">
            {files.map((f) => (
              <li key={f} className="truncate" title={f}>
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function HintBox({ title, body }: { title: string; body: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 bg-cream-dark hover:bg-gray-50 transition-colors text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-heading font-semibold text-sm text-charcoal">{title}</span>
        {open ? (
          <ChevronUp className="w-4 h-4 text-gray-500 shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-gray-500 shrink-0" />
        )}
      </button>
      {open && (
        <div className="px-4 py-3 bg-white">
          <p className="font-body text-sm text-gray-700">{body}</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function UpgradePage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("upgrade");
  const [searchParams] = useSearchParams();
  const fromPath = searchParams.get("from");

  // Role read via the typed loader hook (replaces the ad-hoc useRouteLoaderData
  // cast). Collaborators are redirected away from /upgrade by the routes/_app
  // loader guard (→ /objects?denied=upgrade), so this don't-render is
  // belt-and-braces — a collaborator never reaches this component. Render-gating
  // is a UX layer only; the upgrade action stays convenor-gated server-side.
  const isConvenor = useIsConvenor();

  const {
    siteVersion,
    latestRelease,
    releaseNotes,
    releaseCount,
    diff,
    filesByCategory,
    isBelowMinimum,
    needsUpgrade,
    googleSheetsEnabled,
    project,
  } = loaderData;

  // Filter post-upgrade manual steps to those relevant for compositor users.
  // Rules:
  //   - no audience / "all"          → show
  //   - "compositor"                  → show
  //   - "google-sheets"               → show only if the site has GS enabled
  //   - "local"                       → hide (covered automatically by compositor)
  function isStepVisible(step: ManualStep): boolean {
    const a = step.audience;
    if (!a || a === "all" || a === "compositor") return true;
    if (a === "google-sheets") return googleSheetsEnabled;
    return false; // "local"
  }

  if (!isConvenor) return null;

  const { provider } = useCollaborationContext();

  const upgradeFetcher = useFetcher();
  const pollFetcher = useFetcher();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [stage, setStage] = useState<UpgradeStage>("review");
  const [upgradeSubStage, setUpgradeSubStage] = useState<UpgradeSubStage | null>(null);
  const [upgradeSha, setUpgradeSha] = useState<string | null>(null);
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [buildConclusion, setBuildConclusion] = useState<string | null>(null);
  const [buildUrl, setBuildUrl] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [phases, setPhases] = useState<BuildPhaseStatus[] | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [reauthUrl, setReauthUrl] = useState<string | null>(null);
  const [manualSteps, setManualSteps] = useState<ManualStep[]>([]);

  const upgradeData = upgradeFetcher.data as UpgradeActionData;
  const pollData = pollFetcher.data as UpgradeActionData;

  // Handle upgrade response: two-step flow — prepare response triggers commit,
  // commit response advances to the building stage. Legacy "upgrade" intent
  // (tests) still short-circuits straight to building.
  useEffect(() => {
    if (!upgradeData) return;

    if (upgradeData.ok && upgradeData.intent === "upgrade-prepare") {
      setUpgradeSubStage("committing");
      upgradeFetcher.submit(
        {
          intent: "upgrade-commit",
          preparedState: JSON.stringify(upgradeData.prepared),
        },
        { method: "post" },
      );
      return;
    }

    if (
      upgradeData.ok &&
      (upgradeData.intent === "upgrade-commit" || upgradeData.intent === "upgrade")
    ) {
      setUpgradeSha(upgradeData.newHeadSha);
      setNewVersion(upgradeData.newVersion);
      setManualSteps(
        Array.isArray(upgradeData.manualSteps) ? upgradeData.manualSteps : [],
      );
      setUpgradeSubStage(null);
      setStage("building");
      return;
    }

    if (
      !upgradeData.ok &&
      (upgradeData.intent === "upgrade-prepare" ||
        upgradeData.intent === "upgrade-commit" ||
        upgradeData.intent === "upgrade")
    ) {
      setStage("review");
      setUpgradeSubStage(null);
      if (upgradeData.error === "stale_head") {
        setUpgradeError("stale_head");
        setReauthUrl(null);
      } else if (upgradeData.error === "insufficient_permissions") {
        setUpgradeError("insufficient_permissions");
        setReauthUrl(
          "reauthUrl" in upgradeData && upgradeData.reauthUrl
            ? upgradeData.reauthUrl
            : null,
        );
      } else {
        setUpgradeError("upgrade_failed");
        setReauthUrl(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upgradeData]);

  // Handle poll responses
  useEffect(() => {
    if (!pollData?.ok || pollData.intent !== "poll-build") return;
    if (pollData.buildUrl) setBuildUrl(pollData.buildUrl);
    if (pollData.runId != null) setRunId(pollData.runId);
    if (pollData.phases) setPhases(pollData.phases);
    if (pollData.buildStatus === "completed") {
      setBuildConclusion(pollData.buildConclusion);
      setStage("done");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollData]);

  // Polling effect
  useEffect(() => {
    if (stage !== "building" || !upgradeSha) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    function doPoll() {
      const formData: Record<string, string> = { intent: "poll-build", sha: upgradeSha! };
      if (runId != null) formData.runId = String(runId);
      pollFetcher.submit(formData, { method: "post" });
    }

    doPoll();
    intervalRef.current = setInterval(doPoll, 5000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, upgradeSha, runId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Broadcast upgrade state to all connected clients via Yjs
  // awareness. Collaborators see a freeze modal driven by state.upgrading;
  // error state surfaces a dismissable error modal.
  //
  // This broadcast is owner-only in practice because the routes/_app
  // loader guard redirects non-convenors away from /upgrade. Even if a
  // collaborator spoofed upgrading=true elsewhere, the commit itself is
  // server-gated by the role check in this route's action.
  useEffect(() => {
    if (!provider) return;
    const isActive = stage === "upgrading" || stage === "building";
    provider.awareness.setLocalStateField("upgrading", isActive);
    provider.awareness.setLocalStateField("upgradeError", upgradeError !== null);
    return () => {
      // Clear fields on unmount so an aborted upgrade does not leave the modal
      // stuck for peers.
      provider.awareness.setLocalStateField("upgrading", false);
      provider.awareness.setLocalStateField("upgradeError", false);
    };
  }, [stage, upgradeError, provider]);

  function handleUpgrade() {
    setUpgradeError(null);
    setReauthUrl(null);
    setStage("upgrading");
    setUpgradeSubStage("preparing");
    upgradeFetcher.submit({ intent: "upgrade-prepare" }, { method: "post" });
  }

  function handleRetry() {
    setStage("review");
    setUpgradeError(null);
    setReauthUrl(null);
    setUpgradeSha(null);
    setNewVersion(null);
    setBuildConclusion(null);
    setBuildUrl(null);
    setRunId(null);
    setPhases(null);
  }

  // Build phase labels (i18n)
  const phaseLabels: Record<BuildPhaseId, string> = {
    "setup": t("phase_label_setup"),
    "build-js": t("phase_label_build_js"),
    "process-data": t("phase_label_process_data"),
    "build-site": t("phase_label_build_site"),
    "iiif": t("phase_label_iiif_tiles"),
    "deploy": t("phase_label_deploy"),
  };

  // Build phase display
  const displayPhases: BuildPhaseStatus[] =
    phases ??
    BUILD_PHASE_IDS.map((id) => ({
      id,
      label: phaseLabels[id],
      status: "queued" as const,
      conclusion: null,
    }));

  // Post-upgrade navigation target
  function getContinueButton() {
    if (!fromPath) return null;
    if (fromPath === "/publish" || fromPath.startsWith("/publish")) {
      return (
        <Link to="/publish">
          <Button variant="primary" type="button">{t("continueToPublish")}</Button>
        </Link>
      );
    }
    if (fromPath === "/objects" || fromPath.startsWith("/objects")) {
      return (
        <Link to="/objects">
          <Button variant="primary" type="button">{t("continueToSync")}</Button>
        </Link>
      );
    }
    return null;
  }

  const displayVersion = siteVersion
    ? siteVersion.startsWith("v") ? siteVersion : `v${siteVersion}`
    : "unknown";

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="font-heading font-bold text-2xl text-charcoal mb-2">{t("title")}</h1>
      {latestRelease && needsUpgrade && (
        <p className="font-body text-sm text-gray-500 mb-6">{t("subtitle")}</p>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* REVIEW STAGE                                                        */}
      {/* ------------------------------------------------------------------ */}
      {stage === "review" && (
        <>
          {/* Stale head banner */}
          {upgradeError === "stale_head" && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 flex items-start gap-3">
              <p className="font-body text-sm text-amber-900 flex-1">{t("staleHead")}</p>
              <Link
                to="/dashboard"
                className="font-heading font-semibold text-sm text-amber-900 underline underline-offset-2 hover:opacity-80 shrink-0"
              >
                {t("resync")}
              </Link>
            </div>
          )}

          {/* Missing GitHub App permission (e.g. workflows: write) */}
          {upgradeError === "insufficient_permissions" && reauthUrl && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 flex items-start gap-3">
              <p className="font-body text-sm text-amber-900 flex-1">{t("insufficientPermissions")}</p>
              <a
                href={reauthUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-heading font-semibold text-sm text-amber-900 underline underline-offset-2 hover:opacity-80 shrink-0"
              >
                {t("reviewPermissions")}
              </a>
            </div>
          )}

          {/* Generic error banner */}
          {upgradeError === "upgrade_failed" && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p className="font-body text-sm text-red-900">{t("upgradeFailedDetail")}</p>
            </div>
          )}

          {/* Below minimum version error */}
          {isBelowMinimum && (
            <div className="border border-red-300 rounded-lg p-6 mb-6 bg-red-50">
              <h2 className="font-heading font-bold text-lg text-red-900 mb-2">
                {t("belowMinimumTitle")}
              </h2>
              <p className="font-body text-sm text-red-800">
                {t("belowMinimum", { version: displayVersion })}
              </p>
            </div>
          )}

          {/* Version display */}
          {latestRelease && (
            <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
              <div className="flex items-center justify-center gap-6 mb-6">
                <VersionBadge label={t("currentVersion")} version={displayVersion} variant="current" />
                <ArrowRight className="w-5 h-5 text-gray-400" />
                <VersionBadge label={t("targetVersion")} version={latestRelease.tagName} variant="target" />
              </div>

              {/* Release notes */}
              {releaseNotes && (
                <div className="mb-6">
                  <h2 className="font-heading font-semibold text-base text-charcoal mb-2">
                    {releaseCount > 1
                      ? t("combinedReleaseNotes", { count: releaseCount })
                      : t("releaseNotes")}
                  </h2>
                  <div
                    className="release-notes bg-cream-dark rounded-lg p-5 max-h-96 overflow-y-auto font-body text-sm text-charcoal"
                    dangerouslySetInnerHTML={{ __html: releaseNotes }}
                    onClick={(e) => {
                      const target = e.target as HTMLElement;
                      const anchor = target.closest("a");
                      if (!anchor) return;
                      const href = anchor.getAttribute("href");
                      if (!href?.startsWith("#")) return;
                      e.preventDefault();
                      const id = decodeURIComponent(href.slice(1));
                      const el = e.currentTarget.querySelector(`[id="${CSS.escape(id)}"]`);
                      el?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  />
                </div>
              )}

              {/* File change summary */}
              {diff && (
                <div className="mb-6">
                  <h2 className="font-heading font-semibold text-base text-charcoal mb-1">
                    {t("changesSummary")}
                  </h2>
                  <p className="font-body text-xs text-gray-500 mb-3">
                    {t("changesDescription")}
                  </p>
                  {diff.summary.total === 0 && diff.summary.deletions === 0 ? (
                    <p className="font-body text-sm text-gray-500">{t("totalChanges", { count: 0 })}</p>
                  ) : (
                    <>
                      <p className="font-body text-xs text-gray-500 mb-2">
                        {t("totalChanges", { count: diff.summary.total })}
                      </p>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {(
                          [
                            "layouts",
                            "includes",
                            "stylesheets",
                            "scripts",
                            "workflows",
                            "dataFiles",
                            "other",
                          ] as const
                        )
                          .filter((key) => diff.summary[key] > 0)
                          .map((key) => (
                            <CategoryCard
                              key={key}
                              icon={CATEGORY_ICONS[key]}
                              label={t(key)}
                              count={diff.summary[key]}
                              countLabel={t("fileCount", { count: diff.summary[key] })}
                              files={filesByCategory?.[key] ?? []}
                            />
                          ))}
                        {diff.summary.deletions > 0 && (
                          <CategoryCard
                            icon={XCircle}
                            label={t("deletions")}
                            count={diff.summary.deletions}
                            countLabel={t("fileCount", { count: diff.summary.deletions })}
                            files={filesByCategory?.deletions ?? []}
                            variant="danger"
                          />
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Upgrade button — only if not below minimum and upgrade is needed */}
              {!isBelowMinimum && needsUpgrade && (
                <div className="flex justify-end">
                  <Button variant="primary" type="button" onClick={handleUpgrade}>
                    {t("upgradeButton", { version: latestRelease.tagName })}
                  </Button>
                </div>
              )}

              {/* Already up to date */}
              {!isBelowMinimum && !needsUpgrade && latestRelease && (
                <p className="font-body text-sm text-green-700 text-center">
                  ✓ {t("upgradeSuccessDetail", { version: latestRelease.tagName })}
                </p>
              )}
            </div>
          )}

          {/* Hint boxes */}
          <div className="flex flex-col gap-2 mb-6">
            <HintBox title={t("hint_whatIsUpgrade_title")} body={t("hint_whatIsUpgrade")} />
            <HintBox title={t("hint_whatIsVersion_title")} body={t("hint_whatIsVersion")} />
            <HintBox title={t("hint_whatIsBuild_title")} body={t("hint_whatIsBuild")} />
          </div>

          <div className="flex justify-start">
            <Link
              to="/dashboard"
              className="font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-6 py-2.5 hover:bg-cream-dark transition-colors inline-block"
            >
              {t("backToDashboard")}
            </Link>
          </div>
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* UPGRADING STAGE — two-step progress: prepare, then commit           */}
      {/* ------------------------------------------------------------------ */}
      {stage === "upgrading" && (
        <div className="bg-white rounded-xl border border-gray-200 p-8">
          <h2 className="font-heading font-semibold text-lg text-charcoal mb-6 text-center">
            {t("upgrading")}
          </h2>
          <ol className="flex flex-col gap-4 max-w-sm mx-auto">
            {(["preparing", "committing"] as const).map((step) => {
              const isActive = upgradeSubStage === step;
              const isDone =
                (step === "preparing" && upgradeSubStage === "committing") ||
                upgradeSubStage === null;
              return (
                <li key={step} className="flex items-center gap-3">
                  {isActive ? (
                    <Loader2 className="w-5 h-5 text-terracotta animate-spin shrink-0" aria-hidden="true" />
                  ) : isDone ? (
                    <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" aria-hidden="true" />
                  ) : (
                    <div className="w-5 h-5 rounded-full border-2 border-gray-200 shrink-0" aria-hidden="true" />
                  )}
                  <span
                    className={`font-body text-sm ${
                      isActive
                        ? "text-charcoal font-semibold"
                        : isDone
                          ? "text-gray-500"
                          : "text-gray-400"
                    }`}
                  >
                    {t(`upgrading_step_${step}`)}
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="font-body text-xs text-gray-500 mt-6 text-center">
            {t("upgrading_hint")}
          </p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* BUILDING STAGE                                                      */}
      {/* ------------------------------------------------------------------ */}
      {stage === "building" && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="font-heading font-semibold text-lg text-charcoal mb-4">
            {t("buildTracking")}
          </h2>

          {!phases && (
            <div className="flex items-center gap-2 text-gray-500 mb-4">
              <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
              <span className="font-body text-sm">Waiting for build to start...</span>
            </div>
          )}

          {phases && (
            <div className="flex items-start mb-4">
              {displayPhases.map((phase, index) => (
                <div key={phase.id} className="flex items-center flex-1">
                  <div className="flex flex-col items-center gap-1 flex-shrink-0">
                    <PhaseCircle phase={phase} />
                    <span
                      className={`font-heading text-xs whitespace-nowrap text-center leading-tight ${
                        phase.status === "completed" && phase.conclusion !== "failure"
                          ? "text-green-600"
                          : phase.status === "in_progress"
                          ? "text-blue-600 font-semibold"
                          : "text-gray-400"
                      }`}
                    >
                      {phase.label}
                    </span>
                  </div>
                  {index < displayPhases.length - 1 && (
                    <div
                      className={`flex-1 min-w-2 h-0.5 mx-1 mb-5 transition-colors ${connectorClass(phase)}`}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {buildUrl && (
            <a
              href={buildUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-body text-xs text-blue-600 hover:underline"
            >
              View on GitHub
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* DONE STAGE                                                          */}
      {/* ------------------------------------------------------------------ */}
      {stage === "done" && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          {buildConclusion === "success" ? (
            <>
              <div className="flex flex-col items-center gap-3 py-4 mb-6">
                <CheckCircle2 className="w-12 h-12 text-green-500" />
                <h2 className="font-heading font-semibold text-xl text-charcoal">
                  {t("upgradeSuccess")}
                </h2>
                {newVersion && (
                  <p className="font-body text-sm text-gray-600">
                    {t("upgradeSuccessDetail", { version: newVersion })}
                  </p>
                )}
              </div>

              {/* Post-upgrade manual steps (from manifest chain) */}
              <section className="bg-cream-dark rounded-lg p-4 mb-6">
                <h3 className="font-heading font-semibold text-sm text-charcoal mb-2">
                  {t("manualStepsHeading")}
                </h3>
                {(() => {
                  const visibleSteps = manualSteps.filter(isStepVisible);
                  if (visibleSteps.length === 0) {
                    return (
                      <p className="font-body text-xs text-gray-600">
                        {t("manualStepsEmpty")}
                      </p>
                    );
                  }
                  return (
                    <>
                      <p className="font-body text-sm text-charcoal mb-3">
                        {t("manualStepsIntro")}
                      </p>
                      <ol className="list-decimal pl-6 space-y-3">
                        {visibleSteps.map((step, i) => (
                          <li key={i} className="font-body text-sm text-charcoal">
                            <div
                              dangerouslySetInnerHTML={{
                                // Manual-step descriptions come
                                // from bundled / release-asset manifests
                                // authored by the framework maintainer; route
                                // through sanitiseHtml to harden against an
                                // upstream compromise.
                                __html: sanitiseHtml(
                                  marked.parse(step.description, {
                                    async: false,
                                    gfm: true,
                                  }) as string,
                                ),
                              }}
                            />
                            {step.doc_url && (
                              <a
                                href={step.doc_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 font-body text-xs text-blue-600 hover:underline"
                              >
                                {t("manualStepsDocLink")}
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </li>
                        ))}
                      </ol>
                    </>
                  );
                })()}
              </section>

              <div className="flex flex-wrap gap-3 justify-end">
                {project.github_pages_url && (
                  <a
                    href={project.github_pages_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-6 py-2.5 hover:bg-cream transition-colors"
                  >
                    {t("viewSite")}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                {getContinueButton() ?? (
                  <Link to="/dashboard">
                    <Button variant="primary" type="button">{t("backToDashboard")}</Button>
                  </Link>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col items-center gap-3 py-4 mb-6">
                <XCircle className="w-12 h-12 text-red-500" />
                <h2 className="font-heading font-semibold text-xl text-charcoal">
                  {t("upgradeFailed")}
                </h2>
                <p className="font-body text-sm text-gray-600">{t("upgradeFailedDetail")}</p>
              </div>

              <div className="flex flex-wrap gap-3 justify-end">
                {buildUrl && (
                  <a
                    href={buildUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-6 py-2.5 hover:bg-cream transition-colors"
                  >
                    {t("viewActions")}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                <Button variant="primary" type="button" onClick={handleRetry}>
                  {t("retry")}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
