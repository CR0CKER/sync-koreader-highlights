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
  isIndexReceiptHeading,
  parseKoreaderDatetime,
  renderBookHeaderProperties,
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
  replaceHighlightIds,
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
        const pageName = resolvePageName(sidecar.title, sidecar.authors?.join(', '), isTaken)
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
        const currentIds = new Set(sidecar.highlights.map((h) => h.id))
        const newCount = sidecar.highlights.filter((h) => !known[h.id]).length
        const removedCount = Object.keys(known).filter((id) => !currentIds.has(id)).length
        console.log('sync-koreader-highlights: existing book', existing.title, 'new=', newCount, 'removed=', removedCount)
        if (newCount === 0 && removedCount === 0) continue

        const replaced = await rebuildHighlightsSection(existing, sidecar, ctx, syncDate)
        console.log('sync-koreader-highlights: rebuildHighlightsSection →', replaced)
        if (replaced) {
          // Replace the recorded id set (not append) so that highlights deleted
          // on the device drop out of the dedup map too.
          await replaceHighlightIds(key, sidecar.highlights.map((h) => h.id))
          const maxDt = maxDatetime(sidecar.highlights)
          if (maxDt) await setLastHighlightDatetime(key, maxDt)
          result.updatedBooks.push({ pageName: existing.title, addedCount: newCount })
        } else {
          result.errors.push(`rebuildHighlightsSection failed: ${existing.title}`)
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
  const pageProps = renderBookHeaderProperties(sidecar, ctx)

  const existingPage = await logseq.Editor.getPage(pageName)
  let page: any = existingPage
  if (!page) {
    try {
      page = await logseq.Editor.createPage(pageName, pageProps, {
        createFirstBlock: false,
        redirect: false,
      })
    } catch (e) {
      console.error('sync-koreader-highlights: createPage threw for', pageName, e)
      return null
    }
  } else {
    // Page already exists (user-authored, or from a prior plugin run,
    // or written by another plugin such as logseq-reading-list). Don't
    // overwrite anything: only set page properties that aren't already
    // present anywhere on the page.
    //
    // `getBlockProperty(page.uuid, k)` only checks page-level
    // properties (the pre-block). Other plugins may store properties on
    // a *content* block instead — for example, logseq-reading-list
    // puts author/full-title/category/summary/tags on a dedicated
    // properties block so the cover image can sit above them. Without
    // also scanning child blocks we'd write a second page-level copy
    // and end up with duplicate `author::` etc.
    const tree = (await logseq.Editor.getPageBlocksTree(pageName)) || []
    const blockLevelKeys = new Set<string>()
    const collect = (b: any) => {
      const props = b?.properties
      if (props && typeof props === 'object') {
        for (const k of Object.keys(props)) blockLevelKeys.add(k)
      }
      if (Array.isArray(b?.children)) for (const c of b.children) collect(c)
    }
    for (const b of tree) collect(b)

    for (const [k, v] of Object.entries(pageProps)) {
      if (blockLevelKeys.has(k)) continue
      try {
        const existingValue = await logseq.Editor.getBlockProperty(page.uuid, k)
        if (existingValue === null || existingValue === undefined || existingValue === '') {
          await logseq.Editor.upsertBlockProperty(page.uuid, k, v)
        }
      } catch (e) {
        console.warn('sync-koreader-highlights: property merge failed for', pageName, k, e)
      }
    }
    console.log('sync-koreader-highlights: existing page preserved, appending sync content:', pageName)
  }
  if (!page) return null

  if (sidecar.highlights.length === 0) {
    return { pageUuid: (page as any).uuid }
  }

  const section = renderHighlightsSection(sidecar.highlights, ctx, syncDate, 'initial sync')
  // Append the highlights heading at the bottom of whatever's on the page.
  // For brand-new pages this is the first content block; for existing
  // pages it lands beneath the user's prior content, which is what the
  // user explicitly asked for.
  const heading = await logseq.Editor.appendBlockInPage(pageName, section.content)
  if (heading && section.children && section.children.length > 0) {
    await logseq.Editor.insertBatchBlock(heading.uuid, section.children, { sibling: false })
  }
  return { pageUuid: (page as any).uuid }
}

/**
 * Replace the existing "## Highlights synced from …" block (and all its
 * children) with a fresh one containing every highlight currently in the
 * sidecar. The dated heading is rewritten to match the current sync time.
 *
 * This is destructive: any user edits to highlight blocks under the
 * heading get blown away on the next sync. The user has explicitly
 * opted into this behaviour as the simplest way to keep the page in
 * lockstep with KOReader (and to remove highlights deleted on the
 * device, which the append-only model couldn't do).
 */
async function rebuildHighlightsSection(
  existing: BookIdEntry,
  sidecar: KoreaderSidecar,
  ctx: RenderContext,
  syncDate: Date,
): Promise<boolean> {
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

  // Drop every existing "## Highlights synced from …" subtree. There
  // should normally be only one, but tolerate stale duplicates from a
  // previous build that wrote per-sync siblings.
  for (const block of pageBlocks) {
    if (isHighlightsHeading(block.content)) {
      try { await logseq.Editor.removeBlock(block.uuid) } catch (e) {
        console.warn('sync-koreader-highlights: removeBlock failed for', block.uuid, e)
      }
    }
  }

  if (sidecar.highlights.length === 0) return true

  const refreshed = await safePageBlocks(existing.pageUuid) ?? await safePageBlocks(existing.title)
  if (!refreshed || refreshed.length === 0) {
    // Page now has no blocks — append directly to the page.
    const section = renderUpdateSection(sidecar.highlights, ctx, syncDate)
    const heading = await logseq.Editor.appendBlockInPage(pageName, section.content)
    if (heading && section.children) {
      await logseq.Editor.insertBatchBlock(heading.uuid, section.children, { sibling: false })
    }
    return true
  }
  const section = renderUpdateSection(sidecar.highlights, ctx, syncDate)
  const last = refreshed[refreshed.length - 1]
  await logseq.Editor.insertBatchBlock(last.uuid, [section], { sibling: true })
  return true
}

function isHighlightsHeading(content: string | undefined): boolean {
  // Tolerate the leading `##` prefix from earlier builds so re-syncs of
  // pages created before this change still find and replace their old
  // heading.
  return !!content && /^(?:#+\s+)?Highlights synced from\b/.test(content.trim())
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

  // Drop every prior receipt heading so the page only ever shows the
  // latest sync. Tolerates both the old "## 📚 Sync …" and the current
  // "## 📚 Synced on …" shapes. User-authored content on the page is
  // left untouched.
  const tree = await safePageBlocks(INDEX_PAGE_NAME)
  if (tree) {
    for (const block of tree) {
      if (isIndexReceiptHeading(block.content)) {
        try { await logseq.Editor.removeBlock(block.uuid) } catch (e) {
          console.warn('sync-koreader-highlights: index receipt removeBlock failed', block.uuid, e)
        }
      }
    }
  }

  const receipt = renderIndexReceipt({
    syncDate,
    preferredDateFormat: fmt,
    newBooks: result.newBooks,
    updatedBooks: result.updatedBooks,
  })
  // Prepend the receipt at the top of the page so it sits above any
  // user-authored content. prependBlockInPage doesn't take children,
  // so we insert children under the returned UUID afterwards.
  const inserted = await logseq.Editor.prependBlockInPage(INDEX_PAGE_NAME, receipt.content)
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
