/**
 * format-relative — shared relative time formatting utility.
 *
 * Formats an ISO timestamp as a human-readable relative time string.
 * Used by StoryCard, StoryRow, and ProjectStatusBar.
 */

/**
 * Format an ISO timestamp as a human-readable relative time string.
 * Returns neverLabel (default "") when isoString is null/undefined.
 */
export function formatRelative(
  isoString: string | null | undefined,
  neverLabel = ""
): string {
  if (!isoString) return neverLabel;
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes !== 1 ? "s" : ""} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
  if (diffDays < 30) return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
  return date.toLocaleDateString();
}
