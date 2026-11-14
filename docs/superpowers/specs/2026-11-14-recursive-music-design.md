# Recursive Music Library Scanning

## Scope

Discover supported audio files at every real directory depth below the selected
music root. Keep the existing `scanMusic(musicDir) -> Map<string, string[]>`
interface so preflight, drag import, health checks, manual screening, story
planning and rendering all use the same catalog. Do not move or rename sources,
alter credentials, add dependencies or change vocal-screening requirements.

## Category Rules

- Audio directly in the selected root remains in the default category.
- The first subdirectory supplies the category for its descendants.
- A deeper folder that matches an existing mood name or alias becomes the
  category for that subtree. Retain its actual folder name, as flat libraries do.
- Ordinary album or collection folders inherit the current category.
- If no folder matches a known mood, keep the first-level custom category.
- Sort each category by natural filename order, with the full relative path as
  a deterministic tie-breaker. Keep separate files with identical basenames.
- Skip directory links/junctions and file links, as the previous shallow scan
  did, to avoid cycles, duplicates and traversal outside the selected tree.
- Surface unreadable-directory errors rather than silently omit music.

Examples: `tense/album/song.wav` inherits the category of `tense` when `tense` is
the first directory. Chinese mood folders such as `collection/紧张/album/song.wav`
use `紧张`. Existing aliases are reused, not a new audio mood classifier.

## Health Checks

Keep the existing top-level empty-directory report. Determine emptiness by
whether a scanned file lies below that directory, not whether its name is a
category: a collection containing nested mood folders is not empty.

## Verification

First demonstrate failures on nested-directory fixtures. Cover old flat/root
behavior, nested albums and collections, custom labels, repeated basenames,
supported extensions, empty trees and link cycles. Exercise desktop preflight,
drag import, health checks, manual screening and real FFmpeg rendering using
nested music. Run the complete tests and desktop UI smoke, then rebuild the
local Windows preview and verify packaged scanning and rendering.
