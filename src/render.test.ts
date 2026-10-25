import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEMPLATES,
  RenderContext,
  findSimilarPageName,
  isIndexReceiptHeading,
  normaliseTitle,
  parseKoreaderDatetime,
  renderBookHeaderProperties,
  renderHighlight,
  resolvePageName,
  sanitisePageName,
  truncate,
} from './render'
import { KoreaderHighlight, KoreaderSidecar } from './sidecar'

const ctx: RenderContext = {
  preferredDateFormat: 'yyyy-MM-dd',
  templates: DEFAULT_TEMPLATES,
}

function highlight(over: Partial<KoreaderHighlight> = {}): KoreaderHighlight {
  return { id: 'id', text: '', ...over }
}

describe('parseKoreaderDatetime', () => {
  it('parses "YYYY-MM-DD HH:MM:SS" as a local Date', () => {
    const d = parseKoreaderDatetime('2026-01-02 13:45:30')!
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(0) // January
    expect(d.getDate()).toBe(2)
    expect(d.getHours()).toBe(13)
  })

  it('accepts a date-only string', () => {
    const d = parseKoreaderDatetime('2026-01-02')!
    expect(d.getFullYear()).toBe(2026)
    expect(d.getHours()).toBe(0)
  })

  it('returns null for undefined or malformed input', () => {
    expect(parseKoreaderDatetime(undefined)).toBeNull()
    expect(parseKoreaderDatetime('not a date')).toBeNull()
    expect(parseKoreaderDatetime('2026/01/02')).toBeNull()
  })
})

describe('sanitisePageName', () => {
  it('replaces [ ] with parens so wikilinks do not break', () => {
    expect(sanitisePageName('The Economist [May 2nd 2026]')).toBe('The Economist (May 2nd 2026)')
  })

  it('replaces a reserved colon with an em dash', () => {
    expect(sanitisePageName('This Life: Secular Faith')).toBe('This Life — Secular Faith')
  })

  it('collapses runs of whitespace', () => {
    expect(sanitisePageName('A    B')).toBe('A B')
  })
})

describe('resolvePageName', () => {
  it('returns the base name when it is free', () => {
    expect(resolvePageName('The Odyssey', 'Homer', () => false)).toBe('The Odyssey')
  })

  it('disambiguates a collision with the author, not a stringified array (audit M1)', () => {
    // Callers pass a comma-joined author STRING. A regression that passed the
    // raw string[] would render "[object Array]"-style / raw-comma output.
    const taken = new Set(['The Odyssey'])
    const name = resolvePageName('The Odyssey', 'Homer', (n) => taken.has(n))
    expect(name).toBe('The Odyssey — Homer')
  })

  it('falls back to a numeric suffix when title and author both collide', () => {
    const taken = new Set(['Poems', 'Poems — Anon'])
    const name = resolvePageName('Poems', 'Anon', (n) => taken.has(n))
    expect(name).toBe('Poems (2)')
  })
})

describe('normaliseTitle', () => {
  it('folds case and the punctuation that separates title parts', () => {
    expect(normaliseTitle('Good Strategy, Bad Strategy')).toBe('good strategy bad strategy')
    expect(normaliseTitle('Good Strategy/Bad Strategy')).toBe('good strategy bad strategy')
    expect(normaliseTitle('This Life: Secular Faith')).toBe(normaliseTitle('This Life — Secular Faith'))
    expect(normaliseTitle('A – B ; C')).toBe('a b c')
  })

  it('keeps letters, digits and other punctuation', () => {
    expect(normaliseTitle("Self-Reliance (1841)")).toBe('self-reliance (1841)')
    expect(normaliseTitle('Catch-22')).not.toBe(normaliseTitle('Catch 22'))
  })
})

describe('findSimilarPageName (#45)', () => {
  const page = (originalName: string, extra: Record<string, unknown> = {}) => ({ originalName, ...extra })
  const none = new Set<string>()

  it('finds the one page whose name differs only in punctuation', () => {
    const pages = [page('Good Strategy, Bad Strategy'), page('Strategy')]
    expect(findSimilarPageName('Good Strategy/Bad Strategy', pages, none)).toBe('Good Strategy, Bad Strategy')
  })

  it('matches a colon in the title against an em dash in the page name', () => {
    const pages = [page('This Life — Secular Faith and Spiritual Freedom')]
    expect(findSimilarPageName('This Life: Secular Faith and Spiritual Freedom', pages, none))
      .toBe('This Life — Secular Faith and Spiritual Freedom')
  })

  it('returns undefined when no page matches', () => {
    expect(findSimilarPageName('Good Strategy/Bad Strategy', [page('Good Strategy')], none)).toBeUndefined()
  })

  it('does not guess when two pages match', () => {
    const pages = [page('Good Strategy, Bad Strategy'), page('Good Strategy; Bad Strategy')]
    expect(findSimilarPageName('Good Strategy/Bad Strategy', pages, none)).toBeUndefined()
  })

  it('skips journal pages', () => {
    expect(findSimilarPageName('Oct 6th, 2026', [page('Oct 6th 2026', { 'journal?': true })], none)).toBeUndefined()
  })

  it('skips pages another synced book already owns (case-insensitively)', () => {
    const owned = new Set(['good strategy, bad strategy'])
    expect(findSimilarPageName('Good Strategy/Bad Strategy', [page('Good Strategy, Bad Strategy')], owned)).toBeUndefined()
  })

  it('falls back to `name` when a page has no originalName', () => {
    expect(findSimilarPageName('A/B', [{ name: 'a, b' }], none)).toBe('a, b')
  })
})

describe('renderHighlight (default template)', () => {
  it('renders a highlight as a blockquote with date/chapter/page properties', () => {
    const block = renderHighlight(
      highlight({ text: 'be swift', datetime: '2026-01-02 10:00:00', chapter: 'Ch 1', page: 7 }),
      ctx,
    )
    expect(block.content).toBe('> be swift')
    expect(block.properties).toMatchObject({
      date: '[[2026-01-02]]',
      chapter: 'Ch 1',
      page: '7',
    })
  })

  it('attaches an annotation note as a child block', () => {
    const block = renderHighlight(highlight({ text: 'quote', note: 'my thought' }), ctx)
    expect(block.children).toEqual([{ content: 'my thought' }])
  })

  it('renders a standalone note as plain body text (no blockquote, no date-updated)', () => {
    const block = renderHighlight(
      highlight({ text: '', note: 'just a note', datetime: '2026-01-02 10:00:00', datetimeUpdated: '2026-01-03 10:00:00' }),
      ctx,
    )
    expect(block.content).toBe('just a note')
    expect(block.properties?.['date-updated']).toBeUndefined()
  })

  it('renders a bare page bookmark as "> Bookmarked"', () => {
    const block = renderHighlight(highlight({ text: '', note: '' }), ctx)
    expect(block.content).toBe('> Bookmarked')
  })

  it('escapes a leading dash so it is not parsed as a list item', () => {
    const block = renderHighlight(highlight({ text: '- a dashed line' }), ctx)
    expect(block.content).toBe('> \\- a dashed line')
  })
})

describe('renderBookHeaderProperties (default template)', () => {
  it('produces author / full-title / category and decodes HTML in the summary', () => {
    const sidecar = {
      title: 'The Odyssey',
      authors: ['Homer'],
      keywords: ['epic'],
      description: '<p>A tale of &quot;nostos&quot;.</p>',
      highlights: [],
    } as KoreaderSidecar
    const props = renderBookHeaderProperties(sidecar, ctx)
    expect(props['full-title']).toBe('The Odyssey')
    expect(props['author']).toBe('[[Homer]]')
    expect(props['category']).toBe('#Books')
    expect(props['summary']).toBe('A tale of "nostos".')
    expect(props['tags']).toBe('[[epic]]')
  })
})

describe('isIndexReceiptHeading', () => {
  it('matches both the current and legacy receipt heading shapes', () => {
    expect(isIndexReceiptHeading('## 📚 Synced on 2026-01-02 at 10:00')).toBe(true)
    expect(isIndexReceiptHeading('## 📚 Sync 2026-01-02')).toBe(true)
  })

  it('does not match unrelated headings', () => {
    expect(isIndexReceiptHeading('## My notes')).toBe(false)
    expect(isIndexReceiptHeading(undefined)).toBe(false)
  })
})

describe('truncate', () => {
  it('leaves short strings untouched and passes through undefined', () => {
    expect(truncate('short', 10)).toBe('short')
    expect(truncate(undefined)).toBeUndefined()
  })

  it('cuts to the limit and appends an ellipsis', () => {
    expect(truncate('abcdef', 3)).toBe('abc…')
  })
})
