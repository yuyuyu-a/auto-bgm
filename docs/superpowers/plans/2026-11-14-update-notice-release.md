# Update Notice and Release Implementation Plan

> **For agentic workers:** Use test-driven development for the notice task and
> independent task review before publication. Keep the user's current changes.

**Goal:** Publish 1.0.2 with visible update discovery and the existing API fix.

**Architecture:** Add an HTML dialog to the current renderer, driven by the
existing update IPC state. Reuse About for download/progress/restart. Release
through the existing independent GitHub provider.

**Tech Stack:** Electron 45, electron-updater 6.8, NSIS, Node test, GitHub CLI.

## Global Constraints

- Release version is `1.0.2`; owner/repository remains `yuyuyu-a/auto-bgm`.
- Preserve MIT attribution, encrypted API settings and desktop shortcut identity.
- Do not include user API credentials, local media, or machine configuration.
- Never force an automatic download/restart or interrupt a processing task.
- Do not change the original project/fork or replace older release assets.

## Task 1: Visible Update Notice

Files: `desktop/renderer/index.html`, `renderer.js`, `styles.css`,
`tools/check-update-notice.cjs`, and a scoped test preload if needed.

- [x] Write a real-renderer regression that fails because the update dialog is absent.
- [x] Run `electron tools/check-update-notice.cjs` and record the intended RED.
- [x] Add the dialog, version acknowledgement and safe busy-state deferral.
- [x] Reuse `download-update`; dismiss the notice and navigate to About on Download.
- [x] Verify Escape/Later, reload deduplication, newer-version reminders, untrusted
      notes, busy-to-idle transitions and no implicit install/download.
- [x] Capture desktop/minimum-window screenshots and inspect them.

## Task 2: Package and Regression

Files: `package.json`, `package-lock.json`, `README.md`,
`docs/releases/v1.0.2.md`; retain `tools/check-story-settings.cjs`.

- [x] Set package and lockfile root versions to `1.0.2`.
- [x] Document the notice and API form-before-network fix.
- [x] Run `npm test`, `npm run test:desktop-ui`, and the story/settings UI checks.
- [x] Build with `electron-builder --win --publish never`.
- [x] Run the notice/settings checks against `release/win-unpacked/resources/app.asar`.
- [x] Run `electron tools/check-independent-package.cjs` for real local ASR/rendering.
- [x] Verify `latest.yml` version, installer path/size/SHA-512 and matching blockmap.
- [x] Obtain a focused correctness/security/release review.

## Task 3: Publish

Interfaces: committed source SHA -> `v1.0.2` tag -> draft release with three assets
-> verified latest stable release. Keep authentication only in the existing keyring.

- [x] Check staged paths and credential-pattern scan before committing.
- [ ] Commit/push matching source to `main`; tag the tested commit `v1.0.2`.
- [ ] Create a draft with `gh release create v1.0.2 --draft --verify-tag`.
- [ ] Upload `auto-bgm-setup-1.0.2.exe`, its `.blockmap`, and `latest.yml`.
- [ ] Compare remote asset sizes/digests with local SHA-256 results.
- [ ] Publish with `gh release edit v1.0.2 --draft=false --latest`.
- [ ] Check public-provider discovery from an older version without auto-download.
- [ ] Report actual published version, verification and local installation status.

## Verification Log

- Baseline after version/docs changes: `npm test` passed 146/146; desktop,
  story UI and real-main-process API settings checks passed.
- Public discovery harness successfully used the packaged GitHub configuration
  to find published 1.0.0 from fixture version 0.9.0, without downloading.
- Before publication, discovery from 1.0.1 correctly found no 1.0.2 update.
- Artifact validator passed against the existing 1.0.1 installer/metadata;
  the new 1.0.2 artifacts still require build and verification.
- Task 1 implementer confirmed absent-dialog RED and source GREEN, including
  delayed startup, real Escape, version acknowledgement after reload, untrusted
  notes, idle transitions, failed-download/manual-retry and cancellation.
- Task 1 desktop/minimum screenshots were inspected.
- Production build succeeded. Packaged notice and real-main-process API settings
  checks passed; packaged 1440x900/760x520 screenshots were inspected.
- Packaged source parity (including CSS), own update feed, real English ASR,
  loopback story planning, final-video decode and sample-exact silence passed.
- Review identified two validator gaps and a modal keyboard interaction.
  Blockmap ranges and BLAKE2b chunk digests are now verified; public discovery
  rejects credential/host overrides and asserts the actual public provider type.
  Twenty focused validator tests pass. Modal keyboard RED/GREEN also confirmed.
- Final full suite passed 166/166. Final rebuilt package passed notice (including
  keyboard isolation), real-main API settings and real ASR/render/source parity.
- Final installer: 689215200 bytes, SHA-256
  `c530142e2091c20594c9ef7d20c044f0f6fa9bd3653a6d027c08eaa6ede1bf8a`.
- Independent review approved the final production changes. Modal keyboard,
  digest/range and public-provider findings were closed; a final validator-only
  check rejects multiple NSIS blockmap entries, matching the bundled downloader.
