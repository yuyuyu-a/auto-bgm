# Independent Auto BGM Implementation Plan

> **For agentic workers:** Use executing-plans to implement this approved plan.
> Steps use checkbox syntax for tracking.

**Goal:** Deliver the user's standalone "自动配乐" project and Windows installer.

**Architecture:** Preserve the proven scoring engine and all existing additions.
Use a separate source checkout and standalone GitHub repository with its own
package identity, release links, installer identity, and updater cache.

**Tech Stack:** Node.js >=22.12, Electron, electron-builder NSIS, PowerShell, GitHub CLI.

## Global Constraints

- Product: 自动配乐; package: `auto-bgm`; version: `1.0.0`.
- Repository: `yuyuyu-a/auto-bgm`; default branch: `main`.
- No secrets, user media, dependency trees, or local state in source or installers.
- Preserve MIT attribution, third-party license files, and all existing features.
- Do not modify or delete the existing upstream checkout or GitHub fork.

## Task 1: Create the Independent Source Checkout

- [x] Copy only tracked source into `outputs/auto-bgm`.
- [x] Restore all ten original model archive parts from the cached archive and
  compare every Git blob hash against the original tracked entries.
- [x] Record the approved design and this plan.

## Task 2: Isolate Identity and Update State

Files: `package.json`, `package-lock.json`, `desktop/main.js`,
`desktop/renderer/index.html`, `desktop/renderer/renderer.js`,
`desktop/backend/batch-service.js`, `desktop/update-service.js`,
`desktop/update-cache.js`, `test/desktop.test.js`, `test/update-cache.test.js`,
`README.md`, `LICENSE`.

- [x] Add a real filesystem regression test creating both
  `auto-bgm-updater/pending` and `short-drama-bgm-mvp-updater/pending`.
  Cleanup must remove only the new application's pending installer.
- [x] Run `node --test test/update-cache.test.js` and observe the isolation failure.
- [x] Rename package, version, app ID, product, window, title, navigation branding,
  About identity, default output folder, installer and shortcut.
- [x] Change the provider, release-page link, and updater cache to the new project.
- [x] Update source instructions and preserve upstream MIT attribution.
- [x] Rerun the focused test and desktop-default tests.

## Task 3: Build and Verify

- [x] Reuse verified local dependencies and runtime binaries without copying any
  user settings or private media.
- [x] Run `npm test`, `npm run test:desktop-ui`, story UI and custom-limit checks.
- [x] Build with `electron-builder --win --publish never` and no preview flag.
- [x] Check packaged name/version/app ID/update provider and run packaged UI checks.
- [x] Validate `latest.yml` version/path/size/SHA-512 against the installer and
  confirm the matching blockmap exists.
- [x] Request a read-only review of the independent-project changes and resolve
  any material findings.

## Task 4: Publish the Standalone Repository and Release

- [x] Scan the final source and packaged application for accidental credentials.
- [x] Initialize a fresh Git repository on `main` and commit the tested source.
- [x] Create `yuyuyu-a/auto-bgm` as a standalone public repository.
- [x] Push `main`; create a draft `v1.0.0` release from that exact commit.
- [x] Upload installer, matching blockmap and `latest.yml`; publish only after
  all uploads complete.
- [x] Verify `fork=false`, default branch, release tag, uploaded asset sizes and
  GitHub asset digests. Return the user's new download page.

## Completion Evidence

- Repository: `yuyuyu-a/auto-bgm`, public, `fork=false`, default branch `main`.
- Tested source and release tag: `5f228d787f3725fdf9aefff900c9ac898ef35ae8`.
  Both remote `main` and `v1.0.0` were checked at that commit before this
  documentation-only completion record was added.
- Published stable release `v1.0.0`, not draft or prerelease.
- Installer: 689,214,166 bytes.
- Installer SHA-256:
  `d6736857a4160e507f66549bedf911ad00a51e61f198b244d085a9a90e6750a5`.
- GitHub SHA-256 digests and sizes matched all three local release assets.
- Actual packaged EXE launch: title "自动配乐", version `1.0.0`,
  `updateEnabled=true`; isolated profile used and process exited.
- Packaged local HTTP fixture, real English transcription, output decode,
  explicit-silence samples, encrypted temporary settings, nested library, and
  custom numeric-limit checks passed. No paid provider request was made.
- Original checkout and original GitHub fork were not changed.
