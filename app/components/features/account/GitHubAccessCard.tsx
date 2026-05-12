/**
 * This file renders the GitHub Access card — the section on the
 * /account page that lists every GitHub App installation the user
 * has access to (one row per installation) with avatar + login +
 * Personal account / Organization label + per-row Manage on GitHub
 * link templated by `target_type`.
 *
 * Empty state renders when the user has zero installations (e.g.
 * revoked from the GitHub side after signing in) with a CTA
 * pointing to the existing `installAppUrl` constant — never invent
 * a new URL.
 *
 * Manage link templating:
 *   - target_type === "User"        → /settings/installations/{id}
 *   - target_type === "Organization" → /organizations/{login}/settings/installations/{id}
 *
 * `target="_blank"` always carries `rel="noreferrer"` to mitigate
 * tab-nabbing.
 *
 * @version v1.2.0-beta
 */

import { useTranslation } from "react-i18next";
import { Github } from "lucide-react";
import { Button } from "~/components/ui/Button";
import type { Installation } from "~/lib/github.server";

export interface GitHubAccessCardProps {
  installations: Installation[];
  installAppUrl: string;
}

interface InstallationRowProps {
  installation: Installation;
}

function InstallationRow({ installation }: InstallationRowProps) {
  const { t } = useTranslation("account");

  const isOrg = installation.target_type === "Organization";
  const managementUrl = isOrg
    ? `https://github.com/organizations/${installation.account.login}/settings/installations/${installation.id}`
    : `https://github.com/settings/installations/${installation.id}`;

  const typeLabel = isOrg
    ? t("github_install_type_org")
    : t("github_install_type_user");

  return (
    <li className="py-3 flex items-center gap-3">
      <img
        src={installation.account.avatar_url}
        alt={installation.account.login}
        className="w-8 h-8 rounded-full border border-gray-100"
      />

      <div className="flex-1 min-w-0">
        <p className="text-base font-body font-medium text-charcoal truncate">
          @{installation.account.login}
        </p>
        <p className="text-sm font-body text-gray-500">{typeLabel}</p>
      </div>

      <a
        href={managementUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={t("github_manage_aria", {
          login: installation.account.login,
        })}
        className="text-sm font-body font-medium text-terracotta hover:underline"
      >
        {t("github_manage_link")}
      </a>
    </li>
  );
}

export function GitHubAccessCard({
  installations,
  installAppUrl,
}: GitHubAccessCardProps) {
  const { t } = useTranslation("account");

  return (
    <section className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 mt-8">
      <div className="flex items-center gap-2">
        <Github className="w-5 h-5 text-charcoal" aria-hidden="true" />
        <h2 className="text-xl font-heading font-semibold text-charcoal">
          {t("github_access_heading")}
        </h2>
      </div>

      {installations.length > 0 ? (
        <ul className="divide-y divide-gray-100 mt-4">
          {installations.map((inst) => (
            <InstallationRow key={inst.id} installation={inst} />
          ))}
        </ul>
      ) : (
        <div className="py-8 px-6 text-center">
          <Github
            className="w-8 h-8 text-gray-400 mx-auto"
            aria-hidden="true"
          />
          <p className="text-base font-body font-medium text-charcoal mt-3">
            {t("github_empty_heading")}
          </p>
          <p className="text-sm font-body text-gray-500 mt-2">
            {t("github_empty_subtext")}
          </p>
          <div className="mt-4">
            <a href={installAppUrl} target="_blank" rel="noreferrer">
              <Button variant="primary">{t("github_empty_cta")}</Button>
            </a>
          </div>
        </div>
      )}
    </section>
  );
}
