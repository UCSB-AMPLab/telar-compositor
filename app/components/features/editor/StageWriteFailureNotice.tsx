/**
 * StageWriteFailureNotice — says, one line each, which of a capture, an object
 * change and a page choice the author made on the stage were not saved.
 *
 * @version v1.5.0-beta
 */
import { useTranslation } from "react-i18next";
import type { StageWrite } from "~/hooks/use-stage-write-failure";

const MESSAGE = { capture: "write_failed.capture", object: "write_failed.object", page: "write_failed.page" } as const;

export function StageWriteFailureNotice({ writes }: { writes: StageWrite[] }) {
  const { t } = useTranslation("editor");
  if (writes.length === 0) return null;
  return (
    <div
      role="alert"
      data-testid="stage-write-failure"
      className="absolute bottom-2 inset-x-3 z-20 rounded bg-cream px-3 py-1.5 font-body text-xs text-terracotta shadow"
    >
      {writes.map((write) => (
        <p key={write}>{t(MESSAGE[write])}</p>
      ))}
    </div>
  );
}
