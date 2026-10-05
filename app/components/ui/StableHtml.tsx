/**
 * StableHtml — an element whose markup is set from a string of HTML, written
 * only when the string changes.
 *
 * React 19 writes an element's innerHTML again whenever it is given a new
 * `dangerouslySetInnerHTML` object, and a literal `{ __html }` is a new object
 * on every render. Rewriting replaces the nodes under a pointer that has
 * pressed on them, so no click fires, and discards any formula typeset into
 * them. The object here changes only with `html`, so the markup is written
 * only when the string changes.
 *
 * `html` must already be sanitised by the caller.
 *
 * @version v1.5.0-beta
 */

import { createElement, useMemo, type HTMLAttributes, type Ref } from "react";

type Tag = "div" | "span" | "p" | "small" | "button";

type StableHtmlProps = Omit<HTMLAttributes<HTMLElement>, "children" | "dangerouslySetInnerHTML"> & {
  as?: Tag;
  html: string;
  ref?: Ref<HTMLElement>;
  type?: "button";
};

export function StableHtml({ as = "div", html, ...rest }: StableHtmlProps) {
  const markup = useMemo(() => ({ __html: html }), [html]);
  return createElement(as, { ...rest, dangerouslySetInnerHTML: markup });
}
