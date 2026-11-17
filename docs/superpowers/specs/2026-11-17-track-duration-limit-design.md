# Single-Track Continuous Duration Limit

## Approval And Scope

The user approved a configurable continuous-playback limit, initially 40 seconds,
with real track changes, similar-style substitutions, saved settings, and the
same behavior in rule-based and story-assisted planning.

This document records that design for review before implementation. It does not
claim that the feature is implemented, packaged, published, or installed.

## Behavior

- Add a saved numeric setting for maximum continuous playback of one track.
  The desktop default is 40 seconds; zero disables the limit.
- Measure a continuous run of the same track across adjacent intent segments.
  Restarting the file or splitting its timeline labels does not reset the clock.
  A genuine different track or explicit story silence ends the continuous run.
- No audible run may exceed the configured limit. Account for transition fades;
  do not silently turn 40 seconds into 40 seconds plus the outgoing fade.
- At a required duration change, select a different screened local track using
  the existing same-style, similar-style, and compatible-neutral selection.
  Preserve existing cue-in, intensity, vocal-screening, and deduplication rules.
- If no different compatible track exists, fail with an actionable time-specific
  error. Do not insert accidental silence, reuse the outgoing track as a fake
  change, or bypass strict instrumental screening.
- A required duration change takes priority over the per-episode segment limit.
  Keep existing scene changes, dialogue emotion boundaries, and story evidence.
- Preserve explicit story silence and the configured silent freeze tail.
- Apply to both rule-mode and story-assisted plans. Never send an additional
  paid API request just to enforce the duration limit.
- Saving the setting does not rewrite completed media in the background. Apply
  the limit to newly generated or explicitly regenerated outputs; explain this
  alongside the existing completed-output resume setting.

## Integration

- Reuse desktop configuration normalization, validation, persistence, numeric
  controls, diagnostics, and existing local track selection.
- Share duration enforcement between both planning paths, including cumulative
  same-file playback and final rendered playback windows.
- Keep timeline selection reasons, segment counts, and playback rendering
  consistent after inserting duration-driven changes.
- Carry the value through batch options and generation provenance. Keep source
  media, manually owned output protection, encrypted API settings, and the
  verified v1.0.6 legacy-silence repair unchanged.
- Do not introduce dependencies, new models, unrelated layout changes, or a
  provider-specific implementation.

## Verification

- Red/green unit coverage: below, exactly at, and above the limit; multiple
  replacements; cumulative same-file intent segments; disabled and invalid
  limits; same-style and similar-style replacement; insufficient alternatives.
- Both planners: duration changes override the segment-count restriction,
  while story anchors, intentional silence, and freeze tails remain intact.
- Rendering integration: decode output with FFmpeg and verify track changes
  and fade-aware duration bounds, including short neighboring segments.
- Desktop checks: setting input and disabled state, save/reload, batch option
  propagation, validation errors, desktop and minimum-width screenshots.
- Run the full Node suite and existing legacy-silence regression coverage.
- Obtain independent review before claiming implementation is complete.
- Building or publishing a new release is separate from this design approval.
