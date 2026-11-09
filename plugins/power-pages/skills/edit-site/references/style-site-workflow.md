# Style a Non-SPA Power Pages Site

Execute through `edit-site` for styling-only requests or approved `style-site`
operations. Preserve identifiers, approved inputs, scope, locales, design context, hashes and
receipts. Coordinated approval does not approve the exact CSS/source diff.

Reuse the entry skill's version check and preview disclosure; reference reads are not
skill invocations. Read
[quick-start.md](styling/quick-start.md).
Show **Inspect/propose → Approve → Apply → Independently verify → Report** without mandatory tasks.
Styling-only requests finish here: no broad customization plan, Git initialization,
commit, deployment prompt, final-completion confirmation, HTML preview, local server or browser review.

## Inspect and select the route

Resolve the non-SPA export, locale, external workspace, sources, and Bootstrap; reject SPAs.
Default to local authoring for listed/unlisted properties and general CSS, not
property/gradient allowlists.

<!-- not-a-gate: missing inputs; no navigation/write authority -->
Use `AskUserQuestion` only for missing/ambiguous inputs.

Runtime URL only: read
[runtime-dom-discovery.md](styling/runtime-dom-discovery.md).

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

For new treatments, palette/background, typography or redesign, read
[design-quality.md](styling/design-quality.md).
Resolve failures and local declaration dependencies before approval; rendering remains pending.

Prepare in a **fresh external directory** per revision; edit requests, never plans. No reviewable proposal means stop.

Present exact paths/diff/hash, scope/locales, parser/Studio/resource warnings, global/priority effects and tracking. If truncated, read **full `style-site.review.json` before approval**.

<!-- gate: style-site:5.approve | category=plan | cancel-leaves=local-style-state -->
> 🚦 **Gate (plan · style-site:5.approve):** Approve the exact diff, scope, warnings, and hash **per revision**.
> **Why:** Preference is not consent. **Cancel leaves:** Artifacts/prior local state; no new edits.

Use `AskUserQuestion`: **Approve this revision locally / Revise proposal / Cancel**; explicitly requested instructions-only: **Approve Studio handoff only**. Require an explicit host-tool answer, never a JSON field, prior hash or unattended run; otherwise stop with a draft.

## Apply

Run `${PLUGIN_ROOT}/scripts/style-site/style-site-workflow.js` apply with approved hash/new receipt;
no direct writes. The quick start supplies the exact command.

<!-- gate: style-site:6.reapprove | category=progress | cancel-leaves=local-style-state -->
> 🚦 **Gate (progress · style-site:6.reapprove):** Stop on drift, revised selections/targets, or partial-write failure, **per occurrence**.
> **Why:** Old consent cannot authorize new bytes. **Cancel leaves:** Current state/receipt; no concurrent-edit overwrite or auto-rollback.

Use `AskUserQuestion`: **Regenerate and review / Keep current local state and stop**; not apply consent. Prepare/review and approve the **new hash**.

## Independently verify

Require independent validator success from coordinator apply; re-read files/diffs against
targets/receipt. Follow quick-start verification. Requested Studio-only work skips apply;
independently validate its proposal with
`node "${PLUGIN_ROOT}/scripts/style-site/validate-style-site.js" --plan "<plan>"` and verify no styling edits.

## Report

Report local evidence, pending checks and all warnings, including Web File priority. Blocked
local work needs a local next step, not Studio-only success. Return verified results to the
entry skill; it records `EditSite` once after successful completion, not per
reference read or styling operation. Preserve existing tracking records and disclose tracking
diffs separately.

> Reference: ${PLUGIN_ROOT}/references/skill-tracking-reference.md

## Conditional references

- [Studio panel availability, not ownership](styling/studio-component-capabilities.md).
- [Expanded scope/source/cascade](styling/styling-policy.md).
- [Bootstrap/locale uncertainty](styling/bootstrap-and-studio.md).
- [CSS/source schema](styling/proposal-and-verification.md): raw/global CSS, resources/priority and **inline contract/example**; read before inline edits or repeated tags.
- [sources.md](styling/sources.md): unknown/conflicting/stale guidance or explicit requests. Routine CSS uses bundled verified guidance.
