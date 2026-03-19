/**
 * Upgrade route — shows version info, release notes, file change summary,
 * and an upgrade button that commits framework files atomically.
 *
 * Loader: fetches latest release, computes upgrade diff between user's repo
 *         and the latest framework release.
 *
 * Action: handles three intents —
 *   upgrade:      commits framework files atomically, updates D1
 *   poll-build:   polls GitHub Actions for build progress
 *   compute-diff: recomputes the diff (refresh/retry)
 *
 * Component: 4-stage state machine — review | upgrading | building | done.
 */

import { redirect, useFetcher } from "react-router";
import { eq } from "drizzle-orm";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
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
import { getRepoTree, getFileContent } from "~/lib/github.server";
import {
  fetchLatestRelease,
  fetchAllReleases,
  computeUpgradeDiff,
  updateTelarVersionInConfig,
  compareVersions,
  checkTelarVersion,
  MIN_SUPPORTED_VERSION,
  categorizeFrameworkPath,
} from "~/lib/upgrade.server";
import type { UpgradeDiff, TelarRelease, UpgradeSummary } from "~/lib/upgrade.server";
import {
  commitFilesToRepo,
  listWorkflowRunsBySha,
  getJobSteps,
  mapStepsToBuildPhases,
  StaleHeadError,
} from "~/lib/commit.server";
import type { BuildPhaseStatus } from "~/lib/commit.server";
import { marked, Renderer } from "marked";
import { Button } from "~/components/ui/Button";

export const handle = { i18n: ["common", "upgrade"] };

// ---------------------------------------------------------------------------
// Build phases — mirrors commit.server.ts BUILD_PHASES (no server import)
// ---------------------------------------------------------------------------

const BUILD_PHASES = [
  { id: "setup", label: "Setup" },
  { id: "build-js", label: "Build JS" },
  { id: "process-data", label: "Process data" },
  { id: "build-site", label: "Build site" },
  { id: "iiif", label: "IIIF tiles" },
  { id: "deploy", label: "Deploy" },
] as const;

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

  const allProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.user_id, user.id));

  if (allProjects.length === 0) {
    throw redirect("/dashboard");
  }

  const activeProject =
    allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];

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
    const latestRelease = await fetchLatestRelease(token);

    // Fetch release notes for all versions newer than current site version
    let releaseNotes: string = latestRelease.body;
    let releaseCount = 1;
    if (siteTag && compareVersions(siteTag, latestRelease.tagName) < 0) {
      const allReleases = await fetchAllReleases(token);
      const newerReleases = allReleases.filter(
        (r) => siteTag ? compareVersions(r.tagName, siteTag) > 0 : true,
      );
      releaseCount = newerReleases.length;
      if (newerReleases.length > 1) {
        releaseNotes = newerReleases
          .map((r) => `## ${r.tagName}\n\n${r.body}`)
          .join("\n\n---\n\n");
      }
    }

    // Fetch the user's repo tree and _config.yml
    const { tree: userTree } = await getRepoTree(token, owner, repo);
    const configContent = await getFileContent(token, owner, repo, "_config.yml");

    // Compute the upgrade diff
    const diff = await computeUpgradeDiff(token, userTree, latestRelease.tagName);

    const needsUpgrade = siteTag
      ? compareVersions(siteTag, latestRelease.tagName) < 0
      : false;

    // Convert markdown release notes to HTML (with heading IDs for anchor links)
    const renderer = new Renderer();
    renderer.heading = ({ text, depth }: { text: string; depth: number }) => {
      const slug = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-").trim();
      return `<h${depth} id="${slug}">${text}</h${depth}>`;
    };
    const releaseNotesHtml = await marked.parse(releaseNotes, { async: false, gfm: true, renderer });

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
      project: {
        id: activeProject.id,
        github_pages_url: activeProject.github_pages_url,
        github_repo_full_name: activeProject.github_repo_full_name,
      },
    };
  } catch {
    // GitHub API unavailable — show minimal page
    return {
      siteVersion,
      latestRelease: null,
      releaseNotes: "",
      releaseCount: 0,
      diff: null,
      configContent: "",
      isBelowMinimum,
      needsUpgrade: false,
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

  const allProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.user_id, user.id));

  if (allProjects.length === 0) {
    return { ok: false, intent, error: "no_project" };
  }

  const activeProject =
    allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];

  const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
  const [owner, repo] = activeProject.github_repo_full_name.split("/");

  switch (intent) {
    case "upgrade": {
      try {
        // Fetch latest release and user tree fresh for this commit
        const latestRelease = await fetchLatestRelease(token);
        const { tree: userTree } = await getRepoTree(token, owner, repo);
        const diff = await computeUpgradeDiff(token, userTree, latestRelease.tagName);

        // Build additions list: start with framework files from diff
        const additions = [...diff.additions];

        // Apply config patch to _config.yml
        const configContent = await getFileContent(token, owner, repo, "_config.yml");
        if (configContent && diff.configPatch) {
          const releaseDate = latestRelease.publishedAt.slice(0, 10);
          const patchedConfig = updateTelarVersionInConfig(
            configContent,
            latestRelease.tagName,
            releaseDate,
          );
          additions.push({ path: "_config.yml", content: patchedConfig });
        }

        const configRows = await db
          .select({ telar_version: project_config.telar_version })
          .from(project_config)
          .where(eq(project_config.project_id, activeProject.id))
          .limit(1);
        const oldVersion = configRows[0]?.telar_version ?? "unknown";

        const commitMessage = `Upgrade Telar from ${oldVersion} to ${latestRelease.tagName}`;
        const commitBody = `Upgraded via Telar Compositor\n\nSee release notes: https://github.com/UCSB-AMPLab/telar/releases/tag/${latestRelease.tagName}`;

        const result = await commitFilesToRepo(
          token,
          owner,
          repo,
          "main",
          additions,
          commitMessage,
          commitBody,
          diff.deletions,
        );

        const newHeadSha = result.newHeadSha;
        const now = new Date().toISOString();

        // Update D1: telar_version in project_config, head_sha in projects
        await db
          .update(project_config)
          .set({ telar_version: latestRelease.tagName, updated_at: now })
          .where(eq(project_config.project_id, activeProject.id));

        await db
          .update(projects)
          .set({ head_sha: newHeadSha, updated_at: now })
          .where(eq(projects.id, activeProject.id));

        return {
          ok: true,
          intent: "upgrade",
          newHeadSha,
          newVersion: latestRelease.tagName,
          owner,
          repo,
        };
      } catch (err) {
        if (err instanceof StaleHeadError) {
          return { ok: false, intent: "upgrade", error: "stale_head" };
        }
        return {
          ok: false,
          intent: "upgrade",
          error: "upgrade_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        };
      }
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

type UpgradeActionData =
  | { ok: true; intent: "upgrade"; newHeadSha: string; newVersion: string; owner: string; repo: string }
  | { ok: false; intent: "upgrade"; error: string; message?: string }
  | { ok: true; intent: "poll-build"; buildStatus: string; buildConclusion: string | null; buildUrl: string | null; runId: number | null; phases: BuildPhaseStatus[] | null }
  | { ok: false; intent: "poll-build"; error: string; message?: string }
  | { ok: true; intent: "compute-diff"; diff: UpgradeDiff; latestRelease: TelarRelease }
  | { ok: false; intent: "compute-diff"; error: string; message?: string }
  | { ok: false; intent: string; error: string }
  | null
  | undefined;

type UpgradeStage = "review" | "upgrading" | "building" | "done";

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
        {BUILD_PHASES.findIndex((p) => p.id === phase.id) + 1}
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

  const {
    siteVersion,
    latestRelease,
    releaseNotes,
    releaseCount,
    diff,
    filesByCategory,
    isBelowMinimum,
    needsUpgrade,
    project,
  } = loaderData;

  const upgradeFetcher = useFetcher();
  const pollFetcher = useFetcher();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [stage, setStage] = useState<UpgradeStage>("review");
  const [upgradeSha, setUpgradeSha] = useState<string | null>(null);
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [buildConclusion, setBuildConclusion] = useState<string | null>(null);
  const [buildUrl, setBuildUrl] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [phases, setPhases] = useState<BuildPhaseStatus[] | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);

  const upgradeData = upgradeFetcher.data as UpgradeActionData;
  const pollData = pollFetcher.data as UpgradeActionData;

  // Handle upgrade response
  useEffect(() => {
    if (!upgradeData) return;
    if (upgradeData.ok && upgradeData.intent === "upgrade") {
      setUpgradeSha(upgradeData.newHeadSha);
      setNewVersion(upgradeData.newVersion);
      setStage("building");
    } else if (!upgradeData.ok && upgradeData.intent === "upgrade") {
      setStage("review");
      setUpgradeError(
        upgradeData.error === "stale_head" ? "stale_head" : "upgrade_failed",
      );
    }
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

  function handleUpgrade() {
    setUpgradeError(null);
    setStage("upgrading");
    upgradeFetcher.submit({ intent: "upgrade" }, { method: "post" });
  }

  function handleRetry() {
    setStage("review");
    setUpgradeError(null);
    setUpgradeSha(null);
    setNewVersion(null);
    setBuildConclusion(null);
    setBuildUrl(null);
    setRunId(null);
    setPhases(null);
  }

  // Build phase display
  const displayPhases: BuildPhaseStatus[] =
    phases ??
    BUILD_PHASES.map((p) => ({
      id: p.id,
      label: p.label,
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
      {/* UPGRADING STAGE                                                     */}
      {/* ------------------------------------------------------------------ */}
      {stage === "upgrading" && (
        <div className="bg-white rounded-xl border border-gray-200 p-12 flex flex-col items-center gap-4">
          <Loader2 className="w-10 h-10 text-terracotta animate-spin" />
          <p className="font-heading font-semibold text-lg text-charcoal">{t("upgrading")}</p>
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

              {/* Post-upgrade checklist */}
              <div className="bg-cream-dark rounded-lg p-4 mb-6">
                <h3 className="font-heading font-semibold text-sm text-charcoal mb-1">
                  {t("postUpgradeChecklist")}
                </h3>
                <p className="font-body text-xs text-gray-600">{t("noChecklist")}</p>
              </div>

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
