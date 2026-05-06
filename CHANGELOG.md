# Changelog

All notable changes to this project will be documented here. The format
is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

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
