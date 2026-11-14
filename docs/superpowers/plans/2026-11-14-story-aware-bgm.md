# Story-Aware BGM Implementation Plan

> **For agentic workers:** Use test-driven-development and scoped parallel
> workers; report test commands and changed files. Do not access user secrets.

**Goal:** Add optional video-plus-script music planning using a configurable
third-party model, real transcript anchors, and the user's screened local music.

**Architecture:** Separate document loading and AI transport/validation from
local track selection. The Electron main process owns encrypted settings and
the model callback; renderer configuration never contains a saved key.

**Tech Stack:** CommonJS Node >=22.12, Electron, node:test, existing FFmpeg and
faster-whisper; use Mammoth for DOCX extraction.

## Global Constraints

- Follow `../specs/2026-11-14-story-aware-bgm-design.md`.
- Never hard-code or disclose the user credential.
- Keep edits scoped; do not alter unrelated updates or model assets.
- Actual provider tests use tiny synthetic text, not user material.
- Configuration: `storyEnabled: boolean`, `storyPath: string`.
- Main-process runtime callback:
  `createStoryPlan({document, transcript, groups, sceneCuts, duration, signal})`.
- AI settings IPC returns only `{baseUrl, model, keyStored, models?}`.
- Credential IPC input is transient `{baseUrl, model, apiKey?, clearKey?}`.

## Task 1: Story Document And Model Boundary

Files: `src/story-input.js`, `src/story-director.js`,
`test/story-director.test.js`, `package.json`, `package-lock.json`.

- [x] Write tests for document-basename matching, ambiguity, size bounds,
  DOCX extraction, and invalid JSON.
- [x] Watch them fail, then implement
  `loadStoryDocument(storyPath, videoPath, {singleVideo})` returning
  `{name, text, signature}`. SHA256 hashes content and name.
- [x] Write actual local-HTTP tests for
  `listModels(settings, {signal})`,
  `requestStoryPlan(context, settings, {signal})`, and
  `normalizeStoryPlan(raw, {transcript, groups, duration})`.
- [x] Watch failure, then implement bearer-auth chat-completions transport.
  Normalize root API addresses to `/v1`, reject redirects and non-loopback HTTP,
  validate response sizes and bounded JSON output, and redact errors.
- [x] A plan is `{summary, alignmentConfidence, cues}`. A cue is
  `{startSegment, mood: string|null, intensity: 1|2|3,
  reason, confidence, review}`. Anchors are strictly increasing, begin at zero,
  and refer to real transcript segments. Overall alignment must be >=0.5.
- [x] Run focused tests with `node --test test/story-director.test.js`.

## Task 2: Encrypted Electron Configuration And UI

Files: `desktop/story-ai-settings.js`, `desktop/main.js`,
`desktop/preload.js`, `desktop/renderer/renderer.js`,
`desktop/renderer/styles.css` if needed, `test/story-ai-settings.test.js`,
and focused UI test helpers.

- [x] Write tests for encrypted-only persistence, blank-key preservation,
  clearing credentials, safe public state, and refusal without encryption.
- [x] Watch failure; implement
  `createStoryAISettings({filePath, safeStorage})` with async
  `readPublic()`, `readPrivate()`, `save(input)`.
- [x] Register `story-ai:settings`, `story-ai:save`, `story-ai:models`,
  `story-ai:test`, and `dialog:story-file`.
- [x] Preload API names:
  `storyAISettings`, `saveStoryAISettings`, `storyAIModels`,
  `testStoryAI`, `chooseStoryFile`.
- [x] Main initializes `runtime.createStoryPlan` using `requestStoryPlan`
  and the private settings. `app:info` adds `storyAI` public settings.
- [x] Add `storyEnabled` switch and `storyPath` file/directory selection;
  default disabled. Enable transcription when toggled on.
- [x] Add restrained settings for address, model, blank password field,
  save/check/models/delete controls. Password never enters `state.config`,
  localStorage, logs, or run settings.
- [x] Make preflight and analysis evidence show readiness and story
  planning status; retain existing workbench behavior.
- [x] Run settings tests and extend the Electron UI fixture.

## Task 3: Local Timeline And Batch Integration

Files: `src/story-music-plan.js`, `src/mvp.js`,
`desktop/backend/batch-service.js`, `test/story-music-plan.test.js`,
focused additions to `test/mvp.test.js` and `test/desktop.test.js`.

- [x] Write tests proving story cues override keyword moods, real ASR anchors
  determine times, explicit silence is preserved, incompatible candidates
  error, required scene switches work, and original mode is unchanged.
- [x] Watch failure, then implement
  `buildStoryMusicPlan(context, chooseTrack)` returning the same plan shape as
  the existing builder with added `story` provenance.
- [x] Extend `chooseTrack` with an optional numeric intensity override.
- [x] Validate story path/enabled options and auto-enable transcription.
- [x] On rendering, load the matched document, require a usable transcript,
  request story cues, build local music, and save provenance in `analysis.story`.
- [x] Add a story input/settings fingerprint before skip-completed checks;
  include document signature and model/endpoint revision, never credentials.
- [x] Existing story outputs are reused only for identical story signatures.
  Switching story mode off invalidates old story-assisted outputs.
- [x] Run focused tests and existing suite.

## Task 4: Verification And Delivery

- [x] Run full `npm test`.
- [x] Run Electron UI checks at normal and minimum window sizes, capture
  story settings/import screenshots and inspect them.
- [x] Verify the supplied service supports models and one tiny synthetic
  story plan. Store the credential only through encrypted settings.
- [x] Run synthetic-video end-to-end with local fixture provider and FFmpeg;
  verify timeline, deliberate silence, mix, and metadata without network.
- [x] Review the diff for secret leakage and recovery/cancellation risks.
- [x] Build the Windows preview using existing runtime assets; verify the
  rebuilt executable includes new source.
- [x] Update local launcher/docs and report exact tested capabilities and
  any remaining provider or real-user-video limitations.

## Review Follow-Up

- [x] Reject JSON-escaped credential echoes after decoding and normalization.
  Confirmed RED with a real local HTTP fixture, then GREEN.
- [x] Share timestamped-transcript validation and retain blank-segment indices.
- [x] Allow empty eligible categories only when every returned cue is silence.
- [x] Return a resolved story source path only with `{includePath: true}` for
  local write protection; do not include it in provider input.
- [x] Protect story sources against all generated targets, cache and logs.
- [x] Track media fingerprints separately during partial regeneration.
- [x] A forced model replan can differ for unchanged inputs: conservatively
  invalidate unselected plan-dependent artifacts while retaining their paths
  and ownership. The regression failed before the fix and passed afterward.
- [x] Fix story-directory drops, network badge, stage labels and empty-library
  preflight; rerun UI regression.

## Final Verification

- `npm test`: 136 passed, 0 failed, 0 skipped.
- `npm run test:desktop-ui`: passed.
- `electron tools/check-story-ui.cjs`: passed. Normal and 760x520 content
  screenshots inspected; story API fields and controls fit.
- `git diff --check`: passed.
- Windows preview rebuilt with existing verified runtime assets, without
  signing or publishing. Preview metadata disables upstream automatic updates.
- `electron build/check-story-package.cjs`: passed using packaged source and
  runtime assets. Verified source parity for ten changed runtime files, Mammoth
  inclusion, actual encrypted-settings decryption, English local transcription,
  one loopback fixture request, BGM/silence rendering, zero-valued silence
  samples, decodable final video, and no credential in output text artifacts.
- Final packaged smoke output: `build/story-package-verified-RUvcfO/`.
- Real provider analysis had already passed on synthetic English dialogue.
  Packaging checks replayed that captured plan locally, without more provider
  billing or user-media upload.
- User material and artistic quality remain untested; final listening is
  required. No commits, pushes, upstream releases, or user-media changes made.
