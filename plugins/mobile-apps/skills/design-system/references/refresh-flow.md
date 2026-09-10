# Optional Design Refresh and History

Read only for an existing-brand edit, drift, reskin, theme, or history request. Do not restart the ordinary brand-input/style-picker flow.

## Refresh / reskin

1. Read the requested dimension in `brand/design-system.md`, the actual `brand/tokens.ts`, and relevant config/font/theme consumers. If the spec is missing, reconcile existing tokens into a compact spec; if tokens are missing, materialize approved values.
2. Compare relevant values, normalizing legacy hyphenated labels and typography units. Surface drift rather than overwriting hand edits. Ask only about unresolved conflicts; a clear request to adopt one side already answers that question.
3. Explain the small affected scope, then update the requested choices and tightly coupled contrast/role bindings. Preserve unrelated fields, user negatives, existing imports, and required sidecars. Do not refuse a clear multi-dimension request merely because it changes more than one field.
4. Refresh the compact spec and tokens. `--reskin` may replace the visual direction, but does not automatically open a comparison picker, rewrite every screen, or change data/native contracts.
5. Existing app: apply [Tamagui integration](./tamagui-integration.md) for changed tokens/fonts/themes; coordinate source composition changes through `/edit-app`. Token edits alone do not automatically change hardcoded component choices or load fonts.
6. Regenerate `_design_preview.html` using explicit intent mode for the changed design. Only regenerate `preview.html` in implementation mode **after** source/config changes, reading current sources. Never relabel intent as implementation.
7. Execute [rendered preview review](../../../shared/references/rendered-preview-review.md) for regenerated full-screen previews. Preserve actual browser attempts and incomplete evidence; old review records cannot be restamped after a design change. Validate and show the actual delta; foreground alone records acceptance through an available host question tool. A child returns unresolved decisions as `NEEDS_CONTEXT`. Update the memory bank's Current phase/Pending decision; Approved preview changes only on acceptance with its path + plan/design revision, never as runtime proof. No duplicated design bundle.

| Dimension | Check affected consumers |
|---|---|
| `palette` | Light/dark aliases, status contrast, provider themes |
| `typography` | Actual font files/loading, `createFont` roles, screen bindings |
| `components` / `density` | Used size/space/radius tokens plus affected composition/targets |
| `negatives` | Explicit user rules and affected screens; not merely advisory if user-required |
| `motion` | Actual supported animation and reduced-motion paths |

## Dark mode / named theme

`--add-dark-mode` derives or imports an accessible dark palette and uses the **existing** host config/provider mechanism. Do not add an app-owned ThemeProvider, separate `useTheme` runtime, or another root wrapper. Follow the integration reference's two-theme path.

Preserve an existing `brand/tokens.dark.ts` / named-theme import if runtime uses it. Create an additional palette export/file only when the requested distinct theme needs it, in the project's established shape. Verify the config actually consumes it; unused palette sidecars do not enable themes.

For `--add-theme <name>`, confirm how the app selects the variant using its existing theme mechanism. Do not claim variant selection works without source wiring. Baseline light/dark provider props must remain consistent.

## Gallery and comparisons

Only when requested: [gallery](./preview-template.md) writes `brand/design-system.html`; [style picker](./vibe/style-picker.md) writes `_design_vibe.html`. Neither is needed for an ordinary refresh. Their previews follow the same actual-token and mock-boundary rules.

## History commands

History is opt-in; ordinary creation/refresh does not create snapshots or a workspace backup.

- `--history`: list existing `brand/.history/` snapshots; no history is a valid result.
- `--diff <timestamp>`: safely resolve a named existing snapshot inside `brand/.history/` and compare against current design/tokens. Reject traversal and unknown entries.
- `--rollback <timestamp>`: show the affected files and get confirmation before writing. Snapshot the current affected brand files **before** restoration; never the whole workspace. Restore matching spec/tokens together, or regenerate tokens from a legacy spec-only snapshot and report that approximation. Preserve/reconcile consumed dark/named-theme files, then reapply integration and refresh the appropriate preview.
- If the user asks to retain history on edits, snapshot affected files before mutation. Do not silently prune or delete existing history.

No estimated “zero-token deterministic” promise: these workflows are model-authored edits and previews.
