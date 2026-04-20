---
name: integrate-backend
description: >-
  Analyzes the user's business problem and recommends the right backend integration approach
  — Web API, Server Logic, Cloud Flows, or a combination — for a Power Pages site, then routes
  to the appropriate specialized skill. Use when the user wants to add backend integration,
  connect to data, or needs help deciding which backend approach to use.
user-invocable: true
argument-hint: describe what your backend needs to do
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Skill, Task, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Backend Integration

Analyze the user's business problem and recommend the right backend integration approach — **Web API**, **Server Logic**, **Cloud Flows**, or a combination — then route to the appropriate skill(s) to implement the solution.

## Core Principles

- **Understand the problem first**: Never jump to a technology choice. Analyze the user's intent, data flow, security needs, and performance requirements before recommending.
- **Recommend the simplest approach that works**: Web API for straightforward Dataverse CRUD, Server Logic when server-side processing is needed, Cloud Flows for async background work. Don't over-engineer.
- **Secure actions belong on the server**: When a write depends on a business rule that must be tamper-proof (state transitions, approval workflows, computed values), the server logic must validate AND execute the write — not just validate and leave the write to a client-side Web API call. See the **Secure Action Principle** in the decision framework.
- **Combinations are normal**: Many real scenarios need more than one approach. Recommend combinations when justified, but explain why each piece is needed.
- **Route, don't implement**: This skill recommends and invokes the right skill(s). It does not create backend files itself.

**Initial request:** $ARGUMENTS

---

## Workflow

1. **Verify Site Exists** — Locate the Power Pages project and check prerequisites
2. **Understand the Business Problem** — Analyze what the user needs and why
3. **Recommend Integration Approach** — Present the recommendation with reasoning
4. **Route to Skill(s)** — Invoke the appropriate backend skill(s) to implement

---

## Phase 1: Verify Site Exists

**Goal**: Locate the Power Pages project root and confirm prerequisites

**Actions**:

1. Create todo list with all 4 phases (see [Progress Tracking](#progress-tracking) table)

### 1.1 Locate Project

Look for `powerpages.config.json` in the current directory or immediate subdirectories.

**If not found**: Tell the user to create a site first with `/create-site`.

### 1.2 Explore Current State

Use the **Explore agent** to quickly scan the site for existing backend integrations:

> "Analyze this Power Pages code site for existing backend integrations:
> 1. Check `.powerpages-site/server-logic/` — list any existing server logic endpoints
> 2. Check `.powerpages-site/cloud-flow-consumer/` — list any registered cloud flows
> 3. Search frontend code (`src/**/*.{ts,tsx,js,jsx,vue,astro}`) for calls to `/_api/` (Web API) and `/_api/serverlogics/` (Server Logic) and `/_api/cloudflow/` (Cloud Flows)
> 4. Check for existing service layers or API utilities in `src/services/`, `src/shared/`, or similar
> 5. List available web roles from `.powerpages-site/web-roles/*.webrole.yml`
> Report what backend integrations already exist so we can build on them."

### 1.3 Discover Dataverse Custom Actions

Check whether the user's Dataverse environment has existing custom actions that could be leveraged in the integration:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/list-custom-actions.js" "<ENV_URL>"
```

The script returns Custom APIs (modern) and Custom Process Actions (legacy) with their names, descriptions, binding types, and parameters. If custom actions are found, note them — they will be factored into the recommendation in Phase 3.

**Output**: Project root confirmed, existing backend integrations identified, Dataverse custom actions discovered

---

## Phase 2: Understand the Business Problem

**Goal**: Analyze the user's request to understand the underlying business problem, not just the technical ask

**Actions**:

### 2.1 Analyze the Request

From the user's request and the existing site state, determine:

- **What is the user trying to accomplish?** (business outcome, not technology)
- **What data is involved?** (Dataverse tables, external systems, user input)
- **Who triggers the operation?** (user action, form submit, page load, scheduled)
- **Does the user need an immediate response?** (real-time UI update vs. background processing)
- **Are external services involved?** (payment gateways, email, Graph, SharePoint, third-party APIs)
- **Are credentials or secrets involved?** (API keys, client secrets, tokens)
- **Must logic be hidden from the browser?** (pricing rules, validation algorithms, business rules)
- **Is this a simple data operation or complex business logic?** (CRUD vs. multi-step processing)
- **Does any write depend on a business rule that must be tamper-proof?** (state transitions, approval conditions, computed values) — if yes, the server logic must validate AND execute the write, not just validate
- **Can existing Dataverse custom actions handle part of the requirement?** If custom actions were discovered in Phase 1.3, check whether any align with the user's needs — server logic can wrap existing custom actions via `InvokeCustomApi` instead of building equivalent logic from scratch

### 2.2 Clarify if Ambiguous

If the request could map to multiple approaches and the right choice isn't clear, use `AskUserQuestion` to clarify:

| Question | When to ask |
|----------|-------------|
| Does the user need to see the result immediately, or can it happen in the background? | When the request involves processing that could be sync or async |
| Are external APIs or services involved (e.g., Stripe, SendGrid, SharePoint)? | When the request mentions "integration" without specifics |
| Does this involve sensitive credentials that shouldn't be in the browser? | When external service integration is mentioned |
| Is this a one-time action or a multi-step workflow? | When the request could be a simple call or an orchestration |

**Output**: Clear understanding of the business problem and technical requirements

---

## Phase 3: Recommend Integration Approach

**Goal**: Present a recommendation with clear reasoning

**Actions**:

### 3.1 Apply the Decision Framework

> Reference: `${CLAUDE_PLUGIN_ROOT}/skills/integrate-backend/references/decision-framework.md`

Use the decision matrix, intent mapping, and **Secure Action Principle** from the reference to determine the right approach. Consider:

1. **Can Web API alone handle this?** If it's straightforward Dataverse CRUD with no external calls, no secrets, no server-side logic, and **no business rules governing the write** — recommend Web API. It's the simplest option.

2. **Does it need Server Logic?** If any of these apply, Server Logic is needed:
   - External API calls (HttpClient)
   - Credentials/secrets must stay on the server
   - Business logic must be hidden from the browser
   - Multiple Dataverse queries should be batched into one endpoint
   - Server-side validation that can't be bypassed
   - Wrapping a Dataverse Custom API/Action for portal consumption — if custom actions were found in Phase 1.3, check whether any match the requirement before recommending building from scratch
   - **The write depends on a business rule that must be tamper-proof** (state transitions, approval conditions, computed values) — server logic must validate AND execute the write

3. **Does it need Cloud Flows?** If any of these apply, Cloud Flows are the right fit:
   - The operation is async — the user doesn't need an immediate result
   - Background processing: sending emails, notifications, processing orders
   - Multi-step workflows across systems with Power Automate connectors
   - Long-running processes that exceed the 120-second server logic timeout
   - Non-developers should be able to modify the workflow

4. **Does it need a combination?** Common combinations:
   - Web API + Cloud Flow: UI reads/writes non-sensitive Dataverse fields, some actions trigger background flows
   - Server Logic + Cloud Flow: Real-time endpoint validates and executes the action, async flow does follow-up (e.g., server logic transitions status, Cloud Flow sends notification)
   - Web API + Server Logic: Web API for safe direct reads/writes, server logic for operations that need business rule enforcement (server logic validates AND writes for those operations)

### 3.1.1 Security Review — Apply the Secure Action Principle

Before finalizing the plan, review every item assigned to Web API and ask: **"If a user skipped any preceding server logic validation and called this Web API endpoint directly, could they violate a business rule?"**

If the answer is **yes**, that write does not belong in a Web API item. Move the write into the server logic item that validates it. The server logic should validate AND execute the write using `Server.Connector.Dataverse`.

Common patterns that **must** use validate-and-execute server logic (not Web API):

| Pattern | Why it must be server-side |
|---------|---------------------------|
| Status/state transitions (Draft → Submitted → Approved) | Client could jump to any status by sending a direct PATCH |
| Conditional writes (only allowed before a deadline, only for certain roles) | Client could write after deadline or from wrong role context |
| Computed field writes (server calculates a score, price, or derived value) | Client could submit any value if it writes the field directly |
| Multi-table atomic operations (award bid + reject others + update event) | Partial execution from client could leave data inconsistent |
| Writes that depend on the current state of other records | Client's stale view of data could lead to invalid writes |

**Correct plan structure for state transitions:**

```
Phase 1: Server Logic — "transition-order" endpoint
  - POST: accepts { entityId, targetStatus }
  - Reads current record, validates transition is allowed, writes new status
  - Returns { success, previousStatus, newStatus }

Phase 2: Web API — Order table CRUD
  - Read: list/filter orders (safe for Web API)
  - Create: new orders in Draft status (safe — initial state, no rule to enforce)
  - Update: description, notes, dates (safe — no business rules on these fields)
  - NOTE: Status changes are NOT here — they go through the server logic endpoint
```

**Incorrect plan structure (anti-pattern):**

```
❌ Phase 1: Server Logic — "validate-transition" endpoint
  - POST: accepts { entityId, targetStatus }
  - Reads current record, validates transition
  - Returns { valid: true/false }   ← only validates, doesn't write

❌ Phase 2: Web API — Order table CRUD
  - Update: includes status field  ← client writes status after "validation"
  - PROBLEM: client can skip Phase 1 and write any status directly
```

### 3.2 Render the HTML Plan

Build the plan data and render an HTML plan before asking for approval. The plan visualizes:

- **Key Concepts** — Educational overview of Web API, Server Logic, and Cloud Flows (hardcoded in template)
- **Overview** — Stats per approach, approach chips, design rationale
- **Data Flow** — Visual flow diagrams showing how data moves for each user action, with steps color-coded by approach
- **Implementation Order** — Phase-grouped items with dependencies, complexity badges, and implementation commands
- **Integration Items** — Each item with its approach, reasoning, and implementation details

Prepare a JSON object with these keys:

| Key | Description |
|-----|-------------|
| `SITE_NAME` | Site name from `powerpages.config.json` |
| `PLAN_TITLE` | Short title (e.g., "Backend Integration Plan") |
| `SUMMARY` | 1-3 sentence summary of the integration strategy |
| `ITEMS_DATA` | Array of integration items (see format below) |
| `DATA_FLOWS_DATA` | Array of data flow diagrams (see format below) |
| `RATIONALE_DATA` | Array of design rationale entries (`icon`, `title`, `desc`) |

**ITEMS_DATA format:**
```json
{
  "name": "Create PayPal Order",
  "approach": "webapi|serverlogic|cloudflow",
  "description": "What this item does",
  "reasoning": "Why this approach was chosen",
  "phase": 1,
  "status": "new|existing|extends",
  "complexity": "low|medium|high",
  "depends": "Name of item this depends on (if any)",
  "details": [
    { "label": "Endpoint", "value": "/_api/serverlogics/create-paypal-order" },
    { "label": "Secrets", "value": "PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET" }
  ],
  "docs": [
    { "label": "Server Logic Overview", "url": "https://learn.microsoft.com/..." }
  ]
}
```

**Phase assignment rules** — assign a `phase` number to each item based on dependencies:

1. Items with no dependencies go in the earliest phase appropriate for their approach
2. Items that depend on other items go in a later phase than their dependency
3. Items in the **same phase have no dependencies on each other** and can be built in parallel
4. Recommended default ordering: Server Logic foundations first (validate-and-execute endpoints for state transitions, batch queries), then Web API CRUD for non-sensitive fields (reads, creates with safe defaults, updates to fields with no business rules), then advanced Server Logic (multi-table transactions), then Cloud Flows (async follow-ups)
5. **Security constraint**: A Web API item must never write a field whose value is governed by a business rule enforced in a server logic item. If a field needs validation, the server logic item should write it directly — the Web API item should exclude that field from its scope

**DATA_FLOWS_DATA format:**
```json
{
  "trigger": "User registers and pays",
  "description": "User fills the form, pays via PayPal, receives confirmation",
  "steps": [
    { "approach": "serverlogic", "name": "Validate Seats", "detail": "Check availability" },
    { "approach": "serverlogic", "name": "Create Order", "detail": "Server calls PayPal" },
    { "approach": "cloudflow", "name": "Send Email", "detail": "Async confirmation" }
  ]
}
```

**Important**: In data flow diagrams, when a server logic step validates a business rule, the next step should NOT be a Web API write for the same field. The server logic step should validate AND execute. For example:

```json
// ✅ Correct — server logic validates and writes status
{ "approach": "serverlogic", "name": "Submit Order", "detail": "Validates Draft→Submitted, writes new status" }

// ❌ Incorrect — split across server logic validation and Web API write
{ "approach": "serverlogic", "name": "Validate Transition", "detail": "Checks Draft→Submitted" },
{ "approach": "webapi", "name": "Update Status", "detail": "PATCH status to Submitted" }
```
```

Write the plan to `<PROJECT_ROOT>/docs/backend-plan.html` (create `docs/` if needed). Use the render script:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-backend-plan.js" --output "<OUTPUT_PATH>" --data "<DATA_JSON_PATH>"
```

The render script refuses to overwrite existing files. If the default path exists, choose a new descriptive filename (e.g., `backend-plan-payments.html`).

After rendering, open the HTML plan in the user's default browser:

```bash
open "<OUTPUT_PATH>"  # macOS
# start "<OUTPUT_PATH>"  # Windows
# xdg-open "<OUTPUT_PATH>"  # Linux
```

### 3.3 Present Plan Summary

Do **not** restate the full plan in the CLI. The HTML file is the single detailed plan artifact.

In the CLI, give only a brief summary:
- Total items and how many per approach
- Whether the plan uses one approach or a combination
- The actual output path
- A note that the browser-opened HTML contains the full details including data flow diagrams

### 3.4 Confirm with User

Use `AskUserQuestion`:

| Question | Options |
|----------|---------|
| Here's the integration plan. The HTML plan is open in your browser with data flow diagrams and per-item reasoning. Does this approach look right? | Yes, proceed (Recommended), Change approach, Cancel |

**If "Change approach"**: Ask what they'd prefer and why, update the plan, and present again.

**If "Cancel"**: Stop the workflow.

**Output**: User-approved integration approach

---

## Phase 4: Route to Skill(s)

**Goal**: Invoke the appropriate skill(s) to implement the approved approach, respecting phase ordering and building in parallel within each phase

**Actions**:

### 4.1 Build the Phase Execution Plan

Group the approved items by their `phase` number from the plan. Each phase is a batch of independent items — items within a phase have no dependencies on each other and can be built in parallel.

| Approach | Skill to invoke | What to pass |
|----------|----------------|--------------|
| Web API | `/integrate-webapi` | The user's request + tables for this phase + existing patterns |
| Server Logic | `/add-server-logic` | The user's request + endpoints for this phase + SDK features needed + secrets identified + any matching Dataverse custom actions from Phase 1.3 |
| Cloud Flow | `/add-cloud-flow` | The user's request + async operations for this phase |

### 4.2 Execute Phase by Phase

Process phases in order (Phase 1, then Phase 2, etc.). **Complete all items in a phase before moving to the next** — later phases depend on earlier phases.

**Within each phase**, maximize parallelism:

- **Single approach in the phase**: Invoke the skill once with all items for that phase. Tell the skill: *"These N items are independent — implement them in parallel where possible."*
- **Multiple approaches in the same phase**: Invoke each skill for its items. Since items in the same phase have no cross-dependencies, the order of skill invocation within a phase does not matter. When invoking the second skill, pass context from the first so it can follow the same frontend patterns (e.g., naming conventions, file organization).

**Example** — a plan with 4 phases:

| Phase | Items | Skill(s) | Parallelism |
|-------|-------|----------|-------------|
| 1 | Validate Transition (serverlogic), Dashboard Metrics (serverlogic) | `/add-server-logic` | Both items passed together — skill builds them in parallel |
| 2 | Supplier Updates (webapi), Bid CRUD (webapi), PR Creation (webapi) | `/integrate-webapi` | All 3 items passed together — skill builds them in parallel |
| 3 | Award Bid (serverlogic) | `/add-server-logic` | Single item — sequential |
| 4 | Approval Notification (cloudflow), Expiry Alerts (cloudflow) | `/add-cloud-flow` | Both items passed together — skill builds them in parallel |

When invoking each skill, include:
1. **Which items to implement** — list the specific item names from the plan for this phase
2. **Parallelism guidance** — *"These items are in the same phase and have no dependencies on each other. Implement them in parallel where possible."*
3. **Context from previous phases** — what was created so far (files, patterns, services) so the skill can build on it

### 4.3 Summary

After all phases complete, present a brief summary of everything that was created:

| Phase | Approach | What was created |
|-------|----------|-----------------|
| 1 | Server Logic | [endpoints created, SDK features used] |
| 2 | Web API | [files created, tables integrated] |
| 3 | Server Logic | [endpoints created] |
| 4 | Cloud Flow | [flows registered, triggers wired] |

Remind the user to deploy with `/deploy-site` if they haven't already.

### 4.4 Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "IntegrateBackend"`.

**Output**: All recommended backend integrations implemented

---

## Important Notes

### When NOT to Use This Skill

If the user's request clearly and unambiguously maps to a single approach, **skip this skill and go directly to the implementation skill**:

- "Create a server logic endpoint for..." → `/add-server-logic`
- "Integrate Web API for the contacts table" → `/integrate-webapi`
- "Add a cloud flow for sending emails" → `/add-cloud-flow`

This skill is for **ambiguous requests** where the user describes a business problem and needs help choosing the right approach.

### Examples: What Routing Looks Like

**Example 1: Simple Dataverse CRUD → Web API**
```
User: I need to show a list of products on the homepage and let users
      filter by category.

Recommendation: Web API
Reason: This is straightforward Dataverse read operations with filtering.
        No external APIs, no secrets, no server-side logic needed.
Skill: /integrate-webapi
```

**Example 2: External API with credentials → Server Logic**
```
User: Add payment processing through Stripe. The API key must stay
      on the server.

Recommendation: Server Logic
Reason: Calls an external API (Stripe) with credentials that must be
        protected. Server logic hides the code and credentials from
        the browser.
Skill: /add-server-logic
```

**Example 3: Background email → Cloud Flow**
```
User: When a user submits the contact form, send them a confirmation
      email and notify the support team on Teams.

Recommendation: Cloud Flow
Reason: Email and Teams notifications are async — the user doesn't
        need to wait for them. Cloud Flows have built-in connectors
        for Outlook and Teams.
Skill: /add-cloud-flow
```

**Example 4: Server-side validation → Server Logic (validate-and-execute)**
```
User: Add validation that rejects orders when quantity exceeds
      inventory. Check the actual Dataverse data, not just the form.

Recommendation: Server Logic (validate-and-execute)
Reason: Server-side validation that can't be bypassed from the browser.
        The server logic checks inventory AND creates/updates the order
        in a single call — the client doesn't write the order via Web API
        because quantity validation would be bypassable.
Skill: /add-server-logic
```

**Example 5: Dashboard performance → Server Logic**
```
User: The dashboard makes 3 separate API calls to load contacts,
      orders, and products. It's slow.

Recommendation: Server Logic
Reason: Batching multiple Dataverse queries into a single server
        endpoint reduces round-trips and improves load time.
Skill: /add-server-logic
```

**Example 6: CRUD + background processing → Web API + Cloud Flow**
```
User: Let users submit support tickets from the portal. After
      submission, assign it to the right team and send an email.

Recommendation: Web API + Cloud Flow
Reason: The ticket creation is a Dataverse write (Web API). The
        assignment and email happen in the background after the
        user submits (Cloud Flow).
Phases: Phase 1 → /integrate-webapi (ticket CRUD)
        Phase 2 → /add-cloud-flow (assignment + email, depends on ticket creation)
```

**Example 7: Validate + process + notify → Server Logic + Cloud Flow**
```
User: When a user places an order, validate inventory, process the
      payment through Stripe, and send a confirmation email.

Recommendation: Server Logic + Cloud Flow
Reason: Inventory validation and Stripe payment need real-time
        server-side processing with credentials (Server Logic).
        The confirmation email is async (Cloud Flow).
Phases: Phase 1 → /add-server-logic (validate inventory + process payment — parallel)
        Phase 2 → /add-cloud-flow (confirmation email, depends on payment)
```

**Example 8: State transitions + CRUD → Server Logic (validate-and-execute) + Web API**
```
User: Build a procurement workflow with status transitions
      (Draft → Submitted → Approved) and let users edit request details.

Recommendation: Server Logic + Web API
Reason: Status transitions must be tamper-proof — server logic validates
        the transition AND writes the new status to Dataverse in one call
        (the Secure Action Principle). Editing non-sensitive fields like
        description or notes is safe via Web API since no business rule
        governs those writes.
Phases: Phase 1 → /add-server-logic (transition-request endpoint that
          validates AND writes status changes)
        Phase 2 → /integrate-webapi (read/list requests, edit description
          and notes — but NOT status, which goes through server logic)

NOTE: The Web API item must NOT include the status field in its Update
      operations. Status writes go exclusively through the server logic
      endpoint.
```

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Verify site exists | Verifying site prerequisites | Locate project root, scan for existing backend integrations |
| Understand business problem | Analyzing requirements | Determine what the user needs, clarify ambiguities |
| Recommend integration approach | Evaluating approaches | Apply decision framework, present recommendation |
| Route to implementation skill(s) | Implementing backend integration | Invoke the approved skill(s) and summarize results |

Mark each task `in_progress` when starting and `completed` when done via `TaskUpdate`.

---

**Begin with Phase 1: Verify Site Exists**
