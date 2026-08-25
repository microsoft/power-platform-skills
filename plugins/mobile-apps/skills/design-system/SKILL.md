---
name: design-system
description: Creates the structured design recipe and Tamagui brand system for an Expo/React Native Power Apps mobile app, including design-recipe.json, design-system.md, tokens.ts, and an optional HTML gallery.
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, Task, WebFetch
model: opus
---

# Design System Dispatcher

Select exactly one mode before reading another instruction file. Do not preload
references or combine modes.

## Automatic Native Prototype

Use this mode only when all conditions hold:

- `CODE_APPS_NATIVE_ORCHESTRATING=1`;
- `.tmp/prototype-semantic-plan.json` exists;
- no explicit brand, Figma, screenshot, gallery, style, refresh, reskin, dark
  mode, named-theme, history, diff, rollback, sibling-app, or Power Pages option
  was requested.

Read only [`automatic-native.md`](./automatic-native.md), then execute it. Do
not read `optional-modes.md` or anything under `references/`. This route has no
brand question, style/cost picker, browser preview, or design model call.

## Optional And Standalone Modes

For every other invocation, read [`optional-modes.md`](./optional-modes.md) and
follow its mode-specific routing. That file owns standalone authoring, explicit
brand input, Figma, screenshot/design intake, gallery, style comparison,
refresh, reskin, dark/named themes, history/diff/rollback, sibling extraction,
and Power Pages input.

Load a reference only after the selected optional workflow names it. The closed
ownership inventory is [`reference-ownership.json`](./reference-ownership.json).
A file absent from that inventory is not runtime authority.

## Result

Return `DONE` only after the selected workflow's deterministic validators pass.
Return `BLOCKED: <path and reason>` for missing or contradictory AI-owned
intent; never fill it with a generic dashboard, card list, arbitrary palette,
or icon-only required media.
