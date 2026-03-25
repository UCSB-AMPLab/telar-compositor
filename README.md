# Telar Compositor

![Version](https://img.shields.io/badge/version-0.2.0--beta-orange) ![License](https://img.shields.io/badge/license-MIT-blue)

**[Versión en español abajo](#español)** | **[English version](#telar-compositor)**

A web-based visual editor for creating [Telar](https://github.com/UCSB-AMPLab/telar) stories, replacing the Google Sheets and local CSV workflows with a WYSIWYG interface for composing stories, managing objects, and publishing — all connected to GitHub.

---

**[Telar Documentation](https://telar.org/docs)** | **[Example Site](https://ampl.clair.ucsb.edu/telar)** | **[Report Issues](https://github.com/UCSB-AMPLab/telar-compositor/issues)**

---

> **⚠️ Beta Release - v0.2.0-beta**
> The compositor is in active development. It requires a Telar site running framework v1.0.0-beta or later.

## Overview

Telar Compositor gives students and non-technical users a visual interface to build Telar stories without touching CSVs, markdown, or Git. It handles everything between editing and a live site: importing existing content, editing stories with an IIIF viewer and rich text editor, managing image and multimedia objects, and publishing changes as atomic commits to GitHub.

## Key Features

- **Visual story editor** — Inline editing for titles, subtitles, and metadata; IIIF viewer with pan/zoom and coordinate capture; CodeMirror live preview editor for narrative text
- **Objects manager** — Browse, edit, and add IIIF objects; upload images directly to the repo with automatic tile generation
- **Video and audio support** — YouTube, Vimeo, and Google Drive embeds; WaveSurfer audio player; clip capture with start/end timestamps
- **One-click publish** — Review changes, run pre-publish checks, and commit to GitHub in a single atomic commit with build tracking
- **Sync and upgrade** — Detect repo changes on return, re-sync content, and upgrade the Telar framework version with one click
- **Bilingual interface** — Complete English and Spanish UI

## Stack

- [Cloudflare Workers](https://workers.cloudflare.com/) + [D1](https://developers.cloudflare.com/d1/) — Backend and database
- [React 19](https://react.dev/) + [React Router v7](https://reactrouter.com/) — SSR frontend
- [Tailwind CSS v4](https://tailwindcss.com/) — Styling
- [OpenSeadragon](https://openseadragon.github.io/) — IIIF viewer
- [CodeMirror 6](https://codemirror.net/) — Markdown editor
- [WaveSurfer.js](https://wavesurfer.xyz/) — Audio waveform player
- [i18next](https://www.i18next.com/) — Internationalisation

## License

MIT License — see [LICENSE](LICENSE) file for details.

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

![Versión](https://img.shields.io/badge/versión-0.2.0--beta-orange) ![Licencia](https://img.shields.io/badge/licencia-MIT-blue)

**[Versión en español](#español)** | **[English version above](#telar-compositor)**

Un editor visual web para crear historias de [Telar](https://github.com/UCSB-AMPLab/telar), que reemplaza los flujos de trabajo con Google Sheets y archivos CSV locales con una interfaz visual para componer historias, gestionar objetos y publicar — todo conectado a GitHub.

---

**[Documentación de Telar](https://telar.org/guia)** | **[Sitio de ejemplo](https://ampl.clair.ucsb.edu/telar)** | **[Reportar problemas](https://github.com/UCSB-AMPLab/telar-compositor/issues)**

---

> **⚠️ Versión Beta - v0.2.0-beta**
> El compositor está en desarrollo activo. Requiere un sitio Telar con la versión v1.0.0-beta del framework o posterior.

## Descripción general

Telar Compositor ofrece a estudiantes y usuarios no técnicos una interfaz visual para construir historias de Telar sin tocar archivos CSV, markdown ni Git. Se encarga de todo entre la edición y un sitio en línea: importar contenido existente, editar historias con un visor IIIF y editor de texto enriquecido, gestionar objetos de imagen y multimedia, y publicar cambios como commits atómicos en GitHub.

## Características principales

- **Editor visual de historias** — Edición en línea de títulos, subtítulos y metadatos; visor IIIF con desplazamiento, zoom y captura de coordenadas; editor CodeMirror con vista previa en vivo para texto narrativo
- **Gestor de objetos** — Explorar, editar y agregar objetos IIIF; subir imágenes directamente al repositorio con generación automática de teselas
- **Soporte de video y audio** — Embebidos de YouTube, Vimeo y Google Drive; reproductor de audio WaveSurfer; captura de clips con marcas de inicio y fin
- **Publicación con un clic** — Revisar cambios, ejecutar verificaciones previas y hacer commit en GitHub con una sola operación atómica con seguimiento de construcción
- **Sincronización y actualización** — Detectar cambios en el repositorio al regresar, resincronizar contenido y actualizar la versión del framework Telar con un clic
- **Interfaz bilingüe** — Interfaz completa en inglés y español

## Stack tecnológico

- [Cloudflare Workers](https://workers.cloudflare.com/) + [D1](https://developers.cloudflare.com/d1/) — Backend y base de datos
- [React 19](https://react.dev/) + [React Router v7](https://reactrouter.com/) — Frontend con SSR
- [Tailwind CSS v4](https://tailwindcss.com/) — Estilos
- [OpenSeadragon](https://openseadragon.github.io/) — Visor IIIF
- [CodeMirror 6](https://codemirror.net/) — Editor de markdown
- [WaveSurfer.js](https://wavesurfer.xyz/) — Reproductor de audio con forma de onda
- [i18next](https://www.i18next.com/) — Internacionalización

## Licencia

Licencia MIT — ver el archivo [LICENSE](LICENSE) para más detalles.

## Créditos

Telar es desarrollado por Adelaida Ávila, Juan Cobo Betancourt, Natalie Cobo, Santiago Muñoz, y estudiantes e investigadores del [UCSB Archives, Memory, and Preservation Lab](https://ampl.clair.ucsb.edu), el UT Archives, Mapping, and Pedagogy Lab, y [Neogranadina](https://neogranadina.org).

Agradecemos el apoyo del [Caribbean Digital Scholarship Collective](https://cdscollective.org), el [Center for Innovative Teaching, Research, and Learning (CITRAL)](https://citral.ucsb.edu/home) de la University of California, Santa Barbara, la [UCSB Library](https://library.ucsb.edu), el [Routes of Enslavement in the Americas University of California MRPI](https://www.humanities.uci.edu/routes-enslavement-americas), y el [Department of History of The University of Texas at Austin](https://liberalarts.utexas.edu/history/).

## Soporte

- **Documentación de Telar:** [telar.org/guia](https://telar.org/guia)
- **Reportar problemas:** [GitHub Issues](https://github.com/UCSB-AMPLab/telar-compositor/issues)
- **Sitio de ejemplo:** [ampl.clair.ucsb.edu/telar](https://ampl.clair.ucsb.edu/telar)
