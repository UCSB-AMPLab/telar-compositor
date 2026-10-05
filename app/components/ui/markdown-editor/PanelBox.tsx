/**
 * Nested panel fields edit exact source spans. Their CodeMirror views have no
 * persistence or history of their own; the parent view remains authoritative.
 *
 * A field that an opening request is waiting on (panel-click.ts,
 * `takeFieldFocus`) takes focus as it mounts.
 *
 * A field records itself with fieldFocus.ts when it takes focus, so the
 * panel editor's toolbar acts on it at its own caret. A section's or entry's
 * editor draws its footnote references as their published numbers, numbered
 * from the panel by readNotes.
 *
 * @version v1.5.0-beta
 */
import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { defaultKeymap } from "@codemirror/commands";
import { useTranslation } from "react-i18next";
import { Pencil, Check, Code, Plus, Trash2, Bold, Italic } from "lucide-react";
import { richPasteExtension } from "./richPaste";
import { livePreviewPlugin } from "./livePreviewPlugin";
import { insertMarkdownWrap } from "./commands";
import { editPanelBlock, isEditingPanelBlock } from "./panelAuthoring";
import {
  replacePanelField,
  bookmarkField,
  isCurrentFieldSnapshot,
  releaseBookmark,
  replaceBookmarkedField,
  type FieldBookmark,
  type PanelSection,
  type PanelWidget,
  type SourceField,
} from "./panelSource";
import { readNotes, type NumberedNote } from "./footnoteSyntax";
import { sameScope } from "./footnoteScopes";
import { panelOptions } from "./panelOptions";
import { WidgetPreview } from "./WidgetPreview";
import { renderPanelMath } from "./panelMath";
import { panelMarkdown } from "./panelPreview";
import { loseFocusedField, setFocusedField, type FocusedField } from "./fieldFocus";
import { fieldNoteMarks, setFieldNotes, type FieldNote } from "./noteMarks";
import { takeFieldFocus } from "~/lib/panel-click";
import { StableHtml } from "~/components/ui/StableHtml";

/** Carousel fields in the order the box offers them. */
const CAROUSEL_FIELDS = ["image", "alt", "caption", "credit", "width", "height"];
/** Carousel fields the framework converts as Markdown. */
const MARKDOWN_FIELDS = new Set(["caption", "credit"]);

function wrapKey(key: string, marker: string) {
  return {
    key,
    run: (v: EditorView) => {
      insertMarkdownWrap(v, marker);
      return true;
    },
  };
}

/** The panel's references inside `field`, as offsets in the field. */
function notesIn(view: EditorView, field: SourceField): FieldNote[] {
  const { references, notes } = readNotes(view.state);
  return references
    .filter((ref) => ref.from >= field.from && ref.to <= field.to)
    .flatMap((ref) => {
      const note = notes.find((n) => n.label === ref.label && sameScope(n.scope, ref.scope));
      if (!note || note.duplicate) return [];
      return [{ from: ref.from - field.from, to: ref.to - field.from, number: ref.number, target: note.from }];
    });
}

/** The panel's selection follows the field's caret, so the box stays open. */
function keepOuterSelection(view: EditorView, bookmark: FieldBookmark | null, child: EditorView) {
  if (bookmark?.valid) view.dispatch({ selection: { anchor: bookmark.from + child.state.selection.main.head } });
}

/** Differences between two texts as one change, or none when equal. */
function textChange(old: string, next: string) {
  if (old === next) return undefined;
  let from = 0;
  let oldTo = old.length;
  let newTo = next.length;
  while (from < oldTo && from < newTo && old[from] === next[from]) from++;
  while (oldTo > from && newTo > from && old[oldTo - 1] === next[newTo - 1]) {
    oldTo--;
    newTo--;
  }
  return { from, to: oldTo, insert: next.slice(from, newTo) };
}

/** Whether a field, as it mounts, is the one an opening request is waiting to focus. */
type TakeFocus = () => boolean;

function NestedField({ view, field, label, takeFocus }: { view: EditorView; field: SourceField; label: string; takeFocus?: TakeFocus }) {
  const { t } = useTranslation("editor");
  const mount = useRef<HTMLDivElement>(null);
  const inner = useRef<EditorView | null>(null);
  const readOnly = useRef(new Compartment());
  const latest = useRef<FieldBookmark | null>(null);
  const forwarding = useRef(false);
  const focusRecord = useRef<FocusedField | null>(null);
  const options = view.state.facet(panelOptions);

  useEffect(() => {
    if (forwarding.current || !isCurrentFieldSnapshot(view, field, latest.current)) return;
    if (latest.current) Object.assign(latest.current, field, { expected: field.value, valid: true });
    else latest.current = bookmarkField(view, field);
  }, [view, field.from, field.to, field.value]);

  useEffect(
    () => () => {
      if (latest.current) releaseBookmark(view, latest.current);
      if (focusRecord.current) loseFocusedField(view, focusRecord.current);
    },
    [view],
  );

  useEffect(() => {
    if (!mount.current) return;
    const nested = new EditorView({
      parent: mount.current,
      state: EditorState.create({
        doc: field.value,
        extensions: [
          markdown(),
          livePreviewPlugin,
          richPasteExtension,
          EditorView.lineWrapping,
          keymap.of([wrapKey("Mod-b", "**"), wrapKey("Mod-i", "_"), ...defaultKeymap]),
          ...fieldNoteMarks,
          EditorView.domEventHandlers({
            focus(_event, child) {
              focusRecord.current = { kind: "editor", view: child, bookmark: () => latest.current };
              setFocusedField(view, focusRecord.current);
              keepOuterSelection(view, latest.current, child);
              return false;
            },
            keydown(event) {
              const history = (event.metaKey || event.ctrlKey) && ["z", "y"].includes(event.key.toLowerCase());
              return history ? runScopeHandlers(view, event, "editor") : false;
            },
          }),
          EditorView.contentAttributes.of({ "aria-label": label }),
          readOnly.current.of(EditorState.readOnly.of(view.state.readOnly)),
        ],
      }),
      dispatchTransactions(transactions, child) {
        if (view.state.readOnly) return;
        const changed = transactions.some((tr) => tr.docChanged);
        const current = latest.current;
        const stale = !current?.valid || view.state.sliceDoc(current.from, current.to) !== current.expected;
        if (changed && stale) return;
        // Finish the browser's input transaction before the parent redraws its
        // decoration. Reversing this order can move Safari's DOM caret mid-input.
        forwarding.current = true;
        try {
          child.update(transactions);
          if (changed && current) {
            replaceBookmarkedField(view, current, child.state.doc.toString());
            keepOuterSelection(view, current, child);
          }
        } finally {
          forwarding.current = false;
        }
      },
    });
    inner.current = nested;
    if (takeFocus?.()) nested.focus();
    return () => {
      inner.current = null;
      nested.destroy();
    };
  }, [view]);

  useEffect(() => {
    const nested = inner.current;
    if (forwarding.current || !nested || !isCurrentFieldSnapshot(view, field, latest.current)) return;
    const notes = { notes: notesIn(view, field), name: options.footnoteName ?? "", open: (target: number) => options.openFootnote?.(target) };
    nested.update([
      nested.state.update({
        changes: textChange(nested.state.doc.toString(), field.value),
        effects: [
          readOnly.current.reconfigure(EditorState.readOnly.of(view.state.readOnly)),
          setFieldNotes.of(notes),
        ],
      }),
    ]);
  });

  return (
    <div className="cm-panel-field">
      <span>{label}</span>
      <div className="cm-panel-actions">
        <button
          type="button"
          aria-label={t("toolbar.bold")}
          disabled={view.state.readOnly}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => inner.current && insertMarkdownWrap(inner.current, "**")}
        >
          <Bold size={14} />
        </button>
        <button
          type="button"
          aria-label={t("toolbar.italic")}
          disabled={view.state.readOnly}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => inner.current && insertMarkdownWrap(inner.current, "_")}
        >
          <Italic size={14} />
        </button>
      </div>
      <div ref={mount} />
    </div>
  );
}

function TextField({
  view,
  field,
  label,
  markdown: isMarkdown = false,
  takeFocus,
}: {
  view: EditorView;
  field: SourceField;
  label: string;
  markdown?: boolean;
  takeFocus?: TakeFocus;
}) {
  const bookmark = useRef<FieldBookmark | null>(null);
  const focusRecord = useRef<FocusedField | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (takeFocus?.()) input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    bookmark.current = bookmarkField(view, field);
    return () => {
      if (bookmark.current) releaseBookmark(view, bookmark.current);
    };
  }, [view, field.from, field.to, field.value]);
  useEffect(
    () => () => {
      if (focusRecord.current) loseFocusedField(view, focusRecord.current);
    },
    [view],
  );
  return (
    <label>
      {label}
      <input
        ref={input}
        value={field.value}
        disabled={view.state.readOnly}
        onFocus={(e) => {
          focusRecord.current = { kind: "input", input: e.currentTarget, bookmark: () => bookmark.current, markdown: isMarkdown };
          setFocusedField(view, focusRecord.current);
        }}
        onChange={(e) => bookmark.current && replaceBookmarkedField(view, bookmark.current, e.target.value)}
      />
    </label>
  );
}

interface SectionProps {
  view: EditorView;
  block: PanelWidget;
  section: PanelSection;
  /** The section's place among the widget's sections. */
  index: number;
  unchanged: () => boolean;
}

/** Text written at the end of a carousel item to add a missing field. */
function missingFieldText(view: EditorView, section: PanelSection, key: string): string {
  const joined = section.to > 0 && view.state.sliceDoc(section.to - 1, section.to) !== "\n";
  return `${joined ? "\n" : ""}${key}: \n`;
}

function CarouselField({ view, block, section, index, unchanged, name }: SectionProps & { name: string }) {
  const { t } = useTranslation("editor");
  const field = section.fields?.[name];
  const locked = view.state.readOnly;
  if (!field) {
    const addMissingField = () =>
      unchanged() &&
      replacePanelField(view, { from: section.to, to: section.to }, "", missingFieldText(view, section, name));
    return (
      <button type="button" disabled={locked} onClick={addMissingField}>
        <Plus size={14} />
        {t(`panel.${name}`)}
      </button>
    );
  }
  const openImagePicker = () => unchanged() && view.state.facet(panelOptions).pickImage?.(field);
  return (
    <div>
      <TextField
        view={view}
        field={field}
        label={t(`panel.${name}`)}
        markdown={MARKDOWN_FIELDS.has(name)}
        takeFocus={() => takeFieldFocus(view, block, index, name)}
      />
      {name === "image" && (
        <button type="button" disabled={locked} onClick={openImagePicker}>
          {t("toolbar.image")}
        </button>
      )}
    </div>
  );
}

function SectionEditor(props: SectionProps) {
  const { t } = useTranslation("editor");
  const { view, block, section, index, unchanged } = props;
  const remove = () => unchanged() && replacePanelField(view, section.removal, view.state.sliceDoc(section.removal.from, section.removal.to), "");
  const bodyLabel = t(block.kind === "bibliography" ? "panel.reference" : "panel.content");
  return (
    <section>
      {section.title && <TextField view={view} field={section.title} label={t("panel.title")} />}
      {block.kind === "carousel"
        ? CAROUSEL_FIELDS.map((name) => <CarouselField key={name} {...props} name={name} />)
        : section.body && (
            <NestedField
              view={view}
              field={section.body}
              label={bodyLabel}
              takeFocus={() => takeFieldFocus(view, block, index, "body")}
            />
          )}
      <button type="button" disabled={view.state.readOnly} onClick={remove}>
        <Trash2 size={14} />
        {t("panel.remove")}
      </button>
    </section>
  );
}

/** Text that adds one more section, entry or item at the end of the body. */
function additionText(block: PanelWidget, section: string, reference: string): string {
  const empty = block.body.from === block.body.to;
  if (block.kind === "carousel") return `${block.sections.length ? "\n---\n" : ""}image: \nalt: \ncaption: \ncredit: `;
  if (block.kind === "bibliography") return empty ? reference : `\n\n${reference}`;
  return `${empty ? "" : "\n"}## ${section} ${block.sections.length + 1}\n`;
}

/** A bibliography with no entry yet still offers one empty entry to type in. */
function editableSections(block: PanelWidget): PanelSection[] {
  if (block.sections.length || block.kind !== "bibliography") return block.sections;
  const at = block.body.from;
  return [{ from: at, to: at, source: "", body: { from: at, to: at, value: "" }, removal: { from: at, to: at } }];
}

function BoxHeader({ view, block, editing }: { view: EditorView; block: PanelWidget; editing: boolean }) {
  const { t } = useTranslation("editor");
  const source = () => {
    view.dispatch({ effects: editPanelBlock.of({ from: block.from, mode: "source" }), selection: { anchor: block.from } });
    view.focus();
  };
  const changeMode = () =>
    view.dispatch({ effects: editPanelBlock.of(editing ? null : { from: block.from, mode: "edit" }) });
  const modeLabel = t(editing ? "panel.done" : "panel.edit");
  return (
    <header className="cm-panel-header">
      <span>{t(`panel.${block.kind}`)}</span>
      <div className="cm-panel-actions">
        <button type="button" onClick={changeMode} disabled={view.state.readOnly} title={modeLabel}>
          <span>{editing ? <Check size={14} /> : <Pencil size={14} />}</span>
          {modeLabel}
        </button>
        <button type="button" onClick={source} title={t("panel.source")}>
          <Code size={14} />
          {t("panel.source")}
        </button>
      </div>
    </header>
  );
}

function BoxFields({ view, block }: { view: EditorView; block: PanelWidget }) {
  const { t } = useTranslation("editor");
  const sections = editableSections(block);
  const structure = useRef({ count: sections.length, revision: 0 });
  if (structure.current.count !== sections.length)
    structure.current = { count: sections.length, revision: structure.current.revision + 1 };
  const unchanged = () =>
    isEditingPanelBlock(view, block) && view.state.sliceDoc(block.from, block.to) === block.source;
  const addSection = () => {
    if (!unchanged()) return;
    const at = { from: block.body.to, to: block.body.to };
    replacePanelField(view, at, "", additionText(block, t("panel.section"), t("panel.reference")));
  };
  return (
    <div className="cm-panel-fields">
      {sections.map((section, index) => (
        <SectionEditor
          key={`${structure.current.revision}-${index}`}
          view={view}
          block={block}
          section={section}
          index={index}
          unchanged={unchanged}
        />
      ))}
      <button type="button" disabled={view.state.readOnly} onClick={addSection}>
        <Plus size={14} />
        {t("panel.add")}
      </button>
    </div>
  );
}

export function PanelBox({
  view,
  block,
  editing,
  configKey,
}: {
  view: EditorView;
  block: PanelWidget;
  editing: boolean;
  configKey: string;
}) {
  const options = view.state.facet(panelOptions);
  return (
    <>
      <BoxHeader view={view} block={block} editing={editing} />
      {editing ? (
        <BoxFields view={view} block={block} />
      ) : (
        <WidgetPreview key={configKey} block={block} siteBaseUrl={options.siteBaseUrl} preview={options.preview} />
      )}
    </>
  );
}

export function NoteText({ source, view }: { source: string; view: EditorView }) {
  const root = useRef<HTMLDivElement>(null);
  const preview = view.state.facet(panelOptions).preview;
  useEffect(() => {
    if (root.current && preview?.available) renderPanelMath(root.current, preview.delimiters).catch(() => {});
  }, [source, preview]);
  const { t } = useTranslation("editor");
  const written = t("panel.shownAsWritten");
  return <StableHtml ref={root} html={panelMarkdown(source, undefined, written)} />;
}

export function NoteBox({ view, note }: { view: EditorView; note: NumberedNote }) {
  const { t } = useTranslation("editor");
  return (
    <div className="cm-panel-note-body">
      <sup>{note.number}</sup>
      <NoteText source={note.text} view={view} />
      <button
        type="button"
        disabled={view.state.readOnly}
        aria-label={t("panel.edit")}
        onClick={() => view.state.facet(panelOptions).openFootnote?.(note.from)}
      >
        <Pencil size={14} />
      </button>
      <button
        type="button"
        aria-label={t("panel.source")}
        onClick={() => {
          view.dispatch({ selection: { anchor: note.from }, scrollIntoView: true });
          view.focus();
        }}
      >
        <Code size={14} />
      </button>
    </div>
  );
}
