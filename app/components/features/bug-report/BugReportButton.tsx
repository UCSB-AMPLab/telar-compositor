/**
 * This file renders the bug-report trigger button — the small bug
 * icon in the header that opens `BugReportPanel` on click.
 *
 * @version v1.2.0-beta
 */

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bug } from "lucide-react";
import { BugReportPanel } from "./BugReportPanel";

interface BugReportButtonProps {
  /** GitHub login of the signed-in user, threaded into the "signed in as @x"
   * caption. */
  userLogin: string;
}

export function BugReportButton({ userLogin }: BugReportButtonProps) {
  const { t } = useTranslation("bug-report");
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("button_aria")}
        title={t("button_tooltip")}
        className="p-1.5 rounded-full transition-colors text-white hover:bg-white/10"
      >
        <Bug className="w-4.5 h-4.5" aria-hidden />
      </button>
      <BugReportPanel
        open={open}
        onClose={() => setOpen(false)}
        mode="default"
        userLogin={userLogin}
        triggerRef={triggerRef}
      />
    </>
  );
}
