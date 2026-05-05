import '@logseq/libs'
import { BlockEntity, IBatchBlock } from '@logseq/libs/dist/LSPlugin'
import {
  KoreaderHighlight,
  KoreaderSidecar,
  parseSidecar,
  sidecarKey,
  walkSidecars,
} from './sidecar'
import {
  DEFAULT_TEMPLATES,
  RenderContext,
  Templates,
  bookPageProperties,
  parseKoreaderDatetime,
  renderHighlight,
  renderHighlightsSection,
  renderIndexReceipt,
  renderUpdateSection,
  resolvePageName,
} from './render'
import {
  BookIdEntry,
  clearBookIds,
  clearHighlightIds,
  clearLastHighlightDatetimes,
  getBookIdsMap,
  getHighlightIdsMap,
  getLastHighlightDatetimeMap,
  recordHighlightIds,
  setBookId,
  setLastHighlightDatetime,
  setLastSync,
} from './storage'

export const INDEX_PAGE_NAME = 'KOReader'

export type ProgressFn = (msg: string) => void

export interface SyncResult {
  newBooks: { pageName: string }[]
  updatedBooks: { pageName: string; addedCount: number }[]
  skippedStubs: number
  errors: string[]
}

export interface SyncOptions {
  directoryHandle: any
  preferredDateFormat: string
  templates: Templates
  onProgress?: ProgressFn
}

export async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const ctx: RenderContext = {
    preferredDateFormat: opts.preferredDateFormat,
    templates: opts.templates ?? DEFAULT_TEMPLATES,
  }
  const result: SyncResult = { newBooks: [], updatedBooks: [], skippedStubs: 0, errors: [] }
  const syncDate = new Date()
  const progress = opts.onProgress ?? (() => {})

  console.log('sync-koreader-highlights: walking root directory:', opts.directoryHandle?.name)
  progress(`Walking sidecars in "${opts.directoryHandle?.name ?? '?'}"…`)
  const sidecars: KoreaderSidecar[] = []
  let walked = 0
  for await (const fileHandle of walkSidecars(opts.directoryHandle)) {
    walked++
    console.log('sync-koreader-highlights: walked sidecar', walked, fileHandle.name)
    if (walked % 5 === 0) progress(`Walking sidecars… (${walked})`)
    let file: File
    try {
      file = await fileHandle.getFile()
    } catch (e) {
      result.errors.push(`getFile failed: ${e}`)
      continue
    }
    const text = await file.text()
    const parsed = parseSidecar(text)
    if (!parsed) {
      result.skippedStubs++
      continue
    }
    if (parsed.highlights.length === 0) {
      // No highlights/notes/bookmarks → don't author a Logseq page for it.
      // The user explicitly doesn't want empty books cluttering the graph.
      result.skippedStubs++
      continue
    }
    sidecars.push(parsed)
  }
  progress(`Found ${sidecars.length} books with highlights, ${result.skippedStubs} stubs/empty skipped.`)

  const bookIds = getBookIdsMap()
  const lastHighlights = getLastHighlightDatetimeMap()
  const highlightIds = getHighlightIdsMap()

  // Build a "taken" predicate that includes pages this run is about to create.
  const takenInThisRun = new Set<string>()
  const allKnownPageNames = new Set(Object.values(bookIds).map((e) => e.title))
  const isTaken = (name: string) => takenInThisRun.has(name) || allKnownPageNames.has(name)

  console.log('sync-koreader-highlights: parsed sidecars:', sidecars.length, 'stubs skipped:', result.skippedStubs)
  console.log('sync-koreader-highlights: bookIdsMap entries:', Object.keys(bookIds).length, 'highlightIdsMap entries:', Object.keys(highlightIds).length)
  for (let i = 0; i < sidecars.length; i++) {
    const sidecar = sidecars[i]
    const key = sidecarKey(sidecar)
    progress(`(${i + 1}/${sidecars.length}) ${sidecar.title}`)
    console.log('sync-koreader-highlights: processing', i + 1, 'title=', sidecar.title, 'highlights=', sidecar.highlights.length, 'key=', key)

    const existing = bookIds[key]
    try {
      if (!existing) {
        const pageName = resolvePageName(sidecar.title, sidecar.authors, isTaken)
        takenInThisRun.add(pageName)
        console.log('sync-koreader-highlights: creating page', pageName)
        const created = await createBookPage(pageName, sidecar, ctx, syncDate)
        if (created) {
          console.log('sync-koreader-highlights: created OK, uuid=', created.pageUuid)
          await setBookId(key, { pageUuid: created.pageUuid, title: pageName })
          await recordHighlightIds(key, sidecar.highlights.map((h) => h.id))
          const maxDt = maxDatetime(sidecar.highlights)
          if (maxDt) await setLastHighlightDatetime(key, maxDt)
          result.newBooks.push({ pageName })
        } else {
          console.warn('sync-koreader-highlights: createBookPage returned null for', pageName)
          result.errors.push(`createBookPage returned null: ${pageName}`)
        }
      } else {
        const known = highlightIds[key] ?? {}
        const newHighlights = sidecar.highlights.filter((h) => !known[h.id])
        console.log('sync-koreader-highlights: existing book', existing.title, 'pageUuid=', existing.pageUuid, 'newHighlights=', newHighlights.length)
        if (newHighlights.length === 0) continue

        const appended = await appendHighlights(existing, sidecar, newHighlights, ctx, syncDate)
        console.log('sync-koreader-highlights: appendHighlights →', appended)
        if (appended) {
          await recordHighlightIds(key, newHighlights.map((h) => h.id))
          const maxDt = maxDatetime(newHighlights)
          if (maxDt) await setLastHighlightDatetime(key, maxDt)
          result.updatedBooks.push({ pageName: existing.title, addedCount: newHighlights.length })
        } else {
          result.errors.push(`appendHighlights failed: ${existing.title}`)
        }
      }
    } catch (e) {
      result.errors.push(`${sidecar.title}: ${e}`)
      console.error('sync-koreader-highlights:', sidecar.title, e)
    }
  }

  // Drop a sync receipt onto the index page.
  await writeIndexReceipt(syncDate, opts.preferredDateFormat, result)
  await setLastSync(syncDate.toISOString())
  progress(`Done — ${result.newBooks.length} new, ${result.updatedBooks.length} updated.`)
  return result
}

async function createBookPage(
  pageName: string,
  sidecar: KoreaderSidecar,
  ctx: RenderContext,
  syncDate: Date,
): Promise<{ pageUuid: string } | null> {
  const pageProps = bookPageProperties(sidecar)
  let page: any
  try {
    // Page-level properties: Logseq stores these as the page's own metadata
    // and handles all escaping internally. Avoids the indexer-crash class
    // we'd hit if we authored a "title:: …" header block ourselves.
    page = await logseq.Editor.createPage(pageName, pageProps, { createFirstBlock: false, redirect: false })
  } catch (e) {
    console.error('sync-koreader-highlights: createPage threw for', pageName, e)
    return null
  }
  if (!page) {
    page = await logseq.Editor.getPage(pageName)
    if (!page) {
      console.error('sync-koreader-highlights: createPage and getPage both null for', pageName)
      return null
    }
    console.log('sync-koreader-highlights: page already existed, will append:', pageName)
    // Re-apply page properties in case the page exists but lacks them.
    for (const [k, v] of Object.entries(pageProps)) {
      try { await logseq.Editor.upsertBlockProperty(page.uuid, k, v) } catch {}
    }
  }

  if (sidecar.highlights.length === 0) {
    // No content blocks needed for an empty book; the page-level properties
    // are enough. Avoids creating an empty "## Highlights" heading that
    // could confuse the indexer.
    return { pageUuid: (page as any).uuid }
  }

  const section = renderHighlightsSection(sidecar.highlights, ctx, syncDate, 'initial sync')
  // Insert the heading first as a top-level page block, then hang highlights
  // beneath it via a single batched call (insertBatchBlock with the heading's
  // uuid would require a re-fetch round trip).
  const heading = await logseq.Editor.appendBlockInPage(pageName, section.content)
  if (heading && section.children && section.children.length > 0) {
    await logseq.Editor.insertBatchBlock(heading.uuid, section.children, { sibling: false })
  }
  return { pageUuid: (page as any).uuid }
}

async function appendHighlights(
  existing: BookIdEntry,
  sidecar: KoreaderSidecar,
  newHighlights: KoreaderHighlight[],
  ctx: RenderContext,
  syncDate: Date,
): Promise<boolean> {
  // Try by saved UUID, then by title (graph re-index recovery). If neither
  // resolves to a page with blocks, the page was likely deleted out from
  // under us — recreate it from scratch instead of dropping the highlights.
  let pageBlocks = await safePageBlocks(existing.pageUuid)
  const pageName = existing.title
  if (!pageBlocks || pageBlocks.length === 0) {
    pageBlocks = await safePageBlocks(existing.title)
  }
  if (!pageBlocks || pageBlocks.length === 0) {
    console.warn('sync-koreader-highlights: page disappeared, recreating:', existing.title)
    const created = await createBookPage(pageName, sidecar, ctx, syncDate)
    return created !== null
  }

  // Reuse an existing "## Highlights" block if one is present so the page
  // never grows duplicate headings on incremental syncs. Otherwise create
  // one as a fresh top-level block.
  const heading = pageBlocks.find((b) => (b.content ?? '').trim() === '## Highlights')
  const renderedChildren = newHighlights.map((h) => renderHighlight(h, ctx))
  if (heading) {
    await logseq.Editor.insertBatchBlock(heading.uuid, renderedChildren, { sibling: false })
    return true
  }
  const section = renderUpdateSection(newHighlights, ctx, syncDate)
  const last = pageBlocks[pageBlocks.length - 1]
  await logseq.Editor.insertBatchBlock(last.uuid, [section], { sibling: true })
  return true
}

async function safePageBlocks(idOrName: string): Promise<BlockEntity[] | null> {
  try {
    const tree = await logseq.Editor.getPageBlocksTree(idOrName)
    if (!tree) return null
    return tree
  } catch {
    return null
  }
}

async function writeIndexReceipt(syncDate: Date, fmt: string, result: SyncResult): Promise<void> {
  const indexPage = await logseq.Editor.getPage(INDEX_PAGE_NAME)
  if (!indexPage) {
    await logseq.Editor.createPage(
      INDEX_PAGE_NAME,
      {},
      { createFirstBlock: false, redirect: false },
    )
  }
  const receipt = renderIndexReceipt({
    syncDate,
    preferredDateFormat: fmt,
    newBooks: result.newBooks,
    updatedBooks: result.updatedBooks,
  })
  // appendBlockInPage doesn't accept children, so insertBatchBlock under a freshly-appended root.
  const inserted = await logseq.Editor.appendBlockInPage(INDEX_PAGE_NAME, receipt.content)
  if (inserted && receipt.children) {
    await logseq.Editor.insertBatchBlock(inserted.uuid, receipt.children, { sibling: false })
  }
}

function maxDatetime(highlights: KoreaderHighlight[]): string | undefined {
  let best: { iso: string; raw: string } | null = null
  for (const h of highlights) {
    const dt = parseKoreaderDatetime(h.datetime)
    if (!dt) continue
    const iso = dt.toISOString()
    if (!best || iso > best.iso) best = { iso, raw: h.datetime! }
  }
  return best?.raw
}

export async function resetSyncState(): Promise<void> {
  await clearBookIds()
  await clearLastHighlightDatetimes()
  await clearHighlightIds()
}
