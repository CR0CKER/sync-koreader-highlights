import { IBatchBlock } from '@logseq/libs/dist/LSPlugin'
import Mustache from 'mustache'
import formatDate from 'date-fns/format'
import { KoreaderHighlight, KoreaderSidecar } from './sidecar'

/**
 * Default book-header template. The text is shown verbatim in the
 * settings panel so users can see and edit a real starting point.
 *
 * As long as the field still equals this default (or is blank), the
 * plugin renders book-page metadata via Logseq's structured-properties
 * `createPage` path — the safest option against arbitrary description
 * content (HTML entities, escape sequences, oversized values).
 *
 * Once the user changes the field, the rendered Mustache output is
 * prepended as a regular block at the top of each book page and
 * structured page-level properties are skipped to avoid duplication.
 * The user then owns the property syntax.
 */
export const DEFAULT_BOOK_HEADER_TEMPLATE = `title:: {{title}}
{{#authorsLinked}}author:: {{authorsLinked}}{{/authorsLinked}}
{{#seriesLinked}}series:: {{seriesLinked}}{{/seriesLinked}}
{{#tagsLinked}}tags:: {{tagsLinked}}{{/tagsLinked}}
{{#summary}}summary:: {{summary}}{{/summary}}`

export const DEFAULT_HIGHLIGHTS_HEADING_TEMPLATE = `Highlights synced from [[KOReader]]`

/**
 * Default highlight-block template. Reproduces the structured-properties
 * rendering as inline `key:: value` lines so what the user sees in the
 * settings panel matches what they'd get from the default. The blank
 * line between blockquote and properties is required by Logseq's
 * property parser.
 */
export const DEFAULT_HIGHLIGHT_BLOCK_TEMPLATE = `> {{text}}

{{#date}}date:: [[{{date}}]]{{/date}}
{{#dateUpdated}}date-updated:: [[{{dateUpdated}}]]{{/dateUpdated}}
{{#chapter}}chapter:: {{chapter}}{{/chapter}}
{{#page}}page:: {{page}}{{/page}}`

const PAGE_BOOKMARK_PLACEHOLDER = 'Bookmarked'

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

/**
 * Render a single highlight, note, or bookmark. KOReader keeps all
 * three in the same `annotations` table; we distinguish them by which
 * fields are populated:
 *  - `text` non-empty               → highlight (optional `note` as child)
 *  - `text` empty, `note` non-empty → standalone note (no blockquote)
 *  - both empty                     → page bookmark
 *
 * Two rendering modes:
 *  - Default highlight-block template → Logseq structured-properties
 *    path (block content is the body, properties are passed as
 *    `IBatchBlock.properties` for safe escaping).
 *  - Custom template → render the user's template fully; the output
 *    is the entire block content including any inline `key:: value`
 *    property lines.
 */
export function renderHighlight(h: KoreaderHighlight, ctx: RenderContext): IBatchBlock {
  const created = parseKoreaderDatetime(h.datetime)
  const updated = parseKoreaderDatetime(h.datetimeUpdated)
  const rawText = h.text ?? ''
  const rawNote = h.note ?? ''
  const decodedText = escapeHighlightText(decodeHtmlEntities(rawText))
  const decodedNote = decodeHtmlEntities(rawNote).trim()
  const dateLink = created ? safeFormat(created, ctx.preferredDateFormat) : ''
  const dateUpdatedLink = updated ? safeFormat(updated, ctx.preferredDateFormat) : ''
  const chapter = sanitisePropertyValue(h.chapter) ?? ''
  const page = sanitisePropertyValue(h.page) ?? ''

  // Body shape and child note depend on what KOReader stored.
  let bodyText: string
  let attachNoteChild = false
  if (decodedText) {
    // Highlight (with or without an attached note)
    bodyText = `> ${decodedText}`
    attachNoteChild = decodedNote.length > 0
  } else if (decodedNote) {
    // Standalone note: surface the note as the block body itself.
    bodyText = decodedNote
  } else {
    // Bare page bookmark.
    bodyText = `> ${PAGE_BOOKMARK_PLACEHOLDER}`
  }

  const isStandaloneNote = !decodedText && !!decodedNote

  if (templateIsDefault(ctx.templates.highlightBlock, DEFAULT_HIGHLIGHT_BLOCK_TEMPLATE)) {
    // Property order matters — JS object insertion order drives the API.
    const properties: Record<string, string> = {}
    if (dateLink) properties.date = `[[${dateLink}]]`
    // Standalone notes don't get a `date-updated` property: KOReader's
    // own datetime_updated semantics for notes are ambiguous and the
    // user finds the extra property noisy on note-only blocks.
    if (dateUpdatedLink && !isStandaloneNote) properties['date-updated'] = `[[${dateUpdatedLink}]]`
    if (chapter) properties.chapter = chapter
    if (page) properties.page = page
    const block: IBatchBlock = { content: bodyText, properties }
    if (attachNoteChild) block.children = [{ content: decodedNote }]
    return block
  }

  // Custom template path: render text + properties inline. The `text`
  // variable carries the body chosen above (with `> ` prefix for
  // highlights/bookmarks, plain for notes). dateUpdated is suppressed
  // on standalone notes so the user's template can use a {{#dateUpdated}}
  // section without ever rendering it on note-only blocks.
  const view = {
    text: bodyText.replace(/^>\s+/, ''),
    body: bodyText,
    date: dateLink,
    dateUpdated: isStandaloneNote ? '' : dateUpdatedLink,
    chapter,
    page,
    note: decodedNote,
    isNote: isStandaloneNote,
    isBookmark: !decodedText && !decodedNote,
    isHighlight: !!decodedText,
  }
  const content = renderTemplate(ctx.templates.highlightBlock, view)
  const block: IBatchBlock = { content }
  if (attachNoteChild) block.children = [{ content: decodedNote }]
  return block
}

/**
 * Render the book-page header template into a `key → value` map suitable
 * for Logseq's structured `createPage(name, properties, opts)` API.
 *
 * The template is rendered with Mustache (using the configured field, or
 * the shipped default if blank), then the rendered text is parsed
 * line-by-line back into properties. This keeps the safe-escaping path
 * regardless of whether the user has customised the template.
 *
 * Lines that don't match `key:: value` (where `key` is a Logseq-style
 * property name: starts with a letter, contains letters/digits/dashes)
 * are silently dropped — empty Mustache sections leave blank lines, and
 * users who want freeform body content should edit the page directly,
 * which existing-page protection preserves.
 */
export function renderBookHeaderProperties(sidecar: KoreaderSidecar, ctx: RenderContext): Record<string, string> {
  const tpl = ctx.templates.bookHeader?.trim() ? ctx.templates.bookHeader : DEFAULT_BOOK_HEADER_TEMPLATE
  const authors = (sidecar.authors ?? []).map((a) => sanitisePropertyValue(a)).filter((a): a is string => !!a)
  const tags = (sidecar.keywords ?? []).map((t) => sanitisePropertyValue(t)).filter((t): t is string => !!t)
  const view = {
    title: sanitisePropertyValue(sidecar.title) ?? '',
    authors: authors.join(', '),
    authorsLinked: authors
      .map((a) => `[[${sanitiseForWikilink(a)}]]`)
      .join(', '),
    language: sanitisePropertyValue(sidecar.language) ?? '',
    summary: sanitisePropertyValue(sidecar.description) ?? '',
    description: sanitisePropertyValue(sidecar.description) ?? '',
    series: sanitisePropertyValue(sidecar.series) ?? '',
    seriesLinked: renderSeriesAsWikilink(sidecar.series) ?? '',
    tags: tags.join(', '),
    tagsLinked: tags
      .map((t) => `[[${sanitiseForWikilink(t)}]]`)
      .join(', '),
    koreaderId: sanitisePropertyValue(sidecar.partialMd5 ?? sidecar.docPath) ?? '',
  }
  const rendered = renderTemplate(tpl, view)
  return parseInlineProperties(rendered)
}

const PROPERTY_LINE_RE = /^([a-zA-Z][a-zA-Z0-9-]*)::\s*(.+?)\s*$/

function parseInlineProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const m = rawLine.match(PROPERTY_LINE_RE)
    if (!m) continue
    const [, key, value] = m
    if (!value || out[key]) continue
    out[key] = value
  }
  return out
}

function templateIsDefault(actual: string | undefined, defaultTpl: string): boolean {
  return (actual ?? '').trim() === defaultTpl.trim()
}

function sanitiseForWikilink(s: string): string {
  return s.replace(/\[/g, '(').replace(/\]/g, ')')
}

function renderSeriesAsWikilink(series: string | undefined): string | undefined {
  const cleaned = sanitisePropertyValue(series)
  if (!cleaned) return undefined
  return `[[${sanitiseForWikilink(cleaned)}]]`
}

export function renderHighlightsHeading(kind: 'initial sync' | 'sync', ctx: RenderContext, date: Date): string {
  const view = {
    kind,
    date: safeFormat(date, ctx.preferredDateFormat),
  }
  return renderTemplate(ctx.templates.highlightsHeading || DEFAULT_HIGHLIGHTS_HEADING_TEMPLATE, view)
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
 * the name is referenced via [[wikilink]] or passed to createPage.
 *  - `[`/`]` collide with the wikilink delimiters (e.g.
 *    `[[The Economist [May 2nd 2026]]]` parses as
 *    `[[The Economist [May 2nd 2026]]` + literal `]`).
 *  - `:` is reserved by Logseq's property syntax and createPage rejects
 *    names containing it ("This Life: Secular Faith…" → use em dash).
 */
export function sanitisePageName(title: string): string {
  return title
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/:\s*/g, ' — ')
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
