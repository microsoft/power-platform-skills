# Phase 2 Explore-agent prompt — AI integration discovery

Use this prompt verbatim when invoking the Explore agent (`Task` with
`subagent_type: "Explore"`, thoroughness `medium`) during the `add-ai-webapi` skill's
Phase 2.

The agent's job is to find every candidate site for the two summarization APIs (Search
Summary, Data Summarization), classify them, capture each target's existing fetch and any
ambiguity that needs Phase 3 disambiguation, and report the prerequisite status of every
table in scope.

---

## Prompt body (copy verbatim)

> "Analyse this Power Pages SPA site for generative-AI summarization integration opportunities.
> Report the following as structured sections:
>
> **Reserved slot markers (check this first).** Grep the `src/` tree for the comment pattern
> `POWERPAGES:AI-SLOT`. Sites scaffolded by `/create-site` with AI picks in Phase 3 carry these
> markers at the intended insertion point — for example
> `{/* POWERPAGES:AI-SLOT kind=data-summarization */}` in a JSX detail page, or
> `<!-- POWERPAGES:AI-SLOT kind=search-summary -->` in a Vue/Angular/Astro search page.
> Recognised `kind=` values: `search-summary`, `data-summarization`. For every match, report:
>
> - File path and line number of the marker
> - `kind=` value (tells you which API variant the maker already picked)
> - The containing component/page name
>
> These markers are **authoritative placement hints** — when a marker exists for a given target,
> use its file + line as the insertion point and skip the filename heuristic below for that target.
> A marker also tells you that the maker has already committed to adding this AI surface, so treat
> it as high-confidence in the manifest (don't ask 'should we add an AI summary here?' — they
> already decided). Flag the manifest row with `source: marker` so Phase 5 knows the location is
> pre-decided and the agent should remove the marker comment when it inserts the generated code.
>
> If a marker's `kind` doesn't match any natural target page (e.g., a `kind=data-summarization`
> marker on a search results page that has no record-detail context), flag as `orphan-marker` and
> surface it in Phase 3 for the user to resolve — either move the marker or drop the pick. Do not
> silently ignore orphans.
>
> **Search summary candidates.** Find any search page/component (filenames matching `Search*`, or
> components that call `/_api/search/v1.0/query`). Note the file path and whether it currently
> calls `/_api/search/v1.0/summary`. (Note: `*Results*` alone is ambiguous — a file named
> `SearchResults.tsx` is a search-summary target, but `WorkOrderResults.tsx` iterating a Dataverse
> collection is a list-summary target. Classify by what the component fetches, not just the name.)
>
> **Related-record discovery candidates.** Additionally, flag any detail page whose content would
> benefit from surfacing related records via Search Summary — e.g. \"suggested KB articles\" on a
> case/incident page, \"similar cases\" on a ticket page, \"related products\" on a product page.
> These are not necessarily named `Search*`; look for intent signals in component/page names and
> comments (`suggested`, `related`, `similar`, `recommended`, `KB`, `knowledge base`). Search
> Summary's grounded retrieval is often a better fit for this than a hand-rolled OData match
> because it returns AI-ranked citations from across the site's knowledge index. Report each as
> `<page> — recommended Search Summary candidate (related-record discovery)`.
>
> **Data summarization candidates.** For each Dataverse table in `.datamodel-manifest.json`, find
> components that display records from that table. Note the file path, the table logical name, the
> entity set name (plural), the lookup/expand relationships, and whether the component already
> calls `/_api/summarization/data/v1.0/`. Also flag any placeholder posts that already use
> `InstructionIdentifier` in a body like
> `{ \"InstructionIdentifier\": \"Summarization/prompt/<table>_instruction_identifier_<usecase>\" }` —
> these are explicit TODOs for this skill to implement.
>
> **Classify each data-summarization candidate as `single-record` or `list`** using:
>
> - `single-record` — filename contains `Detail`, `View`, or `Edit`; the component reads a record
>   id from the route (e.g. `useParams()`, `route.params.id`, `?id=<guid>` in the URL) and fetches
>   one record.
> - `list` — filename contains `List`, `History`, `Overview`, `Dashboard`, or the component
>   iterates a server-returned collection (maps over an array of records). Be cautious with
>   `Results` — a page that renders search hits is a search-summary target; a page that iterates a
>   Dataverse collection is a list-summary target. Classify by what the component actually fetches.
>
> This classification drives URL shape (record vs collection form), prompt pattern (narrative vs
> tabular-insight), and default `ContentSizeLimit` downstream. Include it as a column in the
> manifest below.
>
> **Also check for target-kind / user-intent mismatch.** If the filename heuristic says
> `single-record` but the user's verbal request implies a list (plural nouns — \"cases\",
> \"orders\"; scope qualifier — \"all open\", \"my\"; cross-record phrase — \"for this customer's
> history\"), OR vice versa, classify as `intent-mismatch` and flag for Phase 3 disambiguation.
> Do NOT silently pick one interpretation over the other — the target page kind and the user's
> ask can legitimately disagree (e.g., a CaseDetail page where the user wants a summary of the
> customer's other open cases, not this case).
>
> **For every data-summarization candidate (list OR single-record), also capture the existing
> fetch's OData query**: the exact `$select`, `$expand`, `$filter` (list only), and `$orderby`
> (list only) values the component already sends, plus any `Prefer` header. If the target page
> has **no** existing fetch (e.g., a Dashboard or landing page the user wants to decorate with a
> summary card), record `existing fetch: none`.
>
> **Classify the scope** for each candidate by comparing the user's verbal request
> (`$ARGUMENTS`) to the existing fetch. For list targets the scope dimension is `$filter` (which
> rows); for single-record targets the scope dimension is `$select`/`$expand` (which facets of
> the one record). Parse the request for scope qualifiers:
>
> - **List scope qualifiers:** `open`, `overdue`, `recent`, `active`, `pending`, `my`, `all`,
>   date ranges, named statuses.
> - **Single-record scope qualifiers:** \"including its <related-table>\", \"with its <facet>\",
>   \"covering <aspect>\" — signals the user wants the summary to include columns or expansions
>   beyond the existing record fetch. E.g., \"summary including line items\" on an order-detail
>   page where the existing fetch doesn't expand `cr363_Order_LineItems`.
>
> Classifications (applies to BOTH list and single-record):
>
> - `matches-existing-fetch` — the request is generic (\"add a summary of this record\",
>   \"summarize this list\"). Phase 5 uses the existing fetch's scope verbatim without asking.
> - `scope-extends-beyond-existing-fetch` — the request mentions columns / expansions / filters
>   not in the existing fetch. Phase 3 will ask a scope-confirmation question — do NOT invent
>   additions in the manifest.
> - `needs-definition` — the target page has no existing fetch at all. Phase 3 will ask.
> - `intent-mismatch` — the filename heuristic and user's verbal intent disagree on target kind
>   (e.g., filename says single-record but the request says \"my open cases\" = list). Phase 3
>   will ask a target-kind disambiguation question first.
>
> Record the classification plus any detected qualifier as extra fields on the manifest row
> (e.g., `existing fetch: $select=title,description; no $expand. User qualifier: \"with its
> line items\". Scope: scope-extends-beyond-existing-fetch`).
>
> **Existing infrastructure.** Report (a) whether a CSRF helper already exists — grep for
> `_layout/tokenhtml` and `getCsrfToken` — and where it lives; (b) whether
> `src/shared/powerPagesApi.ts` exists (from a prior `/integrate-webapi` run); (c) whether
> `src/services/aiSummaryService.*` already exists from a prior run.
>
> **Layer 1/2 status.** For every Data Summarization target plus every `$expand` target, report
> a single status: does `Webapi/<table>/enabled` exist, does `Webapi/<table>/fields` exist, and
> does at least one table permission with `read: true` exist? Report per target as one of:
> `ready` (all three present), `missing` (any of the three absent). For Search Summary targets,
> report `n/a (search has no per-table prereqs)`.
>
> **Fields-list breadth (advisory).** For every Data Summarization target whose Layer 1/2 status
> is `ready`, also report whether the existing `Webapi/<table>/fields` includes any of:
> (a) the primary key column (`<prefix>_<table>id`); (b) lookup write forms (e.g.
> `cr4fc_categoryid` without the matching `_cr4fc_categoryid_value` read form); (c) columns the
> AI surface won't read. Mark these targets `fields-broader-than-ai-mode` so Phase 3 can surface
> the gap to the user — they can choose to narrow now or accept the broader posture.
>
> **Layer 3 status.** For every Data Summarization target, report whether `Summarization/Data/Enable`
> and the specific `Summarization/prompt/<id>` identifier the code will send exist in
> `.powerpages-site/site-settings/`. For Search Summary targets, report
> `n/a (search uses the Copilot workspace toggle, not a per-call site setting)` — do not flag
> them as `missing`, otherwise the skill will spuriously invoke `ai-webapi-settings-architect`
> for a search-only run."

---

## Manifest shape (compile from the agent's output)

The orchestrator compiles a row per candidate. The `Source` column records whether a row came
from a reserved marker or from heuristic discovery — marker-sourced rows skip Phase 3's
"should we add this?" question.

| # | API | Target file | Target kind | Entity Set | `$select` / `$expand` | Source | Layer 1/2 status | Layer 3 status |
|---|-----|-------------|-------------|-----------|----------------------|--------|------------------|----------------|
| 1 | Search summary | `src/pages/SearchResults.tsx` | n/a | — | — | marker | n/a (search needs no per-table prereqs) | n/a (search uses workspace toggle, no per-setting toggle) |
| 2 | Data summarization | `src/pages/CaseDetail.tsx` | single-record | `incidents` | `$select=description,title&$expand=incident_adx_portalcomments($select=description)` | marker | missing | missing (`Summarization/prompt/case_summary` not present) |
| 3 | Data summarization | `src/pages/ProductDetail.tsx` | single-record | `cr4fc_products` | `$select=cr4fc_name,cr4fc_description` | heuristic | missing | missing (`Summarization/Data/Enable` + prompt identifier not present) |
| 4 | Data summarization | `src/pages/WorkOrderList.tsx` | list | `cr363_workorders` | `$select=cr363_name,cr363_status,cr363_priority&$orderby=createdon desc&$count=true` | heuristic | missing | missing (`Summarization/Data/Enable` + prompt identifier not present; `Summarization/Data/ContentSizeLimit=200000` recommended) |

(Row 2's `$select` / `$expand` / prompt identifier is the Microsoft-shipped support-case
recipe — it appears here because the user picked it explicitly via `/create-site` (the
`POWERPAGES:AI-SLOT` marker), not because the skill auto-detected an `incident` table.)

## Delegation decisions

Compute directly from the two status columns above:

- **Run `/integrate-webapi`?** → True if any row's Layer 1/2 status is `missing`.
- **Run `ai-webapi-settings-architect`?** → True if any row's Layer 3 status is `missing`.

When you delegate to `/integrate-webapi`, send only the **missing** rows in the `tables=`
sentinel value — not the rows whose Layer 1/2 is already `ready`. The sub-skill is being
asked to fill gaps, not re-audit settled tables.

When `fields-broader-than-ai-mode` rows exist, surface them in Phase 3's plan presentation as
a "broader-than-needed" advisory — separate from the Phase 4 delegation decision so the user
can decide whether to narrow.
