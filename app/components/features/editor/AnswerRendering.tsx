/**
 * AnswerRendering — a step's answer as the published card shows it: the build's
 * rendering (`answerHtml`: rendered as a panel is, made prose, glossary links,
 * and the cut at the budget), with its formulas typeset
 * by KaTeX with the site's delimiters, as the site typesets them at runtime.
 * An answer the site sets in the smaller type carries `step-answer--long`, as
 * the published card's answer does.
 * The step card's answer and the hidden cards a media scene is measured from
 * both use it, so a formula takes the same room in each.
 *
 * `onRendered` is told once the formulas are typeset, or at once where there
 * is nothing to typeset, so a caller measuring the text measures it as it will
 * stand. A glossary link in it is never followed from here: its address
 * belongs to the published site. The markup is written once per change of
 * text, so a render that changes nothing leaves the paragraphs a pointer
 * is pressing on in place.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useMemo, useRef } from "react";
import { answerCard, typesetPreview, type GlossaryContext } from "~/lib/card-markdown";
import { holdGlossaryLinks } from "~/lib/glossary-links";
import type { MathDelimiter } from "~/components/ui/markdown-editor/panelMath";

interface AnswerRenderingProps {
  answer: string;
  glossary: GlossaryContext;
  /** The site's formula delimiters; formulas stay as typed without them. */
  delimiters?: MathDelimiter[];
  onRendered?: () => void;
  className?: string;
}

export function AnswerRendering({ answer, glossary, delimiters, onRendered, className }: AnswerRenderingProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { html, long } = useMemo(() => answerCard(answer, glossary), [answer, glossary]);
  // React writes the markup again on every render that hands it a new object,
  // which replaces the paragraph under a pointer that has pressed on it.
  const markup = useMemo(() => ({ __html: html }), [html]);
  const rendered = useRef(onRendered);
  rendered.current = onRendered;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let current = true;
    const done = () => {
      if (current) rendered.current?.();
    };
    if (delimiters) void typesetPreview(el, delimiters).then(done, done);
    else done();
    return () => {
      current = false;
    };
  }, [html, delimiters]);
  return (
    <div
      ref={ref}
      className={[className, long && "step-answer--long"].filter(Boolean).join(" ") || undefined}
      onClickCapture={holdGlossaryLinks}
      dangerouslySetInnerHTML={markup}
    />
  );
}
