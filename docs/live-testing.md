# Live A/B testing in Logseq

The unit tests cover only the parse/render layer. A change that rebuilds the
shipped bundle without changing the code (a new Vite, a new minifier, a
dependency bump) should also be checked in a real Logseq before release:
sync the same data with the last released build and with the new one, and
compare what each wrote.

[`scripts/live-sync.mjs`](../scripts/live-sync.mjs) does one such run. It
starts Logseq OG with its own `HOME` and `--user-data-dir`, installs the build
as a packaged plugin, opens a copy of a test graph, picks a test KOReader
folder and presses **Sync now**.

The data is made up and lives in
[`scripts/live-fixture/`](../scripts/live-fixture/README.md): five books
(a new one, one whose page already exists, a PDF, a punctuation mismatch, a
stub) and a three-page graph. No real graph, library or Logseq profile is
read or opened.

## Requirements

- Logseq OG at `~/.local/opt/logseq-og/Logseq-OG`, or set `LOGSEQ_OG_BIN`.
  Only OG has been tried; other builds keep their profile in a different
  folder (`.logseq`), which the script doesn't handle.
- Node 22 or later (the script uses Node's built-in `WebSocket`), `gh`,
  `unzip` and `jq`.

## Run

```sh
RUN=$(mktemp -d)
gh release download -R CR0CKER/sync-koreader-highlights -p '*.zip' -D "$RUN"   # latest release
unzip -q "$RUN"/sync-koreader-highlights-*.zip -d "$RUN/released"

npm run build
node scripts/live-sync.mjs --dist "$RUN/released/dist" --out "$RUN/old" --port 9721
node scripts/live-sync.mjs --dist dist --out "$RUN/new" --port 9722
```

Each run prints the panel's sync log; with the fixture it should report
4 new books and 1 stub skipped. The script waits for Logseq to finish
indexing the graph before it syncs, because syncing earlier lost writes.

## Compare

```sh
cd "$RUN"
diff -r -x KOReader.md -x custom.css old/graph new/graph
diff <(sed 1d old/graph/pages/KOReader.md) <(sed 1d new/graph/pages/KOReader.md)
S=home/.logseq-og/settings/sync-koreader-highlights.json
F='del(.lastSync, .boundGraph) | .bookIdsMap |= map_values(del(.pageUuid))'
diff <(jq -S "$F" old/$S) <(jq -S "$F" new/$S)
```

For a change that only rebuilds the bundle, all three should print nothing.
When the new build changes behaviour on purpose, they show the change; check
that it's the intended one and nothing else. What they leave out, and why:

- `KOReader.md`: its first line is the receipt's "Synced on" time.
- `custom.css`: Logseq creates it in every fresh profile.
- `lastSync`, `boundGraph` and the pages' `pageUuid`: a timestamp, the
  run's own graph path, and IDs Logseq generates on each run.

Matching runs only show the two builds agree. To check that they're also
right, read `new/graph/pages/`: the user's note on `The Odyssey` should still
be there, the PDF highlight should keep its text, the bookmark should read
`> Bookmarked`, the KOReader note should sit as a child block under its
highlight in `The Lantern Archive — A Novel`, and the highlight from
`Slow Reading/Fast Thinking` should be on the existing
`Slow Reading, Fast Thinking` page, with no second page (#45).

`--graph`, `--books` and `--settings` point a run at other data. Use them
with made-up data only, never a real graph or library.

## Debugging

- `LIVE_DEBUG=1` prints indexing progress while the script waits.
- `LIVE_KEEP=1` leaves Logseq running afterwards; the DevTools endpoint is on
  `--port`. Stop it by PID when done, never with `pkill -f`.
- A run directory can't be reused: every run needs a new `--out`, so both
  builds start from identical state.
- With `TMPDIR` set to a long path, Logseq OG twice crashed at startup
  (SIGTRAP) and the script gave up with "no DevTools endpoint after 60s". With
  the default `/tmp` it starts normally.

## How it drives Logseq

- Logseq opens a folder only through a native dialog, so the script answers
  it from the Electron main process, through the Node inspector on
  `--port` + 1000.
- Clicks are sent as real input events (`Input.dispatchMouseEvent`). The
  folder picker needs a user gesture, which `element.click()` doesn't give.
- `showDirectoryPicker` opens a native dialog that DevTools can't answer. The
  script hides it, so the plugin falls back to `<input webkitdirectory>`.
  `Page.setInterceptFileChooserDialog` plus `DOM.setFileInputFiles` then
  hands that input the books folder.
- After the sync, the script waits until the graph folder has been quiet for
  10 seconds before stopping Logseq, because Logseq writes pages after the
  sync reports done.

The approach comes from the live suites in `logseq-epub-export` and
`logseq-adwaita-theme`.
