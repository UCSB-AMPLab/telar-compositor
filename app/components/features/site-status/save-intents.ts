/**
 * save-intents — the single source of truth for the list of autosave fetcher
 * intents the app submits. The Site Status pill's Saving overlay (useSiteStatus)
 * watches this exact list to flash the transient `Saving…` signal. (The standalone
 * SaveIndicator that previously also watched it has since been retired; this list
 * now has a single consumer but stays factored out as a stable, named contract.)
 *
 * @version v1.3.0-beta
 */

/** All autosave intents across the app. */
export const ALL_SAVE_INTENTS = [
  "autosave-landing",
  "autosave-config",
  "reorder",
  "toggle-draft",
  "toggle-private",
  "autosave-story-field",
  "autosave-step-field",
  "autosave-layer",
  "capture-position",
  "change-object",
  "add-step",
  "delete-step",
  "reorder-steps",
  "create-layer",
  "save-layer",
  "delete-layer",
  "autosave-object-field",
  "autosave-object-featured",
  "toggle-featured",
  "autosave-page-title",
  "autosave-page-body",
] as const;
