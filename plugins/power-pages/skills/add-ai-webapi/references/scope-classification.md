# Phase 3 follow-up questions — list trigger and scope confirmation

After the user confirms which APIs / targets to integrate (Phase 3 main question), the
orchestrator asks per-target follow-ups for:

- **List-trigger choice** — every confirmed list target (one question per list target).
- **Scope confirmation** — every target Phase 2 flagged `scope-extends-beyond-existing-fetch`,
  `needs-definition`, or `intent-mismatch`. The question text varies by target kind and
  classification.

Skip both follow-ups when the corresponding flag isn't set on the row.

Each chosen value flows into Phase 5's agent-invocation prompt — the Phase 5 agent does NOT
re-derive scope from the existing fetch. The original UI fetch on the target component stays
in place unchanged regardless of what scope the summary uses.

---

## List-trigger follow-up (one per list target)

For every confirmed target whose page renders a **collection** of records (filename matches
`*List*`, `*History*`, `*Results*`, or the target component iterates a server-returned array
in the UI), ask:

| Question | Header | Options |
|----------|--------|---------|
| Should the summary appear automatically when the page opens, or only when the user clicks a button? | Trigger | Load the summary when the page opens (Recommended when the list is short and the extra API call won't slow the page noticeably), Load only when the user clicks a button (Recommended when the list is large or filters change frequently) |

Single-record summary targets (any record-detail page, including the support-case detail
page) skip this question — single-record summaries always trigger on a user action.

Both options produce the same hook/composable surface (`refresh`,
`summariseWithRecommendation`); only the initial state of the wrapper differs. Record the
choice per target and pass it to the `ai-webapi-integration` agent in Phase 5 so it wires
the correct initial trigger.

---

## Scope-confirmation follow-up

Ask only when Phase 2 flagged the target with one of these classifications. The question
text varies by target kind and classification.

### LIST target — `scope-extends-beyond-existing-fetch`

User qualifier detected; existing list fetch has a different or no `$filter`.

| Question | Header | Options |
|----------|--------|---------|
| You asked for a summary of `<user qualifier>` `<entity>`. The existing list on this page currently shows `<existing scope description>`. Which scope should the summary cover? | Scope | Use my scope — `$filter=<filter derived from the verbal qualifier>` (Recommended), Mirror the existing list — `$filter=<existing $filter or "none">`, Let me write the OData `$filter`, Both — create two summary cards (advanced) |

### LIST target — `needs-definition`

Target page has no existing list fetch.

| Question | Header | Options |
|----------|--------|---------|
| The target page has no existing list to mirror. Which rows should the summary cover? | Scope | Use my scope — `$filter=<filter derived from the verbal qualifier>` (Recommended), Summarise all `<entity>` rows the signed-in user can see (no filter beyond row-level security), Let me write the OData `$filter` |

### SINGLE-RECORD target — `scope-extends-beyond-existing-fetch`

User mentions facets / related records not in the existing record fetch — e.g., "include its
line items" when the fetch has no `$expand`.

| Question | Header | Options |
|----------|--------|---------|
| Your request mentions `<user qualifier>` — this isn't in the existing record fetch (which selects `<existing $select>`). Which facets should the summary include? | Facets | Include the mentioned facets — `$select=<baseline>,<added columns>`, `$expand=<added expansions with nav-prop casing>` (Recommended), Use the existing fetch's columns only (no additions), Let me write the `$select`/`$expand` |

Translate the qualifier to concrete columns / expansions using the datamodel manifest — e.g.,
"include its line items" on `cr363_order` with a related `cr363_orderlineitem` table via a
`cr363_Order_LineItems` navigation property maps to
`$expand=cr363_Order_LineItems($select=<lineitem primary name + amount>)`. Show the proposed
value inside the option. **Any new `$expand` target becomes a new Phase 4 prerequisite** (Web
API enabled + parent-scope permission on the child table) — re-evaluate the Phase 2
delegation decision after the user picks.

### Any target — `intent-mismatch`

Filename heuristic and the user's verbal intent disagree on target kind (filename says
single-record, request says "my open cases" → list; or vice versa).

| Question | Header | Options |
|----------|--------|---------|
| The target page is `<filename>` (looks like `<filename-classification>`). Your request mentions `<user-verbal-qualifier>` — that sounds more like a `<other-classification>`. Which do you want? | Target kind | `<user-verbal-classification>` — <describe what the summary would cover> (Recommended — matches your ask), `<filename-classification>` — <describe the alternative>, Both — wire two summary cards on the same page |

Resolve `intent-mismatch` **before** any scope-confirmation question — the chosen target
kind decides which scope question (LIST or SINGLE-RECORD form) to ask next.

---

## Handling the chosen values to Phase 5

Phase 5's `ai-webapi-integration` agent-invocation prompt has a structured **Scope for the
summary call** block. Populate:

- `$filter` — the exact filter string (or `none`).
- `$orderby` — typically mirrors the existing fetch.
- `Scope source` — one of `mirror-existing-fetch`, `user-verbal-scope`,
  `user-custom-odata`, `no-filter`, `both` (for the dual-summary advanced option).
- `Target's existing list fetch` — for reference only, never as an override target.

The agent applies these verbatim and does not re-read the existing fetch.
