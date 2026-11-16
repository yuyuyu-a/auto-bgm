# Similar Music Fallback

## Approved Direction

The user requests approximately similar library music when the requested style
is missing, instead of accidental "中性留白". This refines the previously
discussed no-accidental-silence behavior.

## Selection Contract

- Use screened local music only; disabled and unverified tracks remain excluded
  by the existing library filter. Do not change deduplication.
- Prefer the requested category and its existing naming aliases. If unavailable,
  use explicitly compatible categories, then a neutral category. Never choose
  an opposing emotion merely to satisfy a track-count target.
- Compatibility is directional and ordered: tension -> suspense, anger, gloom;
  anger -> tension, suspense, gloom; suspense -> gloom, tension;
  gloom -> sadness, suspense; sadness -> gloom; romance -> warmth;
  warmth -> romance, inspiration; cheerful -> triumphant, inspiration;
  inspiration -> triumphant, warmth, cheerful;
  triumphant -> inspiration, cheerful.
- Category similarity uses folder labels, not acoustic emotion classification.
  Track intensity, episode uniqueness, reuse count, and natural filename order
  resolve choices within a compatibility tier. Exact-category unused tracks
  precede similar unused tracks, which precede neutral unused tracks; when no
  new track is needed, exact-category reuse remains preferable.
- Preserve inferred emotion even if its folder is absent. Sustained evidence
  rules and negation safeguards stay intact. Brief isolated cues must not
  suddenly become sustained emotion evidence.
- With no reliable emotion and no neutral category, choose the least-intense
  available screened track, mark it for review, and continue its category until
  sustained evidence or an existing reset policy changes the request.
- Every rule-based segment must have a track, or planning fails with an
  actionable message. Required scene changes must still change files.
- Preserve deliberate story `mood:null` silence and freeze-tail behavior.
  Story category validation still rejects invented categories; valid existing
  empty categories may use compatible substitutes. The model is instructed
  to choose similar available categories when an exact style is missing.
- Record requested category, actual selected category, match type, and a
  human-readable replacement reason. Fallback choices require review.
- Equivalent named folders form one selection tier, including prefixed folder
  names. Explicit category labels take precedence over ambiguous aliases.
- A sustained intent change remains represented even when both intents use the
  same compatible category. Such a continuation may reuse a file if no scene
  change requires a different track; a coincident required scene still wins.
  Render a reused file as one uninterrupted playback span while preserving the
  separate intent records. Do not restart the song or crossfade it with itself.
- With uncertain intent, minimum-count supplementation retains the first
  selected category rather than reopening the entire library. Missing compatible
  alternatives yield a count warning, not opposing-style filler.

## Existing Outputs

Advance the planning version. Preserve owned completed outputs during normal
resume, but flag earlier planning results, including accidental silence, for
regeneration. Never overwrite unowned outputs or silently rewrite prior work.

## Verification And Scope

Test absent exact styles, alias names, opposing categories, uncertain emotion
with large libraries, intensity/reuse order, mandatory alternatives, strict
screening, deliberate story silence, and old-output resume. Run the complete
Node suite and desktop UI smoke test. No new dependencies, credentials,
paid requests, release uploads, or installer replacement are part of this change.
