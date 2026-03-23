/**
 * NarrativeColumn — switches between TitleCardView (step 0) and StepView (step 1-N).
 *
 * Receives story, active step, and layers from the editor route.
 * Renders TitleCardView when activeStepIndex === 0, StepView otherwise.
 * Forwards layer props and callbacks to StepView.
 */

import { TitleCardView } from "~/components/features/editor/TitleCardView";
import { StepView } from "~/components/features/editor/StepView";

interface NarrativeColumnProps {
  activeStepIndex: number;
  story: {
    id: number;
    title: string | null;
    subtitle: string | null;
    byline: string | null;
    order: number | null;
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
}

export function NarrativeColumn({
  activeStepIndex,
  story,
  activeStep,
  layers,
  onOpenLayer,
  onCreateLayer,
  actionUrl,
  isFirstStep,
}: NarrativeColumnProps) {
  if (activeStepIndex === 0) {
    return <TitleCardView story={story} />;
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
    />
  );
}
