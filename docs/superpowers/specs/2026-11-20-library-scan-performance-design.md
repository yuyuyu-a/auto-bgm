# Music Library Scan Performance Design

## Context

The desktop app can screen very large music libraries. During strict screening, each completed vocal analysis currently rewrites the full growing JSON cache. The library health check also reads every representative audio file in full to calculate SHA-256 on every run, even when that file has not changed.

## Design

Keep the existing full-track YAMNet analysis and strict eligibility rules. Write analysis results to the existing atomic cache in checkpoints of 25 completed tracks, flush any remaining entries when the scan completes, and flush pending entries during graceful cancellation or another exit from the loop.

Reuse the existing health-cache fingerprint, based on file size and modification time. Save each representative file's SHA-256 beside its health entry; reuse it only while the fingerprint matches. If the file changes, recompute its digest. Keep content-duplicate detection and report semantics unchanged, and propagate cancellation instead of marking an interrupted hash read as a damaged file.

Build a file-to-inspection map once when calculating per-category usable counts, so summary generation remains linear in the number of tracks rather than repeatedly searching the full track array.

## Trade-offs

The initial strict analysis still decodes and classifies each uncached full track; this change does not weaken detection or parallelize the classifier. A process crash may require redoing at most 24 analyses since the last checkpoint, while normal completion and graceful cancellation persist every completed result. Cached digests use the repository's existing size/mtime invalidation convention; a content change that preserves both metadata values cannot be detected by that convention.

## Verification

Use focused tests to verify checkpoint frequency, persisted results on cancellation, duplicate reporting, digest reuse for unchanged files, and digest invalidation when size/mtime changes. Run the full unit suite and desktop UI checks before publishing.
