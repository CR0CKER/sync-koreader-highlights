-- Synthetic sidecar. The graph already has a page "The Odyssey", so the
-- highlights should go onto that page instead of a new one.
return {
    ["annotations"] = {
        [1] = {
            ["chapter"] = "Book I",
            ["datetime"] = "2026-01-03 10:00:00",
            ["drawer"] = "lighten",
            ["pageno"] = 3,
            ["pos0"] = "/body/DocFragment[2]/body/p[1]/text().0",
            ["pos1"] = "/body/DocFragment[2]/body/p[1]/text().40",
            ["text"] = "Tell me, Muse, of the man of many ways.",
        },
        [2] = {
            ["chapter"] = "Book IX",
            ["datetime"] = "2026-01-04 18:25:33",
            ["drawer"] = "underscore",
            ["pageno"] = 141,
            ["pos0"] = "/body/DocFragment[10]/body/p[30]/text().5",
            ["pos1"] = "/body/DocFragment[10]/body/p[30]/text().61",
            ["text"] = "Nobody is my name; Nobody they call me.",
        },
    },
    ["doc_path"] = "/mnt/onboard/fixture/The Odyssey - Homer.epub",
    ["doc_props"] = {
        ["authors"] = "Homer",
        ["language"] = "en",
        ["title"] = "The Odyssey",
    },
    ["partial_md5_checksum"] = "f1x7a0000000000000000000000000002",
}
