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
{{#datetimeUpdated}}datetime-updated:: [[{{journalDayUpdated}}]] {{timeOfDayUpdated}}{{/datetimeUpdated}}`

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

/** Render a single highlight as an IBatchBlock with structured properties. */
export function renderHighlight(h: KoreaderHighlight, ctx: RenderContext): IBatchBlock {
  const created = parseKoreaderDatetime(h.datetime)
  const updated = parseKoreaderDatetime(h.datetimeUpdated)
  const text = escapeHighlightText(decodeHtmlEntities(h.text || PAGE_BOOKMARK_PLACEHOLDER))
  // Property order matters in Logseq's structured-properties API — JS
  // object insertion order is what the renderer uses. Order requested by
  // the user: date, chapter, page (most-relevant first).
  const properties: Record<string, string> = {}
  if (created) {
    const day = safeFormat(created, ctx.preferredDateFormat)
    if (day) properties.date = `[[${day}]]`
  }
  if (updated) {
    const day = safeFormat(updated, ctx.preferredDateFormat)
    if (day) properties['date-updated'] = `[[${day}]]`
  }
  const chapter = sanitisePropertyValue(h.chapter)
  if (chapter) properties.chapter = chapter
  const page = sanitisePropertyValue(h.page)
  if (page) properties.page = page

  const block: IBatchBlock = { content: `> ${text}`, properties }
  if (h.note) {
    block.children = [{ content: h.note }]
  }
  return block
}

/** Compute the page-level properties for a book page. */
export function bookPageProperties(sidecar: KoreaderSidecar): Record<string, string> {
  const out: Record<string, string> = {}
  const title = sanitisePropertyValue(sidecar.title)
  if (title) out['full-title'] = title
  const authorsLink = renderAuthorsAsWikilinks(sidecar.authors)
  if (authorsLink) out.author = authorsLink
  const summary = sanitisePropertyValue(sidecar.description)
  if (summary) out.summary = summary
  // koreader-id intentionally omitted from page properties — it's
  // human-irrelevant. The plugin's bookIdsMap holds the same identifier
  // internally, so re-syncs still dedup correctly.
  return out
}

/**
 * Render each author as a separate Logseq wikilink so clicking any one
 * opens that author's page (and Logseq's backlink panel collates every
 * book by that author). Multiple authors join with ", " between links.
 * `[`/`]` inside an author name would break the wikilink delimiters and
 * are replaced with `(`/`)` — same pattern as page-name sanitisation.
 */
function renderAuthorsAsWikilinks(authors: string[] | undefined): string | undefined {
  if (!authors || authors.length === 0) return undefined
  const links = authors
    .map((a) => sanitisePropertyValue(a))
    .filter((a): a is string => !!a)
    .map((a) => `[[${a.replace(/\[/g, '(').replace(/\]/g, ')')}]]`)
  return links.length > 0 ? links.join(', ') : undefined
}

export function renderHighlightsHeading(_kind: 'initial sync' | 'sync', ctx: RenderContext, date: Date): string {
  const day = safeFormat(date, ctx.preferredDateFormat)
  return `Highlights synced from [[KOReader]] on [[${day}]]`
}

export function renderHighlightsSection(
  highlights: KoreaderHighlight[],
  ctx: RenderContext,
  syncDate: Date,
  kind: 'initial sync' | 'sync',
): IBatchBlock {
  return {
    content: renderHighlightsHeading(kind, ctx, syncDate),
    children: highlights.map((h) => renderHighlight(h, ctx)),
  }
}

export function renderUpdateSection(
  highlights: KoreaderHighlight[],
  ctx: RenderContext,
  syncDate: Date,
): IBatchBlock {
  return renderHighlightsSection(highlights, ctx, syncDate, 'sync')
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
    content: `## 📚 Synced on ${dateStr} at ${timeStr}`,
    children,
  }
}

/**
 * Match any of the receipt-heading shapes we have ever written to the
 * index page. Used by the index-page rebuilder to drop the previous
 * entry before writing a fresh one.
 */
export function isIndexReceiptHeading(content: string | undefined): boolean {
  return !!content && /^##\s+📚\s+(?:Sync\b|Synced on\b)/.test(content.trim())
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
 *
 * Calibre-sourced descriptions are HTML; KOReader stores them verbatim.
 * Decode common entities, strip tags, and collapse whitespace so they
 * read as plain text inside Logseq.
 */
function sanitisePropertyValue(value: any): string | undefined {
  if (value === undefined || value === null) return undefined
  let s = String(value)
  s = decodeHtmlEntities(s)
  s = stripHtmlTags(s)
  // Strip newlines (multi-line property values confuse Logseq's parser),
  // collapse property-syntax sequences ("key:: value" inside the value),
  // and trim outer whitespace.
  s = s.replace(/\r?\n+/g, ' ').replace(/::/g, ':').replace(/\s+/g, ' ').trim()
  return s.length > 0 ? s : undefined
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  ndash: '–', mdash: '—', hellip: '…',
  auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  eacute: 'é', egrave: 'è', aacute: 'á', iacute: 'í',
  oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç',
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => HTML_ENTITIES[name] ?? m)
}

function stripHtmlTags(s: string): string {
  // Remove tags but preserve common block-level breaks as spaces so words
  // don't collide ("...behavior.<br>Leidy..." → "...behavior. Leidy...").
  return s
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
}

function renderTemplate(template: string, view: Record<string, any>): string {
  // Disable HTML escaping; Logseq blocks want raw markdown.
  const out = Mustache.render(template, view, undefined, { escape: (v: string) => v })
  return collapseEmptyLines(out)
}

/**
 * Drop empty property lines (e.g. `koreader-id:: ` with no value, which
 * confuse Logseq's property indexer) and collapse runs of consecutive
 * blank lines down to one. A single blank line is preserved — Logseq
 * requires a blank line between block content and its properties for
 * the property syntax to be recognised.
 */
function collapseEmptyLines(s: string): string {
  const lines = s.split('\n').filter((line) => {
    const trimmed = line.trim()
    if (trimmed === '') return true // keep blanks for the next pass
    const propMatch = trimmed.match(/^[a-z][a-z0-9-]*::\s*(.*)$/i)
    if (propMatch && propMatch[1].trim() === '') return false
    return true
  })
  const out: string[] = []
  for (const line of lines) {
    if (line.trim() === '' && (out.length === 0 || out[out.length - 1].trim() === '')) continue
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out.join('\n')
}

export function pageLink(pageName: string): string {
  return `[[${pageName}]]`
}

const MAX_PROPERTY_LENGTH = 500

export function truncate(s: string | undefined, max = MAX_PROPERTY_LENGTH): string | undefined {
  if (!s) return s
  return s.length > max ? s.slice(0, max).trimEnd() + '…' : s
}

/**
 * Replace characters in a book title that would break Logseq syntax when
 * the name is referenced via [[wikilink]]. Square brackets in particular
 * collide with the wikilink delimiters: `[[The Economist [May 2nd 2026]]]`
 * is parsed as `[[The Economist [May 2nd 2026]]` + `]`.
 */
export function sanitisePageName(title: string): string {
  return title
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Disambiguate a book title against an already-taken page name. */
export function resolvePageName(title: string, authors: string | undefined, taken: (name: string) => boolean): string {
  const base = sanitisePageName(title)
  if (!taken(base)) return base
  if (authors) {
    const withAuthor = sanitisePageName(`${title} — ${authors}`)
    if (!taken(withAuthor)) return withAuthor
  }
  let i = 2
  while (taken(`${base} (${i})`)) i++
  return `${base} (${i})`
}
