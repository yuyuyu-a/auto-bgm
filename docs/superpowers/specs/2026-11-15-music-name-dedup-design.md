# Music Filename Deduplication

## Approved Behavior

The user confirmed that identical filenames should be treated as the same song,
without comparing audio content. Match the complete filename, including its
extension, case-insensitively. Do not remove suffixes, punctuation or extensions.
Choose one representative deterministically by natural full-path order, with an
ordinal tie-breaker. Keep all source files untouched.

## Processing

Keep the recursive source inventory intact for source/output collision checks.
Deduplicate before media health checks and full-track vocal analysis. All mood
categories referencing a filename share its representative path, so categories
remain available while analysis, eligibility and distinct-track counts use one
physical file. Do not copy confirmations or analysis between different files.
Reuse the existing fingerprinted cache for the selected representative.

If the representative fails validation, exclude that song normally; do not
silently select or trust a different same-name file. Removing the representative
allows the next deterministic file to be checked on the next scan.

## Reporting and Scope

The desktop preflight counts unique filenames, not category memberships. Library
health lists skipped same-name files separately from existing content-duplicate
warnings and does not call their directories empty. Batch summaries include the
number of skipped same-name copies. This change requires no new dependency,
model, API call, settings migration or credential access.

Validate with real local audio fixtures, cache invalidation checks, source
collision protection, batch rendering and the existing desktop UI harness.
Publishing another release or replacing the installed application is not part
of this source change.
