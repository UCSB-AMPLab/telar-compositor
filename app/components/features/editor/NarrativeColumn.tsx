/**
 * NarrativeColumn — switches between TitleCardView (step 0) and StepView (step 1-N).
 *
 * Receives story, active step, layers, and Y.Text instances from the editor route.
 * Renders TitleCardView when activeStepIndex === 0, StepView otherwise.
 * Forwards Y.Text props and callbacks to TitleCardView and StepView so both
 * components write directly to the Yjs document instead of HTTP autosave.
 */

import * as Y from "yjs";
import { TitleCardView } from "~/components/features/editor/TitleCardView";
import { StepView } from "~/components/features/editor/StepView";

interface NarrativeColumnProps {
  activeStepIndex: number;
  storyId: string;
  story: {
    id: number;
    title: string | null;
    subtitle: string | null;
    byline: string | null;
    order: number | null;
    show_sections: boolean;
  };
  activeStep: {
    id: number;
    step_number: number;
    question: string | null;
    answer: string | null;
    alt_text: string | null;
  } | null;
  layers: Array<{
    id: number;
    step_id: number;
    layer_number: number;
    title: string | null;
    button_label: string | null;
    content: string | null;
  }>;
  onOpenLayer: (layer: {
    id: number;
    layer_number: number;
    title: string | null;
    button_label: string | null;
    content: string | null;
  }) => void;
  onCreateLayer: (stepId: number, layerNumber: number, defaultLabel: string) => void;
  actionUrl: string;
  isFirstStep?: boolean;
  // Y.Text props for TitleCardView
  titleYText: Y.Text | null;
  subtitleYText: Y.Text | null;
  bylineYText: Y.Text | null;
  // show_sections plumbing for TitleCardView
  sectionCardCount: number;
  onToggleShowSections: (value: boolean) => void;
  // Y.Text props for StepView
  questionYText: Y.Text | null;
  answerYText: Y.Text | null;
  altTextYText: Y.Text | null;
}

export function NarrativeColumn({
  activeStepIndex,
  storyId,
  story,
  activeStep,
  layers,
  onOpenLayer,
  onCreateLayer,
  actionUrl,
  isFirstStep,
  titleYText,
  subtitleYText,
  bylineYText,
  sectionCardCount,
  onToggleShowSections,
  questionYText,
  answerYText,
  altTextYText,
}: NarrativeColumnProps) {
  if (activeStepIndex === 0) {
    return (
      <TitleCardView
        story={story}
        storyId={storyId}
        titleYText={titleYText}
        subtitleYText={subtitleYText}
        bylineYText={bylineYText}
        sectionCardCount={sectionCardCount}
        onToggleShowSections={onToggleShowSections}
      />
    );
  }

  if (!activeStep) return null;

  return (
    <StepView
      step={activeStep}
      layers={layers}
      onOpenLayer={onOpenLayer}
      onCreateLayer={onCreateLayer}
      actionUrl={actionUrl}
      isFirstStep={isFirstStep}
      questionYText={questionYText}
      answerYText={answerYText}
      altTextYText={altTextYText}
      storySlug={storyId}
    />
  );
}
