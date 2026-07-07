/**
 * This file holds the action-handler helpers for the onboarding wizard's
 * create-site intents, extracted from `app/routes/onboarding.tsx` so the
 * route module stays free of server-only imports.
 *
 * React Router only strips `loader`, `action`, `middleware`, and `headers`
 * from the client bundle. Any other exported function that transitively
 * reaches a `.server` module fails the client build — so these intent
 * handlers live in a sibling `.server.ts` file the route's `action`
 * imports, and tests can pull from them directly without touching the
 * route module.
 *
 * @version v1.4.0-beta
 */

import {
  checkRepoNameAvailable,
  createSiteFromTemplate,
  waitForRepoReady,
  isRepoInInstallation,
  commitBornCleanSite,
  humanizeSlug,
  normalizeTheme,
  RepoNameTakenError,
  PermissionDeniedError,
  RepoNotReadyError,
} from "~/lib/create-site.server";
import { getInstallationToken } from "~/lib/github-app.server";

export async function handleCreateSiteIntents(
  intent: string,
  formData: FormData,
  token: string,
  env: Env,
  userUiLocale: "en" | "es" | null = null,
) {
  if (intent === "check-repo-name") {
    const owner = formData.get("owner") as string;
    const name = formData.get("name") as string;
    try {
      const result = await checkRepoNameAvailable(token, owner, name);
      if (!result.available) {
        const errorCode = result.reason === "invalid" ? "invalid_name" : "name_exists";
        return { ok: false, intent: "check-repo-name", error: errorCode };
      }
      return { ok: true, intent: "check-repo-name", available: true };
    } catch (err) {
      return {
        ok: false,
        intent: "check-repo-name",
        error: "github_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (intent === "create-site") {
    const owner = formData.get("owner") as string;
    const name = formData.get("name") as string;
    const installationId = Number(formData.get("installation_id"));
    try {
      const { repoUrl, defaultBranch } = await createSiteFromTemplate(token, owner, name);
      await waitForRepoReady(token, owner, name);

      // Born-clean provisioning: commit the site's own config + language-matched
      // starter content (disabling the demo Google Sheet so the first import
      // seeds D1 from the repo's CSVs, not the live demo), enable Pages, and
      // dispatch the first build. Best-effort with degrade-to-repair — the repo
      // exists regardless, so create-site still returns ok:true; any born-clean
      // step failing flips bornCleanOk so the caller knows NOT to skip the repair
      // step.
      //
      // Identity comes from the wizard fields when present, with safe fallbacks:
      // language defaults to the UI locale; title to the humanized slug;
      // description to the title; theme is enum-validated (unknown/`custom` →
      // `trama`); author defaults to the owner login.
      const langField = formData.get("language");
      const locale: "en" | "es" =
        langField === "es" ? "es" : langField === "en" ? "en" : userUiLocale === "es" ? "es" : "en";
      const titleField = ((formData.get("title") as string) ?? "").trim();
      const title = titleField || humanizeSlug(name, locale);
      const descField = ((formData.get("description") as string) ?? "").trim();
      const description = descField || title;
      const theme = normalizeTheme(formData.get("theme"));
      const authorField = ((formData.get("author") as string) ?? "").trim();
      const author = authorField || owner;
      const attemptBornClean = async (): Promise<{
        ok: boolean;
        error?: string;
        pagesUrl?: string;
      }> => {
        try {
          const installationToken = await getInstallationToken(
            env.GITHUB_APP_ID,
            env.GITHUB_PRIVATE_KEY,
            installationId,
          );
          const result = await commitBornCleanSite({
            token,
            installationToken,
            owner,
            name,
            locale,
            title,
            description,
            theme,
            author,
          });
          return { ok: result.ok, error: result.error, pagesUrl: result.pagesUrl };
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[onboarding-create-site] born-clean provisioning failed:", err);
          return { ok: false, error: "provisioning" };
        }
      };

      // A commit/provisioning failure means the born-clean config never landed,
      // so the import step below would read google_sheets:enabled and seed D1
      // from the live demo Sheet. The born-clean commit is idempotent (it skips
      // the re-commit when the config is already clean), so retry once — the
      // dominant cause is a transient GitHub hiccup that clears immediately, and
      // a landed-but-reported-failed first attempt is safe to repeat. Bounded to
      // a single retry; pages/dispatch/scope failures are not retried here (the
      // config already landed, and the repair flow handles them).
      let bc = await attemptBornClean();
      if (!bc.ok && (bc.error === "commit" || bc.error === "provisioning")) {
        bc = await attemptBornClean();
      }
      const bornCleanOk = bc.ok;
      const bornCleanError = bc.error;
      const pagesUrl = bc.pagesUrl;

      return {
        ok: true,
        intent: "create-site",
        repoUrl,
        defaultBranch,
        owner,
        name,
        bornCleanOk,
        bornCleanError,
        pagesUrl,
        // Spanish sites where the config commit never landed never got their
        // telar_language written, so the existing "set it manually" nudge still
        // applies. That covers both a failed commit step and a provisioning throw
        // before the commit (e.g. the installation token can't be minted). On a
        // pages/dispatch failure the language is already committed correctly.
        langPatchFailed:
          locale === "es" &&
          (bornCleanError === "commit" || bornCleanError === "provisioning"),
      };
    } catch (err) {
      if (err instanceof RepoNameTakenError) {
        return { ok: false, intent: "create-site", error: "repo_name_taken" };
      }
      if (err instanceof PermissionDeniedError) {
        return { ok: false, intent: "create-site", error: "permission_denied" };
      }
      if (err instanceof RepoNotReadyError) {
        return { ok: false, intent: "create-site", error: "repo_not_ready" };
      }
      return {
        ok: false,
        intent: "create-site",
        error: "github_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (intent === "check-installation-scope") {
    const installationId = Number(formData.get("installation_id"));
    const owner = formData.get("owner") as string;
    const name = formData.get("name") as string;
    try {
      const installToken = await getInstallationToken(
        env.GITHUB_APP_ID,
        env.GITHUB_PRIVATE_KEY,
        installationId,
      );
      const inScope = await isRepoInInstallation(installToken, owner, name);
      return { ok: true, intent: "check-installation-scope", inScope };
    } catch (err) {
      return {
        ok: false,
        intent: "check-installation-scope",
        error: "github_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  throw new Error(`handleCreateSiteIntents: unknown intent "${intent}"`);
}
