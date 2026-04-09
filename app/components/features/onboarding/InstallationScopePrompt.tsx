/**
 * InstallationScopePrompt — Phase 21 Plan 02 (CSITE-05).
 *
 * Reusable polling prompt shown when the GitHub App cannot yet see a repository
 * the user needs access to. Opens the GitHub App installation settings in a new
 * tab and polls `/onboarding` with `intent=check-installation-scope` every 2s
 * until the server reports `inScope: true`, then calls `onResolved()`.
 *
 * Used by:
 *  - CreateSiteForm (Phase 21 Plan 01 / Plan 02) — after repo creation, while
 *    waiting for the user to grant the GitHub App access to the new repo.
 *  - StepConnect (Phase 21 Plan 02) — normal connect flow when the user picks
 *    an existing repo the App can't see.
 *
 * Safety:
 *  - setInterval is cleared on unmount (T-21-07).
 *  - onResolved is ref-guarded so it fires at most once, and never after unmount.
 *  - Anchor uses rel="noopener noreferrer" (T-21-06).
 *  - Never renders raw fetcher error messages (T-21-08).
 */

import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

interface InstallationScopePromptProps {
  installationId: number;
  owner: string;
  repoName: string;
  onResolved: () => void;
  className?: string;
}

type ScopeResponse =
  | { ok: true; intent: "check-installation-scope"; inScope: boolean }
  | { ok: false; intent: "check-installation-scope"; error: string; message?: string };

export function InstallationScopePrompt({
  installationId,
  owner,
  repoName,
  onResolved,
  className = "",
}: InstallationScopePromptProps) {
  const { t } = useTranslation("onboarding");
  const scopeFetcher = useFetcher<ScopeResponse>();
  const resolvedRef = useRef(false);
  const mountedRef = useRef(true);
  const onResolvedRef = useRef(onResolved);

  // Keep a stable ref to the latest onResolved so the polling effect below
  // doesn't need to re-run (and re-install intervals) when the parent passes
  // a new function identity on each render.
  useEffect(() => {
    onResolvedRef.current = onResolved;
  }, [onResolved]);

  useEffect(() => {
    mountedRef.current = true;
    const submit = () => {
      scopeFetcher.submit(
        {
          intent: "check-installation-scope",
          owner,
          name: repoName,
          installation_id: String(installationId),
        },
        { method: "post", action: "/onboarding" },
      );
    };
    submit();
    const id = setInterval(submit, 2000);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installationId, owner, repoName]);

  useEffect(() => {
    if (!mountedRef.current || resolvedRef.current) return;
    const data = scopeFetcher.data;
    if (data && data.ok && data.inScope) {
      resolvedRef.current = true;
      onResolvedRef.current();
    }
    if (data && !data.ok) {
      // Keep polling; never render raw err.message to the user.
      // eslint-disable-next-line no-console
      console.error(
        "check-installation-scope error:",
        (data as { message?: string }).message,
      );
    }
  }, [scopeFetcher.data]);

  return (
    <div
      className={`border border-gray-200 bg-cream rounded-lg p-4 ${className}`}
    >
      <h3 className="font-heading font-semibold text-base text-charcoal mb-2">
        {t("create_site.installation_scope.title")}
      </h3>
      <p className="font-body text-sm text-gray-600 mb-4">
        {t("create_site.installation_scope.body")}
      </p>
      <a
        href={`https://github.com/settings/installations/${installationId}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center justify-center gap-2 font-heading font-semibold text-sm uppercase tracking-wider bg-periwinkle hover:bg-periwinkle-hover text-charcoal rounded-full px-6 py-2.5 transition-colors"
      >
        {t("create_site.installation_scope.grant_button")}
      </a>
      <p className="mt-3 inline-flex items-center gap-2 font-body text-xs text-gray-500">
        <Loader2 className="w-3 h-3 animate-spin" />
        {t("create_site.installation_scope.waiting")}
      </p>
    </div>
  );
}
