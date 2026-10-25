-- Synthetic PDF sidecar: positions are page-coordinate tables, not xpointers
-- (the shape behind issue #24).
return {
    ["annotations"] = {
        [1] = {
            ["chapter"] = "",
            ["color"] = "gray",
            ["datetime"] = "2026-01-08 09:15:00",
            ["drawer"] = "lighten",
            ["page"] = 6,
            ["pageno"] = 6,
            ["pos0"] = { ["page"] = 6, ["rotation"] = 0, ["x"] = 80.6, ["y"] = 379.95, ["zoom"] = 2.55 },
            ["pos1"] = { ["page"] = 6, ["rotation"] = 0, ["x"] = 216.78, ["y"] = 443.34, ["zoom"] = 2.55 },
            ["text"] = "Measure twice; the river only lets you cross once.",
        },
    },
    ["doc_path"] = "/mnt/onboard/fixture/Field Notes - Field Office.pdf",
    ["doc_props"] = {
        ["authors"] = "Field Office",
        ["title"] = "Field Notes",
    },
    ["partial_md5_checksum"] = "f1x7a0000000000000000000000000003",
}
