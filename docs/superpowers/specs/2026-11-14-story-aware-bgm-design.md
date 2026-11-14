# Story-Aware BGM

## Approved Direction

The user selected video plus script/storyboard assistance, and supplied a
third-party API endpoint and credential. Keep transcription, audio screening,
media, and mixing local. Send only the selected story text, timestamped dialogue,
scene-cut timestamps, and eligible music category summaries to that endpoint.
Never add the supplied credential to this repository, browser storage, logs,
diagnostics, generated timelines, or run reports.

## Experience

- Add an optional story-assisted mode to the existing workbench.
- Accept TXT, Markdown, JSON, and Word DOCX scripts or storyboards.
- A single document is valid for a single video; batches use a directory of
  documents matched by video basename. Reject missing or ambiguous matches.
- Enabling story assistance also enables local transcription. Existing external
  transcript JSON remains usable. A real timestamped transcript is required;
  reject missing speech instead of inventing timing.
- Provide API address, model selection, encrypted credential save, connection
  check, and credential deletion in settings.
- Store API settings in the Electron user-data directory. Use Electron
  safeStorage for credentials and refuse plaintext fallback.
- Keep existing rule-based mode unchanged when story assistance is disabled.

## Planning Contract

The model reads the script and transcript together, including English dialogue
with Chinese or English descriptions. It returns an alignment confidence and
ordered music cues anchored to actual transcript segment IDs, not invented
seconds. Each cue has an available mood/category, strength from 1 to 3,
reason, confidence, and review flag. A null mood explicitly requests silence.
The first cue starts at the beginning of the playable music region. Subsequent
cue boundaries come from real dialogue timestamps; the final cue ends before
the configured frozen tail. Out-of-range, duplicate, or unordered anchors,
unknown categories, malformed JSON, and low overall alignment are errors.
Do not silently revert to keyword rules after an AI failure.

Music selection remains restricted to the screened local library. Honor
explicit silence separately from missing candidates. Prefer the requested
strength and reduce repetition. Respect the existing scene-priority switch,
but do not interrupt an explicit silence cue. Missing compatible tracks at a
required switch are actionable errors. Store model, alignment confidence,
source document name, cue reasons, and review flags in analysis artifacts;
never store complete API messages or credentials.

## Resumption And Safety

Changing the source document, enabled mode, endpoint, or model invalidates
completed story-assisted plans. Do not let the old skip-completed shortcut
silently retain keyword-based or obsolete story outputs. Cancellation must stop
in-flight model requests. Use HTTPS except for explicit loopback development
servers, reject credential-bearing URLs and redirects, cap requests and
responses, apply a timeout, and sanitize remote failures.

The model is a planning assistant, not a visual-semantic video model. No video
frames or music audio are sent. Alignment and musical quality require listening;
uncertain cues remain visibly marked for review.

## Verification

Use test-first development for document import, actual HTTP payloads,
credential storage, cue validation, real timeline selection, recovery
invalidation, and desktop preflight. Use a local HTTP fixture to exercise
network failures without billing. Run the existing Node and Electron UI tests,
a minimal synthetic real-provider request, and a packaged synthetic-media
render. Rebuild the existing Windows preview so the source and executable agree.
