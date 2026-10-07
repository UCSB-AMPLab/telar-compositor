/**
 * The two collaboration cards at the top of Start's right column.
 *
 * "Work together" is the convenor's way to bring people into the site: a large
 * button that opens the collaboration sidebar, where invitations are made. It
 * says what a person who is added can do, or how many already work on the site.
 *
 * On a shared site, everyone sees a second card linking to the contribution
 * record, which shows what each person has added and written.
 *
 * @version v1.5.2-beta
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ArrowRight, Users } from "lucide-react";
import { Button } from "~/components/ui/Button";

const CARD = "rounded-lg border border-border bg-surface px-[20px] py-[16px]";
const HEADING = "mb-2 font-heading font-semibold text-xs uppercase tracking-wider text-fg-muted";

export function WorkTogetherCard({ collaboratorCount, onInvite }: { collaboratorCount: number; onInvite: () => void }) {
  const { t } = useTranslation("start");
  return (
    <section className={CARD} data-testid="work-together-card">
      <h2 className={HEADING}>{t("collab_card.heading")}</h2>
      <p className="font-body text-sm text-charcoal">
        {collaboratorCount > 0 ? t("collab_card.body", { count: collaboratorCount }) : t("collab_card.body_solo")}
      </p>
      <Button variant="primary" type="button" onClick={onInvite} className="mt-4 w-full">
        <Users className="w-5 h-5" aria-hidden="true" />
        {t("collab_card.invite")}
      </Button>
    </section>
  );
}

export function ContributionRecordCard() {
  const { t } = useTranslation(["start", "contributions"]);
  return (
    <section className={CARD} data-testid="contribution-record-card">
      <h2 className={HEADING}>{t("contributions:nav")}</h2>
      <p className="font-body text-sm text-charcoal">{t("record_card.body")}</p>
      <Link
        to="/contributions"
        className="mt-3 inline-flex items-center gap-1.5 font-heading font-semibold text-sm text-caracol hover:text-caracol-deep"
      >
        {t("record_card.link")}
        <ArrowRight className="w-4 h-4" aria-hidden="true" />
      </Link>
    </section>
  );
}
