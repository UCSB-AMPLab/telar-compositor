/**
 * InviteForm — GitHub username search + share-link generation for project owners.
 *
 * Only renders when isOwner is true. Provides two invite paths:
 *   1. Username search: debounced GitHub user search, click to confirm and send.
 *   2. Share link: generate a 48h invite URL and copy to clipboard.
 */

import { useState, useEffect, useRef } from "react";
import { useFetcher } from "react-router";
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

export function InviteForm({ projectId, isOwner, className }: InviteFormProps) {
  const { t } = useTranslation("team");
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [copyErrorUrl, setCopyErrorUrl] = useState<string | null>(null);

  const searchFetcher = useFetcher<{ users?: SearchResult[] }>();
  const inviteFetcher = useFetcher<{ ok?: boolean; added?: boolean; inviteUrl?: string }>();
  const generateFetcher = useFetcher<{ ok?: boolean; inviteUrl?: string }>();

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

  // Auto-focus input when expanded
  useEffect(() => {
    if (expanded) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [expanded]);

  // Handle generate-invite result — copy to clipboard
  useEffect(() => {
    const url = generateFetcher.data?.inviteUrl;
    if (!url) return;
    navigator.clipboard.writeText(url).then(
      () => {
        setCopyState("copied");
        setTimeout(() => setCopyState("idle"), 2000);
      },
      () => {
        setCopyState("error");
        setCopyErrorUrl(url);
      }
    );
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
  }

  function handleGenerateInvite() {
    const fd = new FormData();
    fd.set("intent", "generate-invite");
    generateFetcher.submit(fd, { method: "post", action: "/dashboard" });
  }

  return (
    <div className={`pt-4 border-t border-gray-100 ${className ?? ""}`}>
      {!expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center gap-2 bg-periwinkle text-charcoal font-heading text-sm font-semibold rounded-full px-4 py-2 hover:bg-periwinkle/80 transition-colors"
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
              }}
              placeholder={t("search_placeholder")}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-body text-sm text-charcoal placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-periwinkle/50"
            />

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
                className="inline-flex items-center gap-1.5 bg-periwinkle text-charcoal font-heading text-sm font-semibold rounded-full px-4 py-1.5 hover:bg-periwinkle/80 disabled:opacity-50 transition-colors"
              >
                {t("send_button")}
              </button>
            </div>
          )}

          {/* Share link section */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleGenerateInvite}
              disabled={generateFetcher.state !== "idle"}
              className="inline-flex items-center gap-2 font-body text-sm text-charcoal/70 hover:text-charcoal transition-colors disabled:opacity-50"
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
            }}
            className="font-body text-xs text-gray-400 hover:text-charcoal transition-colors"
          >
            ✕ Close
          </button>
        </div>
      )}
    </div>
  );
}
