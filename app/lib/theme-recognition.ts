/**
 * This file is the pure helper that decides whether the Config tab's
 * "unrecognised theme" amber alert should appear above the theme
 * swatches.
 *
 * The alert fires when the project's stored `theme` value doesn't match
 * any of the themes the importer found in the repo — usually because
 * someone hand-edited `_config.yml` to point at a theme that was never
 * shipped. Telling the user once at the top of the section is friendlier
 * than letting them puzzle over a swatch grid that doesn't include their
 * current theme.
 *
 * One subtle case: when the importer found no themes at all, the alert
 * is hidden. The swatch grid already shows its own "No themes found"
 * empty state, and a redundant "Pick one of your themes below" prompt
 * would point at nothing.
 *
 * @version v1.2.0-beta
 */

export interface ThemeLike {
  theme_id: string;
}

export interface ThemeAlertInput {
  themeValue: string | null | undefined;
  themes: readonly ThemeLike[];
}

export interface ThemeAlertResult {
  showAlert: boolean;
  isEmpty: boolean;
  isUnrecognised: boolean;
}

export function detectThemeAlert({
  themeValue,
  themes,
}: ThemeAlertInput): ThemeAlertResult {
  const value = themeValue ?? "";
  const isEmpty = value === "";
  const isUnrecognised =
    !isEmpty && !themes.some((t) => t.theme_id === value);
  const showAlert = (isEmpty || isUnrecognised) && themes.length > 0;
  return { showAlert, isEmpty, isUnrecognised };
}
