-- Synthetic KOReader sidecar for scripts/live-sync.mjs. A new book: colon in
-- the title, a series, keywords, a note, and one ribbon bookmark (no text,
-- synced as "> Bookmarked").
return {
    ["annotations"] = {
        [1] = {
            ["chapter"] = "1. The Night Shift",
            ["datetime"] = "2026-01-02 21:14:07",
            ["drawer"] = "lighten",
            ["pageno"] = 14,
            ["pos0"] = "/body/DocFragment[3]/body/p[12]/text().0",
            ["pos1"] = "/body/DocFragment[3]/body/p[12]/text().96",
            ["text"] = "Every archive is a promise that somebody, someday, will come looking.",
        },
        [2] = {
            ["chapter"] = "4. Index Cards",
            ["datetime"] = "2026-01-05 08:02:51",
            ["datetime_updated"] = "2026-01-06 19:40:12",
            ["drawer"] = "lighten",
            ["note"] = "compare with the card catalogue chapter",
            ["pageno"] = 77,
            ["pos0"] = "/body/DocFragment[9]/body/p[4]/text().18",
            ["pos1"] = "/body/DocFragment[9]/body/p[4]/text().140",
            ["text"] = "She sorted the cards by the colour of the ink, which was wrong, and by the year, which was worse.",
        },
        [3] = {
            ["chapter"] = "6. Lights Out",
            ["datetime"] = "2026-01-07 22:30:00",
            ["page"] = "/body/DocFragment[12]/body/p[1]/text().0",
            ["pageno"] = 120,
        },
    },
    ["doc_path"] = "/mnt/onboard/fixture/The Lantern Archive - Mara Quell.epub",
    ["doc_props"] = {
        ["authors"] = "Mara Quell",
        ["description"] = "<p>A night archivist and the index nobody finished.</p>",
        ["identifiers"] = "uuid:00000000-0000-4000-8000-000000000001",
        ["keywords"] = "Fiction;Libraries",
        ["language"] = "en",
        ["series"] = "Night Stacks",
        ["series_index"] = 1,
        ["title"] = "The Lantern Archive: A Novel",
    },
    ["partial_md5_checksum"] = "f1x7a0000000000000000000000000001",
}
