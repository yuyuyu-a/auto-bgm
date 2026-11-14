# Independent Auto BGM Project

## Approved Scope

The user requested an independently maintained project and approved the product
name "自动配乐". Publish it as `yuyuyu-a/auto-bgm`, with `main` containing all
previously requested story-assisted scoring, configurable provider credentials,
recursive music-library scanning, and custom per-episode segment limits.

## Identity and Compatibility

- Product, window, page, About panel, and shortcut name: 自动配乐.
- Package: `auto-bgm`; first independent release: `1.0.0`.
- Installer: `auto-bgm-setup-1.0.0.exe`.
- Windows app ID: `com.yuyuyua.autobgm`.
- Repository, homepage, release links, and updater provider belong to
  `yuyuyu-a/auto-bgm`.
- Keep the existing fork and source checkout unchanged. Create a separate source
  checkout and a new standalone repository; do not rewrite or delete old history.
- Give the new app a separate update cache and output default, so cleanup cannot
  remove an upstream installation's pending update.
- Keep upstream copyright and MIT license; credit the upstream project in source
  documentation and the About panel. Add copyright for the independent changes.
- Do not publish machine configuration, API keys, user media, build intermediates,
  or dependencies. Preserve bundled third-party licenses and verified models.

## Verification and Release

Exercise update-cache isolation with a failing regression test before editing
production code. Run the full Node tests, Electron UI checks, and packaged custom
limit/story/library checks. Inspect packaged identity and GitHub updater settings.
Build the NSIS installer with preview mode disabled; validate SHA-512 metadata and
publish the installer, blockmap, and latest.yml together. Verify the independent
repository is not a fork and that `main` and the release tag match the tested
source commit. No paid API requests are part of verification.
