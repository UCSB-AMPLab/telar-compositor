/**
 * Vendored telar-docs slices for the in-product Docs drawer.
 *
 * This is a BUILD-TIME SNAPSHOT, not a runtime fetch. The bodies below are
 * faithfully transcribed from the telar-docs source (the `docs/*.md` EN files
 * and their `docs/*.es.md` ES counterparts), resolving each DOC id to its
 * source file by matching the EN file's frontmatter `permalink` to the doc's
 * `href`. The Jekyll frontmatter (the leading `---` fence block) is stripped —
 * only the prose body is vendored. Each slice is a faithful, representative
 * excerpt of the source (the drawer renders a slice, not the full doc), so the
 * full article always lives one click away behind "Open on telar.org ↗". When
 * telar-docs changes, refresh these slices from the source files.
 *
 * Do NOT add a `.server.ts` suffix — this module is imported by BOTH the SSR
 * isolate and the browser bundle (the drawer renders client-side). There is NO
 * Node `fs` or runtime I/O: the content is inlined as TS string literals.
 *
 * Source → DOC id map (EN file ↔ permalink ↔ DOC.href):
 *   configure ← 3-2-configuration.md   (/docs/configure/configuration/)
 *   objects   ← 9-3-objects.md         (/docs/the-compositor/objects/)
 *   stories   ← 9-4-story-editor.md    (/docs/the-compositor/story-editor/)
 *   glossary  ← 6-2-glossary.md        (/docs/site-features/glossary/)
 *   pages     ← 6-4-custom-pages.md    (/docs/site-features/custom-pages/)
 *   publish   ← 9-6-publishing.md      (/docs/the-compositor/publishing/)
 *   intro     ← 9-0-compositor.md      (/docs/the-compositor/)
 *   iiif      ← 4-3-external-iiif.md    (/docs/your-content/external-iiif/)
 *   start     ← 1-1-compositor.md      (/docs/getting-started/compositor/)
 *   narrative ← 1-4-narrative-structure.md (/docs/getting-started/narrative-structure/)
 *   markdown  ← 4-6-markdown-syntax.md  (/docs/your-content/markdown-syntax/)
 *   refine    ← 1-6-review-refine.md    (/docs/getting-started/review-refine/)
 *   video     ← 9-5-video-audio.md      (/docs/the-compositor/video-audio/)
 *   sync      ← 9-7-sync-updates.md     (/docs/the-compositor/sync-updates/)
 *
 * @version v1.4.0-beta
 */

/** A single vendored doc slice. */
export interface DocSlice {
  /** DOC.href — the telar.org path. "Open on telar.org ↗" → https://telar.org{href}. */
  href: string;
  titleEn: string;
  titleEs: string;
  /** Markdown body (EN), frontmatter stripped — rendered via marked → sanitiseHtml. */
  bodyEn: string;
  /** Markdown body (ES), frontmatter stripped. */
  bodyEs: string;
  /** Related DOC ids for the drawer "See also" section. */
  seeAlso?: DocId[];
}

/** The 14 DOC ids covered by the in-product Docs drawer. */
export type DocId =
  | "configure"
  | "objects"
  | "stories"
  | "glossary"
  | "pages"
  | "publish"
  | "intro"
  | "iiif"
  | "start"
  | "narrative"
  | "markdown"
  | "refine"
  | "video"
  | "sync";

export const DOCS: Record<DocId, DocSlice> = {
  // --- 3-2-configuration.md ----------------------------------------------
  configure: {
    href: "/docs/configure/configuration/",
    titleEn: "Configuration reference",
    titleEs: "Referencia de configuración",
    seeAlso: ["publish", "start"],
    bodyEn: `# Configuration

Configure your Telar site through the \`_config.yml\` file in your repository root.

## Site Settings

Basic site information and appearance:

\`\`\`yaml
# Site Settings
title: Your Narrative Title
description: A brief description of your narrative exhibition
baseurl: "/repository-name"  # For GitHub Pages subdirectory
url: "https://username.github.io"
author: Your Name
email: your-email@example.com
telar_theme: "paisajes"  # Options: paisajes, neogranadina, santa-barbara, austin, or custom
logo: ""  # Path to logo image (optional)
telar_language: "en"  # Options: "en" (English), "es" (Español)
collection_mode: false  # Set to true for objects-first homepage layout
\`\`\`

### collection_mode

Switches the homepage layout from stories-first (default) to objects-first:

- **\`false\` (default)**: Stories appear first on the homepage, with a sample of objects below
- **\`true\`**: Objects appear first in a large grid (up to 8), with stories in a smaller grid below

### baseurl vs. url

- **url**: Your site's base domain
- **baseurl**: Path after domain (use \`""\` for root domain, or \`/repo-name\` for GitHub Pages)`,
    bodyEs: `# Configuración

Configura tu sitio Telar usando el archivo \`_config.yml\` en la raíz de tu repositorio.

## Ajustes del sitio

Información básica y apariencia del sitio:

\`\`\`yaml
# Site Settings
title: Título de tu Narrativa
description: Una breve descripción de tu exhibición narrativa
baseurl: "/nombre-repositorio"  # Para un subdirectorio en GitHub Pages
url: "https://usuario.github.io"
author: Tu Nombre
email: tu-email@ejemplo.com
telar_theme: "paisajes"  # Opciones: paisajes, neogranadina, santa-barbara, austin, o custom
logo: ""  # Ruta a imagen de logo (opcional)
telar_language: "en"  # Opciones: "en" (English), "es" (Español)
collection_mode: false  # Ponlo en true para una página principal centrada en objetos
\`\`\`

### collection_mode

Cambia el diseño de la página principal de historias primero (predeterminado) a objetos primero:

- **\`false\` (predeterminado)**: Las historias aparecen primero en la página principal, con una muestra de objetos debajo
- **\`true\`**: Los objetos aparecen primero en una cuadrícula grande (hasta 8), con las historias en una cuadrícula más pequeña debajo

### baseurl vs. url

- **url**: Dominio base de tu sitio
- **baseurl**: Ruta después del dominio (usa \`""\` para el dominio raíz, o \`/nombre-repo\` para GitHub Pages)`,
  },

  // --- 9-3-objects.md ----------------------------------------------------
  objects: {
    href: "/docs/the-compositor/objects/",
    titleEn: "Objects in the Compositor",
    titleEs: "Objetos en el Compositor",
    seeAlso: ["iiif", "publish"],
    bodyEn: `# Objects

The Objects page in the Compositor lets you browse, edit, and add the visual items that make up your exhibition. Every object you manage here — images, IIIF manifests, videos, audio files — is tracked in your repository's \`objects.csv\` file. The Compositor handles that file for you, so you never need to edit it directly.

## Object list

The object list shows all objects in your exhibition as a grid of thumbnails. Each object displays:

- A **thumbnail** preview of the image or media
- The object's **title**
- A **status indicator** showing its current state

### Status indicators

Objects can have one of three statuses:

- **Ready** — The object has metadata and its image tiles are available. It is ready to use in stories.
- **No metadata** — The object exists but is missing key information like title, creator, or description. You can still use it in stories, but adding metadata improves your exhibition.
- **Tiles missing** — The object's IIIF tiles have not been generated yet. This can happen with newly uploaded images that have not been published and built.

## Edit metadata

Select an object to open its metadata editor. Here you can fill in or update the information that describes the object in your exhibition.

## Add external IIIF

You can add objects from museums, libraries, and other institutions that publish IIIF manifests. The Compositor fetches the image and metadata automatically.

1. Click **Add Object** and select the IIIF option
2. Paste the manifest URL into the field
3. The Compositor retrieves the image and fills in available metadata (title, creator, description)
4. Review and adjust the metadata as needed
5. Save the object`,
    bodyEs: `# Objetos

La página de objetos en el Compositor te permite explorar, editar y agregar los elementos visuales que componen tu exhibición. Cada objeto que administras aquí — imágenes, manifiestos IIIF, videos, archivos de audio — se registra en el archivo \`objects.csv\` de tu repositorio. El Compositor se encarga de ese archivo por ti, así que nunca necesitas editarlo directamente.

## Lista de objetos

La lista de objetos muestra todos los objetos de tu exhibición como una cuadrícula de miniaturas. Cada objeto muestra:

- Una **miniatura** de vista previa de la imagen o el medio
- El **título** del objeto
- Un **indicador de estado** que muestra su condición actual

### Indicadores de estado

Los objetos pueden tener uno de tres estados:

- **Ready** — El objeto tiene metadatos y sus teselas (*tiles*) están disponibles. Está listo para usar en historias.
- **No metadata** — El objeto existe pero le falta información clave como título, creador o descripción. Aún puedes usarlo en historias, pero agregar metadatos mejora tu exhibición.
- **Tiles missing** — Las teselas IIIF del objeto aún no se han generado. Esto puede ocurrir con imágenes recién subidas que no se han publicado ni procesado en el *build*.

## Editar metadatos

Selecciona un objeto para abrir su editor de metadatos. Aquí puedes completar o actualizar la información que describe al objeto en tu exhibición.

## Agregar IIIF externo

Puedes agregar objetos de museos, bibliotecas y otras instituciones que publican manifiestos IIIF. El Compositor obtiene la imagen y los metadatos automáticamente.

1. Haz clic en **Add Object** y selecciona la opción IIIF
2. Pega la URL del manifiesto en el campo
3. El Compositor recupera la imagen y completa los metadatos disponibles (título, creador, descripción)
4. Revisa y ajusta los metadatos según sea necesario
5. Guarda el objeto`,
  },

  // --- 9-4-story-editor.md -----------------------------------------------
  stories: {
    href: "/docs/the-compositor/story-editor/",
    titleEn: "The story editor",
    titleEs: "El editor de historias",
    seeAlso: ["narrative", "video", "markdown"],
    bodyEn: `# Story Editor

The story editor is where you build and refine your narratives. It combines a text editor, an interactive viewer, and step management tools into a single workspace — everything you need to compose a story without editing spreadsheet files.

When you open a story from the Dashboard, the editor loads with the title card on the left and the viewer on the right. Each step in your story appears as a card in the sidebar, and selecting a step updates both the text editor and the viewer to show that step's content.

## Title card

The title card is the first thing your audience sees. It displays your story's title, subtitle, and byline.

To edit the title card, click directly on any of its fields. Changes save automatically as you type — there is no separate save button.

## IIIF viewer

The right side of the editor shows an interactive IIIF viewer. When a step references an image object, you can pan and zoom to frame the exact view you want your audience to see.

To capture the current view for a step:

1. Navigate to the step you want to configure
2. Pan and zoom the viewer until the image shows the framing you want
3. The Compositor captures the current x, y, and zoom coordinates and saves them to the step

## Step management

The sidebar lists all steps in your story. You can reorganize and modify your story structure here.

- **Add a step** — Click the add button at the bottom of the sidebar to append a new step
- **Insert a step** — Click the insert button between two existing steps to place a new step at that position
- **Delete a step** — Remove a step and its content from the story
- **Reorder steps** — Drag a step by its handle to move it to a new position in the sequence`,
    bodyEs: `# Editor de historias

El editor de historias es donde construyes y refinas tus narrativas. Combina un editor de texto, un visor interactivo y herramientas de gestión de pasos en un solo espacio de trabajo — todo lo que necesitas para componer una historia sin editar hojas de cálculo.

Cuando abres una historia desde el Panel de control, el editor se carga con la tarjeta de título a la izquierda y el visor a la derecha. Cada paso de la historia aparece como una tarjeta en la barra lateral, y al seleccionar un paso se actualizan tanto el editor de texto como el visor para mostrar el contenido de ese paso.

## Tarjeta de título

La tarjeta de título es lo primero que ve el público. Muestra el título, subtítulo y línea de autoría de tu historia.

Para editar la tarjeta de título, haz clic directamente en cualquiera de sus campos. Los cambios se guardan automáticamente a medida que escribes — no hay un botón de guardar aparte.

## Visor IIIF

El lado derecho del editor muestra un visor IIIF interactivo. Cuando un paso hace referencia a un objeto de imagen, puedes desplazar y ampliar para encuadrar la vista exacta que deseas que vea el público.

Para capturar la vista actual de un paso:

1. Navega al paso que deseas configurar
2. Desplaza y amplía el visor hasta que la imagen muestre el encuadre que deseas
3. El Compositor captura las coordenadas actuales de x, y y zoom y las guarda en el paso

## Gestión de pasos

La barra lateral lista todos los pasos de tu historia. Aquí puedes reorganizar y modificar la estructura de la historia.

- **Agregar un paso** — Haz clic en el botón de agregar en la parte inferior de la barra lateral para añadir un nuevo paso al final
- **Insertar un paso** — Haz clic en el botón de insertar entre dos pasos existentes para colocar un nuevo paso en esa posición
- **Eliminar un paso** — Elimina un paso y su contenido de la historia
- **Reordenar pasos** — Arrastra un paso por su asa para moverlo a una nueva posición en la secuencia`,
  },

  // --- 6-2-glossary.md ---------------------------------------------------
  glossary: {
    href: "/docs/site-features/glossary/",
    titleEn: "The glossary feature",
    titleEs: "La función de glosario",
    seeAlso: ["markdown", "stories"],
    bodyEn: `# Glossary

The glossary lets you define terms that viewers can look up without leaving a story. When a viewer clicks a glossary link, the definition appears in a slide-over panel.

## Linking to Glossary Terms

Link to glossary terms from story panels using double-bracket syntax:

### Shorthand

Uses the term's \`title\` as the link text:

\`\`\`markdown
The [[loom]] was central to textile production.
\`\`\`

### Custom Display Text

Use a pipe separator to specify different link text:

\`\`\`markdown
The [[loom|weaving device]] was central to textile production.
\`\`\`

### Where Links Work

Glossary auto-links work in:

- Story panel content (all three methods: direct text, pasted markdown, file references)
- Custom pages

If a \`term_id\` is not found in the glossary, a warning icon and error message appear in the build output and in the story panel.

## Tips

- **Keep definitions concise** — Viewers are reading them mid-story. A sentence or two is ideal; save extended explanations for story panels.
- **Use related terms** to build a network of cross-references. This helps viewers explore connected concepts.`,
    bodyEs: `# Glosario

El glosario te permite definir términos que las personas pueden consultar sin abandonar una historia. Cuando alguien hace clic en un enlace de glosario, la definición aparece en un panel lateral deslizante.

## Enlazar a términos del glosario

Enlaza a términos del glosario desde los paneles de las historias usando sintaxis de doble corchete:

### Forma abreviada

Usa el \`title\` del término como texto del enlace:

\`\`\`markdown
El [[loom]] era central para la producción textil.
\`\`\`

### Texto personalizado

Usa un separador de barra vertical para especificar un texto de enlace diferente:

\`\`\`markdown
El [[loom|dispositivo de tejido]] era central para la producción textil.
\`\`\`

### Dónde funcionan los enlaces

Los autoenlaces de glosario funcionan en:

- Contenido de paneles de historias (los tres métodos: texto directo, markdown pegado, archivos)
- Páginas personalizadas

Si un \`term_id\` no se encuentra en el glosario, un ícono de advertencia y un mensaje de error aparecen en la salida de la *build* y en el panel de la historia.

## Consejos

- **Mantén las definiciones concisas** — Las personas las leen en medio de una historia. Una o dos oraciones es lo ideal; guarda las explicaciones extensas para los paneles de las historias.
- **Usa términos relacionados** para construir una red de referencias cruzadas. Esto ayuda a las personas a explorar conceptos conectados.`,
  },

  // --- 6-4-custom-pages.md -----------------------------------------------
  pages: {
    href: "/docs/site-features/custom-pages/",
    titleEn: "Custom pages",
    titleEs: "Páginas personalizadas",
    seeAlso: ["markdown", "glossary"],
    bodyEn: `# Custom Pages

Create custom pages for credits, methodology, team information, or any other content that doesn't fit into the story structure.

## What are Custom Pages?

Custom pages are standalone pages that appear in your site's navigation menu but aren't part of the story viewer. Unlike story layers, which are tightly integrated with IIIF objects and step navigation, custom pages are flexible containers for any content you want to share.

**Common use cases:**
- **About**: Introduce your project and research team
- **Methodology**: Explain your research methods and sources
- **Credits**: Acknowledge contributors, funders, and institutions
- **Bibliography**: List sources and further reading
- **Contact**: Provide ways to get in touch

## Supported Features

Custom pages support the same markdown features as story layers:

### Markdown Formatting
- **Headings** (h1-h6)
- **Bold**, *italic*, and other text formatting
- Lists (bulleted and numbered)
- Links and images
- Blockquotes

### Glossary Links

Glossary auto-linking works the same way:

\`\`\`markdown
The [[encomienda]] system was a key institution...
\`\`\`

When users click the link, the glossary panel opens with the definition.`,
    bodyEs: `# Páginas personalizadas

Crea páginas personalizadas para créditos, metodología, información del equipo, o cualquier otro contenido que no encaje en la estructura de la historia.

## ¿Qué son las páginas personalizadas?

Las páginas personalizadas son páginas independientes que aparecen en el menú de navegación de tu sitio pero no son parte del visor de historia. A diferencia de las capas de historia, que están estrechamente integradas con objetos IIIF y navegación de pasos, las páginas personalizadas son contenedores flexibles para cualquier contenido que quieras compartir.

**Casos de uso comunes:**
- **Acerca de**: Presenta tu proyecto y equipo de investigación
- **Metodología**: Explica tus métodos de investigación y fuentes
- **Créditos**: Reconoce colaboradores, financiadores e instituciones
- **Bibliografía**: Lista fuentes y lecturas adicionales
- **Contacto**: Proporciona formas de ponerse en contacto

## Funcionalidades soportadas

Las páginas personalizadas soportan las mismas funcionalidades de markdown que las capas de historia:

### Formato markdown
- **Encabezados** (h1-h6)
- **Negrita**, *cursiva* y otro formato de texto
- Listas (con viñetas y numeradas)
- Enlaces e imágenes
- Citas en bloque

### Enlaces de glosario

El enlace automático del glosario funciona de la misma manera:

\`\`\`markdown
El sistema de [[encomienda]] fue una institución clave...
\`\`\`

Cuando las personas hacen clic en el enlace, el panel de glosario se abre con la definición.`,
  },

  // --- 9-6-publishing.md -------------------------------------------------
  publish: {
    href: "/docs/the-compositor/publishing/",
    titleEn: "Publishing your changes",
    titleEs: "Publicar tus cambios",
    seeAlso: ["sync", "objects"],
    bodyEn: `# Publishing

Publishing sends your changes from the Compositor to your GitHub repository. Until you publish, all edits — to objects, stories, and settings — are saved on the server. Publishing creates a single commit in your repository, triggers a GitHub Pages build, and makes your changes live on your site.

## Change summary

Before publishing, the Compositor shows a summary of everything that has changed since your last publish. This lets you review your work before committing.

## Pre-publish validation

The Compositor validates your project before allowing you to publish. There are two levels of validation:

- **Errors** — Critical issues that block publishing. You must fix errors before you can publish.
- **Warnings** — Non-critical issues that do not block publishing but are worth reviewing.

## Publish

When you are ready, click the publish button. The Compositor creates a single atomic commit in your GitHub repository containing all your changes. The commit is attributed to your GitHub account — your name and email appear in the repository's commit history, not the Compositor's.

## Build tracking

After publishing, the Compositor tracks the progress of your GitHub Pages build in real time:

- **Queued** — The build is waiting to start
- **Building** — GitHub Actions is building your site
- **Complete** — The build finished successfully and your changes are live
- **Failed** — The build encountered an error`,
    bodyEs: `# Publicación

La publicación envía tus cambios del Compositor a tu repositorio de GitHub. Hasta que publiques, todas las ediciones — de objetos, historias y configuraciones — se guardan en el servidor. Al publicar se crea un solo *commit* en tu repositorio, se activa un *build* de GitHub Pages y tus cambios se hacen visibles en tu sitio.

## Resumen de cambios

Antes de publicar, el Compositor muestra un resumen de todo lo que ha cambiado desde tu última publicación. Esto te permite revisar tu trabajo antes de confirmar.

## Validación previa a la publicación

El Compositor valida tu proyecto antes de permitirte publicar. Hay dos niveles de validación:

- **Errores** — Problemas críticos que bloquean la publicación. Debes corregir los errores antes de publicar.
- **Advertencias** — Problemas no críticos que no bloquean la publicación pero vale la pena revisar.

## Publicar

Cuando estés listo, haz clic en el botón de publicar. El Compositor crea un solo *commit* atómico en tu repositorio de GitHub que contiene todos tus cambios. El *commit* se atribuye a tu cuenta de GitHub — tu nombre y correo electrónico aparecen en el historial de *commits* del repositorio, no los del Compositor.

## Seguimiento del *build*

Después de publicar, el Compositor hace seguimiento del progreso del *build* de GitHub Pages en tiempo real:

- **Queued** — El *build* está en espera para iniciar
- **Building** — GitHub Actions está construyendo tu sitio
- **Complete** — El *build* finalizó correctamente y tus cambios están en línea
- **Failed** — El *build* encontró un error`,
  },

  // --- 9-0-compositor.md -------------------------------------------------
  intro: {
    href: "/docs/the-compositor/",
    titleEn: "What is the Compositor?",
    titleEs: "¿Qué es el Compositor?",
    seeAlso: ["start", "objects", "stories"],
    bodyEn: `# The Compositor

The Telar Compositor is a visual editor for building and managing your exhibition — no spreadsheets, no command line, no code. It runs in your browser at [compositor.telar.org](https://compositor.telar.org) and connects directly to your GitHub repository.

## What is the Compositor?

If you have used Telar before, you know that content is defined through spreadsheet files — CSV files or Google Sheets — and published through GitHub. The Compositor replaces that workflow with a point-and-click editor. You can:

- Import existing content from a Telar repository or Google Sheets
- Add and edit objects with metadata, IIIF manifests, or uploaded images
- Build stories visually — write panels, set viewer coordinates, capture clip times
- Publish changes to GitHub with a single click
- Track your site's build status in real time

The Compositor is designed for students, educators, and anyone who wants to focus on storytelling rather than data files.

## How it works

The typical workflow has four stages:

1. **Sign in** — Authenticate with your GitHub account at [compositor.telar.org](https://compositor.telar.org)
2. **Connect a repository** — Select an existing Telar repository and import its content
3. **Edit** — Use the visual editor to manage objects, write stories, and arrange steps
4. **Publish** — Review your changes, commit to GitHub, and watch the build complete`,
    bodyEs: `# El Compositor

El Compositor de Telar es un editor visual para construir y administrar tu exhibición — sin hojas de cálculo, sin línea de comandos, sin código. Funciona en tu navegador en [compositor.telar.org](https://compositor.telar.org) y se conecta directamente a tu repositorio de GitHub.

## ¿Qué es el Compositor?

Si ya has usado Telar, sabes que el contenido se define a través de archivos de hoja de cálculo — archivos CSV o Google Sheets — y se publica a través de GitHub. El Compositor reemplaza ese flujo de trabajo con un editor visual. Puedes:

- Importar contenido existente desde un repositorio de Telar o Google Sheets
- Agregar y editar objetos con metadatos, manifiestos IIIF o imágenes subidas
- Construir historias visualmente — escribir paneles, definir coordenadas del visor, capturar tiempos de *clip*
- Publicar cambios en GitHub con un solo clic
- Monitorear el estado del *build* de tu sitio en tiempo real

El Compositor está diseñado para estudiantes, docentes y cualquier persona que quiera enfocarse en la narrativa en lugar de los archivos de datos.

## Cómo funciona

El flujo de trabajo tiene cuatro etapas:

1. **Iniciar sesión** — Autentícate con tu cuenta de GitHub en [compositor.telar.org](https://compositor.telar.org)
2. **Conectar un repositorio** — Selecciona un repositorio de Telar existente e importa su contenido
3. **Editar** — Usa el editor visual para administrar objetos, escribir historias y organizar los pasos
4. **Publicar** — Revisa tus cambios, confirma el *commit* en GitHub y observa cómo se completa el *build*`,
  },

  // --- 4-3-external-iiif.md ----------------------------------------------
  iiif: {
    href: "/docs/your-content/external-iiif/",
    titleEn: "What is IIIF?",
    titleEs: "¿Qué es IIIF?",
    seeAlso: ["objects"],
    bodyEn: `# External IIIF Images

Many museums, libraries, and archives make their collections available through a technology called [IIIF](https://iiif.io/) (International Image Interoperability Framework). This means you can build Telar stories around high-resolution images from institutions worldwide — without downloading or hosting the images yourself.

## Finding IIIF images

Look for IIIF resources at:

- [IIIF Guide to Finding Resources](https://iiif.io/guides/finding_resources/)
- Major museums (British Museum, Getty, Smithsonian, Rijksmuseum)
- Digital libraries (Internet Archive, Europeana, Gallica)
- University collections and special archives

When an institution supports IIIF, you'll typically find a manifest URL — a link that describes the image and its metadata. It usually ends in \`info.json\` or \`manifest.json\`.

## Adding an external image

In your objects spreadsheet (Google Sheet or \`objects.csv\`):

1. Create a row with a unique \`object_id\` (e.g., \`museum-textile-001\`)
2. Add the IIIF manifest URL in the \`source_url\` column

That's it. Telar will fetch the image directly from the institution's server when viewers visit your site.

## Automatic metadata extraction

When you provide a \`source_url\`, Telar can automatically fill in metadata from the IIIF manifest — title, description, creator, period, location, and credit. This saves you from typing information that the institution has already recorded.`,
    bodyEs: `# Imágenes IIIF externas

Muchos museos, bibliotecas y archivos ponen sus colecciones a disposición a través de una tecnología llamada [IIIF](https://iiif.io/) (Marco Internacional de Interoperabilidad de Imágenes). Esto significa que puedes construir historias en Telar usando imágenes de alta resolución de instituciones de todo el mundo, sin descargar ni alojar las imágenes.

## Encontrar imágenes IIIF

Busca recursos IIIF en:

- [Guía IIIF para encontrar recursos](https://iiif.io/guides/finding_resources/)
- Museos importantes (British Museum, Getty, Smithsonian, Rijksmuseum)
- Bibliotecas digitales (Internet Archive, Europeana, Gallica)
- Colecciones universitarias y archivos especializados

Cuando una institución ofrece IIIF, generalmente encontrarás una URL de manifiesto — un enlace que describe la imagen y sus metadatos. Normalmente termina en \`info.json\` o \`manifest.json\`.

## Agregar una imagen externa

En tu hoja de cálculo de objetos (Google Sheet u \`objects.csv\`):

1. Crea una fila con un \`object_id\` único (ej., \`museum-textile-001\`)
2. Agrega la URL del manifiesto IIIF en la columna \`source_url\`

Eso es todo. Telar obtendrá la imagen directamente del servidor de la institución cuando alguien visite tu sitio.

## Extracción automática de metadatos

Cuando proporcionas una \`source_url\`, Telar puede llenar automáticamente los metadatos a partir del manifiesto IIIF — título, descripción, creador, periodo, ubicación y crédito. Esto te ahorra escribir información que la institución ya tiene registrada.`,
  },

  // --- 1-1-compositor.md -------------------------------------------------
  start: {
    href: "/docs/getting-started/compositor/",
    titleEn: "Getting started with the Compositor",
    titleEs: "Primeros pasos con el Compositor",
    seeAlso: ["narrative", "refine", "intro"],
    bodyEn: `# Use the Compositor

The Telar Compositor is a visual tool for building exhibitions. You can add objects, write stories, arrange steps, and preview your site — all in your browser, with no coding required.

When you're ready, the Compositor publishes a complete Telar site to GitHub Pages.

## What you'll need

- A [GitHub account](https://github.com/join) (free)
- Images, videos, or audio files for your exhibition

## Get started

Go to [compositor.telar.org](https://compositor.telar.org) and sign in with your GitHub account. The Compositor will ask you to install the Telar Compositor GitHub App — this gives it permission to create and manage repositories on your behalf.

Once signed in, you have two options:

### Create a new site

Click **Create new site**, type a name for your repository — **use lowercase letters and hyphens** (e.g., \`my-exhibition\`) — and the Compositor will set everything up for you: it creates the repository from the Telar template, configures GitHub Pages, and gets your site ready to edit.

### Connect an existing repository

If you already created a repository from the Telar template or have an existing Telar site, select it from the list and the Compositor will import your content.`,
    bodyEs: `# Usa el Compositor

El Compositor de Telar es una herramienta visual para construir exhibiciones. Puedes agregar objetos, escribir historias, organizar pasos y previsualizar tu sitio — todo en el navegador, sin necesidad de programar.

Cuando estés listo, el Compositor publica un sitio Telar completo en GitHub Pages.

## Lo que necesitas

- Una [cuenta de GitHub](https://github.com/join) (gratis)
- Imágenes, videos o archivos de audio para la exhibición

## Empieza aquí

Ve a [compositor.telar.org](https://compositor.telar.org) e inicia sesión con tu cuenta de GitHub. El Compositor te pedirá instalar la aplicación Telar Compositor en GitHub — esto le da permiso para crear y administrar repositorios en tu nombre.

Una vez que hayas iniciado sesión, tienes dos opciones:

### Crea un sitio nuevo

Haz clic en **Crear un sitio nuevo**, escribe un nombre para el repositorio — **usa letras minúsculas y guiones** (ej., \`mi-exhibicion\`) — y el Compositor se encarga del resto: crea el repositorio a partir de la plantilla de Telar, configura GitHub Pages y deja tu sitio listo para editar.

### Conecta un repositorio existente

Si ya creaste un repositorio a partir de la plantilla de Telar o tienes un sitio Telar existente, selecciónalo de la lista y el Compositor importará tu contenido.`,
  },

  // --- 1-4-narrative-structure.md ----------------------------------------
  narrative: {
    href: "/docs/getting-started/narrative-structure/",
    titleEn: "Plan your narrative",
    titleEs: "Planea tu narrativa",
    seeAlso: ["stories", "markdown"],
    bodyEn: `# Plan Your Narrative

Understanding Telar's narrative model will help you plan your content effectively.

Each page in your Telar site contains one or more stories, which can be independent or related narratives. Stories unfold through successive steps that show an image (or a detail of an image) alongside a brief text.

## The Question/Answer/Invitation Pattern

Each step follows this pattern:

- **Question**: Draws viewers in with a compelling heading
- **Answer**: A brief 1-2 sentence response
- **Invitation**: "Learn more" opens a layer panel with extended information

You can provide up to two layer panels in each step to give viewers further information.

## Layered Panels

Layer panels are where you can expand on your narrative. They are written in markdown format, allowing you to include:

- Headings, bold and italic text
- Links and lists
- Additional images
- Embedded videos or 3D renderings

## Planning Your Story

Before you start gathering materials or building your site, take time to sketch out your story's structure:

1. What stories do you want to tell?
2. What are the key moments in each story?
3. What images or details will anchor each step in the story?
4. What information belongs in the brief answer and what in the panel layers?`,
    bodyEs: `# Planea tu narrativa

Entender el modelo narrativo de Telar te ayudará a planificar tu contenido de manera efectiva.

Cada página en tu sitio Telar contiene una o más historias, que pueden ser narrativas independientes o capítulos de una pieza más larga. Las historias se desarrollan a través de pasos sucesivos que muestran una imagen (o un detalle de una imagen) junto con un texto breve.

## El patrón pregunta/respuesta/invitación

Cada paso sigue este patrón:

- **Pregunta**: Atrae a los espectadores con un encabezado convincente
- **Respuesta**: Una breve respuesta de 1-2 oraciones
- **Invitación**: "Conoce más" abre un panel de contenido con información extendida

Puedes proporcionar hasta dos paneles adicionales de contenido en cada paso, permitiendo a los espectadores que quieran obtener más detalle.

## Paneles en capas

Los paneles en capas son donde realmente puedes expandir tu narrativa. Están escritos en formato markdown, permitiéndote incluir:

- Encabezados, texto en negrita e itálica
- Enlaces y listas
- Imágenes adicionales
- Videos incrustados o modelos 3D

## Planea tu historia

Antes de comenzar a reunir materiales o construir tu sitio, toma tiempo para esbozar la estructura de tu historia:

1. ¿Qué historias quieres contar?
2. ¿Cuáles son los momentos clave en cada historia?
3. ¿Qué imagen o imágenes anclarán cada paso?
4. ¿Qué información pertenece a la respuesta breve y qué a las capas más profundas?`,
  },

  // --- 4-6-markdown-syntax.md --------------------------------------------
  markdown: {
    href: "/docs/your-content/markdown-syntax/",
    titleEn: "Markdown syntax",
    titleEs: "Sintaxis de Markdown",
    seeAlso: ["stories", "glossary"],
    bodyEn: `# Markdown Syntax Reference

Panel content in Telar supports rich markdown formatting. This reference covers all available syntax for creating engaging narrative content.

## What is Markdown?

Markdown is a lightweight markup language that lets you format text using simple, readable syntax. Instead of complex HTML tags, you write in plain text with special characters like \`*\` for emphasis or \`#\` for headings. Markdown is:

- **Easy to read**: Even in its raw form, markdown is readable
- **Easy to write**: Simple syntax that's faster than HTML
- **Portable**: Plain text files work everywhere
- **Convertible**: Automatically converted to HTML for display

### Learning Resources

New to markdown? These resources will help:

- [Markdown Guide](https://www.markdownguide.org/) - Comprehensive getting started guide
- [CommonMark Tutorial](https://commonmark.org/help/) - Interactive 10-minute tutorial
- [Markdown Cheat Sheet](https://www.markdownguide.org/cheat-sheet/) - Quick reference

## Panel Content Methods

You can provide panel content in three ways:

### Method 1: Entering Text Directly

Type panel text directly in your spreadsheet's \`layer1_content\` column. Line breaks in your spreadsheet cell create paragraph breaks.

### Method 2: Pasting Markdown Text

Paste text from a plain text editor. You can include headings, widgets, and a custom panel title using YAML frontmatter.`,
    bodyEs: `# Referencia de sintaxis de Markdown

Los paneles de contenido en Telar se deben escribir utilizando el formato Markdown. Esta guía de referencia cubre cómo funciona esta sintaxis para crear contenido narrativo claro y atractivo.

## ¿Qué es Markdown?

Markdown es un lenguaje de marcado ligero que te permite formatear texto usando una sintaxis simple y legible. En lugar de etiquetas HTML complejas, escribes en texto plano con caracteres especiales como \`*\` para énfasis o \`#\` para encabezados. Markdown es:

- **Fácil de leer**: Incluso en su forma cruda, markdown es legible
- **Fácil de escribir**: Sintaxis simple que es más rápida que HTML
- **Portátil**: Los archivos de texto plano funcionan en cualquier lugar
- **Convertible**: Se convierte automáticamente a HTML para su visualización

### Recursos de aprendizaje

¿Nuevo en Markdown? Estos recursos te ayudarán:

- [Guía de Markdown](https://www.markdownguide.org/es/) - Guía completa para empezar
- [Tutorial de CommonMark](https://commonmark.org/help/) - Tutorial interactivo de 10 minutos
- [Hoja de Referencia de Markdown](https://www.markdownguide.org/cheat-sheet/) - Referencia rápida

## Métodos de contenido de panel

Puedes proporcionar el contenido del panel de tres maneras:

### Método 1: Introducir texto directamente

Escribe el texto del panel directamente en la columna \`contenido_capa1\` de tu hoja de cálculo. Los saltos de línea en la celda de tu hoja de cálculo crean saltos de párrafo.

### Método 2: Pegar texto markdown

Pega texto desde un editor de texto plano. Puedes incluir encabezados, widgets y un título de panel personalizado usando frontmatter YAML.`,
  },

  // --- 1-6-review-refine.md ----------------------------------------------
  refine: {
    href: "/docs/getting-started/review-refine/",
    titleEn: "Review and refine",
    titleEs: "Revisa y perfecciona",
    seeAlso: ["start", "iiif"],
    bodyEn: `# Review and Refine

Browse through your exhibition and check for:

- Warning messages on the homepage (these point to configuration issues)
- Correct images appearing for each story step
- Text displaying as expected

## Set Your Image Coordinates

The placeholder coordinates (\`0.5, 0.5, 1.0\`) show the center of each image. To focus on specific details:

1. Navigate to any object page on your site
2. Click **Identify coordinates** below the image viewer
3. Pan and zoom to find the perfect view for each story step
4. Copy the X, Y, and Zoom values
5. Paste them into your spreadsheet
6. Trigger a rebuild to see the changes

## Keep Building

Once the basics are in place, you can:

- Add more stories
- Add a glossary of terms
- Customize your homepage (edit \`index.md\` in your repository)
- Browse and search your objects collection (enabled by default)`,
    bodyEs: `# Revisa y perfecciona

Navega tu exposición y verifica:

- Mensajes de advertencia en la página de inicio (señalan problemas de configuración)
- Que las imágenes correctas aparezcan en cada paso de la historia
- Que el texto se muestre como esperas

## Ajusta las coordenadas de imagen

Las coordenadas iniciales (\`0.5, 0.5, 1.0\`) muestran el centro de cada imagen. Para enfocar detalles específicos:

1. Navega a cualquier página de objeto en tu sitio
2. Haz clic en **Identify coordinates** debajo del visor de imágenes
3. Desplaza y amplía para encontrar la vista perfecta de cada paso
4. Copia los valores de X, Y y Zoom
5. Pégalos en tu hoja de cálculo
6. Activa una reconstrucción para ver los cambios

## Sigue construyendo

Una vez que tengas lo básico, puedes:

- Agregar más historias
- Agregar un glosario de términos
- Personalizar tu página de inicio (edita \`index.md\` en tu repositorio)
- Explorar y buscar en tu colección de objetos (habilitado por defecto)`,
  },

  // --- 9-5-video-audio.md ------------------------------------------------
  video: {
    href: "/docs/the-compositor/video-audio/",
    titleEn: "Video and audio",
    titleEs: "Video y audio",
    seeAlso: ["stories", "objects"],
    bodyEn: `# Video and Audio

The Compositor supports video and audio objects alongside images. When a story step references a video or audio object, the viewer column shows the appropriate media player — an embedded video player or a waveform audio player — and provides tools for capturing clip times and setting loop behavior.

## Media type detection

The Compositor detects the media type of each object automatically based on its source URL. You do not need to configure the type manually — the Compositor reads the URL and determines whether the object is an image, a video, or an audio file.

## Supported video sources

The Compositor recognizes video URLs from three platforms:

- **YouTube** — \`youtube.com/watch?v=...\` and \`youtu.be/...\` short links
- **Vimeo** — \`vimeo.com/123456789\`
- **Google Drive** — \`drive.google.com/file/d/.../view\` (the video must be shared publicly or with "Anyone with the link")

## Clip capture

Clip capture lets you define which segment of a video or audio file plays during a particular step. Instead of entering timestamps manually in a spreadsheet, you capture them visually while the media plays.

1. Select the step you want to configure
2. Play the video or audio in the viewer
3. When the media reaches the point where you want the clip to begin, click **Capture start**
4. Continue playing until the media reaches the end point, then click **Capture end**`,
    bodyEs: `# Video y audio

El Compositor admite objetos de video y audio junto con imágenes. Cuando un paso de la historia hace referencia a un objeto de video o audio, la columna del visor muestra el reproductor de medios correspondiente — un reproductor de video insertado o un reproductor de audio con forma de onda — y ofrece herramientas para capturar tiempos de *clip* y configurar el comportamiento de bucle.

## Detección del tipo de medio

El Compositor detecta el tipo de medio de cada objeto automáticamente a partir de su URL de origen. No necesitas configurar el tipo manualmente — el Compositor lee la URL y determina si el objeto es una imagen, un video o un archivo de audio.

## Fuentes de video compatibles

El Compositor reconoce URLs de video de tres plataformas:

- **YouTube** — \`youtube.com/watch?v=...\` y enlaces cortos \`youtu.be/...\`
- **Vimeo** — \`vimeo.com/123456789\`
- **Google Drive** — \`drive.google.com/file/d/.../view\` (el video debe estar compartido públicamente o con "Cualquier persona con el enlace")

## Captura de *clips*

La captura de *clips* te permite definir qué segmento de un archivo de video o audio se reproduce durante un paso particular. En lugar de ingresar marcas de tiempo manualmente en una hoja de cálculo, las capturas visualmente mientras se reproduce el medio.

1. Selecciona el paso que deseas configurar
2. Reproduce el video o audio en el visor
3. Cuando el medio llegue al punto donde quieres que comience el *clip*, haz clic en **Capture start**
4. Continúa la reproducción hasta que el medio llegue al punto final, luego haz clic en **Capture end**`,
  },

  // --- 9-7-sync-updates.md -----------------------------------------------
  sync: {
    href: "/docs/the-compositor/sync-updates/",
    titleEn: "Sync and updates",
    titleEs: "Sincronización y actualizaciones",
    seeAlso: ["publish", "objects"],
    bodyEn: `# Sync and Updates

The Compositor keeps track of changes in your repository and Telar updates. When you return to a project, it checks whether anything has changed remotely and whether a newer version of Telar is available.

## On return detection

Each time you open the Compositor, it checks whether your GitHub repository has changed since your last session. Changes might come from another collaborator, from direct edits on GitHub, or from a previous session on a different device.

If the repository has not changed, you continue where you left off. If changes are detected, the Compositor prompts you to re-sync before editing.

## Re-sync

Re-syncing imports the latest content from your repository into the Compositor. This ensures you are working with the most current version of your objects, stories, and configuration.

During re-sync, the Compositor:

1. Reads the current state of your repository
2. Updates your local project to reflect any remote changes
3. Warns you if the remote changes conflict with unpublished local edits

## Version detection

The Compositor checks which version of Telar your site is running. If a newer version is available, it lets you know and offers to upgrade. Upgrades update Telar's code in your repository but do not alter your content — your objects, stories, and configuration remain unchanged.`,
    bodyEs: `# Sincronización y actualizaciones

El Compositor hace seguimiento de los cambios en tu repositorio y las actualizaciones de Telar. Cuando regresas a un proyecto, verifica si algo cambió remotamente y si hay una versión más reciente de Telar disponible.

## Detección al regresar

Cada vez que abres el Compositor, verifica si tu repositorio de GitHub ha cambiado desde tu última sesión. Los cambios pueden provenir de otra persona colaboradora, de ediciones directas en GitHub o de una sesión anterior en un dispositivo diferente.

Si el repositorio no ha cambiado, continúas donde lo dejaste. Si se detectan cambios, el Compositor te invita a resincronizar antes de editar.

## Resincronización

La resincronización importa el contenido más reciente de tu repositorio al Compositor. Esto asegura que trabajas con la versión más actual de tus objetos, historias y configuración.

Durante la resincronización, el Compositor:

1. Lee el estado actual de tu repositorio
2. Actualiza tu proyecto local para reflejar cualquier cambio remoto
3. Te advierte si los cambios remotos entran en conflicto con ediciones locales sin publicar

## Detección de versión

El Compositor verifica qué versión de Telar ejecuta tu sitio. Si hay una versión más reciente disponible, te lo informa y ofrece actualizar. Las actualizaciones modifican el código de Telar en tu repositorio pero no alteran tu contenido — tus objetos, historias y configuración se mantienen sin cambios.`,
  },
};

/** Type guard: is the given string a known DOC id? */
export function isDocId(value: string | null | undefined): value is DocId {
  return value != null && Object.prototype.hasOwnProperty.call(DOCS, value);
}
