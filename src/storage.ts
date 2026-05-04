import '@logseq/libs'

export interface BookIdEntry {
  pageUuid: string
  title: string
}

const KEY_BOOK_IDS = 'bookIdsMap'
const KEY_LAST_HIGHLIGHT = 'lastHighlightDatetimeMap'
const KEY_LAST_SYNC = 'lastSync'
const KEY_HIGHLIGHT_IDS = 'highlightIdsMap'

export function getBookIdsMap(): Record<string, BookIdEntry> {
  return (logseq.settings?.[KEY_BOOK_IDS] as Record<string, BookIdEntry>) ?? {}
}

export async function setBookId(sidecarKey: string, entry: BookIdEntry): Promise<void> {
  const map = { ...getBookIdsMap(), [sidecarKey]: entry }
  await logseq.updateSettings({ [KEY_BOOK_IDS]: map })
}

export async function clearBookIds(): Promise<void> {
  await logseq.updateSettings({ [KEY_BOOK_IDS]: {} })
}

export function getLastHighlightDatetimeMap(): Record<string, string> {
  return (logseq.settings?.[KEY_LAST_HIGHLIGHT] as Record<string, string>) ?? {}
}

export async function setLastHighlightDatetime(sidecarKey: string, datetime: string): Promise<void> {
  const map = { ...getLastHighlightDatetimeMap(), [sidecarKey]: datetime }
  await logseq.updateSettings({ [KEY_LAST_HIGHLIGHT]: map })
}

export async function clearLastHighlightDatetimes(): Promise<void> {
  await logseq.updateSettings({ [KEY_LAST_HIGHLIGHT]: {} })
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

export async function clearHighlightIds(): Promise<void> {
  await logseq.updateSettings({ [KEY_HIGHLIGHT_IDS]: {} })
}

export function getLastSync(): string | undefined {
  return logseq.settings?.[KEY_LAST_SYNC] as string | undefined
}

export async function setLastSync(value: string): Promise<void> {
  await logseq.updateSettings({ [KEY_LAST_SYNC]: value })
}
