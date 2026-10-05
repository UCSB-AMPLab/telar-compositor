/**
 * Dynamic key families: the key spaces built at runtime rather than written out
 * at a call site, and therefore invisible to both probes in
 * `catalogue-key-scan.ts`.
 *
 * A family is declared by its MEMBER SET, never by its prefix. A prefix would
 * be wrong on the evidence here: `common.json` holds six keys under `role.` of
 * which three are roles (`denied_publish`, `denied_upgrade` and
 * `publish_is_team_task` are ordinary static keys), and `contributions.json`
 * holds eight under `time.` of which three are the columns the loop iterates.
 * Excusing a prefix would hide any dead key that happened to share it.
 *
 * The member set is READ from the code that owns the domain, so extending that
 * code without writing the strings turns the coverage assertion red. Where no
 * such symbol exists, the declaration says so and names the site the members
 * were taken from; those are the declarations to convert first when the code
 * gains a name for its own list.
 *
 * Three kinds:
 *
 *   `listed`      — the member set is read from a named symbol, or taken from a
 *                   site named in `domain` where the code has no symbol yet.
 *   `generated`   — the member set is produced by driving the function that
 *                   builds the keys, over its own input domain.
 *   `underivable` — the key space cannot be enumerated from this repository.
 *                   Such a family excuses its whole prefix, which is weaker
 *                   than every other declaration here; the reason must say what
 *                   blocks enumeration.
 *
 * @version v1.5.0-beta
 */

import { getTableColumns } from "drizzle-orm";

import { project_config } from "~/db/schema";
import { buildConfigChangeFields } from "~/lib/publish.server";
import { settingsChangeI18nKey, SETTINGS_CHANGE_FALLBACK_KEY } from "~/lib/settings-change-i18n";
import { supportedLanguages } from "~/i18n/config";

import { readStringArray, readStringProperty, readUnionMembers } from "./catalogue-key-scan";

/** How a family's member set was arrived at. */
export type FamilyKind = "listed" | "generated" | "underivable";

/** One declared family, with its members already resolved from source. */
export interface KeyFamily {
  /** Namespace the keys live in. */
  ns: string;
  /** Common leading segment, including its trailing separator. */
  prefix: string;
  kind: FamilyKind;
  /** Where the member set comes from. */
  domain: string;
  /** What makes these keys reachable despite naming no literal. */
  reason: string;
  /** Files and lines that build a key of this family. */
  callSites: readonly string[];
  /** Resolved members, or null for an `underivable` family. */
  members: readonly string[] | null;
}

/**
 * The suffixes `WhatsNewModal.tsx` asks of whichever release is current.
 * `features` and `fixes` are arrays, so the catalogue's leaves under them are
 * `features.0`, `fixes.3` and so on — `familyCovers` treats a member as
 * covering its own subtree for exactly this case.
 */
const RELEASE_NOTE_SUFFIXES = [
  "title",
  "features",
  "fixes",
  "features_label",
  "fixes_label",
  "thanks_label",
  "thanks_suffix",
  "thanks_cta",
  "dismiss",
] as const;

/** The four strings `InstallationScopePrompt` asks of whichever prefix it is given. */
const INSTALLATION_SCOPE_SUFFIXES = ["title", "body", "grant_button", "waiting"] as const;

/**
 * Every `auto_commit.change_*` key, produced by driving the function that
 * builds them rather than by copying its output.
 *
 * The input domain is the managed-field set `buildConfigChangeFields` derives
 * from a `project_config` row, so a column added there reaches this set without
 * anyone editing this file. The row is stubbed from the table's own columns:
 * both builders gate every field on `!= null`, so any non-null value admits it.
 *
 * The rows are driven with each boolean both ways and each supported language
 * in turn, and the key builder is handed the managed VALUE the same way
 * `computeChangeSummary` hands it one. Driving the field names alone would
 * over-produce: a boolean field's bare `change_<slug>` form is unreachable
 * because its value is always `"true"` or `"false"`, so the key is always the
 * `_on` or `_off` variant.
 *
 * Two renames are applied between the diff loop and the key builder
 * (`telar_language` reports as `lang`, `development-features.skip_stories` as
 * `skip_stories`); they live inline in `computeChangeSummary` rather than in an
 * exported helper, so they are restated here and are the one part of this
 * family that a change could leave behind.
 */
function autoCommitMembers(): string[] {
  const columns = Object.entries(getTableColumns(project_config));
  /**
   * A config row whose every field is set, so no `!= null` gate drops one. A
   * `_json` column holds a JSON list, as anything that reads one requires.
   */
  const rowWith = (flag: boolean, language: string): Record<string, unknown> => {
    const row: Record<string, unknown> = {};
    for (const [name, column] of columns) {
      const text = name.endsWith("_json") ? "[]" : language;
      row[name] = column.dataType === "boolean" ? flag : column.dataType === "number" ? 1 : text;
    }
    return row;
  };

  const keys = new Set<string>([SETTINGS_CHANGE_FALLBACK_KEY]);
  for (const flag of [true, false]) {
    for (const language of supportedLanguages) {
      for (const [rawKey, value] of Object.entries(buildConfigChangeFields(rowWith(flag, language) as never))) {
        const key =
          rawKey === "telar_language"
            ? "lang"
            : rawKey === "development-features.skip_stories"
              ? "skip_stories"
              : rawKey;
        const label =
          rawKey === "telar_language"
            ? language
            : key === "collection_mode" || key === "skip_stories"
              ? value === "true"
                ? "on"
                : "off"
              : key;
        keys.add(settingsChangeI18nKey({ key, label, value }));
      }
    }
  }
  return [...keys].sort();
}

/** Every declared family, with members resolved against `repoRoot`'s sources. */
export function keyFamilies(repoRoot: string): KeyFamily[] {
  const measures = readStringArray(
    repoRoot,
    "app/components/features/contributions/ContributionRecord.tsx",
    "MEASURES",
  );
  const sections = readUnionMembers(repoRoot, "app/lib/undo-target.ts", "EntitySection");

  return [
    {
      ns: "common",
      prefix: "role.",
      kind: "listed",
      domain: "`ProjectRole` union, app/lib/publishing-roles.ts",
      reason:
        "the role chip labels its wearer by the role it is handed; the three roles are a union, and the other three keys under `role.` are ordinary static keys, which is why this is a member set and not the prefix",
      callSites: [
        "app/components/layout/Header.tsx:67",
        "app/components/features/header/ProjectSwitcher.tsx:64",
      ],
      members: readUnionMembers(repoRoot, "app/lib/publishing-roles.ts", "ProjectRole"),
    },
    {
      ns: "contributions",
      prefix: "measures.",
      kind: "listed",
      domain: "`MEASURES`, app/components/features/contributions/ContributionRecord.tsx",
      reason: "the record renders one column per measure, naming each by its own key",
      callSites: [
        "app/components/features/contributions/ContributionRecord.tsx:107",
        "app/components/features/contributions/SidebarContributions.tsx:91",
      ],
      members: measures,
    },
    {
      ns: "contributions",
      prefix: "definitions.",
      kind: "listed",
      domain: "`MEASURES`, app/components/features/contributions/ContributionRecord.tsx",
      reason: "each measure carries its caveat beside it, keyed by the same name",
      callSites: ["app/components/features/contributions/ContributionRecord.tsx:109"],
      members: measures,
    },
    {
      ns: "contributions",
      prefix: "kinds.",
      kind: "listed",
      domain: "`CONTRIBUTION_KINDS`, app/lib/contributions.ts",
      reason: "the record counts every measure for every kind of thing in the site",
      callSites: [
        "app/components/features/contributions/ContributionRecord.tsx:139",
        "app/components/features/contributions/SidebarContributions.tsx:98",
      ],
      members: readStringArray(repoRoot, "app/lib/contributions.ts", "CONTRIBUTION_KINDS"),
    },
    {
      ns: "contributions",
      prefix: "time.",
      kind: "listed",
      domain:
        "an unnamed array literal at app/components/features/contributions/ContributionRecord.tsx:245 — the one family whose domain has no symbol to read, so these members are a copy until it gains one",
      reason:
        "the time table heads three columns from the array it maps; the other five keys under `time.` are static and are why this is a member set",
      callSites: ["app/components/features/contributions/ContributionRecord.tsx:251"],
      members: ["editing", "writing", "writingShare"],
    },
    {
      ns: "objects",
      prefix: "sync_field.",
      kind: "listed",
      domain: "`SYNC_FIELDS`, app/lib/sync.server.ts",
      reason: "the sync diff names every field it reconciles, one row per field",
      callSites: [
        "app/components/features/objects/SyncDiffDialog.tsx:306",
        "app/components/features/dashboard/SyncConflictsBlock.tsx:127",
      ],
      members: readStringArray(repoRoot, "app/lib/sync.server.ts", "SYNC_FIELDS"),
    },
    {
      ns: "start",
      prefix: "activity.verb.",
      kind: "listed",
      domain: "`ACTIVITY_VERBS`, app/lib/activity.server.ts",
      reason:
        "a feed row carries a verb enum validated before INSERT; the row's raw token is the `defaultValue`, so an out-of-set legacy row degrades rather than showing a key",
      callSites: ["app/components/features/start/ActivityFeed.tsx:68"],
      members: readStringArray(repoRoot, "app/lib/activity.server.ts", "ACTIVITY_VERBS"),
    },
    {
      ns: "start",
      prefix: "activity.entity.",
      kind: "listed",
      domain: "`ACTIVITY_ENTITY_TYPES`, app/lib/activity.server.ts",
      reason: "the same row's entity type, validated at the same gate",
      callSites: ["app/components/features/start/ActivityFeed.tsx:69"],
      members: readStringArray(repoRoot, "app/lib/activity.server.ts", "ACTIVITY_ENTITY_TYPES"),
    },
    {
      ns: "start",
      prefix: "from_docs.desc_",
      kind: "listed",
      domain: "`DocId` union, app/lib/docs-content.ts",
      reason: "each doc tile takes its one-line description from the doc's own id",
      callSites: ["app/components/features/start/FromTheDocs.tsx:128"],
      members: readUnionMembers(repoRoot, "app/lib/docs-content.ts", "DocId"),
    },
    {
      ns: "start",
      prefix: "other_projects.",
      kind: "listed",
      domain:
        "the three keys `statusFor` returns, app/components/features/start/OtherProjectsRibbon.tsx:54 — a function's return values, with no list to read",
      reason: "each project tile shows one status pill, and the status decides its key",
      callSites: ["app/components/features/start/OtherProjectsRibbon.tsx:84"],
      members: ["pill_draft", "pill_unpublished_some", "pill_in_sync"],
    },
    {
      ns: "onboarding",
      prefix: "create_site.form.language_",
      kind: "listed",
      domain: "`supportedLanguages`, app/i18n/config.ts",
      reason: "the create form offers one button per language the Compositor supports",
      callSites: ["app/components/features/onboarding/CreateSiteForm.tsx:655"],
      members: [...supportedLanguages],
    },
    {
      ns: "onboarding",
      prefix: "create_site.form.kind_",
      kind: "listed",
      domain:
        "the `[\"site\", \"course\"]` literal at app/components/features/onboarding/StepConnect.tsx:325, gated on course access — an inline array with no symbol",
      reason: "each kind card shows its own name and hint",
      callSites: [
        "app/components/features/onboarding/StepConnect.tsx:338",
        "app/components/features/onboarding/StepConnect.tsx:341",
      ],
      members: ["site", "site_hint", "course", "course_hint"],
    },
    {
      ns: "onboarding",
      prefix: "create_site.installation_scope.",
      kind: "listed",
      domain:
        "the four suffixes `InstallationScopePrompt` asks of its prefix prop, app/components/features/onboarding/InstallationScopePrompt.tsx:115-130; this is the prop's default value",
      reason: "the prompt is rendered under two prefixes and asks the same four strings of each",
      callSites: ["app/components/features/onboarding/InstallationScopePrompt.tsx:115"],
      members: [...INSTALLATION_SCOPE_SUFFIXES],
    },
    {
      ns: "onboarding",
      prefix: "step_connect.installation_scope.",
      kind: "listed",
      domain:
        "the same four suffixes under the prefix StepConnect passes, app/components/features/onboarding/StepConnect.tsx:209",
      reason: "the second of the prompt's two prefixes",
      callSites: ["app/components/features/onboarding/InstallationScopePrompt.tsx:115"],
      members: [...INSTALLATION_SCOPE_SUFFIXES],
    },
    {
      ns: "editor",
      prefix: "panel.",
      kind: "listed",
      domain: "`WidgetKind` union, app/components/ui/markdown-editor/panelSource.ts",
      reason: "a widget box and the Widget menu name each widget by its kind",
      callSites: [
        "app/components/ui/markdown-editor/PanelBox.tsx (BoxHeader)",
        "app/components/ui/markdown-editor/PanelToolbar.tsx (WidgetMenu)",
      ],
      members: readUnionMembers(repoRoot, "app/components/ui/markdown-editor/panelSource.ts", "WidgetKind"),
    },
    {
      ns: "editor",
      prefix: "panel.",
      kind: "listed",
      domain: "`CAROUSEL_FIELDS`, app/components/ui/markdown-editor/PanelBox.tsx",
      reason: "a carousel item's editor labels each field, or its add button, by the field's key",
      callSites: ["app/components/ui/markdown-editor/PanelBox.tsx (CarouselField)"],
      members: readStringArray(repoRoot, "app/components/ui/markdown-editor/PanelBox.tsx", "CAROUSEL_FIELDS"),
    },
    {
      ns: "publish",
      prefix: "passed_checks.",
      kind: "listed",
      domain: "`CANONICAL_PASSED_CHECKS`, app/components/features/publish/ValidationChecks.tsx",
      reason: "the passed list is the canonical set minus whatever failed",
      callSites: ["app/components/features/publish/ValidationChecks.tsx:526"],
      members: readStringArray(
        repoRoot,
        "app/components/features/publish/ValidationChecks.tsx",
        "CANONICAL_PASSED_CHECKS",
        "key",
      ),
    },
    {
      ns: "publish",
      prefix: "checks.",
      kind: "underivable",
      domain: "none — `ValidationItem.code` is bare `string` (app/lib/publish.server.ts:316)",
      reason:
        "a check's message is keyed on the code the validator emitted, and the codes are literals spread across the validation passes rather than a declared set, so there is nothing to assert coverage against. This excuses the whole `checks.` prefix, including the static keys that share it, and is the weakest declaration here — enumerating it needs the code union that does not yet exist.",
      callSites: [
        "app/components/features/publish/ValidationChecks.tsx:362",
        "app/components/features/publish/ValidationChecks.tsx:314",
      ],
      members: null,
    },
    {
      ns: "publish",
      prefix: "auto_commit.",
      kind: "generated",
      domain:
        "driving `settingsChangeI18nKey` (app/lib/settings-change-i18n.ts:35) over the managed fields `buildConfigChangeFields` derives from `project_config`",
      reason:
        "a settings change names itself in the commit subject and the popover through one key builder, which composes the key from the field, its nesting and its post-change value",
      callSites: [
        "app/routes/_app.publish.tsx:255",
        "app/components/features/site-status/popovers/UnpublishedPopover.tsx:188",
      ],
      members: autoCommitMembers(),
    },
    {
      ns: "collaboration",
      prefix: "undo_label_",
      kind: "listed",
      domain: "`EntitySection` union, app/lib/undo-target.ts",
      reason:
        "an off-screen undo names the section it happened in, with a second form for a target that has no title yet",
      callSites: ["app/components/features/collaboration/UndoFeedback.tsx:61"],
      members: [...sections, ...sections.map((section) => `${section}_untitled`)],
    },
    {
      ns: "account",
      prefix: "preferences.presence_color_",
      kind: "listed",
      domain: "`PRESENCE_COLOR_NAMES`, app/routes/_app.account.tsx",
      reason: "the presence palette labels each swatch by its colour's name",
      callSites: ["app/routes/_app.account.tsx:706"],
      members: readStringArray(repoRoot, "app/routes/_app.account.tsx", "PRESENCE_COLOR_NAMES"),
    },
    {
      ns: "upgrade",
      prefix: "upgrading_step_",
      kind: "listed",
      domain:
        "the `[\"preparing\", \"committing\"]` literal at app/routes/_app.upgrade.tsx:1991 — an inline array with no symbol",
      reason: "the upgrade progress list names its two stages from the array it maps",
      callSites: ["app/routes/_app.upgrade.tsx:2014"],
      members: ["preparing", "committing"],
    },
    {
      ns: "popover",
      prefix: "publishing.steps.",
      kind: "listed",
      domain:
        "`BUILD_STEP_KEYS` plus the synthesised `dispatch` step, app/components/features/site-status/build-phase-collapse.ts",
      reason:
        "each publish step carries its own label key, which the stepper strips of its `popover.` prefix before asking for it",
      callSites: [
        "app/components/features/site-status/PublishingRows.tsx:31",
        "app/components/features/site-status/PublishingStepper.tsx:67",
      ],
      members: [
        "dispatch",
        ...readStringArray(
          repoRoot,
          "app/components/features/site-status/build-phase-collapse.ts",
          "BUILD_STEP_KEYS",
          "keySuffix",
        ),
      ],
    },
    {
      ns: "popover",
      prefix: "site_status.halted.reason.",
      kind: "listed",
      domain:
        "`KNOWN_REASONS` plus the `other` fallback, app/components/features/site-status/popovers/PersistenceHaltedPopover.tsx",
      reason:
        "a halted site explains itself by the reason on its marker, with one catch-all for a reason the list does not know",
      callSites: [
        "app/components/features/site-status/popovers/PersistenceHaltedPopover.tsx:66",
      ],
      members: [
        ...readStringArray(
          repoRoot,
          "app/components/features/site-status/popovers/PersistenceHaltedPopover.tsx",
          "KNOWN_REASONS",
        ),
        "other",
      ],
    },
    {
      ns: "release-notes",
      prefix: `${currentReleaseKey(repoRoot)}.`,
      kind: "listed",
      domain: "`CURRENT_RELEASE.i18nKey`, app/lib/release-notes.ts",
      reason:
        "the what's-new modal reads one release's subtree, chosen by the release the build is for; earlier releases' subtrees are not kept",
      callSites: ["app/components/features/release/WhatsNewModal.tsx:37"],
      members: [...RELEASE_NOTE_SUFFIXES],
    },
  ];
}

/** The release whose subtree `WhatsNewModal` reads, read from the release table. */
function currentReleaseKey(repoRoot: string): string {
  return readStringProperty(repoRoot, "app/lib/release-notes.ts", "CURRENT_RELEASE", "i18nKey");
}

/**
 * True when `family` accounts for `key`. A member covers its own subtree as
 * well as itself, because `t(key, { returnObjects: true })` asks for one key
 * and reads an array under it, whose leaves are `features.0`, `fixes.1`, …
 */
export function familyCovers(family: KeyFamily, key: string): boolean {
  if (!key.startsWith(family.prefix)) return false;
  if (family.members === null) return true;
  const tail = key.slice(family.prefix.length);
  return family.members.some((member) => tail === member || tail.startsWith(`${member}.`));
}
