/**
 * The pencil of a text on a card that is not a `.text-card`: the title card's
 * title, subtitle and byline, and a section card's heading and answer. The
 * step question's pencil is placed past its last line by the `.text-card`
 * rules (visitor-layer.css); these cards have none, so the wrappers here give
 * the pencil's box the same place: no size, absolute, at the coordinates
 * FieldPencil measures.
 *
 * @version v1.5.5-beta
 */

import type { ComponentProps, ReactNode } from "react";
import { ReportedText } from "~/components/features/editor/StepCard";

/** The pencil's box as the `.text-card` rules place it: no size, absolute, centred on the line it follows. */
const PENCIL_AT_TEXT_END =
  "contents [&_.stage-field-pencil]:absolute [&_.stage-field-pencil]:h-0 [&_.stage-field-pencil]:w-0 [&_.stage-field-pencil]:whitespace-nowrap [&_.stage-field-pencil>[data-in-place]]:ml-1 [&_.stage-field-pencil>[data-in-place]]:-translate-y-1/2";

/**
 * A text of the intro, edited in place as the step question is, with the same
 * pencil after it. The pencil stands past the end of the text's last line and
 * adds no line of its own.
 */
export function IntroText(props: ComponentProps<typeof ReportedText>) {
  return (
    <span className={PENCIL_AT_TEXT_END}>
      <ReportedText {...props} />
    </span>
  );
}

/**
 * Around an answer field given a `pencilLabel`: the pencil's box has no size
 * and stands absolutely at the end of the answer's last line, as on a
 * `.text-card`, so no line of the answer moves.
 */
export function CardAnswerPencil({ children }: { children: ReactNode }) {
  return (
    <div className={PENCIL_AT_TEXT_END}>
      {children}
    </div>
  );
}
