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

Every skill must implement **task-based progress tracking** using `TaskCreate` and `TaskUpdate`. Tasks are created upfront at Phase 1, one per phase, and marked `in_progress` / `completed` as the skill progresses.

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

> **Acceptance criterion:** Every skill must create all phase tasks upfront at Phase 1 start. Each task must have `subject`, `activeForm`, and `description`. Tasks must be marked `in_progress` when starting and `completed` when done.

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
| `/create-webroles` | Stop hook | Web role YAML validates (schema, naming conventions, booleans) |

**Hook-based validation** — Skills tracked in `hooks/hooks.json` get automatic validation when they complete. The `PostToolUse` hook on `Skill` dispatches to per-skill validator scripts via `run-skill-posttool-validation.js`. Validators use `approve()` / `block(reason)` from `scripts/lib/validation-helpers.js`.

> **Acceptance criterion:** No skill that creates, modifies, or deletes files may ship without a dedicated verification phase. Verification must use a different code path than creation (e.g., run validators, glob for files, build the project — don't just trust the write succeeded).

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
| `powerpages-hook-utils.js` | Maps skill names to validator scripts for the hook dispatcher |
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
| `clear-site-cache.js` | Clears site cache via Power Platform admin API |

### Usage Pattern

Skills invoke scripts via `node` with CLI arguments:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/create-table-permission.js" \
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

Between checkpoints, skills work **autonomously** — no mid-analysis questions.

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

> **Acceptance criterion:** Every skill must implement the three-point approval pattern. No approval-gated action may proceed without explicit user confirmation via `AskUserQuestion`. Skills must work autonomously between checkpoints — no mid-analysis questions.

---
