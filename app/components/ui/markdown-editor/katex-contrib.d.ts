/** KaTeX's chemistry side effect has no exported API. @version v1.5.0-beta */
declare module "katex/contrib/mhchem";
declare module "katex/contrib/auto-render" {
  import type { KatexOptions } from "katex";
  export default function renderMath(element: HTMLElement, options: KatexOptions & { delimiters: Array<{left: string; right: string; display: boolean}>; ignoredClasses?: string[] }): void;
}
