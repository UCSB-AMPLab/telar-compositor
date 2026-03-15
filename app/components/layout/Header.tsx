/**
 * Header — authenticated app header bar.
 *
 * Charcoal background (#333333) with Telar brand, user avatar, and avatar dropdown.
 * Per Figma: no language toggle in header — language is set in Settings only.
 */

import { useState, useRef, useEffect } from "react";
import { Form, Link } from "react-router";
import { ChevronDown, Settings, LogOut } from "lucide-react";
import type { AuthenticatedUser } from "~/middleware/auth.server";

interface HeaderProps {
  user: Pick<AuthenticatedUser, "github_id" | "github_login" | "github_name" | "github_email">;
  className?: string;
}

export function Header({ user, className = "" }: HeaderProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClick);
    }
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

  const displayName = user.github_name || user.github_login;
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <header
      className={`h-14 bg-charcoal flex items-center justify-between px-6 ${className}`}
    >
      {/* Brand */}
      <Link
        to="/dashboard"
        className="flex items-center gap-2.5 hover:opacity-80 transition-opacity"
      >
        <img src="/logo-lila-amarillo.svg" alt="Telar" className="h-9 w-auto max-h-9" />
        <span className="font-heading font-normal text-periwinkle" style={{ fontSize: "24px" }}>
          Compositor
        </span>
      </Link>

      {/* User menu */}
      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          onClick={() => setDropdownOpen((v) => !v)}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          aria-haspopup="true"
          aria-expanded={dropdownOpen}
          aria-label="User menu"
        >
          {/* Avatar — use GitHub CDN from github_id */}
          <img
            src={`https://avatars.githubusercontent.com/u/${user.github_id}?s=56`}
            alt={displayName}
            className="w-7 h-7 rounded-full object-cover bg-periwinkle"
            onError={(e) => {
              // Fallback to initials on load error
              const target = e.currentTarget;
              target.style.display = "none";
              const sibling = target.nextElementSibling as HTMLElement | null;
              if (sibling) sibling.style.display = "flex";
            }}
          />
          <span
            className="w-7 h-7 rounded-full bg-periwinkle text-charcoal font-heading font-semibold text-xs items-center justify-center hidden"
            aria-hidden="true"
          >
            {initials}
          </span>
          <ChevronDown
            className={`w-3.5 h-3.5 text-white transition-transform ${dropdownOpen ? "rotate-180" : ""}`}
          />
        </button>

        {/* Dropdown */}
        {dropdownOpen && (
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 z-10"
              onClick={() => setDropdownOpen(false)}
              aria-hidden="true"
            />
            <div className="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-100 z-20 py-1">
              {/* User info */}
              <div className="px-4 py-3 border-b border-gray-100">
                <p className="font-heading font-semibold text-sm text-charcoal truncate">
                  {displayName}
                </p>
                {user.github_email && (
                  <p className="font-body text-xs text-gray-500 truncate mt-0.5">
                    {user.github_email}
                  </p>
                )}
              </div>

              {/* Settings */}
              <Link
                to="/config"
                onClick={() => setDropdownOpen(false)}
                className="flex items-center gap-2 px-4 py-2.5 text-sm font-body text-charcoal hover:bg-cream transition-colors"
              >
                <Settings className="w-4 h-4 text-gray-400" />
                Settings
              </Link>

              {/* Sign out */}
              <Form method="post" action="/signout">
                <button
                  type="submit"
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-body text-terracotta hover:bg-cream transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  Sign out
                </button>
              </Form>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
