/**
 * The notice for a write refused because another tab switched sites.
 *
 * An action answers `{ ok: false, error: "site_changed", currentSiteName }`
 * when the page posted a site other than the one the session names
 * (`resolvePageProject`). Nothing was written, and the page's own error
 * handling says nothing for this error, so this is the one message the author
 * sees. It stays dismissible: the author's unsaved text is still on the page
 * until they reload.
 *
 * `SiteChangedWatcher` is mounted once in the layout. It shows the refusals
 * every `useSiteFetcher` reports (`~/lib/page-site`), and compares the
 * layout's site with the one this page was showing. A `<Form>` submission's
 * result reaches only its own route, so a route that submits one renders
 * `SiteChangedDialog` from its action data.
 *
 * @version v1.5.0-beta
 */

import { useState } from "react";
import { useRouteLoaderData } from "react-router";
import { useTranslation } from "react-i18next";
import { Dialog } from "~/components/ui/Dialog";
import { Button } from "~/components/ui/Button";
import { SITE_CHANGED, usePageSite, usePageSiteId } from "~/lib/page-site";

interface SiteChangedData {
  ok: false;
  error: typeof SITE_CHANGED;
  currentSiteName?: string;
}

/** Whether an action's answer is the site-changed refusal. */
export function isSiteChanged(data: unknown): data is SiteChangedData {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { error?: unknown }).error === SITE_CHANGED
  );
}

interface LayoutProjects {
  allProjects?: Array<{ id: number; github_repo_full_name: string }>;
}

function useSiteName(id: number | null): string {
  const app = useRouteLoaderData("routes/_app") as LayoutProjects | null;
  if (id === null) return "";
  return app?.allProjects?.find((p) => p.id === id)?.github_repo_full_name ?? "";
}

/**
 * `stopped`: an action refused a write. `stale`: the layout reloaded for
 * another site while this page still held the one the author arrived on.
 */
export function SiteChangedDialog({
  reason,
  otherSiteName,
  onClose,
}: {
  reason: "stopped" | "stale";
  otherSiteName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("common");
  const site = useSiteName(usePageSiteId());
  const other = otherSiteName;
  return (
    <Dialog open onClose={onClose} className="max-w-md p-6">
      <h2 className="font-heading font-semibold text-lg text-charcoal mb-3">
        {t("site_changed.title")}
      </h2>
      <p className="text-sm text-charcoal mb-2">
        {t(reason === "stopped" ? "site_changed.body_stopped" : "site_changed.body_stale", {
          site,
          other,
        })}
      </p>
      <p className="text-sm text-charcoal mb-5">{t("site_changed.next", { site, other })}</p>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {t("close")}
        </Button>
        <Button onClick={() => window.location.reload()}>{t("site_changed.reload")}</Button>
      </div>
    </Dialog>
  );
}

/**
 * Shows the notice for any site fetcher whose action refused a changed site,
 * and when the layout's site moves under a page that still holds another one.
 */
export function SiteChangedWatcher() {
  const { latched, live, stopped, clearStopped } = usePageSite();
  const liveName = useSiteName(live);
  const [staleDismissed, setStaleDismissed] = useState<number | null>(null);

  if (stopped !== null) {
    return <SiteChangedDialog reason="stopped" otherSiteName={stopped} onClose={clearStopped} />;
  }
  const stale = latched !== null && live !== null && latched !== live && staleDismissed !== live;
  if (stale) {
    return (
      <SiteChangedDialog reason="stale" otherSiteName={liveName} onClose={() => setStaleDismissed(live)} />
    );
  }
  return null;
}
