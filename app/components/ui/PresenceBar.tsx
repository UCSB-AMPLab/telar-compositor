/**
 * PresenceBar -- avatar row showing connected collaborators in the header.
 *
 * Renders 28px GitHub avatar circles with coloured rings. Only shows OTHER
 * collaborators. Renders nothing when solo.
 * Avatars fade in/out on connect/disconnect.
 */

import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import type { AwarenessUser } from "~/hooks/use-collaboration";
import { useTranslation } from "react-i18next";

interface FadingCollaborator {
  collaborator: AwarenessUser;
  fading: boolean;
}

/**
 * Returns a human-readable label for a route path.
 * e.g. "/stories" -> "Stories", "/stories/my-story" -> "Story: my-story"
 */
function getRouteLabel(route: string): string {
  if (!route || route === "/") return "Start";
  const segments = route.replace(/^\//, "").split("/");
  const base = segments[0];
  switch (base) {
    case "dashboard":
      return "Start";
    case "stories":
      return segments[1] ? `Story: ${segments[1]}` : "Stories";
    case "objects":
      return "Objects";
    case "config":
      return "Settings";
    default:
      return base.charAt(0).toUpperCase() + base.slice(1);
  }
}

interface PresenceBarProps {
  className?: string;
}

export function PresenceBar({ className = "" }: PresenceBarProps) {
  const { remoteCollaborators, userGithubId } = useCollaborationContext();
  const navigate = useNavigate();
  const { t } = useTranslation("collaboration");

  // Track fading-out collaborators so they can animate before removal
  const [displayed, setDisplayed] = useState<FadingCollaborator[]>([]);
  const prevIds = useRef<Set<number>>(new Set());

  useEffect(() => {
    const currentIds = new Set(remoteCollaborators.map((c) => c.clientId));

    setDisplayed((prev) => {
      // Mark collaborators that left as fading
      const updated = prev.map((item) => {
        if (!currentIds.has(item.collaborator.clientId)) {
          return { ...item, fading: true };
        }
        return item;
      });

      // Add new collaborators that arrived
      for (const collaborator of remoteCollaborators) {
        const exists = updated.some(
          (item) => item.collaborator.clientId === collaborator.clientId
        );
        if (!exists) {
          updated.push({ collaborator, fading: false });
        } else {
          // Update location for existing collaborators
          const idx = updated.findIndex(
            (item) => item.collaborator.clientId === collaborator.clientId
          );
          if (idx !== -1) {
            updated[idx] = { collaborator, fading: false };
          }
        }
      }

      return updated;
    });

    prevIds.current = currentIds;
  }, [remoteCollaborators]);

  const handleTransitionEnd = (clientId: number) => {
    setDisplayed((prev) =>
      prev.filter((item) => item.collaborator.clientId !== clientId || !item.fading)
    );
  };

  // Filter out the current user's other tabs — sidebar shows them instead
  const otherPeople = displayed.filter(
    ({ collaborator }) => collaborator.user.githubId !== userGithubId,
  );

  if (otherPeople.length === 0) return null;

  return (
    <div className={`flex items-center ${className}`}>
      {otherPeople.map(({ collaborator, fading }) => {
        const { user, location } = collaborator;
        const routeLabel = location?.route ? getRouteLabel(location.route) : "Start";
        const tooltipText = location?.fieldKey
          ? t("presence_tooltip_editing", {
              name: user.name,
              route: routeLabel,
              field: location.fieldKey,
            })
          : t("presence_tooltip_viewing", { name: user.name, route: routeLabel });

        const targetRoute = location?.route || "/dashboard";

        return (
          <button
            type="button"
            key={collaborator.clientId}
            onClick={() => navigate(targetRoute)}
            title={tooltipText}
            className={`-ml-2 first:ml-0 transition-opacity duration-300 cursor-pointer ${fading ? "opacity-0" : "opacity-100"}`}
            onTransitionEnd={() => handleTransitionEnd(collaborator.clientId)}
          >
            <img
              src={`https://avatars.githubusercontent.com/u/${user.githubId}?s=56`}
              alt={user.name}
              className="w-7 h-7 rounded-full object-cover"
              style={{ outline: `2px solid ${user.color}`, outlineOffset: "1px" }}
              onError={(e) => {
                const target = e.currentTarget;
                target.style.display = "none";
                const sibling = target.nextElementSibling as HTMLElement | null;
                if (sibling) sibling.style.display = "flex";
              }}
            />
            <span
              className="w-7 h-7 rounded-full text-charcoal font-heading font-semibold text-xs items-center justify-center hidden"
              style={{ backgroundColor: user.color + "33", display: "none" }}
              aria-hidden="true"
            >
              {user.name.slice(0, 2).toUpperCase()}
            </span>
          </button>
        );
      })}
    </div>
  );
}
