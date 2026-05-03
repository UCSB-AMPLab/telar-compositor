# Changelog

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
