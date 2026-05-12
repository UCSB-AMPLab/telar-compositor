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
 * @version v1.2.0-beta
 */

import {
  checkRepoNameAvailable,
  createSiteFromTemplate,
  waitForRepoReady,
  isRepoInInstallation,
  patchSiteConfigLanguage,
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
    try {
      const { repoUrl, defaultBranch } = await createSiteFromTemplate(token, owner, name);
      await waitForRepoReady(token, owner, name);

      // Seed telar_language in the new repo's
      // _config.yml from the user's ui_locale. Soft-fail — if the patch
      // throws for any reason, the create-site action still returns ok:true
      // and the UI renders an inline amber warning pointing at /config.
      let langPatchFailed = false;
      if (userUiLocale === "es") {
        try {
          await patchSiteConfigLanguage(token, owner, name, "es");
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[onboarding-create-site] _config.yml patch failed:", err);
          langPatchFailed = true;
        }
      }

      return {
        ok: true,
        intent: "create-site",
        repoUrl,
        defaultBranch,
        owner,
        name,
        langPatchFailed,
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
