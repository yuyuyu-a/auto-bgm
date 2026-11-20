# Local Visual Subtitle-Aware BGM Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with focused regression tests.

**Goal:** Add an API-free desktop mode that combines an episode's timed SRT subtitles and sampled video frames to choose only screened tracks from the local music library.

**Architecture:** Add isolated SRT parsing and scene-frame sampling modules, then pass bounded local inputs to a loopback-only llama.cpp runtime using a pinned Qwen2.5-VL GGUF model. Validate structured scene cues and feed them through the existing screened-track planner; the existing rule and API-assisted modes remain unchanged.

**Tech Stack:** Node.js 22, Electron, `node:test`, FFmpeg/ffprobe, official `llama.cpp` Windows builds, Qwen2.5-VL 3B GGUF.

## Global Constraints

- No API key is required; videos, SRT files, sampled frames, prompts, and music files stay on the user's computer.
- Network access is used only after an explicit model/runtime download action; analysis itself is offline.
- Model weights stay outside the installer, use an immutable model revision, and are SHA-256 verified before inference.
- Keep frame sampling bounded, low resolution, cancellable, and clean up temporary images on every exit path.
- Use only strictly screened, enabled, same-name-deduplicated local music tracks; never invent a track or silently replace a failed cue with silence.
- Preserve the existing rule-based and API-backed behavior and keep local-model credentials, prompts, subtitle text, and media paths out of diagnostics and logs.
- Keep the configured continuous-track duration limit and scene-switch rules in force.

---

### Task 1: Parse and pair timed SRT subtitles

**Files:**
- Create: `src/subtitles.js`
- Modify: `src/mvp.js`
- Test: `test/subtitles.test.js`
- Test: `test/mvp.test.js`

**Interfaces:**
- Produce `parseSrt(text, duration)` returning `{ segments, language: null }`, where segments retain exact source start/end seconds and normalized multiline cue text.
- Produce `findSubtitleForVideo(videoPath, subtitlePath, videoCount, duration)` accepting one SRT file for a single video or a directory with exactly one basename match per video.
- Keep JSON transcript loading compatible and prefer an explicitly selected SRT only for the new local visual mode.

- [ ] Test BOM/CRLF, multiline cues, hours and millisecond timestamps, duplicate/overlapping cues, malformed or reversed timestamps, empty files, and cues extending beyond video duration.
- [ ] Test exact basename pairing, a selected SRT file for one video, ambiguous matches, missing files, and rejection of one SRT file shared across multiple videos.
- [ ] Run `node --test test/subtitles.test.js test/mvp.test.js` and confirm the new cases fail before implementation.
- [ ] Implement a strict parser and pairing function without estimating times or silently dropping malformed cues.
- [ ] Wire the local mode's subtitle source into episode processing while leaving JSON and existing API mode behavior unchanged.
- [ ] Re-run the focused tests.

### Task 2: Sample bounded representative video frames

**Files:**
- Create: `src/video-frames.js`
- Test: `test/video-frames.test.js`
- Modify: `src/mvp.js`

**Interfaces:**
- Produce `sampleVideoFrames(videoPath, duration, sceneCuts, options)` returning ordered `{ time, path }` samples.
- Use a maximum of 24 frames, include evenly spaced coverage plus nearby strong scene cuts, scale images to at most 768 pixels wide, and write them only to a unique temporary directory.
- Accept `signal` and `onProgress`; remove the temporary directory in `finally`, including when extraction is aborted or fails.

- [ ] Test the sampling planner with no cuts, many cuts, short videos, long videos, and duplicate timestamps; assert its cap and time ordering.
- [ ] Test actual FFmpeg extraction using a synthetic video, verify image timestamps and dimensions, and test cancellation cleanup.
- [ ] Run the focused tests and confirm they fail for the missing module or behavior.
- [ ] Implement bounded sampling with the existing FFmpeg path and process cancellation conventions.
- [ ] Re-run the focused tests.

### Task 3: Download and verify the optional local runtime and model

**Files:**
- Create: `src/local-vision-assets.js`
- Create: `test/local-vision-assets.test.js`
- Modify: `desktop/main.js`
- Modify: `desktop/preload.js`
- Modify: `desktop/backend/batch-service.js`

**Interfaces:**
- Export immutable manifest data for the selected `llama.cpp` Windows build and `ggml-org/Qwen2.5-VL-3B-Instruct-GGUF` revision, including URLs, byte sizes, SHA-256 hashes, and model/license references.
- Export `inspectLocalVisionAssets(root)`, `downloadLocalVisionAssets(root, { signal, onProgress, fetchImpl })`, and `cancelLocalVisionDownload()`.
- Download to a temporary sibling file, report byte progress, verify the pinned size and SHA-256, then atomically promote it; do not overwrite verified assets on cancellation.
- Save downloaded runtime/model files under the app's per-user data directory, outside `resources` and the installer.

- [ ] Use an injected local HTTP server to test streamed download progress, hash mismatch rejection, truncation, cancellation, atomic promotion, and verified-asset reuse without fetching multi-gigabyte assets.
- [ ] Run `node --test test/local-vision-assets.test.js` and confirm the contract tests fail before implementation.
- [x] Implement resumable/cancellable downloads with bounded retry and SHA-256 verification; reject manifests that lack immutable revision, size, or digest fields.
- [ ] Add main-process IPC for status, explicit download, and cancellation; return only serializable readiness/progress and never expose local paths to the renderer.
- [ ] Re-run the focused tests.

### Task 4: Run local multimodal inference with hardware fallback

**Files:**
- Create: `src/local-vision-runtime.js`
- Create: `test/local-vision-runtime.test.js`
- Modify: `desktop/main.js`

**Interfaces:**
- Export `detectVisionBackend({ platform, env, execFile })`, preferring a compatible NVIDIA CUDA backend when detected and otherwise using the portable Windows Vulkan/CPU route.
- Export `createLocalVisionPlanner({ assets, spawn, fetchImpl })`; bind the inference server to `127.0.0.1` only and stop it on success, failure, or abort.
- Accept sampled image paths, exact SRT cue indices/timestamps/text, available music-category labels, duration, and `signal`.
- Return a validated object with a summary and ordered cues `{ startSegment, mood, intensity, reason, confidence, evidence }`; evidence must reference supplied frame times or subtitle indices.

- [x] Use a fake child process and loopback HTTP server to test CPU/GPU selection, startup failure, GPU-to-CPU retry, valid structured output, invalid JSON, out-of-range indices/times, unknown categories, cancellation, and child cleanup.
- [ ] Run `node --test test/local-vision-runtime.test.js` and confirm the new tests fail before implementation.
- [x] Implement the loopback server client, explicit CPU fallback, strict JSON/evidence validation, timeouts, and prompt construction that requests only cues grounded in supplied frames/subtitles.
- [ ] Prevent all external inference/network calls after assets are installed.
- [ ] Re-run the focused tests.

### Task 5: Reuse the screened local music planner

**Files:**
- Create: `src/local-vision-plan.js`
- Modify: `src/story-music-plan.js`
- Test: `test/local-vision-plan.test.js`

**Interfaces:**
- Export `buildLocalVisionMusicPlan(context, visionPlan, chooseTrack)` and validate cues against the real SRT transcript, video duration, and currently available library categories.
- Route valid cues through `buildStoryMusicPlan` so existing compatibility fallback, intensity selection, track-duration enforcement, scene-switch behavior, and provenance remain authoritative.
- Require every local visual cue to select a music mood; only an explicit validated creative-silence cue may be silent, and it must be shown as such for review.
- Store matched mood, confidence, reason, sampled evidence times, and review state in the saved analysis.

- [ ] Test valid scene cues, exact SRT anchors, similar-category substitution, strict screening, disabled tracks, no-compatible-track errors, explicit silence review, and rejection of invented timestamps/evidence.
- [ ] Run `node --test test/local-vision-plan.test.js test/story-music-plan.test.js` and confirm the new tests fail before implementation.
- [ ] Implement the validated adapter and preserve existing story planner behavior for API mode.
- [ ] Re-run the focused tests.

### Task 6: Integrate batch mode and desktop workflow

**Files:**
- Modify: `desktop/backend/batch-service.js`
- Modify: `src/mvp.js`
- Modify: `desktop/renderer/renderer.js`
- Modify: `desktop/renderer/index.html`
- Modify: `desktop/renderer/styles.css`
- Modify: `desktop/main.js`
- Modify: `desktop/preload.js`
- Test: `test/desktop.test.js`
- Modify: `tools/check-workbench.cjs`

**Interfaces:**
- Add a separately persisted `localVisionEnabled` setting and keep it mutually exclusive with API-backed `storyEnabled`.
- Add SRT file/directory selection, a local-model download/cancel status control, and a preflight warning for CPU inference; do not require API settings.
- Pass progress through existing batch events for asset download, frame sampling, local vision analysis, and planning.
- Include subtitle/model/settings fingerprints so changing source media, SRT, model revision, or mode invalidates completed local-vision outputs.
- Never place prompts, cue text, raw model output, or user media paths in diagnostics.

- [ ] Add service tests for mode validation, SRT selection, model readiness, API settings independence, cancellation, progress serialization, and diagnostic redaction.
- [ ] Add UI regression assertions for the third mode, selecting an SRT file/directory, model download/cancel, CPU warning, and mode conflict prevention.
- [ ] Run the focused service and UI checks and confirm the new cases fail before implementation.
- [ ] Connect local vision mode through the queue, preflight, batch progress, renderer, and existing timeline review.
- [ ] Keep rule mode and API mode UI controls and persistence unchanged.
- [ ] Run `node --test test/desktop.test.js test/mvp.test.js` and `npm run test:desktop-ui`.

### Task 7: Documentation, packaging, and v1.0.9 publication

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Create: `docs/releases/v1.0.9.md`
- Modify: `tools/build-windows.ps1`
- Modify: `THIRD_PARTY_NOTICES.md`

- [ ] Document the no-API workflow, required SRT naming, model download size/disk space, GPU/CPU behavior, offline analysis, review limits, model/runtime sources, and licenses.
- [ ] Bump the application version to `1.0.9` and update the lockfile consistently.
- [ ] Run `npm test`, `npm run test:desktop-ui`, model/runtime manifest checks, packaged Windows smoke tests, and `node tools/verify-update-artifacts.cjs` against the generated installer metadata.
- [ ] Confirm the packaged app contains no user model weights, API key, local media, temporary frame, or machine-specific path.
- [ ] Commit the completed source, push `main`, publish the verified v1.0.9 installer, `.blockmap`, and `latest.yml`, then verify the public release and updater discovery from v1.0.8.
