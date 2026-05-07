# Sync KOReader Highlights

A Logseq plugin that imports your [KOReader](https://koreader.rocks/)
highlights, notes, and bookmarks into your Logseq graph — one Logseq
page per book, with rich properties, journal-day backlinks, and an
idempotent replace-on-change sync model.

> **Inspiration & credits.** This plugin was inspired by two prior
> works:
>
> - [`isosphere/logseq-koreader-sync`](https://github.com/isosphere/logseq-koreader-sync)
>   for showing that KOReader sidecars can be parsed in-browser via
>   `luaparse` and the File System Access API. No code is reused; the
>   layout, sync engine, and rendering pipeline here are written from
>   scratch with a different design.
> - [`readwiseio/logseq-readwise-official-plugin`](https://github.com/readwiseio/logseq-readwise-official-plugin)
>   for the per-book-page UX, the property-based metadata model, and
>   the toolbar/index-page conventions that this plugin mirrors.
>
> Thank you to both projects.

> **AI-assisted development.** This plugin was built with substantial
> help from [Claude Code](https://www.anthropic.com/claude-code).
> If that matters to you, read the source before you load the plugin into your graph.

> **Use at your own risk.** This software is provided "as is",
> without warranty of any kind, express or implied. The author
> accepts no liability for data loss, graph corruption, lost
> highlights, broken syncs, or any other damages arising from the
> use of this plugin. **Always back up your Logseq graph before
> trying any new plugin, including this one.** See the [LICENSE](./LICENSE)
> for the full disclaimer.

## Tested with

- **KOReader 2025.04** on Android (annotations and bookmarks
  written to `metadata.*.lua` sidecars, propagated to the desktop
  via Syncthing or any other file-level sync).
- **Logseq 0.10.x** on Linux (Asahi Fedora aarch64). The plugin
  uses only Logseq's standard JS plugin API, so other Logseq
  desktop builds (Mac, Windows, other Linux distros) are expected
  to work; they have not been exhaustively tested.

## Status

Public beta. Working end-to-end against a real Calibre + KOReader
library. Not yet on the Logseq plugin marketplace; load the
repository as an unpacked plugin (see
[Loading in Logseq](#loading-in-logseq) below).

## Screenshots

A book page with KOReader-derived properties (author, tags, summary)
and the synced highlights below:

![Book page with properties and highlights](docs/screenshots/book-page.png)

A journal day, showing every highlight made on that date as a Linked
Reference — produced automatically by the `date::` page-link on each
highlight block, with no plugin-authored blocks on the journal page:

![Journal day with linked references to highlights](docs/screenshots/journal-day.png)

The `KOReader` index page, where each sync writes a receipt and every
synced book backlinks via the `[[KOReader]]` mention in its highlights
heading:

![KOReader index page with sync receipt and linked book](docs/screenshots/koreader-index.png)

## What it does

### Per book

- **One Logseq page per book.** Page name comes from the KOReader
  sidecar's `doc_props.title`, with the following sanitisation so
  the name doesn't break Logseq's wikilink / page-creation rules:
  - `[` / `]` → `(` / `)`
  - `:` → ` — ` (so titles like
    `This Life: Secular Faith and Spiritual Freedom` become
    `This Life — Secular Faith and Spiritual Freedom` for the page
    address; the colon-bearing original lives in the `title::`
    property and renders correctly in Logseq's UI).
  - Title collisions get disambiguated as `<title> — <authors>` or
    `<title> (n)`.

- **Page-level properties** (defined by the customisable
  Book-page header template and written via Logseq's structured
  `createPage(name, properties, opts)` API so Logseq escapes them
  natively). The default template produces:
  - `author::` — each KOReader author rendered as its own
    `[[wikilink]]`. Names containing `Last, First` commas are split
    only on KOReader's `\n` separator, never on commas inside a name.
  - `full-title::` — full original title, including any colons.
  - `series::` — single `[[wikilink]]` from `doc_props.series`
    when present.
  - `category:: #Books` — a constant tag so every synced book is
    grouped under the `Books` page.
  - `summary::` — the full `doc_props.description`, with HTML tags
    stripped, named/numeric HTML entities decoded, and Lua escapes
    resolved. Not truncated.
  - `tags::` — comma-joined `[[wikilinks]]`, sourced from
    `doc_props.keywords` (or `doc_props.subject` as fallback).
    Split on `;`, `,`, and newlines so KOReader's multi-line
    keyword form (`Philosophy\<newline>Life`) yields two distinct
    tags.

  All values are sanitised before being written: newlines collapsed,
  duplicate `::` neutralised, whitespace trimmed. Empty values cause
  their property line to drop out entirely. Edit the Book-page
  header template setting to add, remove, or rename any of these.

- **Highlights / notes / bookmarks** (KOReader stores all three in
  the `annotations` table; the renderer disambiguates by which
  fields are populated):
  - **Highlight** (`text` non-empty) → block content `> {text}`,
    optional KOReader-side note attached as a child block.
  - **Note alone** (`text` empty, `note` non-empty) → the note text
    becomes the block body (no blockquote prefix, no `Bookmarked`
    placeholder).
  - **Page bookmark** (both empty) → block content `> Bookmarked`.

  Each block carries structured properties — order: `date`,
  `date-updated`, `chapter`, `page`. The `date` value is a
  `[[<journal-day>]]` page-link formatted with the user's
  `preferredDateFormat`, so Logseq's native Linked References panel
  surfaces every highlight on its journal day automatically (no
  plugin-authored blocks on the journal side). Standalone notes
  intentionally skip `date-updated`.

- **Highlights heading.** A single block per book, content
  `Highlights synced from [[KOReader]]`. The `[[KOReader]]` link
  gives you a backlink to every book on the index page. The
  heading intentionally omits a date because each highlight block
  already carries its own `date::` page-link to the journal day it
  was made.

### Per sync run

- **Idempotency state** lives in `logseq.settings`, not in graph
  block properties:
  - `bookIdsMap: { sidecarKey → { pageUuid, title } }` where
    `sidecarKey` is `md5:<partial_md5_checksum>` (stable across
    file moves and Calibre id changes) with a
    `meta:<authors>|||<title>` fallback for ancient sidecars.
  - `highlightIdsMap: { sidecarKey → { highlightId: true } }` —
    dedup set keyed by `<datetime>|<pos0>|<pos1>|<notes>|<text>`.
  - `lastHighlightDatetimeMap`, `lastSync`.

- **Replace-on-change update model.** When a sidecar's set of
  highlights differs from what's recorded in the dedup map (new
  ones added on the device, removed ones, or both), the existing
  `Highlights synced from …` block and its children are removed
  and rewritten in full from the current sidecar. No-op syncs
  (zero added, zero removed) leave the page completely untouched.
  Highlights deleted on the device drop out of Logseq too — the
  trade-off is that user edits to highlight blocks get lost on
  the next change-bearing sync. Edits to anything **outside** the
  `Highlights synced from …` block are preserved.

- **Existing-page protection.** When a Logseq page or the
  `KOReader` index page already exists at sync time, the plugin
  never overwrites user content:
  - On a book page, page-level properties are added only where
    they aren't already present, never updated.
  - The `Highlights synced from …` block lands at the bottom of
    the existing content; the user's prior blocks stay above.
  - On the `KOReader` index page, the sync receipt is **prepended**
    so it always sits at the top, with everything else below
    untouched. Old receipt blocks (both `## 📚 Sync …` and
    `## 📚 Synced on …` shapes) are removed before the new one
    drops in.

- **Books with zero items skipped.** Books whose sidecar has
  neither highlights nor notes nor bookmarks aren't synced at
  all — no Logseq page, no entry on the index page.

- **Stub-sidecar tolerance.** Sidecars without a populated
  `doc_props` (KOReader writes those for books opened-but-never-
  annotated, and re-collapses to that shape if you delete the last
  remaining annotation on the device) are silently skipped.

- **Numeric-keyed-table handling.** KOReader writes sequence-
  shaped values (annotations, multi-author/multi-tag fields) as
  Lua tables with explicit `["1"] = …, ["2"] = …` numeric-string
  keys rather than implicit sequences. The parser detects 1..N
  integer-keyed shapes and converts them to JS arrays so
  downstream code can iterate them.

### Sync receipt

A single `KOReader` index page receives a `## 📚 Synced on
<date> at <time>` block (rewritten on every sync that touches at
least one book) listing new books as `[[wikilinks]]` and existing
books that gained highlights with per-book counts.

## Loading in Logseq

1. Plugins → ··· → **Load unpacked plugin** → point at this
   repository's root directory.
2. A book icon appears in the toolbar.
3. Click it, pick the directory containing your KOReader sidecars
   (typically your Calibre library or whatever folder Syncthing
   pulls from your reader).

## Settings

In Logseq → Plugins → Sync KOReader Highlights → ⚙:

- **Remember Koreader directory** *(default on)* — persists the
  picked directory handle to IndexedDB so the picker is skipped
  on subsequent syncs and across Logseq restarts.
- **Auto-sync on Logseq launch** *(default off)* — runs a sync
  shortly after Logseq starts. See
  [Auto-sync limitations](#auto-sync-limitations) below.
- **Auto-sync interval (minutes)** *(default 0 = disabled)* —
  runs a sync every N minutes. Background ticks never prompt for
  the picker (they're a no-op when the directory hasn't been
  remembered yet), to avoid disrupting the user.
- **Book page header template** *(Mustache)* — defines the
  page-level properties on each book page. Pre-filled with a
  default that produces `author`, `full-title`, `series`,
  `category:: #Books`, `summary`, and `tags`. Add, remove, or
  rename properties by editing the template; the rendered output
  is parsed line-by-line as `key:: value` pairs and written
  through Logseq's structured `createPage` properties API for
  safe escaping (same path whether you keep the default or
  customise). Lines that don't match `key:: value` are dropped,
  so empty Mustache sections (`{{#series}}…{{/series}}`) collapse
  cleanly. Variables: `{{title}}`, `{{authors}}`,
  `{{authorsLinked}}`, `{{series}}`, `{{seriesLinked}}`,
  `{{tags}}`, `{{tagsLinked}}`, `{{language}}`, `{{summary}}`
  (alias `{{description}}`), `{{koreaderId}}`.
- **Highlights section heading template** *(Mustache; default
  `Highlights synced from [[KOReader]]`)* — always rendered
  through Mustache. Variables: `{{date}}` (current sync time),
  `{{kind}}` (`"initial sync"` or `"sync"`). Add them back to the
  template if you want a date-bearing heading.
- **Highlight block template** *(Mustache; default reproduces
  the inline-properties shape)* — when left at the default, the
  renderer uses Logseq's structured-properties API (safer
  escaping). When modified, the template owns the entire block
  content, including any inline `key:: value` lines you write.
  Variables: `{{text}}`, `{{date}}`, `{{dateUpdated}}`,
  `{{chapter}}`, `{{page}}`, `{{note}}`, plus boolean
  discriminators `{{isHighlight}}`, `{{isNote}}`,
  `{{isBookmark}}`.

State maps (`bookIdsMap`, `highlightIdsMap`,
`lastHighlightDatetimeMap`, `lastSync`) are stored in
`logseq.settings` and not exposed in the UI. The directory
handle itself lives in IndexedDB under
`sync-koreader-highlights:directoryHandle`.

## UI

- **Toolbar icon** triggers a sync directly. No modal pops up.
- **Toasts** (`logseq.UI.showMsg`) report start, completion
  summary (`Sync done — N new book(s), M new highlight(s), …`),
  and any errors.
- **Command palette** entries:
  - `Sync KOReader Highlights: sync now`
  - `Sync KOReader Highlights: reset sync state`
  - `Sync KOReader Highlights: reset and delete all book pages`
  - `Sync KOReader Highlights: forget remembered directory`
  - `Sync KOReader Highlights: reset templates to defaults`
- All other configuration lives in the standard Logseq plugin
  settings panel.

## Auto-sync limitations

The Readwise plugin's auto-sync just works because Readwise is
an HTTPS pull and needs no permission story. This plugin uses
the File System Access API, which Chromium drops the read
permission for on every Logseq restart. To re-grant permission
the plugin needs to call `requestPermission` *inside a user-
activation context* (i.e. a click or keypress event). The
plugin tries to defer the launch sync to the next user
activation by listening for `pointerdown` / `keydown`, but
Chromium does not always propagate user activation from the
plugin's iframe. When that happens the auto-sync silently
fails; a click on the toolbar icon (always a proper user-
activation context) re-grants and runs the sync.

The interval setting has the same limitation: a background tick
fires only when permission is currently granted in this session.

## Build

System Node 22+ (the project uses Vite 5 + React 18 +
TypeScript). On Asahi Fedora aarch64, an x86-64 nvm install can
shadow the right binary, so:

```sh
PATH=/usr/bin:$PATH /usr/bin/npm install
PATH=/usr/bin:$PATH /usr/bin/npm run build
```

Output lands in `dist/` (one `index.html` + one bundled JS
asset, ≈165 KB).

## Architecture

```
src/
  main.tsx     — Logseq plugin lifecycle, settings schema,
                 toolbar, command palette, picker (with IDB
                 persistence), launch-sync activation deferral.
  sync.ts      — Sync engine: walk → parse → diff against state
                 maps → createPage / rebuildHighlightsSection /
                 writeIndexReceipt.
  sidecar.ts   — Async generator FSA walker; luaparse-based
                 metadata parser (numeric-keyed-table handling,
                 Lua-unescaped string values, multi-line
                 keyword/author splitting); highlight-id
                 derivation; sidecar key.
  render.ts    — Page-property and highlight-block builders;
                 Mustache template plumbing; HTML-entity
                 decoder; page-name and property-value
                 sanitisers; KOReader datetime parser.
  storage.ts   — Typed wrappers around `logseq.settings` for
                 the four state maps. Reset writes per-key
                 nulls before the top-level null overwrite,
                 since Logseq's `updateSettings` deep-merges and
                 `{key: {}}` is a no-op.
```

Runtime deps: `@logseq/libs`, `luaparse`, `mustache`,
`date-fns`, `idb-keyval`. About 1100 lines of source.

## Privacy

The plugin reads files only from the directory you explicitly
pick, runs entirely on your machine, and makes no network
requests of any kind. The picked directory handle is persisted
to your browser's IndexedDB, scoped to Logseq, and never
transmitted anywhere. State maps live in your local Logseq
settings file.

## Contributing

Issue reports and pull requests welcome on
[GitHub](https://github.com/CR0CKER/sync-koreader-highlights).

If you're filing a bug, please include:

- KOReader version (Settings → ⓘ → "About").
- Logseq version (top-right ⋯ → About Logseq).
- The plugin version (from `package.json`).
- A redacted copy of the relevant `metadata.*.lua` sidecar if
  the bug involves a specific book.
- Console output from Logseq's devtools (Ctrl+Shift+I →
  Console) at the time of the failure. Lines starting with
  `sync-koreader-highlights:` are particularly useful.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE).

## Project history

A short note on intent for future maintainers: the design
choices here are documented at the level of "why" in the commit
log, especially for the parser fix (KOReader's numeric-keyed
tables), the indexer-crash mitigation (switching from inline
properties to structured properties), the replace-on-change
update model (so device-side deletions propagate), the settings-
reset bug (Logseq's deep-merge surprises empty-object clears),
and the multi-character page-name handling. `git log` is the
durable source of truth.
