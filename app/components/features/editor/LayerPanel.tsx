/**
 * LayerPanel — what a layer panel on the stage holds, as the published page
 * draws it (the framework `_includes/panels.html`, `getPanelContent` in
 * assets/js/telar-story/panels.js): the heading, the content, and on layer 1
 * the button that opens layer 2. The panel's frame, its Back, close and
 * delete buttons, and where it stands are StagePanels'.
 *
 * The heading is `h1.offcanvas-title`, focusable by script only
 * (`tabIndex=-1`), so it can take focus as the panel opens. It holds the
 * title edited in place: the title as the reader sees it, which opens its
 * field, and beside it the pencil, in its own `span.stage-field-pencil`, as
 * the card's question has one. A panel with no title of its own is headed as
 * the site heads it (`panelHeading`: its button label, else the site
 * language's default label), shown muted in the title's place; opening the
 * field then starts it empty, and finishing it unedited stores nothing. A
 * stored title is shown whatever it says, a default label included, since an
 * author may have written it.
 *
 * Layer 1's content ends with layer 2's button, as the site draws it, with a
 * pencil that edits its label in place, as the card's button has; or, with
 * no layer 2, the dashed button that adds one. There is no other place to
 * edit a button's label in a panel: layer 1's is edited on the card.
 *
 * With a Y.Text a field writes to it as it is typed, as the card's fields
 * do. Without one it saves through `saveField` (the stage's `autosave-layer`
 * save, which outlives the panel), and a save that is refused or fails keeps
 * the field open with `saveErrorMessage`, and the draft kept under the
 * field's recovery key once the field has gone (in-place-editing.tsx). A
 * layer with no database id yet has nothing to save to without a Y.Text.
 *
 * A panel held in the editor until its first content (`writeUnsaved`)
 * writes its fields there, and offers no layer 2 until it is written.
 *
 * The content is PanelContent's: drawn as the site renders it, opened into
 * the editor to be edited, and without a Y.Text saved through the stage's
 * owner of layer content (`contentDrafts`), which outlives the panel.
 *
 * @version v1.5.0-beta
 */

import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import { PanelContent } from "~/components/features/editor/PanelContent";
import { DocsLink } from "~/components/ui/DocsLink";
import { ReportedText } from "~/components/features/editor/StepCard";
import type { StagePanelLayer } from "~/components/features/editor/StagePanels";
import type { PanelPreviewConfig, PanelPreviewSource } from "~/lib/panel-preview-config";
import type { GlossaryContext } from "~/lib/card-markdown";
import { derivedHeadingOf } from "~/lib/panel-heading";
import type { LayerContentDrafts } from "~/hooks/use-layer-content-drafts";
import type { FieldSaveOptions } from "~/hooks/use-route-field-save";

/** A text field of a layer that a panel edits in place. */
export type LayerTextField = "title" | "button_label";

/** How a panel's fields save without a Y.Text, and what they are given. */
export interface LayerFieldSaves {
  /**
   * Saves a field of a layer, resolving with the answer's confirmation stamp;
   * rejects for a layer with no database id.
   */
  save: (layer: StagePanelLayer, field: LayerTextField, value: string, options?: FieldSaveOptions) => Promise<number | undefined>;
  /** The value a field may be given, which a read older than its last save does not replace. */
  fresh: (layer: StagePanelLayer, field: LayerTextField, value: string) => string;
  /** Where a failed draft of a field is kept, for a layer with a database id. */
  recoveryKey: (layer: StagePanelLayer, field: LayerTextField) => string | undefined;
  /** Shown under a field whose save failed. */
  saveErrorMessage: string;
}

interface LayerPanelProps {
  layer: StagePanelLayer;
  /** The panel's heading, which takes focus as the panel opens. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
  /** The site's `telar_language`, whose default labels head an untitled panel. */
  siteLang?: string | null;
  /** The panel is covered by the one over it: its editor's popovers and menus close. */
  dismissed?: boolean;
  /** Layer 2, on layer 1's panel. */
  layer2?: StagePanelLayer | null;
  onCreateLayer2?: () => void;
  /** Opens layer 2, from the button pressed. */
  onOpenLayer2?: (opener: HTMLElement) => void;
  fields: LayerFieldSaves;
  /** The stage's owner of layer content without a Y.Text. */
  contentDrafts: LayerContentDrafts;
  /** When the loader read the layer. */
  readStamp?: number;
  /** The site's glossary, which the rendered content resolves its links against. */
  glossary: GlossaryContext;
  /** The site's preview configuration, once it has arrived. */
  previewConfig?: PanelPreviewConfig;
  /** A request to highlight the content's first glossary link, by its id. */
  highlight?: number | null;
  onHighlighted?: (id: number) => void;
  objects: Array<{ object_id: string; title: string | null; thumbnail: string | null; image_available?: boolean | null; source_url: string | null }>;
  siteBaseUrl?: string | null;
  /** The site's `telar_version`, which the image dialog builds a self-hosted object's address by. */
  frameworkVersion?: string | null;
  /** The site's widget and formula preview settings, as the loader streams them. */
  panelPreview?: PanelPreviewSource;
  actionUrl: string;
  /** Callback to open the in-product docs drawer — threaded from the _app shell via outlet context. */
  onOpenDoc?: (id: string) => void;
}

export function LayerPanel({
  layer,
  headingRef,
  siteLang,
  dismissed = false,
  layer2 = null,
  onCreateLayer2,
  onOpenLayer2,
  fields,
  contentDrafts,
  readStamp,
  glossary,
  previewConfig,
  highlight,
  onHighlighted,
  objects,
  siteBaseUrl,
  frameworkVersion,
  panelPreview,
  actionUrl,
  onOpenDoc,
}: LayerPanelProps) {
  const { t } = useTranslation("editor");
  const isLayer1 = layer.layer_number === 1;
  const titleTarget = `layer:${layer.key}:title`;

  return (
    <>
      <h1 ref={headingRef} tabIndex={-1} className="offcanvas-title">
        <ReportedText
          target={titleTarget}
          yText={layer.titleYText}
          initialValue={fields.fresh(layer, "title", layer.title ?? "")}
          placeholder={derivedHeadingOf(layer.layer_number, layer.button_label, siteLang)}
          label={t("layer.panel_title_aria")}
          fieldKey={`layer-${layer.key}-title`}
          onSave={layer.titleYText ? undefined : saveOf(layer, "title", fields)}
          saveErrorMessage={fields.saveErrorMessage}
          recoveryKey={fields.recoveryKey(layer, "title")}
          pencilLabel={t("stage.edit_panel_title")}
        />
      </h1>

      <div className="stage-panel-content">
        {onOpenDoc && (
          <div className="flex justify-end mb-1">
            <DocsLink docId="markdown" onOpenDoc={onOpenDoc} className={isLayer1 ? "" : "!text-cream/70 hover:!text-cream"} />
          </div>
        )}
        <PanelContent
          layer={layer}
          drafts={contentDrafts}
          readStamp={readStamp}
          glossary={glossary}
          previewConfig={previewConfig}
          highlight={highlight}
          onHighlighted={onHighlighted}
          dismissed={dismissed}
          objects={objects}
          siteBaseUrl={siteBaseUrl}
          frameworkVersion={frameworkVersion}
          panelPreview={panelPreview}
          actionUrl={actionUrl}
        />

        {isLayer1 && !layer.writeUnsaved && (
          <p className="stage-panel-next">
            {layer2 ? (
              <Layer2Button layer2={layer2} fields={fields} siteLang={siteLang} onOpen={onOpenLayer2} />
            ) : (
              <button type="button" className="stage-panel-add" onClick={onCreateLayer2}>
                {t("layer.add_further_panel")}
              </button>
            )}
          </p>
        )}
      </div>
    </>
  );
}

/** How a field without a Y.Text saves: to the held panel, else through the stage. */
function saveOf(layer: StagePanelLayer, field: LayerTextField, fields: LayerFieldSaves) {
  const writeUnsaved = layer.writeUnsaved;
  return writeUnsaved ? (value: string) => writeUnsaved(field, value) : (value: string) => fields.save(layer, field, value);
}

/**
 * Layer 2's button at the end of layer 1's content, as the site draws it,
 * with the pencil beside it that edits its label in place, as the card's
 * button has (StepCard's PanelButton): the same opener pattern, writing
 * layer 2's `button_label`.
 */
function Layer2Button({
  layer2,
  fields,
  siteLang,
  onOpen,
}: {
  layer2: StagePanelLayer;
  fields: LayerFieldSaves;
  siteLang?: string | null;
  onOpen?: (opener: HTMLElement) => void;
}) {
  const { t } = useTranslation("editor");
  const placeholder = derivedHeadingOf(2, null, siteLang);
  return (
    <ReportedText
      target={`layer:${layer2.key}:button_label`}
      yText={layer2.buttonLabelYText}
      initialValue={fields.fresh(layer2, "button_label", layer2.button_label ?? "")}
      placeholder={placeholder}
      label={t("layer.edit_button_label_aria")}
      fieldKey={`layer-${layer2.key}-button_label`}
      onSave={layer2.buttonLabelYText ? undefined : saveOf(layer2, "button_label", fields)}
      saveErrorMessage={fields.saveErrorMessage}
      recoveryKey={fields.recoveryKey(layer2, "button_label")}
      className="ml-1 inline-flex items-center p-1 rounded opacity-70 hover:opacity-100 transition-opacity cursor-pointer!"
      opener={{
        content: <Pencil className="w-3 h-3" aria-hidden="true" />,
        around: (value, pencil) => (
          <>
            <button type="button" data-layer2-pill="" className="panel-trigger text-left" onClick={(e) => onOpen?.(e.currentTarget)}>
              {value || placeholder}
              <span aria-hidden="true"> →</span>
            </button>
            <span className="inline-flex items-center w-0 h-0 align-middle whitespace-nowrap" data-stage-pencil={t("layer.edit_button_label")}>
              {pencil}
            </span>
          </>
        ),
      }}
    />
  );
}
