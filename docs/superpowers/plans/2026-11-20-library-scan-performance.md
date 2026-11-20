# Music Library Scan Performance Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with focused regression tests.

**Goal:** Reduce repeated disk I/O during large music-library screening without changing strict instrumental eligibility or duplicate detection.

**Architecture:** Persist completed vocal-analysis entries in checkpoints rather than serializing the growing cache after every track. Store each inspected file's SHA-256 beside its existing size/mtime-based health fingerprint and reuse that digest while the fingerprint remains unchanged.

**Tech Stack:** Node.js 22, Electron main-process services, `node:test`, FFmpeg.

## Global Constraints

- Keep strict instrumental screening, manual confirmation, disable state, same-name deduplication, and content-duplicate reporting behavior.
- Preserve completed analysis on normal completion and graceful cancellation.
- Do not read or modify user music files.
- Keep all new content hashes bound to the existing file fingerprint.

---

### Task 1: Checkpoint vocal analysis results

**Files:**
- Modify: `src/music-library.js`
- Test: `test/music-library.test.js`

- [x] Add a focused regression test with 27 short valid audio files; observe cache-file writes and assert two writes (at the 25-track checkpoint and final flush) and all analysis results remain cached.
- [x] Add a cancellation test that aborts after progress reports the first completed track; assert the operation rejects as aborted and the completed track is present in the persisted cache.
- [x] Run the focused tests and confirm they fail because the current implementation writes each track and does not explicitly flush dirty data on cancellation.
- [x] Implement a 25-track checkpoint, flush any remaining dirty data at completion and in the cancellation path, and keep classifier cleanup in `finally`.
- [x] Run `node --test test/music-library.test.js test/music-name-dedup.test.js`.

### Task 2: Cache content hashes with health results

**Files:**
- Modify: `desktop/backend/batch-service.js`
- Test: `test/music-name-dedup.test.js`

- [x] Add a regression test that checks an unchanged library twice with an injected hash function; assert the first check hashes each representative once and the second check reuses the saved digests.
- [x] Add coverage that a changed size/mtime fingerprint causes that file's digest to be recalculated.
- [x] Run the focused test and confirm the unchanged second check currently hashes files again.
- [x] Reuse a SHA-256 value only when its stored health entry fingerprint matches the freshly inspected file fingerprint; store newly computed digests in `library.health` before writing the cache.
- [x] Ensure cancellation errors are propagated rather than reported as unreadable files.
- [x] Build a file-to-health map once before per-category usable counts, avoiding repeated full-list searches.
- [x] Run `node --test test/music-name-dedup.test.js test/mvp.test.js`.

### Task 3: Release preparation and verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

- [x] Bump the application version to `1.0.8` and document the scan-cache performance changes without claiming a measured wall-clock speedup.
- [x] Run `npm test` and the desktop UI regression suite.
- [x] Build the Windows installer and verify the generated updater metadata and artifact hashes.
- [x] Commit and push the source branch, then publish the verified v1.0.8 GitHub release so installed copies can discover the update.
- [x] Verify the published installer, blockmap, and `latest.yml` sizes and SHA-256 digests with `node tools/verify-update-artifacts.cjs --remote`.
- [x] Verify the packaged updater discovers v1.0.8 from v1.0.7 with `npm exec -- electron tools/check-published-update.cjs --expected=1.0.8 --from=1.0.7`.

Release: https://github.com/yuyuyu-a/auto-bgm/releases/tag/v1.0.8
