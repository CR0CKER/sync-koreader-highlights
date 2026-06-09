import '@logseq/libs'

export interface BookIdEntry {
  pageUuid: string
  title: string
}

const KEY_BOOK_IDS = 'bookIdsMap'
const KEY_LAST_HIGHLIGHT = 'lastHighlightDatetimeMap'
const KEY_LAST_SYNC = 'lastSync'
const KEY_HIGHLIGHT_IDS = 'highlightIdsMap'
const KEY_BOUND_GRAPH = 'boundGraph'

/** Identity of the one graph this plugin is allowed to write to. `url` is
 *  Logseq's stable graph identifier (e.g. `logseq_local_/path…`); `name` is
 *  only for display. Mirrors the relevant fields of `AppGraphInfo`. */
export interface BoundGraph {
  name: string
  url: string
}

export function getBoundGraph(): BoundGraph | null {
  return (logseq.settings?.[KEY_BOUND_GRAPH] as BoundGraph | undefined) ?? null
}

export async function setBoundGraph(graph: BoundGraph): Promise<void> {
  await logseq.updateSettings({ [KEY_BOUND_GRAPH]: { name: graph.name, url: graph.url } })
}

export async function clearBoundGraph(): Promise<void> {
  await logseq.updateSettings({ [KEY_BOUND_GRAPH]: null as any })
}

export function getBookIdsMap(): Record<string, BookIdEntry> {
  return (logseq.settings?.[KEY_BOOK_IDS] as Record<string, BookIdEntry>) ?? {}
}

export async function setBookId(sidecarKey: string, entry: BookIdEntry): Promise<void> {
  const map = { ...getBookIdsMap(), [sidecarKey]: entry }
  await logseq.updateSettings({ [KEY_BOOK_IDS]: map })
}

export async function clearBookIds(): Promise<void> {
  // Logseq's updateSettings deep-merges objects, so `{ [KEY]: {} }` is a no-op.
  // Setting individual entries to null is the documented pattern for removal;
  // we then overwrite with an empty object so subsequent reads see {}.
  const existing = getBookIdsMap()
  const wipe: Record<string, null> = {}
  for (const k of Object.keys(existing)) wipe[k] = null
  if (Object.keys(wipe).length > 0) {
    await logseq.updateSettings({ [KEY_BOOK_IDS]: wipe })
  }
  await logseq.updateSettings({ [KEY_BOOK_IDS]: null as any })
}

export function getLastHighlightDatetimeMap(): Record<string, string> {
  return (logseq.settings?.[KEY_LAST_HIGHLIGHT] as Record<string, string>) ?? {}
}

export async function setLastHighlightDatetime(sidecarKey: string, datetime: string): Promise<void> {
  const map = { ...getLastHighlightDatetimeMap(), [sidecarKey]: datetime }
  await logseq.updateSettings({ [KEY_LAST_HIGHLIGHT]: map })
}

export async function clearLastHighlightDatetimes(): Promise<void> {
  const existing = getLastHighlightDatetimeMap()
  const wipe: Record<string, null> = {}
  for (const k of Object.keys(existing)) wipe[k] = null
  if (Object.keys(wipe).length > 0) {
    await logseq.updateSettings({ [KEY_LAST_HIGHLIGHT]: wipe })
  }
  await logseq.updateSettings({ [KEY_LAST_HIGHLIGHT]: null as any })
}

export function getHighlightIdsMap(): Record<string, Record<string, true>> {
  return (logseq.settings?.[KEY_HIGHLIGHT_IDS] as Record<string, Record<string, true>>) ?? {}
}

export async function recordHighlightIds(sidecarKey: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const map = { ...getHighlightIdsMap() }
  const bucket = { ...(map[sidecarKey] ?? {}) }
  for (const id of ids) bucket[id] = true
  map[sidecarKey] = bucket
  await logseq.updateSettings({ [KEY_HIGHLIGHT_IDS]: map })
}

/** Replace (not merge) the recorded highlight ids for one book. Used by
 *  the rebuild flow so that highlights deleted on the device drop out of
 *  the dedup map. Pass an empty array to clear the bucket entirely. */
export async function replaceHighlightIds(sidecarKey: string, ids: string[]): Promise<void> {
  const map = { ...getHighlightIdsMap() }
  // Set the previous bucket's keys to null first so Logseq's deep-merge
  // settings update actually drops them.
  const oldBucket = map[sidecarKey] ?? {}
  if (Object.keys(oldBucket).length > 0) {
    const wipe: Record<string, null> = {}
    for (const k of Object.keys(oldBucket)) wipe[k] = null
    await logseq.updateSettings({ [KEY_HIGHLIGHT_IDS]: { [sidecarKey]: wipe } })
  }
  const bucket: Record<string, true> = {}
  for (const id of ids) bucket[id] = true
  await logseq.updateSettings({ [KEY_HIGHLIGHT_IDS]: { [sidecarKey]: bucket } })
}

export async function clearHighlightIds(): Promise<void> {
  const existing = getHighlightIdsMap()
  const wipe: Record<string, null> = {}
  for (const k of Object.keys(existing)) wipe[k] = null
  if (Object.keys(wipe).length > 0) {
    await logseq.updateSettings({ [KEY_HIGHLIGHT_IDS]: wipe })
  }
  await logseq.updateSettings({ [KEY_HIGHLIGHT_IDS]: null as any })
}

export function getLastSync(): string | undefined {
  return logseq.settings?.[KEY_LAST_SYNC] as string | undefined
}

export async function setLastSync(value: string): Promise<void> {
  await logseq.updateSettings({ [KEY_LAST_SYNC]: value })
}
