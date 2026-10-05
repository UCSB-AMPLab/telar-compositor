/**
 * Panel commands cross the React/CodeMirror boundary through view-local
 * callbacks. `preview` is undefined until the site's configuration arrives.
 * `openFootnote` takes the position of the note's definition.
 *
 * @version v1.5.0-beta
 */
import { Facet } from "@codemirror/state";
import type { SourceField } from "./panelSource";
import type { PanelPreviewConfig } from "~/lib/panel-preview-config";
export interface PanelOptions {
  footnoteName?: string;
  preview?: PanelPreviewConfig;
  openFootnote?: (definitionFrom: number) => void;
  pickImage?: (field: SourceField) => void;
  siteBaseUrl?: string | null;
}
export const panelOptions = Facet.define<PanelOptions, PanelOptions>({
  combine: (values) => Object.assign({}, ...values),
});
