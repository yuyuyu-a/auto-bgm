# Custom Per-Episode Music Limit

The user wants an editable per-episode BGM upper limit. Existing backend and
planners accept arbitrary nonnegative safe integers, but default scene-priority
mode disables the numeric field and bypasses its cap.

## Design

Add an explicit native radio choice, "unlimited" or "custom", to the existing
music quantity section. Derive the mode from current settings, without a new
backend option: scene priority or a zero maximum means unlimited; otherwise
the mode is custom. Custom selection disables scene priority and restores a
positive maximum, using the stored value when possible or the larger of the
default and current minimum. This makes the chosen cap effective in existing
rule and story planning. Unlimited selection sets the maximum to zero.
Enabling scene priority displays unlimited again; the controls must never
claim that a finite cap is active when scene priority bypasses it.

Retain the existing count semantics, minimum validation, local persistence,
strict screening, API settings, story silence and recursive scanning. Custom
values are whole nonnegative safe integers, not a fixed menu or a new low
hard-coded maximum. Zero entered directly selects unlimited; malformed values
remain visible for existing preflight validation. Quantity controls update
without rebuilding a focused numeric input.

## Verification

Use a real Electron renderer test for mode switching, entering 17, focus
stability, local persistence and reload, the configuration sent on start,
unlimited zero, and the scene-priority interaction. Verify real rule planning
with a custom cap above three and story cap/silence behavior using existing
tests. Run full unit and UI checks, inspect desktop/minimum-size screenshots,
rebuild the existing local unpacked preview and repeat UI verification against
packaged renderer sources. Do not call a paid provider or commit user work.
