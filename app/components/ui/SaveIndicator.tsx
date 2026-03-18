/**
 * SaveIndicator — shows save status based on active fetcher state.
 *
 * Watches all fetchers whose intent matches the provided list.
 * When alwaysShow is true, displays idleLabel when nothing is happening.
 */

import { useState, useEffect, useRef } from "react";
import { useFetchers } from "react-router";
import { Loader2, Check } from "lucide-react";

interface SaveIndicatorProps {
  intents: string[];
  savingLabel: string;
  savedLabel: string;
  className?: string;
  /** When true, show idleLabel when nothing is saving */
  alwaysShow?: boolean;
  /** Label to show when idle (requires alwaysShow) */
  idleLabel?: string;
}

export function SaveIndicator({
  intents,
  savingLabel,
  savedLabel,
  className = "font-body text-xs text-gray-400",
  alwaysShow = false,
  idleLabel,
}: SaveIndicatorProps) {
  const fetchers = useFetchers();
  const [showSaved, setShowSaved] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isSaving = fetchers.some(
    (f) =>
      f.state === "submitting" &&
      f.formData &&
      intents.includes(f.formData.get("intent") as string)
  );

  const wasSavingRef = useRef(false);
  useEffect(() => {
    if (isSaving) {
      wasSavingRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      setShowSaved(false);
    } else if (wasSavingRef.current) {
      wasSavingRef.current = false;
      setShowSaved(true);
      timerRef.current = setTimeout(() => setShowSaved(false), 2000);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isSaving]);

  const isIdle = !isSaving && !showSaved;

  if (isIdle && !alwaysShow) return null;

  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${className}`}>
      {isSaving ? (
        <>
          <Loader2 className="w-3 h-3 animate-spin" />
          {savingLabel}
        </>
      ) : showSaved ? (
        <>
          <Check className="w-3 h-3 text-green-500" />
          {savedLabel}
        </>
      ) : (
        <>
          <Check className="w-3 h-3 text-green-500" />
          {idleLabel ?? savedLabel}
        </>
      )}
    </span>
  );
}
