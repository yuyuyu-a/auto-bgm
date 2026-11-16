# Similar Music Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substitute compatible local music for missing styles without accidental silent BGM.

**Architecture:** Extract the existing category resolver and track chooser into
one shared selection module. Preserve requested mood independently of available
folders, and report actual selection in rule and story plans.

**Tech Stack:** CommonJS, Node.js built-in test runner, Electron, FFmpeg.

## Global Constraints

- Existing strict screening, deduplication, required scene switches, track limits,
  deliberate story silence, freeze tails, credentials, and output ownership remain intact.
- Folder-label compatibility is deterministic; no acoustic emotion model or new dependency.
- No opposing-style substitution solely to satisfy track counts.
- Completed old outputs remain preserved and are flagged for regeneration.
- No release uploads or installed-app replacement.

## Task 1: Shared Similar Selection And Planner Integration

**Files:**
- Create: `src/music-selection.js`, `test/music-selection.test.js`.
- Modify: `src/mvp.js`, `src/story-music-plan.js`, `src/story-director.js`.
- Test: `test/music-library.test.js`, `test/mvp.test.js`,
  `test/story-music-plan.test.js`, `test/story-director.test.js`.

**Interfaces:**
- `findMoodFolder(mood, groups)` retains its public folder-name-or-null contract.
- `chooseTrack(groups, mood, trackUses, episodeTracks, metadata, changeTrack,
  previousTrack, intensityOverride)` retains its file-path-or-null contract.
- `describeTrackSelection(groups, requestedMood, track)` returns
  `{ requestedMood, selectedMood, matchType }`.
- `buildMusicPlan(context)` still returns its existing structure, with additional
  selection provenance on segments. Only explicit story silence permits null tracks.

- [x] Write planner regressions showing missing romance selects warmth, missing
  tension selects suspense before neutral, sadness never selects cheerful music,
  uncertain mood without neutral selects a restrained track, and no compatible
  music raises an actionable error. Assert tracks and review metadata directly:

```js
const result = buildMusicPlan({
  duration: 40,
  transcript: { segments: [{ start: 0, end: 10, text: 'I love you.' }] },
  groups: new Map([['温情', ['warm.wav']]]),
  options: {},
  trackUses: new Map(),
});
assert.equal(result.segments[0].track, 'warm.wav');
assert.equal(result.segments[0].requestedMood, '浪漫');
assert.equal(result.segments[0].selectedMood, '温情');
assert.equal(result.segments[0].matchType, 'similar');
assert.equal(result.segments[0].review, true);
```

- [x] Run focused regressions and observe failures caused by the missing behavior:
  `node --test test/music-selection.test.js`.
- [x] Extract existing aliases and chooser, add ordered compatible categories,
  retain episode uniqueness and intensity ranking, and implement provenance.
  Keep classification independent of library availability, but only stable mood
  runs determine section intent. Reject null rule selections explicitly.
- [x] Add and verify story fallback tests for empty valid categories; retain
  explicit silence and unknown-category rejection. Update the story prompt to
  explicitly prefer dramatically similar available categories over missing-music silence.
- [x] Revise the legacy-silence integration fixture to verify actual nonsilent
  fallback rendering and safe legacy resume; add a synthetic prior-silence state
  to verify regeneration warnings without rewriting existing files.
- [x] Run `npm.cmd test` and `npm.cmd run test:desktop-ui`; inspect changes with
  `git diff --check` and obtain independent review.
- [x] Record verification evidence, mark these steps complete, and leave the
  change on its feature branch without publishing or installing it.

## Verification Progress

- Initial regression run: 11 expected failures and 1 existing conservative-evidence
  pass in `test/music-selection.test.js`, before implementation.
- Shared and story focused run: 52 passing, 0 failures.
- FFmpeg fallback rendering, safe legacy-silence resume/regeneration, and
  sustained-arc regression: 3 passing, 0 failures.
- `npm.cmd test`: 191 passing, 0 failures, 0 skips, 61.1 seconds.
- `npm.cmd run test:desktop-ui`: passed; desktop screenshot inspected.
- `git diff --check`: passed; only expected Windows line-ending notices.
- Independent review identified five boundary issues: prefixed aliases, pooled
  alias tiers, shared-category intent boundaries, uncertain-style continuity,
  and ambiguous neutral provenance. Added six failing reproductions before the
  fixes, plus a same-track/required-scene regression.
- Fix verification: selection/library/story tests 43 passing; focused existing
  planner and scene-render regressions 12 passing.
- Final `npm.cmd test`: 198 passing, 0 failures, 0 skips, 57.0 seconds.
- Final `npm.cmd run test:desktop-ui`: passed.
- Scoped independent re-review confirmed all five original findings addressed,
  and found that same-file intent segments restarted playback.
- Added a real nonstationary-audio regression: before the render fix it measured
  440 Hz where uninterrupted playback required 880 Hz. Render spans now coalesce
  same-file continuations while retaining separate intent artifacts.
- Extended the passing regression to cover a following different track (1320 Hz),
  correct original-input indexing, and both enabled/disabled transition fades.
  Loudness duration, configured fades, and exact story silence: 5 focused tests pass.
- Final full rerun: `npm.cmd test` passed 199 tests, 0 failures, 0 skips,
  67.3 seconds. Final desktop UI smoke passed again.
- Rendering-only independent re-review: restart finding addressed; no new
  findings. Reviewer independently verified 5 focused rendering tests, guarded
  boundaries, CSV fades, and preservation of intent records.
- Work retained on local branch `fix/similar-music-fallback`; no main-branch merge,
  remote push, release build, private-settings access, or installed-app changes.
