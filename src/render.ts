import { IBatchBlock } from '@logseq/libs/dist/LSPlugin'
import Mustache from 'mustache'
import formatDate from 'date-fns/format'
import { KoreaderHighlight, KoreaderSidecar } from './sidecar'

export const DEFAULT_BOOK_HEADER_TEMPLATE = `title:: {{title}}
{{#authors}}authors:: {{authors}}{{/authors}}
{{#language}}language:: {{language}}{{/language}}
koreader-id:: {{koreaderId}}
{{#description}}description:: {{description}}{{/description}}`

export const DEFAULT_HIGHLIGHTS_HEADING_TEMPLATE = `## Highlights — {{kind}} {{date}}`

/**
 * Highlight block template. The blockquote line is the visible text;
 * the property lines below it become Logseq block properties.
 * `journalDay` is rendered as a [[page-link]] inside the datetime property
 * so Logseq's native backlinks panel surfaces this highlight on the journal
 * page for the day it was made — no extra plugin code needed.
 */
export const DEFAULT_HIGHLIGHT_BLOCK_TEMPLATE = `> {{text}}
{{#page}}page:: {{page}}{{/page}}
{{#chapter}}chapter:: {{chapter}}{{/chapter}}
{{#datetime}}datetime:: [[{{journalDay}}]] {{timeOfDay}}{{/datetime}}
{{#datetimeUpdated}}datetime-updated:: [[{{journalDayUpdated}}]] {{timeOfDayUpdated}}{{/datetimeUpdated}}
koreader-highlight-id:: {{id}}`

const PAGE_BOOKMARK_PLACEHOLDER = 'Page bookmark'

export interface Templates {
  bookHeader: string
  highlightsHeading: string
  highlightBlock: string
}

export const DEFAULT_TEMPLATES: Templates = {
  bookHeader: DEFAULT_BOOK_HEADER_TEMPLATE,
  highlightsHeading: DEFAULT_HIGHLIGHTS_HEADING_TEMPLATE,
  highlightBlock: DEFAULT_HIGHLIGHT_BLOCK_TEMPLATE,
}

export interface RenderContext {
  /** User's Logseq preferredDateFormat, e.g. "MMM do, yyyy". */
  preferredDateFormat: string
  templates: Templates
}

/** Parse "YYYY-MM-DD HH:MM:SS" as local time. Returns null if unparseable. */
export function parseKoreaderDatetime(s: string | undefined): Date | null {
  if (!s) return null
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/)
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
}

function safeFormat(date: Date | null, fmt: string): string {
  if (!date) return ''
  try {
    return formatDate(date, fmt)
  } catch {
    return ''
  }
}

function timeOfDay(s: string | undefined): string {
  const m = s?.match(/(\d{2}:\d{2}:\d{2})/)
  return m ? m[1] : ''
}

/** Render a single highlight as one or more IBatchBlocks (block + optional note child). */
export function renderHighlight(h: KoreaderHighlight, ctx: RenderContext): IBatchBlock {
  const created = parseKoreaderDatetime(h.datetime)
  const updated = parseKoreaderDatetime(h.datetimeUpdated)

  const view = {
    text: escapeHighlightText(h.text || PAGE_BOOKMARK_PLACEHOLDER),
    page: sanitisePropertyValue(h.page),
    chapter: sanitisePropertyValue(h.chapter),
    datetime: sanitisePropertyValue(h.datetime),
    journalDay: safeFormat(created, ctx.preferredDateFormat),
    timeOfDay: timeOfDay(h.datetime),
    datetimeUpdated: sanitisePropertyValue(h.datetimeUpdated),
    journalDayUpdated: safeFormat(updated, ctx.preferredDateFormat),
    timeOfDayUpdated: timeOfDay(h.datetimeUpdated),
    id: sanitisePropertyValue(h.id) ?? '',
  }

  const content = renderTemplate(ctx.templates.highlightBlock, view)
  const block: IBatchBlock = { content }
  if (h.note) {
    block.children = [{ content: h.note }]
  }
  return block
}

/** Render the per-book "header" content (title block of the page). */
export function renderBookHeader(sidecar: KoreaderSidecar, ctx: RenderContext): string {
  return renderTemplate(ctx.templates.bookHeader, {
    title: sanitisePropertyValue(sidecar.title) ?? '',
    authors: sanitisePropertyValue(sidecar.authors) ?? '',
    language: sanitisePropertyValue(sidecar.language) ?? '',
    koreaderId: sanitisePropertyValue(sidecar.partialMd5 ?? sidecar.docPath) ?? '',
    description: sanitisePropertyValue(sidecar.description) ?? '',
  })
}

export interface BookPageBlocks {
  /** First block on the page: the metadata header. */
  header: IBatchBlock
  /** Second block on the page: a "## Highlights — initial sync ..." heading wrapping the highlights. */
  highlightsSection: IBatchBlock
}

export function renderInitialBookPage(
  sidecar: KoreaderSidecar,
  highlights: KoreaderHighlight[],
  ctx: RenderContext,
  syncDate: Date,
): BookPageBlocks {
  const heading = renderTemplate(ctx.templates.highlightsHeading, {
    kind: 'initial sync',
    date: safeFormat(syncDate, ctx.preferredDateFormat),
  })
  const children = highlights.map((h) => renderHighlight(h, ctx))
  return {
    header: { content: renderBookHeader(sidecar, ctx) },
    highlightsSection: { content: heading, children },
  }
}

export function renderUpdateSection(
  highlights: KoreaderHighlight[],
  ctx: RenderContext,
  syncDate: Date,
): IBatchBlock {
  const heading = renderTemplate(ctx.templates.highlightsHeading, {
    kind: 'sync',
    date: safeFormat(syncDate, ctx.preferredDateFormat),
  })
  return {
    content: heading,
    children: highlights.map((h) => renderHighlight(h, ctx)),
  }
}

export interface IndexReceiptInput {
  syncDate: Date
  preferredDateFormat: string
  newBooks: { pageName: string }[]
  /** existing books that received new highlights this run */
  updatedBooks: { pageName: string; addedCount: number }[]
}

/** Build the sync receipt that goes onto the index page. */
export function renderIndexReceipt(input: IndexReceiptInput): IBatchBlock {
  const dateStr = safeFormat(input.syncDate, input.preferredDateFormat)
  const timeStr = formatDate(input.syncDate, 'HH:mm')
  const children: IBatchBlock[] = []

  if (input.newBooks.length > 0) {
    children.push({
      content: `${input.newBooks.length} new book${input.newBooks.length === 1 ? '' : 's'}`,
      children: input.newBooks.map((b) => ({ content: pageLink(b.pageName) })),
    })
  }

  const totalNewHighlights = input.updatedBooks.reduce((acc, b) => acc + b.addedCount, 0)
  if (totalNewHighlights > 0) {
    children.push({
      content: `${totalNewHighlights} new highlight${totalNewHighlights === 1 ? '' : 's'} across ${input.updatedBooks.length} existing book${input.updatedBooks.length === 1 ? '' : 's'}`,
      children: input.updatedBooks.map((b) => ({
        content: `${pageLink(b.pageName)} (${b.addedCount})`,
      })),
    })
  }

  if (children.length === 0) {
    children.push({ content: 'No changes.' })
  }

  return {
    content: `# 📚 Sync ${dateStr} ${timeStr}`,
    children,
  }
}

/**
 * Escape characters that break Logseq's block-level rendering.
 * - leading dashes turn into list items
 * - the highlight text itself goes on its own first line, but property
 *   lines below it must not get appended to the blockquote, so collapse
 *   internal newlines to spaces.
 */
function escapeHighlightText(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/^-/gm, '\\-')
    .trim()
}

/**
 * Make a value safe to use as a Logseq block property value. Empty or
 * unrenderable values become undefined so the surrounding Mustache
 * `{{#var}}…{{/var}}` section drops out entirely.
 */
function sanitisePropertyValue(value: any): string | undefined {
  if (value === undefined || value === null) return undefined
  let s = String(value)
  // Strip newlines (multi-line property values confuse Logseq's parser),
  // collapse property-syntax sequences ("key:: value" inside the value),
  // and trim outer whitespace.
  s = s.replace(/\r?\n/g, ' ').replace(/::/g, ':').trim()
  return s.length > 0 ? s : undefined
}

function renderTemplate(template: string, view: Record<string, any>): string {
  // Disable HTML escaping; Logseq blocks want raw markdown.
  const out = Mustache.render(template, view, undefined, { escape: (v: string) => v })
  return collapseEmptyLines(out)
}

/**
 * Drop blank lines and any property line whose value rendered empty
 * (e.g. `koreader-id:: ` with no value). Empty-value property lines
 * confuse Logseq's property indexer and have caused page-load crashes.
 */
function collapseEmptyLines(s: string): string {
  return s
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (trimmed === '') return false
      const propMatch = trimmed.match(/^[a-z][a-z0-9-]*::\s*(.*)$/i)
      if (propMatch && propMatch[1].trim() === '') return false
      return true
    })
    .join('\n')
    .trim()
}

export function pageLink(pageName: string): string {
  return `[[${pageName}]]`
}

/** Disambiguate a book title against an already-taken page name. */
export function resolvePageName(title: string, authors: string | undefined, taken: (name: string) => boolean): string {
  if (!taken(title)) return title
  if (authors) {
    const withAuthor = `${title} — ${authors}`
    if (!taken(withAuthor)) return withAuthor
  }
  let i = 2
  while (taken(`${title} (${i})`)) i++
  return `${title} (${i})`
}
