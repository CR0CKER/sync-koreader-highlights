# Changelog

All notable changes to this project will be documented here. The format
is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
