# Sync Koreader Highlights

A Logseq plugin that imports KOReader sidecar metadata (`metadata.*.lua`
files inside `*.sdr` directories) into your Logseq graph. Modelled on the
official Readwise plugin: one Logseq page per book, idempotent
append-only updates, minimal UI surface, no server.

## Status

Early development. Working end-to-end against a real Calibre + KOReader
library (paths discovered via the File System Access API, parsed via
`luaparse`). Not yet published to the Logseq marketplace; load the
`dist/` build as an unpacked plugin.

## What it does today

- **One Logseq page per book.** Page name is the book's title from
  KOReader, with `[`/`]` replaced by `(`/`)` so wikilinks don't break.
  Title collisions get disambiguated as `<title> — <authors>` or
  `<title> (n)`.
- **Page-level properties** are written via Logseq's structured
  `createPage(name, properties, opts)` API: `title`, `authors`,
  `language`, `koreader-id` (KOReader's `partial_md5_checksum`, stable
  across file moves), and a HTML-stripped, entity-decoded, 500-char
  truncated `description`.
- **Highlights live under a single `## Highlights` heading.** Each
  highlight is a Logseq block with the highlight text as a blockquote
  and `page`, `chapter`, `date`, optional `date-updated` as structured
  block properties. The `date` property value is a `[[<journal-day>]]`
  page-link, so Logseq's native Linked References panel surfaces every
  highlight on its journal day automatically — no plugin-authored
  blocks on the journal side.
- **Re-syncs are idempotent and append-only.** New highlights appear as
  additional children of the same `## Highlights` heading. Highlights
  already imported (matched by a stable `id` derived from KOReader's
  `pos0/pos1/datetime/text`) are not re-inserted. Highlights deleted on
  the device are not removed from Logseq — same tradeoff Readwise
  makes; the plugin never clobbers user edits.
- **Books with zero highlights/notes/bookmarks are skipped entirely.**
  No empty book pages get created, and they don't show up on the
  KOReader index page either.
- **One `KOReader` index page** receives a sync receipt per run
  (`# 📚 Sync <date> <time>` block listing new books and highlight
  counts).
- **Stub-sidecar tolerance.** Sidecars without `doc_props` (KOReader
  writes those for books opened-but-never-annotated, and re-collapses
  to that shape if you delete the last remaining annotation) are
  silently skipped. Same fix as `isosphere/logseq-koreader-sync` PR #7.

## Settings

Three visible settings, all optional:

- **Remember Koreader directory** *(default on)* — caches the directory
  handle so the picker is skipped on subsequent syncs.
- **Auto-sync on Logseq launch** *(default off)* — opens the modal a
  moment after Logseq starts.
- **Mustache templates** for highlights heading and book header. These
  are inert in the current build (the rendering path now uses Logseq's
  structured properties API for robustness) but kept as settings for
  future re-introduction.

State maps (`bookIdsMap`, `lastHighlightDatetimeMap`, `highlightIdsMap`,
`lastSync`) are stored in `logseq.settings` and not exposed in the UI.

## Build

System Node 22+ (the project uses Vite + React + TypeScript). On Asahi
Fedora aarch64, an x86-64 nvm install can shadow the right binary:

```
PATH=/usr/bin:$PATH /usr/bin/npm install
PATH=/usr/bin:$PATH /usr/bin/npm run build
```

The output lands in `dist/` (one `index.html` + one bundled JS asset).

## Loading in Logseq

1. Plugins → ··· → **Load unpacked plugin** → point at this repo's
   root directory.
2. The toolbar gains a book icon. Clicking it opens the React modal.
3. Click **Sync now**, pick the directory containing your KOReader
   sidecars (typically your Calibre library or whatever folder
   Syncthing pulls from your reader).

## UI

React modal with three views:

- **Main:** Sync now / Customize templates / Reset, plus an in-modal
  progress region.
- **Customize templates:** edit the (currently inert) Mustache
  templates with a "Reset to defaults" button.
- **Reset:** clears `bookIdsMap`, `lastHighlightDatetimeMap`,
  `highlightIdsMap`. With the optional checkbox, also deletes every
  book page the plugin created plus the `KOReader` index page.

Two command palette entries: `Sync Koreader Highlights: open` and
`Sync Koreader Highlights: reset sync state`.

## Architecture

```
src/
  main.tsx     — Logseq plugin lifecycle, settings schema, toolbar,
                 command palette, picker, React root.
  App.tsx      — Modal UI: Main / Customize / Reset views.
  sync.ts      — Sync engine: walk → parse → diff against state maps →
                 createPage / appendHighlights → write index receipt.
  sidecar.ts   — Async generator FSA walker; luaparse-based metadata
                 parser; stable highlight-id derivation; sidecar key.
  render.ts    — Page-property and highlight-block builders, sanitisers,
                 page-name disambiguation, KOReader-datetime parser.
  storage.ts   — Typed wrappers around logseq.settings for the four
                 state maps; explicit "set every key to null then
                 wipe" reset that beats Logseq's deep-merge.
```

Build harness: Vite 5 + `vite-plugin-logseq` + React 18. Runtime deps:
`@logseq/libs`, `luaparse`, `mustache`, `date-fns`, `react`,
`react-dom`. Roughly 800 LOC total.

## Known limitations

- **No deletion handling.** Highlights removed in KOReader are not
  removed from Logseq.
- **Append-only with no rendering customisation in this build.** The
  Mustache template settings are not currently consulted; the renderer
  takes the structured-property path. Re-introducing user-editable
  templates is on the backlog.
- **Mustache template settings still appear in the panel** even though
  they're inert. Will be hidden until templating is re-wired.
- **Empty `key:: ` property lines** were the source of an early
  page-load crash; now mitigated by the structured properties API and
  by `sanitisePropertyValue` returning `undefined` for empty strings so
  the surrounding Mustache section drops out.

## Backlog

- User-customisable rendering (re-wire Mustache templates as a layer
  on top of the structured-properties path).
- Optional removal of highlights deleted in KOReader.
- Better progress reporting / cancel button.
- Marketplace publication (after a few more iterations and real-world
  testing).

## License

MIT.
