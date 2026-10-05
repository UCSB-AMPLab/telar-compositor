/**
 * PanelContent — a layer panel's content on the stage: drawn as a reader of
 * the site is shown it (PanelRendering), and opened into the layer panel's
 * Markdown editor to be edited.
 *
 * Closed, the content is one focusable block named for editing it, holding
 * the rendered text and its widgets. It is not a button: each widget keeps
 * its own controls and roles, and they never open the editor. Any other
 * click opens it at the place clicked (panel-click.ts); a modified click on
 * an ordinary link follows the link instead, and a glossary link never
 * navigates. Enter or Space on the block itself opens the editor at the
 * start; a key a widget handles does not reach it. The opening is applied
 * once, to the editor's first view, and goes with the editor when it
 * closes. While a publish holds
 * the document, nothing opens the editor and the block says it is disabled.
 * An empty panel shows a placeholder, muted. The site's preview notices sit
 * above the content whether it is open or not.
 *
 * Open, it is the editor the panel has always had: its toolbar, widget boxes,
 * field formatting, popovers and word count. Focus leaving the editor and
 * everything opened from it closes it again, unless its last save failed;
 * so does the panel being covered, whatever the save did, without moving
 * focus. While the editor has focus, the author's awareness location names
 * the content (`layer-{key}-content`), as the inline fields' do.
 *
 * With a Y.Text the editor is bound to it and the text is saved as it is
 * typed. Without one the content belongs to the stage's owner
 * (use-layer-content-drafts.ts): the editor is controlled, reports each
 * change to the owner, and opens on what the owner says the layer holds, so
 * a pending or failed draft outlives the editor, and the closed block shows
 * the same text. A draft the owner still holds when the shared text takes
 * over, and that no send carried, is offered under the content to apply to
 * the shared text or discard. The editor closing, the panel being covered
 * and the step changing each send a draft the owner is still holding. A
 * save that failed is said under the open editor, with Retry, in the
 * editor's own slot inside its focus scope; closed, the block says a draft
 * is waiting. An editor opened on a failed draft also offers Discard,
 * which sets the draft back and closes the editor, so the discarded text
 * cannot come back with a keystroke; it does nothing while a save is out.
 *
 * A panel held in the editor until its first content (`writeUnsaved`) is
 * edited as the owner's is, controlled, each change written to the held
 * panel; the first content writes it to the document, and the shared text
 * then replaces the editor's own. While a publish holds the document the
 * editor is read-only, as the shared text's is.
 *
 * A layer with no database id and no Y.Text has nowhere to save to: its
 * content is shown and cannot be opened, rather than accepting text it
 * would drop.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { PanelPreviewNotice } from "~/components/ui/markdown-editor/PanelPreviewNotice";
import { KeptDraftNotice } from "~/components/ui/markdown-editor/KeptDraftNotice";
import { presenceOutline, usePresenceColour } from "~/components/ui/in-place-editing";
import type { StagePanelLayer } from "~/components/features/editor/StagePanels";
import { PanelRendering, usePanelGeneration } from "~/components/features/editor/PanelRendering";
import { useLayerContent, type LayerContentDrafts, type LayerContentView } from "~/hooks/use-layer-content-drafts";
import { useCollaborativeText } from "~/hooks/use-collaborative-text";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { holdGlossaryLinks } from "~/lib/glossary-links";
import type { GlossaryContext, RenderedPanel } from "~/lib/card-markdown";
import type { GlossaryTerms } from "~/lib/glossary-links";
import { applyOpeningRequest, requestFromClick, startRequest, type OpeningRequest } from "~/lib/panel-click";
import type { PanelPreviewConfig, PanelPreviewSource } from "~/lib/panel-preview-config";

export interface PanelContentProps {
  layer: StagePanelLayer;
  /** The stage's owner of content without a Y.Text. */
  drafts: LayerContentDrafts;
  /** When the loader read the layer's content. */
  readStamp?: number;
  /** The panel is covered by the one over it. */
  dismissed?: boolean;
  /** The site's glossary, which the rendered text resolves its links against. */
  glossary: GlossaryContext;
  /** The site's preview configuration, once it has arrived. */
  previewConfig?: PanelPreviewConfig;
  /** A request, by its id, to scroll to and highlight the first glossary link once the content has rendered. */
  highlight?: number | null;
  /** Called with the request's id once it is done, whether or not there was a link. */
  onHighlighted?: (id: number) => void;
  objects: Array<{ object_id: string; title: string | null; thumbnail: string | null; image_available?: boolean | null; source_url: string | null }>;
  siteBaseUrl?: string | null;
  /** The site's framework version, which decides the ids its images are published under. */
  frameworkVersion?: string | null;
  panelPreview?: PanelPreviewSource;
  actionUrl: string;
}

/** Under the open editor: a failed save, Retry, and Discard for an editor opened on a failed draft. */
function ContentSaveFailure({
  view,
  offerDiscard,
  onRetry,
  onDiscard,
}: {
  view: LayerContentView;
  offerDiscard: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation("editor");
  if (!view.failed) return null;
  return (
    <div data-testid="content-save-failure" className="font-body text-xs mt-1">
      <p role="alert" data-testid="editor-save-error" className="text-terracotta">
        {t("stage.save_failed")}
      </p>
      <div className="flex gap-3 mt-1">
        <button type="button" className="underline" onClick={onRetry}>
          {t("in_place.recovered_retry")}
        </button>
        {offerDiscard && (
          <button
            type="button"
            aria-disabled={view.sending || undefined}
            className={view.sending ? "opacity-50 cursor-not-allowed" : "underline"}
            onClick={onDiscard}
          >
            {t("in_place.recovered_discard")}
          </button>
        )}
      </div>
    </div>
  );
}

/** A panel's footnote anchors, apart from every other panel's on the page. */
function anchorOf(layer: StagePanelLayer): string {
  return `panel-${layer.layer_number}-${layer.key.replace(/[^\w-]/g, "")}`;
}

/** One opening of the editor. */
interface Opening {
  n: number;
  /** The editor opened on a failed draft, and so offers Discard. */
  onFailure: boolean;
  /** Where the editor opens, applied once to its first view. */
  request: OpeningRequest;
}

/** The content's text as the panel shows it, and who saves it. */
function useContentText(layer: StagePanelLayer, drafts: LayerContentDrafts, readStamp: number | undefined) {
  useLayerContent(drafts);
  const yText = layer.contentYText;
  const loaded = layer.content ?? "";
  const shared = useCollaborativeText(yText, loaded);
  const owned = !yText && layer.id > 0 ? drafts : null;
  const view = owned ? owned.view(layer.id, loaded, readStamp) : null;
  const value = yText ? shared.value : (view?.value ?? loaded);
  return { yText, owned, view, value, editable: canEditContent(layer), kept: keptOver(layer, drafts, shared.value) };
}

/** Whether the content has somewhere to save to: the shared text, the owner, or the held panel. */
function canEditContent(layer: StagePanelLayer): boolean {
  return !!layer.contentYText || layer.id > 0 || !!layer.writeUnsaved;
}

/** The draft the owner kept when the shared text took over, while the shared text does not hold it. */
function keptOver(layer: StagePanelLayer, drafts: LayerContentDrafts, sharedValue: string) {
  const target = layer.contentYText;
  const text = target && layer.id > 0 ? drafts.keptAfterTakeOver(layer.id) : null;
  return target && text !== null && text !== sharedValue ? { text, target } : null;
}

/**
 * The editor's openings: opening one, closing it (sending what the owner
 * holds back), Discard, and the closings that come from outside: the panel
 * covered or gone, and the shared text taking over.
 */
function useEditorOpenings({
  layer,
  drafts,
  owned,
  view,
  canOpen,
  dismissed,
}: {
  layer: StagePanelLayer;
  drafts: LayerContentDrafts;
  owned: LayerContentDrafts | null;
  view: LayerContentView | null;
  canOpen: boolean;
  dismissed: boolean;
}) {
  const [open, setOpen] = useState<Opening | null>(null);
  const openings = useRef(0);
  const latest = useRef({ open, owned, id: layer.id, view, canOpen });
  latest.current = { open, owned, id: layer.id, view, canOpen };

  const openEditor = (request: OpeningRequest) => {
    if (!latest.current.canOpen || latest.current.open) return;
    openings.current += 1;
    setOpen({ n: openings.current, onFailure: !!latest.current.view?.failed, request });
  };

  const closeEditor = () => {
    latest.current.owned?.flush(latest.current.id);
    setOpen(null);
  };

  const discardDraft = () => {
    if (latest.current.owned?.discard(latest.current.id)) setOpen(null);
  };

  const yText = layer.contentYText;
  // The shared text takes over from the owner as soon as it arrives.
  useEffect(() => {
    if (yText && layer.id > 0) drafts.takeOver(layer.id);
  }, [yText, drafts, layer.id]);

  // Covering the panel closes the editor, whatever its save did, and takes no focus.
  useEffect(() => {
    if (dismissed && latest.current.open) closeEditor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissed]);

  // The panel going (a close, or the step changing) sends what is held back.
  useEffect(
    () => () => {
      const { open: wasOpen, owned: owner, id } = latest.current;
      if (wasOpen) owner?.flush(id);
    },
    [],
  );

  // Focus leaving closes the editor, unless its last save failed.
  const leaveEditor = () => {
    if (!latest.current.view?.failed) closeEditor();
  };

  return { open, openEditor, discardDraft, leaveEditor };
}

/** Whether a rendering shows nothing: no text and no widget. */
function isEmptyRendering(rendered: { html: string; widgets: unknown[] }): boolean {
  return !rendered.html.trim() && rendered.widgets.length === 0;
}

const PULSE_MS = 2400;

/** Scrolls to and highlights `link` for `ms`, unless it is highlighted already. */
function pulse(link: HTMLElement, ms: number) {
  if (link.classList.contains("glossary-link-pulse")) return;
  link.scrollIntoView?.({ behavior: "smooth", block: "center" });
  link.classList.add("glossary-link-pulse");
  setTimeout(() => link.classList.remove("glossary-link-pulse"), ms);
}

/** A generation of the rendering, once in the page. */
interface Shown {
  generation: number;
  element: HTMLElement;
}

/**
 * The current rendering's first glossary link, or null for none; nothing at
 * all while there is no current rendering to look in (the editor is open, or
 * the generation has not reported yet).
 */
function firstGlossaryLink(shown: Shown | null, generation: number, waiting: boolean, empty: boolean): { link: HTMLElement | null } | null {
  if (waiting) return null;
  const element = shown?.generation === generation ? shown.element : null;
  if (!element) return empty ? { link: null } : null;
  return { link: element.querySelector<HTMLElement>("a.glossary-inline-link") };
}

/** A highlight still lasting is put back on the link a new rendering drew. */
function renewPulse(link: HTMLElement | null, lastsUntil: { current: number }) {
  const left = lastsUntil.current - Date.now();
  if (link && left > 0) pulse(link, left);
}

/** Highlights the link, if there is one, and answers the request. */
function answerHighlight(highlight: number, link: HTMLElement | null, lastsUntil: { current: number }, onHighlighted?: (id: number) => void) {
  if (link) {
    lastsUntil.current = Date.now() + PULSE_MS;
    pulse(link, PULSE_MS);
  }
  onHighlighted?.(highlight);
}

/**
 * The glossary jump. A request waits for a rendering made with what it
 * depends on (the glossary's terms and the site's preview configuration),
 * unless a glossary link is in view sooner; then the first glossary link is
 * highlighted and the request answered, and an empty panel answers at once.
 * While the highlight lasts, a later generation replacing the rendering (the
 * configuration arriving, say) gets it again. Returns what the rendering
 * reports each generation to.
 */
function useGlossaryHighlight({
  highlight,
  waiting,
  empty,
  generation,
  ready,
  onHighlighted,
}: {
  highlight: number | null;
  /** The editor is open: there is no rendered text to highlight yet. */
  waiting: boolean;
  empty: boolean;
  generation: number;
  /** The rendering was made with the glossary's terms and the preview configuration. */
  ready: boolean;
  onHighlighted?: (id: number) => void;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const lastsUntil = useRef(0);
  useEffect(() => {
    const seen = firstGlossaryLink(shown, generation, waiting, empty);
    if (!seen) return;
    if (highlight === null) renewPulse(seen.link, lastsUntil);
    else if (seen.link || ready || empty) answerHighlight(highlight, seen.link, lastsUntil, onHighlighted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight, shown, waiting, empty, ready]);
  return (rendered: number, element: HTMLElement) => setShown({ generation: rendered, element });
}

/**
 * Whether a click on the rendered text is left alone: a modified click on an
 * ordinary link follows it, and a widget's controls are the widget's. A
 * glossary link is never followed, and a plain click on any link edits.
 */
function clickStaysOutside(event: MouseEvent<HTMLDivElement>): boolean {
  holdGlossaryLinks(event);
  const target = event.target as Element;
  const link = target.closest("a");
  if (link && !link.classList.contains("glossary-inline-link") && (event.metaKey || event.ctrlKey)) return true;
  if (link) event.preventDefault();
  return !!target.closest(".telar-widget button, .telar-widget [role='tab']");
}

/** Where a click on the rendered text opens the editor. */
function requestForClick(event: MouseEvent<HTMLDivElement>, value: string, rendered: Pick<RenderedPanel, "widgets" | "callouts">, terms: GlossaryTerms): OpeningRequest {
  const prose = event.currentTarget.querySelector<HTMLElement>("[data-panel-prose]");
  if (!prose) return startRequest(value);
  const { widgets, callouts } = rendered;
  return requestFromClick(event.target as Element, { x: event.clientX, y: event.clientY }, { value, widgets, callouts, prose, terms });
}

/** Enter or Space on the block itself, not on anything inside it. */
function isOpeningKey(event: KeyboardEvent<HTMLDivElement>): boolean {
  return event.target === event.currentTarget && (event.key === "Enter" || event.key === " ");
}

export function PanelContent({
  layer,
  drafts,
  readStamp,
  dismissed = false,
  glossary,
  previewConfig,
  highlight = null,
  onHighlighted,
  objects,
  siteBaseUrl,
  frameworkVersion,
  panelPreview,
  actionUrl,
}: PanelContentProps) {
  const { t } = useTranslation("editor");
  const { isPublishing } = useCollaborationContext();
  const { owned, view, value, editable, kept } = useContentText(layer, drafts, readStamp);
  const fieldKey = `layer-${layer.key}-content`;
  const colour = usePresenceColour(fieldKey);
  const disabled = !editable || isPublishing;
  const { open, openEditor, discardDraft, leaveEditor } = useEditorOpenings({ layer, drafts, owned, view, canOpen: !disabled, dismissed });

  const rendered = usePanelGeneration({ value, anchor: anchorOf(layer), glossary, config: previewConfig, siteBaseUrl });
  const empty = isEmptyRendering(rendered);
  const failed = view?.failed === true;
  const ready = glossary.terms.size > 0 && previewConfig !== undefined;
  const onRendered = useGlossaryHighlight({ highlight, waiting: !!open, empty, generation: rendered.generation, ready, onHighlighted });

  const openFromClick = (event: MouseEvent<HTMLDivElement>) => {
    if (clickStaysOutside(event)) return;
    openEditor(requestForClick(event, value, rendered, glossary.terms));
  };

  const openFromKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isOpeningKey(event)) return;
    event.preventDefault();
    openEditor(startRequest(value));
  };

  return (
    <div className="stage-panel-body">
      <PanelPreviewNotice preview={previewConfig} />
      {open ? (
        <OpenContent
          open={open}
          layer={layer}
          owned={owned}
          view={view}
          value={value}
          fieldKey={fieldKey}
          dismissed={dismissed}
          onDiscard={discardDraft}
          onLeave={leaveEditor}
          editorProps={{ objects, siteBaseUrl, frameworkVersion, panelPreview, actionUrl }}
        />
      ) : (
        <div
          role="group"
          tabIndex={0}
          aria-label={t("stage.edit_panel_text")}
          aria-disabled={disabled || undefined}
          data-panel-content=""
          data-recovered={failed || undefined}
          className={`stage-panel-text panel-widgets panel-widgets-layer${layer.layer_number}`}
          style={presenceOutline(colour)}
          onClick={openFromClick}
          onKeyDown={openFromKey}
        >
          <RenderedContent
            empty={empty}
            rendered={rendered}
            glossary={glossary}
            config={previewConfig}
            siteBaseUrl={siteBaseUrl}
            onRendered={onRendered}
            waiting={failed}
          />
        </div>
      )}
      {kept && <KeptDraftNotice draft={kept.text} target={kept.target} disabled={isPublishing} onClose={() => drafts.discard(layer.id)} />}
    </div>
  );
}

/**
 * The open content: the layer panel's editor, controlled by the owner when
 * the content has no Y.Text, with a failed save said in its slot.
 */
function OpenContent({
  open,
  layer,
  owned,
  view,
  value,
  fieldKey,
  dismissed,
  onDiscard,
  onLeave,
  editorProps,
}: {
  open: Opening;
  layer: StagePanelLayer;
  owned: LayerContentDrafts | null;
  view: LayerContentView | null;
  value: string;
  fieldKey: string;
  dismissed: boolean;
  onDiscard: () => void;
  onLeave: () => void;
  editorProps: Pick<PanelContentProps, "objects" | "siteBaseUrl" | "frameworkVersion" | "panelPreview" | "actionUrl">;
}) {
  const unsaved = layer.contentYText ? undefined : layer.writeUnsaved;
  const footer = view && (
    <ContentSaveFailure view={view} offerDiscard={open.onFailure} onRetry={() => owned?.retry(layer.id)} onDiscard={onDiscard} />
  );
  return (
    <MarkdownEditor
      key={open.n}
      {...editorProps}
      initialValue={value}
      fieldName="content"
      projectId={layer.id}
      formFieldName="layerId"
      intent="autosave-layer"
      mode={owned || unsaved ? "controlled" : "autosave"}
      onChange={owned ? (next) => owned.edit(layer.id, next) : unsaved && ((next) => unsaved("content", next))}
      lockWhilePublishing={!!unsaved}
      autoFocus
      showWordCount
      placeCaret={(editor) => applyOpeningRequest(editor, open.request)}
      onFocusLeave={onLeave}
      presenceKey={fieldKey}
      yText={layer.contentYText}
      transparent
      darkTheme={layer.layer_number === 2}
      enableGlossaryLinks
      enableFootnotes
      enablePanelAuthoring
      dismissed={dismissed}
      footer={footer}
    />
  );
}

/** The closed content: the rendering or the placeholder, and a waiting draft's marker. */
function RenderedContent({
  empty,
  waiting,
  ...rendering
}: ComponentProps<typeof PanelRendering> & { empty: boolean; waiting: boolean }) {
  const { t } = useTranslation("editor");
  return (
    <>
      {empty ? <p className="text-gray-400">{t("stage.panel_text_placeholder")}</p> : <PanelRendering {...rendering} />}
      {waiting && (
        <span data-in-place-marker="" className="block font-body text-xs mt-1 text-terracotta">
          {t("in_place.recovered_marker")}
        </span>
      )}
    </>
  );
}
