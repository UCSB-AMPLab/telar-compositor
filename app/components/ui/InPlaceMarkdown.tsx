/**
 * InPlaceMarkdown — Markdown shown rendered, edited in place: activating the
 * rendered block swaps in a MarkdownEditor holding the source, focused with
 * the caret at the end; focus leaving the editor, its toolbar and every
 * popover and dialog opened from it (the editor's focus scope), or Escape in
 * its text, shows the rendering again. The draft, the save and the block's
 * keyboard and pointer behaviour are in-place-editing.tsx.
 *
 * `render` turns the Markdown into HTML for the block and must return it
 * sanitised; it is inserted as it comes. The default is the Compositor's
 * existing preview rendering, `marked` with GFM through `sanitiseHtml`.
 *
 * The editor runs in its `controlled` mode: without a Y.Text it saves
 * nothing itself, and each change goes to the draft this component holds.
 * Escape counts only in the editor's own text; a popover or dialog opened
 * from the editor, portalled elsewhere, answers Escape for itself.
 *
 * @version v1.5.0-beta
 */
import { useMemo, useRef, type KeyboardEvent } from "react";
import { marked } from "marked";
import { sanitiseHtml } from "~/lib/sanitise-html";
import { MarkdownEditor, type MarkdownEditorProps } from "~/components/ui/MarkdownEditor";
import { StableHtml } from "~/components/ui/StableHtml";
import {
  InPlaceBlock,
  InPlaceSaveError,
  useInPlaceEditing,
  type InPlaceCommonProps,
} from "~/components/ui/in-place-editing";

/** Markdown to sanitised HTML, as the Compositor's previews render it. */
export function renderPreviewMarkdown(markdown: string): string {
  return sanitiseHtml(marked.parse(markdown, { async: false, gfm: true }) as string);
}

type EditorPassThrough = Omit<
  MarkdownEditorProps,
  "initialValue" | "yText" | "mode" | "onChange" | "autoFocus" | "onFocusLeave" | "placeholder"
>;

export interface InPlaceMarkdownProps extends InPlaceCommonProps {
  /** Markdown to sanitised HTML for the block. */
  render?: (markdown: string) => string;
  /** Passed to the MarkdownEditor: toolbar options, glossary links, objects. */
  editorProps?: Partial<EditorPassThrough>;
}

export function InPlaceMarkdown(props: InPlaceMarkdownProps) {
  const { render = renderPreviewMarkdown, editorProps, placeholder, fieldKey, label, className, yText } = props;
  const editing = useInPlaceEditing(props);
  const { binding } = editing;
  const html = useMemo(() => render(binding.value), [render, binding.value]);
  const textRef = useRef<HTMLDivElement>(null);

  if (!editing.editing) {
    return (
      <InPlaceBlock
        editing={editing}
        empty={!binding.value.trim()}
        placeholder={placeholder}
        label={label}
        className={className}
        fieldKey={fieldKey}
      >
        <StableHtml html={html} />
      </InPlaceBlock>
    );
  }

  const escapeFromText = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    if (!textRef.current?.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    editing.done("escape");
  };

  return (
    <div ref={textRef} onKeyDown={escapeFromText}>
      <MarkdownEditor
        fieldName=""
        projectId={0}
        {...editorProps}
        initialValue={binding.value}
        yText={yText}
        mode="controlled"
        onChange={yText ? undefined : binding.handleChange}
        placeholder={placeholder}
        autoFocus
        onFocusLeave={() => editing.done("blur")}
      />
      <InPlaceSaveError editing={editing} />
    </div>
  );
}
