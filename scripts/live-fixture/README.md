# Live-test fixture

Made-up data for [`scripts/live-sync.mjs`](../live-sync.mjs): a KOReader
library (`books/`) and a small Logseq graph (`graph/`). Nothing here comes
from a real library or graph.

| Book | What it exercises |
|---|---|
| The Lantern Archive: A Novel | new page; colon in the title; series, keywords, a note; a ribbon bookmark |
| The Odyssey | a page with that name already exists; the user's note on it must survive |
| Field Notes (PDF) | PDF positions as page-coordinate tables (#24) |
| Slow Reading/Fast Thinking | the graph has `Slow Reading, Fast Thinking`; makes a second page today (#45) |
| Unopened | a stub sidecar with no `doc_props`; skipped |

Each sidecar has its own `partial_md5_checksum`, so the plugin tells the
books apart. To cover a new case, add a book folder with a
`<name>.sdr/metadata.<ext>.lua` sidecar, and a page under `graph/` if it
needs one.
