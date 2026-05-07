import { parse as luaparse } from 'luaparse'

export interface KoreaderHighlight {
  /** Highlight text. May be empty for page bookmarks. */
  text: string
  /** Personal note attached to the highlight, if any. */
  note?: string
  page?: number | string
  chapter?: string
  /** ISO-ish KOReader datetime: "YYYY-MM-DD HH:MM:SS" (local time on device). */
  datetime?: string
  /** When KOReader has edited the highlight after creation. */
  datetimeUpdated?: string
  /** Stable-ish per-highlight key derived from KOReader fields, used for dedup. */
  id: string
}

export interface KoreaderSidecar {
  title: string
  /** Each entry is one author. KOReader separates authors with "\n" in the
   *  raw Lua string; individual author names may themselves contain commas
   *  ("Last, First"), so callers must not naively split on commas. */
  authors?: string[]
  language?: string
  description?: string
  /** Tag-like values from the source file (EPUB <dc:subject> or PDF
   *  Keywords). Each entry is one tag. KOReader/Calibre separate them
   *  with `;` or `,` in the raw doc_props string. */
  keywords?: string[]
  /** Series name (e.g. "Foundation Trilogy") if the source file
   *  carried <calibre:series> or equivalent. */
  series?: string
  /**
   * KOReader's content-derived fingerprint. Stable across file moves and Calibre id changes.
   * Falls back to docPath when absent on legacy sidecars.
   */
  partialMd5?: string
  /** Absolute path KOReader thinks the document lives at. */
  docPath?: string
  highlights: KoreaderHighlight[]
}

/** Walk a FileSystemDirectoryHandle yielding `metadata.*.lua` file handles. */
export async function* walkSidecars(handle: any): AsyncGenerator<any> {
  if (handle.kind === 'file') {
    if (handle.name && /metadata\..+\.lua$/i.test(handle.name)) {
      yield handle
    }
    return
  }
  if (handle.kind === 'directory') {
    for await (const child of handle.values()) {
      yield* walkSidecars(child)
    }
  }
}

/**
 * Parse a Lua sidecar text into a typed object. Returns null when the sidecar
 * is a stub (e.g. opened-but-never-annotated; doc_props missing/empty).
 */
export function parseSidecar(text: string): KoreaderSidecar | null {
  let raw: any
  try {
    raw = luaToObject(text)
  } catch (e) {
    console.warn('sync-koreader-highlights: lua parse failure', e)
    return null
  }

  const docProps = raw?.doc_props
  if (!docProps || typeof docProps !== 'object' || Object.keys(docProps).length === 0) {
    return null
  }

  const title: string = String(docProps.title ?? '').trim()
  if (!title) return null

  const authors = normaliseAuthors(docProps.authors)
  const highlights = extractHighlights(raw)

  return {
    title,
    authors,
    language: stringOrUndefined(docProps.language),
    description: stringOrUndefined(docProps.description),
    keywords: normaliseTags(docProps.keywords ?? docProps.subject),
    series: stringOrUndefined(docProps.series),
    partialMd5: stringOrUndefined(raw.partial_md5_checksum),
    docPath: stringOrUndefined(raw.doc_path),
    highlights,
  }
}

function normaliseTags(value: any): string[] | undefined {
  if (typeof value !== 'string') return undefined
  // KOReader stores multiple tags the same way it stores multiple
  // authors: separated by newlines. The raw Lua source uses the
  // `\<LF>` line-continuation form, which luaparse may decode either
  // as a bare newline or leave intact as a backslash-then-newline.
  // The split below consumes an optional leading backslash so the
  // tag itself doesn't end with a stray `\`. EPUB/PDF metadata also
  // uses `;` or `,` as separators.
  const parts = value
    .split(/\\?[;,\r\n]+/)
    .map((s) => s.trim().replace(/\\$/, ''))
    .filter((s) => s.length > 0)
  return parts.length > 0 ? parts : undefined
}

function normaliseAuthors(value: any): string[] | undefined {
  if (typeof value !== 'string') return undefined
  const parts = value
    .split(/\\?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parts.length > 0 ? parts : undefined
}

function stringOrUndefined(value: any): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function extractHighlights(raw: any): KoreaderHighlight[] {
  const out: KoreaderHighlight[] = []

  // Modern KOReader: top-level `annotations` array, each with text/note/datetime/pageno/chapter/pos0/pos1.
  const annotations = raw.annotations
  if (Array.isArray(annotations)) {
    for (const a of annotations) {
      if (!a) continue
      out.push({
        text: isRibbonBookmark(a) ? '' : stringOrUndefined(a.text) ?? '',
        note: stringOrUndefined(a.note),
        page: a.pageno ?? a.page,
        chapter: stringOrUndefined(a.chapter),
        datetime: stringOrUndefined(a.datetime),
        datetimeUpdated: stringOrUndefined(a.datetime_updated),
        id: deriveHighlightId(a),
      })
    }
    return out
  }

  // Legacy: `bookmarks` array with notes/text fields.
  const bookmarks = raw.bookmarks
  if (Array.isArray(bookmarks)) {
    for (const b of bookmarks) {
      if (!b) continue
      out.push({
        text: isRibbonBookmark(b) ? '' : stringOrUndefined(b.text) ?? '',
        note: undefined,
        page: b.page,
        chapter: stringOrUndefined(b.chapter),
        datetime: stringOrUndefined(b.datetime),
        id: deriveHighlightId(b),
      })
    }
  }
  return out
}

/**
 * KOReader's ribbon page-bookmarks live alongside text highlights in
 * the `annotations` (modern) and `bookmarks` (legacy) arrays. They have
 * no `pos0`/`pos1` selection range — those are present on every text
 * highlight — and KOReader auto-fills `text` with "in <chapter>" so the
 * row renders as something in its own UI. We detect the shape via the
 * absent selection range and discard the auto-text so the renderer's
 * "empty text → page bookmark" path can produce `> Bookmarked`.
 */
function isRibbonBookmark(a: any): boolean {
  return !stringOrUndefined(a?.pos0) && !stringOrUndefined(a?.pos1)
}

function deriveHighlightId(a: any): string {
  // Compose a stable per-highlight key. KOReader doesn't ship a UUID, but
  // the (datetime, pos0, pos1) tuple is unique within a sidecar; falling back
  // to the highlight text covers older bookmark-style entries.
  const parts = [a.datetime, a.pos0, a.pos1, a.notes, a.text]
    .filter((p) => p !== undefined && p !== null && p !== '')
    .map(String)
  return parts.join('|') || crypto.randomUUID()
}

/**
 * Convert a Lua return-table source into a JS object via luaparse.
 * Handles nested tables and array-style sequences.
 */
function luaToObject(text: string): any {
  const ast = luaparse(text, {
    comments: false,
    locations: false,
    ranges: false,
    luaVersion: 'LuaJIT',
  })
  const ret = (ast.body[0] as any)?.arguments?.[0]
  if (!ret || ret.type !== 'TableConstructorExpression') {
    return {}
  }
  return readTable(ret)
}

function readTable(node: any): any {
  const fields = node.fields ?? []
  if (fields.length === 0) return {}

  // Implicit-sequence form: `{ a, b, c }` → fields are all TableValue.
  const allArrayStyle = fields.every((f: any) => f.type === 'TableValue')
  if (allArrayStyle) {
    return fields.map((f: any) => readValue(f.value))
  }

  // Read into a keyed object first, then convert to an array if the kept
  // keys are 1..N integers (KOReader writes annotations as
  // `["1"] = {…}, ["2"] = {…}`, which is a sequence semantically but
  // doesn't show up as Lua's implicit-sequence parse shape).
  const obj: Record<string, any> = {}
  for (const f of fields) {
    const key = readKey(f)
    if (key === undefined) continue
    if (key === 'stats') continue
    obj[String(key)] = readValue(f.value)
  }
  const keys = Object.keys(obj)
  if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
    const intKeys = keys.map(Number).sort((a, b) => a - b)
    if (intKeys[0] === 1 && intKeys[intKeys.length - 1] === intKeys.length) {
      return intKeys.map((i) => obj[String(i)])
    }
  }
  return obj
}

function readKey(f: any): string | number | undefined {
  if (f.type === 'TableKeyString') return f.key.name
  if (f.type === 'TableKey') {
    const k = f.key
    if (k.type === 'StringLiteral') return stripQuotes(k.raw ?? k.value)
    if (k.type === 'NumericLiteral') return k.value
  }
  return undefined
}

function readValue(v: any): any {
  if (!v) return undefined
  if (v.type === 'StringLiteral') {
    // Prefer the parsed `value` (Lua-unescaped) over the raw source. Falling
    // back to `raw` would leave \"-style escapes intact and HTML-entity-laden
    // descriptions would render those backslashes verbatim in Logseq.
    return typeof v.value === 'string' ? v.value : stripQuotes(v.raw ?? '')
  }
  if (v.type === 'NumericLiteral') return v.value
  if (v.type === 'BooleanLiteral') return v.value
  if (v.type === 'NilLiteral') return undefined
  if (v.type === 'TableConstructorExpression') return readTable(v)
  if (v.type === 'UnaryExpression' && v.operator === '-' && v.argument?.type === 'NumericLiteral') {
    return -v.argument.value
  }
  return undefined
}

function stripQuotes(raw: string): string {
  if (typeof raw !== 'string') return raw
  if (raw.length >= 2 && (raw.startsWith('"') || raw.startsWith("'")) && raw.endsWith(raw[0])) {
    return raw.slice(1, -1)
  }
  return raw
}

/** Sidecar key used for dedup in `bookIdsMap`. Stable across file moves when md5 is present. */
export function sidecarKey(sidecar: KoreaderSidecar): string {
  if (sidecar.partialMd5) return `md5:${sidecar.partialMd5}`
  return `meta:${sidecar.authors ?? ''}|||${sidecar.title}`
}
