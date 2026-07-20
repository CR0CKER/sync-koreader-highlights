`@logseq/libs` now publishes **`__LATEST__`** on the `latest` dist-tag; this repo pins **`__PINNED__`**.

A newer stable release is the re-rating trigger recorded in
[`docs/adr/0001-dependency-vulnerability-posture.md`](../blob/master/docs/adr/0001-dependency-vulnerability-posture.md):
it's what would let us clear the vendored `dompurify` / `lodash-es` advisories
(currently dismissed as unreachable) for real.

### Do

- [ ] Bump `@logseq/libs` to `__LATEST__` on its own PR.
- [ ] **Manually QA the plugin in a real Logseq graph** — the unit suite covers only the pure parse/render layer, not the `@logseq/libs` integration surface.
- [ ] Re-run `npm audit`; if the vendored advisories are gone, un-dismiss / let the Dependabot alerts close, and consider enabling the blocking audit gate.
- [ ] Supersede ADR 0001 if the posture changes.

_Filed automatically by `.github/workflows/logseq-libs-watch.yml`._
