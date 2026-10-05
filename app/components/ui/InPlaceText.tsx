/**
 * InPlaceText — plain text shown as it reads, edited in place: activating
 * the rendered block swaps in an InlineTextField, or an InlineTextArea when
 * `multiline`, focused and sized to its text; finishing the field shows the
 * text again. The draft, the save and the block's keyboard and pointer
 * behaviour are in-place-editing.tsx.
 *
 * `renderValue` draws the value in the block; by default it is the text
 * itself.
 *
 * @version v1.5.0-beta
 */
import type { ReactNode } from "react";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { InlineTextArea, type InlineTextAreaProps } from "~/components/ui/InlineTextArea";
import {
  InPlaceBlock,
  InPlaceSaveError,
  useInPlaceEditing,
  type InPlaceCommonProps,
} from "~/components/ui/in-place-editing";

export interface InPlaceTextProps extends InPlaceCommonProps {
  /** Edit in a textarea rather than a single-line input. */
  multiline?: boolean;
  /** Draws the value in the block. */
  renderValue?: (value: string) => ReactNode;
  /** Passed to the field: the answer's word counter and text-only rule, rows, borders. */
  fieldProps?: Pick<InlineTextAreaProps, "answerLength" | "textOnly" | "rows" | "bordered" | "inputClassName">;
}

export function InPlaceText(props: InPlaceTextProps) {
  const { multiline, renderValue, fieldProps = {}, placeholder, fieldKey, label, className, yText, initialValue } = props;
  const editing = useInPlaceEditing(props);
  const { binding } = editing;

  if (!editing.editing) {
    return (
      <InPlaceBlock
        editing={editing}
        empty={!binding.value}
        placeholder={placeholder}
        label={label}
        className={className}
        fieldKey={fieldKey}
      >
        {renderValue ? renderValue(binding.value) : binding.value}
      </InPlaceBlock>
    );
  }

  const shared = {
    initialValue,
    yText,
    binding,
    fieldKey,
    placeholder,
    autoFocus: true,
    grow: true,
    onDone: editing.done,
  };
  return (
    <div>
      {multiline ? (
        <InlineTextArea {...shared} {...fieldProps} />
      ) : (
        <InlineTextField
          {...shared}
          bordered={fieldProps.bordered}
          inputClassName={fieldProps.inputClassName}
        />
      )}
      <InPlaceSaveError editing={editing} />
    </div>
  );
}
