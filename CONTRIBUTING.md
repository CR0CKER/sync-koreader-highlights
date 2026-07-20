# Contributing

Thanks for taking an interest! This is a small, single-maintainer
project — issues and pull requests are welcome and treated as a
conversation, not a process.

## Filing an issue

The issue templates ask for:

- KOReader version (Settings → ⓘ → "About").
- Logseq version (top-right ⋯ → About Logseq).
- Plugin version (from `package.json` or the unpacked-plugin
  folder name).
- Reproduction steps.
- Console output from Logseq's devtools (Ctrl+Shift+I → Console).
  Lines starting with `sync-koreader-highlights:` are the most
  useful.
- A redacted copy of the relevant `metadata.*.lua` sidecar if the
  bug involves a specific book.

A short, well-scoped report tends to get a quick answer.

## Building and testing

Requires Node 22+. On Asahi Fedora aarch64 you may need to bypass
an x86-64 nvm install:

```sh
PATH=/usr/bin:$PATH /usr/bin/npm install
PATH=/usr/bin:$PATH /usr/bin/npm run build
```

Output lands in `dist/` (one HTML + one JS bundle). To test in
Logseq:

1. Plugins → ··· → **Load unpacked plugin** → point at the repo
   root.
2. Reload after every rebuild (toggle the plugin off and on).

A Vitest suite covers the pure parse/render layer — run it (and the
type-checker) locally with:

```sh
PATH=/usr/bin:$PATH /usr/bin/npm run typecheck
PATH=/usr/bin:$PATH /usr/bin/npm test
```

Full end-to-end testing still means syncing against a small KOReader
directory and inspecting the produced Logseq pages and console output.
CI ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml) +
[`security.yml`](./.github/workflows/security.yml)) runs type-check,
build, unit tests, semgrep SAST, and gitleaks on every push and PR;
all are required checks, so a change won't merge until they're green.

## Pull requests

- Branch off `master`.
- Keep commits focused. The history reads well when each commit
  is a single coherent change with a body explaining *why*.
- Update [CHANGELOG.md](./CHANGELOG.md) under an `## [Unreleased]`
  section if the change is user-visible.
- Update [README.md](./README.md) if a setting, command, or
  behaviour changed.
- The PR template walks through a small checklist; please tick
  through it before requesting review.

## Code style

- TypeScript strict mode.
- Module-level comments for non-obvious *why* (the project's
  history has a few of these — see e.g. `storage.ts`'s reset
  helpers, which document why `updateSettings({key: {}})` is a
  no-op against Logseq's deep-merge).
- Avoid adding runtime dependencies unless the value is
  unambiguous; the build is small and we'd like to keep it that
  way.

## Code of Conduct

This project adopts the [Contributor Covenant v2.1](./CODE_OF_CONDUCT.md).
By participating you agree to abide by it.

## Licensing of contributions

By contributing you agree that your contributions will be licensed
under the [MIT License](./LICENSE) of this project. No CLA is
required.
