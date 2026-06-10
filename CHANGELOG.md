# Changelog

## v1.3.3-beta (2026-06-10)

A small fix release for the glossary editor.

### Fixes

- **Glossary definitions no longer lose text while you type** — Editing a
  newly-created term's definition could drop everything after the first
  character or two when the term was first saved in the background. The editor
  now keeps the term selected through that save, so definitions are typed and
  saved in full.

## v1.3.2-beta (2026-06-09)

A reliability release focused on image uploads and object data. Object
metadata now saves dependably, a failed upload surfaces a clear reason and can
be retried without creating duplicates, and several collaborative-editing edge
cases that could make objects briefly disappear now self-heal. No new D1
migrations, environment variables, or bindings.

### New features

- **Stories-section intro** — The homepage editor now has an optional intro
  paragraph for the stories section, shown above your stories when set.

### Reliability and bug fixes

- **Object credit, source, type, and subjects now save reliably** — These
  fields round-trip through the collaboration snapshot and back-fill on load
  for existing projects, fixing cases where an edited credit line could revert.
- **Image upload is more dependable** — A failed registration after the image
  was committed no longer leaves the upload stuck or the object stranded;
  retrying is safe and never creates duplicates.
- **Clearer upload errors** — When an upload can't proceed, the message now
  explains why (for example, an invalid object ID) instead of a generic
  "check your connection."
- **Object IDs are tidied automatically** — Spaces or capital letters in an
  object ID no longer block the upload.
- **Objects no longer briefly disappear** — Self-healing reconciles objects,
  stories, and steps that could vanish after certain collaborative edits.
- **Site-config repair stays applied** — Repairing a site's configuration
  during onboarding now coordinates with live collaboration so the fix isn't
  overwritten.

### Under the hood

- **Workers observability enabled** — Server-side errors are now captured with
  stack traces, so issues can be diagnosed from logs.
- Image and object commits now use the GitHub App installation token, removing
  a class of permission failures.

## v1.3.1-beta (2026-06-07)

A patch release hardening the framework-upgrade flow for sites whose GitHub App installation hasn't yet approved the "workflows" permission, plus two bug-report improvements. Upgrading adds one backwards-compatible D1 migration; no new environment variables or bindings.

### Upgrade reliability

- **A rejected workflows permission can no longer leave a site half-upgraded** — When an upgrade modifies a site's GitHub Actions workflow files but the GitHub App installation hasn't been granted the workflows permission, the commit used to fail after the version had already been bumped. The upgrade now lands the content changes first and holds the version bump (and the workflow files) for a second commit, so a rejected workflows write leaves the content upgrade intact and the version unchanged — and the next upgrade re-fires cleanly.
- **"Review permissions on GitHub" link no longer 404s** — The link shown when an upgrade hits a missing permission pointed at a page that doesn't exist on GitHub. It now opens the installation's settings page, where the pending permission can be approved.
- **Sign-in prompt to approve the workflows permission** — Convenors whose installation predates the workflows permission now see a one-time notice at sign-in explaining they need to approve it before upgrading, shown after the welcome and "What's new" prompts.

### Bug reports

- **Reports capture the project they came from** — A filed bug report now includes the active project's repository, so issues arrive with the context needed to reproduce them.
- **The maintainer is notified** — Filed issues now mention the maintainer so they are notified directly.

### Data layer

- D1 migration 0034 adds two nullable columns to `projects` (`gh_workflows_write_missing`, `gh_install_target_type`) that cache each installation's workflows-permission state, so the sign-in prompt costs no extra GitHub call per navigation. Additive and backwards-compatible — existing rows read as unknown and fail open (no prompt) until the next GitHub-status poll fills them.

## v1.3.0-beta (2026-06-06)

The largest compositor release since v1.0.0-beta: a top-to-bottom redesign of the workspace, real-time collaboration moving into open beta, and a wave of stability and user-reported bug fixes. Upgrading runs eight D1 migrations — one of them, dropping a vestigial column, is forwards-only. No new environment variables or bindings.

### New features

- **Redesigned workspace** — A refreshed visual identity across the whole app: a new type system, palette, and a set of shared UI primitives that bring every tab into one consistent design language. The header, tab navigation, and project switcher were rebuilt around it.
- **Guided Start tab** — A new landing tab inside each project that orients you: a workflow map showing the six steps of building a Telar site (configure, objects, stories, glossary, pages, publish) with the live state of each, an activity feed of the latest edits, short documentation excerpts you can read in a drawer without leaving the compositor, and a first-run checklist tailored to whether you convene the project or collaborate on it.
- **Site-status pill** — A single status indicator in the header that shows where the site stands and opens the right popover: a step-by-step publish progress tracker while a build runs, an "in sync" / "GitHub has changed" view, and a prompt when a new Telar version is available.
- **Real-time collaboration — open beta** — Working on a site together with your team is now in open beta, with live presence (live, reconnecting, or working solo), an in-app notice while the feature is in beta, and a welcome when someone adds you to a project. Edits save automatically, and nothing goes live until the convenor publishes.
- **Scoped undo and redo** — Undo now affects only your own recent edits, never a teammate's, with a toast (and one-click reverse) when an undo touches something off-screen, and a clear "nothing of yours to undo" message.
- **Rebuilt glossary editor** — Rename a term and see what it affects, trace where each term is used, and preview entries live as you edit.
- **Restructured story editor** — The story editor was reorganised around steps and layers, with clearer per-step and per-layer labels.
- **One add-object dialog** — Uploading an image, pasting an IIIF manifest, and linking external media (Vimeo, YouTube, Google Drive) now happen in a single add-object dialog, alongside a refreshed objects table.
- **Rewritten Pages and Publish** — Publish now shows what's changing and what was checked before you commit, with clearer success and failure cards.
- **Rich site-description editor** — The homepage description is now a collaborative inline-HTML editor (bold, links) with a view/edit toggle, replacing a plain-text field that had been silently dropping links.
- **Project switcher** — Switch between your projects, or add and remove a repo, from the header.
- **Activity log and "What's new" card** — Projects keep an activity log, and a dismissable, bilingual "What's new" card greets you at sign-in after a release.

### Data layer

- D1 migrations 0026–0033: an activity-log table, a per-collaborator "welcomed" stamp, a created-by column, a GitHub-status cache, object dimensions and extra columns, glossary related-terms, and a last-seen-release stamp. Migration 0028 drops the vestigial `objects.order` column and is **forwards-only** — self-hosters cannot roll the database back past this release without manual schema work. The rest are additive and backwards-compatible.

### Security and stability

- **Multiplayer hardening** — Closed several access-control gaps where one user could act on another's project, made a removed collaborator's live session end immediately, and made snapshot ordering and de-duplication robust under concurrent editing.
- **Authentication hardened; broader key support** — Sign-in paths were hardened, and the GitHub App integration now accepts both PKCS#1 and PKCS#8 private keys.
- **Faster navigation** — GitHub status is cached between checks so moving between tabs stays fast, and the cache is cleared on publish so status stays accurate.
- **Framework files self-heal on publish** — A site missing its `package-lock.json` (required since the framework's build switched to `npm ci`) now has it restored automatically on the next publish.
- **Readable settings changes** — Settings changes now appear in human-readable form in both the commit message and the unpublished-changes popover, instead of raw keys.

### Bug fixes

- **Turning off demo content now works** — Nested settings such as "show demo content" were silently dropped at publish, so toggling demo content off never reached the live site. Publish now writes the nested `story_interface` and `collection_interface` blocks (and `telar_theme`) back to `_config.yml`, so every toggle takes effect.
- **Editing a brand-new story no longer errors** — Opening a just-created story, or navigating to one that doesn't exist yet, now shows an in-app recovery card instead of crashing the page.
- **Renaming a layer button no longer fails** — Editing the label or expander on a freshly-created layer no longer triggers a failed save.
- **Publish no longer ships stale content** — If a pre-publish snapshot fails, publish now stops instead of shipping the previous state.

## v1.2.1-beta (2026-05-29)

A patch release with three fixes, all live on production. No D1 migrations, no
binding changes, no new environment variables — upgrading is a deploy.

### Bug fixes

- **Welcome message editor no longer crashes and now saves** — Editing (or clearing) the homepage Welcome Message crashed the page with a "Something went wrong" error and discarded the edit. The editor now saves changes reliably as you type. The canned framework default shows as a placeholder when the field is empty, so you start from a clean slate and type to replace it.
- **Dashboard timestamps no longer cause a hydration mismatch** — The "Synced …" relative timestamps on dashboard story cards rendered differently on the server and the client (date format and timezone), triggering a React hydration error on load. Timestamps are now computed consistently and localised.

### Stability

- **Site config is escaped and self-heals on publish** — Config string fields are now escaped when writing `_config.yml`, and a corrupted `_config.yml` is repaired on the next publish instead of failing.

## v1.2.0-beta (2026-05-11)

A new Account page for identity, preferences, projects, and account deletion; a bug-report button that captures runtime context for issues; persistent UI language across devices and seeded into newly-created sites; and a more accurate publish change summary built on per-entity content hashing.

### New features

- **Account page** — `/account` is the new top-level user route, replacing the Settings link in the header dropdown. Five sections: Profile (name, avatar, joined month), Preferences (editor UI language and presence-cursor colour), Connected sites (every project the user belongs to with a kebab for delete-or-leave), GitHub access (every installation granted, with deep links to GitHub's management page), and Danger zone (full account deletion with a live collaborator-count warning)
- **Persistent UI language** — Language choice now persists to D1. Signing in on a new device restores the previously chosen language; creating a new site seeds `telar_language` in the generated `_config.yml` from the same preference, with a soft-fail amber warning surfaced on the Account page if the patch can't be applied
- **Bug report button** — Header now carries a bug-report button. Clicking it opens a panel pre-filled with the user's locale, recent console errors, the build SHA, and attachments the user can drag in, then submits as a GitHub issue against the compositor repo with a redacted payload. A post-crash variant renders inside route ErrorBoundaries so a user can still file a report when the page they were on has stopped working
- **Orphan-story handling** — When a story row in `project.csv` has been removed but the per-story CSV is still in the repo, the dashboard surfaces a banner. "Restore as drafts" pulls each orphan back into the project as a new draft; "Ignore" writes the orphan IDs to a `.compositor-ignored` file so they stop being flagged on every sync. Restores route through the project's Durable Object so live collaborators see the new drafts appear without reloading
- **Sync mismatch modal** — The Sync flow surfaces a four-mode modal that distinguishes untracked-files-only divergence from stale-HEAD, repo-side drift, and conflict states. Empty-state copy makes it clear when there is no actionable divergence
- **Telar v1.3.0 framework upgrade support** — The upgrade flow now recognises the v1.3.0 framework's homepage layout. On upgrade, the compositor hash-gates a replacement of `about.md` and the localised welcome body (only if untouched), removes obsolete frontmatter literals from the homepage's `index.md`, and silently creates `acerca.md` for Spanish sites that still carry the unedited v1.2.1 `about.md`. The homepage editor renders the v1.3.0 defaults as faded placeholders when the user hasn't customised them
- **Onboarding safety checks** — The connect flow now warns when the chosen repo is private and the user's GitHub plan can't be verified, alerts when the site's `telar_theme` isn't a recognised theme, and pre-checks installation scope before the user commits to a repo
- **Live deletion notifications** — Deleting a project or removing a collaborator now broadcasts over the project's WebSocket to every connected editor, so collaborators see a sticky toast and get cleanly disconnected instead of finding out by silent failure

### Data layer

- D1 migration 0025: `users.language_preference` (a write-once cookie default that nothing read) replaced with `users.ui_locale` (NULL means never actively chosen; non-null is the user's locked UI locale). **Forwards-only** — self-hosters cannot roll the database back past this release without manual schema work
- Bilingual CSV column added to `project.csv` for sites upgrading from older Telar framework versions: `show_sections` / `mostrar_secciones` (the column was already supported in v1.1.0 of the compositor; the v1.1.0→v1.2.0 manifest now backfills it on user repos)
- Per-entity content hashing — the publish change summary now hashes each story, page, object, and glossary term independently. The Review modal lists what was added, changed, and removed at per-entity granularity, and the commit body uses Added / Changed / Removed sections to match. A format-version sentinel detects mismatched snapshots so older saved state falls through to a safe full-recompute
- Order-only changes no longer trigger false-positive change rows in either the Sync modal or the publish change summary: object order, story order, and page order are excluded from the relevant diffs and hashes

### Security and stability

- **Empty-title pages now blocked at publish** — A page missing its title used to surface as a non-blocking warning. The publish pipeline now refuses the commit and surfaces the offending page in the Checks step with a direct link to fix it
- **Account deletion no longer leaves dangling projects** — Deleting your account auto-cascades any project on which you were the sole convenor, removing collaborator rows and the project record in one D1 batch. The signin page surfaces an "account deleted" banner so a tab that was open on a since-deleted account does not loop on failed-auth state
- **Sync reimport now journals before mutation** — Reimporting a project from the repo snapshots existing state before deletion and restores on failure, so a mid-reimport crash no longer leaves the project in a half-imported state
- **Repo HEAD cache with publish eviction** — Sync now caches the repo HEAD between checks within a single session and evicts the cache after a successful publish, reducing GitHub API pressure while keeping every publish accurate to actual repo state
- **Per-entity hashing back-compat** — When a project's snapshot predates per-entity hashing, the change summary surfaces existing pages and glossary terms as Modified once on the first run rather than treating the upgrade as a full rewrite

### Bug fixes

- **Review modal humanises all settings keys** — Settings changes in the publish Review modal previously showed raw keys for non-language settings; every setting now renders in human-readable form
- **No more duplicate `story_key` entries in `_config.yml`** — Repeated publishes used to append a fresh top-level `story_key` each time; only one is written now
- **Publish change summary reflects current state** — The publish loader now forces a Durable Object snapshot before reading from D1, so the summary reflects the latest collaborative edits instead of occasionally stale state
- **Step rows sort by step number on publish** — The story-CSV serialiser now sorts steps by step number; previously the CSV could emerge out of order after certain reorder-then-publish sequences
- **`telar_language` no longer dropped on publish** — The `_config.yml` serialiser threads `telar_language` through correctly, fixing a regression where republishing reset the field
- **Story-deletion toast names the right story** — Deleting a story used to surface the previously-deleted story's name in the toast; the key extractor now stabilises across the underlying `_id` backfill
- **New page nav tab tracks the latest title** — The nav tab label now tracks the page title after the slug is set, instead of pinning the early slug value
- **Auto-slug debounced and replaces the temporary slug** — The first keystroke in a new page's title no longer locks the URL; auto-slug is 600ms-debounced, and adding a page replaces the placeholder `untitled-page-N` slug with the title-derived slug as the user types
- **Untitled new pages now appear in the nav** — Adding a page used to leave it un-navigable until a title was set; the nav now surfaces a tab immediately on creation
- **Drag-reorder of pages-tab nav preserves entries** — Reordering tabs by drag could drop entries; the reorder helper now preserves all entries and corrects an off-by-one in the destination index
- **Navigation recovers from corrupted Y.Array state** — Sites that had been affected by an earlier collaboration-corruption bug now self-heal on load by sanitising the navigation Y.Array
- **Drag-reorder of editor steps preserves order across snapshots** — The editor's reorder-in-place helper drops a stray off-by-one that could shift a row past its intended slot under certain conditions
- **Site URL re-verified server-side on object commits** — The commit-objects action re-verifies the site URL server-side, blocking an edge case where a stale client URL could land in the commit
- **Dashboard status-bar timestamps clarified** — Last-published and last-synced labels drop trailing destinations for clarity, the last-published string is shortened to avoid overflow on narrow viewports, and the redundant "View site" affordance that surfaced twice has been removed

### Toolchain

- Build script now injects `BUILD_SHA` at compile time (`git rev-parse --short HEAD`), wired through Vite `define` and an ambient type declaration. The bug-report payload includes this so an issue ties back to a specific build
- A `data-env` attribute on `<html>` exposes the environment (production / staging / dev) to client code, used by the bug-report flow to label which environment a report came from
- i18next's global HTML-escape pass disabled — placeholder interpolation in some keys was double-escaping React-managed markup; React's own rendering remains the escape boundary

## v1.1.0-beta (2026-05-04)

Story sections with a table of contents, a collection-first homepage layout, a deploy smoke test that catches bundle-time crashes vitest can't see, and a swap from `isomorphic-dompurify` to `sanitize-html` for cleaner worker-bundle compatibility.

### New features

- **Story sections** — Stories can be broken into chapters with a new section-card step kind. The story sidebar gains a "+ Add section title" button alongside "+ Add step", and each section card renders as a centred heading-only step in the editor (no IIIF viewer, no layers)
- **Table of contents on title cards** — Per-story toggle on the title card surfaces section headings as a TOC on the published story; the toggle sits inline below the byline and shows a helper line when no section cards exist yet
- **Collection mode** — New homepage layout option that leads with objects (large thumbnails) and shows stories below. Toggle lives on the Config tab under Collection interface

### Data layer

- D1 migrations 0022–0024: `steps.kind` (media | section), `stories.show_sections` boolean, `project_config.collection_mode` boolean
- Bilingual CSV columns: `show_sections` / `mostrar_secciones` on `project.csv`; `kind` derivation from the empty-`object` column convention on `stories.csv`
- Defensive empty-object write for kind=section steps in publish output, so the framework's section-card signal is preserved even if internal state has drifted
- `collection_mode` round-trips through `_config.yml` as an unquoted boolean

### Security and stability

- **HTML sanitiser swap** — Replaces `isomorphic-dompurify` with `sanitize-html`. The policy preserves the same allowlist behaviour and continues to reject `data:image/svg+xml` on `<img src>`. `sanitize-html` runs natively in the worker without pulling Node-only dependencies into the bundle
- **Predeploy smoke test** — `npm run deploy` now runs `npm run build && npm run smoke` before `wrangler deploy`. The smoke harness boots `wrangler dev` against the built bundle, hits `GET /`, and aborts deploy on any 5xx — catching the class of bundle-time errors that typecheck and vitest can't surface

### Toolchain

- Typecheck CI workflow runs `tsc --noEmit` on every push to main and every PR
- TypeScript strict-narrowing fixes in `_app.dashboard.tsx`, `_app.objects.tsx`, `_app.objects.$objectId.tsx`, `_app.pages.tsx`, and four IDOR-guard tests so the codebase passes typecheck cleanly
- New dependencies: `sanitize-html`, `@types/sanitize-html`
- Removed: `isomorphic-dompurify`

## v1.0.1-beta (2026-05-03)

Security hardening and stability fixes following the v1.0.0-beta launch. Tightens authorisation across every authenticated route, sanitises rendered markdown and image URLs, locks down the collaboration Durable Object's internal endpoints, and relicenses the compositor under AGPL-3.0.

### Relicense

- **AGPL-3.0** — Telar Compositor is now licensed under the GNU Affero General Public License v3.0. Anyone may use, modify, and self-host the compositor; running a modified version as a network service for others requires publishing the modifications under the same license. The trademarks "Telar", "Telar Compositor", "AMPL", and the associated logos remain outside the AGPL grant

### Security hardening

- **Per-project membership enforcement** — Every authenticated route loader and action now resolves the active project via a shared `requireProjectMember` helper; non-members get a 403 instead of seeing other projects' data
- **HTML sanitisation in markdown previews** — `marked.parse` output is run through `isomorphic-dompurify` before reaching React, blocking script injection and unsafe attributes in narrative previews and glossary bodies
- **Image URL allowlist** — Markdown image refs and IIIF manifest URLs reject `userinfo`-bearing URLs and `data:image/svg+xml`; only safe http(s) and `data:image/{png,jpeg,gif,webp}` schemes are accepted
- **Shared session-cookie helpers** — Cookie parsing and user-id resolution moved into `workers/auth.ts`, so the worker, can-delete handler, and snapshot endpoint all run the same hardened path
- **Signed internal marker on Durable Object endpoints** — `/snapshot` and `/reset` now require an HMAC-signed marker from the worker; outside callers cannot reach them even with a valid session
- **Server-side `canDelete` on Yjs deletes** — Structural deletes through the collaborative editor route through a server-side handler that re-checks role and project membership; reorder and clone integrity preserved across concurrent edits
- **Atomic cascade unlink** — Removing a project's members, invites, pages, and project link is now issued as a single D1 batch, so a partial failure can no longer leave dangling rows

### Reliability

- **Yjs revert flag** — Structural ops are guarded by an `isReverting` flag so they cannot double-apply against a Y.Doc after a server-side revert
- **Navigation editor** — Config tab now hosts a dedicated editor for the site's top navigation
- **Feature UI refresh** — Collaborator modals, dashboard rows, onboarding forms, and story rows reworked for clearer affordances and consistent layout

### Bug fixes

- **Onboarding wizard done-step** — Fixed a `ReferenceError` on `createSessionStorage` that crashed the final step of the onboarding flow

### Toolchain

- New dependency: `isomorphic-dompurify`
- Tighter `Uint8Array<ArrayBuffer>` typing on Web Crypto helpers
- `npm run typecheck` now passes `--noEmit` to `tsc`

## v1.0.0-beta (2026-04-17)

Real-time multi-user editing, in-app framework upgrades, and the pages and glossary editors that bring the compositor to feature parity with Telar 1.2.0. The largest release in the compositor's history.

### Real-time collaboration

- **Up to 6 editors per project** — Members work in the same project simultaneously and see each other's changes instantly. Built on Yjs with a Cloudflare Durable Object per project; state survives reload and disconnect
- **Presence avatars** — Header shows everyone currently in the project, with a hover tooltip indicating which page they're viewing or editing
- **Per-field "currently editing" indicators** — Inline fields show a coloured highlight when another member is typing in them
- **Convenor / collaborator roles** — Project owners can invite collaborators by email; collaborators can edit but not delete other people's work or run destructive actions
- **Contribution tracking** — Donut chart in the new collaboration sidebar shows each member's edit share, sourced from per-field authorship metadata
- **Shared undo/redo** — Ctrl/Cmd+Z works across all collaborative surfaces and respects other members' concurrent edits
- **Snapshot integrity** — Server-side guard prevents Y.Array duplication during snapshot persistence

### In-app framework upgrades

- **One-click upgrade flow** — Detect new Telar releases and run the framework migration on the user's repo without leaving the compositor
- **Bundled migration manifests** — Five hand-authored migrations cover every framework transition from v0.9.2-beta through v1.2.0; manifests for newer releases ship as GitHub Release assets
- **Freeze modal during upgrades** — All connected clients see a full-screen overlay while the upgrade runs; non-owners auto-reload when it completes
- **External version drift detection** — If someone changes the framework version in GitHub directly, the dashboard surfaces a toast on next sync
- **Manual-step rendering** — Upgrades that require user action surface the steps in the done screen with markdown bodies and "Read more" links

### New content surfaces

- **Pages editor** — First-class editor for static pages with sortable navigation, slug uniqueness enforcement, and bilingual support
- **Glossary editor** — Two-column editor for glossary terms with markdown bodies and `[[term_id]]` link insertion from any markdown surface

### Editor improvements

- **Layer panel** — Per-step layer editor with drag-to-reorder
- **Refined step layout** — Tightened title-card, narrative, and viewer columns; consistent inline editing across all fields
- **Glossary link button** in the markdown toolbar with searchable term picker
- **Image upload metadata flow** — Walks users through file selection, metadata entry, and dismiss confirmation before the commit-and-build

### Onboarding and dashboard

- **Dashboard tabs** — Site / Team / Settings tabs with a five-step workflow guide on the Start page
- **Pagination of installation repos** — Onboarding search now sees every repo in the installation, not just the first page
- **Cascade unlink** — Removing a project also clears its members, invites, and pages
- **Connected sites** — Onboarding separates already-connected sites with open/resume actions
- **Install on another account** — Inline callout to install the GitHub App on additional accounts or organisations
- **Page count in import progress** — Onboarding surfaces page count alongside object and story counts
- **Refreshed layout chrome** — Header, footer, tab nav, restriction banner

### Bug fixes

- **YAML escape in published output** — Page titles or nav labels containing `:`, `"`, or newlines no longer produce malformed Jekyll output
- **Sync divergence banner** — Banner now actually shows when there's real divergence between repo and compositor; previously always silently disabled
- **Object delete leaves no orphans** — Deleting an object now removes both the metadata row and the image files from the repo; previously files accumulated as orphans
- **Rich paste no longer duplicates content** — Pasting HTML into the markdown editor no longer inserts the markdown twice
- **CSV genre column** — Object exports now include the `medium_genre` column for all object operations

### Infrastructure

- D1 migrations 0015–0021: collaboration tables, Yjs state blob, presence colours, contributions JSON, objects order, navigation slug uniqueness
- New dependencies: `yjs`, `y-websocket`, `y-codemirror.next`
- Cloudflare Durable Object binding (`COLLABORATION` → `ProjectCollaborationDO`)
- TypeScript clean across `app/`, `workers/`, and `tests/`

## v0.3.0-beta (2026-04-09)

Create new site flow — users can generate a fresh Telar site from the repo template without leaving the compositor.

### New features

- **Create new site from template** — Single-field form generates a brand-new Telar site via GitHub's repo template API. Defaults to your personal account; creating in an organisation requires an explicit account picker. Includes debounced name-availability checking and an inline progress view
- **Installation scope prompt** — Reusable component guides users through granting the GitHub App access to a specific repo when the site they selected is outside the App's current scope
- **Orphan repo badge** — Repos that exist in the user's GitHub account but aren't yet visible to the compositor now display a "New — connect to continue" badge in the repo list
- **Connect flow view-mode toggle** — The connect step surfaces a "Create new site" CTA alongside the existing repo picker, with a single toggle between the two modes

### Bug fixes

- The "View site" button at the end of the publish sequence now always renders, falling back to the default GitHub Pages URL pattern when the project's stored Pages URL is not populated, and is stacked on its own line above the View commit link

## v0.2.0-beta (2026-03-24)

Framework v1.0.0 compatibility — video/audio story steps, clip capture, and media type detection.

### New features

- **Video embed support** — YouTube, Vimeo, and Google Drive videos render inline in the story editor viewer column
- **Audio player** — WaveSurfer waveform player with play/pause controls for audio story steps
- **Clip capture** — Record start/end timestamps from video and audio players; toggle loop playback per step
- **Media type detection** — Automatic detection of IIIF, YouTube, Vimeo, Google Drive, audio, and text-only objects from source URLs
- **Media type badges** — Step sidebar shows Video, Music, or Text icons per step
- **Object type relabel** — "Type" field renamed to "Genre or Medium" to match framework v1.0.0 CSV column

### Data layer

- D1 schema migration adds `clip_start`, `clip_end`, `loop` columns to steps table
- CSV export includes clip fields with bilingual column mappings
- Import reads clip/loop values from framework v1.0.0 story CSVs
- Objects CSV column `object_type` mapped to framework `medium_genre`
- Round-trip publish preserves all clip and media type data

## v0.1.0-beta (2026-03-22)

First release — full story composition workflow from GitHub sign-in to published site.

### Authentication and onboarding

- GitHub App sign-in with encrypted token storage and transparent refresh
- Repo connection wizard: detect Telar sites, import content from CSV or Google Sheets
- GitHub Pages enablement during onboarding

### Dashboard and stories

- Pedagogical landing page with site preview sections and inline editing
- Stories tab with drag-to-reorder, creation, deletion, draft/private toggles
- Multi-project support with project switching

### Objects manager

- Object list with thumbnails, status indicators, and featured toggle
- Metadata editing with IIIF manifest auto-fetch for external objects
- Image upload with metadata entry and background IIIF tile generation
- Immediate CSV commit to repo with GitHub Actions build tracking

### Story editor

- Inline editing for title, subtitle, byline, question, and answer fields
- IIIF viewer with pan/zoom and coordinate capture per step
- Step management: add, insert, delete, reorder with drag handles
- CodeMirror live preview editor with formatting toolbar, keyboard shortcuts, and rich paste
- Link popover, image insertion from URL or IIIF objects
- Alt text fields for objects and zoomed regions

### Publish and sync

- Change summary with pre-publish validation
- Atomic commit to GitHub via GraphQL, attributed to user
- Build progress tracking with GitHub Actions polling
- Re-sync detection on return with conflict warning
- Site version detection and one-click framework upgrade

### Infrastructure

- Cloudflare Workers + D1 with Drizzle ORM
- EN/ES internationalisation throughout
- YouTube/Vimeo iframe preservation on paste
- GitHub Actions control: [skip ci] support, targeted workflow dispatch
