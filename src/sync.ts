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
  parseKoreaderDatetime,
  renderIndexReceipt,
  renderInitialBookPage,
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
    sidecars.push(parsed)
  }
  progress(`Found ${sidecars.length} books, ${result.skippedStubs} stubs skipped.`)

  const bookIds = getBookIdsMap()
  const lastHighlights = getLastHighlightDatetimeMap()
  const highlightIds = getHighlightIdsMap()

  // Build a "taken" predicate that includes pages this run is about to create.
  const takenInThisRun = new Set<string>()
  const allKnownPageNames = new Set(Object.values(bookIds).map((e) => e.title))
  const isTaken = (name: string) => takenInThisRun.has(name) || allKnownPageNames.has(name)

  for (let i = 0; i < sidecars.length; i++) {
    const sidecar = sidecars[i]
    const key = sidecarKey(sidecar)
    progress(`(${i + 1}/${sidecars.length}) ${sidecar.title}`)

    const existing = bookIds[key]
    try {
      if (!existing) {
        const pageName = resolvePageName(sidecar.title, sidecar.authors, isTaken)
        takenInThisRun.add(pageName)
        const created = await createBookPage(pageName, sidecar, ctx, syncDate)
        if (created) {
          await setBookId(key, { pageUuid: created.pageUuid, title: pageName })
          await recordHighlightIds(key, sidecar.highlights.map((h) => h.id))
          const maxDt = maxDatetime(sidecar.highlights)
          if (maxDt) await setLastHighlightDatetime(key, maxDt)
          result.newBooks.push({ pageName })
        }
      } else {
        const known = highlightIds[key] ?? {}
        const newHighlights = sidecar.highlights.filter((h) => !known[h.id])
        if (newHighlights.length === 0) continue

        const appended = await appendHighlights(existing, sidecar, newHighlights, ctx, syncDate)
        if (appended) {
          await recordHighlightIds(key, newHighlights.map((h) => h.id))
          const maxDt = maxDatetime(newHighlights)
          if (maxDt) await setLastHighlightDatetime(key, maxDt)
          result.updatedBooks.push({ pageName: existing.title, addedCount: newHighlights.length })
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
  const page = await logseq.Editor.createPage(pageName, {}, { createFirstBlock: false, redirect: false })
  if (!page) return null
  const blocks = renderInitialBookPage(sidecar, sidecar.highlights, ctx, syncDate)
  await logseq.Editor.appendBlockInPage(pageName, blocks.header.content)
  await logseq.Editor.appendBlockInPage(pageName, blocks.highlightsSection.content)
  // re-fetch the heading we just appended so we can hang the highlights underneath it
  const tree = await logseq.Editor.getPageBlocksTree(pageName)
  const heading = tree[tree.length - 1]
  if (heading && blocks.highlightsSection.children) {
    await logseq.Editor.insertBatchBlock(heading.uuid, blocks.highlightsSection.children, {
      sibling: false,
    })
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
  // Try the saved page UUID first; fall back to the title (graph re-index recovery).
  let pageBlocks = await safePageBlocks(existing.pageUuid)
  let pageName = existing.title
  if (!pageBlocks || pageBlocks.length === 0) {
    pageBlocks = await safePageBlocks(existing.title)
    if (!pageBlocks) return false
    pageName = existing.title
  }
  const last = pageBlocks[pageBlocks.length - 1]
  const section = renderUpdateSection(newHighlights, ctx, syncDate)
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
