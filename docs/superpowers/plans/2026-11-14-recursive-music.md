# Recursive Music Scanning Implementation Plan

> **For agentic workers:** Execute in the current feature branch with
> test-driven-development. Preserve all existing story-assisted work.

**Goal:** Include deeply nested music in scanning, screening and automatic BGM.

**Architecture:** Extend the existing scanner without changing its return
type. Reuse existing mood-folder matching for nested categories. Correct
top-level health warnings using discovered file ancestry.

**Tech Stack:** Node.js CommonJS, node:test, Electron, FFmpeg.

## Global Constraints

- No new dependencies, source-file relocation or API requests.
- Do not commit, push or overwrite unrelated work.
- Retain strict vocal screening, encrypted settings and preview update policy.
- Rebuild `release/win-unpacked` as a local preview, not a published installer.

## Task 1: Recursive Catalog And Consumers

**Files:** `src/mvp.js`, `desktop/backend/batch-service.js`,
`test/music-scan.test.js`, `test/mvp.test.js`, `README.md`.

**Interface:** `scanMusic(musicDir)` returns the existing mood-to-paths Map.
Known nested mood folders override inherited categories; ordinary folders do
not. Health checks report only genuinely audio-empty top-level directories.

- [x] Add scanner fixtures for nested albums, wrapped mood directories, custom
  categories, root tracks, repeated names, supported formats and junctions.
  Assert literal expected paths and category names.
- [x] Add an integration fixture with nested tracks: preflight/import must
  count them, health must not mark the wrapper empty, manual confirm/disable
  must persist, and strict batch rendering must use only the confirmed track.
- [x] Run `node --test test/music-scan.test.js` and the focused integration
  test. Confirm failures are caused by the shallow scanner.
- [x] Implement recursive traversal with inherited mood and existing
  `findMoodFolder` matching; do not follow links. Update health emptiness.
- [x] Run the focused tests again, then document the rules and examples.

## Task 2: Verification And Local Delivery

- [x] Run `npm test`, `npm run test:desktop-ui`, and `git diff --check`.
- [x] Request an independent review limited to recursive scanning changes.
- [x] Rebuild with:
  `electron-builder --win --dir --publish never --config.extraMetadata.bgmPreview=true --config.directories.output=release`.
- [x] Verify packaged source parity and render with deeply nested input music,
  using bundled media tools and a local provider fixture only. Run
  `electron tools/check-recursive-package.cjs` for nested screening/rendering
  and `electron build/check-story-package.cjs` for story/runtime preservation.
- [x] Report the verified executable path and any category limitations.

## Verification Results

- Initial RED: four scanner regressions failed on the shallow scanner; the
  desktop integration failed with zero preflight tracks.
- Focused GREEN: six scanner tests and the real-media integration passed.
- Full `npm test`: 143 passed, zero failed, zero skipped.
- Desktop UI regression: passed; `git diff --check`: passed.
- Independent read-only review: no findings. Residual fixture gaps are
  file-symlink exclusion, unreadable children and collation-equal path ties.
- Windows unpacked preview rebuilt successfully with `bgmPreview=true`.
- `tools/check-recursive-package.cjs`: passed; four nested directory levels,
  two discovered tracks, one strictly eligible after manual review,
  matching packaged sources, correct story category and sample-exact silence.
- `build/check-story-package.cjs`: passed; ten runtime files match source,
  encrypted settings remain usable, bundled real transcription/rendering work,
  and the local provider replay preserves deliberate silence. No paid request.
- Both package verifiers generated decodable final videos. The user's guide
  `../STORY-BGM-local.md` now documents recursive categories and regeneration.
