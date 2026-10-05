/**
 * The document a framework-driving subprocess loads the framework's browser
 * modules against.
 *
 * The framework's story modules reach `window`, `document`,
 * `getComputedStyle`, `matchMedia` and `requestAnimationFrame` while loading,
 * so a test that drives them runs a `node --input-type=module` script that
 * starts with these lines. The lines are source text for that script, not code
 * run here.
 *
 * @version v1.5.0-beta
 */

export interface JsdomPreludeOptions {
  /** Markup for the document's `<head>`, such as a `:root` style. */
  head?: string;
  /**
   * Declare `W` and `H` and make `window.innerWidth` and `innerHeight` read
   * them, so the script can size the window per case.
   */
  sizedWindow?: boolean;
  /**
   * Lines that assign `dom.window.matchMedia`. Without them it matches no
   * query, which is the desktop branch.
   */
  matchMedia?: string[];
}

/** The script's opening lines: the document, the window's size, and the globals. */
export function jsdomPrelude(options: JsdomPreludeOptions = {}): string[] {
  const html = `<!doctype html><html><head>${options.head ?? ""}</head><body></body></html>`;
  return [
    "import { JSDOM } from 'jsdom';",
    `const dom = new JSDOM(${JSON.stringify(html)});`,
    ...(options.sizedWindow
      ? [
          "let W = 0, H = 0;",
          "Object.defineProperty(dom.window, 'innerWidth', { get: () => W, configurable: true });",
          "Object.defineProperty(dom.window, 'innerHeight', { get: () => H, configurable: true });",
        ]
      : []),
    ...(options.matchMedia ?? [
      "dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });",
    ]),
    "globalThis.window = dom.window;",
    "globalThis.document = dom.window.document;",
    "globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);",
    "globalThis.matchMedia = dom.window.matchMedia;",
    "globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);",
  ];
}
