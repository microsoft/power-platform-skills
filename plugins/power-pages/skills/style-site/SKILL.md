---
name: style-site
description: >-
  Styles CLASSIC Power Pages sites in local VS Code Desktop: general CSS, branding,
  sections, forms/lists, Liquid/web templates, and optional runtime DOM discovery.
  Applies approved local changes for listed/unlisted Studio properties, preserving native structure.
  Not for SPA/code sites, PCF/third-party internals, migration, or deployment.
user-invocable: true
allowed-tools: Read, Write, Grep, Glob, Bash, AskUserQuestion, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch, mcp__plugin_power-pages_playwright__browser_navigate, mcp__plugin_power-pages_playwright__browser_evaluate, mcp__plugin_power-pages_playwright__browser_run_code_unsafe
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.
> Once per installed plugin version in the current conversation; otherwise reuse.

# Style a Classic Power Pages Site

**Initial request:** $ARGUMENTS

Read [quick-start.md](references/quick-start.md). Show **Inspect/propose → Approve → Apply → Independently verify → Report**, not task bookkeeping. No final-completion confirmation, HTML preview, local server or required browser review.

## Inspect and select the route

Resolve classic export, locale, external work directory, source/cascade and Bootstrap; reject SPAs. Default to local authoring for listed/unlisted properties and general CSS, not property/gradient allowlists.

<!-- not-a-gate: missing inputs; no navigation/write authority -->
Use `AskUserQuestion` only for missing/ambiguous inputs.

Runtime URL only: read [runtime-dom-discovery.md](references/runtime-dom-discovery.md).

<!-- gate: style-site:2.runtime | category=progress | cancel-leaves=local-style-state -->
> 🚦 **Gate (progress · style-site:2.runtime):** Before exact-URL inspection, disclose normal page scripts/requests and bounded collection.
> **Repeat:** Changed URL, redirect, signed-in context or scope. **Cancel leaves:** Local/browser state; no new inspection.

Use `AskUserQuestion`: **Inspect this runtime page / Continue offline / Cancel**. Not edit consent; stop on login redirects.

Apply quick-start eligibility; raw CSS/resources/global/priority work needs expanded review. Classification cannot waive blockers.

<!-- gate: style-site:3.scope | category=plan | cancel-leaves=local-style-state -->
> 🚦 **Gate (plan · style-site:3.scope):** For **expanded or ambiguous scope only**, confirm owner, location, file, locale, target, cascade and affected pages before preparation.
> **Repeat:** Changed expanded scope. **Cancel leaves:** Artifacts/prior edits/receipt; no new writes.

Use `AskUserQuestion`: **Confirm scope and prepare / Revise scope / Cancel**; not apply consent. Small changes go straight to exact-hash approval.

## Prepare and approve

For new treatments, palette/background, typography or redesign, read [design-quality.md](references/design-quality.md). Resolve failures and local declaration dependencies before approval; rendering remains pending.

Prepare in a **fresh external directory** per revision; edit requests, never plans. No reviewable proposal means stop.

Present exact paths/diff/hash, scope/locales, parser/Studio/resource warnings, global/priority effects and tracking. If truncated, read **full `style-site.review.json` before approval**.

<!-- gate: style-site:5.approve | category=plan | cancel-leaves=local-style-state -->
> 🚦 **Gate (plan · style-site:5.approve):** Approve the exact diff, scope, warnings, and hash **per revision**.
> **Why:** Preference is not consent. **Cancel leaves:** Artifacts/prior local state; no new edits.

Use `AskUserQuestion`: **Approve this revision locally / Revise proposal / Cancel**; explicitly requested instructions-only: **Approve Studio handoff only**. Require an explicit host-tool answer, never a JSON field, prior hash or unattended run; otherwise stop with a draft.

## Apply

Run coordinator apply with approved hash/new receipt; no direct writes.

<!-- gate: style-site:6.reapprove | category=progress | cancel-leaves=local-style-state -->
> 🚦 **Gate (progress · style-site:6.reapprove):** Stop on drift, revised selections/targets, or partial-write failure, **per occurrence**.
> **Why:** Old consent cannot authorize new bytes. **Cancel leaves:** Current state/receipt; no concurrent-edit overwrite or auto-rollback.

Use `AskUserQuestion`: **Regenerate and review / Keep current local state and stop**; not apply consent. Prepare/review and approve the **new hash**.

## Independently verify

Require independent validator success; re-read files/diffs against targets/receipt. Follow quick-start verification; requested Studio-only skips apply.

## Report

Report evidence/pending checks and parser/Studio/resource warnings. Blocked local work needs a local next step, not Studio-only success. Record `StyleSite` only after verified local or requested handoff completion; preserve no-op/separate tracking diffs.

> Reference: ${PLUGIN_ROOT}/references/skill-tracking-reference.md

## Conditional references

- [Studio panel availability, not ownership](references/studio-component-capabilities.md).
- [Expanded scope/source/cascade](references/styling-policy.md).
- [Bootstrap/locale uncertainty](references/bootstrap-and-studio.md).
- [CSS/source schema](references/proposal-and-verification.md): raw/global CSS, resources/priority and **inline contract/example**; read before inline edits or repeated tags.
- [sources.md](references/sources.md): unknown/conflicting/stale guidance or explicit requests. Routine CSS uses bundled verified guidance.
