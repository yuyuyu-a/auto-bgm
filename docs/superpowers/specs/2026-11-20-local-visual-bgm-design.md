# Local Visual And Subtitle-Aware Music Planning

## Goal

Improve scene-to-music fit by analyzing a video's sampled frames together with
its timed `.srt` subtitles, then selecting only from the user's screened local
music library. The workflow must not require an API key or upload the user's
video, subtitles, frames, or music.

## User Experience

- Add an optional local visual-planning mode alongside the current rule-based
  and API-backed story-assisted modes. Existing modes keep their current
  behavior.
- Accept a video and its `.srt` subtitle file. For a single episode, allow
  selecting the subtitle file directly. For a batch, allow a subtitle
  directory and pair files by video basename.
- Validate subtitle parsing, duration, and episode pairing before starting.
  Missing, ambiguous, malformed, or badly aligned subtitles produce a clear
  per-episode error instead of guessed timestamps.
- On first use, explain the local model download size and required disk space,
  show download and verification progress, and allow cancellation. Store model
  files outside the installer so the installer does not grow by several
  gigabytes.
- Detect available hardware automatically. Use a supported GPU backend when
  available and otherwise offer CPU inference with an honest performance
  warning. The analysis remains available without an API configuration.
- Show planning progress by stage, make analysis cancellable, and identify
  low-confidence cues as requiring review. Keep the existing timeline,
  audition, and output-review workflow.

## Analysis And Selection

1. Parse `.srt` cue text and timestamps into the existing normalized
   transcript representation. Preserve original timing; never estimate time
   from subtitle text length.
2. Reuse FFmpeg scene-cut detection and extract bounded, low-resolution
   representative frames around scene changes. For long scenes, sample
   additional frames at a capped interval. Do not send full video streams to
   the model.
3. Pass the local vision model only sampled frames, their timestamps, and
   nearby subtitle cues. Require structured output containing scene
   description, dramatic intent, requested mood, intensity, confidence, and
   evidence tied to supplied frame/subtitle timestamps. The model must not
   invent timing or silently turn missing analysis into neutral music.
4. Build a cached local profile for eligible music tracks. Include available
   acoustic descriptors such as energy, tempo, and timbral/instrument cues,
   alongside existing folder category, manual intensity, and cue-in metadata.
   Mark uncertain descriptors as unknown instead of treating model guesses as
   confirmed facts. Keep strict instrumental screening, disabled-track
   exclusions, same-name deduplication, and content-duplicate reporting.
5. Rank compatible screened tracks using the scene intent and the local music
   profile. Preserve existing category compatibility and duration-switching
   constraints. Record the selected track, matched features, reason, and
   confidence in the timeline and review panel.
6. If local analysis cannot produce a safe cue or compatible screened track,
   report the affected time and a specific recovery action. Do not silently
   claim a successful fit or substitute accidental silence.

## Local Runtime And Privacy

- Package the inference runtime with the app and download version-pinned model
  files on demand. Verify model file hashes before loading and retain the
  model license and source information for distribution review.
- Keep model management behind a small local inference adapter so the selected
  runtime/model can be changed without changing subtitle parsing, scene
  extraction, or selection logic.
- No network requests are made during analysis. Network access is used only
  when the user chooses to download or update model files.
- Do not log subtitle text, extracted frames, user media paths, or raw model
  prompts. Store analysis caches locally and invalidate them when the source
  video, subtitle, library audio fingerprint, model, or analysis settings
  change.
- Remove temporary frame files after analysis or cancellation. Preserve
  original videos, subtitles, and music.

## Failure And Recovery

- If model files are absent, offer download or return to the user's existing
  mode; never silently switch modes.
- If GPU initialization fails, explain the issue and offer a CPU retry.
- If CPU inference is impractically slow, allow cancellation without losing
  completed cache entries.
- If subtitle timestamps exceed video duration or alignment is implausible,
  stop that episode with an actionable message.
- Treat malformed model output as an analysis failure; validate all cue
  timestamps and categories before planning or rendering.

## Verification

- Unit-test `.srt` parsing for UTF-8 BOM, CRLF, multiline cues, malformed
  timestamps, duplicate/overlapping cues, and video-duration bounds.
- Test single and batch subtitle matching, including missing and ambiguous
  pairs.
- Test scene-frame sampling limits and stable time alignment using synthetic
  video fixtures.
- Test inference through a fake local runtime for structured output,
  cancellation, invalid output, cache reuse, and cache invalidation.
- Test audio-profile persistence, fingerprint invalidation, uncertain feature
  handling, and selection compatibility without bypassing strict screening.
- Test hardware detection and GPU-to-CPU fallback without requiring a
  particular developer machine.
- Run the full test suite, desktop UI smoke tests, and a packaged Windows
  smoke test. Confirm local analysis produces no media/API network traffic.

## Initial Runtime Candidate

Evaluate a quantized local vision-language model through `llama.cpp`; its
official multimodal documentation lists image input and Qwen2.5-VL support.
Confirm the chosen quantization, projector files, license, Windows packaging,
memory use, and CPU/GPU behavior with a packaged prototype before pinning a
model release. The model must be downloadable independently of the app
installer.

## References

- llama.cpp multimodal support: https://github.com/ggml-org/llama.cpp/blob/master/tools/mtmd/README.md
- Qwen2.5-VL model card: https://huggingface.co/Qwen/Qwen2.5-VL-3B-Instruct
