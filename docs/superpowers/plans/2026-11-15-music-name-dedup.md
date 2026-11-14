# Music Filename Deduplication Implementation Plan

> **For agentic workers:** Use test-driven development to implement this scoped
> plan in the current session, followed by a focused independent code review.

**Goal:** Analyze and select only one copy of each case-insensitive filename.

**Architecture:** A shared pure catalog helper maps filename aliases to stable
representative paths while preserving mood memberships. Raw recursive scans stay
unchanged for source protection. Desktop and batch processing use the same helper.

**Tech Stack:** Node.js, Electron, existing FFmpeg and Node test harnesses.

## Global Constraints

- Compare full filenames including extensions; ignore case only.
- Never delete, rename, move or overwrite source media.
- Preserve strict screening, fingerprint invalidation and manual disable.
- Keep all mood memberships but count each representative once.
- Do not publish, change the package version or replace the installed app.

## Task 1: Deduplicate Before Expensive Processing

Files: `src/music-dedup.js`, `src/music-library.js`, `src/mvp.js`,
`desktop/backend/batch-service.js`, `test/music-name-dedup.test.js`.

- [x] Add integration tests that fail because same-name copies are all checked.
      Run `node --test test/music-name-dedup.test.js` and confirm RED.
- [x] Add `deduplicateMusic(groups) -> { groups, files, duplicates }`.
      Sort unique source paths naturally with an ordinal tie-breaker, index by
      `path.basename(file).toLowerCase()`, and map each mood to unique
      representative paths. Duplicate rows use `{ file, original, kind: 'name' }`.
- [x] Use the helper in `inspectMusicCatalog` before health checks, and in
      `filterLibrary` before fingerprint lookup or vocal inference. Return name
      duplicates from health inspection; retain raw scans for source protection.
- [x] Use representative groups/counts in desktop preflight and health. Preserve
      existing content warnings and add `nameDuplicateCount`; batch summaries
      record the skipped copy count.
- [x] Confirm GREEN for same-name/different-content files, case-insensitive
      matches, distinct extensions/suffixes, deterministic selection, shared
      moods, one cached analysis and invalidation of changed representatives.
- [x] Render a real batch requesting two tracks from two same-name files and
      assert it uses one unique track and reports the unmet minimum.
- [x] Verify a deduplicated-out source is still protected from output collision.

## Task 2: Visible Results and Regression

Files: `desktop/renderer/renderer.js`, `tools/check-workbench.cjs`, `README.md`.

- [x] Extend the real desktop harness with overlapping mood memberships and a
      skipped-name fixture. Assert unique preflight counts and a name-duplicate
      warning, rather than a content-equality claim; confirm RED.
- [x] Show unique counts and skipped-name warnings using escaped file paths.
      Document case-insensitive full-name matching and untouched originals.
- [x] Run `node --test test/music-name-dedup.test.js test/music-scan.test.js
      test/music-library.test.js`, `npm test`, and `npm run test:desktop-ui`.
- [x] Inspect the desktop and minimum-window screenshots, review the final diff,
      and obtain one focused correctness review.
- [x] Record actual results and explain that the installed release is unchanged.

## Verification

- RED: six of seven new integration checks failed on the original code because
  copies were separately checked; the existing source-protection check passed.
- GREEN: 23 focused tests passed, covering raw recursive scan compatibility,
  filename deduplication, strict screening and a real rendered batch.
- UI RED: the real renderer reported three category memberships instead of two
  unique songs in the new overlapping-category fixture.
- Full suite: `npm test` passed 173/173; log:
  `build/music-name-dedup-tests.log`.
- UI GREEN: `npm run test:desktop-ui` passed, including unique preflight counts,
  skipped-name messages, media/editing stability and minimum-window layout.
  Desktop and 760x520 screenshots of the actual library result were inspected:
  `build/ux-verification/library-name-dedup.png` and
  `build/ux-verification/library-name-dedup-minimum.png`.
- Changed-file credential-pattern and diff-whitespace checks passed. No live
  credentials, user music or installed application files were used or modified.
- A focused read-only independent review found no important issues or blockers.
  Syntax and in-memory catalog checks passed without another test-suite run.
- Source changes are kept on local branch `codex/music-name-dedup`. No new
  installer was built or published, and the installed application was not
  replaced. This status was explicitly reported to the user.
