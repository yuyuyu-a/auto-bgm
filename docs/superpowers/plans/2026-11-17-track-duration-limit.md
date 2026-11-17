# Single-Track Duration Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Enforce a saved, configurable continuous-track limit and publish the verified Windows update.

**Architecture:** Apply one shared local duration-enforcement pass to rule and story plans. Derive shared playback windows for rendering and timeline evidence, including fade overlaps, without changing story anchors.

**Tech Stack:** CommonJS, Node test runner, FFmpeg, Electron, electron-builder, GitHub CLI.

## Global Constraints

- Default `maxTrackDuration` is 40 seconds; `0` disables the limit.
- Same file across adjacent intention segments counts cumulatively, even if restarted.
- Include fade extensions in the actual playback limit.
- Required duration changes override episode segment limits.
- Reuse screened local same-style, similar-style, compatible-neutral selection.
- Preserve explicit story silence, freeze tail, original media, encrypted secrets, and v1.0.6 silence repair.
- No new dependencies, models, extra paid API calls, or unrelated refactors.
- No alternative: time-specific actionable error, never accidental silence.
- Saved settings affect new or explicitly regenerated outputs, not completed media automatically.
- User authorized implementation and publication in the existing release checkout.

## Task 1: Shared Planning And Rendering

**Files:** `src/track-duration.js` (new), `src/mvp.js`, `test/track-duration.test.js` (new), `test/mvp.test.js`.

**Interfaces:**
- Input: existing plan `{ segments, trackCount, ... }`, planner context with screened `groups`, `options`, `trackUses`.
- Setting: `options.maxTrackDuration`, finite nonnegative seconds, default 40, zero unlimited.
- Output: plan preserving evidence and intentional boundaries, with different-track duration changes and updated counts.
- Shared playback windows are consumed by FFmpeg filter and timeline, never independently approximated.

- [x] Write failing behavioral tests with real planners and local synthetic file names:
  ```js
  const plan = buildMusicPlan({duration: 95, groups: new Map([['默认', ['a.wav','b.wav']]]),
    options: {scenePriority:false,maxTracksPerEpisode:1,maxTrackDuration:40},
    trackUses:new Map()});
  assert.ok(plan.segments.length >= 3);
  assert.notEqual(plan.segments[0].track, plan.segments[1].track);
  ```
- [x] Run `node --test test/track-duration.test.js`; confirm missing enforcement failures.
- [x] Implement duration validation, cumulative same-file enforcement and metadata-preserving replacement.
  ```js
  chooseTrack(groups, requestedMood, trackUses, episodeTracks, options.trackMetadata,
    false, outgoingTrack, storyIntensity);
  ```
- [x] Ensure below/exact40, 0, multiple replacements, cumulative same-file intent boundaries, same/similar selection, insufficient alternatives, explicit silence, scene evidence, story segment-count precedence.
- [x] Share fade-aware playback windows between rendering and timeline; existing fade behavior remains unchanged when no cap requires adjustment.
- [x] Pass CLI default/validation/help, signature and generation evidence through `src/mvp.js`.
- [x] Add real FFmpeg tone separation test: output is nonzero, different tone after deadline, no outgoing contribution after the audible limit.
- [x] Run `node --test test/track-duration.test.js test/mvp.test.js test/story-music-plan.test.js`.
- [x] Review scoped changes, fix verified findings, commit planning/rendering tests and implementation.

## Task 2: Desktop Configuration And Persistence

**Files:** `desktop/backend/batch-service.js`, `desktop/renderer/renderer.js`, `test/desktop.test.js`, `tools/check-workbench.cjs`.

**Interfaces:**
- Produce numeric `maxTrackDuration` in defaults, validated batch config, diagnostics, and persisted renderer config.
- Accept finite nonnegative numbers/numeric nonblank strings, preserve zero, reject negative/blank/null/boolean/infinite/malformed input.
- No API secret changes.

- [x] Add failing backend tests:
  ```js
  assert.equal((await inspectBatch(base)).config.maxTrackDuration, 40);
  assert.equal((await inspectBatch({...base,maxTrackDuration:0})).config.maxTrackDuration, 0);
  assert.match((await inspectBatch({...base,maxTrackDuration:-1})).validationError, /时长/);
  ```
- [x] Run focused desktop tests; confirm failures stem from missing behavior.
- [x] Add normalization, validation, diagnostics, persistence and a numeric seconds input under track switching.
- [x] Preserve input zero through save/reload; communicate unlimited state and existing completed-output regeneration behavior.
- [x] Extend actual Electron workbench check: edit, save/reload, disabled/unlimited, batch payload and responsive screenshots.
- [x] Run desktop tests and real Electron workbench check, inspect desktop/minimum screenshots.
- [x] Independent spec/quality review, fix verified findings and commit.

## Task 3: Integration And Release

**Files:** `tools/check-independent-package.cjs`, `package.json`, `package-lock.json`, `docs/releases/v1.0.7.md`, this plan.

- [x] Run `npm test`; all tests pass including legacy silence and duration regression tests.
- [x] Obtain independent whole-change review, resolve important findings before packaging.
- [x] Confirm current remote stable version using GitHub CLI; choose next unused patch version.
- [x] Update version metadata and release notes; preserve all runtime/model assets.
- [x] Build with `electron-builder --win --publish never`.
- [x] Run packaged parity/workflow verification, encrypted settings checks, updater notice and local update-artifact checks.
- [x] Commit verified source, tag and push source/tag atomically without force.
- [x] Create draft release, upload installer/blockmap/latest.yml and verify every asset digest/size.
- [x] Publish only after all upload checks pass.
- [x] Verify public update metadata and updater discovery from the previous stable version.
- [x] Record verification evidence here, commit/push documentation and report download/settings/regeneration steps.

## Progress

- Initial repository: clean `main`, source design commit `3387bf7`, published stable v1.0.6.
- Baseline: 208 tests passed, zero failures before production edits.
- RED: initial 10 duration cases failed; desktop four cases failed before implementation.
- Fractional PCM regression: without the post-normalization sample trim, outgoing music survived until sample 48047, exceeding 1.0006 seconds. Restoring the trim passes the real stereo-isolated PCM test.
- Real 95-second FFmpeg tone test verifies audible fades and old-tone absence after deadlines.
- Desktop sidecar: 17 backend tests and 31 combined backend/encrypted-settings tests passed. Real Electron workbench exits 0 with saved default40/custom37.5/unlimited0 numeric payloads and six responsive screenshots, reviewed visually.
- Completed-output/freeze-tail integration passes: changing the setting preserves completed media; explicit regeneration records the cap and leaves source/video duration unchanged.
- Remote stable confirmed v1.0.6; next patch selected v1.0.7.
- Independent review found three concrete issues (future scarce scenes, blank CLI values, preliminary fractional trim). Each was reproduced RED, then fixed and verified GREEN. A distant 135-second scarce-scene case additionally verifies bounded replacements with fades on/off.
- Final duration suite: 15 passed. Final `npm test`: 228 passed, zero failures, 77863 ms (`build/v1.0.7-tests.log`).
- Independent scoped re-review: spec and quality PASS, no actionable findings; reviewer also ran 216 nearby timing/cap/fade combinations with successful bounds and mandatory changes.
- Windows build exits 0; packaged source parity includes the new module.
- `check-independent-package.cjs` exits 0: packaged custom cap/freeze-tail WAV generation, default 95-second planning, actual English ASR, exactly one loopback story request, intentional zero-sample silence, recursive lyrical selection, same-name dedup, real v1.0.4 accidental-silence reproduction and repair.
- Packaged updater-notice checks exit 0, covering layout, idle discovery, acknowledgement, safe dialogs, cancellation and no automatic install.
- Packaged encrypted API settings functional checks exit 0 using `--packaged --no-screenshots`, covering real IPC, save/reload, masked key, replacement, deletion, layout DOM assertions and no paid calls. The screenshot-enabled run reported Electron `UnknownVizError`; screenshots were explicitly skipped rather than reported as captured. Six duration-setting workbench screenshots remain verified. The optional flag affects only the test harness, not application behavior.
- Local update-artifact validation exits 0, streaming all blockmap chunk checksums and validating latest.yml size/SHA512.
- Installer: `auto-bgm-setup-1.0.7.exe`, 689220081 bytes; SHA256 `53b9f271ba4bb95914a4d3c506fbc2fa0a43abeea0ed895af18e3009953aee98`.
- Verified source commit `1cd443d` and annotated tag `v1.0.7` pushed atomically to the user's repository with no force.
- Release `448638484` published as stable `v1.0.7` at `2026-11-17T13:09:54Z`, only after all three uploaded assets matched local SHA256 and byte counts.
- `verify-update-artifacts.cjs --remote` exits 0: all installer blockmap chunks and latest.yml SHA512/size verified again; public release asset digests/sizes all match.
- `check-published-update.cjs --expected=1.0.7 --from=1.0.6` exits 0: real packaged public GitHub updater discovers v1.0.7, with the correct 689220081-byte installer, without downloading or installing.
- Final committed-tree `npm test` repeat: 228 passed, zero failures, 76882 ms (`build/v1.0.7-final-tests.log`).
- No installation was performed on this computer or the user's other computer. Use the published update there, then explicitly regenerate normal completed media to apply the new duration setting.
