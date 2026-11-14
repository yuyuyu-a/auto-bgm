# Update Notice and Release Design

## Approved User Intent

The user requested in-app new-version notification, download and restart-to-install,
and publication of the preceding API settings fix to `yuyuyu-a/auto-bgm`.
Keep the existing user-confirmed update flow and make discovery visible outside About.

## Approach

Reuse the existing `electron-updater` service and About update page. A small native
HTML dialog announces an available version, displays escaped version/release notes,
and offers Download Update or Later. Download navigates to the existing About
progress/install controls; no duplicate downloader or installer is introduced.
An About-only red dot is less visible; automatic forced installation is not wanted.

## Behavior

- Only actual `available` states from an enabled updater can open the dialog.
- Startup data must finish loading before opening a notification.
- Defer notifications during a running/starting batch, library analysis, API settings
  actions, or another modal. Reconsider when the application becomes idle.
- The same version is not repeatedly announced after dismissal, Escape, or Download;
  save this acknowledgement locally. A later version can be announced again.
- Retain the About red dot and manual check/download/install workflow.
- Do not automatically download, quit, install, downgrade, or enable prereleases.
- Keep backend batch-running installation guards unchanged.
- Renderer state, credentials and user media are not part of the published source
  or installer. Provider text is rendered as text, never trusted HTML.

## Release

Publish version `1.0.2`, including the local `1.0.1` API form-before-network fix.
Build a production Windows x64 NSIS installer, matching blockmap and `latest.yml`.
Create a draft release, upload and verify all assets, then publish it as latest.
Commit/push matching source and tag without rewriting older releases.

Existing 1.0.0/1.0.1 clients already have the About updater; the new dialog is
available after upgrading to 1.0.2. Local installation is optional and must not
interrupt a running application or alter saved settings.

## Verification

Exercise the real renderer in Electron with isolated local state and updater
boundary fixtures: idle notification, deduplication/reload, newer version,
busy deferral, Escape, download handoff, no implicit installation, untrusted text,
and 1440x900 / 760x520 screenshots. Retain the complete existing suite and API IPC
regression. Check packaged source parity, bundled runtimes, installer hashes,
remote commit/tag/assets, and real public-provider discovery without downloading
or executing an update during the discovery test.
