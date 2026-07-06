# ALM Documentation Grounding (Phase 1.5)

Power Platform ALM (solutions, pipelines, host environments) is documented on Microsoft Learn and the docs evolve — new component types, changed API signatures, expanded splitting guidance. **Never rely on hardcoded URLs or stale schema knowledge.** Always search Microsoft Learn dynamically at the start of each ALM skill run so the agent grounds itself in what's currently true.

This reference is shared by `setup-solution`, `export-solution`, `import-solution`, `diagnose-deployment`, `setup-pipeline`, `deploy-pipeline`, and `ensure-pipelines-host`. Each SKILL.md invokes a Phase 1.5 step that points here.

## Anchor docs

| Domain | Canonical Microsoft Learn entry point |
|---|---|
| Solutions (concepts, lifecycle, components, managed vs unmanaged) | `https://learn.microsoft.com/en-us/power-platform/alm/solution-concepts-alm` |
| Power Platform Pipelines (host setup, stages, deployments, approvals) | `https://learn.microsoft.com/en-us/power-platform/alm/pipelines` |

These pages each link out to a constellation of sister pages — pick whichever sister pages match the current skill's scope.

## Discovery strategy (Phase 1.5)

Cap the grounding step at ~30 seconds total. Don't let it block the rest of the skill run on Microsoft Learn outages — if the search or fetch errors out, log a one-line note and continue.

### Step 1: Search

Call `mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search` once with a skill-specific query (see the per-skill table below). Capture the top 5 results.

### Step 2: Collect unique URLs

Extract `contentUrl` values from results. Keep pages that match:

- `learn.microsoft.com/.../power-platform/alm/*`
- `learn.microsoft.com/.../power-pages/configure/*-alm` or `*solution*` or `*pipeline*`
- `learn.microsoft.com/.../power-apps/maker/data-platform/solution*`
- `learn.microsoft.com/.../power-apps/developer/data-platform/*solution*`

Discard release-plan announcements, blog posts, and unrelated configuration pages.

### Step 3: Fetch the canonical page(s)

Fetch the anchor doc for the skill's domain (table below) plus up to 1 sister page that matches the current scope. Use parallel `mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch` calls so the wall-clock cost stays low.

### Step 4: Summarize for the agent

Output a one-paragraph summary noting:
- Anything that changed since the last skill run (breaking field renames, new component types, deprecated actions)
- Any new pages discovered that aren't in the per-skill known-pages table
- Whether the current skill's hardcoded patterns (e.g., HAR-confirmed payloads in `cicd-pipeline-patterns.md` / `solution-api-patterns.md`) are still in line with what the docs say

If the search results reveal a new pattern the skill should adopt, surface it as a soft suggestion in the agent's next prompt — don't change behavior silently.

## Per-skill query templates

| Skill | Phase 1.5 query (passed to `microsoft_docs_search`) | Anchor doc to fetch |
|---|---|---|
| `setup-solution` | `Power Pages solution publisher creation Dataverse component types ALM` | `solution-concepts-alm` |
| `export-solution` | `Power Pages solution export managed unmanaged ExportSolutionAsync ALM` | `solution-concepts-alm` |
| `import-solution` | `Power Pages solution import staging missing dependencies ImportSolutionAsync ALM` | `solution-concepts-alm` |
| `diagnose-deployment` | `Power Pages deployment errors solution import troubleshooting` | `solution-concepts-alm` |
| `setup-pipeline` | `Power Platform Pipelines setup OData API host environment deploymentenvironments` | `pipelines` |
| `deploy-pipeline` | `Power Platform Pipelines stage run validation ValidatePackageAsync DeployPackageAsync approval` | `pipelines` |
| `ensure-pipelines-host` | `Power Platform Pipelines host environment Platform Host Custom Host` | `pipelines` |

## What this is NOT

- **Not a replacement for the HAR-confirmed reference docs.** `references/cicd-pipeline-patterns.md` and `references/solution-api-patterns.md` capture exact request bodies that have been verified against live Dataverse + BAP responses. Those stay authoritative for *what to send*. Microsoft Learn grounding is for *what's currently documented* — the two should agree, but when they diverge the HAR-confirmed pattern wins until the divergence is investigated.
- **Not a per-component fetch.** Don't fetch a page for each component the skill creates. One search + one anchor fetch + at most one sister page per skill run.
- **Not blocking.** If MCP server is down or the search returns nothing relevant, log a note and proceed. ALM skills must remain runnable offline.

## Phase 1.5 block to paste into a skill

Each skill's SKILL.md should embed a phase block like this (substitute the per-skill query and anchor doc):

```markdown
### Phase 1.5 — Ground in current ALM documentation

> Reference: `${PLUGIN_ROOT}/references/alm-docs-grounding.md`

Cap this step at ~30 seconds. If MCP search / fetch errors out, log a one-line note and continue — this skill must remain runnable offline.

1. Run `microsoft_docs_search` with the query: `<skill-specific query from the reference>`.
2. Fetch the canonical anchor page (`<anchor URL>`) and at most one sister page that matches the current scope, in parallel via `microsoft_docs_fetch`.
3. Extract a one-paragraph summary of what the docs say today — flag any breaking changes vs. the HAR-confirmed patterns in `${PLUGIN_ROOT}/references/<solution-api-patterns | cicd-pipeline-patterns>.md`.
4. Use the summary to inform Phase 2+ decisions. Do not silently change skill behavior — surface any divergence to the user as a soft warning.
```
