/**
 * Onboarding create-site action intents.
 *
 * Extracted from `app/routes/onboarding.tsx` so the route file does not
 * export a non-allowed function that transitively references server
 * modules — React Router only strips `loader`, `action`, `middleware`,
 * and `headers` from the client bundle, and will fail the client build
 * for any other exported function that reaches a `.server` module.
 *
 * Keeping this helper in a `.server.ts` file (server-only by convention)
 * lets the route's `action` import it safely, and tests can import it
 * directly without touching the route module.
 */

import {
  checkRepoNameAvailable,
  createSiteFromTemplate,
  waitForRepoReady,
  isRepoInInstallation,
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
      return { ok: true, intent: "create-site", repoUrl, defaultBranch, owner, name };
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
