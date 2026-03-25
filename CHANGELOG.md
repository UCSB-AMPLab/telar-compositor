# Changelog

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
