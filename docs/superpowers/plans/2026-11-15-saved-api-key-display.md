# Saved API Key Display

User explicitly canceled the multiple-provider design. Keep the existing single
encrypted API profile, its file format, IPC and private-key handling.

## Approved Behavior

- Saved credentials appear as a fixed mask and saved status, never as an empty
  required-looking password field and never as the decrypted key.
- A Replace command opens an empty password input; Cancel discards that draft.
- Saving other settings, getting models or testing the connection without a new
  key reuses the encrypted saved key. The mask is never a submitted value.
- Navigation/reload drops any unsaved key and retains the saved status.
- Existing clear-key behavior returns to the empty initial-key field.
- No provider list, storage migration, key reveal, paid API test or GitHub release.

## Tasks

- [x] Stop the UI agent before implementation; no provider code was written.
- [x] Extend `tools/check-story-settings.cjs` with actual saved-mask, replace/cancel,
  reload, blank-key reuse, replacement and deletion assertions; run RED.
- [x] Implement the isolated key-field rendering in `desktop/renderer/renderer.js`
  and matching responsive styles, retaining all existing IDs/IPC.
- [x] Run GREEN with real Electron/native encryption and loopback-only requests,
  full node tests, workbench and update-notice regressions; inspect screenshots.
- [x] Build local version 1.0.4, run packaged/installed settings checks, preserve
  private profile and desktop shortcut during upgrade.
- [x] Record results; no GitHub release published as part of this change.

## Evidence

- `build/saved-api-key-red.log`: expected missing saved-status assertion fails.
- `build/saved-api-key-green.log`: actual Electron UI shows mask on save/reload,
  cancel/navigation discard drafts, old/replacement keys authenticate correctly,
  deletion clears the synthetic key; native encryption and no completion requests.
- `build/saved-api-key-tests.log`: 173 tests passed, zero failures.
- `build/saved-api-key-ui.log`: desktop workbench regression passes.
- `build/saved-api-key-notice.log`: source update-notice regression passes.
- `build/saved-api-key-packaged-settings.log`: all saved-key tests also pass
  through the packaged main process, preload, renderer and native encryption.
- Desktop and 760x520 saved-status screenshots inspected; controls fit without overlap.
- Independent read-only review found no important/blocker issues. Its minor
  programmatic-navigation observation was reproduced RED and fixed by resetting
  replacement mode on every render outside Settings; the covering Electron check
  passes (`build/saved-api-key-navigation-red.log`, `build/saved-api-key-green.log`).
- Scoped re-review confirmed that the navigation fix addresses the observation,
  with no new important or minor findings.
- Final local 1.0.4 build and installer/blockmap/update-metadata verification pass.
  Installer SHA-256:
  `55207b4510cf85bb184e65991ec1e8014fca7654b59e8cbee622cc7c6c7b02a3`.
- Final installer applied locally; installed `app.asar` matches the tested
  package. All 71 backed-up private profile files remain byte-for-byte unchanged,
  and the desktop shortcut retains its existing target.
- `electron tools/check-story-settings.cjs --installed` passes all settings
  assertions against the final installed application with an isolated temporary
  profile and synthetic loopback credentials.
