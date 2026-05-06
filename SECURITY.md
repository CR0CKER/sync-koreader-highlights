# Security policy

This is a small, single-maintainer Logseq plugin. There is no
automated security pipeline.

## Reporting a vulnerability

If you find a security issue (e.g. arbitrary file read outside the
picked directory, content injection that escapes Logseq's
property/wiki-link sanitisation, or anything else that could lead
to data exfiltration or graph corruption), please **report it
privately** rather than opening a public issue:

- Open a [private security advisory](https://github.com/CR0CKER/sync-koreader-highlights/security/advisories/new)
  on this repository, or
- Email the maintainer using the address GitHub shows on the
  `CR0CKER` account profile.

I'll acknowledge receipt within a reasonable window and discuss
disclosure timing with you. Public bug reports are also welcome
for non-sensitive issues — see [README.md](./README.md#contributing).

## What this plugin can and can't see

- It reads files **only** from the directory you explicitly pick
  via the File System Access API.
- It makes no network requests.
- The picked directory handle is persisted to your browser's
  IndexedDB, scoped to Logseq, never transmitted anywhere.
- All sync state (`bookIdsMap`, `highlightIdsMap`,
  `lastHighlightDatetimeMap`, `lastSync`) lives in Logseq's local
  settings file.

## Scope

In scope:

- Anything the plugin code does on a user's machine that exceeds
  the documented behaviour.
- Content that could escape Logseq's escaping when written to a
  page (broken page-load, script injection, etc.).
- Permission elevation beyond the picked directory.

Out of scope:

- Bugs in Logseq, KOReader, Calibre, Syncthing, or other upstream
  projects.
- Misuse of property values that are clearly under the user's own
  control.
