# Changelog

All notable changes to this project will be documented here. The format
is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Restore type-checking: `tsc --noEmit` was failing with 8 errors and was
  never run in CI (only `vite build`, which strips types unchecked). Fixed
  the `date-fns/format` import (named `formatDate`), typed the
  `logseq.settings` locals, and corrected `resolvePageName` being passed a
  string array where a string was expected (collision-disambiguated page
  names previously stringified the author array with a raw comma-join).

### Added

- `npm run typecheck` script and a Type-check step in CI so type errors
  fail the build.
- Vitest unit-test suite covering the pure parse/render layer
  (`src/sidecar.ts`, `src/render.ts`): sidecar shapes (modern annotations,
  legacy bookmarks, ribbon page-bookmarks, stubs, multi-author/keyword
  separators), datetime parsing, page-name sanitising/collision handling
  (incl. the M1 regression), and highlight/note/bookmark rendering. Run
  with `npm test`; gated as its own `test` job in CI.
- README status-badge row (CI / license / release) and a `Last updated`
  stamp.
- `import type` on the type-only `IBatchBlock` import in `render.ts` so the
  module is cleanly importable under the test runner.

## [0.1.6] – 2026-06-09

### Fixed

- **The plugin is now tied to a single graph and no longer writes
  book/highlight pages into whatever graph happens to be open.**
  Logseq stores plugin settings (and runs sync writes) against the
  active graph, so opening a different graph and syncing — or letting
  an automatic/launch sync fire there — used to scatter KOReader pages
  across unrelated graphs. The plugin now binds to one graph on the
  first sync and refuses to write to any other.

### Added

- **Graph binding.** The panel shows a "Graph:" row with the bound
  graph and a **Bind / Re-bind to this graph** button. The first
  "Sync now" auto-binds the open graph; opening any other graph
  disables "Sync now" and shows a warning. Background (interval) and
  launch syncs silently skip when the open graph isn't the bound one.
  Re-binding to a different graph resets tracked sync state (pages in
  the previous graph are left untouched for manual cleanup).
- New command-palette entry **"Sync Koreader Highlights: unbind
  graph"** to clear the binding; the next sync re-binds to the open
  graph.

## [0.1.5] – 2026-05-24

### Fixed

- **"Sync now" now re-grants directory permission after a Logseq
  restart.** Chromium drops File System Access permissions across
  sessions even when the directory handle itself is persisted, so
  clicking Sync after relaunching Logseq used to fail with an
  opaque error. The Sync button now invokes
  `requestPermission({mode:'read'})` from the click handler,
  triggering Chromium's one-tap re-grant prompt. Denials surface a
  clear in-panel log line and a warning toast instead of a stack
  trace.

## [0.1.4] – 2026-05-21

### Documentation

- README refreshed for the v0.1.3 in-plugin panel: a new
  "How it works" section walks through the toolbar → panel →
  picker → sync flow in plain steps, the stale "currently works
  on Linux only" warning is removed, the "Status" section
  reflects the live marketplace listing, and the loading
  instructions now lead with the marketplace install.
- Added macOS to the list of explicitly-tested platforms.

(No source changes from 0.1.3.)

## [0.1.3] – 2026-05-21

### Fixed

- **Root cause of the picker + theming failures in packaged
  installs: missing `"effect": true` in `package.json`.** Without
  that flag Logseq loaded the plugin into a cross-origin iframe
  sandbox, which (a) blocked `showDirectoryPicker` by Permissions
  Policy, (b) stripped user activation from toolbar clicks dispatched
  through Logseq's command bridge, and (c) made the parent's
  `--ls-*` CSS variables unreadable from inside the plugin. With
  `effect: true` Logseq picks the shadow-DOM sandbox, the plugin
  runs same-origin to the host, and all three issues disappear.
  v0.1.1 (realm walk) and v0.1.2 (`<input>` fallback) each chased
  symptoms of the cross-origin restriction without the underlying
  fix; both code paths remain as safety nets but are no longer the
  primary picker route.
- Directory picker now opens reliably on Linux, macOS, and Windows
  packaged installs. The toolbar icon opens a themed sync panel
  rendered inside the plugin (mirroring the `logseq-reading-list`
  plugin's modal); the user clicks a `<button>` inside that panel
  to choose a directory.
- Panel styling honours the active Logseq theme via the same
  parent-CSS-variable read used by the Reading List plugin — Awesome
  Styler accent and background overrides now apply correctly.

### Changed

- Toolbar icon opens a sync panel instead of triggering a sync
  directly. The panel shows the currently-selected directory,
  last-sync timestamp, a live sync-progress log, a "Choose KOReader
  directory…" button, a "Sync now" button, and a link to the
  standard Logseq plugin-settings dialog (which still hosts the
  Mustache template and auto-sync knobs).
- The "Sync Koreader Highlights: sync now" command-palette entry is
  replaced with "Sync Koreader Highlights: open panel". The four
  reset/forget commands are unchanged.
- Settings copy clarified: "Remember Koreader directory", auto-sync
  on launch, and the auto-sync interval are all effectively
  same-origin-only (dev-mode unpacked installs). On packaged
  installs the directory must be re-selected from the panel each
  session — `File` blobs from the `<input>` fallback don't survive
  a Logseq restart.

### Removed

- React and react-dom runtime dependencies (the iframe UI is now
  vanilla DOM). Also removed `@types/react`, `@types/react-dom`,
  `@vitejs/plugin-react` devDeps and the React plugin entry in
  `vite.config.ts`.

## [0.1.2] – 2026-05-21

### Fixed

- Directory picker on macOS / Windows marketplace installs. The 0.1.1
  fix (resolve `showDirectoryPicker` across realms) was insufficient:
  Chromium blocks the File System Access API from cross-origin
  iframes regardless of which realm exposes the function, throwing
  `SecurityError: Cross origin sub frames aren't allowed to show a
  file picker`. Logseq's marketplace install runs plugins in a cross-
  origin iframe (dev-mode install does not, which is why the previous
  release worked when loaded as an unpacked plugin). The plugin now
  detects the cross-origin case upfront and falls back to a
  `<input type="file" webkitdirectory>` picker, which is gated only by
  a user click and not by Permissions Policy. The returned `FileList`
  is wrapped in a minimal `FileSystemDirectoryHandle`-shaped adapter
  so the sidecar walker is unchanged.

### Known limitations

- On platforms using the `<input>` fallback (macOS / Windows
  marketplace installs at time of release), "Remember Koreader
  directory" cannot persist across Logseq restarts — `File` blobs
  don't survive a reload. The plugin will prompt for the directory on
  every sync and surfaces a one-time toast explaining this.

## [0.1.1] – 2026-05-21

### Fixed

- Directory picker now appears on macOS (and Windows) Logseq builds.
  `window.showDirectoryPicker` is gated by Permissions Policy inside
  the plugin iframe and is disabled by default on those platforms;
  the plugin now walks `window → parent → top` and calls the API in
  the first realm that exposes it. When no realm exposes it the user
  gets an explicit error toast instead of silent failure, and
  per-realm availability is logged to the console for diagnosis.
- Picker failures other than user-cancellation now surface a toast
  naming the underlying error instead of being swallowed.

### Changed

- Book-page header template setting now ships with a visible default
  that mirrors the structured page-level properties, so users can see
  and edit a real starting point. The rendered template is always
  parsed line-by-line as `key:: value` pairs and written through
  Logseq's structured `createPage` properties API — the same safe
  path is used whether the default is kept or the user customises.
  Customising the template adjusts the page-level properties
  themselves, not a separate inline block.
- Schema defaults for the three template settings are backfilled on
  plugin load, so the textareas show an editable starting point even
  for users upgrading from a version where the default was empty.
- KOReader ribbon page bookmarks render as `Bookmarked` for clarity.
- Merging into an existing book page no longer duplicates block-level
  properties.

### Documentation

- README now includes screenshots of a book page, a journal day, and
  the `KOReader` index page.

## [0.1.0] – 2026-05-06

Initial public release.

### Added

- One-Logseq-page-per-book sync from KOReader sidecar files.
- Page-level properties: `title`, `author` (each as `[[wikilink]]`),
  `series`, `tags` (multi-value), `summary` (HTML stripped, entities
  decoded). Properties are written via Logseq's structured
  `createPage(name, properties, opts)` API for safe escaping.
- Three KOReader item shapes supported: highlights, standalone
  notes, page bookmarks. Distinguished by which sidecar fields are
  populated and rendered with appropriate body text.
- Highlight blocks carry structured properties (`date`,
  `date-updated`, `chapter`, `page`). The `date` value is a
  `[[<journal-day>]]` page-link so Logseq's native Linked References
  panel surfaces every highlight on its journal day automatically.
- Single `Highlights synced from [[KOReader]]` heading per book;
  rebuilt only when the underlying highlight set changes.
- Replace-on-change update model: highlights deleted on the device
  drop out of Logseq on the next sync.
- Existing pages preserved: page-level properties merge non-
  destructively; user content above and below the highlights block
  is left untouched.
- Single `KOReader` index page with a top-of-page sync receipt
  listing new books and per-book highlight counts.
- Toolbar icon triggers a sync directly; status appears as Logseq
  toasts.
- Persistent directory handle via IndexedDB; survives Logseq
  restarts.
- Auto-sync on Logseq launch and on a configurable interval (in
  minutes), best-effort against Chromium's File System Access
  permission rules.
- Mustache templates for the book-page header, highlights-section
  heading, and highlight block, exposed in plugin settings with
  defaults pre-filled.
- Command palette: `sync now`, `reset sync state`,
  `reset and delete all book pages`, `forget remembered directory`,
  `reset templates to defaults`.

### Tested

- KOReader 2025.04 on Android.
- Logseq 0.10.x on Linux (Asahi Fedora aarch64).

### Known limitations

- Auto-sync on launch may silently fail when Chromium refuses to
  re-grant File System Access permission outside a user-activation
  context. A subsequent click on the toolbar icon recovers.
- Edits made to blocks under the `Highlights synced from [[KOReader]]`
  heading are overwritten on the next change-bearing sync. Edits
  outside that block are preserved.
- Not yet published to the Logseq plugin marketplace.
