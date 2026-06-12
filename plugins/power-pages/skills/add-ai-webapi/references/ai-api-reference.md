# Power Pages Generative-AI Summarization APIs

Reference for the two Power Pages endpoints that return AI-generated summaries — Search Summary
(`/_api/search/v1.0/summary`) and Data Summarization
(`/_api/summarization/data/v1.0/<entitySet>(<id>)?...`). Both use the same portal session auth — a CSRF
token fetched from `/_layout/tokenhtml` sent as the `__RequestVerificationToken` header. No
`Authorization` bearer is needed.

The Microsoft-shipped support-case Copilot summary is **a configuration of Data Summarization**, not
a third endpoint — same URL family, specific entity set (`incidents`), specific `$select` / `$expand`,
and the canonical `Summarization/prompt/case_summary` identifier. See §3 below.

Sources (Microsoft Learn):

- Search Summary API — https://learn.microsoft.com/power-pages/configure/search/generative-ai#search-summary-api
- Data Summarization API — https://learn.microsoft.com/power-pages/configure/data-summarization-api
- Case-page Copilot preset — https://learn.microsoft.com/power-pages/configure/add-copilot-summarization-to-case-page

---

## Semantics vs. HTTP method — why these rules differ from `/integrate-webapi`

Both endpoints are **semantically reads**: they return an AI-generated summary of content
the caller could already read through the regular Power Pages Web API, and they never mutate
Dataverse. They use **POST** for transport only — because the request carries a body
(`userQuery`, `InstructionIdentifier`, `RecommendationConfig`) that doesn't fit in a GET query
string cleanly.

This matters because the general `/integrate-webapi` rulebook assumes POST means mutation. Several
of those rules do **not** apply here:

| `/integrate-webapi` rule for POST | Why it doesn't apply to AI summarization |
|-----------------------------------|------------------------------------------|
| Set lookup relationships via `NavigationProperty@odata.bind` | No writes happen — there's nothing to bind. |
| Send `Prefer: return=representation` and handle the `Location` / `OData-EntityId` header | The response always contains the summary body; no record is created. |
| Require `If-Match: *` | That header is for PATCH; not applicable. |
| Table permissions should grant `create: true` / `write: true` for POST callers | AI callers need **`read: true` only**. |
| `Webapi/<table>/fields` should include the primary key for CRUD | Primary key isn't needed — the record id is in the URL path, not a selected column. MS's shipped case preset ships `Webapi/incident/fields = description,title` with no `incidentid`. |
| Lookup columns need both the LogicalName and `_<col>_value` forms | Only the `_<col>_value` read form is needed. The LogicalName write form is only required if the same table has non-AI mutation code elsewhere. |

**Runtime auth path.** When a request hits `/_api/summarization/data/v1.0/<table>(<id>)?...`, the
Power Pages runtime walks this sequence before the generative layer sees any content:

1. Is `Webapi/<table>/enabled = true`? → if not, 403
2. Does the caller's web role have a table permission on `<table>` with `read: true`? → if not, 403
3. Are all columns named in `$select` / `$expand` allowlisted in `Webapi/<table>/fields`? → if not, 403
4. For each `$expand` target, repeat steps 1–3 on that table (and confirm Parent-scope with
   `appendTo: true` on the parent) → if not, 403
5. Is `Summarization/Data/Enable = true`? → if not, error `90041003`
6. Does the `InstructionIdentifier` value correspond to an existing
   `Summarization/prompt/<identifier>` site setting? → if not, error from the summariser

Only after step 6 does the request reach the Azure OpenAI layer that produces the summary. This
is why the `add-ai-webapi` skill orders its work as Phase 4 (Layer 1 + Layer 2 via
`/integrate-webapi` in AI-only read mode) before Phase 6 (Layer 3 via `ai-webapi-settings-architect`)
— Layer 3 can't be validated until Layers 1 and 2 are on disk.

---

## 1. Search Summary API

Summarises search results using generative AI for a user query. Requires that **Site search with generative AI** is enabled in the site's Copilot workspace.

| Method | URI |
|--------|-----|
| POST | `/_api/search/v1.0/summary` |

> **At-a-glance gotchas (full detail below):**
> - **Content-Type:** `application/x-www-form-urlencoded` — *not* `application/json`. JSON returns 400.
> - **Indexed content:** the API grounds on the site's knowledge-article index. A Single Page
>   Application (SPA) site with no `knowledgearticle` data (or with the search index not yet
>   built) returns empty `Summary` / `Citations`. Verify your site has knowledge articles
>   populated and indexed before debugging the API itself.
> - **Citation URLs on SPA sites:** returned as `/page-not-found/?id=<guid>`. Rewrite to your SPA's
>   KB route (default `/knowledge/:id`) — see the "Citation URLs on SPA sites" subsection.

**Request body (wire format):**

The Microsoft Learn sample calls this with jQuery as:

```javascript
shell.ajaxSafePost({
  type: "POST",
  url: ".../_api/search/v1.0/summary",
  contentType: "application/x-www-form-urlencoded",
  data: { userQuery: "Fix problems with slow coffee dispense" }
})
```

With that `contentType`, jQuery serialises `data` into a URL-encoded string. The actual wire body is:

```http
Content-Type: application/x-www-form-urlencoded

userQuery=Fix+problems+with+slow+coffee+dispense
```

> **⚠️ Content-Type is the #1 way to break this endpoint.** The Search Summary API **requires**
> `application/x-www-form-urlencoded` — sending `application/json` (even with the correct payload
> shape) returns a 400. This is the opposite of the Data Summarization endpoint, which requires
> JSON. Do **NOT** reuse `buildPowerPagesHeaders()` defaults (or any other shared header helper
> that defaults to `application/json`) without explicitly overriding `contentType` for this call.
> A copy-paste from the data endpoint is the most common source of Search Summary 400s in the
> field.

**Response body:**

```json
{
  "Summary": "To fix slow coffee dispense, descale the boiler[[1]](https://contoso.powerappsportals.com/knowledgebase/article/KA-01055) and verify the pump pressure is within spec[[2]](https://contoso.powerappsportals.com/knowledgebase/article/KA-01092).",
  "SummaryTitle": "Troubleshooting slow coffee dispense",
  "SearchTitle": "Fix problems with slow coffee dispense",
  "Citations": {
    "[1]": "https://contoso.powerappsportals.com/knowledgebase/article/KA-01055",
    "[2]": "https://contoso.powerappsportals.com/knowledgebase/article/KA-01092"
  },
  "CitationTitleMapping": {
    "[1]": "KA-01055 — Descaling the espresso boiler",
    "[2]": "KA-01092 — Pump pressure calibration"
  },
  "Chunks": [
    { "Id": "...", "Title": "...", "Url": "...", "Score": 0.87 }
  ],
  "ErrorMessage": "",
  "ResponseStatus": "Success"
}
```

**Notes:**

- `Summary` embeds citations inline as markdown-style links: `[[N]](url)`. Rendering `{Summary}`
  directly in a `<p>` (or via `v-html` / `innerHTML`) will show raw markdown syntax — the caller
  must parse the token pattern and emit framework-native clickable elements. Do **not**
  pass the raw string through `dangerouslySetInnerHTML` or a markdown renderer; it's a single
  inline token grammar, not general markdown.
- `Citations` is an object keyed by citation tokens (`[1]`, `[2]`, ...) that map tokens to the
  source URL (see "Citation URLs on SPA sites" below for a gotcha).
- `CitationTitleMapping` is an object keyed by the same tokens that maps each token to a
  human-readable title — **use this as the visible label** for citation links and citation-list
  rows, with the URL as a fallback only when the mapping is absent.
- `SummaryTitle` is a short AI-generated heading for the summary block; `SearchTitle` echoes back
  the user's query.
- `Chunks` is an array of the underlying content chunks the summary was grounded on (rarely needed
  by UI code; useful for debugging).
- `ErrorMessage` / `ResponseStatus` are populated on failure (the API returns 200 with a non-empty
  `ErrorMessage` for soft-failures like "no results").
- Enablement is a tenant/site toggle — no per-table `Webapi/*` site setting is required for search summary.
- Faceted search is **not** available when generative AI search is enabled.
- Content snippet `Search/Summary/Title` controls the section heading on the built-in search results page.

**TypeScript shape:**

```ts
export interface SearchSummaryChunk {
  Id?: string;
  Title?: string;
  Url?: string;
  Score?: number;
}

export interface SearchSummaryResponse {
  Summary: string;
  Citations: Record<string, string>;
  // Extras — optional because older server versions omit them, but real tenants return them today.
  SummaryTitle?: string;
  SearchTitle?: string;
  CitationTitleMapping?: Record<string, string>;
  Chunks?: SearchSummaryChunk[];
  ErrorMessage?: string;
  ResponseStatus?: string;
}
```

**Parsing inline citations.** The `Summary` string contains `[[N]](url)` tokens that must be
split into alternating text and citation runs so the UI can render each citation as a clickable
element (with its `CitationTitleMapping[token]` label, or the URL as fallback). Use this helper
verbatim — a hand-rolled `split(/(\[\d+\])/)` is not sufficient because the server embeds the URL
inside the token, not just the `[N]` marker:

```ts
type SummaryPart =
  | { kind: 'text'; text: string }
  | { kind: 'citation'; token: string; url: string };

function parseSummaryWithCitations(summary: string): SummaryPart[] {
  if (!summary) return [];
  const re = /\[\[(\d+)\]\]\(([^)]+)\)/g;
  const parts: SummaryPart[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(summary)) !== null) {
    if (m.index > last) parts.push({ kind: 'text', text: summary.slice(last, m.index) });
    parts.push({ kind: 'citation', token: `[${m[1]}]`, url: m[2].trim() });
    last = re.lastIndex;
  }
  if (last < summary.length) parts.push({ kind: 'text', text: summary.slice(last) });
  return parts;
}
```

Render each `citation` part as a framework-native anchor element, using
`CitationTitleMapping[token]` for the visible label when available.

### Citation URLs on SPA sites

On Microsoft-shipped portal templates the `Citations` URLs point at the built-in Knowledge Base
page (`/knowledgebase/article/<articleNumber>`). On **SPA sites** the built-in KB page does
not exist, so the Search Summary service falls back to returning URLs of the form:

```
https://<host>/page-not-found/?id=<knowledgearticleid-guid>
```

The `id` query-string parameter is the actual `knowledgearticleid` GUID from Dataverse. SPAs that
surface knowledge articles typically route them at something like `/knowledge/:id`, so the
citation URL must be rewritten before it's rendered as a clickable link — otherwise every
citation lands on the built-in 404 page.

Drop-in helper for extracting the GUID so callers can reconstruct their own SPA route:

```ts
function extractKnowledgeArticleId(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.origin);
    const id = parsed.searchParams.get('id');
    if (id && /^[0-9a-f-]{36}$/i.test(id)) return id;
  } catch {}
  return null;
}
```

Usage sketch:

```ts
const articleId = extractKnowledgeArticleId(citationUrl);
const href = articleId ? `/knowledge/${articleId}` : citationUrl;
```

Treat a successful `extractKnowledgeArticleId` match as authoritative — it means the server
returned a fallback page-not-found URL with the real GUID attached. A null result means the URL
is a regular site page and should be used verbatim.

### Empty response handling

When no content is indexed for the query, Search Summary returns a 200 with an empty `Summary`
(and typically empty `Citations`, or a non-empty `ErrorMessage` like "No results found"). The UI
must render an explicit empty state ("No related items found") rather than hiding the whole
section — hiding reads as a broken feature because the user sees their query disappear. Branch
the render on `Summary.trim().length === 0` (not just `!Summary`) to catch whitespace-only
responses.

### Gen AI Search disabled state — HTTP 200 with embedded error envelope

**Not documented on Microsoft Learn.** Observed in the wild: when the site-level **Site search
with generative AI (preview)** toggle is off, the Search Summary endpoint returns HTTP 200 with
a body of the form:

```json
{ "Code": 400, "Message": "Gen AI Search is disabled." }
```

No `Summary`, no `Citations`, no other fields. Naive code that checks `response.ok` and then
returns `response.json()` treats this as a success and ends up rendering the empty-state message
("No related items found") — which is misleading because no amount of retry or query tweaking
will fix it. Only a site admin flipping the toggle will.

**Detection rule.** After a 200, if the body has a top-level `Code` (number) and `Message`
(string) and no `Summary`, it is the disabled-state envelope — convert to a typed error instead
of a success response. This is distinct from Data Summarization's `90041001` error, which
arrives as a proper HTTP 400 with `{ error: { code: "90041001", ... } }` (see §2 Error codes).
Different surface, different envelope, same underlying admin toggle.

**Why the server behaves this way.** Search Summary is the only one of the three AI endpoints
gated by a **site-level** toggle rather than per-table site settings — the toggle lives in the
maker's Set up workspace, not in `.powerpages-site/site-settings/`. When the toggle is off, the
endpoint is registered but short-circuits with a canned response body. The HTTP 200 is a quirk
of how the short-circuit path is wired on the server side.

**Enable procedure** (from Microsoft Learn — fetched 2026-04-20):

1. Go to the site's **Set up workspace**
2. Under **Copilot** select **Site search (preview)**
3. Turn on **Enable Site search with generative AI (preview)**

Link to surface in the UI when this state is detected: `https://learn.microsoft.com/power-pages/configure/search/generative-ai#enable-site-search-with-generative-ai`

**UI consequences.**

- Render a specific remediation card in place of the summary: headline "AI search summary is
  turned off for this site", explanation mentioning the workspace path above, and a link to the
  Learn doc. Do NOT show a retry button in this state — retry is useless until the toggle flips.
- Keep the keyword search results (from `/_api/search/v1.0/query`) rendering as normal — the
  toggle only disables the AI summary layer, not keyword search.
- Do NOT treat this as equivalent to the empty-results state ("No related items found") —
  conflating them hides a real configuration problem under a generic "we couldn't find anything"
  message.

The generated service code in `src/services/aiSummaryService.*` handles this via a
`SearchSummaryApiError` exception plus an `isGenAiSearchDisabled(err)` predicate; see the
agent's §3.2 for the reference implementation.

### Troubleshooting: AI feature appears disabled (admin hierarchy)

This checklist applies to **both Search Summary and the Data Summarization API** — the same
Copilot Hub admin surface gates both features. When the maker has flipped the site-level toggle
on but the API still returns a disabled response, the cause is usually higher up in the
hierarchy. Walk the levels top-down; each level **overrides** the one below it.

Admin reference: [Copilot hub for Power Pages (preview)](https://learn.microsoft.com/power-pages/admin/copilot-hub)

**1. Tenant-level governance (PowerShell).** Controlled via the
`enableGenerativeAIFeaturesForSiteUsers` PowerShell setting. If this is off at the tenant level,
nothing downstream can be enabled — admins opening Copilot Hub will see an error prompting them
to enable tenant-level settings first. Only **Power Platform administrator** or **Dynamics 365
administrator** (Azure AD service-admin roles) can change this.

**2. Environment-level governance (Copilot Hub).** Power Platform Admin Center → **Copilot Hub**
→ **Power Pages** tab → **Settings**. Each end-user AI feature (Search summary, Summarization
API, Chat agent, AI form fill, AI summary list) has its own per-feature governance page. For the
selected environment, the admin picks one of:

| Option | Effect |
|--------|--------|
| **On - All sites** | Feature enabled in every site in the environment |
| **All sites except specific sites** | Enabled everywhere **except** listed sites. **Overrides maker config** on the excluded sites. |
| **Specific sites** | Enabled **only** on listed sites. Prevents access in all other sites in the environment. |
| **None of the sites** | Disabled for every site. **Overrides maker config** — even if the maker toggle is on, the feature won't work. |

**The admin setting wins.** If Search Summary returns the disabled envelope even though the
maker toggle is on, check whether this environment/site is excluded here. This is the most
common cause of "the toggle is on but it still says disabled".

**3. Site-level maker toggle.** Set up workspace → Copilot → Site search (preview) → Enable Site
search with generative AI (preview). Only relevant when the two levels above allow it. In the
studio, if admin has disabled the feature at the environment level, **the maker-side toggle
appears greyed out** with an in-product message directing the maker to their admin.

**4. Runtime version.** Copilot Hub requires site runtime **9.7.4.xx or later**. If the site is
on an older runtime, some AI features won't exist — the admin UI may show them but the runtime
won't serve them. Upgrade the site's runtime version before chasing other causes.

**5. Cross-region data movement.** If the environment's region lacks sufficient Azure OpenAI
capacity and the "Move data across regions" setting is **disallowed**, Copilot features
silently fail. Admins can't configure the feature in Copilot Hub in this case. See [Move data
across regions for Copilots and generative AI features](https://learn.microsoft.com/power-platform/admin/geographical-availability-copilot).

**6. Bing search dependency** (chat/search features only). If Bing search is disabled at the
environment level, any Copilot feature that depends on Bing search won't function. Less common
for Summarization API, but worth checking if the symptom is intermittent.

**What end users see when disabled.** Per Microsoft's admin doc, when governance blocks a
feature for end users, *"users see a regular search and don't get a generative AI powered search
summary. Users don't see any messaging about organizational policies or governance controls."*
This is exactly why the generated code surfaces a remediation card on the disabled envelope —
without it, the user sees a silent fallback and thinks the feature is broken, when it was
actually governed off by an admin.

**Deprecated surface.** The older tenant-level governance configuration page is deprecated; all
admin governance now flows through Copilot Hub → Power Pages → Settings. If someone points at
the old governance page during debugging, redirect them — their existing settings are preserved
but new changes must go through the hub.

---

## 2. Data Summarization API

Summarises a single Dataverse record (optionally with expanded related collections) using generative AI. Built on the Power Pages Web API, so all read-operation OData options apply (`$select`, `$expand`, `$filter` inside `$expand`, etc.). **Preview feature.**

| Method | URI |
|--------|-----|
| POST | `/_api/summarization/data/v1.0/<entitySetName>(<recordId>)?<odata-query>` |

**Request body (first request — use a maker-defined prompt):**

```json
{ "InstructionIdentifier": "Summarization/prompt/<table>_instruction_identifier_<usecase>" }
```

**Request body (follow-up — use a recommended prompt from a prior response):**

```json
{ "RecommendationConfig": "<hashed config string from prior response, verbatim>" }
```

- **Exactly one** of `InstructionIdentifier` and `RecommendationConfig` is set per call.
- `InstructionIdentifier` must match a site-setting name that exists — e.g. site setting `Summarization/prompt/case_summary` is identified as `"Summarization/prompt/case_summary"`.
- `RecommendationConfig` is an opaque hashed value that must be sent verbatim; any modification invalidates it.

**Response body:**

```json
{
  "Summary": "The data results provide information…",
  "Recommendations": [
    { "Text": "would you like to know about…?", "Config": "HSYmaicakjvIwTFYeCIjKOyC7nQ4RTSiDJ+/LBK56r4=" }
  ]
}
```

- `Recommendations` is always an array (may be empty). Feed a `Config` back as `RecommendationConfig` to get a refined summary.
- Respects row-level security: only records the user can read are considered.
- Inherits the `$expand` / nested-expand behaviour of the Power Pages Web API — each expanded related table needs its own Web API site settings and table permissions.

### Collection endpoint for list summaries

When the caller wants "N rows the user can see" (e.g., a list of recent work orders for the
signed-in contact) rather than one specific record, use the **collection** form of the URI — not
an account-anchored record form with nested `$expand`.

**Rule — mirror the existing data fetch.** Whenever the target page already fetches a list or a
filtered collection from Dataverse, the summary URL is a mechanical transformation of that
fetch's URL. Do not re-derive `$select` / `$expand` / `$orderby` / `$filter` from scratch — copy
them verbatim so the AI summary covers the exact rows the user is looking at.

```
Existing data fetch:   /_api/<entitySet>?<query>
AI summary URL:        /_api/summarization/data/v1.0/<entitySet>?<query without $top>
```

And on the request: **do not** send the `Prefer: odata.maxpagesize` header that the paginated
fetch uses. `$top` is UI pagination; the server-side cap for summarization is
`Summarization/Data/ContentSizeLimit` (default `100000` chars). If you carry `$top=25` over, the
AI summary silently covers only those 25 rows even though `ContentSizeLimit` would allow many
more.

**Example 1 — plain list page (invoices list):**

```
List fetch:
  GET /_api/crd50_invoices
    ?$select=crd50_invoiceid,crd50_name,crd50_amount,crd50_invoicestatus,createdon
    &$expand=crd50_ContactId($select=contactid,fullname)
    &$orderby=crd50_submissiondate desc
    &$count=true
    &$top=10

Summary:
  POST /_api/summarization/data/v1.0/crd50_invoices
    ?$select=crd50_invoiceid,crd50_name,crd50_amount,crd50_invoicestatus,createdon
    &$expand=crd50_ContactId($select=contactid,fullname)
    &$orderby=crd50_submissiondate desc
    &$count=true
```

**Example 2 — parent-filtered collection (invoice-attachments subgrid on an invoice form):**

```
Form subgrid fetch:
  GET /_api/crd50_invoiceattachments
    ?$select=crd50_invoiceattachmentid,crd50_name,crd50_filesize,createdon
    &$orderby=createdon desc
    &$count=true
    &$top=25
    &$filter=_crd50_invoiceid_value eq <parent-invoice-guid>

Summary:
  POST /_api/summarization/data/v1.0/crd50_invoiceattachments
    ?$select=crd50_invoiceattachmentid,crd50_name,crd50_filesize,createdon
    &$orderby=createdon desc
    &$count=true
    &$filter=_crd50_invoiceid_value eq <parent-invoice-guid>
```

The **`$filter` must be preserved** — it's what scopes the summary to this parent's attachments
rather than every attachment in the site. Dropping it produces an unrelated summary. This is the
main reason the transformation is mechanical (copy the query) rather than creative (re-derive
the query): the original fetch already encodes the user's scope intent, and recomputing it from
the page's filename or user prompt loses signal.

Full URL template (what the transformation produces):

```
POST /_api/summarization/data/v1.0/<entitySetName>?$select=...
  &$expand=<NavProp>($select=...)
  &$orderby=<col> desc
  &$count=true
  [&$filter=...]
```

The endpoint respects table permissions, so the user only sees rows the row-level security layer
already scopes for them — no explicit record id in the path is needed. Prefer this pattern over
the record form (`accounts(<id>)?$expand=cr363_account_workorder(...)`) for list/history/results
pages because it:

- Eliminates the otherwise-required `/_api/accounts?$top=1` lookup to resolve the anchor id.
- Keeps `$filter` / `$orderby` / `$top` at the root, where they're straightforward — nested
  `$filter;$top;$orderby` inside `$expand` on the record form is fragile.

Use the record form only when the caller genuinely needs a single named record. For
list/history/results pages, default to the collection form.

### Sizing

Prefer **omitting `$top`** for list summaries. The server caps input text via
`Summarization/Data/ContentSizeLimit` (default `100000` characters) and surfaces error
`90041004` when exceeded. Only set `$top` when you have an explicit UX reason (e.g., "top 10
highest-priority tickets"). A hardcoded `$top=25` is usually wrong — it silently caps the data
the user thinks they're summarising.

### List-summary playbook

When the target is a LIST of records (not a single record), the defaults for a single-record
Copilot card (such as the Microsoft-shipped support-case recipe) are the wrong defaults.
Apply every rule below — the orchestrator skill (`/add-ai-webapi`) and the
`ai-webapi-integration` agent both reference this playbook:

1. **Use the collection endpoint** —
   `POST /_api/summarization/data/v1.0/<entitySet>?$select=...` — not the account-anchored
   `accounts(<id>)?$expand=<navprop>` form. Row-level security already scopes the
   collection; the extra `/_api/accounts?$top=1` lookup and fragile nested
   `$filter;$top;$orderby` inside `$expand` are both avoidable. See
   "Collection endpoint for list summaries" above.
2. **Ask "auto-load or button?"** Auto is usually right for short lists; button is safer
   when the collection is large or filters change often.
3. **Scope: mirror the existing list fetch — OR confirm with the user when ambiguous.**
   If the target page has an existing list fetch AND the user's request is generic
   ("add a summary to this list"), mirror `$filter`/`$orderby` from the existing fetch so
   the summary covers the same rows the user sees. `$select` / `$expand` can be supersets
   (add a lookup expand → name for AI context), but never drop columns the UI displays.
   When the user's request contains a scope qualifier the existing fetch doesn't have
   ("open invoices" when the page shows all), OR the target page has no existing list
   fetch at all, **do NOT guess the `$filter` — ASK the user.** Silently inventing an OData
   filter gives the user a summary they didn't ask for. Strip `$top` entirely, and do NOT
   carry over any `Prefer: odata.maxpagesize` header — pagination is UI behaviour, not
   summary scope. Let `Summarization/Data/ContentSizeLimit` govern the server-side cap.
4. **Use the tabular-insight prompt**, not a narrative prompt. The 3-insights /
   <=200-words / no-suggested-actions pattern produces much stronger output than "write a
   4-sentence narrative". Use the compact template in
   `${CLAUDE_PLUGIN_ROOT}/agents/ai-webapi-settings-architect.md` (~570 chars) so the
   deployed prompt fits the size budget.
5. **Include at most one short domain-neutral few-shot example** (~250 chars) —
   sales-by-region, software purchases, fleet maintenance. Avoid domain-matched examples —
   the model copies example figures instead of grounding on the user's data. Skip the
   example entirely if the combined prompt would exceed 1000 chars.

   **Hard size limits on `Summarization/prompt/<id>` value:** target ≤1000 characters, hard
   ceiling 2000 characters. The `validate-ai-webapi.js` validator blocks the run when any
   prompt exceeds 2000 chars and warns above 1000. The ceiling exists because the
   underlying `adx_sitesetting.adx_value` Memo column defaults to `MaxLength=2000` in many
   environments; exceeding it can cause silent upload truncation or a Dataverse-level
   reject.
6. **Ship `normalizeSummaryString` in the service layer.** The tabular-insight prompt
   returns `Summary` as a JSON-encoded string array; rendering it raw shows `[\"...\"]` in
   the UI.
7. **Ship a tiny safe-markdown renderer** in the UI (React/Vue/Angular/Astro). Insights
   contain `**bold**` and `\n\n` separators; rendering `{summary}` directly shows raw
   asterisks.
8. **Use YAML block-literal** (`value: |` with indented content) for any prompt > 200 chars
   or containing `:`, `|`, `` ` ``, `<|`, `> `, a colon-quote, or a newline. Plain-scalar
   YAML breaks `pac pages upload-code-site` silently for these.
9. **Verify `$expand` nav-property casing** against Dataverse metadata
   (`EntityDefinitions(LogicalName='<primary>')/ManyToOneRelationships` →
   `ReferencedEntityNavigationPropertyName`). The nav prop is PascalCase; the lookup column
   is lowercase. Mismatched casing returns 400.
10. **Always ship `Summarization/Data/ContentSizeLimit = 200000` for list-summary
    targets** — this is required, not optional. The 100k server default silently truncates
    list content *before* it reaches the model, so summaries ship based on partial data
    with no error to catch. `90041004` only fires on overflow; under-overflow truncation is
    invisible. Bump above `200000` only when real data hits `90041004` consistently.

### Summary may be a JSON-encoded string array for list prompts

Prompts that instruct the model to emit "three insights" (the tabular-insight pattern — see
`agents/ai-webapi-settings-architect.md`) return `Summary` as a **JSON-encoded string array**,
not a paragraph:

```
"Summary": "[\"**Insight 1 heading** ...\",\"**Insight 2 heading** ...\",\"**Insight 3 heading** ...\"]"
```

The model follows the "three insights" contract and serialises the list as an array. Rendering
`{payload.Summary}` directly in the UI shows the raw brackets, escaped quotes, and Unicode
escapes (e.g. `\u0027`). Normalise in the shared `postSummary`-style helper in
`aiSummaryService.ts` so every caller gets the normalised shape:

```ts
function normalizeSummaryString(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return raw
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) {
      return parsed.join('\n\n')
    }
  } catch { /* fall through */ }
  return raw
}
```

Both paragraph and array shapes should continue to work — smoke-test both during rollout.

### Required site settings

| Name | Value | Type | Purpose |
|------|-------|------|---------|
| `Summarization/Data/Enable` | `true` | boolean | Master toggle for the data summarization API |
| `Summarization/prompt/<identifier>` | `<prompt text>` | string | One or more maker-defined prompts; the `<identifier>` portion is referenced by `InstructionIdentifier`. **Size budget: target ≤1000 chars, hard ceiling 2000 chars** — the value lives in `adx_sitesetting.adx_value` (a Memo column whose default `MaxLength` is 2000 in many environments). The `validate-ai-webapi.js` validator blocks runs that exceed 2000 chars and warns above 1000. |
| `Summarization/Data/ContentSizeLimit` | `100000` | integer | Optional. Input-content character cap (default `100000`). **When to raise:** only when a specific list-summary target hits error `90041004` consistently with realistic data volumes. Raise in increments of `50000`, not wholesale — higher limits cost more per call. For list-summary targets, `200000` is a safer default (~500 rows of narrow records). |
| `Webapi/<table>/enabled` | `true` | boolean | **Required** — the table being summarised must also have Web API enabled |
| `Webapi/<table>/fields` | `<validated columns>` | string | Columns the API can read; must include every column named in `$select`/`$expand` |

### Error codes (HTTP 400)

| Code | Message |
|------|---------|
| `90041001` | Generative AI features are disabled |
| `90041003` | Data summarization disabled for this site. Enable using the site setting. |
| `90041004` | Content length exceeds the limit |
| `90041005` | No records found to summarize |
| `90041006` | Error occurred while summarizing the content. |

> **`90041001` can originate from three different levels.** The message says "Generative AI
> features are disabled" but doesn't say *where* they're disabled. Walk the admin hierarchy in
> §1's [*Troubleshooting: AI feature appears disabled*](#troubleshooting-ai-feature-appears-disabled-admin-hierarchy)
> checklist — tenant PowerShell setting, Copilot Hub environment/site governance, and the
> site-level Summarization API toggle each produce this same code. The retry button will not
> help; an admin has to change the governance state. The Copilot Hub governance setting for this
> feature is **Summarization API** (listed separately from Search summary).
>
> **`90041003` vs `90041001`.** `90041003` means the per-site `Summarization/Data/Enable` site
> setting is missing or false — the fix is to run `ai-webapi-settings-architect` (or edit the
> site setting directly). `90041001` is higher in the hierarchy (tenant or environment
> governance) and typically requires admin intervention.

### Empty response handling

Two distinct "empty" shapes can come back from this endpoint and the UI must handle both rather
than hiding the summary section:

1. **Error `90041005` ("No records found to summarize")** — a 400 whose error body contains the
   `90041005` code. Hits when the record exists but every column in `$select` (and every
   `$expand` collection that would contribute content) is empty. Render a calm "No summary
   available for this record yet" message in the summary slot.
2. **200 with empty `Summary` / empty `Recommendations`** — rarer, but possible when the model
   has nothing meaningful to return. Branch on `!response.Summary?.trim()`. Render the same
   empty-state message; keep the section visible so the user can tell the feature is working and
   simply has nothing to summarise yet.

Hiding the entire summary section on empty reads as a broken feature — users interpret the
missing surface as "the Copilot card never loaded". Always render **one of four** branches:
`loading`, `error`, `content`, `empty`. See the agent's Step 5 for the UI contract.

---

## 3. Case-page Copilot preset

The canonical implementation of the data-summarization API for the **incident** (case) table. Shipped by the Customer self-service and Community portal templates as a Copilot summary section on the support case page.

| Field | Value |
|-------|-------|
| Entity set | `incidents` |
| Record id | Case GUID (from `?id=` query string on the case page) |
| `$select` | `description,title` |
| `$expand` | `incident_adx_portalcomments($select=description)` |
| `InstructionIdentifier` | `Summarization/prompt/case_summary` |

**Request URL template:**

```
POST /_api/summarization/data/v1.0/incidents(<caseId>)?$select=description,title&$expand=incident_adx_portalcomments($select=description)
```

**Request body:**

```json
{ "InstructionIdentifier": "Summarization/prompt/case_summary" }
```

### Required site settings for the preset

| Setting description | Name | Value |
|---------------------|------|-------|
| Enable data summarization | `Summarization/Data/Enable` | `true` |
| Prompt for the case summary | `Summarization/prompt/case_summary` | `Summarize key details and critical information` |
| Enable Web API for incident | `Webapi/incident/enabled` | `true` |
| Allowed fields for incident | `Webapi/incident/fields` | `description,title` |
| Enable Web API for portal comments | `Webapi/adx_portalcomment/enabled` | `true` |
| Allowed fields for portal comments | `Webapi/adx_portalcomment/fields` | `description` |

> The `adx_portalcomment` table is expanded via `incident_adx_portalcomments($select=description)` — both tables need Web API site settings **and** table permissions with `read: true`.

### Empty response handling

The Microsoft-shipped support-case configuration trips `90041005` more often than other Data
Summarization configurations because it expands `incident_adx_portalcomments($select=description)`
— a freshly-created case with no comments and a blank `description` has literally nothing to
summarise. Treat `90041005` here as a first-class empty state, not an error: render "No case
summary yet — add a description or a comment and try again" in the summary card (keep the
Copilot-style shell visible, including the gradient border and header) rather than hiding the
section or showing a generic error.

SKILL.md Phase 8's test recipe already tells the user to add at least one comment before
clicking the chevron — surface that same guidance in the empty-state text so testers know why
they're seeing it.

---

## CSRF token handling (both APIs)

Every POST to these endpoints must include the portal anti-forgery token fetched from `/_layout/tokenhtml`. Use raw `fetch` — do **not** route through an OData wrapper that injects Dataverse-specific headers.

```ts
async function getCsrfToken(): Promise<string> {
  const res = await fetch('/_layout/tokenhtml');
  const html = await res.text();
  const match = html.match(/value="([^"]+)"/);
  if (!match) throw new Error('CSRF token not found');
  return match[1];
}
```

Send on every summarization request:

| Header | Search Summary | Data Summarization |
|--------|----------------|--------------------|
| `Content-Type` | `application/x-www-form-urlencoded` | `application/json; charset=utf-8` |
| `Accept` | `application/json` | `application/json` |
| `__RequestVerificationToken` | CSRF token from `/_layout/tokenhtml` | CSRF token from `/_layout/tokenhtml` |
| `X-Requested-With` | `XMLHttpRequest` (recommended — matches `shell.ajaxSafePost`) | `XMLHttpRequest` (recommended — matches `shell.ajaxSafePost`) |
| `OData-MaxVersion` | — | `4.0` |
| `OData-Version` | — | `4.0` |

The CSRF token is explicitly required by the Data Summarization docs. Neither summarization page
documents `X-Requested-With`, but it's part of the `shell.ajaxSafePost` behaviour that Microsoft's
own case-page sample relies on — include it for consistency with stock Power Pages calls.

If a `getCsrfToken` helper already exists elsewhere in the site (for example from `/add-cloud-flow` or an earlier `/add-ai-webapi` run), **reuse it** — do not create a duplicate.

---

## Function-naming convention

| API | Service function | React hook |
|-----|------------------|------------|
| Search summary | `fetchSearchSummary(userQuery: string)` | `useSearchSummary()` |
| Data summarization | `fetchDataSummary(entitySetName: string, recordId: string, options?: DataSummaryOptions)` | `useDataSummary(entitySet, id, options?)` |
| Data summarization (Microsoft-shipped support-case wrapper, optional) | `fetchCaseSummary(caseId: string)` | `useCaseSummary(caseId)` |

`DataSummaryOptions` shape:

```ts
interface DataSummaryOptions {
  select?: string;       // $select — comma-separated root columns
  expand?: string;       // $expand — nav property(ies) with optional nested $select/$filter/$orderby
  filter?: string;       // $filter — rare on the root entity, but supported (all Web API read ops apply)
  orderby?: string;      // $orderby — same caveat
  instructionIdentifier?: string;  // Set ONE of these two:
  recommendationConfig?: string;   //   identifier on first call, config on follow-up
}
```

For other frameworks (Vue composable, Angular service, Astro util) follow the same name stems, with the framework's idiomatic wrapper.

---

## Docs quirks (as of the Microsoft Learn pages fetched 2026-04-17)

Three places in the upstream docs are confusing or typo'd. Don't get tripped up by them:

1. **Search-summary "Example: Request" block is jQuery syntax, not an HTTP body.** The Search
   Summary page shows:

   ```
   POST https://contoso.powerappsportals.com/_api/search/v1.0/summary
   {
           data: { userQuery: "Fix problems with slow coffee dispense" }
   }
   ```

   That block is not a literal JSON request body — it's jQuery-style parameters leaking into the
   "HTTP request" formatting. The authoritative shape is the JavaScript sample immediately below it,
   which uses `contentType: "application/x-www-form-urlencoded"` and `data: { userQuery: "..." }`.
   On the wire, the body is `userQuery=Fix+problems+with+slow+coffee+dispense`.

2. **`"Citations'"` with a stray apostrophe in the response sample.** The docs' sample response
   literally prints:

   ```
   "Citations'":{
                 "[1]": " https://contoso.powerappsportals.com /knowledgebase/article/KA-01055",
   }
   ```

   The apostrophe and the leading space inside the URL are typos. Real responses return the field
   as `Citations` (no apostrophe) and the URL values have no leading whitespace.

3. **`X-Requested-With: XMLHttpRequest` is not documented but matches stock behaviour.** Neither
   the Search Summary nor the Data Summarization pages list `X-Requested-With`. The Microsoft-shipped
   case-page Copilot snippet uses `shell.ajaxSafePost`, which injects it automatically. The skill
   sets it for consistency with every other Power Pages call; the post-Skill validator warns (but
   does not block) if it's missing.

## Instruction-identifier naming

Use the convention `Summarization/prompt/<table>_instruction_identifier_<usecase>` for maker-defined prompts (e.g. `Summarization/prompt/product_instruction_identifier_overview`, `Summarization/prompt/order_instruction_identifier_timeline`). The case-page preset uses the shorter canonical name `Summarization/prompt/case_summary` — keep it exactly as Microsoft ships it.
