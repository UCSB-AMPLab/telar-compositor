/**
 * Preview configuration accepts data from the site's YAML without executing its
 * asset URLs. KaTeX is bundled at the supported framework version; a different
 * version leaves equations in source rather than promising a matching preview.
 * The site's files are read in panel-preview-config.server.ts.
 *
 * @version v1.5.0-beta
 */
import { load } from "js-yaml";
import {
  panelMathDelimiters,
  type MathDelimiter,
} from "~/components/ui/markdown-editor/panelMath";
export const PREVIEW_KATEX_VERSION = "0.16.21";
export interface PanelPreviewConfig {
  version: string;
  delimiters: MathDelimiter[];
  theme: Record<string, string>;
  available: boolean;
  /** The site's Telar version from `_config.yml`, or null when it cannot be read. */
  siteVersion: string | null;
  /**
   * True when the site's Telar predates the release that publishes carousel
   * images, formulas in widgets and footnote numbers as the preview shows
   * them. False when the version is that release or later, or unknown.
   */
  olderFramework: boolean;
  /**
   * The site's `theme` setting, whose file `theme` was read from; absent
   * where the configuration was not read. The framing stage loads the shipped
   * theme's fonts by it.
   */
  themeId?: string;
}
/** The configuration, or the loader's promise of it while it is read. */
export type PanelPreviewSource = PanelPreviewConfig | Promise<PanelPreviewConfig>;

/** What the editor shows when the site's configuration cannot be read. */
export function unavailablePanelPreview(): PanelPreviewConfig {
  return { ...parsePanelPreviewConfig(null, null), available: false };
}

type YamlObject = Record<string, unknown>;

function asObject(value: unknown): YamlObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as YamlObject) : {};
}

function shortString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100;
}

function readDelimiter(value: unknown): MathDelimiter {
  const d = asObject(value);
  if (!shortString(d.left) || !shortString(d.right) || typeof d.display !== "boolean")
    throw new Error("Invalid delimiter");
  return { left: d.left, right: d.right, display: d.display };
}

function readMath(mathYaml: string, result: PanelPreviewConfig): void {
  const math = asObject(load(mathYaml));
  if (typeof math.version === "string") result.version = math.version;
  if (math.delimiters === undefined) return;
  if (!Array.isArray(math.delimiters) || math.delimiters.length > 32) throw new Error("Invalid delimiters");
  result.delimiters = math.delimiters.map(readDelimiter);
}

function readTheme(themeYaml: string, result: PanelPreviewConfig): void {
  const theme = asObject(load(themeYaml));
  const colors = asObject(theme.colors);
  const text = asObject(colors.text);
  const background = asObject(colors.background);
  const variables: YamlObject = {
    "--color-panel-layer1-bg": background.panel_layer1,
    "--color-panel-layer2-bg": background.panel_layer2,
    "--color-panel-layer1-text": text.panel_layer1,
    "--color-panel-layer2-text": text.panel_layer2,
    "--color-heading": text.heading,
    "--color-body": text.body,
    "--color-link": text.link,
    "--color-button-bg": background.button,
    "--color-button-text": text.button,
  };
  for (const [key, value] of Object.entries(variables))
    if (typeof value === "string" && /^#[\da-f]{3,8}$/i.test(value)) result.theme[key] = value;
  const fonts = asObject(theme.fonts);
  const families: Array<[string, unknown]> = [
    ["--font-headings", fonts.headings],
    ["--panel-body-font", fonts.body],
  ];
  for (const [key, value] of families)
    if (typeof value === "string" && /^[\w\s,'"-]+$/.test(value) && value.length < 200) result.theme[key] = value;
}

export function parsePanelPreviewConfig(
  mathYaml: string | null,
  themeYaml: string | null,
): PanelPreviewConfig {
  const result: PanelPreviewConfig = {
    version: PREVIEW_KATEX_VERSION,
    delimiters: panelMathDelimiters,
    theme: {},
    available: true,
    siteVersion: null,
    olderFramework: false,
  };
  try {
    if (mathYaml) readMath(mathYaml, result);
    if (themeYaml) readTheme(themeYaml, result);
  } catch {
    result.available = false;
  }
  result.available &&= result.version === PREVIEW_KATEX_VERSION;
  return result;
}
