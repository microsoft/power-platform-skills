---
name: manage-governance
description: >-
  Apply, inspect, and monitor Power Pages tenant governance policies. Covers
  twenty-one policies: toggling Maker Copilot for existing sites, enabling/disabling
  sign-in protocols (OpenID Connect, SAML 2.0, WS-Federation, OAuth 2.0), social
  identity providers (Google, Facebook, Microsoft), local login, and external
  auth providers, plus eleven Power Pages Copilot / site-control policies. Sets
  a policy environment-wide or for selected sites, watches the rollout to
  completion, and reads current state at the environment or site level. Use when
  the user wants to "turn off OpenID Connect on Power Pages", "disable SAML on a
  portal", "enable/disable Maker Copilot for existing sites", "enable
  Google/Facebook/Microsoft sign-in", "turn off local login", "allow site Copilot
  on sites", "disable external service calls from server logic", or "see the
  governance status of my Power Pages sites" - even if they only name the policy
  or its side effect without saying "governance".
user-invocable: true
argument-hint: "[optional policy or operation hint]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"`; show any output to the user before proceeding.

# Manage Power Pages Governance Policies

Tenant-admin workflow for applying and inspecting 21 governance policies.
No Power Pages project root is required.

**Initial request:** $ARGUMENTS

## Required references

All paths below are relative to `${PLUGIN_ROOT}/skills/manage-governance/`.
Read the mapping at entry, then the applicable procedure and relevant command
sections **before executing its branch**. References are mandatory instructions, not
optional background reading.

| Reference | Read when | Owns |
|-----------|-----------|------|
| [governance-mapping.json](references/governance-mapping.json) | Entry and intent resolution | Policy metadata, shorthands, intent/scope mapping, labels, dependencies, cascades, side effects |
| [commands.md](references/commands.md) | Relevant script section before each helper call | Flags, JSON shapes, API contract, exit codes, polling semantics |
| [selection.md](references/selection.md) | Every new request or picker | Intent parsing, fresh environment resolution, conditional picker, site display and parsing |
| [apply.md](references/apply.md) | Every Apply, including prerequisite parents | Eligibility, parent remediation/resumption, redundant-operation guard, impact preparation, membership deltas |
| [status.md](references/status.md) | Every read or post-Apply verification | Batched reads, effective state, full status output, verification and errors |

Use **site** and **Fetch Site** in user-facing prose. Preserve actual API/code
identifiers (`portalId`, `/websites`, script names) and helper-emitted labels.
Use plain-language policy subjects; show technical names only when requested
or in the consent renderer's technical mapping.

### Table display across all branches

Render every environment, site-selection, eligibility, impact, and status
table in an **assistant message**, not inside an input form. Use unfenced
Markdown with blank lines around each table, complete URLs/IDs, and the
helper's state icons. Tool stdout alone is not the delivered table.

When input is needed, send the table in an assistant message before calling
the question tool in the same turn. Keep the form's message/question and
field/option descriptions short and plain text; never put tables or the
surrounding summary in those fields. This applies to free-text environment
and scope selection as well as approval: input forms can display Markdown
literally instead of rendering the grid.

## Workflow and task tracking

Create tasks for prerequisites, intent parsing, and environment/scope resolution
at entry; add the selected operation when resolved and a summary/follow-up task
after its result. Mark each in progress when starting and completed when done.

The workflow is prerequisites → parse → resolve → run → loop. The phase numbers
below remain the stable entry points for the procedure and command references.

## 1. Prerequisites

Confirm `pac auth who` and `az account show` both exit 0. If either fails, tell
the user to sign in with `pac auth create` or `az login`, as appropriate, and
stop. Exit code `2` from any helper also means sign-in required: explain and
stop, never treat it as permission to continue.

Use `--envId "<ENV_ID>"` on every environment-scoped helper so a chosen
environment does not silently fall back to PAC's current environment.
Site APIs require `/websites` **Id**, not Dataverse **WebsiteRecordId**.

## 2. Entry point

Start directly with Phase 2.1's free-text prompt, not an entry menu. Do not
pre-warm or cache environments. Exit cleanly on done / that's all / exit /
nothing. Only the consent gate uses an option question.

## 2.1 Free-text intent prompt

<!-- not-a-gate: data-gathering — intent parsing writes nothing; approval is required later -->

Ask in prose: "Tell me what you'd like to do. For example, enable OpenID
Connect on all sites in an environment, disable Google sign-in on Site 1 and
Site 2, or show SAML status for an environment or a specific site."

Follow [selection.md](references/selection.md#intent-resolution). Resolve
against the mapping JSON, not an inline policy/alias table. Ask only for missing
or ambiguous fields; never auto-invert an "everywhere except" request.

## 2.2 Validate, ask for missing pieces, take consent, then submit

<!-- gate: manage-governance:2.2.consent | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · manage-governance:2.2.consent):** Approve the resolved governance change after seeing its impact.
>
> **Trigger:** PER LOOP ITERATION for each policy/environment/scope change on the NLP path. Phase 4.2.3 implements this same approval, not a second prompt.
> **Why we ask:** Governance changes can disable sign-in and sign out users; prior requests or approvals do not authorize later changes or prerequisite parents.
> **Cancel leaves:** No change from this iteration; previously approved changes remain. Do not POST without a selected **Apply now**.

After resolving fields and passing the Apply checks, use `AskUserQuestion`:
**Apply now / Cancel**, exactly once at Phase 4.2.3. Do not submit directly
from the NLP path or ask here and again at Phase 4.2.3.

## 2.3 Supported policies and policyValue meaning

Supported exact, case-sensitive names come from `SUPPORTED_POLICIES` in
`scripts/policies.js`; reject custom names. Read all presentation/intent rules
from `references/governance-mapping.json`, including `userShorthands`,
`intentToPolicyValue`, `policyValueSemantics`, `ambiguousPhrasings`,
`effectLineTemplates`, `availabilityDependsOn`, and cascade/side-effect data.
All policies use the same Enable/Disable workflow; do not reinterpret the verb
based on a policy's internal name.

## 3. Determine the operation

| Intent | Operation | Branch |
|--------|-----------|--------|
| `apply` | Apply | 4.2 |
| `fetchEnv` | Fetch Env | 4.3 |
| `fetchSite` | Fetch Site | 4.4 |

Do not ask users to re-pick a clear operation. If ambiguous, describe these
three operations in a free-text clarification. Rollout status is internal,
not a fourth advertised operation.

## 4. Run the operation

### 4.1 Environment picker

Follow [selection.md](references/selection.md#environment-picker) on **every
new request**, including loop iterations: fetch fresh environments, show the
resolved name/ID and skip re-selection for an exact ID or unique exact name
supplied by the user. If missing, unknown, conflicting, or ambiguous, show the
complete table in an assistant message before the selection form and require
explicit `keep` / row / name / ID selection. Never silently choose a default
or a partial/fuzzy match; never truncate or filter a displayed environment list.
Then show the site picker and take the scope/site reply as specified there.

### 4.2 Apply

Read [apply.md](references/apply.md) in full before proceeding.

#### 4.2.1 Choose scope

Run the mapping-driven eligibility check before scope selection. For blocked
children, follow [parent remediation and auto-resume](references/apply.md#parent-remediation-and-auto-resume).
Otherwise take free-text `all` or comma-separated site names/IDs.

#### 4.2.2 Site picker

Use the shared [site picker and parser](references/selection.md#site-picker-and-parser).
Validate against the full site list, not just visible rows.

#### 4.2.2b Availability gate for named sites

Directly named sites must pass the **same** [eligibility hard gate](references/apply.md#eligibility-hard-gate)
as picker-selected sites. There is no force/anyway bypass in either direction.

#### 4.2.3 Confirm before posting

<!-- gate: manage-governance:4.2.3.consent | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · manage-governance:4.2.3.consent):** Authorize this specific POST after the Impact Summary.
>
> **Trigger:** PER LOOP ITERATION for each policy/environment/scope change, including prerequisite parent-policy changes.
> **Why we ask:** A policy can disable sign-in and sign out users. Earlier intent, environment picks, and previous approvals do not authorize this POST. Phase 2.2 describes this same gate; ask once per change.
> **Cancel leaves:** No change from this iteration; earlier approved changes remain. Cancel exits without a POST.

Follow [impact preparation](references/apply.md#impact-preparation): one batched
current-state read, the redundant-operation guard, and disclosure of collateral
changes and membership removals **before** rendering and approval.
First send an **assistant message** containing `render-impact-summary.js`
output verbatim as Markdown, starting at `**Action:**` with no preamble or code
fence. Preserve blank lines and keep table rows on single physical lines;
do not hand-build, shorten, or supplement its cascade. Tool output alone does
not count as displaying the summary.

Then use `AskUserQuestion`: "Proceed with this change?" with exactly **Apply
now** / **Cancel**. Keep the form's message/question to that short plain-text
confirmation; do not put the impact summary, table, warnings, or cascades in
the form's message, question, or field/option descriptions. The approval form
can display Markdown literally, whereas the preceding assistant message
renders the table. Send the summary before calling the tool in the same turn;
do not add a separate acknowledgement prompt.

Only selected **Apply now** authorizes the POST. Freeform
"Other" text, cancellation, or any different reply is non-authorizing.
On Cancel say "No change made" and return to the loop. Changed requests require
a fresh summary and approval; never reuse consent.

#### 4.2.4 Apply and watch

Use [apply.md's submission procedure](references/apply.md#submit-and-watch).
Run `set-governance.js` in the background (`run_in_background: true`); relay
stderr progress no more than once every 30 seconds. Surface timeout/failure
explicitly rather than claiming success.

#### 4.2.5 Confirm after rollout

Wait for terminal completion, then follow [post-Apply verification](references/status.md#post-apply-verification).
Never trust polling alone. Verify the expected scope and site states, report
mismatches, and deliver the complete status artifact.

### 4.3 Check current state across an environment (Fetch Env)

#### 4.3.1 Batched read and render

Follow [Fetch Env](references/status.md#fetch-env): `fetch-env-status.js` is the
single batched reader; no preliminary standalone governance reads.

### 4.4 Check current state on one site (Fetch Site)

#### 4.4.1 List sites and render the table

Use the shared site picker from Phase 4.1; no duplicate list prompt is needed.

#### 4.4.2 Ask which site

Resolve exactly one site through `parse-portal-input.js`; surface errors and
reprompt for zero or multiple matches.

#### 4.4.3 Run the read and render the result

Follow [Fetch Site](references/status.md#fetch-site): pipe one-site JSON directly
into `get-effective-status.js`, then the canonical renderer. No temporary
site-list file or sequential `get-*` calls.

#### 4.4.4 Effective status for gated child sign-in methods

Use the [effective-state contract](references/status.md#effective-state-and-output-contract).
The helper computes own AND every gating parent; never add parent columns.

### 4.5 Internal rollout status

Consult [status.md](references/status.md#internal-rollout-status) for
`get-status.js`. A last-rollout snapshot is not proof the current Apply landed.

## 5. Loop or finish

Summarize the result in one plain-language sentence using mapping-owned
`summaryLabel` and scope labels; do not expose internal exit codes or fields.
Keep the complete unfenced Markdown status table in the delivered response,
not just tool output.

A successfully verified prerequisite-parent enable with `<PENDING_CHILD_INTENT>`
takes priority: [re-run eligibility and resume the child](references/apply.md#parent-remediation-and-auto-resume)
before the generic prompt. Otherwise re-prompt as in Phase 2.1, without an
operation menu. Every new request goes through a fresh Phase 4.1 environment
resolution (picker only when needed). Done / exit finishes; a different request or cancel discards pending
child intent.

For tracking, read `${PLUGIN_ROOT}/references/skill-tracking-reference.md` and
use `--skillName "ManageGovernance"`. A tracking no-op outside a project is
expected; do not require local project artifacts.
