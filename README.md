# Sync KOReader Highlights

A Logseq plugin that imports KOReader sidecar metadata
(`metadata.*.lua` files inside `*.sdr` directories) into your Logseq
graph. Modelled on the official Readwise plugin: one Logseq page per
book, idempotent updates, minimal UI surface, no server.

## Status

Working end-to-end against a real Calibre + KOReader library on
Linux/Asahi Fedora aarch64. Not yet published to the Logseq
marketplace; load the repository as an unpacked plugin.

## What it does

### Per book

- **One Logseq page per book.** Page name comes from the KOReader
  sidecar's `doc_props.title`, with the following sanitisation so the
  name doesn't break Logseq's wikilink / page-creation rules:
  - `[` / `]` → `(` / `)`
  - `:` → ` — ` (so titles like
    `This Life: Secular Faith and Spiritual Freedom` become
    `This Life — Secular Faith and Spiritual Freedom` for the page
    address; the colon-bearing original lives in the `title::`
    property and renders correctly in Logseq's UI).
  - Title collisions get disambiguated as `<title> — <authors>` or
    `<title> (n)`.

- **Page-level properties** (set via Logseq's structured
  `createPage(name, properties, opts)` API so Logseq escapes them
  natively):
  - `title::` — full original title, including any colons.
  - `author::` — each KOReader author rendered as its own
    `[[wikilink]]`. Names containing `Last, First` commas are split
    only on KOReader's `\n` separator, never on commas inside a name.
  - `series::` — single `[[wikilink]]` from
    `doc_props.series` when present.
  - `tags::` — comma-joined `[[wikilinks]]`, sourced from
    `doc_props.keywords` (or `doc_props.subject` as fallback). Split
    on `;`, `,`, and newlines so KOReader's multi-line keyword form
    (`Philosophy\<newline>Life`) yields two distinct tags.
  - `summary::` — the full `doc_props.description`, with HTML tags
    stripped, named/numeric HTML entities decoded, and Lua escapes
    resolved. Not truncated.

  All values are sanitised before being written: newlines collapsed,
  duplicate `::` neutralised, whitespace trimmed. Empty values cause
  their property line to drop out entirely.

- **Highlights / notes / bookmarks** (KOReader stores all three in the
  `annotations` table; the renderer disambiguates by which fields are
  populated):
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
  `Highlights synced from [[KOReader]] on [[<date>]]`. The `[[KOReader]]`
  link gives you a backlink to every book on the index page.

### Per sync run

- **Idempotency state** lives in `logseq.settings`, not in graph
  block properties:
  - `bookIdsMap: { sidecarKey → { pageUuid, title } }`
    where `sidecarKey` is `md5:<partial_md5_checksum>` (stable across
    file moves and Calibre id changes) with a `meta:<authors>|||<title>`
    fallback for ancient sidecars.
  - `highlightIdsMap: { sidecarKey → { highlightId: true } }` —
    dedup set keyed by `<datetime>|<pos0>|<pos1>|<notes>|<text>`.
  - `lastHighlightDatetimeMap`, `lastSync`.

- **Replace-on-change update model.** When a sidecar's set of
  highlights differs from what's recorded in the dedup map (new ones
  added on the device, removed ones, or both), the existing
  `Highlights synced from …` block and its children are removed and
  rewritten in full from the current sidecar. No-op syncs (zero
  added, zero removed) leave the page completely untouched. This
  replaces the original Readwise-style append-only model so that
  highlights deleted on the device drop out of Logseq too — the
  tradeoff is that user edits to highlight blocks get lost on the
  next change-bearing sync. Edits to anything **outside** the
  `Highlights synced from …` block are preserved.

- **Existing-page protection.** When a Logseq page or the `KOReader`
  index page already exists at sync time, the plugin never overwrites
  user content:
  - On a book page, page-level properties are added only where they
    aren't already present, never updated.
  - The `Highlights synced from …` block lands at the bottom of the
    existing content; the user's prior blocks stay above.
  - On the `KOReader` index page, the sync receipt is **prepended**
    so it always sits at the top, with everything else below
    untouched. Old receipt blocks (both `## 📚 Sync …` and
    `## 📚 Synced on …` shapes) are removed before the new one
    drops in.

- **Books with zero items skipped.** Books whose sidecar has neither
  highlights nor notes nor bookmarks aren't synced at all — no Logseq
  page, no entry on the index page.

- **Stub-sidecar tolerance.** Sidecars without a populated `doc_props`
  (KOReader writes those for books opened-but-never-annotated, and
  re-collapses to that shape if you delete the last remaining
  annotation on the device) are silently skipped. Same fix that
  resolves `isosphere/logseq-koreader-sync` PR #7 in the upstream.

- **Numeric-keyed-table handling.** KOReader writes sequence-shaped
  values (annotations, multi-author/multi-tag fields) as Lua tables
  with explicit `["1"] = …, ["2"] = …` numeric-string keys rather
  than implicit sequences. The parser detects 1..N integer-keyed
  shapes and converts them to JS arrays so downstream code can
  iterate them.

### Sync receipt

- **One `KOReader` index page** carries a single block,
  `## 📚 Synced on <date> at <time>`, with two children listing new
  books (as `[[wikilinks]]`) and existing books that gained
  highlights (with counts). The block is rewritten on every sync that
  touches at least one book.

## Settings

In Logseq → Plugins → Sync KOReader Highlights → ⚙:

- **Remember Koreader directory** *(default on)* — persists the
  picked directory handle to IndexedDB so the picker is skipped on
  subsequent syncs and across Logseq restarts.
- **Auto-sync on Logseq launch** *(default off)* — runs a sync
  shortly after Logseq starts. See
  [Auto-sync limitations](#auto-sync-limitations) below.
- **Auto-sync interval (minutes)** *(default 0 = disabled)* — runs a
  sync every N minutes. Background ticks never prompt for the picker
  (they're a no-op when the directory hasn't been remembered yet),
  to avoid disrupting the user.
- **Book page header template** *(Mustache; default empty)* — when
  empty the plugin uses the page-level properties path (above). When
  filled, the rendered text is prepended as a regular block at the
  top of each book page and the page-level properties are skipped to
  avoid duplication. Variables: `{{title}}`, `{{authors}}`,
  `{{authorsLinked}}`, `{{series}}`, `{{seriesLinked}}`, `{{tags}}`,
  `{{tagsLinked}}`, `{{language}}`, `{{summary}}` (alias
  `{{description}}`), `{{koreaderId}}`.
- **Highlights section heading template** *(Mustache; default
  `Highlights synced from [[KOReader]] on [[{{date}}]]`)* — always
  rendered through Mustache. Variables: `{{date}}`, `{{kind}}`.
- **Highlight block template** *(Mustache; default reproduces the
  inline-properties shape)* — when left at the default, the renderer
  uses Logseq's structured-properties API (safer escaping). When
  modified, the template owns the entire block content, including
  any inline `key:: value` lines you write. Variables: `{{text}}`,
  `{{date}}`, `{{dateUpdated}}`, `{{chapter}}`, `{{page}}`,
  `{{note}}`, plus boolean discriminators `{{isHighlight}}`,
  `{{isNote}}`, `{{isBookmark}}`.

State maps (`bookIdsMap`, `highlightIdsMap`,
`lastHighlightDatetimeMap`, `lastSync`) are stored in
`logseq.settings` and not exposed in the UI. The directory handle
itself lives in IndexedDB under
`sync-koreader-highlights:directoryHandle`.

## UI

- **Toolbar icon** triggers a sync directly. No modal pops up.
- **Toasts** (`logseq.UI.showMsg`) report start, completion summary
  (`Sync done — N new book(s), M new highlight(s), …`), and any
  errors.
- **Command palette** entries:
  - `Sync KOReader Highlights: sync now`
  - `Sync KOReader Highlights: reset sync state`
  - `Sync KOReader Highlights: reset and delete all book pages`
  - `Sync KOReader Highlights: forget remembered directory`
- All other configuration lives in the standard Logseq plugin
  settings panel.

## Auto-sync limitations

Readwise's auto-sync just works because Readwise is an HTTPS pull and
needs no permission story. Sync KOReader Highlights uses the
File System Access API, which Chromium drops the read permission for
on every Logseq restart. To re-grant permission you need to call
`requestPermission` *inside a user-activation context* (i.e. a click
or keypress event). The plugin tries to defer the launch sync to the
next user activation by listening for `pointerdown`/`keydown`, but
Chromium does not always propagate user activation from the plugin's
iframe, and the call can still throw `SecurityError: User activation
is required to request permissions`. When that happens, the auto-sync
silently fails and a click on the toolbar icon (which is always a
proper user-activation context) re-grants and runs the sync.

The interval setting has the same limitation: a background tick can
fire only when permission is currently granted in this session.

## Build

System Node 22+ (Vite 5 + React 18 + TypeScript). On Asahi Fedora
aarch64, an x86-64 nvm install can shadow the right binary, so:

```
PATH=/usr/bin:$PATH /usr/bin/npm install
PATH=/usr/bin:$PATH /usr/bin/npm run build
```

Output lands in `dist/` (one `index.html` + one bundled JS asset,
≈165 KB).

## Loading in Logseq

1. Plugins → ··· → **Load unpacked plugin** → point at this repo's
   root directory.
2. A book icon appears in the toolbar.
3. Click it, pick the directory containing your KOReader sidecars
   (typically your Calibre library or whatever folder Syncthing
   pulls from your reader).

## Architecture

```
src/
  main.tsx     — Logseq plugin lifecycle, settings schema, toolbar,
                 command palette, picker (with IDB persistence),
                 launch-sync activation deferral.
  sync.ts      — Sync engine: walk → parse → diff against state maps
                 → createPage / rebuildHighlightsSection / writeIndex
                 receipt.
  sidecar.ts   — Async generator FSA walker; luaparse-based metadata
                 parser (numeric-keyed-table handling, Lua-unescaped
                 string values, multi-line keyword/author splitting);
                 highlight-id derivation; sidecar key.
  render.ts    — Page-property and highlight-block builders;
                 Mustache template plumbing; HTML-entity decoder;
                 page-name and property-value sanitisers; KOReader
                 datetime parser.
  storage.ts   — Typed wrappers around logseq.settings for the four
                 state maps. Reset writes per-key nulls before the
                 top-level null overwrite, since Logseq's
                 updateSettings deep-merges and `{key: {}}` is a
                 no-op.
```

Runtime deps: `@logseq/libs`, `luaparse`, `mustache`, `date-fns`,
`idb-keyval`. About 1100 LOC.

## Project history (highlights)

- **Initial port from `isosphere/logseq-koreader-sync`.** The
  original plugin dumped every book and highlight into one
  `_logseq-koreader-sync` page; users with non-trivial libraries
  found that unworkable. We rewrote in the Readwise model — one
  page per book, structured idempotency state in plugin settings.
- **Numeric-keyed-table parser fix.** KOReader writes annotations
  as `["1"] = …, ["2"] = …, …`. luaparse exposes these as TableKey
  nodes, so the naive "all-TableValue → array" check produced an
  object-keyed map and downstream `Array.isArray(annotations)`
  failed silently. Detecting 1..N integer keys and converting was
  the difference between zero highlights syncing and everything
  syncing.
- **Indexer-crash class.** Authoring book-page metadata as inline
  `title:: …` blocks broke Logseq's property indexer for any book
  whose `doc_props.description` had escape sequences, HTML, or
  oversized values. Solution: switch to Logseq's structured
  `createPage(name, properties, opts)` and `IBatchBlock.properties`
  paths, which Logseq escapes itself.
- **Replace-on-change update model.** Initial design was Readwise-
  style append-only. User wanted highlight deletions on the device
  to propagate to Logseq, so the model became "rebuild the
  Highlights block whenever the dedup set differs". User edits
  inside the Highlights block are now ephemeral; user edits
  elsewhere on the book page are preserved.
- **Reset bug.** `logseq.updateSettings({key: {}})` deep-merges
  rather than replaces; clearing state required setting every prior
  bucket key to null first, then the top-level null. Without that,
  a "Reset" left the maps populated and made testing extremely
  confusing.
- **FSA + IDB.** The original implementation kept the directory
  handle only in a JS module variable and lost it on every plugin
  reload. We now persist the FileSystemDirectoryHandle in
  IndexedDB; bootstrap restores it; permission lapses are handled
  by deferring re-grant to the next user activation event.
- **Author / tag / page-name multi-character handling.** KOReader
  separates multi-value strings (authors, tags) with `\<LF>` line
  continuations, which luaparse may decode as a real newline or
  may leave as backslash + newline depending on context. The
  splitters now consume an optional leading backslash so values
  don't end up with stray `\` characters. Page names additionally
  get `[`, `]`, and `:` rewritten so they don't collide with
  Logseq's wikilink, property, and journal-format syntax.
- **Property naming aligned with Readwise** (`title`, `author`,
  `summary`, `tags`) so muscle memory carries between the two
  plugins.

## Known limitations / backlog

- **Auto-sync on launch is best-effort** because Chromium's
  user-activation rules sometimes refuse `requestPermission` even
  inside an event handler. See above.
- **Replace-on-change destroys user edits** to highlight blocks.
  The plugin preserves anything outside the
  `Highlights synced from …` block; an opt-in "preserve edits"
  mode is on the backlog if it turns out to be needed.
- **Mustache template inputs are textareas** with no syntax
  highlighting or live preview — copy-and-edit is the workflow.
- **No marketplace publication yet.**

## License

MIT.
