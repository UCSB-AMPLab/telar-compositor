# Telar Compositor

![Version](https://img.shields.io/badge/version-1.3.6--beta-orange) ![License](https://img.shields.io/badge/license-AGPL%20v3-blue)

**[Versión en español abajo](#español)** | **[English version](#telar-compositor)**

A web-based visual editor for creating [Telar](https://github.com/UCSB-AMPLab/telar) stories, replacing the Google Sheets and local CSV workflows with a WYSIWYG interface for composing stories, managing objects, and publishing — all connected to GitHub.

---

**[Telar Documentation](https://telar.org/docs)** | **[Example Site](https://ampl.clair.ucsb.edu/telar)** | **[Report Issues](https://github.com/UCSB-AMPLab/telar-compositor/issues)**

---

> **⚠️ Beta Release — v1.3.6-beta**
> The compositor is in active development. It works with Telar sites running framework v0.9.2-beta or later, and ships with bundled migrations through v1.2.0.

## Overview

Telar Compositor gives students and non-technical users a visual interface to build Telar stories without touching CSVs, markdown, or Git. It handles everything between editing and a live site: importing existing content, editing stories with an IIIF viewer and rich text editor, managing image and multimedia objects, collaborating in real time, upgrading the underlying framework, and publishing changes as atomic commits to GitHub.

## Key Features

- **Realtime collaboration** — Multiple editors can work on the same project at once with presence avatars, per-field "currently editing" indicators, and convenor / collaborator roles backed by GitHub identity
- **Visual story editor** — Inline editing for titles, subtitles, and metadata; IIIF viewer with pan/zoom and coordinate capture; CodeMirror live preview editor for narrative text
- **Pages and glossary** — First-class editors for static pages (with sortable navigation) and glossary terms (with `[[term_id]]` links from any markdown surface)
- **Objects manager** — Browse, edit, and add IIIF objects; upload images directly to the repo with automatic tile generation
- **Video and audio support** — YouTube, Vimeo, and Google Drive embeds; WaveSurfer audio player; clip capture with start/end timestamps
- **One-click publish** — Review changes, run pre-publish checks, and commit to GitHub in a single atomic commit with build tracking
- **In-app upgrades** — Detect new Telar releases, run bundled migration manifests against the user's repo, and atomically commit the result without ever leaving the compositor
- **Bilingual interface** — Complete English and Spanish UI

## Stack

- [Cloudflare Workers](https://workers.cloudflare.com/) + [D1](https://developers.cloudflare.com/d1/) — Backend, database, and Durable Objects for collaboration state
- [Yjs](https://yjs.dev/) + [y-websocket](https://github.com/yjs/y-websocket) — CRDT-based realtime sync
- [React 19](https://react.dev/) + [React Router v7](https://reactrouter.com/) — SSR frontend
- [Tailwind CSS v4](https://tailwindcss.com/) — Styling
- [OpenSeadragon](https://openseadragon.github.io/) — IIIF viewer
- [CodeMirror 6](https://codemirror.net/) — Markdown editor with rich-paste and glossary links
- [WaveSurfer.js](https://wavesurfer.xyz/) — Audio waveform player
- [i18next](https://www.i18next.com/) — Internationalisation

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars  # then fill in the values below
npm run dev                     # starts at http://localhost:4005
```

Required variables in `.dev.vars`:

| Variable | Description |
|----------|-------------|
| `GITHUB_CLIENT_ID` | GitHub App OAuth client ID |
| `GITHUB_CLIENT_SECRET` | GitHub App OAuth client secret |
| `GITHUB_CALLBACK_URL` | OAuth callback URL (e.g. `http://localhost:4005/callback`) |
| `ENCRYPTION_KEY` | 32-byte hex key for token encryption (`openssl rand -hex 32`) |
| `SESSION_SECRET` | Session signing secret |
| `GITHUB_APP_ID` | GitHub App ID (for installation token features) |
| `GITHUB_PRIVATE_KEY` | GitHub App private key PEM (for installation token features) |

Other commands: `npm run build`, `npm run deploy`, `npm run typecheck`, `npx vitest`.

## License

Telar Compositor is licensed under the [GNU Affero General Public License v3.0](LICENSE).

Anyone may use, modify, and self-host Telar Compositor under AGPL terms. If you run a modified version as a network service for others, you must publish your modifications under the same license — this protects the upstream commons that AMPL, Neogranadina, and partner institutions depend on.

The license governs the software. The stories, objects, and content you publish with Telar Compositor belong to you and your institution.

## Trademarks

"Telar", "Telar Compositor", "AMPL", and the associated logos are not covered by the AGPL-3.0 license. Forks may use the code freely under AGPL terms but should not present themselves as official Telar or AMPL releases.

## Credits

Telar is developed by Adelaida Ávila, Juan Cobo Betancourt, Natalie Cobo, Santiago Muñoz, and students and scholars at the [UCSB Archives, Memory, and Preservation Lab](https://ampl.clair.ucsb.edu), the UT Archives, Mapping, and Pedagogy Lab, and [Neogranadina](https://neogranadina.org).

We gratefully acknowledge the support of the [Caribbean Digital Scholarship Collective](https://cdscollective.org), the [Center for Innovative Teaching, Research, and Learning (CITRAL)](https://citral.ucsb.edu/home) at the University of California, Santa Barbara, the [UCSB Library](https://library.ucsb.edu), the [Routes of Enslavement in the Americas University of California MRPI](https://www.humanities.uci.edu/routes-enslavement-americas), and the [Department of History of The University of Texas at Austin](https://liberalarts.utexas.edu/history/).

## Support

- **Telar Documentation:** [telar.org/docs](https://telar.org/docs)
- **Report Issues:** [GitHub Issues](https://github.com/UCSB-AMPLab/telar-compositor/issues)
- **Example Site:** [ampl.clair.ucsb.edu/telar](https://ampl.clair.ucsb.edu/telar)

---
---

# Español

![Versión](https://img.shields.io/badge/versión-1.3.6--beta-orange) ![Licencia](https://img.shields.io/badge/licencia-AGPL%20v3-blue)

**[Versión en español](#español)** | **[English version above](#telar-compositor)**

Un editor visual web para crear historias de [Telar](https://github.com/UCSB-AMPLab/telar), que reemplaza los flujos de trabajo con Google Sheets y archivos CSV locales con una interfaz visual para componer historias, gestionar objetos y publicar — todo conectado a GitHub.

---

**[Documentación de Telar](https://telar.org/guia)** | **[Sitio de ejemplo](https://ampl.clair.ucsb.edu/telar)** | **[Reportar problemas](https://github.com/UCSB-AMPLab/telar-compositor/issues)**

---

> **⚠️ Versión Beta — v1.3.6-beta**
> El compositor está en desarrollo activo. Funciona con sitios Telar que usan el framework v0.9.2-beta o posterior, e incluye las migraciones para actualizar hasta la v1.2.0.

## Descripción general

Telar Compositor ofrece a estudiantes y usuarios no técnicos una interfaz visual para construir historias de Telar sin tocar archivos CSV, markdown ni Git. Se encarga de todo entre la edición y un sitio en línea: importar contenido existente, editar historias con un visor IIIF y un editor de texto enriquecido, gestionar objetos de imagen y multimedia, colaborar en tiempo real, actualizar la versión del framework y publicar cambios como commits atómicos en GitHub.

## Características principales

- **Colaboración en tiempo real** — Varios editores pueden trabajar en el mismo proyecto al mismo tiempo, con avatares de presencia, indicadores de "editando ahora" por campo y roles de convocante / colaborador respaldados por la identidad de GitHub
- **Editor visual de historias** — Edición en línea de títulos, subtítulos y metadatos; visor IIIF con desplazamiento, zoom y captura de coordenadas; editor CodeMirror con vista previa en vivo para texto narrativo
- **Páginas y glosario** — Editores integrados para páginas estáticas (con navegación reordenable) y términos del glosario (con enlaces `[[term_id]]` desde cualquier superficie de markdown)
- **Gestor de objetos** — Explorar, editar y agregar objetos IIIF; subir imágenes directamente al repositorio con generación automática de teselas
- **Soporte de video y audio** — Embebidos de YouTube, Vimeo y Google Drive; reproductor de audio WaveSurfer; captura de clips con marcas de inicio y fin
- **Publicación con un clic** — Revisar cambios, ejecutar verificaciones previas y hacer commit en GitHub en una sola operación atómica con seguimiento de la construcción
- **Actualizaciones integradas** — Detectar nuevas versiones de Telar, ejecutar las migraciones incluidas sobre el repositorio del usuario y hacer commit del resultado de forma atómica sin salir del compositor
- **Interfaz bilingüe** — Interfaz completa en inglés y español

## Stack tecnológico

- [Cloudflare Workers](https://workers.cloudflare.com/) + [D1](https://developers.cloudflare.com/d1/) — Backend, base de datos y Durable Objects para el estado de colaboración
- [Yjs](https://yjs.dev/) + [y-websocket](https://github.com/yjs/y-websocket) — Sincronización en tiempo real basada en CRDT
- [React 19](https://react.dev/) + [React Router v7](https://reactrouter.com/) — Frontend con SSR
- [Tailwind CSS v4](https://tailwindcss.com/) — Estilos
- [OpenSeadragon](https://openseadragon.github.io/) — Visor IIIF
- [CodeMirror 6](https://codemirror.net/) — Editor de markdown con pegado enriquecido y enlaces al glosario
- [WaveSurfer.js](https://wavesurfer.xyz/) — Reproductor de audio con forma de onda
- [i18next](https://www.i18next.com/) — Internacionalización

## Licencia

Telar Compositor se distribuye bajo la [Licencia Pública General Affero de GNU v3.0](LICENSE).

Cualquier persona puede usar, modificar e instalar el Compositor de Telar en su propia infraestructura según los términos de la AGPL. Quien ofrezca una versión modificada como servicio en línea a terceros debe publicar esas modificaciones bajo la misma licencia — esto protege el ecosistema abierto que sostienen AMPL, Neogranadina y las instituciones aliadas.

La licencia rige el software. Las historias, los objetos y el contenido que usted publique con Telar Compositor son suyos y de su institución.

## Marcas

"Telar", "Telar Compositor", "AMPL", y los logos asociados no están cubiertos por la licencia AGPL-3.0. Quien haga un fork puede usar el código libremente bajo los términos de la AGPL, pero no debe presentarse como versión oficial de Telar ni de AMPL.

## Créditos

Telar es desarrollado por Adelaida Ávila, Juan Cobo Betancourt, Natalie Cobo, Santiago Muñoz, y estudiantes e investigadores del [UCSB Archives, Memory, and Preservation Lab](https://ampl.clair.ucsb.edu), el UT Archives, Mapping, and Pedagogy Lab, y [Neogranadina](https://neogranadina.org).

Agradecemos el apoyo del [Caribbean Digital Scholarship Collective](https://cdscollective.org), el [Center for Innovative Teaching, Research, and Learning (CITRAL)](https://citral.ucsb.edu/home) de la University of California, Santa Barbara, la [UCSB Library](https://library.ucsb.edu), el [Routes of Enslavement in the Americas University of California MRPI](https://www.humanities.uci.edu/routes-enslavement-americas), y el [Department of History of The University of Texas at Austin](https://liberalarts.utexas.edu/history/).

## Soporte

- **Documentación de Telar:** [telar.org/guia](https://telar.org/guia)
- **Reportar problemas:** [GitHub Issues](https://github.com/UCSB-AMPLab/telar-compositor/issues)
- **Sitio de ejemplo:** [ampl.clair.ucsb.edu/telar](https://ampl.clair.ucsb.edu/telar)
