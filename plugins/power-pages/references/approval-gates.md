# Approval Gates — ALM Skill Catalog (Draft v2)

> **Status: DRAFT v2.** Addresses review feedback on v1.
>
> **Scope: ALM skills only.** §6 enumerates every `AskUserQuestion` in the 12 ALM skills (`plan-alm`, `setup-solution`, `setup-pipeline`, `deploy-pipeline`, `export-solution`, `import-solution`, `configure-env-variables`, `ensure-pipelines-host`, `force-link-environment`, `activate-site`, `test-site`, `diagnose-deployment`). Non-ALM skills (`create-site`, `deploy-site`, `add-cloud-flow`, `add-server-logic`, `add-seo`, `add-sample-data`, `audit-permissions`, `create-webroles`, `integrate-backend`, `integrate-webapi`, `setup-auth`, `setup-datamodel`) are intentionally **deferred** — see §10. Catalog completeness is asserted only for ALM.
>
> **Not yet applied to SKILL.md files.** This document defines terminology + marker + lint design. The follow-up PR will add the markers to each ALM SKILL.md and ship the lint rule. Run the decisions in §9 first.

---

## 1. Terminology — is "approval gate" / "review gate" standard?

Short answer: **"gate" has strong industry precedent. "review gate" specifically does not. "Approval gate" is the closest match to widely-used vocabulary.**

| Term | Source | Match for our pattern |
|---|---|---|
| **Approval gate** | Azure DevOps Release Pipelines ("Pre/post-deployment approvals and gates"). Spinnaker "Manual Judgment" stages. GitHub Environments "Required reviewers". | ✅ Closest to our usage. |
| **Deployment gate** | Same CI/CD heritage; often paired with "approval gate". | ✅ Narrower — fits final-deploy consent specifically. |
| **Stage gate** | Robert Cooper's Stage-Gate process (product development, 1986). | ⚠️ Conceptually similar but rooted in NPD, not software. |
| **Phase gate** | Same as stage-gate. Used loosely in PM. | ⚠️ Imprecise. |
| **Human-in-the-loop (HITL) checkpoint** | AI agent / ML ops vocabulary. | ✅ Captures the philosophy but verbose. |
| **Manual approval / approval step** | GitHub Actions, ADO Classic, Spinnaker. | ✅ Common synonym. |
| **Review gate** | Not a recognized industry term. Some internal change-management usage but no canonical reference. | ❌ Project-specific construction. |

In **Claude Code / Anthropic skills** specifically, there is **no formal name** for this pattern. The mechanism is `AskUserQuestion`. The closest official framing in `PLUGIN_DEVELOPMENT_GUIDE.md` is the **Three-Point Approval Pattern** (after discovery, after planning, before deployment) — that's our internal convention, not an Anthropic one.

### Recommendation

Adopt **"Approval Gate"** (capitalized as a proper noun) as the canonical term. Drop "review gate" if it's in informal use. Rationale:

- Strong CI/CD heritage that maps cleanly to ALM skills.
- Concrete: makes clear *someone has to approve*.
- Already the most common existing word in our SKILL.md files (`Phase 0 — ALM plan gate`, `Final deploy consent gate`, `Post-sync approval gate`).
- Composes well with category prefixes (see §3 below).
- Distinct from "checkpoint" (no enforcement implication) and "review" (passive — gates are active blockers).

---

## 2. What an Approval Gate is

An **Approval Gate** is a point in a skill workflow where:

1. The skill **stops** and asks the user a question via `AskUserQuestion`.
2. The skill **cannot proceed past the gate** without an explicit user answer.
3. The blast radius of skipping the gate is **non-trivial**.

**The test:** *"would any state — partial or complete-but-wrong — be left behind if the user answered Cancel at this point, and is that state expensive to undo?"* If yes, it's a gate.

Things that are **not** Approval Gates (and shouldn't be marked as such):

- **Informational sub-prompts** that just shape an upcoming gate's options without changing what gets created. Example: `plan-alm` Phase 2 "Help me decide" expanding to a comparison table is not a gate; the gate is the strategy choice that follows.
- **Free-text fallback prompts** that fill in a missing required field (e.g., "I couldn't auto-detect your site URL — paste it") — these are data-gathering, not approval.
- **Discovery-stage confirmations** that simply confirm what was found, with no side effect to undo.
- **Validation polls** (the user isn't being asked anything).
- **Sync-mode `TaskUpdate` checkpoints**.

When in doubt, apply the test above. Borderline cases get the marker; lint complains only if the marker is missing.

---

## 3. Six gate categories

Each gate fits one of six categories. Each gets a one-word prefix in the marker syntax (§4) so readers and lint can tell them apart at a glance. **The defining attribute** for each category is what distinguishes its blast radius — not just when it fires.

### 3.1 `intent` — Entry / orchestration gate
**Defining attribute:** Helper-script-backed; reads deterministic state from a real script, branches on JSON. Not LLM reasoning.

**Question the user answers:** *"Should this skill even run, given current project state?"*

**Mechanism:** Phase 0 calls a helper (`check-alm-plan.js`); the JSON return value (`{ exists, deferred, stale, ... }`) determines whether to surface the gate or pass through silently. The gate itself is an `AskUserQuestion` *only* when the helper returns a "no plan / stale plan" state.

**Lint implication:** The `intent` marker requires the SKILL.md to invoke a known helper script (one of: `check-alm-plan.js`, `verify-alm-prerequisites.js`, `check-activation-status.js`). Inline LLM-evaluated entry conditions don't qualify.

### 3.2 `plan` — Plan-approval gate
**Defining attribute:** User signs off on a rendered artifact (HTML plan, manifest, parameter table, permissions matrix) *before* the skill writes anything Dataverse-side.

**Question the user answers:** *"Does this match what you wanted to do?"*

**Mechanism:** Skill presents a rendered artifact and a 2–4 option `AskUserQuestion`. Cancel exits without any Dataverse / filesystem write.

### 3.3 `progress` — Mid-flow re-confirmation gate
**Defining attribute:** A condition emerged mid-run that wasn't visible at planning time; the user re-confirms before the skill continues with the delta.

**Question the user answers:** *"The situation changed — proceed with the new state?"*

**Mechanism:** Triggered by a detected condition (sync mode happened; new components were adopted; pre-flight found a gap). Skill pauses and re-prompts with the delta surfaced inline.

### 3.4 `consent` — Destructive / irreversible-action gate
**Defining attribute:** The action being approved changes **shared or irreversible state** — a tenant-wide security setting, a permanent naming choice, a cross-host stamp move, a managed-vs-unmanaged export choice. Distinguishing factor is **what kind of state changes**, not when in the flow.

**Question the user answers:** *"This is destructive / irreversible — really proceed?"*

**Mechanism:** Mandatory `AskUserQuestion` with consequences spelled out. Often non-skippable even when other flags pre-confirmed upstream. The "no `--yes` flag" rule applies.

> **Note:** Both proactive (pre-flight) and reactive (after-failure) modifications of the same shared state are `consent` gates. Trigger timing doesn't change the category — `deploy-pipeline:2.5` (pre-flight unblock of `blockedattachments`) and `deploy-pipeline:7.6.2` (reactive unblock after `AttachmentBlocked` failure) both modify a tenant-wide setting and are therefore both `consent`.

### 3.5 `final` — Last-call gate
**Defining attribute:** Immediately before the destructive API call. No work happens between the gate and the call except the call itself.

**Question the user answers:** *"Ready to ship?"*

**Mechanism:** Distinct from `consent` in that the destructive action has already been agreed in principle (often by upstream `plan` and `progress` gates) — this gate's job is only to convert that principle-level approval into "fire now" approval. Separates *validation passed* from *user wants to ship*.

### 3.6 `pause` — External-system wait gate
**Defining attribute:** Nothing the *skill* is asking the user about. The *external platform* is requesting a human action (e.g., PPAC approval) and the skill is surfacing that wait through `AskUserQuestion`.

**Question the user answers:** *"Have you done the thing the external system wants?"*

**Mechanism:** Skill polls until external state changes. When the external state is `PendingApproval` / `AwaitingPreDeployApproval`, the skill surfaces it via `AskUserQuestion` and waits. Tooling must never auto-respond to a `pause` gate.

---

### 3.7 Loop semantics — when a gate sits inside a loop

> **The single biggest runtime failure mode of this strategy:** the LLM interprets the user's answer at the top of a loop as covering the *entire loop*, then proceeds through subsequent iterations without re-prompting. Documented runtime example: `deploy-pipeline` Phase 6.0 was skipped for iterations 2 and 3 of a 3-solution `MULTI_RUN_MODE` deploy after the user answered "staging" once at the top. The gate marker was present; the lint passed; the agent simply did not call `AskUserQuestion` again.

The default behavior **per category** when a gate is inside a loop:

| Category | Default when inside a loop | Override? |
|---|---|---|
| `intent` | **Once per skill invocation, before the loop.** Entry gates protect the skill from running with wrong project state — the project state doesn't change between iterations. | Not applicable. |
| `plan` | **Depends on what the gate is choosing.** A "pick a strategy" plan gate runs once before the loop. A "confirm this iteration's parameters" plan gate runs **once per iteration.** Each catalog row must state which. | SKILL.md prose. |
| `progress` | **Per occurrence of the triggering delta.** If sync mode runs twice in a loop, this gate fires twice. If a delta is detected only on iteration 2, it fires only on iteration 2. | Not applicable. |
| `consent` | **PER ITERATION when the destructive action repeats.** Each instance of the destructive call gets its own consent. A consent given for iteration 1 does NOT cover iteration 2 even if the destruction is the same shape. | Hard rule — never override. |
| `final` | **PER ITERATION, full stop.** The whole point of `final` is "fire immediately before the destructive call." If the destructive call runs `N` times in a loop, the gate fires `N` times. | Hard rule — never override. |
| `pause` | **Per occurrence of the external pending state.** Polling can re-enter PendingApproval after a retry; each entry gets its own pause prompt. | Not applicable. |

**Required prose in SKILL.md** for any gate that sits inside a loop:

1. The gate marker block (`> 🚦 **Gate (...)**`) must include an explicit line stating *"Fires PER LOOP ITERATION"* (or equivalent) and naming the loop variable. Example: *"Three solutions in `deploymentOrder` → three Phase 6.0 prompts."*
2. The loop description elsewhere in the SKILL.md must call out the gate by name in the per-iteration sequence. Example: *"For each entry in `DEPLOYMENT_ORDER`: ... fire Phase 6.0 consent gate ... call `DeployPackageAsync`."*
3. The marker block must explicitly negate the most common shortcut: *"The upstream Phase 2 stage selection (whether via interactive prompt or `--stage` argument) does NOT cover subsequent iterations."*

**Why prose, not lint?** The lint catches the *presence* of a marker. It cannot prove the agent actually *fired* the `AskUserQuestion` call at runtime. Loop-semantics prose narrows the LLM's interpretation space so the shortcut becomes textually impossible — *"the gate fires N times for N iterations"* leaves no room to read it as *"once is enough"*.

**Future hardening (out of scope for v2):** runtime telemetry on gate firing — a `gate-fire-log.js` helper the skill calls before each `AskUserQuestion`, with a validator that asserts the expected pattern post-run. That would let us detect runtime non-firing empirically instead of just structurally.

---

## 4. Marker syntax (proposed)

Every gate gets a structural marker in SKILL.md. The marker has two parts: a **machine-readable HTML comment** (lint anchor) and a **human-readable block** (documentation).

### 4.1 The marker

```markdown
<!-- gate: skill-name:phase-id | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · skill-name:phase-id):** One-line summary of what the user is approving.
>
> **Trigger:** When this gate fires.
> **Blast radius if skipped:** What goes wrong if a tool bypasses the prompt.
> **Cancel leaves:** Explicit state description — either `nothing` (clean exit) or a specific state.
```

`skill-name` is kebab-case; `phase-id` matches the SKILL.md phase number (`6.0`, `5.4c`, `q1b`).

### 4.2 Pairing rule (replaces v1's "within 10 lines" proximity rule)

Lint uses the **HTML comment** as the structural anchor, not text proximity. The `AskUserQuestion` block paired with a marker:

- Must appear **after** the marker (anywhere later in the same phase section).
- Has no maximum line distance — rationale prose can be arbitrarily long between marker and `AskUserQuestion`.
- May be followed by sub-`AskUserQuestion` calls (e.g., follow-up free-text input within the same gate); those don't need their own markers if the catalog entry says "may include follow-up data-gathering prompts".

A second `AskUserQuestion` in the same phase section that is **not** covered by an existing marker must have its own marker OR an explicit `<!-- not-a-gate: reason -->` comment justifying why.

### 4.3 `cancel-leaves` field (new in v2)

Required, normalized vocabulary:

| Value | Meaning |
|---|---|
| `nothing` | Clean exit. No Dataverse write, no filesystem write, no state change anywhere. |
| `validated-stage-run` | A `deploymentstageruns` row remains on the host in validated-but-not-deployed state. |
| `partial-manifest` | `.solution-manifest.json` written but not all components added to Dataverse. |
| `partial-solution` | Some components added to Dataverse via `AddSolutionComponent` before Cancel. |
| `deferral-marker` | `.alm-deferred` file written (an intentional user-facing artifact). |
| `host-binding` | Dev env's `ProjectHostEnvironmentId` org-db setting changed. |
| `attachment-block-modified` | Env's `blockedattachments` setting modified before Cancel. |
| `cross-host-stamp-moved` | Pattern 15 force-link partially completed. |
| `external-state-pending` | Skill cancelled while external system (PP Pipelines) was in `PendingApproval` — the run remains on the host in that state. |
| `invalid-secret-in-file` | `deployment-settings.json` carries Secret values in invalid formats (e.g. `@KeyVault(...)` short-form). Cancel leaves the file as-is so the user can hand-fix with canonical Key Vault URIs. |

Custom values are allowed when none of the above fits — lint accepts any kebab-case slug but flags duplicate slugs across the catalog for de-duplication.

### 4.4 Example — `deploy-pipeline` Phase 6.0

```markdown
<!-- gate: deploy-pipeline:6.0 | category=final | cancel-leaves=validated-stage-run -->

> 🚦 **Gate (final · deploy-pipeline:6.0):** Final consent before DeployPackageAsync.
>
> **Trigger:** Validation passed (Phase 5); no completeness drift outstanding; no env-var override prompts outstanding. About to fire `DeployPackageAsync` or the `pac pipeline deploy` fallback.
> **Blast radius if skipped:** Wrong-stage deploy. Non-transactional — partial failure leaves whatever already imported on the target.
> **Cancel leaves:** Validated stage run on host (no `docs/alm/last-deploy.json` written). User can retry by re-invoking `deploy-pipeline`.

[arbitrarily long rationale prose explaining why this gate exists, what alternatives were considered, etc.]

Use `AskUserQuestion`:

> "Ready to deploy `{ARTIFACT_SOLUTION_NAME}` (v`{newVersion}`) to **`{SELECTED_STAGE.name}`** (`{targetEnvUrl}`)?"
>
> Options:
> 1. Deploy now (Recommended)
> 2. Cancel
```

### 4.5 Why an emoji in the human block?

`🚦` (traffic-light) is high-contrast and unusual. Verified: it appears nowhere else in any SKILL.md or reference doc on the current branch, so the grep-safety claim holds today. Plain-text fallback if emoji is undesirable: `[GATE]`. Note that lint anchors on the HTML comment, not the emoji — the emoji is purely for human readability.

---

## 5. Lint rules (proposed)

Add to `scripts/lint-skills-alm.js`:

### `GATE-must-have-marker`
Every `AskUserQuestion` block in an ALM SKILL.md must be preceded (within the same phase section) by either:
- A paired `<!-- gate: ID | category=X | cancel-leaves=Y -->` comment, **or**
- An explicit `<!-- not-a-gate: <reason> -->` comment justifying why.

Pairing is established by section boundary (`### Phase`), not line proximity. Multiple `AskUserQuestion` calls in the same phase may share one marker only if the catalog entry explicitly documents the sub-prompts.

Waivable via `<!-- alm-lint-ignore: GATE-must-have-marker -->`. Tracked in `.almlintignore` for known exceptions.

### `GATE-id-must-be-unique`
The `gate-id` slug must be unique across all SKILL.md files in the plugin.

### `GATE-must-be-in-catalog`
Every `gate-id` in a SKILL.md must appear in §6 of this catalog. Catches drift when a skill adds a gate without documenting it.

Strict for ALM skills (hard-fail). Warn-only for non-ALM skills until the catalog is extended to cover them (§10).

### `GATE-intent-must-call-helper`
A marker tagged `category=intent` must be in a SKILL.md section that invokes a known helper script (one of: `check-alm-plan.js`, `verify-alm-prerequisites.js`, `check-activation-status.js`). Prevents `intent` from being abused as a generic "first prompt" label.

### `GATE-cancel-leaves-known-vocab`
The `cancel-leaves=` value must be one of the §4.3 vocabulary entries or a kebab-case slug. Lint flags duplicate slugs across the catalog for de-duplication.

---

## 6. The ALM-skill catalog

Each section lists every `AskUserQuestion` in that skill. Catalog rows are marked as one of:

- **`gate`** — meets the §2 definition; gets a marker and a lint check.
- **`not-a-gate`** — informational sub-prompt or data-gathering; gets a `<!-- not-a-gate -->` comment.

> **Phase numbers reference the SKILL.md as of branch `users/nityagi/EnvVariableChanges`.** Phase IDs may need re-anchoring if SKILL.md is restructured.

---

### 6.1 `plan-alm` (19 calls; orchestrator)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `plan-alm:1.deferral` | gate | progress | 1 | `.alm-deferred` marker present — *"Continue with deferral / remove and proceed / cancel"* | `deferral-marker` |
| `plan-alm:1.completeness` | gate | progress | 1 | Completeness check found gaps — *"Sync first / plan with gaps / cancel"* | nothing |
| `plan-alm:2.q1-existing` | gate | plan | 2 (Q1) | `SOLUTION_DONE=true` — *"Use existing solution **{name}**?"* | nothing |
| `plan-alm:2.q1-fresh` | gate | plan | 2 (Q1) | `SOLUTION_DONE=false` — *"Include solution setup in plan?"* | nothing |
| `plan-alm:2.q1b-split` | gate | plan | 2 (Q1b) | `RECOMMEND_SPLIT=true` — *"Follow recommended {strategy} split?"* | nothing |
| `plan-alm:2.q1b-override` | gate | consent | 2 (Q1b) | User picked "keep single" — *"Confirm override + free-text reason"* | nothing |
| `plan-alm:2.q2-strategy` | gate | plan | 2 (Q2) | *"PP Pipelines / Manual export-import / Already have pipeline / Help me decide"* | nothing |
| `plan-alm:2.q3-stages` | gate | plan | 2 (Q3 PP) | *"How many deployment stages?"* | nothing |
| `plan-alm:2.q4-stage-env` | gate | plan | 2 (Q4 PP per stage) | *"Target env URL for stage {N}?"* | nothing |
| `plan-alm:2.q5-approval` | gate | plan | 2 (Q5 PP) | *"Approvals: required each stage / staging auto + prod required / no gates"* | nothing |
| `plan-alm:2.q3-manual` | gate | plan | 2 (Q3 Manual) | *"How many target envs?"* | nothing |
| `plan-alm:2.q4-manual-target` | gate | plan | 2 (Q4 Manual per stage) | *"URL for target env {N}?"* | nothing |
| `plan-alm:2.q5-manual-type` | gate | plan | 2 (Q5 Manual) | *"Export managed or unmanaged?"* | nothing |
| `plan-alm:2.q6-manual-checkpoint` | gate | plan | 2 (Q6 Manual) | *"Pause between export and import?"* | nothing |
| `plan-alm:4.approve` | gate | plan | 4 | *"Approve and execute / save for later / change something"* | nothing |
| `plan-alm:4.approver-fallback` | not-a-gate | — | 4 | Free-text "approver name" — pure data-gathering | — |
| `plan-alm:7.manual-checkpoint` | gate | progress | 7 (Manual path) | `MANUAL_CHECKPOINT=true` — *"Export done; proceed to import?"* | partial-manifest |
| `plan-alm:7.deploy-failure` | gate | plan | 7 (Step A.1) | deploy-pipeline halted before completing — *"Retry / Skip stage / Exit"*. Fires per failed stage. | nothing |
| `plan-alm:7.activate-step-b` | gate | plan | 7 (Step B) | Post-deploy activation prompt per stage — *"Activate now / skip"* | nothing |

---

### 6.2 `setup-solution` (13 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `setup-solution:0.no-plan` | gate | intent | 0 | `check-alm-plan.js` returned `exists:false` — *"Run plan-alm? / Continue without / Cancel"* | nothing |
| `setup-solution:0.stale-plan` | gate | intent | 0 | `check-alm-plan.js` returned `stale:true` — *"Refresh plan? / Continue / Cancel"* | nothing |
| `setup-solution:1.preloaded` | gate | plan | 1 | `docs/alm/alm-plan-context.json` present — *"Use pre-loaded choices? / Re-discover"* | nothing |
| `setup-solution:1.stale-manifest` | gate | consent | 1 | Manifest references a solution not in env — *"Start fresh (back up) / Abort"* | nothing |
| `setup-solution:2.publisher-prefix` | gate | consent | 2 | Publisher prefix selection — *"This is PERMANENT — confirm"* | nothing |
| `setup-solution:5.4a.promote` | gate | plan | 5.4A | `multiSelect` over auth settings — *"Which to promote to env vars?"* | nothing |
| `setup-solution:5.4c.credentials` | gate | consent | 5.4C.2 | Bulk credential handling — *"Secret env var / String env var / Skip per credential"* | nothing |
| `setup-solution:5.4b.orphan-envvars` | gate | plan | 5.4b | `DEFAULT-ONLY` env vars found — *"Which to adopt?"* (multiSelect) | nothing |
| `setup-solution:5.4c.orphan-ppcs` | gate | plan | 5.4c | Orphan ppcs found (incl. siteLanguages) — *"Which to adopt?"* (multiSelect) | nothing |
| `setup-solution:5.5.manifest-confirm` | gate | plan | 5.5 | Manifest assembly + final confirmation. Covers sub-prompts: tables multi-select, flows multi-select, bots multi-select, and the closing *"Proceed / change something"* gate. Single marker covers all four because the lint regex matches the closing prompt; the multi-select sub-prompts share the same gate semantics. | partial-manifest |
| `setup-solution:7.next-step` | gate | plan | 7 | *"How to deploy: pipeline / manual / later"* | nothing |
| `setup-solution:1.no-config` | not-a-gate | — | 1 | Free-text "site name" if `powerpages.config.json` missing — data-gathering | — |
| `setup-solution:1.no-website-record` | not-a-gate | — | 1 | Free-text "website record ID" fallback — data-gathering | — |

---

### 6.3 `setup-pipeline` (11 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `setup-pipeline:0.no-plan` | gate | intent | 0 | `check-alm-plan.js` returned `exists:false` — *"Run plan-alm? / Continue / Cancel"* | nothing |
| `setup-pipeline:0.stale-plan` | gate | intent | 0 | `check-alm-plan.js` returned `stale:true` — *"Refresh plan? / Continue / Cancel"* | nothing |
| `setup-pipeline:1.existing-pipeline` | gate | plan | 1 | `docs/alm/last-pipeline.json` found — *"Overwrite / Review first / Cancel"* | nothing |
| `setup-pipeline:2.platform` | gate | plan | 2 | *"PP Pipelines / GitHub (coming soon) / ADO (coming soon)"* | nothing |
| `setup-pipeline:3.config` | gate | plan | 3 | Auto-detected pipeline config — *"Confirm / correct"* | nothing |
| `setup-pipeline:4.3.name-conflict` | gate | plan | 4.3 | Existing pipeline with same name — *"Use existing / different name"* | nothing |
| `setup-pipeline:4.4.blocked-attachments` | gate | consent | 4.4 | `.js` blocked on source or target — *"Remove block / skip"* | `attachment-block-modified` |
| `setup-pipeline:5a.pattern-15` | gate | consent | 5a | Env stamped to different host — *"Run force-link (DESTRUCTIVE) / cancel"* | nothing |
| `setup-pipeline:6b.v2-migration` | gate | plan | 6b | v2 manifest detected on re-run — *"Migrate to v3 / keep legacy"* | nothing |
| `setup-pipeline:coming-soon.exit` | gate | plan | (coming-soon path) | GitHub/ADO selected — *"Switch to PP Pipelines / Exit"* | nothing |
| `setup-pipeline:1.host-fallback` | not-a-gate | — | 1 | Free-text host URL if discovery returns empty — data-gathering | — |

---

### 6.4 `deploy-pipeline` (18 gates / 3 sub-prompts; 21 calls total)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `deploy-pipeline:0.no-plan` | gate | intent | 0 | `check-alm-plan.js` `exists:false` — *"Run plan-alm? / Continue / Cancel"* | nothing |
| `deploy-pipeline:0.stale-plan` | gate | intent | 0 | `check-alm-plan.js` `stale:true` — *"Refresh / Continue / Cancel"* | nothing |
| `deploy-pipeline:2.stage` | gate | plan | 2 | *"Target stage?"* (Staging / Prod / etc.) | nothing |
| `deploy-pipeline:2.5.blocked-attachments` | gate | consent | 2.5 | Pre-flight detected `.js` on `blockedattachments` — *"Unblock / skip"* | `attachment-block-modified` |
| `deploy-pipeline:3.5.completeness` | gate | progress | 3.5 | Solution missing components vs. live site — *"Sync now / deploy anyway / cancel"* | nothing |
| `deploy-pipeline:3.5.post-sync` | gate | progress | 3.5 | Post-sync re-confirm — *"New version + adopted components — proceed?"* | nothing |
| `deploy-pipeline:3.6.batch-pending-approval` | gate | pause | 3.6 | `MULTI_RUN_MODE` parallel-validation batch — N of M solutions hit `stagerunstatus=200000005` — *"Approve all in PPAC, then re-poll / Cancel"* (fires once per batch, not per pending solution) | `external-state-pending` |
| `deploy-pipeline:3.6.batch-validation-failed` | gate | plan | 3.6 | `MULTI_RUN_MODE` parallel-validation batch — one or more solutions failed or timed out — *"Abort (Recommended) / Deploy succeeded subset only (advanced) / Cancel"* | `validated-stage-run` |
| `deploy-pipeline:4.pending-approval` | gate | pause | 4 | `stagerunstatus=200000005` during validation (single-solution / legacy v2 only — `MULTI_RUN_MODE` handles approval via `3.6.batch-pending-approval` instead) — *"Approved in PPAC? Yes / Cancel"* | `external-state-pending` |
| `deploy-pipeline:5.env-vars` | gate | plan | 5 | Unconfigured env vars per stage — *"Enter values"* | nothing |
| `deploy-pipeline:6.0.final-consent` | gate | final | 6.0 | About to fire `DeployPackageAsync` — *"Deploy now / Cancel"* | `validated-stage-run` |
| `deploy-pipeline:6.pending-approval` | gate | pause | 6 | `stagerunstatus=200000005` mid-deploy — *"Approved? Yes / Cancel"* | `external-state-pending` |
| `deploy-pipeline:7.6.2.blocked-attachments` | gate | consent | 7.6.2 | Reactive `AttachmentBlocked` — *"Modify `blockedattachments`? Yes / No"* | `attachment-block-modified` |
| `deploy-pipeline:7.6.3.retry-exit` | gate | plan | 7.6.3 | Failed deploy, no known pattern matched — *"Retry / Exit"* | `validated-stage-run` |
| `deploy-pipeline:7.6.4.strip-secret-values` | gate | consent | 7.6.4 | Reactive Secret-reference validation failure — *"Strip invalid Secret values from `deployment-settings.json` and retry? Yes / No"* | `invalid-secret-in-file` |
| `deploy-pipeline:7.7.activate` | gate | plan | 7.7 | Site deployed, not yet activated — *"Activate now / later"* | nothing |
| `deploy-pipeline:7.cloud-flow-register` | gate | plan | 7 (cloud-flow path) | Cloud flows in solution — *"Registered in target? Yes / Later"* (informational continue) | nothing |
| `deploy-pipeline:6.1.pac-fallback-consent` | gate | final | 6.1 | `VALIDATE_PACKAGE_UNAVAILABLE=true` path uses `pac pipeline deploy` instead of `DeployPackageAsync` — same shape as `6.0` | `validated-stage-run` |

(Three additional `AskUserQuestion` calls in this skill are sub-prompts inside the gates above — env-var value entry per variable inside `5.env-vars`, validation `Approved? Yes / No` follow-ups inside `4.pending-approval` and `6.pending-approval`. They share the parent gate's marker.)

---

### 6.5 `export-solution` (8 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `export-solution:0.no-plan` | gate | intent | 0 | `check-alm-plan.js` `exists:false` — *"Run plan-alm? / Continue / Cancel"* | nothing |
| `export-solution:0.stale-plan` | gate | intent | 0 | `check-alm-plan.js` `stale:true` — *"Refresh / Continue / Cancel"* | nothing |
| `export-solution:2.identify` | gate | plan | 2 | Solution not auto-found — *"Pick / paste unique name"* | nothing |
| `export-solution:2.5.completeness` | gate | progress | 2.5 | Completeness gap — *"Sync now / export anyway / cancel"* | nothing |
| `export-solution:2.5.post-sync` | gate | progress | 2.5 | Post-sync re-confirm — *"New version — proceed?"* | nothing |
| `export-solution:3.export-type` | gate | consent | 3 | *"Managed (for staging/prod) / Unmanaged (for dev-to-dev)"* | nothing |
| `export-solution:3.overwrite` | gate | plan | 3 | Existing zip at target path — *"Overwrite / pick new name / cancel"* | nothing |
| `export-solution:2.unique-name` | not-a-gate | — | 2 | Free-text fallback for solution unique name — data-gathering | — |

---

### 6.6 `import-solution` (11 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `import-solution:0.no-plan` | gate | intent | 0 | `check-alm-plan.js` `exists:false` — *"Run plan-alm? / Continue / Cancel"* | nothing |
| `import-solution:0.stale-plan` | gate | intent | 0 | `check-alm-plan.js` `stale:true` — *"Refresh / Continue / Cancel"* | nothing |
| `import-solution:2.multiple-zips` | gate | plan | 2 | More than one valid zip found — *"Choose"* | nothing |
| `import-solution:3.0.version-skew` | gate | consent | 3.0 | Zip version `≤` installed target version — *"Re-export with bump / Import anyway / Cancel"* | nothing |
| `import-solution:3.config` | gate | plan | 3 | Import config — *"Staged dependency check / direct / overwrite options"* | nothing |
| `import-solution:5b.blocked-attachments` | gate | consent | 5b.3 | `AttachmentBlocked` during import — *"Modify `blockedattachments` and retry? Yes / Skip"* | `attachment-block-modified` |
| `import-solution:6b.env-vars` | gate | plan | 6b | Env vars need per-stage values — *"Enter values"* | nothing |
| `import-solution:6c.cloud-flow-register` | gate | plan | 6c | Cloud flows in imported solution — *"Registered? Yes / Later"* | nothing |
| `import-solution:6d.activate` | gate | plan | 6d | Site present but not activated — *"Activate now / later"* | nothing |
| `import-solution:2.confirm-target` | not-a-gate | — | 2 | Display warning, no choice needed (single-option ack) | — |
| `import-solution:2.zip-path` | not-a-gate | — | 2 | Free-text fallback for zip path — data-gathering | — |

---

### 6.7 `configure-env-variables` (5 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `configure-env-variables:0.no-plan` | gate | intent | 0 | `check-alm-plan.js` `exists:false` — *"Run plan-alm? / Continue / Cancel"* | nothing |
| `configure-env-variables:0.stale-plan` | gate | intent | 0 | `check-alm-plan.js` `stale:true` — *"Refresh / Continue / Cancel"* | nothing |
| `configure-env-variables:2.selection` | gate | plan | 2 | Settings classified — *"Which to promote? Per-stage values per setting"* | nothing |
| `configure-env-variables:6.confirm-matrix` | gate | plan | 6 | `deployment-settings.json` assembled — *"Confirm matrix before write"* | nothing |
| `configure-env-variables:6.1.invalid-secret-values` | gate | consent | 6.1 | Pre-write validation found Secret refs in invalid formats — hard-stop, *"Fix or abort"* | nothing |

---

### 6.8 `ensure-pipelines-host` (10 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `ensure-pipelines-host:1.4.tenant-identity` | gate | consent | 1.4 | Tenant identity echo before any provisioning — *"Is this the right tenant?"* | nothing |
| `ensure-pipelines-host:3.C.host-type` | gate | plan | 3.C | `NoHost` status — *"Platform / Custom / PPAC / Manual strategy / Cancel"* | nothing |
| `ensure-pipelines-host:3.C.env-pick` | gate | plan | 3.C (sub-option a) | Eligible env list — *"Pick env to install Pipelines on"* | nothing |
| `ensure-pipelines-host:4.sandbox-confirm` | gate | consent | 4 (Sandbox) | Picked env has `environmentSku=Sandbox` — *"Sandbox limits — proceed?"* | nothing |
| `ensure-pipelines-host:4.0.pre-call` | gate | consent | 4.0 | PE `getOrCreate` about to fire — *"Echoed API body — proceed?"* | nothing |
| `ensure-pipelines-host:4.A.pre-call` | gate | consent | 4.A | Custom Host create about to fire — *"Echoed API body — proceed?"* | nothing |
| `ensure-pipelines-host:4.A.sku-fallback` | gate | plan | 4.A (on 409) | Capacity error — *"Try {nextSku} / Cancel"* | nothing |
| `ensure-pipelines-host:4.C.ppac-done` | gate | progress | 4.C | Manual PPAC fallback — *"Done in PPAC? / Cancel"* | `host-binding` |
| `ensure-pipelines-host:4.B.guid-confirm` | not-a-gate | — | 4.B | Confirm GUID identity when uncertain — data-gathering | — |
| `ensure-pipelines-host:4.B.admin-check` | not-a-gate | — | 4.B | Single confirm of admin role — informational | — |

(`4.B.guid-confirm` is conditional and only fires when the BAP GUID is ambiguous — a typical run sees ~9 prompts. The header count reflects total catalog rows, not per-run prompt count.)

---

### 6.9 `force-link-environment` (5 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `force-link-environment:2.host-url` | gate | plan | 2 | Host URL not resolved from markers — *"Pick host"* | nothing |
| `force-link-environment:2.dev-env` | gate | plan | 2 | Dev env BAP GUID not resolved — *"Pick / paste"* | nothing |
| `force-link-environment:4.destructive` | gate | consent | 4 | Mandatory gate before `ManageEnvironmentStamp` — *"DESTRUCTIVE: confirm cross-host stamp move"* | nothing |
| `force-link-environment:2.host-fallback` | not-a-gate | — | 2 | Free-text host URL — data-gathering | — |
| `force-link-environment:2.dev-fallback` | not-a-gate | — | 2 | Free-text dev env GUID — data-gathering | — |

---

### 6.10 `activate-site` (4 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `activate-site:2.1.site-name` | not-a-gate | — | 2.1 | Free-text site name fallback — data-gathering | — |
| `activate-site:2.2.subdomain` | gate | plan | 2.2 | Generated subdomain — *"Accept / enter your own"* | nothing |
| `activate-site:2.3.website-record` | not-a-gate | — | 2.3 | Free-text website record ID fallback — data-gathering | — |
| `activate-site:3.confirm` | gate | final | 3 | All activation params assembled — *"Activate {siteName} at {subdomain}?"* | nothing |

---

### 6.11 `test-site` (6 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `test-site:1.4.site-url` | not-a-gate | — | 1.4 | Free-text site URL fallback — data-gathering | — |
| `test-site:3.2.private-gate-login` | gate | pause | 3.2 | Private site gate detected — *"Logged in? / Skip"* | nothing |
| `test-site:3.2.login-retry` | gate | pause | 3.2 | Login not completed after first prompt — *"Retry / Skip"* | nothing |
| `test-site:3.5.public-vs-auth` | gate | plan | 3.5 | Site appears to have auth UI — *"Test as anonymous / sign in"* | nothing |
| `test-site:3.5.login-retry` | gate | pause | 3.5 | Site-auth login not completed — *"Retry / Skip"* | nothing |
| `test-site:5.5.form-submit` | gate | consent | 5.5 | About to submit a form on the live site — *"Submit / skip"* | nothing |

---

### 6.12 `diagnose-deployment` (1 loop-style gate)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `diagnose-deployment:6.auto-fix` | gate | consent | 6 | Per-finding: each suggested auto-fix loops through this same prompt template, surfacing the pattern ID and the proposed fix. User answers Yes / No / Skip-all per finding. | varies by fix |

The single `AskUserQuestion` template fires once per Error finding with `autoFixAvailable: true`. **Resolves the v1 wildcard problem (`diagnose-deployment:6.*`)** by collapsing all per-pattern loops under one gate ID. The prompt's content varies by pattern; the gate identity does not. Pattern IDs themselves are stable: see `references/deployment-error-catalog.md`.

---

## 7. How to add a new gate

When introducing a gate in an existing or new ALM skill:

1. **Pick the category** from §3. If it doesn't fit, propose a new one — don't shoehorn.
2. **Pick a gate ID** of the form `skill-name:phase-id` (kebab-case skill name; phase number / step matches the SKILL.md heading).
3. **Add a row to the catalog** (§6 table for the owning skill) with `kind`, `category`, `phase`, trigger, question, `cancel-leaves`.
4. **Add the marker block** in SKILL.md immediately before the (possibly distant) `AskUserQuestion` call. Use both the HTML comment and the human-readable block from §4.1.
5. **If `category=intent`**, ensure the SKILL.md section invokes a helper script (`GATE-intent-must-call-helper` lint rule).
6. **Run** `node scripts/lint-skills-alm.js`.

When **removing** a gate, also remove its catalog row in the same PR.

---

## 8. Non-ALM skills — explicitly deferred

Per the v1 review, the catalog was incomplete because it claimed full coverage but only covered ~30% of `AskUserQuestion` calls. v2 fixes this by **scoping to ALM only**. The 13 non-ALM skills below contain ~70 additional `AskUserQuestion` calls that need to be catalogued in a follow-up:

| Skill | `AskUserQuestion` count | Status |
|---|---|---|
| `create-site` | 11 | Deferred |
| `deploy-site` | 9 | Deferred |
| `add-server-logic` | 13 | Deferred |
| `add-cloud-flow` | 7 | Deferred |
| `setup-auth` | 5 | Deferred |
| `integrate-webapi` | 6 | Deferred |
| `setup-datamodel` | 3 | Deferred |
| `add-sample-data` | 3 | Deferred |
| `add-seo` | 3 | Deferred |
| `create-webroles` | 3 | Deferred |
| `audit-permissions` | 2 | Deferred |
| `integrate-backend` | (see SKILL.md) | Deferred |
| `report-issue` | 1 | Deferred (cross-plugin, may not need a gate) |

For non-ALM skills, the lint rules in §5 are **warn-only** until this section is extended. ALM lint rules are **hard-fail** from day one (per §9 decision).

---

## 9. Decisions — pre-resolved with recommendations

These need explicit confirmation from the reviewer before SKILL.md edits land. Recommendation in **bold**.

| # | Decision | Recommendation | Rationale |
|---|---|---|---|
| 1 | Canonical term | **"Approval Gate"** | CI/CD heritage; already the most common word in our SKILL.md files; concrete. Drop "review gate" if used informally. |
| 2 | Marker syntax | **HTML comment `<!-- gate: ID \| category=X \| cancel-leaves=Y -->` + human `> 🚦 Gate (...)` block** | Comment is the lint anchor; block is for humans. Robust to interleaved prose. |
| 3 | Catalog location | **`plugins/power-pages/references/approval-gates.md`** (this file) + a one-line pointer in `PLUGIN_DEVELOPMENT_GUIDE.md` | Sits with other shared references; cross-skill scope is obvious from the path. |
| 4 | Lint rollout strictness | **ALM: hard-fail. Non-ALM: warn-only until §8 catalog extends.** | ALM is fully catalogued; non-ALM is the follow-up. Hard-fail on ALM forces drift to be caught at PR time. |
| 5 | Emoji vs plain text | **Keep `🚦` in the human block; lint anchors on the HTML comment regardless** | Emoji is for humans; tooling doesn't depend on it. |
| 6 | Wildcard gate IDs (e.g. `diagnose-deployment:6.*`) | **Disallowed. Enumerate per pattern.** | Per-pattern markers enforce that each catalog-listed deployment-error pattern has matching prompt logic. |

---

## 10. Landing plan

The reviewer's recommendation — **land §1–§5 + §7–§9 as documentation now; do the SKILL.md sweep + lint rule as a follow-up PR** — is the right shape. Concretely:

**This PR (proposed):**
- Land this `approval-gates.md` v2 file.
- Add a one-line pointer in `PLUGIN_DEVELOPMENT_GUIDE.md` (under the Three-Point Approval Pattern section).
- No SKILL.md edits.
- No new lint rule yet.

**Follow-up PR (after §9 decisions confirmed):**
- For each ALM SKILL.md, add the `<!-- gate: ID -->` HTML comment + human `> 🚦 Gate (...)` block above every gate listed in §6.
- Mark every "not-a-gate" row with `<!-- not-a-gate: <reason> -->`.
- Add the 5 lint rules to `scripts/lint-skills-alm.js` with hard-fail for ALM, warn-only for non-ALM.
- Update `references/deployment-error-catalog.md` to cross-reference the per-pattern gate IDs from §6.12.

**Follow-up #2 (non-ALM extension):**
- Sweep the 13 non-ALM skills, populate §8 with full catalog rows, switch their lint mode from warn to hard-fail.

---

## 11. Open questions remaining

These are honest unresolved questions — not necessary to answer before v2 lands, but flagged for future tightening:

- **Does `intent` need a sub-category for plan-alm itself?** plan-alm is the orchestrator; it doesn't have a Phase 0 ALM-plan gate (because it *is* the plan). The closest analogue is `plan-alm:1.deferral` (handle `.alm-deferred` marker) and `plan-alm:1.completeness` (completeness check). Both are tagged `progress` in §6.1 — defensible but worth a second look.
- **Should `pause` gates be allowed to auto-resume?** Currently the lint rule would flag any tooling that auto-responds. But if PP Pipelines exposes a polling endpoint that detects approval state, a deterministic auto-resume becomes possible. Worth a future rule extension.
- **Telemetry on gate cancellation.** A gate that's cancelled 80% of the time is asking the wrong question. Out of scope for v2; worth instrumenting once §5 lint lands.
- **Multi-prompt gates.** Some entries in §6 cover multiple `AskUserQuestion` calls under one marker (e.g., `setup-solution:5.5*` is one logical gate but renders three multiSelect prompts). The lint rule says one marker can cover multiple calls if the catalog row documents it. Worth a more precise rule once we see drift.
