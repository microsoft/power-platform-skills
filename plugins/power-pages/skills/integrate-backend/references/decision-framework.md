# Backend Integration Decision Framework

Use this framework to recommend the right backend integration approach for a Power Pages code site. A single user request may map to one approach or a combination.
## The Three Approaches

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
- The user wants server-side validation that can't be bypassed from the browser
- The operation should happen in the background after the user moves on

**Key characteristics:**
- Code runs in the browser (visible in DevTools)
- No external API access
- No credential/secret handling
- Real-time, synchronous responses
- Requires table permissions for every Dataverse table accessed
- CSRF token required for mutations (POST, PATCH, DELETE)

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
| | Business rule enforcement | Permit: Submitted > Review > Approved sequence |
| **Performance** | Batch operations | Dashboard: Contacts + Orders + Products in one call |
| | Data aggregation | 12 monthly totals instead of 10,000 raw rows |
| | Response formatting | JSON, CSV, or XML based on caller request |
| **Integration** | Third-party services | PayPal/Stripe payment via server-side call |
| | On-prem services | ERP via Azure Relay for stock levels |
| | Microsoft Graph / SharePoint | Upload documents, read SharePoint lists via OAuth |
| | Wrapping Dataverse Custom APIs | Expose `InvokeCustomApi` to the portal |

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

| Question | Web API | Server Logic | Cloud Flow |
|----------|:-------:|:------------:|:----------:|
| Does the UI need to display data from Dataverse? | **Yes** | Possible | No |
| Does it call external APIs (non-Dataverse)? | No | **Yes** | Possible |
| Are credentials/secrets involved? | No | **Yes** | Possible |
| Must business logic be hidden from the browser? | No | **Yes** | N/A |
| Is the operation async/background (user doesn't wait)? | No | No | **Yes** |
| Is it a simple Dataverse CRUD with no extra logic? | **Yes** | Overkill | Overkill |
| Does it need 400+ connectors (Teams, Outlook, SAP)? | No | No | **Yes** |
| Should the response render immediately in the UI? | **Yes** | **Yes** | No |
| Does it batch multiple queries for performance? | No | **Yes** | No |
| Is it a long-running process (>120 seconds)? | No | No | **Yes** |
| Should non-developers be able to modify the logic? | No | No | **Yes** |

## Common Combinations

Many real-world scenarios use multiple approaches together:

| Combination | When to use | Example |
|-------------|-------------|---------|
| **Web API + Server Logic** | UI reads/writes Dataverse directly, but some operations need server-side logic | Dashboard displays records via Web API, but "Export to PDF" calls server logic |
| **Server Logic + Cloud Flow** | Real-time endpoint handles the request, then kicks off background processing | Server logic validates and records the order, then triggers a Cloud Flow to send confirmation email |
| **Web API + Cloud Flow** | UI manages data directly, but some actions trigger background workflows | User edits a record via Web API, a "Submit for Approval" button triggers a Cloud Flow |
| **All three** | Complex application with data display, server processing, and automation | Web API for browsing data, Server Logic for payment processing, Cloud Flow for order fulfillment notifications |

## Mapping User Intent to Approach

| User says... | Likely approach | Reasoning |
|--------------|-----------------|-----------|
| "Show data from Dataverse" / "display records" / "CRUD" | Web API | Direct data access, real-time UI binding |
| "Filter and sort products" / "search contacts" | Web API | Standard OData queries, no server logic needed |
| "Call an external API" / "integrate with Stripe/Twilio/etc." | Server Logic | External API calls with credential protection |
| "Add validation on the server" / "prevent bypassing" | Server Logic | Server-side enforcement (security) |
| "Rate limit submissions" / "prevent abuse" | Server Logic | Server-side enforcement (security) |
| "Calculate premium/price/discount on the server" | Server Logic | Computed data — logic hidden from browser |
| "Enforce a workflow sequence" / "status transitions" | Server Logic | Business rule enforcement (data integrity) |
| "Only let managers approve their team's expenses" | Server Logic | Row-level authorization logic |
| "Connect to our on-prem ERP" / "Azure Relay" | Server Logic | On-prem integration via server-side call |
| "Return data as CSV/XML" / "format the response" | Server Logic | Response formatting (performance) |
| "Send an email when..." / "notify the team when..." | Cloud Flow | Async notification, no immediate UI response |
| "Process orders in the background" | Cloud Flow | Background processing, user doesn't wait |
| "Batch multiple API calls" / "dashboard loads too slow" | Server Logic | Combine multiple queries into one endpoint |
| "Upload to SharePoint" / "call Microsoft Graph" | Server Logic | External API with OAuth credentials |
| "Add an approval workflow" | Cloud Flow | Multi-step workflow with connectors |
| "Hide pricing logic from the browser" | Server Logic | Code hidden from client |
| "Bulk import CSV" / "process file in background" | Cloud Flow | Long-running background processing |
| "Create a record and send a confirmation email" | Web API + Cloud Flow | CRUD is immediate, email is async |
| "Validate inventory and process payment" | Server Logic (both) | Server-side validation + external API call |
| "Submit form, assign to team, and email confirmation" | Web API + Cloud Flow | Dataverse write + async assignment/email |
