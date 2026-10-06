import { describe, expect, it } from 'vitest'
import { parseSidecar, sidecarKey, walkSidecars, KoreaderSidecar } from './sidecar'

/**
 * KOReader sidecars are `return { … }` Lua tables. These fixtures mirror
 * the real shapes the parser must survive: modern `annotations`, legacy
 * `bookmarks`, ribbon page-bookmarks (no pos0/pos1), stubs, and
 * separator-laden author/keyword strings.
 */
function modernSidecar(extra = ''): string {
  return `return {
    ["doc_props"] = {
        ["title"] = "The Odyssey",
        ["authors"] = "Homer",
        ["keywords"] = "epic;poetry,classics",
        ["series"] = "Greek Classics",
        ["description"] = "<p>A tale of &quot;nostos&quot;.</p>",
    },
    ["annotations"] = {
        ["1"] = {
            ["text"] = "Sing to me of the man, Muse",
            ["note"] = "opening line",
            ["datetime"] = "2026-01-02 10:00:00",
            ["datetime_updated"] = "2026-01-03 11:00:00",
            ["pos0"] = "/body/DocFragment[1]/body/p[3]/text().0",
            ["pos1"] = "/body/DocFragment[1]/body/p[3]/text().28",
            ["chapter"] = "Book I",
            ["pageno"] = 12,
        },
    },
    ["partial_md5_checksum"] = "abc123",
    ["doc_path"] = "/mnt/onboard/odyssey.epub",
    ${extra}
}`
}

describe('parseSidecar', () => {
  it('returns null on unparseable Lua', () => {
    expect(parseSidecar('this is not lua {{{')).toBeNull()
  })

  it('returns null when doc_props is missing or empty', () => {
    expect(parseSidecar('return { ["annotations"] = {} }')).toBeNull()
    expect(parseSidecar('return { ["doc_props"] = {} }')).toBeNull()
  })

  it('returns null when the title is blank', () => {
    expect(parseSidecar('return { ["doc_props"] = { ["title"] = "  " } }')).toBeNull()
  })

  it('extracts title, md5, doc_path, series and decoded description', () => {
    const s = parseSidecar(modernSidecar())!
    expect(s).not.toBeNull()
    expect(s.title).toBe('The Odyssey')
    expect(s.partialMd5).toBe('abc123')
    expect(s.docPath).toBe('/mnt/onboard/odyssey.epub')
    expect(s.series).toBe('Greek Classics')
    // description is kept raw here (HTML sanitising happens in render.ts).
    expect(s.description).toContain('nostos')
  })

  it('splits keywords on ; and , separators', () => {
    const s = parseSidecar(modernSidecar())!
    expect(s.keywords).toEqual(['epic', 'poetry', 'classics'])
  })

  it('keeps a "Last, First" author as one entry (never splits on comma)', () => {
    const lua = `return { ["doc_props"] = { ["title"] = "X", ["authors"] = "Le Guin, Ursula K." } }`
    const s = parseSidecar(lua)!
    expect(s.authors).toEqual(['Le Guin, Ursula K.'])
  })

  it('splits multiple authors on the KOReader line-continuation separator', () => {
    // KOReader writes multiple authors with a `\<LF>` line-continuation in
    // the raw Lua (NOT a `\n` escape, which luaparse leaves as literal two
    // chars). The `\\\n` below is backslash + a real newline in the source.
    const lua = `return { ["doc_props"] = { ["title"] = "X", ["authors"] = "Gaiman, Neil\\\nPratchett, Terry" } }`
    const s = parseSidecar(lua)!
    expect(s.authors).toEqual(['Gaiman, Neil', 'Pratchett, Terry'])
  })

  it('reads modern annotations with page/chapter/datetime and both timestamps', () => {
    const s = parseSidecar(modernSidecar())!
    expect(s.highlights).toHaveLength(1)
    const h = s.highlights[0]
    expect(h.text).toBe('Sing to me of the man, Muse')
    expect(h.note).toBe('opening line')
    expect(h.page).toBe(12)
    expect(h.chapter).toBe('Book I')
    expect(h.datetime).toBe('2026-01-02 10:00:00')
    expect(h.datetimeUpdated).toBe('2026-01-03 11:00:00')
    expect(h.id).toContain('2026-01-02 10:00:00')
  })

  it('treats an annotation without pos0/pos1 as a ribbon bookmark (empty text)', () => {
    const lua = `return {
      ["doc_props"] = { ["title"] = "X", ["authors"] = "A" },
      ["annotations"] = { ["1"] = { ["text"] = "in Chapter 3", ["datetime"] = "2026-01-01 09:00:00", ["pageno"] = 5 } },
    }`
    const s = parseSidecar(lua)!
    expect(s.highlights).toHaveLength(1)
    expect(s.highlights[0].text).toBe('')
    expect(s.highlights[0].page).toBe(5)
  })

  // PDF sidecars store pos0/pos1 as position tables, not xpointer strings
  // (issue #24: every PDF highlight rendered as "Bookmarked").
  function pdfSidecar(annotations: string): string {
    return `return {
      ["doc_props"] = { ["title"] = "A PDF", ["authors"] = "A" },
      ["annotations"] = { ${annotations} },
    }`
  }
  const pdfHighlight = (n: number, text: string, x: number) => `[${n}] = {
      ["chapter"] = "", ["color"] = "gray", ["datetime"] = "2026-07-26 17:28:14",
      ["drawer"] = "lighten", ["page"] = 6, ["pageno"] = 6,
      ["pos0"] = { ["page"] = 6, ["rotation"] = 0, ["x"] = ${x}, ["y"] = 379.95, ["zoom"] = 2.55 },
      ["pos1"] = { ["page"] = 6, ["rotation"] = 0, ["x"] = 216.78, ["y"] = 443.34, ["zoom"] = 2.55 },
      ["text"] = "${text}",
    },`

  it('keeps the text of a PDF highlight whose pos0/pos1 are position tables', () => {
    const s = parseSidecar(pdfSidecar(pdfHighlight(1, 'highlighted in a PDF', 80.6)))!
    expect(s.highlights).toHaveLength(1)
    expect(s.highlights[0].text).toBe('highlighted in a PDF')
    expect(s.highlights[0].page).toBe(6)
  })

  it('still treats a PDF ribbon bookmark (page number, no positions) as a bookmark', () => {
    const s = parseSidecar(pdfSidecar(
      '[1] = { ["text"] = "in Chapter 2", ["datetime"] = "2026-07-26 17:30:00", ["page"] = 9, ["pageno"] = 9 },',
    ))!
    expect(s.highlights[0].text).toBe('')
    expect(s.highlights[0].page).toBe(9)
  })

  it('gives PDF highlights ids built from their positions, not "[object Object]"', () => {
    const s = parseSidecar(pdfSidecar(pdfHighlight(1, 'one', 80.6) + pdfHighlight(2, 'two', 120.1)))!
    const [a, b] = s.highlights.map((h) => h.id)
    expect(a).not.toContain('[object Object]')
    expect(a).not.toBe(b)
    expect(parseSidecar(pdfSidecar(pdfHighlight(1, 'one', 80.6)))!.highlights[0].id).toBe(a)
  })

  it('keeps EPUB highlight ids exactly as before, so a sync does not rebuild every EPUB book', () => {
    const s = parseSidecar(modernSidecar())!
    expect(s.highlights[0].id).toBe(
      '2026-01-02 10:00:00|/body/DocFragment[1]/body/p[3]/text().0|/body/DocFragment[1]/body/p[3]/text().28|Sing to me of the man, Muse',
    )
  })

  it('falls back to the legacy bookmarks array when annotations are absent', () => {
    const lua = `return {
      ["doc_props"] = { ["title"] = "Old Book", ["authors"] = "A" },
      ["bookmarks"] = { ["1"] = {
        ["text"] = "a legacy highlight",
        ["datetime"] = "2020-05-05 08:00:00",
        ["pos0"] = "p0", ["pos1"] = "p1", ["page"] = 3,
      } },
    }`
    const s = parseSidecar(lua)!
    expect(s.highlights).toHaveLength(1)
    expect(s.highlights[0].text).toBe('a legacy highlight')
    expect(s.highlights[0].page).toBe(3)
  })
})

describe('sidecarKey', () => {
  it('prefers the content md5 when present (stable across file moves)', () => {
    const s = { title: 'T', authors: ['A'], partialMd5: 'deadbeef', highlights: [] } as KoreaderSidecar
    expect(sidecarKey(s)).toBe('md5:deadbeef')
  })

  it('falls back to author+title metadata when no md5 is present', () => {
    const s = { title: 'T', authors: ['A'], highlights: [] } as KoreaderSidecar
    expect(sidecarKey(s)).toBe('meta:A|||T')
  })
})

describe('walkSidecars', () => {
  it('yields only files matching metadata.*.lua', async () => {
    const files = ['metadata.epub.lua', 'cover.jpg', 'metadata.pdf.lua', 'notes.txt']
    const fakeDir = {
      kind: 'directory',
      async *values() {
        for (const name of files) yield { kind: 'file', name }
      },
    }
    const found: string[] = []
    for await (const h of walkSidecars(fakeDir)) found.push((h as any).name)
    expect(found).toEqual(['metadata.epub.lua', 'metadata.pdf.lua'])
  })
})
