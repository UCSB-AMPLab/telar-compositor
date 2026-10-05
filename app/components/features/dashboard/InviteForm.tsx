/**
 * InviteForm — GitHub username search + share-link generation for project owners.
 *
 * Only renders when isOwner is true. Provides two invite paths:
 *   1. Username search: debounced GitHub user search, click to confirm and send.
 *   2. Share link: generate a 48h invite URL and copy to clipboard.
 *
 * The search runs against GitHub, so the person it finds usually has no
 * Compositor account, and `send-invite` answers that case with a 48-hour link
 * rather than a membership row. Nothing here sends mail: that link is the
 * whole of the invitation, and the person at this form is the one who has to
 * deliver it. Every outcome therefore reaches the screen — the row written,
 * the link to hand over, and the refusals.
 *
 * @version v1.5.0-beta
 */

import { useState, useEffect, useRef } from "react";
import { useSiteFetcher } from "~/lib/page-site";
import { isUnreachableAnswer } from "~/lib/unreachable-write";
import { useRetryWhileUnreachable } from "~/lib/use-retry-unreachable";
import { isSiteChanged } from "~/components/features/site-status/SiteChangedNotice";
import { UserPlus, Copy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";

interface SearchResult {
  login: string;
  avatar_url: string;
}

interface InviteFormProps {
  projectId: number;
  isOwner: boolean;
  className?: string;
}

/** What the last attempt on this form produced. */
export type InviteOutcome =
  | { kind: "added"; username: string }
  | { kind: "link"; username: string; url: string; copied: boolean }
  | { kind: "failed"; messageKey: string };

/**
 * The refusal a response names, or the generic failure when it names one this
 * form has no sentence for. `missing_username` and `no_project` are both
 * states the form cannot produce on purpose, so neither has its own copy.
 */
function failureMessageKey(error: string | undefined): string {
  return error === "invite_refused_course" ? "invite_refused_course" : "error_invite_failed";
}

/** The sentence an outcome puts on screen. */
export function inviteOutcomeMessage(
  outcome: InviteOutcome,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  switch (outcome.kind) {
    case "failed":
      return t(outcome.messageKey);
    case "added":
      return t("invite_added", { username: outcome.username });
    case "link":
      return outcome.copied
        ? t("invite_link_copied", { username: outcome.username })
        : t("invite_link_manual", { username: outcome.username, url: outcome.url });
  }
}

/**
 * Copy `text`, reporting whether the clipboard took it.
 *
 * `navigator.clipboard` is absent outside a secure context, where reading
 * `.writeText` throws rather than rejecting — inside an effect that reaches
 * the error boundary and takes the panel down over a copy.
 */
function copyToClipboard(text: string): Promise<boolean> {
  try {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/** Whether there is a query whose search is still wanted: two characters, and no one chosen yet. */
function searchStands(query: string, selectedUser: string | null): boolean {
  return query.length >= 2 && !selectedUser;
}

/** Whether a fetcher has settled on an unreachable answer. */
function searchSettledUnreachable(fetcher: { state: string; data?: unknown }): boolean {
  return fetcher.state === "idle" && isUnreachableAnswer(fetcher.data);
}

function SearchNotMadeNote({ failed }: { failed: boolean }) {
  const { t } = useTranslation("team");
  if (!failed) return null;
  return (
    <p role="status" className="mt-1 font-body text-xs text-terracotta">
      {t("search_could_not_search")}
    </p>
  );
}

export function InviteForm({ projectId, isOwner, className }: InviteFormProps) {
  const { t } = useTranslation("team");
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [copyErrorUrl, setCopyErrorUrl] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<InviteOutcome | null>(null);

  const searchFetcher = useSiteFetcher<{ users?: SearchResult[] }>();
  const inviteFetcher = useSiteFetcher<{
    ok?: boolean;
    intent?: string;
    added?: boolean;
    inviteUrl?: string;
    username?: string;
    error?: string;
  }>();
  const generateFetcher = useSiteFetcher<{
    ok?: boolean;
    intent?: string;
    inviteUrl?: string;
    error?: string;
  }>();

  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search
  useEffect(() => {
    if (!query || query.length < 2) return;
    const timer = setTimeout(() => {
      const fd = new FormData();
      fd.set("intent", "search-users");
      fd.set("query", query);
      searchFetcher.submit(fd, { method: "post", action: "/dashboard" });
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  // A search that could not be made is asked again while its query stands.
  const searchWanted = searchStands(query, selectedUser);
  useRetryWhileUnreachable(
    searchFetcher.data,
    () => {
      const fd = new FormData();
      fd.set("intent", "search-users");
      fd.set("query", query);
      searchFetcher.submit(fd, { method: "post", action: "/dashboard" });
    },
    searchWanted,
  );

  // Auto-focus input when expanded
  useEffect(() => {
    if (expanded) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [expanded]);

  // The outcome of an invite. Each effect reads the intent its own fetcher
  // was given, so a response cannot be read by the half of the form that did
  // not ask for it.
  useEffect(() => {
    const data = inviteFetcher.data;
    if (!data || data.intent !== "send-invite") return;
    // The layout's notice speaks for a write refused because the site changed.
    if (isSiteChanged(data)) return;

    if (!data.ok) {
      setOutcome({ kind: "failed", messageKey: failureMessageKey(data.error) });
      return;
    }

    const username = data.username ?? "";
    const url = data.inviteUrl;
    if (!url) {
      setOutcome({ kind: "added", username });
      return;
    }

    // The link goes on screen either way: the clipboard is a convenience, and
    // its refusal must not be what decides whether the invitation is legible.
    setOutcome({ kind: "link", username, url, copied: false });
    copyToClipboard(url).then((copied) => {
      if (copied) setOutcome({ kind: "link", username, url, copied: true });
    });
  }, [inviteFetcher.data]);

  // Handle generate-invite result — copy to clipboard
  useEffect(() => {
    const data = generateFetcher.data;
    if (!data || data.intent !== "generate-invite") return;
    if (isSiteChanged(data)) return;

    if (!data.ok) {
      setOutcome({ kind: "failed", messageKey: failureMessageKey(data.error) });
      return;
    }

    const url = data.inviteUrl;
    if (!url) return;
    copyToClipboard(url).then((copied) => {
      if (copied) {
        setCopyState("copied");
        setTimeout(() => setCopyState("idle"), 2000);
      } else {
        setCopyState("error");
        setCopyErrorUrl(url);
      }
    });
  }, [generateFetcher.data]);

  if (!isOwner) return null;

  const searchResults: SearchResult[] = searchFetcher.data?.users ?? [];
  const sending = inviteFetcher.state !== "idle";

  function handleSendInvite() {
    if (!selectedUser) return;
    const fd = new FormData();
    fd.set("intent", "send-invite");
    fd.set("username", selectedUser);
    inviteFetcher.submit(fd, { method: "post", action: "/dashboard" });
    setSelectedUser(null);
    setQuery("");
    setOutcome(null);
  }

  function handleGenerateInvite() {
    const fd = new FormData();
    fd.set("intent", "generate-invite");
    generateFetcher.submit(fd, { method: "post", action: "/dashboard" });
    setOutcome(null);
  }

  return (
    <div className={`pt-4 border-t border-gray-100 ${className ?? ""}`}>
      {!expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center gap-2 bg-anil text-charcoal font-heading text-sm font-semibold rounded-full px-4 py-2 hover:bg-anil/80 transition-colors"
        >
          <UserPlus size={15} aria-hidden="true" />
          {t("invite_button")}
        </button>
      ) : (
        <div className="space-y-3">
          {/* Username search */}
          <div className="relative">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedUser(null);
                setOutcome(null);
              }}
              placeholder={t("search_placeholder")}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-body text-sm text-charcoal placeholder:text-gray-400"
            />

            <SearchNotMadeNote failed={searchWanted && searchSettledUnreachable(searchFetcher)} />

            {/* Search results dropdown */}
            {searchResults.length > 0 && !selectedUser && query.length >= 2 && (
              <ul className="absolute z-10 mt-1 w-full rounded-lg border border-gray-100 bg-white shadow-lg overflow-hidden">
                {searchResults.map((u) => (
                  <li key={u.login}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedUser(u.login);
                        setQuery(u.login);
                      }}
                      className="flex items-center gap-2 w-full px-3 py-2 hover:bg-cream-dark text-left transition-colors"
                    >
                      <img
                        src={u.avatar_url}
                        alt={u.login}
                        className="w-6 h-6 rounded-full"
                      />
                      <span className="font-body text-sm text-charcoal">@{u.login}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Confirmation chip when a user is selected */}
          {selectedUser && (
            <div className="flex items-center gap-3">
              <p className="font-body text-sm text-charcoal flex-1">
                {t("send_confirm", { username: selectedUser })}
              </p>
              <button
                type="button"
                onClick={handleSendInvite}
                disabled={sending}
                className="inline-flex items-center gap-1.5 bg-anil text-charcoal font-heading text-sm font-semibold rounded-full px-4 py-1.5 hover:bg-anil/80 disabled:bg-disabled disabled:text-fg-disabled transition-colors"
              >
                {t("send_button")}
              </button>
            </div>
          )}

          {/* What the last attempt produced */}
          {outcome && (
            <p
              role="status"
              className={`font-body text-xs break-all ${
                outcome.kind === "failed" ? "text-terracotta" : "text-charcoal/70"
              }`}
            >
              {inviteOutcomeMessage(outcome, t)}
            </p>
          )}

          {/* Share link section */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleGenerateInvite}
              disabled={generateFetcher.state !== "idle"}
              className="inline-flex items-center gap-2 font-body text-sm text-charcoal/70 hover:text-charcoal transition-colors disabled:text-fg-disabled"
            >
              {copyState === "copied" ? (
                <Check size={15} className="text-green-600" aria-hidden="true" />
              ) : (
                <Copy size={15} aria-hidden="true" />
              )}
              {copyState === "copied" ? t("link_copied") : t("copy_share_link")}
            </button>
          </div>

          {/* Clipboard error fallback */}
          {copyState === "error" && copyErrorUrl && (
            <p className="font-body text-xs text-terracotta break-all">
              {t("error_copy_failed", { url: copyErrorUrl })}
            </p>
          )}

          {/* Collapse button */}
          <button
            type="button"
            onClick={() => {
              setExpanded(false);
              setQuery("");
              setSelectedUser(null);
              setOutcome(null);
            }}
            className="font-body text-xs text-gray-400 hover:text-charcoal transition-colors"
          >
            ✕ {t("close")}
          </button>
        </div>
      )}
    </div>
  );
}
