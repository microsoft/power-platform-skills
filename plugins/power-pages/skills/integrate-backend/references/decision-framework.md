# Backend Integration Decision Framework

Use this framework to recommend the right backend integration approach for a Power Pages code site. A single user request may map to one approach or a combination.
## The Four Approaches

### Web API (`/integrate-webapi`)

**What it is:** A client-side, browser-based OData API that lets frontend code perform CRUD operations directly against Dataverse tables via `/_api/<entity-set>` endpoints.

**How it works:** JavaScript/TypeScript in the browser makes HTTP calls to Dataverse. Authentication is cookie-based (user session). Table permissions and web roles control access. No code runs on the server — the browser does all the work.

**Best for:**
- Displaying Dataverse records in the UI (lists, tables, dashboards, detail views)
- Form submissions that create or update Dataverse records
- Filtering, sorting, searching records with OData queries
- Inline editing of records
- File/image upload to Dataverse File columns
- Real-time data binding where the user sees results immediately
- Aggregation queries (`$apply`) for charts and summaries

**Not suitable when:**
- The logic requires calling external APIs (Stripe, SendGrid, Graph, etc.)
- API keys, client secrets, or other credentials are involved
- Business logic must be hidden from the browser (pricing rules, validation algorithms)
- The operation needs to batch multiple table queries into one call for performance
- The write depends on a business rule that must be tamper-proof (e.g., status transitions, approval workflows) — use Server Logic to validate AND execute the write in a single call instead (see Secure Action Principle)
- The operation should happen in the background after the user moves on

**Key characteristics:**
- Code runs in the browser (visible in DevTools)
- No external API access
- No credential/secret handling
- Real-time, synchronous responses
- Requires table permissions for every Dataverse table accessed
- CSRF token required for mutations (POST, PATCH, DELETE)

---

### AI Web API (`/add-ai-webapi`)

**What it is:** A specialization of Web API for AI-augmented reads. Two endpoints: **Search Summary** (`/_api/search/v1.0/summary`) produces a grounded AI answer over the site's search index, and **Data Summarization** (`/_api/summarization/data/v1.0/<entitySet>(<id>)?$select=...`) produces an AI summary of one record or a collection. Microsoft also documents a ready-made Data Summarization configuration for the standard `incident` table (the support-case Copilot summary recipe) — that's an example of Data Summarization, not a separate API.

**How it works:** Same browser-to-portal auth model as Web API — cookie session + CSRF token from `/_layout/tokenhtml`. Data Summarization reads via the portal's `_api` layer, so it respects the same table permissions, column permissions, and Web API field settings as regular Web API. The server adds a generative-AI pass that returns a text summary instead of raw records. Read-only by definition — neither endpoint mutates Dataverse.

**Best for:**
- AI summary of a record on its detail page (e.g., "summarize this case including its portal comments")
- AI summary of a list of records (e.g., "summarize open cases on the dashboard", "trends in this week's orders")
- Related-record discovery on a detail page (e.g., "suggest KB articles relevant to this case", "similar products")
- AI-grounded site search with citations (replaces or augments keyword-only search UIs)

**Not suitable when:**
- The output needs to be deterministic or exact (AI output is probabilistic; use Web API for exact data)
- The operation writes data (these endpoints are read-only — use Web API or Server Logic)
- The data isn't in Dataverse (Search Summary indexes site content; Data Summarization requires a Dataverse entity set)
- The tenant doesn't have generative AI features enabled (these APIs are preview; until an admin enables them, **Data Summarization** returns HTTP 400 with `error.code = 90041001`, while **Search Summary** returns HTTP 200 with an embedded `{ Code, Message }` envelope instead)
- The site uses the Microsoft-shipped search control and just wants AI-summarised search results on it — that's a workspace toggle (`Search/Summary/Title` content snippet), not a code integration

**Key characteristics:**
- Layered on Web API — Data Summarization requires the same `Webapi/<table>/enabled`, `Webapi/<table>/fields`, and table permissions as regular Web API reads. Search Summary has no per-table prereqs.
- Code runs in the browser; the AI pass happens server-side
- Read-only — no validate-and-execute concerns (Secure Action Principle does not apply)
- Preview feature — requires tenant admin to enable generative AI, and (for Search Summary) a site-level Copilot workspace toggle. APIs and admin toggles may change before GA.
- `/add-ai-webapi` delegates Layer 1/2 to `/integrate-webapi` in AI-only read mode — if a Web API item already covers the same table, the AI item detects the existing prereqs and skips the delegation

**Relationship to Web API:** AI Web API items for a given Dataverse table should be ordered **after** any regular Web API item for the same table (Web API sets up Layer 1/2; AI adds Layer 3 on top). Search Summary items can stand alone since they have no per-table prereqs.

**Field-list drift caveat (when both items exist for the same table):** if `/integrate-webapi`
has already configured `Webapi/<table>/fields` for full CRUD (including primary key and
lookup write forms), the follow-up `/add-ai-webapi` run detects Layer 1/2 as `ready` and
skips its delegation — leaving the broader CRUD allowlist in place. The AI surface still
works, but the fields list is broader than AI-only mode would produce. The
`ai-webapi-settings-architect` agent flags this as an advisory in its plan; the user can
narrow the allowlist after the AI surface lands by editing the YAML directly. If a strict
read-only posture matters from day one, run `/add-ai-webapi` *before* `/integrate-webapi`
on the same table — the AI skill will then write the minimal fields list and the later
Web API run will widen it.

---

### Server Logic (`/add-server-logic`)

**What it is:** Server-side JavaScript that runs in a sandboxed V8 engine on the Power Pages server. Exposed as REST endpoints at `/_api/serverlogics/<name>`. Code is hidden from the browser.

**How it works:** The frontend calls a server logic endpoint. The server executes the JavaScript function matching the HTTP method (get, post, put, patch, del). The function can access Dataverse, call external APIs, read site settings/environment variables, and return a computed response.

**Best for (by category):**

| Category | Use Case | Example |
|----------|----------|---------|
| **Security** | Secure content rendering | Healthcare portal: patient data after server-side role check |
| | Secret & credential management | Stripe API key stays on server; client never sees it |
| | Server-side validation | Reject order if quantity exceeds inventory |
| | Rate limiting / abuse prevention | Max 5 support tickets/hour/user, enforced server-side |
| **Authorization** | Complex permissions beyond table permissions | Moderator edits only in their assigned community |
| | Row-level logic | Manager approves expenses for direct reports < $1K |
| **Data Integrity** | Cross-entity transactions | Order + line items + inventory: all roll back if one fails |
| | Computed data | Insurance premium calculated server-side; client sees result |
| | Business rule enforcement (validate-and-execute) | Permit: Submitted > Review > Approved — server logic validates the transition AND writes the new status to Dataverse in a single call, so the client never writes the status field directly |
| | State machine transitions | Server logic reads current status, validates the target status is reachable, and performs the update — preventing clients from jumping to arbitrary states |
| **Performance** | Batch operations | Dashboard: Contacts + Orders + Products in one call |
| | Data aggregation | 12 monthly totals instead of 10,000 raw rows |
| | Response formatting | JSON, CSV, or XML based on caller request |
| **Integration** | Third-party services | PayPal/Stripe payment via server-side call |
| | On-prem services | ERP via Azure Relay for stock levels |
| | Microsoft Graph / SharePoint | Upload documents, read SharePoint lists via OAuth |
| | Wrapping Dataverse Custom APIs/Actions | Expose existing Dataverse custom actions (both Custom APIs and Custom Process Actions) to the portal via `InvokeCustomApi`. Discover available actions with `list-custom-actions.js` before recommending building from scratch — the customer may already have actions that do what's needed. |

**Not suitable when:**
- The operation is purely async/background (no immediate response needed) — use Cloud Flows instead
- The scenario only needs simple Dataverse CRUD with no extra logic — Web API is simpler
- The workflow spans multiple systems with built-in connectors (e.g., send email + create record + notify Teams) — Cloud Flows have 400+ connectors
- The operation takes longer than 120 seconds (platform maximum timeout)

**Key characteristics:**
- Code runs on the server (hidden from browser)
- Can call external APIs via `Server.Connector.HttpClient`
- Can access Dataverse via `Server.Connector.Dataverse` (respects table permissions)
- Can read site settings and environment variables for credential management
- 5 functions only: get, post, put, patch, del — each must return a string
- ECMAScript 2023 sandbox, no npm packages, no browser APIs
- 120-second maximum timeout, 10 MB default memory
- CSRF token required for non-GET requests

---

### Cloud Flows (`/add-cloud-flow`)

**What it is:** Power Automate cloud flows triggered from the Power Pages frontend. The flow runs asynchronously in the Power Automate service and has access to 400+ connectors.

**How it works:** The frontend calls a registered cloud flow endpoint. The flow runs in the background on Power Automate infrastructure. The user does not wait for the flow to complete — the trigger returns immediately with a confirmation.

**Best for:**
- Background/async processing where the user doesn't need an immediate result
- Sending emails or notifications after a form submission
- Processing orders, approvals, or multi-step business workflows
- Integrating with systems that have Power Automate connectors (Teams, Outlook, SharePoint, Dynamics 365, SAP, ServiceNow, etc.)
- Long-running processes that exceed the 120-second server logic timeout
- Orchestrating multi-step workflows across multiple systems
- Scenarios where no-code/low-code maintainability is important (business users can modify flows)

**Not suitable when:**
- The frontend needs an immediate, computed response (use Server Logic)
- The operation is simple Dataverse CRUD (use Web API)
- The logic needs to return data that the UI renders immediately (use Server Logic or Web API)
- Low latency is critical — flow trigger has overhead compared to direct API calls

**Key characteristics:**
- Runs asynchronously in Power Automate (fire-and-forget from the frontend)
- 400+ pre-built connectors
- No-code/low-code — modifiable by business users in the Power Automate designer
- Output is not immediately consumed by the user
- Registered via `.cloudflowconsumer.yml` metadata files
- Requires web role assignments for authorization

---

## Decision Matrix

Use these questions to narrow down the recommendation:

| Question | Web API | AI Web API | Server Logic | Cloud Flow |
|----------|:-------:|:----------:|:------------:|:----------:|
| Does the UI need to display data from Dataverse? | **Yes** | Possible | Possible | No |
| Does the UI need an AI-generated summary of Dataverse data? | No | **Yes** | No | No |
| Does the UI need AI-grounded search with citations? | No | **Yes** | No | No |
| Does a detail page need related-record discovery (e.g., suggested KB articles)? | No | **Yes** | Possible | No |
| Does it call external APIs (non-Dataverse)? | No | No | **Yes** | Possible |
| Are credentials/secrets involved? | No | No | **Yes** | Possible |
| Must business logic be hidden from the browser? | No | No | **Yes** | N/A |
| Does the write depend on a business rule that must be tamper-proof? | No | N/A (read-only) | **Yes (validate-and-execute)** | No |
| Is the operation async/background (user doesn't wait)? | No | No | No | **Yes** |
| Is it a simple Dataverse CRUD with no extra logic? | **Yes** | Overkill | Overkill | Overkill |
| Does it need 400+ connectors (Teams, Outlook, SAP)? | No | No | No | **Yes** |
| Should the response render immediately in the UI? | **Yes** | **Yes** | **Yes** | No |
| Does it batch multiple queries for performance? | No | No | **Yes** | No |
| Is it a long-running process (>120 seconds)? | No | No | No | **Yes** |
| Should non-developers be able to modify the logic? | No | No | No | **Yes** |
| Does the output need to be deterministic / exact? | **Yes** | No (probabilistic) | **Yes** | **Yes** |

## The Secure Action Principle

**When server logic validates a business rule, it must also execute the resulting action.**

This is the most important architectural principle for secure backend integration. Splitting validation from execution — where server logic validates a rule and then a separate client-side Web API call performs the write — creates a security gap because the client can skip the validation call and write directly via Web API.

### Anti-Pattern: Validate-Only Server Logic + Client-Side Write

```
❌ INSECURE — Do NOT use this pattern for security-sensitive operations:

1. Browser calls /_api/serverlogics/validate-transition (Server Logic checks Draft → Submitted is valid)
2. Server Logic returns { valid: true }
3. Browser calls /_api/cr65f_orders(id) with PATCH { status: "Submitted" } (Web API writes the change)

Problem: A user can skip step 1 and go directly to step 3 via browser dev tools,
bypassing all server-side validation.
```

### Correct Pattern: Validate-and-Execute Server Logic

```
✅ SECURE — Server logic validates AND executes:

1. Browser calls /_api/serverlogics/transition-order with POST { orderId: "...", newStatus: "Submitted" }
2. Server Logic reads current record from Dataverse, validates Draft → Submitted is allowed
3. Server Logic writes the status change to Dataverse via Server.Connector.Dataverse.UpdateRecord
4. Server Logic returns { status: "success", previousStatus: "Draft", newStatus: "Submitted" }

The browser never makes a direct Web API write for this operation.
```

### When Does This Apply?

Use validate-and-execute (server logic performs the write) whenever **any** of these are true:

| Condition | Example |
|-----------|---------|
| The operation enforces a state machine or lifecycle | Order status: Draft → Submitted → Approved → Fulfilled |
| The write depends on a business rule that must be tamper-proof | "Only allow bid submission before the deadline" |
| The operation spans multiple tables atomically | Award a bid + reject all others + update RFx status |
| The write involves computed or derived values the client shouldn't control | Server calculates a discount or score and writes it |
| The operation requires authorization beyond table permissions | "Managers can only approve expenses for their direct reports" |
| The client should not have write access to the field at all | Status fields that follow strict transitions |

Use Web API for the write (validation-only server logic is fine) when **all** of these are true:

| Condition | Example |
|-----------|---------|
| The write is simple CRUD with no business rules | Editing a name or description field |
| Table permissions alone enforce the access control | User edits their own profile |
| The fields being written have no restricted value constraints | Free-text fields, dates the user picks |
| Skipping validation would not cause a security or data integrity issue | Updating a contact's phone number |

### Impact on Plan Design

When building integration plans, this principle affects how items are assigned to approaches:

1. **State transitions** — The server logic endpoint should accept the entity ID and target status, validate the transition, and write the new status to Dataverse. The frontend calls only the server logic endpoint — there is no separate Web API PATCH for the status field.

2. **Multi-step operations** — When an action involves validation + write + side effects (e.g., award a bid, reject losers, update event status), the entire sequence belongs in one server logic endpoint. The frontend makes a single call.

3. **Mixed operations on the same table** — A table may use Web API for some fields (e.g., editing a description) and server logic for others (e.g., changing status). This is expected and correct. Table permissions should grant read access broadly but restrict write access to fields that are safe for direct client writes.

4. **Phase ordering** — Server logic endpoints that validate-and-execute should be built before any dependent frontend work. The frontend for these operations calls server logic, not Web API.

---

## Common Combinations

Many real-world scenarios use multiple approaches together:

| Combination | When to use | Example |
|-------------|-------------|---------|
| **Web API + AI Web API** | UI displays raw Dataverse records directly and also surfaces an AI-generated summary of the same data. Most common AI pattern. | Case detail page shows incident fields and portal comments via Web API, plus a Copilot summary card via AI Web API. Dashboard shows a list of orders and an AI summary of trends. |
| **Web API + Server Logic** | UI reads/writes non-sensitive fields directly, but security-sensitive operations go through server logic that validates and executes | Dashboard displays records via Web API; status transitions go through server logic that validates and writes |
| **AI Web API + Server Logic** | AI-augmented read surface over data that was computed or prepared by server-side logic | Server logic aggregates raw claims into a curated incident record (validate-and-execute); AI Web API summarises the curated record on the detail page |
| **Server Logic + Cloud Flow** | Real-time endpoint validates and executes the action, then async processing follows | Server logic validates transition and writes the new status, then a Cloud Flow sends the notification email |
| **Web API + Cloud Flow** | UI manages data directly (no business rules on the write), and some actions trigger background workflows | User edits a description via Web API; a separate "Submit for Approval" action triggers a Cloud Flow |
| **Web API + AI Web API + Cloud Flow** | Users browse and edit records, see AI summaries, and trigger async workflows | Support portal: list/edit cases (Web API), Copilot case summary with suggested KB articles (AI Web API), async assignment email (Cloud Flow) |
| **All four** | Complex application with safe direct writes, AI-augmented reads, secure server-side actions, and automation | Web API for browsing/editing non-sensitive fields, AI Web API for summaries and grounded search, Server Logic for state transitions and payment processing, Cloud Flow for notifications |

## Mapping User Intent to Approach

| User says... | Likely approach | Reasoning |
|--------------|-----------------|-----------|
| "Show data from Dataverse" / "display records" / "CRUD" | Web API | Direct data access, real-time UI binding |
| "Filter and sort products" / "search contacts" | Web API | Standard OData queries, no server logic needed |
| "Summarize this case" / "AI summary on the detail page" / "Copilot summary" | AI Web API | Data Summarization on a single record (the Microsoft-shipped support-case recipe is one option for the standard `incident` table) |
| "Summarize open cases" / "AI summary of this list" / "highlight trends in these records" | AI Web API | Data Summarization over a collection (list-summary pattern) |
| "Show relevant KB articles" / "suggest similar cases" / "related products" | AI Web API | Search Summary for related-record discovery — grounded retrieval returns AI-ranked citations from the site's search index |
| "AI search" / "semantic search" / "search with summary" | AI Web API | Search Summary endpoint returns a grounded AI answer plus citations for a user query |
| "Call an external API" / "integrate with Stripe/Twilio/etc." | Server Logic | External API calls with credential protection |
| "Add validation on the server" / "prevent bypassing" | Server Logic | Server-side enforcement (security) |
| "Rate limit submissions" / "prevent abuse" | Server Logic | Server-side enforcement (security) |
| "Calculate premium/price/discount on the server" | Server Logic | Computed data — logic hidden from browser |
| "Enforce a workflow sequence" / "status transitions" | Server Logic (validate-and-execute) | Server logic validates the transition AND writes the new status — the client never writes status directly via Web API |
| "Only let managers approve their team's expenses" | Server Logic | Row-level authorization logic |
| "Connect to our on-prem ERP" / "Azure Relay" | Server Logic | On-prem integration via server-side call |
| "Return data as CSV/XML" / "format the response" | Server Logic | Response formatting (performance) |
| "Send an email when..." / "notify the team when..." | Cloud Flow | Async notification, no immediate UI response |
| "Process orders in the background" | Cloud Flow | Background processing, user doesn't wait |
| "Batch multiple API calls" / "dashboard loads too slow" | Server Logic | Combine multiple queries into one endpoint |
| "Upload to SharePoint" / "call Microsoft Graph" | Server Logic | External API with OAuth credentials |
| "Use an existing custom action" / "call a Dataverse custom API" / "wrap a custom action" | Server Logic | Existing Dataverse custom action exposed to portal via `InvokeCustomApi` — discover available actions first |
| "Add an approval workflow" | Cloud Flow | Multi-step workflow with connectors |
| "Hide pricing logic from the browser" | Server Logic | Code hidden from client |
| "Bulk import CSV" / "process file in background" | Cloud Flow | Long-running background processing |
| "Create a record and send a confirmation email" | Web API + Cloud Flow | CRUD is immediate, email is async |
| "Validate inventory and process payment" | Server Logic (both) | Server-side validation + external API call |
| "Submit form, assign to team, and email confirmation" | Web API + Cloud Flow | Dataverse write + async assignment/email |
