# Plugin UX & Reliability

## Why This Matters

A plugin can have many brilliant skills and still feel broken if the user sits staring at a frozen terminal for 90 seconds, has no way to know if the schema actually deployed, or loses their main conversation context because a long deployment blocked the thread.

Here are **five UX and reliability pillars** that every skill and agent must meet before it ships.

---

## The Five Pillars

These five engineering principles address the gap between "the plugin works" and "the plugin feels great to use." Each pillar is a non-negotiable requirement embedded into the acceptance criteria for every skill and agent.

### 01 — Engaging Loading Experience

**Pillar 1 — Perception of speed**

Long operations must show structured progress — not silence. The user should always know what's happening, what phase they're in, and what's next.

### 02 — Action Verification

**Pillar 2 — Trust through proof**

Every action the agent performs must be verifiable. The agent should confirm what it did, show evidence it worked, and give the user a way to validate independently.

### 03 — Sub-Agent Architecture

**Pillar 3 — Context preservation**

Complex, multi-table operations should delegate to specialized agents in isolated contexts, keeping the main conversation responsive and clean.

### 04 — Deterministic Execution

**Pillar 4 — Reliability through determinism**

Deterministic operations (file creation, Dataverse API calls, UUID generation, YAML parsing) must use shared Node.js scripts — not inline LLM-generated commands. LLMs compose the intent; scripts execute it.

### 05 — Transparency & User Approval

**Pillar 5 — No surprises, ever**

The plugin must show every action it performs in real time and seek explicit user approval at defined checkpoints. The user should never be surprised by what the plugin did.

---

## Pillar 1 — Engaging Loading Experience

### The Problem

When a skill deploys a site or audits permissions across many tables, the terminal can go quiet. The user doesn't know if it's working, stuck, or crashed. Unexplained silence beyond 10 seconds causes users to assume failure — and they interrupt the process.

### The Solution

Every skill must implement **task-based progress tracking** using `TaskCreate` and `TaskUpdate`. Tasks are created upfront at Phase 1, one per phase, and marked `in_progress` / `completed` as the skill progresses. **Local styling exception:** `style-site` shows **Inspect/propose → Approve → Apply → Independently verify → Report** status without mandatory task-tool calls; expanded work may use tasks when useful. Do not add seven task creates/updates to routine CSS changes.

### Implementation Pattern

Every skill creates all phase tasks at the start:

```
Phase 1: TaskCreate → subject: "Verify prerequisites", activeForm: "Verifying prerequisites"
Phase 2: TaskCreate → subject: "Discover existing config", activeForm: "Discovering config"
Phase 3: TaskCreate → subject: "Review plan with user", activeForm: "Reviewing plan"
Phase 4: TaskCreate → subject: "Implement changes", activeForm: "Implementing changes"
Phase 5: TaskCreate → subject: "Verify results", activeForm: "Verifying results"
Phase 6: TaskCreate → subject: "Deploy and summarize", activeForm: "Deploying"
```

Each task has three fields:
- `subject` — Imperative form (what to do)
- `activeForm` — Present continuous (shown in the spinner)
- `description` — Brief explanation of the phase

For skills that process multiple entities (e.g., audit-permissions auditing many tables), create **per-entity sub-tasks** dynamically within the relevant phase.

### What This Means in Practice

| Skill | Phases | Dynamic Sub-Tasks |
|-------|--------|-------------------|
| `/deploy-site` | 6 phases (prereqs → auth → env → build/upload → verify → summarize) | None |
| `/integrate-webapi` | 7 phases (prereqs → analyze → plan → implement → verify → permissions → deploy) | Per-table tasks in Phase 4 |
| `/audit-permissions` | 7 phases (prereqs → discover → analyze → audit → cross-check → report → present) | Per-table tasks in Phase 4 (checklist A-K) |
| `/create-site` | 8 phases (prereqs → gather → plan → scaffold → implement → validate → deploy → summarize) | None |

> **Acceptance criterion:** Every skill except the documented `style-site` local workflow must create all phase tasks upfront at Phase 1 start. Each task must have `subject`, `activeForm`, and `description`. Tasks must be marked `in_progress` when starting and `completed` when done. `style-site` must expose equivalent visible status, not mandatory task bookkeeping.

---

## Pillar 2 — Action Verification

### The Problem

The agent says "I've created table permissions and site settings" — but did it? The user has no way to verify without manually inspecting YAML files. This erodes trust.

### The Solution

Every skill must have a **dedicated Verify phase** (typically Phase 5) — separate from implementation. Verification uses a different code path than the action itself.

### The Verification Pattern

After implementation, always run a standalone verification phase that:

1. **Checks expected files exist** — Glob for generated files and confirm count matches plan
2. **Validates schema/content** — Run shared validators (`validate-permissions-schema.js`, `site-settings-validator.js`, `web-roles-validator.js`)
3. **Runs project build** — Confirm no TypeScript/build errors from generated code
4. **Reports results** — Present a summary to the user before proceeding

### Verification in Practice

| Skill | Verification Phase | What It Checks |
|-------|-------------------|----------------|
| `/deploy-site` | Phase 5 | Upload succeeded, site responds, activation status |
| `/integrate-webapi` | Phase 5 | File inventory matches plan, all imports resolve, build passes |
| `/audit-permissions` | Phase 6 | Findings report generated, all tables audited, cross-checks complete |
| `/create-site` | Phase 6 | All pages render, design foundations applied, build passes |
| `/create-webroles` | PostToolUse hook | Web role YAML validates (schema, naming conventions, booleans) |

**Hook-based validation** — Skills tracked in `hooks/hooks.json` get automatic validation when they complete. The `PostToolUse` hook on `Skill` dispatches to per-skill validator scripts via `run-skill-posttool-validation.js`. Validators use `approve()` / `block(reason)` from `scripts/lib/validation-helpers.js`.

> **Acceptance criterion:** No skill that creates, modifies, or deletes files may ship without a dedicated verification phase. Verification must use a different code path than creation (e.g., run validators, glob for files, build the project — don't just trust the write succeeded).

For `style-site`, keep the **independent verification step** even though its coordinator invokes the separate validator in the apply command. Require that result and independently re-read changed files/diffs, including reconstructed inline/class markup. Report desktop/mobile rendering, effective computed values, accessibility and Studio save/reopen as pending separately authorized live checks. Do not generate HTML previews, start a server, require browser review or deploy to manufacture evidence. Static validation and supplied-color math do not establish runtime behavior or Studio editability.

---

## Pillar 3 — Sub-Agent Architecture

### The Problem

Complex operations (multi-table Web API integration, permission analysis, data model design) generate large amounts of intermediate output that pollutes the main context. Additionally, specialized tasks benefit from purpose-built system prompts.

### The Solution

Delegate to specialized **architect agents** defined in `agents/`. Skills invoke agents via the `Task` tool. Each agent has its own context, tool permissions, model, and system prompt.

### Current Agents

| Agent | Purpose | Mode | Key Tools |
|-------|---------|------|-----------|
| `webapi-integration` | Implements Web API code for a single table (client, types, service, hooks) | Generative (writes code) | Read, Write, Edit, Bash, Glob, Grep |
| `table-permissions-architect` | Analyzes site and proposes table permissions plan | Plan mode (proposes, then creates after approval) | Read, Write, Edit, Bash, Glob, Grep, EnterPlanMode |
| `webapi-settings-architect` | Analyzes site and proposes Web API site settings | Plan mode (proposes, then creates after approval) | Read, Write, Edit, Bash, Glob, Grep, EnterPlanMode |
| `data-model-architect` | Analyzes requirements and Dataverse, proposes data model | Plan mode (read-only advisor) | Read, Bash, Glob, Grep, EnterPlanMode |

### Agent Orchestration Patterns

**Sequential-then-parallel** — When agents depend on shared output:

```
# /integrate-webapi Phase 4:
# First table creates the shared powerPagesApi.ts client.
# After the first table completes and the shared client exists,
# invoke all remaining tables IN PARALLEL via multiple Task calls.
```

**Independent parallel** — When agents are fully independent:

```
# /integrate-webapi Phase 6.3:
# table-permissions-architect and webapi-settings-architect are
# INDEPENDENT — invoke them IN PARALLEL rather than sequentially.
# Wait for BOTH agents to complete before proceeding.
```

### Plan Mode

Architect agents use `EnterPlanMode` / `ExitPlanMode` to propose plans before creating files. The agent renders an HTML visualization (Mermaid diagram, permissions matrix, etc.) for the user to review. If the user rejects, the agent revises. This prevents costly rework.

### When to Delegate vs. Inline

| Operation | Approach | Rationale |
|-----------|----------|-----------|
| Generate a React component | Inline (main agent) | Fast, context-relevant, user wants to see output |
| Integrate Web API for one table | **Agent** (`webapi-integration`) | Specialized system prompt, isolated context |
| Analyze and propose permissions | **Agent** (`table-permissions-architect`) | Plan mode, specialized analysis |
| Run a deterministic script | Inline (`node script.js`) | Fast, no agent overhead needed |
| Audit permissions across many tables | Inline with per-table sub-tasks | Skill orchestrates, but tracks per-table progress |

> **Acceptance criterion:** Skills must delegate specialized work to purpose-built agents. Agent invocations must be documented as sequential or parallel with rationale. Agents that propose changes must use plan mode.

---

## Pillar 4 — Deterministic Execution

### The Problem

LLMs are probabilistic. When an LLM constructs inline bash commands for Dataverse API calls, file creation, or YAML generation, minor variations cause intermittent failures that are hard to debug.

### The Principle

**LLMs compose. Scripts execute.** The LLM determines *what* needs to happen (intent). Shared Node.js scripts *make it happen* (execution). This separation creates a deterministic layer that produces the same result every time.

### Script Categories

**Shared helpers** (`scripts/lib/`):

| Module | Purpose |
|--------|---------|
| `validation-helpers.js` | `runValidation()`, `findPath()`, `findProjectRoot()`, `approve()`, `block()` — shared boilerplate for all validators |
| `powerpages-config.js` | Loads `.powerpages-site` YAML files (table permissions, site settings, web roles) with consistent parsing |
| `powerpages-hook-utils.js` | Discovers skill folders and optional validator scripts for the hook dispatcher |
| `powerpages-schema-validator.js` | Validates permission/site-setting YAML schema |
| `table-permissions-validator.js` | Validates table permission YAML |
| `web-roles-validator.js` | Validates web role YAML |
| `site-settings-validator.js` | Validates site setting YAML |
| `render-template.js` | Template rendering with `__PLACEHOLDER__` variable substitution |

**File creation scripts** (`scripts/`):

| Script | Purpose |
|--------|---------|
| `create-table-permission.js` | Generates table permission YAML with proper formatting, UUIDs, field ordering |
| `create-site-setting.js` | Generates site setting YAML |
| `generate-uuid.js` | Centralized UUID generation — never duplicate this |
| `update-skill-tracking.js` | Records skill usage in site settings |

**Dataverse API scripts** (`scripts/` and skill-specific `scripts/`):

| Script | Purpose |
|--------|---------|
| `dataverse-request.js` | Generic authenticated Dataverse API request helper |
| `verify-dataverse-access.js` | Verifies Dataverse connectivity and permissions |
| `check-activation-status.js` | Queries Power Platform API for site activation status |
| `clear-site-cache.js` | Clears site cache via Power Platform API |

### Usage Pattern

Skills invoke scripts via `node` with CLI arguments:

```bash
node "${PLUGIN_ROOT}/scripts/create-table-permission.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --permissionName "<Permission Name>" \
  --tableName "<table_logical_name>" \
  --webRoleIds "<uuid1,uuid2>" \
  --scope "Global" \
  --read --create
```

Scripts that call Dataverse APIs import `getAuthToken` and `makeRequest` from `scripts/lib/validation-helpers.js`. Never use inline PowerShell `Invoke-RestMethod` for API calls.

### Testing Requirement

Every script must have test coverage in `scripts/tests/`. Run tests with:

```bash
node --test plugins/power-pages/scripts/tests/
```

> **Acceptance criterion:** All file creation, YAML generation, UUID generation, and Dataverse API calls must use shared scripts. No skill may use LLM-generated inline commands for operations that have a shared script. New scripts must ship with test coverage.

---

## Pillar 5 — Transparency & User Approval

### The Problem

An agent that silently creates table permissions, modifies site settings, and deploys — all from a single prompt — is dangerous in an enterprise context. The user didn't see what happened, didn't consent to each step, and can't explain to their team what the plugin did.

### The Principle

**Show everything. Ask at defined checkpoints.** The plugin operates with radical transparency: every action is logged, every decision is explained, and user approval is required at specific points in the workflow.

### The Three-Point Approval Pattern

Every skill pauses for user approval at three junctures:

1. **After discovery** — Present what was found (existing config, code patterns, tables). Ask the user to confirm the scope before planning.
2. **After planning** — Present the proposed plan (HTML visualization, permissions matrix, integration list). Ask the user to approve before implementing.
3. **Before deployment** — Present what was created. Ask "Ready to deploy?" and invoke `/deploy-site` if yes.

**`style-site` local-only exception:** Ordinary broad declarations on one localized page, at most 3 components/10 style groups in one section, inline-only/stylesheet-only/inline+CSS with at most one existing stylesheet and guarded same-page class additions can use the small-change route when Bootstrap/source/cascade are known. Any raw `style.css`, `global: true`, nonempty `externalResources` or `importantReason`, shared templates/metadata, new files, Studio-only/source-free descriptors or broader/ambiguous scope needs expanded review. True blockers, including generated-source work, need local next steps, not successful handoffs. Only expanded/ambiguous work asks `3.scope`; small changes review scope at exact-hash `5.approve`. Runtime consent (`2.runtime`) is separate; drift/revisions (`6.reapprove`) require new diff/hash approval. No final-completion/deployment questions, unattended approval or HTML/browser prerequisite.

Between checkpoints, skills work **autonomously** — no mid-analysis questions.

> **Approval Gates — canonical catalog.** Every individual `AskUserQuestion` that meets the gate test (would Cancel leave partial or complete-but-wrong state behind?) is an **Approval Gate**. See `references/approval-gates.md` for the canonical terminology, the six categories (`intent` / `plan` / `progress` / `consent` / `final` / `pause`), the marker syntax (`<!-- gate: skill:phase | category=X | cancel-leaves=Y -->` + human-readable `> 🚦 **Gate (...)**` block), the per-skill catalog, and the seven gate-related lint rules: `GATE-must-have-marker`, `GATE-id-must-be-unique`, `GATE-must-be-in-catalog`, `GATE-intent-must-call-helper`, `GATE-cancel-leaves-known-vocab`, `GATE-prose-block-required` (marker followed by 🚦 prose block within 10 lines, outside any code fence), and `CATALOG-row-must-have-marker` (every `kind: gate` catalog row must have a corresponding marker in some SKILL.md — the reverse of `GATE-must-be-in-catalog`). **Every skill in this plugin** is enforced at `severity: 'error'` — there is no ALM vs non-ALM carve-out. When you add a new skill that introduces an `AskUserQuestion`, you must extend `references/approval-gates.md` §6 with the new gate-id(s) in the same PR; CI will block otherwise. Data-gathering prompts (free-text fallbacks, configuration sub-prompts) take a `<!-- not-a-gate: <reason> -->` comment instead.

### Approval in Practice

| Skill | Checkpoint 1 (Discovery) | Checkpoint 2 (Plan) | Checkpoint 3 (Deploy) |
|-------|--------------------------|---------------------|----------------------|
| `/deploy-site` | Confirm environment is correct | N/A (no plan phase) | Confirm site activation |
| `/integrate-webapi` | Confirm tables to integrate | Approve permissions/settings plans (via plan mode agents) | Deploy site |
| `/audit-permissions` | N/A (autonomous discovery) | N/A (autonomous audit) | "Fix issues?" after report |
| `/create-site` | Confirm requirements | Approve site plan | Deploy site |
| `/create-webroles` | Confirm web role requirements | Approve roles and assignments | Deploy site |

### Decision Explanation

When the agent makes a non-obvious design choice, it must explain *why*:

```
Decision: Set Contact permission to Read + Create only (not Update or Delete).
Reason: Customer-facing portals should follow least-privilege. Customers can view
their own contacts and create new ones, but cannot modify or delete existing records.
```

### Actions That Always Require Approval

| Action Category | Examples |
|----------------|----------|
| **Production deployment** | `pac pages upload-code-site` to any environment |
| **Security configuration** | Creating/modifying table permissions, web roles |
| **Environment changes** | Enabling JS attachments, changing site settings |
| **Destructive operations** | Deleting permissions, removing web roles |

> **Acceptance criterion:** Every skill must implement the three-point approval pattern or the documented `style-site` local-only gates. No approval-gated action may proceed without explicit user confirmation via `AskUserQuestion`. Skills must work autonomously between checkpoints — no mid-analysis questions.

### Lean classic styling guidance

Keep `style-site/SKILL.md` plus its mandatory `references/quick-start.md` within **12,000 UTF-8 bytes**, with SKILL.md at most **6,000 characters** as the target. The quick start contains one validated request and typical properties, not duplicated schema/allowlists. Load policy/version/deep request/CLI references only when applicable. Routine CSS uses bundled verified guidance; web documentation is for unknown/conflicting/stale guidance or explicit requests. Reuse the unchanged version-check script's result once per installed plugin version in the current conversation.

Use bounded inspector summaries with full evidence on disk, then one coordinator prepare command per fresh external revision directory, producing only plan/review JSON. Review the full exact-diff artifact before approval if its summary is truncated. Coordinator apply retains guarded preflights and independent verification; do not prescribe additional routine validate/dry-run/validate calls. Keep individual commands for diagnostics, external receipts for recovery, and the no-args hook as a backstop only. Record normal `StyleSite` usage after verified local or explicitly requested instructions-only completion, preserving supported-directory no-op and separate tracking diffs; canceled drafts/blocked local work do not track. Do not change the model or weaken approval/integrity checks to optimize this workflow.

Use the bundled component Design-panel map for availability, **not exclusive ownership**. Both listed and unlisted properties default to local `owner: "custom"` authoring. Prefer the actual static inline declaration; otherwise use effective CSS at the locale sidecar or an appropriate custom Web File. For Web File changes, report custom CSS priority above `theme.css` and below `portalbasictheme.css` as guidance only. Do not infer priority, block preparation, allocate slots or renumber files using `displayorder`; new CSS Web Files omit that field. Preserve native source/Liquid/IDs/accessibility/Studio markers and default assets/order. Existing exact-property inline importance may remain; authored `!important` needs nonempty `importantReason` and expanded review. Never blindly raise priority/specificity to avoid local inline edits, rewrite DOM or replace native components. Raw CSS cannot bypass root conflicts; native colors are local dependencies, not Studio prerequisites.

General declarations use pinned bundled css-tree structural parsing, not fixed property/value/part or gradient allowlists. Support standard CSS custom properties, font stacks, sizing/layout/functions, shadows, transforms, transitions and all gradient kinds. Unknown or semantic-grammar-unverified values yield explicit warnings; malformed/injected/legacy executable CSS fails. Fix actual invalid values or verify newer browser support before approving. Parser support is not Power Pages/browser/Studio rendering proof; missing parser grammar is not a Power Pages prohibition.

Preserve authored/insertion declaration order, never alphabetize: shorthands can reset earlier longhands. Pinned mdn-data provides shorthand effects with logical-side safety. This remains conflict protection, not a new property allowlist.
Alternative `style.css` accepts full local stylesheet text instead of declarations, with no `part`: responsive `@media`/`@supports`/`@container`, keyframes/reduced motion, fonts, tokens, `@property` and layers. Default all selectors stay in the verified `pp-*` component subtree; arbitrary stable descendant/state/pseudo-element parts are allowed. Raw `global: true` intentionally enables global rules in the existing placement scope with expanded review of **all matching elements**. Source-free descriptors are allowed only for global raw stylesheets or user-requested Studio handoffs; global needs no fake class/source. Namespace new keyframe/font/property/layer names with `pp-`/`--pp-`, or review shared naming under explicit global scope.

Exact external HTTPS URL references require `externalResources` and hashed warnings; relative/root-relative/fragment Web File URLs need no declaration. Reject protocol-relative, JavaScript/file schemes, unreviewed external tracking/font/image URLs and data payloads (use Web Files). Review CSP, availability, licensing/privacy. Imports require raw global scope, declared external URLs and valid beginning-of-stylesheet placement; a new custom file may avoid late imports. Never fetch imports automatically or make browser/network access a prerequisite.

Keep deep inline/source contracts conditional: optional `location` is `stylesheet` (default) or `inline`; inline requires exact static `inlineTarget`, with no nonempty `part` or raw/global/stylesheet/handoff placement fields. Inline-only components may omit `className`; scoped stylesheets need verified hooks/guarded additions. Supplied inline classes identify actual tags. Shared-template inline edits require site scope, potentially every page; Page Copy requires the selected locale. Original exact tags/contexts compose as reconstructed `kind: "markup"` writes; class-only stays `kind: "class"`. Safely parse/encode quoted fonts, HTML entities, CSS comments/escapes, preserving unrelated source/attributes. Ambiguous/malformed edits and conflicting important shorthands still block with local remediation.

Only inline declarations may use `null` to remove that exact existing property; removal-only groups are valid. Null is a request directive, not a CSS value, and stylesheet/Studio groups reject it. Combine removal and scoped CSS in the same approved plan to enable responsive/state rules without ineffective overrides. Preserve other inline properties/priority and native attributes/markers. Shorthand removal removes the entire declaration: retain needed longhands in planned styles and review the actual diff. This is general authoring, not a gradient-specific path.

Real rendered source tags (including input, textarea, SVG and outer local iframe/embedded elements) are eligible, not a fixed wrapper list; only class/style attributes change, never embedded contents. Static tags and CSS values may span lines; preserve exact whitespace/newline matching, size/unique-context guards and the no-Liquid target rule. The source tokenizer skips iframe/noembed/noframes/xmp contents like textarea/script/style contents; tag-shaped text there is not a local DOM target. Runtime-discovery exclusions are unchanged. The entities codec decodes/encodes the style attribute; only that attribute can normalize entity spelling. Preserve the rest of the tag/document exactly, apart from approved class additions.
Reserve `owner: "studio"` for explicitly requested instructions-only work, requiring `handoffReason: "user-requested"` plus `studioAction`; native support alone is not a reason. Retain plan schema 2: old zero-write Studio requests missing the explicit reason need regeneration/new approval, never hand-edited plans or inherited consent. Microsoft's Studio recommendation is not a VS Code prohibition. Keep unlisted/unknown/conditional support warnings in review, approval and final report, without promising local values populate native controls. Theme controls remain separate from the map. Batch only requested lookups and do not load the complete catalog for every small change. Retain source-level readability checks and supplied-color math; rendering and Studio round trips remain pending.

### Maintaining the bundled CSS parser

The pinned parser lives in `scripts/vendor/css-tools`, including `package.json`, `package-lock.json`, `css-tools.cjs` and bundled licenses, including the mdn-data license. Users need **no npm installs** in their plugin or site. Maintainers reproduce the bundle from the repository root with:

```powershell
Set-Location plugins\power-pages\scripts\vendor\css-tools
npm ci --ignore-scripts
npm run build
```

Keep the manifests, lockfile, generated bundle and licenses together when updating the parser. These are maintainer build dependencies, not runtime installation instructions. Do not replace documented general CSS support with bespoke gradient/property/selector grammars.

---

## ALM Checklist for New Skills

Any skill that creates, modifies, or depends on Dataverse records that belong in a Power Pages site's solution (site components, env var definitions, web roles, site settings, server logic, cloud flow bindings, bot consumers, custom tables, etc.) **must** comply with the ALM-aware-by-default principle documented in `AGENTS.md`. Concretely, before merging:

- [ ] **SKILL.md Phase 1** reads `.solution-manifest.json` if present; stores `solution.uniqueName` for downstream phases
- [ ] Any `scripts/*.js` that writes to Dataverse accepts a `--solutionUniqueName` argument and imports `./lib/resolve-target-solution` to honor the [strict resolution order](AGENTS.md#alm-aware-by-default)
- [ ] Records created by the skill are added to the resolved solution via `AddSolutionComponent` (never silently left in `Default`)
- [ ] Any new `powerpagecomponenttype` values used in the skill are reflected in `scripts/lib/discover-site-components.js` (`PPC_TYPE_LABELS`). Discovery must never skip a type
- [ ] Skills that create Dataverse artifacts but might not know the target solution (e.g. utility skills, skills that can run before `setup-solution`) end by prompting the user to run `/power-pages:setup-solution` in sync mode
- [ ] `node scripts/lint-skills-alm.js` reports **zero findings** on the changed skill + scripts
- [ ] A `node:test` suite covers the new component-creation script, including an assertion that `--solutionUniqueName` flows through to `AddSolutionComponent`

### Solution Resolution Order

When a skill or script needs "which solution?", resolve in this order and stop at the first match:

1. **Explicit `--solutionUniqueName` CLI argument / skill argument** — always wins
2. **`.solution-manifest.json` in project root** — the default path
3. **Neither present** — interactive skill: prompt via `AskUserQuestion` with a list of candidate user solutions (publisher-prefix matches) + option to run `/power-pages:setup-solution` first. Non-interactive script: exit with `NoSolutionConfiguredError` and a clear hint. **Never silently fall back to `Default`.**

### Lint Command

Run locally before submitting a PR:

```powershell
node plugins/power-pages/scripts/lint-skills-alm.js
```

Exits 0 with `alm-lint: 0 findings` when clean; exits 1 and prints file/rule/message for each violation otherwise. Waive individual findings with an `alm-lint-ignore: <rule-name> — <short reason>` comment at the relevant line (prefer `<!-- … -->` in Markdown, `// …` in JS).

### Related Helpers

- `scripts/lib/resolve-target-solution.js` — implements the 3-step resolution order; use from every component-creation script
- `scripts/lib/discover-site-components.js` — one-call site inventory (powerpagecomponents, flows, env vars, custom tables) + diff against an existing solution; use in Inventory / pre-export phases

> **Acceptance criterion:** No component-creation skill may ship that leaves a Dataverse record orphaned in `Default`. The lint, the resolver, and the discovery module together make this the path of least resistance — please use them.

---

## Hook design for skill validation

Hook validators run after a skill executes (or, badly, every time the assistant pauses) to surface incomplete state to the agent. **Get this wrong and you cost users real money.** A real incident on this plugin (BYOC supplier portal, 2026-05-04) had three Stop hooks LLM-evaluating skill-completion every turn, all returning `{ ok: false }` with multi-paragraph reasons because the user had explicitly deferred ALM. The agent kept acknowledging, the hooks kept refiring on each acknowledgement, and the transcript grew quadratically until the cost was visible.

### Anti-patterns — do not use these

| Pattern | Why it's wrong |
|---|---|
| **`type: prompt` Stop hooks for skill-completion** | Stop fires on every assistant pause, including user-input waits. LLM-evaluation can't reliably tell "this skill wasn't supposed to run" from "this skill failed", so it returns `ok: false` whenever artifacts are missing — forcing continuation. Combine with multiple skills' hooks all firing per turn, and you have a runaway loop. The plugin removed all of these in commit `e670581`. **Do not re-introduce.** |
| **`process.exit(2)` (block) for soft "did this complete?" checks** | Blocking exit forces continuation. For "did the skill complete cleanly?" you almost never want forced continuation — you want a one-time advisory the agent acknowledges and moves on. Reserve `block()` for **hard correctness gates** only: malformed marker files, `docs/alm/last-deploy.json.status === "Failed"`, lint failures, secrets in diffs. |
| **Re-deriving completion from ephemeral artifacts** | If a validator checks `docs/foo.html` exists and the user legitimately deletes that file (cleanup, project move), the hook fails forever. Validation should reflect *intent*, not *artifact presence*. Use marker files the skill writes deliberately. |
| **Stop hooks that duplicate PostToolUse hooks** | If a skill is already validated by `hooks/hooks.json` PostToolUse on the `Skill` tool (which fires once per skill invocation), a Stop hook running the same validator just adds noise — fires too often. Pick one. **Prefer PostToolUse.** |

### Recommended patterns

#### 1. Deterministic command validators with marker-file gates

Each skill writes a marker file at completion (`docs/alm/last-pipeline.json`, `docs/alm/last-deploy.json`, `docs/alm-plan.html`, `.solution-manifest.json`, etc.). The validator:

```js
const { runValidation, findProjectRoot, approve, block, readDeferralMarker } = require('../../../scripts/lib/validation-helpers');

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd) || cwd;

  // 1. Honor explicit deferral first — silent-approve regardless of state.
  if (readDeferralMarker(projectRoot)) return approve();

  // 2. No marker -> not a foo session -> silent-approve.
  const markerPath = path.join(projectRoot, '.last-foo.json');
  if (!fs.existsSync(markerPath)) return approve();

  // 3. Marker exists -> validate its shape. Block ONLY on hard failures.
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); }
  catch { return block('.last-foo.json could not be parsed as JSON.'); }

  if (marker.status === 'Failed') {
    return block('Last foo run failed (id: ' + marker.runId + '). Investigate before retrying.');
  }
  if (!marker.requiredField) {
    return block('.last-foo.json is missing required field: requiredField');
  }

  return approve();
});
```

This pattern doesn't loop: silent-approve produces no output, no forced continuation. Block fires only when the marker exists AND is genuinely broken.

#### 2. Honor deferral markers before any other check

If a user explicitly defers a skill family (e.g. ALM for a project handled by infra team's pipeline), they drop a marker file (`.alm-deferred` for ALM). All related validators short-circuit on this marker as their FIRST check.

`scripts/lib/validation-helpers.js` exports `readDeferralMarker(projectRoot)` — every ALM validator on this plugin calls it first. The marker is recognized in three formats: empty (touch file), plain text (one-line reason), or JSON (`{ deferredAt, deferredBy, reason, scope }`).

User-facing usage:
```bash
# At the project root:
echo '{"reason":"ni-dev — ALM handled by infra"}' > .alm-deferred
```

#### 3. Prefer PostToolUse over Stop for skill-completion

PostToolUse on the `Skill` tool fires **once per skill invocation**. Stop fires on **every assistant pause** (including user-input waits — every "Continue?" prompt fires it).

This plugin uses PostToolUse via `hooks/hooks.json` → `run-skill-posttool-validation.js` → per-skill validator. Skill frontmatter must NOT declare its own `hooks: Stop:` block — those duplicate the centralized PostToolUse hook and fire too often. `scripts/lib/powerpages-hook-utils.js` automatically tracks every `skills/*/SKILL.md` folder and discovers an optional `skills/<skill>/scripts/validate*.js` validator, so new skills do not need manual hook registration.

#### 4. Skills write explicit status, not just artifact presence

Marker files include a `status` field:

```json
{
  "status": "Completed",   // or "Draft" | "Approved" | "In Execution" | "Deferred" | "Failed"
  ...
}
```

Validators check `status` when present rather than re-deriving completion from secondary artifacts. A `"Deferred"` status in the marker file is also a valid signal — silent-approve regardless of other field presence.

### When you genuinely need a hard gate

Some checks DO warrant blocking — they're not "did the skill complete?" checks but "did something go wrong that requires the agent to retry?" Examples that justify `block()`:

- Marker file exists but is malformed JSON.
- Marker file's `status === "Failed"` and the agent should investigate before continuing.
- Required field is missing from a present marker (e.g. `docs/alm/last-pipeline.json` without `pipelineId`).
- Lint failure on a file the skill just wrote.
- Secrets detected in a diff the skill is about to commit.

These all share a property: the artifact is present, not absent. Absent artifacts always silent-approve.

### Acceptance criterion

A new skill's validator must:

1. Silent-approve when its marker file is absent.
2. Silent-approve when `.alm-deferred` (or skill-specific deferral marker) is present.
3. Block ONLY when the marker is present AND in a state that requires retry.
4. Not register a `type: prompt` Stop hook under any circumstances.
5. Use `runValidation()` from `validation-helpers.js` so it inherits the standard try/catch and silent-approve-on-error fallback.

If your validator can return `block()` when no skill-related work happened in the session, fix it before merging. The cost of getting this wrong is real-money runaway loops, not just noisy errors.

---
