/**
 * The "Choose where to create your site" dialog for the create-site flow.
 *
 * Extracted from StepConnect so the account picker has a single, independently
 * testable home — and so the create flow has a first-class path to install the
 * Compositor on an organization it isn't installed on yet. The account list only
 * ever contains accounts/orgs where the app is ALREADY installed (that's all the
 * installation token can enumerate), so without the "Install on an organization
 * account" CTA a user whose org has no installation would have no in-flow way to
 * add one. The CTA points at GitHub's app-install page (new tab); clicking it
 * arms a one-shot listener that revalidates the onboarding loader when the user
 * returns to this tab, so the newly-installed org appears without a manual
 * reload.
 *
 * @version v1.4.0-beta
 */

import { useEffect, useRef } from "react";
import { X, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useRevalidator } from "react-router";
import { Button } from "~/components/ui/Button";

export interface AccountInstallationOption {
  installationId: number;
  owner: string;
  targetType: "User" | "Organization";
  isOwnAccount: boolean;
}

interface AccountModalProps {
  options: AccountInstallationOption[];
  activeInstallationId: number;
  githubAppSlug: string;
  onSelect: (installationId: number) => void;
  onClose: () => void;
}

export function AccountModal({
  options,
  activeInstallationId,
  githubAppSlug,
  onSelect,
  onClose,
}: AccountModalProps) {
  const { t } = useTranslation("onboarding");
  const revalidator = useRevalidator();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Latest onClose without re-running the a11y effect. StepConnect passes an
  // inline-arrow onClose (new identity every render), so depending on it would
  // re-run the effect on every parent re-render — stealing focus back to the
  // first focusable mid-interaction (and revalidator state transitions trigger
  // exactly such re-renders). The effect runs once; Escape reads the ref.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Modal a11y (mount/unmount only): move focus into the dialog on open, restore
  // it to the previously-focused element on close, trap Tab within the dialog,
  // and close on Escape.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusables = () =>
      dialog
        ? Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];
    (focusables()[0] ?? dialog)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab") {
        const items = focusables();
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, []);

  // Installing on GitHub happens in a new tab; when the user returns to this
  // tab, revalidate the onboarding loader so the newly-installed org shows up in
  // the account list. One-shot per arm — tracked in a ref so it's removed on
  // unmount (no leak / spurious post-close revalidate) and a second click while
  // already armed doesn't pile up duplicate listeners.
  const returnListenerRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      if (returnListenerRef.current) {
        window.removeEventListener("focus", returnListenerRef.current);
        returnListenerRef.current = null;
      }
    };
  }, []);
  function armRevalidateOnReturn() {
    if (returnListenerRef.current) return;
    const onReturn = () => {
      window.removeEventListener("focus", onReturn);
      returnListenerRef.current = null;
      revalidator.revalidate();
    };
    returnListenerRef.current = onReturn;
    window.addEventListener("focus", onReturn);
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-cream rounded-2xl shadow-2xl max-w-md w-full p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-modal-title"
      >
        <div className="flex items-start justify-between mb-2">
          <h3 id="account-modal-title" className="font-heading font-semibold text-lg text-charcoal">
            {t("create_site.account_modal.title")}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-charcoal transition-colors"
            aria-label={t("create_site.account_modal.cancel")}
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="font-body text-sm text-gray-500 mb-4">
          {t("create_site.account_modal.description")}
        </p>
        <ul className="flex flex-col gap-2 mb-4">
          {options.map((opt) => {
            const isActive = opt.installationId === activeInstallationId;
            return (
              <li key={opt.installationId}>
                <button
                  type="button"
                  onClick={() => onSelect(opt.installationId)}
                  className={`w-full flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
                    isActive
                      ? "border-terracotta bg-anil/20"
                      : "border-gray-200 hover:border-charcoal hover:bg-cream-dark"
                  }`}
                >
                  <div className="flex flex-col">
                    <span className="font-body font-semibold text-sm text-charcoal">{opt.owner}</span>
                    <span className="font-body text-xs text-gray-500">
                      {opt.isOwnAccount
                        ? t("create_site.account_modal.your_account_label")
                        : t("create_site.account_modal.organization_label")}
                    </span>
                  </div>
                  {isActive && <span className="w-2 h-2 rounded-full bg-terracotta" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>

        {/* Install-on-another-org CTA. The account list above can only show
            orgs the app is already installed on, so this is the in-flow path to
            add a new one. */}
        <div className="border-t border-cream-dark pt-4 mb-4">
          <p className="font-body text-xs text-gray-500 mb-2">
            {t("create_site.account_modal.install_elsewhere_hint")}
          </p>
          <a
            href={`https://github.com/apps/${githubAppSlug}/installations/new`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={armRevalidateOnReturn}
            className="inline-flex items-center gap-1.5 font-heading font-semibold text-xs uppercase tracking-wider bg-charcoal text-white rounded-full px-4 py-1.5 hover:opacity-90 transition-opacity"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            {t("create_site.account_modal.install_elsewhere_cta")}
          </a>
        </div>

        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            {t("create_site.account_modal.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
