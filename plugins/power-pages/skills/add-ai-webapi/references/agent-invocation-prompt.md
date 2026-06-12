# Phase 5.1 ai-webapi-integration agent invocation prompt template

The orchestrator (`/add-ai-webapi` Phase 5) invokes the `ai-webapi-integration` agent once
per target — the first call sequentially (it establishes the shared summarization service
file + CSRF helper), then the remaining targets sequentially per `AGENTS.md`.

This file holds the **prompt template** the orchestrator passes via `Task`. Replace every
`<…>` placeholder with the concrete value for the current target before sending; the agent
does not interpret placeholders, so sending the literal text `<single-record | list>` will
confuse it.

---

## Prompt body (template)

> "Integrate the **<API name>** for the Power Pages SPA site.
>
> - APIs to wire: <one of: `search`, `data`>
> - Target file: <absolute or project-relative path to the page/component to wire>
> - Target kind: <one of: `single-record`, `list`, `n/a (search)`> — from the Phase 2
>   manifest. `list` means use `fetchListSummary` + the collection-endpoint URL form (see
>   agent §2.1); `single-record` means use `fetchDataSummary` + the record-endpoint URL
>   form.
> - Trigger mode (list targets only, from Phase 3 follow-up): <one of: `auto-on-mount`,
>   `manual-button`>. Set the wrapper's initial trigger accordingly. Omit for
>   single-record targets (always auto on a user action).
> - Framework: <React | Vue | Angular | Astro>
> - Project root: <absolute path>
> - If data: table logical name `<logical_name>`, entity set `<entity_set_name>`,
>   `$select=<columns>`, `$expand=<NavProp($select=...)>` (omit for search),
>   `InstructionIdentifier` `Summarization/prompt/<identifier>`. For the support-case
>   scenario, use the Microsoft-shipped recipe: `incident` / `incidents` /
>   `$select=description,title` /
>   `$expand=incident_adx_portalcomments($select=description)` /
>   `Summarization/prompt/case_summary`.
> - For `list` targets — Scope for the summary call (resolved by the orchestrator from
>   Phase 2 + Phase 3; the agent uses these values verbatim and does NOT re-derive from
>   the existing fetch):
>   - `$filter`: `<exact filter value to use on the summary URL, or \"none\">`
>   - `$orderby`: `<exact value, typically mirrors the existing fetch>`
>   - Scope source: `<one of: \"mirror-existing-fetch\" | \"user-verbal-scope\" |
>     \"user-custom-odata\" | \"no-filter\" | \"both\" (dual summary)>`
>   - Target's existing list fetch (for reference, may be `none`):
>     `<verbatim URL + any Prefer header>` — the agent MUST leave this fetch in place
>     unchanged; the summary is an ADDITION, not a replacement.
>   - Regardless of scope source: the new summary URL must NOT include `$top` and must
>     NOT set `Prefer: odata.maxpagesize`. Those belong to the UI's paginated fetch only.
>     Pagination is UI behaviour; the server-side cap is
>     `Summarization/Data/ContentSizeLimit`.
> - `$expand` navigation property casing (data/list targets with `$expand` only): each
>   nav property name verbatim as it appears in Dataverse metadata's
>   `ReferencedEntityNavigationPropertyName` — do not auto-lowercase. If unknown, the
>   agent must query
>   `EntityDefinitions(LogicalName='<primary>')/ManyToOneRelationships` (or
>   `/OneToManyRelationships`) before building the URL. See agent §2.2.
> - Existing CSRF helper: <path + export name, or `none — define inline`>
> - Existing summarization service: <path, or `none — create new`>. If present, grep the
>   file for `normalizeSummaryString`, `postSummary`, `fetchListSummary`,
>   `buildSummaryQuery` — reuse any that already exist rather than redeclaring.
> - Placeholder POSTs to replace at this target (from Phase 2 Explore): <list each as
>   `path:line — body`, or write `none` if Phase 2 didn't flag any in this file>
>
> Create or extend the summarization service with raw `fetch`, both required headers, and
> the framework-idiomatic wrapper. Wire the call into the target file with
> loading/error/empty/recommendation handling. If a placeholder POST was flagged for this
> file, **replace it in place** rather than adding a second fetch. Do NOT create a second
> `getCsrfToken` if one already exists.
>
> Return value: structured file-modification list per the agent's "Return value" section
> so the orchestrator can stage commits and assemble the final summary."

---

## Why these fields are passed verbatim

`Target kind`, `$filter`, `$orderby`, and `Scope source` are decided by the orchestrator
during Phase 2 (existing-fetch capture + classification) and Phase 3 (per-target
follow-ups). The agent applies them verbatim — re-deriving scope from the existing fetch
or the user's verbal request risks contradicting a decision the orchestrator already made
with the user.

The `Target's existing list fetch` field is **reference only**. The agent does not modify
or replace the existing fetch; the summary URL is a parallel addition.
