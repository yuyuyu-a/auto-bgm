# Custom Music Limit Implementation Plan

> **For agentic workers:** Use test-driven-development in the existing feature
> checkout. Preserve previous story and recursive-library changes.

**Goal:** Make the effective per-episode upper limit clearly user-configurable.

**Architecture:** Native mode radios map onto existing `maxTracksPerEpisode`
and `scenePriority` configuration. No API or planner protocol change.

**Tech Stack:** Electron, Node.js CommonJS, native DOM inputs, node:test.

## Global Constraints

- Do not change audio count semantics or strict music screening.
- Custom mode must turn scene priority off; unlimited writes zero.
- Preserve existing encrypted credentials and unpacked preview policy.
- No new dependency, external provider request, commit or push.

## Task 1: Mode Controls And Regression Coverage

- [x] Add `tools/check-custom-limit.cjs` using the real renderer and existing
  workbench preload. Assert custom selection is accessible from the default,
  17 is saved/reloaded and sent at start, and zero/scene priority show unlimited.
- [x] Run `electron tools/check-custom-limit.cjs` before implementation; expect
  failure because the custom radio does not exist.
- [x] Add focused settings rendering and event handling in
  `desktop/renderer/renderer.js`, retaining the existing config shape.
- [x] Add scoped mode styles in `desktop/renderer/styles.css`.
- [x] Run the new check and adjust old workbench/package UI smoke expectations.

## Task 2: Verify And Deliver

- [x] Run `npm test`, `npm run test:desktop-ui`, custom limit UI checks and
  `git diff --check`; inspect desktop and minimum-window screenshots.
- [x] Request a focused independent code review while packaging.
- [x] Update README and the local usage guide with effective cap semantics.
- [x] Rebuild `release/win-unpacked` using `bgmPreview=true`; run the custom
  check against `app.asar`, then recursive and story package smoke checks.
- [x] Deliver the verified executable and short usage instructions.

## Verification Evidence

- `npm test`: 145 passed, zero failed.
- `npm run test:desktop-ui` and `tools/check-story-ui.cjs`: passed.
- `tools/check-custom-limit.cjs` in source and packaged modes: passed,
  including custom 17, reload, task configuration, unlimited and scene mode.
- Desktop and minimum-window screenshots inspected with the custom value 17.
- Independent review found incomplete native numeric edits were cleared on
  blur. A regression reproduced this with Control+A, native insertion and
  blur; conditional value synchronization now preserves `1e`, `-` and `1e+`.
  The regression passes against source and the rebuilt package.
- Unpacked Windows build, recursive package smoke and story package smoke:
  passed. Story smoke used a local fixture service, not a paid provider.
- `git diff --check`: passed; line-ending normalization warnings only.
- Supplemental `check-packaged-preview.cjs` reached and passed the new mode
  assertions, then stopped at its existing automatic-instrumental assertion:
  the supplied synthetic tone was classified `unknown` (music ratio 1/9).
  That input is unsuitable for this checker, which requires music classified
  as instrumental. No filtering rules were changed to accommodate the fixture.
