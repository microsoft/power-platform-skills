# Approval Gates — Power Pages Skill Catalog (v3)

> **Status: v3 — extended to non-ALM skills.** v2 introduced the marker/lint design and catalogued the 12 ALM skills (§6.1–§6.12). v3 extends coverage to the 12 non-ALM skills (§6.13–§6.24), flips lint severity from warn-only to hard-fail across the plugin, and updates `AGENTS.md` so any new skill must add its gates here in the same PR.
>
> **Scope: all power-pages skills.** §6 enumerates every `AskUserQuestion` across the 24 user-invocable skills (12 ALM + 12 non-ALM). `report-issue` is a cross-plugin shared workflow — its wrapper SKILL.md contains no prompts (the workflow file at `shared/skills/report-issue/report-issue-workflow.md` lives outside the per-plugin lint scope) and is excluded from this catalog.
>
> **Markers applied across all SKILL.md files.** Each gate has both a machine-readable `<!-- gate: ID | category=X | cancel-leaves=Y -->` HTML comment and a human-readable `> 🚦 **Gate (...)**` block. Each pure data-gathering prompt has a `<!-- not-a-gate: <reason> -->` comment.
>
> **Lint is hard-fail for every skill.** `scripts/lint-skills-alm.js` enforces seven gate-related rules at error severity on every SKILL.md under `plugins/power-pages/skills/`: `GATE-must-have-marker`, `GATE-id-must-be-unique`, `GATE-must-be-in-catalog`, `GATE-intent-must-call-helper`, `GATE-cancel-leaves-known-vocab`, `GATE-prose-block-required` (the marker must be followed by a 🚦 prose block within 10 lines, outside any code fence), and `CATALOG-row-must-have-marker` (every `kind: gate` catalog row must have a corresponding marker in some SKILL.md — the reverse of `GATE-must-be-in-catalog`).

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

> **Deploy-dispatch prompts ("Deploy now?") are `plan`, not `consent`.** Many non-ALM skills (`create-site:8.deploy`, `add-server-logic:11.3.deploy`, `add-cloud-flow:8.4.deploy`, etc.) end with a "Deploy now / Later" prompt that invokes `/deploy-site`. These are `plan` gates — the user is choosing *whether to dispatch a child skill*, not approving the destructive action itself. The destructive Dataverse write lives inside `/deploy-site`'s own `consent` gate at `deploy-site:3.confirm-env`, which echoes the target env and requires explicit confirmation. The pattern is dispatch-then-consent: `plan` here, `consent` there. Compare `deploy-site:6.2.unblock-js` (`consent`, modifies tenant-wide `blockedattachments`) — that one IS destructive at its call site and is tagged accordingly. If a future "Deploy now?" prompt skips the dispatch and writes directly to Dataverse, retag it `consent`.

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
> **Why we ask:** What goes wrong if a tool bypasses the prompt.
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
> **Why we ask:** Wrong-stage deploy. Non-transactional — partial failure leaves whatever already imported on the target.
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

### 6.1 `plan-alm` (15 calls; planner)

> `plan-alm` is a **planner** — it produces an approved/draft HTML plan and never executes. The execution gates that used to live in Phases 5–8 (deploy-failure, post-deploy activation, manual export/import checkpoint) now belong to the individual ALM skills the user runs afterward; they are catalogued under those skills' sections, not here.

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
| `plan-alm:2.q4-host` | gate | plan | 2 (Q4 PP) | Host environment selection — branched table consuming `HOST_RESOLUTION` status (use-detected / pick from list / NoHost host-type menu / Sandbox confirm / CannotRedirect block / manual paste). Per-stage env URLs are inferred from the Q3 stage-layout answer + `pac env list`, not collected via a separate prompt. | nothing |
| `plan-alm:2.q5-approval` | gate | plan | 2 (Q5 PP) | *"Approvals: required each stage / staging auto + prod required / no gates"* | nothing |
| `plan-alm:2.q3-manual` | gate | plan | 2 (Q3 Manual) | *"How many target envs?"* | nothing |
| `plan-alm:2.q4-manual-target` | gate | plan | 2 (Q4 Manual per stage) | *"URL for target env {N}?"* | nothing |
| `plan-alm:2.q5-manual-type` | gate | plan | 2 (Q5 Manual) | *"Export managed or unmanaged?"* | nothing |
| `plan-alm:4.approve` | gate | plan | 4 | *"Save approved / Save draft / Change something"* — saves the plan; never executes | nothing |
| `plan-alm:4.approver` | not-a-gate | — | 4 | Approver-name capture (option 1 only) — always-on interactive prompt with git/OS-name prefill; data-gathering for the audit trail | — |

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

(Three additional `AskUserQuestion` calls in this skill are sub-prompts inside the gates above — env-var value entry per variable inside `5.env-vars`, validation `Approved? Yes / No` follow-ups inside `4.pending-approval` and `6.pending-approval`. They share the parent gate's marker. The `6.0.final-consent` marker covers both the `DeployPackageAsync` and `pac pipeline deploy` paths — no separate ID for the CLI fallback.)

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
| `configure-env-variables:2.selection` | gate | plan | 2 | Settings classified — *"Which to promote? Per-stage values per setting"*. Per-stage values matrix is built inside this same multi-question prompt. | nothing |
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

### 6.9 `force-link-environment` (3 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `force-link-environment:2.host-url` | gate | plan | 2 | Host URL not resolved from `--host` arg / `last-host-check.json` / `last-pipeline.json` — *"Pick host (with paste-URL fallback)"* | nothing |
| `force-link-environment:2.dev-env` | gate | plan | 2 | Dev env BAP GUID not resolved from `--dev-env` arg or `pac env who` confirmation — *"Pick / paste"* | nothing |
| `force-link-environment:4.destructive` | gate | consent | 4 | Mandatory gate before `ManageEnvironmentStamp` — *"DESTRUCTIVE: confirm cross-host stamp move"* | nothing |

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

### 6.13 `create-site` (5 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `create-site:1.purpose` | gate | plan | 1 | Site purpose unclear — multi-question prompt (site name, framework, purpose, audience, location) | nothing |
| `create-site:3.requirements` | gate | plan | 3 | *"Which features? / Aesthetic / Mood"* — three sub-prompts sharing this gate; shape the rendered Phase 4 plan | nothing |
| `create-site:4.7.plan-approval` | gate | plan | 4.7 | HTML plan rendered — *"Approve and start building / I'd like to make changes"* | nothing |
| `create-site:7.review` | gate | plan | 7 | Live site ready — *"Would you like any changes?"* | nothing |
| `create-site:8.deploy` | gate | plan | 8 | *"Deploy now (Recommended) / Skip for now"* — invokes `/deploy-site` on Yes | nothing |

---

### 6.14 `deploy-site` (8 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `deploy-site:2.auth-url` | not-a-gate | — | 2 | Free-text env URL when PAC CLI not authenticated — data-gathering | — |
| `deploy-site:3.confirm-env` | gate | consent | 3 | Echoes current env — *"Deploy to this environment? Yes / No, choose different"*. Covers the follow-up "pick different env" sub-prompt at the same step (single section, paired by marker proximity). Wrong-env deploy is destructive — confirmation is mandatory. | nothing |
| `deploy-site:4.1.multi-project` | gate | plan | 4.1 | Multiple `powerpages.config.json` candidates found — *"Which project to deploy?"* | nothing |
| `deploy-site:4.2.audit-permissions` | gate | plan | 4.2 | Re-deployment detected (`.powerpages-site` exists) — *"Run permissions audit first / Skip"* | nothing |
| `deploy-site:5.5.1.activate` | gate | plan | 5.5.1 | Site not yet activated — *"Activate now / Skip"* | nothing |
| `deploy-site:5.6.restart-cache` | gate | plan | 5.6 | Site activated — *"Restart site to flush cache? (brief downtime) / Skip"* | nothing |
| `deploy-site:6.2.unblock-js` | gate | consent | 6.2 | Upload failed because `.js` is blocked — *"Remove .js block from `blockedattachments`? / No"*. Modifies tenant-wide env setting — destructive shared state. | `attachment-block-modified` |

---

### 6.15 `add-server-logic` (12 calls / 8 gates + 4 sub-prompts)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `add-server-logic:1.5.deploy-first` | gate | plan | 1.5 | `.powerpages-site` missing — *"Deploy now (Required) / Cancel"* — entry condition for the skill | nothing |
| `add-server-logic:2.1.2.use-custom-actions` | gate | plan | 2.1.2 | Custom actions discovered — *"Wrap an existing custom action? Yes / No, build from scratch"* — changes implementation shape | nothing |
| `add-server-logic:2.1.2.per-item-action` | not-a-gate | — | 2.1.2 | Per-item follow-up — *"For `<name>` endpoint, which custom action?"* — data-gathering sub-prompt under the previous gate's Yes path | — |
| `add-server-logic:2.3.1.keyvault` | gate | plan | 2.3.1 | Secrets identified — *"Use Azure Key Vault (Recommended) / Store directly as env var"* — affects the Phase 4 plan and Phase 7 implementation | nothing |
| `add-server-logic:2.4.clarify` | not-a-gate | — | 2.4 | Multi-question clarification when intent is ambiguous — data-gathering | — |
| `add-server-logic:4.4.plan-approval` | gate | plan | 4.4 | HTML plan rendered — *"Approve and implement / Request changes / Cancel"* | nothing |
| `add-server-logic:7.2a.select-vault` | not-a-gate | — | 7.2a | Pick which Key Vault to use — data-gathering sub-prompt under the Phase 2.3.1 Yes path | — |
| `add-server-logic:7.2a.no-vaults` | gate | plan | 7.2a | No Key Vaults found — *"Create new (Recommended) / Fall back to plain env var"* — branches the secret-storage flow | nothing |
| `add-server-logic:7.2a.vault-params` | not-a-gate | — | 7.2a | Vault name / RG / location free-text — data-gathering for the create call | — |
| `add-server-logic:9.1.frontend-scope` | gate | plan | 9.1 | *"Fully integrate into UI (Recommended) / I'll handle frontend myself"* — decides Phase 9 work scope | nothing |
| `add-server-logic:11.3.deploy` | gate | plan | 11.3 | *"Deploy now (Recommended) / Later"* — invokes `/deploy-site` on Yes | nothing |
| `add-server-logic:11.3.test` | gate | plan | 11.3 | After successful deploy — *"Run `/test-site` now / Skip"* | nothing |

---

### 6.16 `add-cloud-flow` (6 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `add-cloud-flow:1.3.deploy-first` | gate | plan | 1.3 | `.powerpages-site` missing — *"Deploy now (Required) / Cancel"* | nothing |
| `add-cloud-flow:3.1.select-flows` | gate | plan | 3.1 | Multi-select over discovered + already-registered flows — *"Which flows to add or integrate?"* | nothing |
| `add-cloud-flow:3.3.scenario-clarify` | not-a-gate | — | 3.3 | Per-flow scenario clarification when flow name/description is ambiguous — data-gathering for Phase 4 role assignment | — |
| `add-cloud-flow:5.3.plan-approval` | gate | plan | 5.3 | HTML plan rendered — *"Approve and implement / Request changes / Cancel"* | nothing |
| `add-cloud-flow:8.4.deploy` | gate | plan | 8.4 | *"Deploy now (Recommended) / Later"* | nothing |
| `add-cloud-flow:8.4.test` | gate | plan | 8.4 | After successful deploy — *"Run `/test-site` to validate flow integration / Skip"* | nothing |

---

### 6.17 `setup-auth` (5 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `setup-auth:1.3.deploy-first` | gate | plan | 1.3 | `.powerpages-site` missing — *"Deploy now (Required) / Later"* | nothing |
| `setup-auth:1.4.create-webroles` | gate | plan | 1.4 | No web roles found — *"Create web roles first (Recommended) / Skip"* | nothing |
| `setup-auth:2.1.requirements` | gate | plan | 2.1 | *"Which auth features? Login+Logout+RBAC / Login+Logout only / RBAC only"* — covers the follow-up "which roles get access" sub-prompt in the same step | nothing |
| `setup-auth:2.2.plan-approval` | gate | plan | 2.2 | *"Approve and proceed / I'd like to make changes"* | nothing |
| `setup-auth:8.4.deploy` | gate | plan | 8.4 | *"Deploy now (Recommended) / Later"* — auth doesn't work until deployed | nothing |

---

### 6.18 `integrate-webapi` (5 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `integrate-webapi:3.2.confirm-tables` | gate | plan | 3.2 | *"Which tables to integrate? All / Let me select / Add more"* | nothing |
| `integrate-webapi:6.1.deploy-first` | gate | plan | 6.1 | `.powerpages-site` missing — *"Deploy now (Recommended) / Skip permissions setup"* | nothing |
| `integrate-webapi:6.2.permissions-source` | gate | plan | 6.2 | *"Upload existing diagram / Let architects figure it out"* | nothing |
| `integrate-webapi:6.2.permissions-approval` | gate | plan | 6.2 (Path A) | Parsed permissions plan rendered — *"Approve and create files / Request changes / Cancel"* | nothing |
| `integrate-webapi:7.3.deploy` | gate | plan | 7.3 | *"Deploy now (Recommended) / Later"* — Web API calls won't work until deployed | nothing |

---

### 6.19 `setup-datamodel` (2 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `setup-datamodel:2.source` | gate | plan | 2 | *"Upload existing ER diagram / Let the Data Model Architect figure it out"* | nothing |
| `setup-datamodel:4.2.approval` | gate | plan | 4.2 | Data model proposal rendered — *"Approve and create tables (Recommended) / Request changes / Cancel"* | nothing |

---

### 6.20 `add-sample-data` (2 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `add-sample-data:3.1.tables` | gate | plan | 3.1 | Multi-select over discovered tables — *"Which tables to populate?"* | nothing |
| `add-sample-data:3.2.count` | gate | plan | 3.2 | *"How many records per table? 5 / 10 / 25 / Custom"* — covers the sub-prompt for the custom count | nothing |

---

### 6.21 `add-seo` (3 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `add-seo:2.config-call1` | not-a-gate | — | 2 | Production URL + exclusion choice — data-gathering for the upcoming Phase 3 plan | — |
| `add-seo:2.config-call2` | not-a-gate | — | 2 | Meta description + OG-tag preference — data-gathering for the upcoming Phase 3 plan | — |
| `add-seo:3.plan-approval` | gate | plan | 3 | SEO plan rendered inline — *"Approve and proceed (Recommended) / Make changes"* | nothing |

---

### 6.22 `create-webroles` (3 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `create-webroles:1.deploy-first` | gate | plan | 1 | `.powerpages-site` missing — *"Deploy now (Recommended) / Later"* | nothing |
| `create-webroles:3.role-selection` | gate | plan | 3 | *"Which web roles to create?"* — multi-select over suggested + custom roles | nothing |
| `create-webroles:6.deploy` | gate | plan | 6 | *"Deploy now (Recommended) / Later"* — roles don't take effect until deployed | nothing |

---

### 6.23 `audit-permissions` (1 call)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `audit-permissions:6.fix-offer` | gate | plan | 6 | Audit complete — *"Would you like me to fix any of these issues? Yes / No"* — declining leaves the audit report untouched; accepting routes to the table-permissions-architect agent | nothing |

---

### 6.24 `integrate-backend` (2 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `integrate-backend:2.2.clarify` | not-a-gate | — | 2.2 | Ambiguous-intent clarification (sync vs async, external APIs, secrets, one-off vs workflow) — data-gathering for the Phase 3 plan | — |
| `integrate-backend:3.4.plan-approval` | gate | plan | 3.4 | HTML plan rendered — *"Approve and proceed / Change approach / Cancel"* — branches to the right child skill (`integrate-webapi` / `add-server-logic` / `add-cloud-flow`) | nothing |

---

### 6.24a Security skills — runtime-loop pattern (now anchored)

The four security skills introduced in PR #151 (`manage-firewall`, `manage-headers`, `scan-site`, `security-review`) use `AskUserQuestion` differently from the other skills: most calls happen inside a "recommend then ask" runtime loop that was originally described in prose without a literal `AskUserQuestion`:` call site.

v3 closed this coverage hole by surfacing the recommend-then-ask block as a real call site in the prose:

- `manage-firewall:3.action-choice` (gate, plan) — `### Default approach`; routes to which destructive action runs.
- `manage-firewall:3.execute-consent` (gate, consent) — `### Plan-validate-execute`; final consent before each WAF mutation.
- `scan-site:3.action-choice` (gate, plan) — `### Default approach`; idle/running × has-report/no-report decision.
- `manage-headers:3.per-finding` (gate, plan) — `### Default approach`; per-finding accept / customize / skip loop.
- `security-review:2.1.goal` + `5.3.next-action` (gates, plan) — goal capture + post-report next-action.

The `### Option rules` sections in `manage-firewall` and `scan-site` retain `<!-- not-a-gate -->` markers — they document HOW to construct prompts but aren't call sites themselves.

---

### 6.25 `manage-firewall` (3 gate IDs)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `manage-firewall:3.action-choice` | gate | plan | 3 (`### Default approach`) | Recommend an action based on firewall state; user accepts or picks differently. Loops back here after each Phase 4 apply if the user wants additional changes. | nothing |
| `manage-firewall:3.execute-consent` | gate | consent | 3 (`### Plan-validate-execute`) | Final consent before any destructive WAF mutation (enable/disable, add/update/delete rule). Fires PER CHANGE. | nothing |
| `manage-firewall:3.option-rules-meta` | not-a-gate | — | 3 (`### Option rules`) | Meta-documentation describing how to structure `AskUserQuestion` options in this skill — not a literal call site. | — |

---

### 6.26 `manage-headers` (1 call)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `manage-headers:3.per-finding` | gate | plan | 3 (`### Default approach`) | Per-finding loop — *"For each finding, present via `AskUserQuestion`: accept the recommendation, customize, or skip"*. Fires PER FINDING; skipped findings leave the header at its current value. | nothing |

---

### 6.27 `scan-site` (2 gate IDs)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `scan-site:3.action-choice` | gate | plan | 3 (`### Default approach`) | Recommend an action based on scan state (running/idle/has-report). Starting a new scan triggers a multi-minute backend run; using an existing report is free. | nothing |
| `scan-site:3.option-rules-meta` | not-a-gate | — | 3 (`### Option rules`) | Meta-documentation describing how to structure `AskUserQuestion` options. Not a call site. | — |

---

### 6.28 `security-review` (2 calls)

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `security-review:2.1.goal` | gate | plan | 2.1 | *"What to review? Access & config / Release readiness / Deployed site"* — branches into 3 different sub-skill sets. | nothing |
| `security-review:5.3.next-action` | gate | plan | 5.3 | Post-report prompt — *"Walk me through the fixes / Re-run the review / Done for now"*. Drives whether remediation skills get invoked next. | nothing |

---

### 6.29 `add-ai-webapi` (4 calls)

New skill introduced by PR #144. Orchestrates AI summarization API integration across three layers (Web API settings, table permissions, and `Summarization/*` site settings). It delegates heavily to `/integrate-webapi` and `/create-webroles` sub-skills; the gates below cover the orchestrator-level decisions.

| ID | Kind | Category | Phase | Trigger / question | Cancel leaves |
|---|---|---|---|---|---|
| `add-ai-webapi:iter.deploy-commit` | gate | consent | Iteration mode | End-of-iteration batched prompt — *"Deploy and commit now? / Just commit / Just deploy / Neither"*. Avoids per-tweak upload + commit noise on re-entry runs. | nothing |
| `add-ai-webapi:4.2.skip-webrole` | gate | consent | 4.2 | *"Continue without a web role (AI endpoints will 403) / Stop here"* — fires only when the user skipped web-role creation and the run is on a known-broken path. | nothing |
| `add-ai-webapi:5.5.commit` | gate | consent | 5.5 | *"Commit Phase 5 Layer 3 integration changes now? / Skip"* — explicit commit after summarization-service + UI wiring complete. | nothing |
| `add-ai-webapi:6.4.commit` | gate | consent | 6.4 | *"Commit new Summarization/* site settings? / Skip"* — explicit commit after `ai-webapi-settings-architect` creates the YAMLs. | nothing |

---

### Cross-plugin shared skills — out of catalog scope

`report-issue` — The power-pages SKILL.md wrapper at `plugins/power-pages/skills/report-issue/SKILL.md` is a thin re-export that contains no prompts. The actual workflow with `AskUserQuestion` calls lives in `shared/skills/report-issue/report-issue-workflow.md`, which is consumed by every plugin (not just power-pages). The shared workflow lies outside the per-plugin lint scope (`plugins/power-pages/skills/`), so its prompts are not catalogued here. If the shared workflow is ever ported into per-plugin SKILL.md files, add a `report-issue:*` section to this catalog.

---

## 8. Plugin-wide enforcement (was: non-ALM deferral)

> **v3 update.** This section previously listed 13 deferred non-ALM skills. Those skills are now catalogued in §6.13–§6.24 above (plus the security skills introduced by PR #151 in §6.25–§6.28) and the lint runs hard-fail across the whole plugin.

The lint rules in §5 fire at `error` severity for **every** SKILL.md under `plugins/power-pages/skills/`. There is no skill-class carve-out. When you add a new skill:

1. Catalog every `AskUserQuestion` call in §6 — pick category from §3, pick `cancel-leaves` from §4.3.
2. Add `<!-- gate: ... -->` markers in the SKILL.md per §4.
3. Mark every data-gathering prompt with `<!-- not-a-gate: ... -->`.
4. Run `node scripts/lint-skills-alm.js`. CI will block the PR otherwise.

---

## 9. Decisions — pre-resolved with recommendations

These need explicit confirmation from the reviewer before SKILL.md edits land. Recommendation in **bold**.

| # | Decision | Recommendation | Rationale |
|---|---|---|---|
| 1 | Canonical term | **"Approval Gate"** | CI/CD heritage; already the most common word in our SKILL.md files; concrete. Drop "review gate" if used informally. |
| 2 | Marker syntax | **HTML comment `<!-- gate: ID \| category=X \| cancel-leaves=Y -->` + human `> 🚦 Gate (...)` block** | Comment is the lint anchor; block is for humans. Robust to interleaved prose. |
| 3 | Catalog location | **`plugins/power-pages/references/approval-gates.md`** (this file) + a one-line pointer in `PLUGIN_DEVELOPMENT_GUIDE.md` | Sits with other shared references; cross-skill scope is obvious from the path. |
| 4 | Lint rollout strictness | **[v2 — superseded by §10.] ALM: hard-fail. Non-ALM: warn-only until §8 catalog extends.** v3 made enforcement hard-fail across every skill once the catalog was extended; the warn-only branch is gone. | ALM is fully catalogued; non-ALM is the follow-up. Hard-fail on ALM forces drift to be caught at PR time. |
| 5 | Emoji vs plain text | **Keep `🚦` in the human block; lint anchors on the HTML comment regardless** | Emoji is for humans; tooling doesn't depend on it. |
| 6 | Wildcard gate IDs (e.g. `diagnose-deployment:6.*`) | **Disallowed. Enumerate per pattern.** | Per-pattern markers enforce that each catalog-listed deployment-error pattern has matching prompt logic. |

---

## 10. Landing history

**v2 PR (landed)** — `approval-gates.md` v2 doc; `<!-- gate: ID -->` markers added to the 12 ALM SKILL.md files; 5 GATE lint rules added to `scripts/lint-skills-alm.js` at hard-fail for ALM, warn-only for non-ALM.

**v3 PR (this branch — `users/nityagi/ApplyApprovalGatesPattern`)** — extends the catalog and enforcement to the 12 non-ALM skills plus the 4 security skills picked up in the rebase:

- §6.13–§6.24 added — full catalog rows for `create-site`, `deploy-site`, `add-server-logic`, `add-cloud-flow`, `setup-auth`, `integrate-webapi`, `setup-datamodel`, `add-sample-data`, `add-seo`, `create-webroles`, `audit-permissions`, `integrate-backend` (45 gates + 9 not-a-gates).
- §6.24a–§6.28 added — security skills introduced by PR #151 (`manage-firewall`, `manage-headers`, `scan-site`, `security-review`). The new skills use a runtime-loop prompt pattern; §6.24a documents the marker convention for that pattern. 3 gates + 2 not-a-gates.
- Markers added to all non-ALM SKILL.md files (HTML comment + 🚦 block per gate; `not-a-gate` comment per data-gathering prompt or meta-mention).
- `scripts/lint-skills-alm.js` warn-only branch removed — all skills now hard-fail.
- `AGENTS.md` Key Patterns updated — Approval Gate convention applies plugin-wide; new skills must extend §6 in the same PR they introduce a prompt.
- `report-issue` excluded from the catalog (cross-plugin shared workflow lives outside the per-plugin lint scope). **Cross-plugin TODO:** the `AskUserQuestion` calls in `shared/skills/report-issue/report-issue-workflow.md` are not caught by any per-plugin lint today. A future cross-plugin sweep should either (a) define a `shared:*` namespace in the catalog and add markers in the shared workflow, or (b) duplicate the workflow into each plugin so the per-plugin lint covers it.
- v3 lint changes: removed warn-only branch; tightened `m <= promptLine` to strict `m <`; relaxed `CATALOG_GATE_ID_PATTERN` to case-insensitive on the skill-name segment; added two new rules — `CATALOG-row-must-have-marker` (reverse check — catalog rows of `kind: gate` must have a matching SKILL.md marker; prevents the orphan-row class of bug v3 closed by hand) and `GATE-prose-block-required` (every marker must be followed within 10 lines by a 🚦 sentinel; minimum-viable check against prose-block deletion). Field rename: `Blast radius if skipped:` → `Why we ask:` across all ~60 prose blocks plus §4.1 template.

---

## 11. Open questions remaining

These are honest unresolved questions — not necessary to answer before v2 lands, but flagged for future tightening:

- **Does `intent` need a sub-category for plan-alm itself?** plan-alm is the front-door planner; it doesn't have a Phase 0 ALM-plan gate (because it *is* the plan). The closest analogue is `plan-alm:1.deferral` (handle `.alm-deferred` marker) and `plan-alm:1.completeness` (completeness check). Both are tagged `progress` in §6.1 — defensible but worth a second look.
- **Should `pause` gates be allowed to auto-resume?** Currently the lint rule would flag any tooling that auto-responds. But if PP Pipelines exposes a polling endpoint that detects approval state, a deterministic auto-resume becomes possible. Worth a future rule extension.
- **Telemetry on gate cancellation.** A gate that's cancelled 80% of the time is asking the wrong question. Out of scope for v2; worth instrumenting once §5 lint lands.
- **Multi-prompt gates.** Some entries in §6 cover multiple `AskUserQuestion` calls under one marker (e.g., `setup-solution:5.5*` is one logical gate but renders three multiSelect prompts). The lint rule says one marker can cover multiple calls if the catalog row documents it. Worth a more precise rule once we see drift.
- **Phase-number drift is silent.** Catalog rows reference SKILL.md phase numbers as plain strings (`7.6.4`, `3 (Q3 PP)`, `2.1.2`). If a skill is refactored to renumber phases (e.g. `7.6.4` → `7.7.1`), the catalog row's "Phase" column desyncs with no signal. **Convention:** any SKILL.md phase renumber MUST grep this catalog for the old phase number and update the row(s). Worth a future lint rule that asserts each catalog phase-reference is findable as a heading in the owning SKILL.md.
- **Runtime-loop coverage — historical.** Earlier v3 drafts treated the manage-firewall + scan-site destructive prompts as a known coverage gap because they sat inside a "recommend then ask" loop with no statically-locatable `AskUserQuestion`:` call site, and only the `### Option rules` sections carried `not-a-gate` markers. v3 closed the gap (see §6.24a) by restructuring the prose to surface real call sites and adding `manage-firewall:3.action-choice`, `manage-firewall:3.execute-consent`, and `scan-site:3.action-choice` as full gate markers. The `not-a-gate` markers on the `### Option rules` sections are retained for the meta-documentation sections only.
- **Lint enforces only the 🚦 sentinel, not the 3 structured labels.** `GATE-prose-block-required` checks for 🚦 within 10 lines of a marker. It does NOT verify the recommended `> **Trigger:**` / `> **Why we ask:**` / `> **Cancel leaves:**` labels — 80+ legacy v2 markers use a one-line prose style. Drift on the labels remains possible. Tightening the rule to require the 3 labels would force a structural rewrite of every legacy marker — explicit deferral.
