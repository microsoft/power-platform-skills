# AGENTS.md — Model Apps Plugin

This file provides guidance to AI Agents when working with the **model-apps** plugin.

## What This Plugin Is

A plugin for building Power Apps for **model-driven apps**. Two **authoring** skills do the work
(plus `/report-issue` and `/telemetry` — four user-invocable skills in total):

- **`/genpage`** — build and deploy standalone **generative pages** (genux): React 17 + TypeScript +
  Fluent UI V9 single-file components, deployed via PAC CLI. Orchestrates specialist agents (planner,
  optional entity builder, parallel page builders).
- **`/app-builder`** — build and edit a **whole model-driven app** (tables, columns,
  relationships, adaptive forms, views, charts, generative pages, app + sitemap, sample data, and
  admin-gated AI features) from a natural-language intent, via the vendored headless `cds-maker-sdk`.

**The two authoring skills are independent entry points — neither requires the other.** Use `/genpage`
to add pages to an app that already exists; use `/app-builder` to build or edit a whole app.
`/app-builder` does *reuse* `genpage-page-builder` to generate its page `.tsx` (Phase 1.5), but that
is an implementation detail of code generation, not a dependency: `/genpage` never invokes
`/app-builder`, and `/app-builder` never invokes the `/genpage` skill. They install together (the
marketplace copies the whole plugin directory), but **either can be invoked without the other, and
neither leaves state the other depends on**. Keep it that way — shared **agents and libraries** are
fine, a skill-to-skill call is not, and neither may write a file the other treats as authoritative
(this is why `write-page-plan.js` emits `app-builder-page-plan.md`, not `genpage-plan.md`).

Plus **`/report-issue`** to file bugs against this repo. Dataverse mutation flows through the
shared, vendored SDK (`scripts/vendor/cds-maker-sdk.cjs`) — see `## Building & Testing` — except for
the few surfaces it does not model, which use `dataverseRequest()` (see `## Dataverse Access From
Scripts`).

**Requirements:**
- **PAC CLI > 2.10.0** — for app and generative-page deploy operations (incl. the genpage `upload` connector/Custom API flags)
- **Azure CLI (`az`)** — Dataverse Web API auth (SDK + entity builder); must be logged in with the
  same identity as the active `pac` profile

No Dataverse Skills plugin or Python dependency.

## Documentation Map

Keep these in sync — **update the relevant doc(s) in the same PR as the change** (a reviewer should be
able to tell what moved from the docs alone):

| Doc | What it holds | Update when… |
|-----|---------------|--------------|
| `AGENTS.md` (this file — `CLAUDE.md` symlinks to it) | Per-component behavioral specs, the canonical file tree, conventions, build/test | You add/rename a script, change a component's behavior, or change how to build/test |
| [`docs/architecture.md`](docs/architecture.md) | Wiring / flow **diagrams** for both skills (`/genpage` + `/app-builder`) | You change the orchestration, phase pipeline, or how the pieces connect |
| [`docs/app-builder-capabilities.md`](docs/app-builder-capabilities.md) | `/app-builder` **capabilities** — what ships today, with the evidence for each | You ship an app-builder capability |
| [`docs/app-builder-design.md`](docs/app-builder-design.md) | `/app-builder` **design record** — Part I staged-flow architecture (**cited from code by section number — never renumber**), Part II the `--changed-only` contract | You change the staged flow or the partial-apply contract |
| [`CHANGELOG.md`](CHANGELOG.md) | Keep-a-Changelog — concise bullets (detail lives in PRs/docs) | Any user-visible change |
| [`references/app-spec-schema.md`](references/app-spec-schema.md) | The App Spec contract (always-present fields) | You change the App Spec shape or validation |
| [`references/app-spec-schema-advanced.md`](references/app-spec-schema-advanced.md) | The conditional App Spec fields (business rules, BPFs, commands, web resources, global choices, dashboards, roleGrants) — split out so the always-read contract stays small | You change one of those features |

Don't duplicate content across these — **cross-link instead** (a second copy only drifts, as the file
tree and teardown order both did before).

**Issue references belong in history and in code, never in use-the-plugin reference material.**
`references/*.md` and `skills/*/SKILL.md` are loaded verbatim into an agent's context so it can
*author a spec*. A tracker link there costs tokens, cannot be dereferenced by the reader it is shown
to, and goes stale while the doc lives on — so state the rule and the **why**, and stop. The test is
simple: if deleting the link loses nothing operational, it was provenance, not explanation.

Provenance is welcome in the *other* class of doc — the material that explains **why the code is the
way it is** rather than how to use it: this file, `CHANGELOG.md`, and code comments, where the
repo-root `AGENTS.md` actively asks for one. Its reader is a contributor who can open the link and
act on it. Prefer the bare id (`AB#6686428`, `#537`) over a full URL even there: it carries the same
provenance, costs less, and cannot rot.

A corollary for **error messages**: an error must stand alone. `operator 'X' is not usable — see
<issue url>` sends an author to a tracker to find out what they did wrong; say what is wrong instead.

**This repo is public.** Before adding to any of these docs, re-read the repo-root `AGENTS.md` →
*"This Repo Is PUBLIC"*. The docs here have already had to be scrubbed once for internal repo paths,
a real Dataverse environment name, review provenance, and indexes into documents an outside reader
cannot open. Record that kind of context in the PR conversation instead.

## app-builder — intent → model-driven app

A second skill (`/app-builder`) builds a whole **model-driven app** (tables, columns,
relationships, adaptive forms with sub-grids, views, Choice-column charts, app module +
sitemap) from a natural-language intent — distinct from `/genpage`, which builds generative
*pages*. The **whole flow runs in the main conversation loop, never a `Task` subagent** — subagents
are headless, so `AskUserQuestion` and plan mode cannot reach the user. **This applies to `/genpage`
too**: its agents are headless discovery/generation workers, and an agent that needs a decision
returns a `needs_input` request for the main loop to ask (`references/agent-interaction-contract.md`).
`scripts/validate-agent-interactivity.js` fails the build if any `plugins/model-apps/agents/*.md`
declares an interactive tool — the frontmatter is prose to every other test, which is how `/genpage`
Phase 1 specified an unreachable interactive flow for ~2.5 months. The same validator also fails a
**one-sided tool declaration**: tool names are host-specific and every host silently ignores a name
it does not recognize, so a capability named only in one scheme is absent on the other host and the
agent launches without it. `TaskCreate`/`TaskUpdate`/`TaskList` are the live example — no published
alias table lists them, so `todo` must be declared alongside. Both skills also support **unattended
runs** (Copilot autopilot / Claude auto-accept) via
`scripts/resolve-interaction-mode.js`; suppressing a prompt never authorizes destructive work.
For the end-to-end flow,
stage→phase mapping and page-identity model, see
[`docs/architecture.md`](docs/architecture.md) → `## /app-builder — build pipeline`; that doc owns
the pipeline and delegates each script's **behavioral spec** to the entries below.

- **`references/authoring-flow.md`** — the Phase-1 authoring playbook the skill executes itself:
  validate prereqs, select the env via PAC (`pac auth list` / `pac org who`), detect existing
  tables/apps, author the **App Spec** in confirmed levels (**(a0) personas & jobs-to-be-done
  first** — they drive which tables and surfaces exist — then data model, then forms/views/charts +
  page-intents + sample data, then access), run the `spec-lint.js` guardrail, get plan-mode approval.
  Writes `app-spec.json` (the machine contract) + `model-app-plan.md` (rendered by
  `scripts/write-app-spec-doc.js`, never hand-written).
  **Artifact naming:** both skills derive their working directory from a slug off the user's
  request, so they can land on the SAME folder and file names are a namespace. A file written by
  BOTH is unprefixed (`workflow-log.md`); a file owned by ONE is prefixed with it
  (`genpage-plan.md`, `genpage-entity-creation-log.md`, `app-builder-page-plan.md`). A name chosen
  to prevent confusion must not *contain* the name it guards against — see
  `scripts/write-page-plan.js` for why the app-builder page plan is not `genpage-*`.
- **`scripts/lib/spec-lint.js`** — pure App Spec guardrail (`lintAppSpec → { ok, errors,
  warnings }`): errors block the plan gate (e.g. the relationship-name-vs-lookup-name
  collision Dataverse rejects), warnings teach.
- **`scripts/lib/app-source-path.js`** — shared resolver for page `codeFile` and web-resource
  `contentPath` reads/uploads and hashing. Validation/lint share its lexical rule; the resolver
  requires a relative, regular file inside the canonical app folder and refuses source symlinks
  and junctions. Source-file checks report rejected paths rather than silently skipping them.
- **`scripts/lint-app-spec.js`** — the CLI surface for both gates, for a headless author or a CI
  job (#560). Runs `migrateAppSpec` → `validateAppSpec` (what the build runs on load) → `lintAppSpec`
  (guardrails the builder does **not** run), and exits non-zero on errors (`--strict` also fails on
  warnings). Prefer it over calling the library through `node -e`: linting the file **as written**
  rather than the migrated shape is what let a spec pass the lint and then fail the build (#545).
  `--profile` defaults to **`plan`**, not `deploy`, because the authoring flow runs this while pages
  are still intents — a deploy default rejects a normal work-in-progress spec. `plan` relaxes only
  that rule. Gate a final, deployable spec with `--profile deploy`.
- **`scripts/build-model-app.js` → `scripts/lib/sdk-build.js`** — the deterministic, **idempotent**
  build engine, run after approval. Runs in two engine invocations (staged flow): (1) `--stage data
  --apply` materializes tables + columns + relationships (solution·data-model only; sample-data
  deferred) so `generate-types` can emit `RuntimeTypes.ts`; (2) a full `--apply` build (re-discovers
  the data model, then ui · app · publish) finalizes everything idempotently. `--stage
  <data|ui|app|publish>` selects phases by stage name; **apply-safe only for `data`** — the full
  build (run 2) is always a complete idempotent run. Discovers existing tables/columns/relationships via the SDK
  (`findTables`/`findColumns`/`fetchEntityMetadata`) and creates only what's missing
  (`createSolution`/`createTable`/`createColumn`/`createRelationship`), seeds sample data via
  `seedRecordGraph` (SDK-owned parent-bind + resolve-by-name idempotency), enriches default
  Active/Inactive views via `enrichDefaultViews`, then
  `createWebResource` for form JS, then builds each artifact through the SDK's **generic mutation
  surface** (`createArtifact`+`addElement`/`updateElement`/`removeElement`+`pushArtifact`) driven by the
  pure **`scripts/lib/artifact-intent.js`** compiler: a form is a minimal `createArtifact` plus a coarse
  `addElement` of each authored tab (sub-grids/quick-views are canonical control cells; form JS is the
  root-bag `/bag/c` `<events>` region), a view is `updateElement('/columns')`, an app is
  `updateElement('/siteMap')`, a dashboard tile is `addElement('/components')`. Form reconcile adds the
  spec's fields and — for an author-controlled **explicit** layout — prunes fields it dropped (never the
  primary) via `findFieldCellPointer`+`removeElement`, keyed by a declared semantic identity so a rebuild
  never duplicates a control. A row that a pruned or moved cell leaves holding nothing is removed too
  (`strandedRows` in `lib/form-occupancy.js`, shared by the prune pass and both move paths). A row that
  a row-spanning cell above still reserves is kept, and so is a row that was already empty.
  Explicit layouts converge **tab/section order**, not existing-field order. Newly created listed
  fields and `fieldOptions[x].after` share a copied occupancy-checked plan, committed as one artifact
  edit so an interrupted split cannot persist duplicated cells. Anchors run in dependency order
  after new-field insertion; remaining unsatisfied requests are warned in `skipped.layout`.
  Existing fields are not list-reordered. Verify checks form-wide cell/control ID uniqueness,
  including auto forms, but not field order or anchor adjacency. See the
  [form-layout contract](references/app-spec-schema.md).
  **Which form a table opens with** (AB#6736948, `lib/form-order.js`) is decided by the table's Main
  Form Set order — each Main form's formxml `<DisplayConditions Order>` — not by `systemform.isdefault`
  (measured: moving the flag reorders nothing, and a table's three new forms, all at the same order,
  were served with the `isdefault` form last). After every form exists, the forms phase promotes the default (an explicit
  `isDefault` or `entities[].mainFormOrder[0]` on any table; the first Main form only on a table the
  spec owns) and then writes Order 0..n-1 onto the spec's Main forms, the ones it does not list keeping
  their stored relative order. On a table it orders nothing on, a Main form it creates is created after the
  table's others: its order is written into the new form's own `<DisplayConditions>` before the first
  push (`createInPlace`), so no interrupted run or later failure can leave it at the Order 0 every new
  form gets — a later build could not tell it is new. Only declared forms are written, order-only through `setFormSecurityRoles` so roles
  survive; a table ordered by hand (`securityRoles.order`) is left alone; the step is best-effort (✗ and
  a warning, never a halt). Verify checks the stored order (`form-order`) and what the public
  `RetrieveFilteredForms` serves the user running it (`form-order-served`). On `build --apply`, the destructive preflight writes `.maker-workspace/destructive-approval.json`
  when it refuses form-field or sitemap removals, and also when an approved destructive run starts so
  retries and later failures stay bound to that gate-time list — an empty list included, when the run
  includes the removal phases. A later `--allow-destructive` run may
  remove only that recorded set; the record is consumed only after a successful run that included both
  removal phases (`forms` and `app-shell`) and kept no field, and is otherwise kept on failure, partial
  runs, changed-only runs, or when the fence kept a field. An approved run consumes or rewrites only a record it
  found at its start or wrote itself (each record carries its run id, compared by content fingerprint),
  checked and changed under the workspace lease the apply snapshot uses, so two builds sharing a
  workspace cannot consume each other's record. A refusal still replaces the record with the list it
  just showed, because that is the list the maker is looking at, and a halt naming new removals refreshes
  it with the full current list (the halt shows only the new ones). An approved
  run halts before any write if the record
  changed after it was read, or if the lease stays held. The gate fails closed if the record is
  unreadable or if discovery fails while a record exists, because live removals cannot be compared with
  the approved list. If live state contains a new removal, the build halts, lists only that new removal,
  refreshes the record, and the engine keeps any field or sitemap target that appears during the run
  rather than pruning beyond the preflight-approved set. Every push routes through `requireSuccessfulPush` (a 412 version conflict
  halts the build for a fresh download instead of silently dropping the edit) — so new, existing, and mixed
  envs all work. The data model is **complete** (all column types, global choices, status reasons,
  alternate keys, N:N). It also builds **quick-create/quick-view forms** (`formType`) with **quick-view
  placement** (`forms[].quickViews[]` — embed a QuickView form via a lookup), **modern command-bar
  buttons** (`commands[]` — functional JS on-click + static hidden/disabled, incl. **flyout/split-button
  menus** via `type`+`children[]`), and **dashboards** (`dashboards[]` — chart/list/iframe/webresource
  tiles) with **sitemap placement** (a `dashboard` subarea auto-pins the dashboard as an app component).
  It also builds **business process flows** (`businessProcessFlows[]` — the staged process bar on a
  record): a `workflows` row of category 4 / type 1 / businessprocesstype 0 whose XAML the SDK compiles
  from ordered `stages[]`/`steps[]`, activated in the same push. The phase is additive
  discover-reconcile keyed on `(entity, name)` like `business-rules` — it creates what is missing and
  converges only Active/Draft **state**, never stage structure — and `bpfFilter` scopes every query in
  build/verify/teardown to the DEFINITION row, excluding both the platform's activated `type 2` copy and
  same-named TASK flows (also category 4). v1 is deliberately single-entity and linear: cross-entity
  stages, branching and stage actions are **rejected at the spec gate** rather than silently dropped,
  because the build cannot yet verify them. `securityRoles` was rejected alongside them and is now
  **supported** (`{ "personas": [...] }`): a BPF's role grants are `create/read/write/delete` privileges
  on the backing table that ACTIVATION creates, so they are applied in the **`security` phase**, after
  both the flow and the personas' roles exist — persona lookup there is **case-insensitive**, since a
  persona is a display name the author repeats by hand across two sections of the spec, and the target
  table is the flow's **deployed `uniquename` read back** from the workflow row rather than derived
  from its display name (a flow authored in Maker, or renamed later, keeps an unrelated unique name). There is no
  `everyone`/`fallbackForm`/`order`: those are `forms[].securityRoles` concepts written into formxml,
  and a privilege has no such equivalent. The rejection is an
  **allow-list at flow, stage AND step level**, because the SDK's normalizers copy a fixed key set and
  discard the rest — so a `branch` written on a stage (where the SDK actually models it), or the very
  plausible `fieldLogicalName` instead of `field` on a step, would otherwise validate clean and deploy
  as if it had never been written. Two further platform facts the validator encodes: a flow's **name
  must be unique across the whole spec**, because the SDK derives `uniquename` as
  `new_<name lowercased, non-alphanumerics stripped>` — **ignoring the table** — and activation creates
  a backing table with that name; and a stage must carry **at least one step**, because the SDK
  substitutes a placeholder step named "New Step" for an empty one (its own `stage-needs-step` rule
  never fires, as the placeholder is injected before it looks).
  Following a **genpage-first policy**, overview/dashboard/analytics surfaces are authored as **generative
  pages** (`pages[]`) rather than classic dashboards — the build's `pages` phase uses a **three-authority
  model**: IDENTITY (durable `<app>_pagemanifest`, outranked by a downloaded spec's `pages[].pageId`),
  EXISTENCE (env-wide `pac model genpage list` — crash-safe create-vs-reuse via `enumerateEnv`), and
  MEMBERSHIP (the app's sitemap `GenPageId` set, read fail-closed via `fetchSitemap` in
  `scripts/lib/sitemap-pages.js` — drives placement, download enumeration, and verify; a read failure
  HALTs). All page matching is by id. Every `pages[]` entry must be sitemap-placed (validation rejects
  headless pages) — because the sitemap is download's ONLY membership oracle, so a page reached only
  by `navigatesTo` is invisible to download and gets re-created as a duplicate on the next build.
  The corollary is that a detail page is reachable from the nav with **no input**, so a page
  declaring `pageInput` must also declare **`directEntry`** (`selector` | `emptyState`) saying what
  that renders; `page-plan` passes it to the generator and the page manifest carries it through
  download. Every `pageInput.data` key must also be produced by an incoming `navigatesTo[].data`
  edge. See `references/app-spec-schema.md` → *the input contract*.
  The build halts on safety violations (`pages-removed`, `pages-shared-across-apps`,
  identity conflicts, read failures). The cross-app shared-page scan (`fetchAppsForPages`) enumerates every app via the vendored SDK's
  `@odata.nextLink` pagination (`queryRecords({ paginate:true })`), so it verifies EVERY app in the
  environment rather than one 5000-row page; a pagination fault (the SDK's repeated-nextLink guard) still
  fails **closed** rather than scanning a partial list. Classic `dashboards[]` are opt-in.
  **All of the build's Dataverse access is via the SDK** (see "Dataverse Access From Scripts" for the
  sanctioned exceptions elsewhere), so metadata is persisted under
  `<app-folder>/.maker-workspace/` for reuse/edits. The 16 phases
  (`solution·data-model·sample-data·web-resources·views·charts·forms·business-rules·business-process-flows·commands·dashboards·app-shell·pages·ai-features·security·publish`)
  are unchanged; independent ops run with bounded parallelism.
  Off-sitemap ids require a local CREATE receipt for this app/key/id plus an exact decoded stored-name
  match, including when the spec and remote manifest agree. Otherwise `unproven-manifest-id` causes
  `pages-identity-conflict`, never a replacement CREATE. Names corroborate identity, never establish it.
  `scripts/lib/page-ownership-records.js` writes receipts immediately after an acknowledged create,
  before remote manifest persistence or sitemap placement. Version-2 records bind the target's
  normalized HTTPS origin with a SHA-256 fingerprint, never a stored environment URL. This is the only
  receipt format. Unknown versions, malformed data and unreadable files halt with the record's full
  path and recovery guidance, never an empty ownership set. Foreign fingerprints grant no authority
  and are never consumed for another target. Baselines, downloads and journals are not receipts.
  Business-rule reuse keeps additional same-name definitions; after a push every extra id not returned
  by the SDK is kept and reported as not attributable to this run. A rejected AI summary
  exposes no created-model id to this caller, so same-name AI models are reported and kept.
  Emits `[n/total]` events the orchestrator narrates + a `BuildHalt` it gates on. Dry-run by
  default; `--apply` writes, `--sample-data` / `--publish` opt-in (`--publish` gates the final *bulk*
  publish; edit/finalize paths — reconciling an existing form/view, form events, quick-views,
  existing-app sitemap, page finalize — still publish their one artifact so the change takes effect).
  The bulk publish is ONE `PublishXml` envelope (`publishArtifacts`) for every table and the app, and
  with `--publish` the default-view enrichment defers its own publish to it. A build that halts before
  it hands what is still owed to the CLI, which keeps each attempt's debt across transient retries until
  a publish phase pays it, and settles the rest per target once no retry follows (`settleOwedPublishes`)
  — so a halted build leaves those views live, as it did before the batching. A default-view push
  refused by a concurrent edit fails the enrichment step, as any refused push does.
  **The modern ("new look") shell is opt-in via `app.newLook`.** It is a per-app SETTING
  (`NewLookAlwaysOn`, written through the SDK's `saveSettingValue` scoped to app + solution), NOT an
  app-module column — `navigationtype` is Single/Multi *session* and unrelated, which is the reason
  this looked unavailable for a long time. Best-effort: the feature rolls out by tenant, so a failure
  warns and records `created.newLook: false` rather than failing an otherwise-good build or reporting
  a silent success.
  **`app.aiDescription` (the routing description) is written only when the spec sets it** — at create,
  and on an existing app when it differs from the fetched draft, riding that run's app push. The
  platform may author this text itself, so an omitted field is never written or blanked. A
  never-published app refuses the write (`APP_DRAFT_HEADER_NOT_WRITABLE`), which halts with
  `app-header-unpublished` — publish, then re-run — after resetting the workspace copy, which a plain
  re-fetch would otherwise refuse to replace (`LOCAL_EDITS_WOULD_BE_LOST`). An app with an UNPUBLISHED
  header change takes it: the vendored SDK conditions the header write on the appmodule's row token, so
  the push saves and keeps that change (live-verified). A 412 is a concurrent edit, on the appmodule
  row as on the sitemap, and is never re-explained as "publish first". Any
  other failed push that carried the change resets the copy too — except a concurrent edit
  (`VERSION_CONFLICT` / a code-less 412), where the unrecorded copy is what stops a blind re-run — and
  without the pages phase the change is applied only after the live-page gate, so a gate halt leaves
  nothing behind; a page-backed app's standalone header push refuses a copy still holding an earlier
  run's unpushed edits (`app-copy-unpushed-edits`) rather than replay them.
  **An existing app's sitemap is rewritten ONTO its live nodes (AB#6726727).** The App Spec describes a
  node's label/title, target and icons only, and the SDK serializes a node without its fetched `bag` from
  scratch (new `Id`, `ResourceId="SitemapDesigner.NewSubArea"`, broad `Client`/`Sku`,
  `AvailableOffline="true"`). Both existing-app writers (the app-shell write and the pages finalizer)
  therefore pass appDef's tree through `adoptLiveSitemap` (`scripts/lib/sitemap-merge.js`) first: a
  subarea corresponds by navigation target (a URL keeps the case of its path and query), an area or
  group by a label its level uses once, then by the navigation entries it holds, then by the id an
  earlier build gave it (a node none of these identifies is written as new rather than guessed); the
  live `id` and `bag` are kept, and only
  what the spec sets is overlaid — chrome it does not name is still removed, as before. Because the SDK
  only patches an existing `<Titles>` on a node with a bag, and reads an empty title as "no edit", a
  title added to an entry that had none, or removed from one, is reconciled in the adopted bag at the
  SDK's language (other languages' titles are kept). Every dashboard entry carries exactly
  `Url="/workplace/home_dashboards.aspx"` — the designer writes it on every dashboard entry and
  recognizes one only by the whole Url, and the runtime keys the dashboard glyph on it with a
  case-sensitive match — and verify fails an entry without it (`subarea-dashboard-launcher`, which
  reads only real nav entries — a `SubArea` directly under `SiteMap/Area/Group`, never one in a comment
  or elsewhere — as the kept-icon check below does). With a
  **baseline** — `.maker-workspace/last-applied.json`, written atomically by a successful apply and
  by download, stamped with its environment and app (`scripts/lib/deployed-baseline.js`) — a nav entry's
  title/icon that the spec has not changed since, but the designer has, is kept and reported rather
  than reverted (`keepsLiveValue`); without one the spec wins and every change to an existing entry is
  reported. Baseline entries are lined up with live ones by the ids the baseline RECORDED for its
  environment (`__deployedIds`: what the apply resolved, or what the download read), never by the
  spec's own `dashboardId`/`pageId`, which may be another environment's. Verify accepts a kept icon by
  the same rule and identities, and only on a live entry that exists. A downloaded dashboard carries
  `dashboards[].dashboardId`, which build, verify and teardown resolve before the name
  (`findPinnedDashboard`) — when it resolves it is the only candidate, and teardown still requires
  solution membership — so a dashboard renamed in the designer is reused, with a warning since a build
  never renames one, instead of a second being created under the stale name.
  **DATA-MODEL Dataverse labels are stamped with the ORGANIZATION's base language, not a hardcoded
  1033.** `resolveLanguageCode` (`scripts/lib/entity-provision.js`) reads `organization.languagecode`
  once per build and threads it into every label-emitting SDK call in that phase (tables, columns,
  customer columns, global choices, status reasons, alternate keys, relationships); precedence is
  `--language-code` → App Spec `languageCode` → the org's base language → 1033. Without this, an org
  that has not provisioned 1033 fails the data-model phase with `The language code 1033 is not a valid
  language for this organization`
  (#447) — and confusingly only on
  *some* column types, because (observed 2026-08) Dataverse tolerates an unprovisioned LCID on
  `EntityMetadata` and `PicklistAttributeMetadata` but rejects it on `DateTime`/`Memo`. Every fallback
  to 1033 warns, as does an explicitly supplied LCID that had to be discarded.
  An **explicitly supplied** LCID is additionally checked against `RetrieveProvisionedLanguages`
  (`readProvisionedLanguages`, `scripts/lib/dataverse-auth.js`, injected as `deps.provisionedLanguages`)
  and halts the data-model phase before any write if the org does not have it — because of the
  split behaviour above, the alternative is a table created with silently-wrong labels followed by a
  failure on the first `DateTime`/`Memo` column. Only *explicit* overrides are probed; the org's base
  language is provisioned by definition. The probe is best-effort — an unreachable or non-2xx
  `RetrieveProvisionedLanguages` resolves to `null` ("unknown") and the build proceeds unchanged, so
  the diagnostic can never itself break a build. Note
  `updateTable(logical, { quickCreateEnabled })` deliberately passes no language: it only builds a
  Label when a `displayName`/`pluralName`/`description` is supplied, and otherwise round-trips
  Dataverse's own labels under `MSCRM.MergeLabels`.
  **Scope — this now extends to the `forms`, `dashboards` and `app-shell` phases too.** Those go
  through the vendored SDK's artifact serializers, which used to hardcode `1033` into FormXML
  (`<label languagecode="1033">`), SiteMap XML (`<Title LCID="1033">`) and dashboard XML with **no
  caller override** (#455). The SDK
  now takes the authoring LCID as a **construction-time** option (`MakerSdkOptions.languageCode`),
  which is why `main()` resolves the language over the transport hatch (`resolveAuthoringLanguage`,
  `scripts/lib/entity-provision.js`) **before** calling `makeSdk`, and passes the identical value on
  as `opts.preResolvedLanguageCode` so the data-model phase cannot resolve a different one. Both SDK
  instances get the same LCID deliberately: `pushArtifact` refuses a push whose stored artifact
  language disagrees with the SDK performing it (`ARTIFACT_LANGUAGE_MISMATCH`, for registrations
  marked `languageSensitive` — App, Form, Dashboard). Passing nothing preserves the SDK's own 1033
  default exactly, so the option is opt-in rather than a silent re-labelling.
  **One language per BUILD, and there is no per-table override.** Because the LCID is resolved once
  and is a construction-time SDK option, a second language would need a second SDK instance — and
  multi-language labelling is blocked a layer lower anyway, since the SDK's label serializer emits a
  one-element `LocalizedLabels` array by design. `entities[].languageCode` and
  `entities[].localizedLabels` are therefore **rejected by validation**
  (#537) rather than accepted and
  dropped: `entities[]` had no allow-list, so both validated clean and were silently ignored, and an
  author asking for one table in a second language got a successful build with the request gone. Any
  unknown table key now fails the same way (see `ENTITY_KEYS`, `scripts/lib/app-spec.js`). Note that
  `references/localization.md` is about generated **page** code, not Dataverse labels.
  Note the SDK deliberately does **not** language-parameterize BusinessRule: its mapper's language
  parameter is the *environment base* language, a different concept.
  **`languageCode` is the language for a PLAIN label, not the only language available.** An
  author-facing name (`entities[].displayName`/`pluralName`, `primaryAttribute.displayName`,
  `columns[].displayName`, `alternateKeys[].displayName`, `relationships[].lookup.displayName`,
  and an **inline** Choice option on `columns[].options[]`) may instead be a **map keyed by LCID**,
  which the SDK's label serializer turns into a multi-entry `LocalizedLabels` array
  (AB#6686428 / #537). ⚠ **`globalChoices[]` is the exception and is REJECTED, not supported** —
  neither its `displayName` nor its `options[]` may be localized, because Dataverse accepts the
  multi-language payload for a global option set and stores only the base language (measured, even
  through a raw `POST` that bypasses the SDK). Listing it here as localizable sent authors into a
  validation error; use an inline Choice on the column when option labels must be localized. The plugin
  passes a supported value through **unflattened** — flattening it here would silently restore the
  English-only behaviour while validation and the design doc still claimed two languages. Everything
  that RENDERS or DERIVES FROM a label must go through `labelText()` (never string-interpolate a
  label), and anything that resolves an author's reference BY label text must go through
  `labelAliases()` so a reference written in any provisioned language matches. Both live in
  `app-spec.js`; `references/localization.md` is about generated **page** code, a separate concern.
  Guarded by `scripts/tests/lcid-real-bundle.test.js`, which drives the REAL vendored bundle — a mock
  would keep passing against a bundle that ignored the option.
  `--verify` (opt-in) auto-runs the read-only reconcile after a successful apply and exits non-zero on a silent partial build (the same
  check `verify-model-app.js` runs standalone). Recovery from a halted build is a full rerun (idempotent).
  **`--changed-only`** (Preview, off by default) is a fail-closed SAFE partial apply: after a FRESH
  `--apply --changed-only` baseline, a later `--apply --changed-only` for a page `.tsx` byte edit runs ONLY
  the pages phase (uploads just the changed page, skips the full build) — gated on an identity-bound
  snapshot (`.maker-workspace/apply-snapshot.json`); any non-page edit (or an edit to a pre-existing app)
  falls back to a full build. Teardown tombstones+deletes the snapshot. See
  [`docs/app-builder-design.md`](docs/app-builder-design.md) for the v1 scope + contract.
  **App TABLE components are pinned by OData REFERENCE** (ADO 6612527). The SDK sends
  `{ '@odata.id': '<EntitySetName>(<MetadataId>)' }` per sitemap table, NOT an `@odata.type` instance:
  `Microsoft.Dynamics.CRM.entity` names a real Dataverse table (metadata-as-data), so the old instance
  payload pinned the `entity` TABLE and every app exported as
  `<AppModuleComponent type="1" schemaName="entity" />`. The **set segment** decides the resulting
  `objectid`; an unknown set 400s, so a typo cannot silently pin the wrong table. The reference form is
  also the ONLY one that can express an abstract EDM table (`activitypointer`, `principal`), which an
  instance payload rejects outright. Three consequences the build depends on: ONE bad component fails
  the WHOLE `AddAppComponents` call (zero rows), so an unresolvable table **HALTS** the build naming it
  rather than shipping an app whose nav points at content it lacks; `AddAppComponents` does NOT
  de-duplicate (N components → N rows); and because a 204 says only that the request was *accepted*,
  the SDK **reads the components back** and asserts each declared table has a `componenttype: 1` row
  carrying that table's MetadataId, failing closed on an inconclusive read. That last point is the
  general rule this bug taught: **assert what you PRODUCED, not what you intended** — "some table
  component exists" was true of the corrupt apps too, and `ValidateApp` reported success on them.
  Pinned by `scripts/tests/app-entity-components-real-bundle.test.js`.
  **Hidden table membership is explicit via `app.tables`** (AB#6603388), not inferred from
  `entities[]`. `scripts/lib/app-components.js` is the one home for component inventory, pin/proof
  and layer reads. It resolves `MetadataId,EntitySetName` before any app write, pins only missing
  tables right after app identity exists on both create and reuse, then re-resolves the CURRENT
  layer and proves the rows. An SDK create already publishes, so a fresh app's new pins are
  published again even without `--publish`; an existing app's normal finalizer/publish includes
  them. Dropping a table from the list never unpins it.
  **`app.mainForms` is a name-based Main-form allow-list for sitemap Entity tables.** Names resolve
  after forms exist, within `(table, Main, normalized name)`; a same-named QuickView does not reject
  a stock Main. Even a known `forms[].formId` must pass the active Main catalog's name-ambiguity
  check before any app write; a created/reused id counts once if metadata has not caught up.
  Every app push carries the SDK's `components.mainFormsByTable`, after every fetch,
  and excludes conflicting explicit Main pins by ID. Create is exact; update adds only listed forms
  and never removes old ones. SDK extras are surfaced by name with the Maker remedy, and verify
  fails them. This does not set a default/order/security roles. Measured: changing membership after
  first publish did not reach the runtime list within 89 minutes; remembered forms are per table.
  Both fields require a `minimumPluginVersion` floor of at least `2.13.0` (lint advisory;
  download-emitted). `app-main-forms-real-bundle.test.js` proves the serialized create excludes a
  disallowed Main ID and the SDK refuses an explicit conflicting pin.
  `--verify` now asserts the same membership INDEPENDENTLY of the write path: it resolves the app's
  PUBLISHED `componenttype: 1` rows and fails, by table name, when a sitemap table or `app.tables`
  reference is not among them,
  fails closed when that list cannot be read, and reports any leftover `entity` placeholder row. The
  SDK's read-back only covers what a build intended to pin, so an app that drifted afterwards (or was
  edited elsewhere) still verified clean — the sitemap named the table and the table existed, which
  was all verify checked.
  The same rule binds **tests and evals**, with a distinction that is easy to get backwards:
  an EXPECTATION must come from the CONTRACT, independent of the code under test, while the FIXTURE
  that stands in for the environment should be generated from the builder's real output so it cannot
  drift from what ships. `smoke-eval.js` got both wrong at once: it asserted a `VectorIcon` the
  builder deliberately drops, and its unit test hand-wrote sitemap XML containing that value — so the
  offline suite stayed green while every live run failed. Deriving the expectation from `appDef`
  instead is the opposite failure and is just as bad: when the builder stops emitting a value, a
  derived "must be present" check silently becomes "must be absent" and still passes, leaving the
  eval unable to contradict the very code it exists to check. Assertions are therefore fixed by
  contract, the offline fixture is rendered from `appDef`, and `vendor-sdk-smoke.test.js` checks the
  bytes the real vendored SDK serializes.
- **`scripts/teardown-model-app.js` → `scripts/lib/sdk-teardown.js`** — the first-class, **classifier-safe**
  teardown (reverse of the build), for cleaning up live-verification probes or a failed build. Deletes
  exactly the artifacts a given App Spec declares, in dependency-safe order (**app module → proven generative pages → security
  roles → dashboards → command bars → business rules → business process flows → forms → charts → views
  → reset enriched default views to drop
  parent lookups → relationships → AI row summaries → tables [reverse-topological, children-first] →
  web resources (generated app icon + page manifest + declared) → global choices → solution**). Forms/charts/views/relationships
  are deleted **explicitly before tables** (a table delete does not reliably cascade cross-references; it
  does remove the table's own columns). A business rule and a business process flow are `workflows` rows
  bound to the entity, so they too are deleted before their table — and each is **deactivated first**,
  because Dataverse refuses to delete an activated process. Deleting an activated BPF is also what
  removes the org-owned **backing table** the platform creates on activation. **Web resources are deleted after tables**: a table's vector/raster
  **icon** web resource is referenced by the table itself, so Dataverse refuses to delete it until the table
  is gone (form JS, referenced by its already-deleted form, is safe either way). Teardown also removes the
  build's **generated default app icon** (`<appUnique>_icon`, created in-solution when the spec sets no
  `app.icon`) so it doesn't leak as an orphan. It keeps the **page manifest** while the generative-pages
  step fails (a failed manifest or page read fails that step too), so a re-run still finds the pages the
  app's manifest lists. Before deleting the app, it resolves page candidates, their stored names
  and this app's sitemap. Only navigation members or corroborated local creation receipts authorize
  deletion; names alone do not. Navigation is either layer: the published sitemap, and the saved but
  unpublished one when the published layer leaves a page unproven (`navigationProof`, the layer a download reads);
  when that saved layer cannot be read and a page stays unproven, the app is left intact for a re-run. The BUILD
  binds a page by its published navigation or a receipt only, because its shared-page scan reads other apps'
  published navigation; a page only in the saved layer halts with advice to publish the app first. The verified ownership set is persisted locally before app deletion,
  so a page-less retry still has proof after the app is gone. Unreadable proof or a failed record write
  leaves the app intact. Proven pages still undeleted, including dependency-blocked pages, keep the
  manifest, solution and local teardown record and make the run fail. Records are consumed only for
  completed deletions or confirmed absence. Form-only page references are not scanned.
  **An app is TWO rows** — an `appmodule` AND a `sitemaps`
  row, with no lookup between them and no server-side cascade; the only link is
  `sitemap.sitemapnameunique === appmodule.uniquename`. Deleting only the appmodule strands the sitemap
  forever and, because `sitemapnameunique` is unique-constrained, permanently **burns that unique name**:
  a later build of an app with the same name fails with *"The name &lt;x&gt; is already in use by an
  existing site map"*, which the maker cannot act on. `deleteAppCascade` therefore resolves the sitemap
  BEFORE deleting the app, deletes both rows in **one atomic OData `$batch`**, and **fails closed** — any
  delete it cannot prove is rejected rather than guessed. Each row's delete is conditioned on its
  **row** token from a by-id read, not the unpublished-aware read's content token, which runs ahead
  of the row while a sitemap edit is unpublished (that made such an app impossible to tear down —
  412 every time). This is why
  **`scripts/lib/sdk-http-client.js` must implement `postRaw`**: the SDK will not fall back to two
  sequential deletes, so a transport without it fails every teardown with `APP_DELETE_NOT_ATOMIC` (see
  that file for the wire contract, why a `$batch` is sent once unless its answer proves nothing in it
  ran — a SQL deadlock or a 429 — and why a conditional write that gets no answer is never re-sent).
  Pinned by
  `scripts/tests/app-delete-real-bundle.test.js` against the real bundle — every other teardown test
  drives a mock and would stay green through a regression here.
  The empty solution container goes last — but a **built-in
  system solution** (`Active`/`Default`/`Basic`) is **skipped** (Dataverse 400s any delete of a restricted
  solution), so a downloaded spec whose real solution could not be recovered (and defaulted to `Default`)
  still tears down cleanly instead of erroring. It is also **kept while any earlier step failed**:
  dashboards are found by name, and the app's own are the ones its solution holds (a built-in container
  holds every dashboard, so with no real solution teardown deletes none), which makes the solution the
  only proof a re-run has — deleted after a failure, the retry kept the app's dashboards for good. A
  membership read that fails is itself a failed step, never a skip or a not-found (as either, the
  solution was deleted right after it). Command teardown
  removes the whole command bar for an entity the spec authored commands on (the SDK models a command bar
  per entity, not per button). Every id is resolved from a spec-declared name/logical/uniquename via an
  exact-match OData filter, so it can never wildcard-scan an org. **Dry-run by default** (`--apply`
  writes); dry-run lists every page candidate by id and stored name without writes, marking absent
  rows as "not found" with their manifest names only.
  Best-effort continue (a failed step is recorded, teardown proceeds). A not-found (already-gone)
  error is treated as deleted, the table delete's **not-found-on-success** is tolerated (`tolerateNotFound`),
  and system/managed artifacts that cannot be deleted are recorded as `skipped` rather than failing.
  `--clear-workspace` prunes `.maker-workspace/` after a clean apply (not while another teardown of it
  still holds the changed-only fence). It also refuses while any unconsumed ownership records remain,
  including another app/environment. The refusal names each file and explains that teardown retires it
  on deletion or confirmed absence; a record for a page confirmed gone can be removed by hand.
  The path-safety guard remains generic;
  ownership checks run before isolation and before recursive removal. A record arriving during isolation
  keeps that isolated folder and reports how to resume from it. `planTeardown(spec)` is pure (dry-run +
  unit-test surface); reuses `appUniqueName`/`commandsByEntity`/`topoOrderEntities` from the build engine (DRY).
- **`scripts/download-model-app.js` → `scripts/lib/hydrate-spec.js`** — the **edit flow**: pulls a
  server-current app back into an editable App Spec + page code, including saved unpublished
  Maker changes (sitemap → `appShell` with icons, **every**
  generative page via `pac model genpage download`, referenced entities/tables, icon web resources,
  dashboards, solution). It reads through a throwaway SDK workspace, never the folder's
  `.maker-workspace` — a copy an interrupted build left there made the download fail, or describe edits
  that were never saved to Dataverse — and writes only the baseline (`last-applied.json`) into it.
  The fetched SDK navigation must agree with the selected current XML's full target multiset:
  entities, generative pages, URLs, dashboards and custom pages, including repeated shortcuts.
  A missing SDK sitemap or a mismatch is refused with publish-then-download guidance, never emitted
  as hidden-table membership or lost Main restrictions. The immutable name is recovered from the
  fetched `uniqueName`/`uniquename` before manifest/prefix lookup; an unresolved identity is refused.
  **Round-trip scope (be precise — do not claim "complete"):** tables, sitemap/appShell, generative pages,
  classic dashboards, icons, and solution round-trip; **forms, views, charts, and commands do NOT yet
  round-trip.** (View hydration was tried and reverted — LIVE-verified that the deployed savedquery set
  can't reliably tell app-builder-authored views from Dataverse's auto-generated Active/Inactive/QuickFind
  system views: `isdefault` is TRUE on the authored primary view and FALSE on the system Inactive view, so
  no filter isolates author views. Charts/commands need structured reads the SDK doesn't expose. FORMS are
  a deliberate refusal rather than a missing capability: the SDK does expose `formTypes` on its form
  listing, but the App Spec form shape cannot express everything a deployed `formxml` carries — header/
  footer, business-process control, related-entity nav, control parameters, event libraries — and a LOSSY
  form declared in the spec is *worse* than an absent one, because a rebuild into a fresh environment
  recreates it having silently lost those controls while reporting success.)
  All four survive on the live app (a rebuild into the SAME environment preserves them), but are absent
  from the downloaded spec, so edit them in Maker or a fresh spec.
  **The omission is reported, not silent** (AB#6686423): every deployed form/view/chart is listed in the
  spec's `descriptionInventory`, and each run prints a note naming the counts, the tables and the
  artifacts, plus a `notRoundTripped` block on the JSON result. It is a NOTE, never a gate — every app
  has forms and views, so failing the download would break every download, and the omission is not
  destructive in the environment the app came from. Do not "fix" this by reconstructing `forms[]`
  without also solving the lossy-layout problem above.
  **Table membership also comes from type-1 components**, in addition to the sitemap and the app's
  VIEW / CHART / FORM owners. Hidden type-1 members emit sorted `app.tables`; custom hidden tables
  hydrate into `entities[]` only when `IsCustomEntity === true`. A non-custom or unclassified hidden
  type-1 member remains a reference even when a view/chart/form also references it; unknown status
  gets a classification loss note, never schema-authoring instructions. Tables found
  ONLY through view/chart/form components keep their prior hydration behavior.
  Corrupt `entity` placeholder rows and deleted/unresolvable metadata IDs are
  omitted with named not-round-tripped notes, not silently treated as valid tables.
  **Measured: hidden-table pinning works, and layers matter** (AB#6603388). Adding a hidden `task`
  with `{ '@odata.id': 'tasks(<MetadataId>)' }` returned 204 and created a new unpublished layer
  (`componentstate: 1`, new `appmoduleidunique`) containing it. The plain published app row still
  pointed at the old layer without it; after app `PublishXml`, the published row carried the new
  layer and table. The earlier “204 but no row before/after publish” note read the wrong layer.
  Never cache `appmoduleidunique` across a write/publish: build proof reads
  `RetrieveUnpublishedMultiple` (one row, or the single unpublished row when several). Download uses
  that same CURRENT layer for navigation, table inventory and Main membership because the vendored
  SDK fetch reads the current app/sitemap; verify describes the PUBLISHED layer.
  An `entities[]` entry alone still does not request membership.
  **Main membership round-trips separately from form layout.** Download emits `app.mainForms` for a
  non-empty strict active Main subset with unambiguous names. Inactive/unclassifiable pins are named
  in `notRoundTripped.appMembership`, preserving an encodable active restriction even when those
  extra pins cannot be authored. It shares the component inventory with description capture.
  Both membership fields raise `minimumPluginVersion` to `2.13.0`, retaining a higher authored floor.
  Component reads remain best-effort with explicit loss notes rather than failing the download.
  Each schema-hydrated entity's **`primaryAttribute` comes from
  real Dataverse metadata** (`primaryNameAttribute`) and is **never synthesized**. The old
  `<entity>_name` guess was wrong for most OOB tables (`account` → `name`,
  `contact` → `fullname`) while looking plausible on custom ones, which is why it went unnoticed.
  Because validation *requires* `primaryAttribute`, a table without one cannot simply be emitted: a
  **sitemap** table missing it FAILS the download (actionable — the user asked for that table), while a
  **schema-hydrated component-only** table missing it is dropped with a warning (it arrived via a best-effort read and
  was absent from the spec entirely before this change, so aborting over it would regress a previously
  working download with no override flag). A membership-only stock table never needs this read;
  its `app.tables` reference survives even when it has no primary-name column.
  The **solution** is recovered as the app's one *real* unmanaged solution — `recoverAppSolution` enumerates
  the app's solution memberships and excludes the built-in `Active`/`Default`/`Basic` system solutions the
  app is also a member of (see `scripts/lib/system-solutions.js`), so the downloaded spec can cleanly tear
  down its own solution instead of targeting the restricted `Default`. Its **publisher prefix is read from
  that solution's owning publisher** via the SDK's `getSolution` — NOT inferred from the app's uniquename,
  which is silent-wrong whenever the app name doesn't encode the publisher (an app named
  `new_customermanagement` inside publisher `contoso`, an app with no prefix, or a prefix longer than the
  guess assumed all collapsed to a literal `new`). The app-derived value remains the fallback, and
  `prefixResolved` is true for BOTH trusted sources — it gates the icon own-vs-foreign classification, so
  a downgrade there silently stops custom nav icons from round-tripping. Recovered **tables are flagged
  `existing: true`**, so a teardown of a downloaded spec never deletes a table (+ its data) this build
  cannot prove it created — download can't distinguish app-created from merely-referenced tables, so it
  fails safe (an orphaned table is recoverable; deleted customer data is not). The **same flag is set on
  every recovered relationship and global choice** and teardown honours it for all three (#587 item 6):
  deleting a relationship strips its lookup column off a retained table, and an option set is org-wide.
  An app in **several unmanaged solutions** is never resolved to one of them (#587 item 9): Dataverse
  has no "owning" solution, a rebuild adds to the spec's solution and teardown deletes it, and the
  app-name heuristic is the unreliable guess above. The spec keeps `Default` (never torn down), the
  download names the candidates in `solutionCandidates` and scopes its inventory by all of them, and
  keeps a publisher prefix only when every candidate's publisher agrees. A membership that cannot be
  read is reported as such — business rules and solution-owned global choices become "unknown" —
  rather than read as "no solution".
  Edit the downloaded spec and re-run the build (idempotent) — create and edit share one path. Always
  pull fresh at the start of an edit session (the build reads an etag; a write against an artifact
  changed in Maker throws a version conflict → re-pull, never clobber). **Classic DashBoard subareas
  round-trip** too — `readDashboards` reconstructs each into `dashboards[]` with **id-passthrough tiles**
  (every tile carries the deployed view/chart ids), so a rebuild recreates the dashboard against the
  existing views/charts without re-declaring them (genpage/entity/URL subareas round-trip losslessly). A
  dashboard whose tiles cannot be reconstructed is dropped and surfaced in `droppedSubareas`.
  **A URL subarea that TARGETS a web resource round-trips too.** The Site Map Designer's "custom page
  backed by an HTML web resource" writes `$webresource:<name>` (Dataverse also serves it at
  `/WebResources/<name>`) into a URL subarea. Passing that token through used to fail the WHOLE
  download on validation — the http(s) guard rejected it — so no spec was written at all and download
  → edit → rebuild was blocked for the entire app over one nav entry (issue #430). The reference now
  **passes validation as-is**, exactly like a platform icon ref and for the reason recorded there: it
  is a live/OOB value a downloaded app carries, and rejecting it broke the round-trip on real apps.
  Requiring it to be *declared* would re-make that mistake, because such a page is frequently managed
  or owned by another publisher.
  Download additionally captures the page's CONTENT when it can safely do so. `collectSitemap` returns
  these as **`navRefs`, separate from icon `customRefs`**, because the type policy differs: the icon
  path gates on `IMAGE_WR_TYPES` by design and such a page is `html` (type 1), so routing it through
  the icon rules silently declared nothing and left a rebuild pointing at a resource the spec could
  not recreate. A nav ref takes the same safety gates as an icon — own prefix, unmanaged, has content,
  `external: true` so teardown never deletes it — minus the image-type gate. A managed/foreign one is
  left as a bare reference (it exists in the target env). The build needed no change: it already
  passes a subarea `url` straight through to the sitemap.
  This does **not** weaken the http(s) guard, which exists to stop an *arbitrary* scheme
  (`javascript:`, `file:`) becoming a nav entry in a shipped app — a web-resource reference names a
  resource inside Dataverse, not a script or a local file. A genuinely unexpressible url is still
  dropped and counted in `droppedSubareas`.
- **`scripts/verify-model-app.js` → `scripts/lib/verify-spec.js`** — read-only reconcile of the App Spec
  against what actually deployed; exits non-zero and lists anything missing, catching silent partial
  builds. Checks **existence** (entities/columns/views/charts/forms + sitemap subareas + icons + pages by
  id) AND, best-effort, **content** so an *unapplied edit* is caught (not just a missing artifact): a
  view's **column set** (parsed from `layoutxml`; every spec column must be deployed — an extra deployed
  column passes by design, so a column REMOVED from the spec, which the additive `reconcileView` leaves
  in place, is not flagged), plus **relationship** and **command-bar existence** (previously unchecked).
  Content checks are additive + reader-gated (they only fire when the reader supplies `layoutxml` /
  `entityRelationships` / `commandBar`), so existence-only callers are unaffected. **Dashboards** are
  checked too (#586): each declared dashboard must exist. A name can also match another app's
  dashboard, so when it matches several, verify checks the one the app's solution holds — the one the
  build reuses (`dashboardsInSolution`, shared with the build and teardown) — and fails only when the
  solution cannot single one out. All three find the candidates with `findDashboardsByName`: the
  vendored lookup reads one page of ten in no defined order, so a full page is re-read in full and the
  app's own cannot sort out of sight. The sitemap subarea check asks the same question (one lookup per
  name, shared), so the two cannot pick different dashboards — it used to take the first match, and live
  a same-named dashboard of another app sorted first and failed a correctly wired nav entry. When the reader supplies `dashboardComponents`, every chart tile's
  visualization and view must belong to the tile's `TargetEntityType` — the cross-wiring a same-named
  chart on another table produced. A tile whose owner rows cannot be read is reported unverified, not
  passed. **App membership is checked on the published layer:** sitemap tables union `app.tables`
  must have type-1 rows; each `app.mainForms` table gets an `app-main-forms` check comparing resolved
  active Main IDs with classified type-60 members. Missing members fail with “re-run the build”,
  extras fail with the Maker Forms remedy, and unreadable/unclassifiable membership is unverified,
  never passed. Dashboards (systemform type 0) and other non-Main forms are not Main members.
  It also reconciles
  **AI app features**: for every `ai.appFeatures` entry it proves an APP-SCOPE OVERRIDE ROW exists in
  `appsettings` holding the requested value. Verify previously had no awareness of `spec.ai` at all, so
  a run whose every AI feature was skipped (admin gate off) or silently not persisted still reported a
  clean PASS. The oracle is deliberately the override row and NOT the effective value:
  `RetrieveSetting(name, { appUniqueName })` **falls back to the environment value** when the app has no
  override, so an effective-value compare passes whenever the environment already holds the requested
  value — a false PASS for an app that was never configured, and the same oracle the SDK uses for its
  `applied` bucket. It fails CLOSED when the proof cannot be read, and the check needs BOTH
  `retrieveSetting` and `queryRecords` on the reader (an existence-only reader skips it rather than
  degrading to the unsound compare). Note the per-app settings are DISTINCT from the org readiness gates —
  `nlSearch`'s gate is the boolean `EnableNLGridSearch` but its per-app setting is the numeric
  `NLGridSearchSetting`; conflating them is what let NL grid search report "applied" while writing
  nothing. This is the F5 "convergence" mitigation: the build is additive (edits to existing artifacts
  aren't re-applied in place — teardown + rebuild to converge), and verify makes any resulting
  divergence **loud**.
- **`scripts/ai-preflight.js`** — standalone preflight report: prints each AI feature's on/off status
  and the exact admin action needed (Power Platform Admin Center → Environments → Settings → Product →
  Features) for anything off. Never fails. The `ai-features` build phase calls this logic internally and
  uses `RetrieveSetting`/`SaveSettingValue` (SDK) for app-level feature flags and `AIModelPublish` +
  `aiskillconfigs` for per-table row summaries. Feature values are `true`/`false` — encoded by the
  plugin to each setting's own On/Off value (On is `2` everywhere; Off is `1`, but `0` for `nlChart`;
  `AI_SETTING_CODEC` in `lib/ai-app-settings.js`, AB#6714731) before the SDK sees them — or an explicit
  integer written verbatim, bounded to `0..1000000` — the same range
  the SDK enforces, so validation rejects an out-of-range value up front instead of aborting the build
  half-applied. The SDK **proves every write** against the app-scope override row, retrying with backoff
  (an immediate read can still return the environment fallback, which previously produced a false
  `notPersisted` on first apply). `applied` is the ONLY success bucket; a feature otherwise lands in
  `notPersisted` (no override observed for the whole retry budget — Dataverse
  can accept an app-scope `SaveSettingValue` with HTTP 204 and store nothing), `skipped` (the same
  absence, PLUS the feature's org readiness gate reads off, which is offered as the explanation),
  `unverified` (the write
  was issued but the proof could not be read) or `failed` (the write threw; the rest of the batch still
  reports). **A gate is never a PRECONDITION** (AB#6688904): the SDK attempts every write and reads a
  gate only afterwards, to explain an absence that actually happened. It used to read the gate first,
  and for four of the seven features that "gate" IS the per-app setting the write is about to set — so
  on a new app its platform-default `0` looked like an admin refusal and the build shipped an app with
  no AI features while reporting success. The build surfaces **every** non-success bucket as a `⊘` warning plus in the phase detail
  — buckets are read off the result object, so one a future SDK adds is reported verbatim rather than
  silently dropped — and `--verify` fails on any of them. **An app-scope setting WRITE is a no-op until
  the app is published** (live-measured: the write reports `notPersisted` and `appsettings` holds no row
  at all, while publishing and re-issuing the same call applies every feature). This is not read lag, so
  re-*proving* after publish cannot fix it — the build **re-issues** the write after publish for anything
  the first attempt did not apply, `skipped` INCLUDED. On a fresh app nothing persists pre-publish, so
  the gate diagnosis fires for every feature that has one; abandoning those would leave `--verify`
  failing on a row the build declined to write a second time, and a reported customer environment ran a
  working app at `NLGridSearchSetting = 2` with `EnableNLGridSearch` off. Anything still `skipped` after
  the re-issue is reported as an admin action. Verification proves the override ROW, keyed by `appmoduleid`, so the
  build passes the id it already holds rather than have the SDK resolve it by name (an unpublished
  appmodule is not readable). See the `ai-features` phase in `scripts/lib/sdk-build.js` for the full
  sequence and its bounds.
  The flag set is resolved ONCE by `scripts/lib/ai-app-settings.js` and shared by the build and the
  verifier: a spec with an `ai` block but no `ai.appFeatures` still gets defaults written, so
  reconciling only the DECLARED features left them applied-but-unverified.
  All AI features need an environment admin to have enabled them: the skill preflights
  and warns; it cannot flip admin or tenant switches. What it does NOT do is decline to write on the
  strength of that preflight — see the bucket note above. `scripts/lib/ai-candidates.js` selects
  good-candidate tables for auto row-summary mode; `scripts/lib/ai-prompt.js` generates tailored summary
  prompts. The `ai` block in the App Spec configures the full set; see
  [`references/app-spec-schema.md`](references/app-spec-schema.md) → `## ai`.
- **`scripts/preview-form.js` → `scripts/lib/form-preview.js`** — renders an ASCII **form
  wireframe** (tabs, sections, fields with widget hints and authored `hidden`/`readOnly` state, the
  Notes/timeline block, sub-grids, form JS) from the App Spec, so the user can review a form
  visually during authoring before approving. A hidden field is annotated rather than omitted, and
  state is never truncated — the widget hint and then the label give way first, because a
  half-printed `(read-on…` is the silent-state failure the annotation exists to prevent.
  **`scripts/preview-app.js` → `scripts/lib/app-preview.js`** — renders the WHOLE app design
  (data model + sitemap tree + views/charts + per-form wireframes + page-intents + design contract)
  as a single ASCII preview — the design gate #2 / plan-mode approval artifact.
  **`scripts/write-app-spec-doc.js` → `scripts/lib/app-spec-doc.js`** — renders `model-app-plan.md`,
  the durable **Markdown design document** the user reviews and keeps alongside the app (jobs →
  surfaces traceability, data model, every surface incl. generative pages, navigation, the access
  model per role, sample data, design contract, AI features). Distinct from `app-preview.js`: that is
  an ASCII console preview for the in-conversation approval gate, this is durable Markdown for review
  and archival. It is **rendered, never hand-written** — the freehand version drifted from the spec
  and shrank to a counts summary. Also returns `warnings[]` naming design gaps (no jobs captured, a
  job with no covering surface, no generative pages) so the orchestrator surfaces them in chat.
- **`scripts/vendor/cds-maker-sdk.cjs`** — the SDK vendored as a self-contained headless bundle
  (rebuild via `scripts/_vendor-build/`); **`scripts/lib/sdk-http-client.js`** injects an
  `az`-token HttpClient. No browser, no relay — the SDK reuses the designer's own serializers.
- The build log is **phase-grouped with per-step status** (`▶ phase` / `[n/total] ✓ created` /
  `⊘ skipped` / `✗ failed`) + a closing summary. A **dry run resolves each item against the live
  environment** (#559) and marks it `+ create`, `= reuse`, or `? unknown` when the read failed —
  never guessing, because a wrong confident answer is worse than none. Items with no live identity
  (sample data, publish, generated icons) stay `▢` unprobed and are counted separately in the
  summary. The probe reuses the build's OWN discovery helpers (`findExistingTable`,
  `findExistingColumns`, `relationshipExists`, `artifactIdentityQuery`) rather than a parallel
  implementation, so the plan cannot disagree with what the apply then does; it is read-only, and
  `--no-live-plan` restores the offline, spec-only listing.

The end-to-end flow (Phase 0 working dir → Phase 1 author **in the main loop** per
`references/authoring-flow.md` → Phase 2 narrated SDK build → Phase 3 verify & iterate; **edit** an
existing app via the same path — `download-model-app.js` pulls it back into a spec, then re-run Phase 2
idempotently) is diagrammed in [`docs/architecture.md`](docs/architecture.md) → *`/app-builder` —
build pipeline*. **Upcoming:** shippable-defaults provisioning (security role / standard views; the
quick-create table flag now ships via `entities[].quickCreate` / an authored `QuickCreate` form —
auto-generating the Quick Create form's field layout is the remaining follow-up).

## Local Development

Test this plugin locally:

```bash
claude --plugin-dir /path/to/plugins/model-apps
```

## File Tree

The canonical layout of the plugin (architecture **diagrams** live in
[`docs/architecture.md`](docs/architecture.md)):

```
.plugin/plugin.json            ← Open Plugins metadata (name, version, keywords)
.mcp.json                      ← MCP server config (Playwright for browser verification)
AGENTS.md                      ← Plugin guidance for AI agents (this file)
CLAUDE.md                      ← Symlink → AGENTS.md
README.md                      ← User-facing intro and prereqs
CHANGELOG.md                   ← Keep-a-Changelog
feature-flags.json             ← Feature flags (custom-api, custom-telemetry)
.claude-plugin/plugin.json     ← Legacy plugin metadata mirror
docs/
  architecture.md              ← Wiring/flow diagrams for BOTH skills (/genpage + /app-builder)
  app-builder-capabilities.md       ← /app-builder capabilities (what ships today, with evidence)
  app-builder-design.md        ← /app-builder design record (Part I staged flow · Part II --changed-only)
agents/                        ← Agent definitions (invoked by skills via Task tool)
  genpage-planner.md           ← Requirements, discovery, plan doc, user approval (create flow)
  genpage-connector-builder.md ← Orchestrator-invoked connector gate/discovery; writes connector bindings
  genpage-entity-builder.md    ← DV entity creation via plugin's Web API scripts (create flow)
  genpage-page-builder.md      ← Writes one .tsx file; runs in parallel for multi-page (create flow)
  genpage-edit-planner.md      ← Reads download artifacts, plans edits, writes edit plan (edit flow)
  genpage-customapi-builder.md ← Single owner of the custom-api gate; discovers bound Custom APIs, writes ## Custom API Bindings + actions.json (create & edit flows)
references/                    ← Shared reference docs
  rules.md                     ← Full code-gen rules, DataAPI types, layout patterns, common errors
  custom-api.md                ← Dataverse Custom API (Action/Function) invocation contract (loaded when the plan has ## Custom API Bindings)
  page-telemetry.md            ← props.appInsights page telemetry contract (custom-telemetry gated; loaded only when the maker asked to measure something)
  connectors.md                ← GenPage connector binding contract and runtime patterns
  plan-schema.md               ← Schema contract for genpage-plan.md
  app-spec-schema.md           ← The App Spec contract (always-present fields) — /app-builder
  app-spec-schema-advanced.md  ← Conditional App Spec fields (business rules, BPFs, commands, web resources, global choices, dashboards, roleGrants)
  authoring-flow.md            ← /app-builder Phase 1 authoring playbook, run in the main loop (not a subagent)
  agent-interaction-contract.md ← Agents are headless: no AskUserQuestion / plan mode inside a Task subagent
  data-caching.md              ← Rule 15 on-mount fetch: de-dupe + cache (loaded conditionally)
  localization.md              ← Multi-language + RTL pattern (loaded conditionally)
  supported-dependencies.md    ← Versioned package list for generated pages
  troubleshooting.md           ← Deployment/runtime/env issues
  verified-icons.txt           ← ~5000 Fluent UI icon names; Grep-validated by page-builder
samples/                       ← Example .tsx files (13 samples) plus app-builder spec samples
scripts/
  launch-playwright-mcp.js     ← Playwright MCP server launcher (fullscreen; uses lib/detect-browser.js)
  playwright-mcp-fullscreen.config.json ← Fullscreen browser config for the launcher
  regenerate-verified-icons.js ← Regenerates references/verified-icons.txt from npm
  check-auth.js                ← Pre-flight: az present + logged in, pac identity, WhoAmI, identity match (pac overlaps the az probes); a CLI too slow to answer is `az_timeout`/`pac_timeout`
  check-version.js             ← Skill-start update notice: compares the plugin clone with its origin/main (git runs in the plugin, never the user's repo)
  resolve-interaction-mode.js  ← Reports whether a human can answer in this run (unattended defaults)
  lint-app-spec.js             ← Validate + lint an App Spec without touching an environment
  dataverse-request.js         ← General Dataverse Web API wrapper (escape hatch)
  list-connections.js          ← Connector discovery: PAC connections + Dataverse connection references
  create-connection-reference.js ← Creates Dataverse connectionreference rows for connector bindings
  list-custom-apis.js          ← Discovers bindable Custom APIs (Global + entity-bound) + parameter kinds (custom-api gated)
  add-page-to-solution.js      ← Adds GenPages and optional connection references to a solution
  provision-entities.js        ← CLI wrapper for entity provisioning (solution + data-model + sample-data; --language-code)
  provision-solution.js        ← Creates a Dataverse solution via the SDK
  write-page-plan.js           ← app-builder Phase 1.5: projects an App Spec into the genpage-plan.md read by page-builder workers
  promote-intent-pages.js      ← app-builder Phase 1.5: validates every generated page, then atomically flips source: intent → tsx
  build-model-app.js           ← app-builder: narrated, idempotent SDK build (dry-run default; --stage data|ui|app|publish; --changed-only; --language-code)
  download-model-app.js        ← app-builder: pull a deployed app into an editable spec (edit flow)
  teardown-model-app.js        ← app-builder: classifier-safe reverse-of-build teardown
  verify-model-app.js          ← app-builder: reconcile the spec against the deployed app
  preview-form.js              ← app-builder: ASCII form wireframe for authoring review
  preview-app.js               ← app-builder: ASCII whole-app design preview (data model + sitemap + forms + page-intents + design)
  write-app-spec-doc.js        ← app-builder: renders the readable model-app-plan.md design doc from app-spec.json
  ai-preflight.js              ← app-builder: preflight AI feature availability (admin-gate report)
  run-tests.js                 ← one-command plugin + SDK regression runner
  smoke-eval.js                ← scripted live smoke eval (build → assert → teardown)
  generate-page-manifest.js    ← Phase 0.5: writes working-dir package.json + genpage.d.ts
  genpage-upload.js            ← /genpage: deploy one page via the shared wrapper (prompt passed BY FILE, never on a command line; an update must name the app the page is placed in, and keeps the page's name, model and bindings unless given; refuses no-base / deployed-changed / deployed-unreadable unless --overwrite-deployed)
  genpage-base.js              ← /genpage: record or check the deployed-page base marker next to a page.tsx (#673)
  genpage-plan-provenance.js   ← /genpage: quarantine a stale plan before the planner writes, then verify the written plan targets the pages the approval named and, for an edit, carries the exact approved change list
  check-page-files.js          ← /genpage: pre-dispatch gate — the page file names of the plan's one ## Pages table are safe write targets (lib/page-file-targets.js)
  genpage-worker-output.js     ← /genpage: accept a parallel worker's page only if complete (default export, balanced, no elided code)
  capture-fixture.js           ← Copies /genpage working dir into an eval fixture and runs both runners
  lib/
    entity-provision.js        ← Shared entity-provisioning core (solution + data-model + sample-data)
    provision-input.js         ← Input validation for entity provisioning
    dataverse-auth.js          ← Shared auth + HTTP helpers (`az account get-access-token`, memoized per process and replaced on a 401; responses decoded as UTF-8 once; an environment URL is used only as a Dataverse https origin, `dataverseOrigin`), plus the CLI arg contract (parseArgs/validateFlags)
    process-runner.js          ← how every script starts az/pac/npm/npx/git: the executable is resolved to an absolute path on PATH, never the project folder, and started without a shell (a Windows batch shim runs through cmd.exe with its arguments checked)
    cli-failure.js             ← how a CLI child failed (timeout / missing / failed) and the Azure CLI budget (60 s, `POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS`), so a slow `az` is never reported as missing or signed out
    nearest-name.js            ← pure single-edit "did you mean" matcher for closed vocabularies (CLI flags, FetchXML operators)
    supported-dependencies.js  ← Single source of truth for runtime + dev deps versions
    feature-flags.js           ← Default-OFF feature flag probe + Custom API script backstop
    sdk-build.js               ← app-builder build engine (idempotent; incl. the pages phase)
    app-components.js          ← shared current/published app layers, component inventory, hidden-table pin/proof, Main-form resolution/membership and push directives
    stages.js                  ← stage→phase-range mapping + PHASES/STAGES constants
    op-diff.js                 ← destructive-op diff + --allow-destructive / --non-interactive gating
    artifact-intent.js         ← pure App Spec → canonical SDK intent compiler (new form topology; no SDK calls)
    form-occupancy.js          ← pure row occupancy (own cells + columns reserved by row-spanning cells above), shared by build and verify
    form-order.js              ← the Main Form Set order: which Main form a table opens with, and which forms the build orders (shared by the spec gate, build and verify)
    form-container-match.js    ← how an authored tab/section is matched to a deployed one, and the moves that put them in the layout's order (shared by build and verify)
    ai-app-settings.js         ← single source of truth for the per-app AI feature contract
    interaction-mode.js        ← whether a human is reachable in this run (shared by both skills)
    page-plan.js               ← pure App Spec → plan-document projection used by write-page-plan.js
    page-structure.js          ← the one structural gate a generated page must pass (empty, truncated, prose, elided), shared by genpage-worker-output.js and promote-intent-pages.js
    page-file-targets.js       ← the one page-filename rule (absolute/backslash/traversal/.tsx only/links/case collision, incl. with files already there), shared with check-page-files.js and the evals
    app-source-path.js         ← shared lexical + realpath confinement for app source reads/uploads and hashes
    page-ownership-records.js  ← local CREATE receipts and pre-delete ownership records, scoped to app/key/id
    source-literals.js         ← TSX lexer (code/comment/string/template/regex/JSX) — see "Known limits" below
    sdk-teardown.js            ← app-builder teardown engine (planTeardown is pure)
    sdk-http-client.js         ← az-token HttpClient for the vendored SDK
    spec-lint.js / app-spec.js ← App Spec guardrail lint + validation
    spec-shape.js              ← shared structural normalization for both authoring gates
    surface-resolver.js        ← pure: resolve personas[].jobs[].surfaces[] to the spec artifacts that satisfy them
    role-privileges.js         ← pure: declared persona privileges + subset comparison against a deployed role
                                  (also the oracle for `roleGrants[]`, which is additive rather than converged)
    odata.js                   ← OData literal escaping helpers
    genpage-cli.js             ← pac model genpage upload/list/download wrapper, plus a page's own name read from its row (pac stores `"` as `\"`; `unescapePacName`); an uncertain create reports its candidates and stops without adopting one as an UPDATE
    genpage-base.js            ← base-marker hash, compare, and read/write (sibling dotfile of the code file; no environment URL)
    safe-fs.js                 ← confined output writes and deletes: the named directory's final component must not be a link or junction (readlink, not a path-text compare, so an 8.3 name and a share root stay usable); write via exclusive temp + rename. Shared by genpage markers and later callers
    hydrate-spec.js            ← reconstruct an App Spec from a deployed app (edit flow)
    verify-spec.js             ← spec-vs-deployed reconciliation core
    build-journal.js           ← durable JSONL build journal (resume diagnostics)
    form-preview.js            ← form wireframe renderer
    app-preview.js             ← whole-app design renderer (data model + sitemap + forms + page-intents + design)
    app-spec-doc.js            ← pure App Spec → readable Markdown design doc (model-app-plan.md)
    schema-facts.js            ← pure data-model provisioning fact extractor for evals
    pageref-resolver.js        ← PAGEREF_<key> → GenPageId nav resolver
    page-manifest.js           ← durable <app>_pagemanifest read/write
    sitemap-pages.js           ← pure GenPageId extractors + fail-closed fetchSitemap MEMBERSHIP reader + navigationProof (page ownership proof from either app layer) + cross-app scan
    sitemap-merge.js           ← pure: re-attach an existing app's rewritten sitemap to its live nodes (ids + everything the spec cannot describe), keep designer nav edits the spec did not make
    deployed-baseline.js       ← `.maker-workspace/last-applied.json`: the spec last applied or downloaded, stamped with its environment + app and the dashboard/page ids deployed there
    ai-candidates.js           ← selects good-candidate tables for auto row-summary mode
    ai-prompt.js               ← generates tailored Copilot row-summary prompts
    _graph.js                  ← entity topological ordering (shared by build + teardown)
    system-solutions.js        ← built-in system solutions (Active/Default/Basic) — shared by download recovery + teardown skip
    phase-diff.js              ← pure spec-diff → changed build phases (advisory diff foundation)
    content-hash.js / hash.js  ← content-aware phase diff: fold on-disk .tsx/contentPath byte hashes into the diff (changed-only)
    classify-changes.js        ← changed-only: classify a spec diff → fast (page-content) | full | noop + sticky debt
    apply-snapshot.js          ← changed-only: pure eligibility state machine (identity bind, debt, tombstone, generation CAS)
    apply-snapshot-store.js    ← changed-only: atomic snapshot write (writeFileAtomic, also the baseline's) + workspace lease + invalidate/claim/tombstone/delete + distrust marker
    apply-snapshot-index.js    ← changed-only: build result.created → snapshot artifact map
    workspace-paths.js         ← the `.maker-workspace` name + the guard that gates destructive --clear-workspace cleanup
    changed-only-flow.js       ← changed-only: --changed-only orchestration (decide fast/full, live identity, snapshot lifecycle)
    projection.js              ← changed-only: pure post-apply verifiers (form placement / sitemap / page dual-hash)
    detect-browser.js          ← System Chromium/Edge/Chrome detection (used by the launcher)
    modelapps-hook-utils.js    ← Tracked-skill discovery + validator lookup for the hooks
    utf8-stream.js             ← reads a hook's stdin as UTF-8 without splitting a multibyte character across pipe chunks
    telemetry/                 ← Bundled 1DS telemetry: ikey.json (this plugin's config) + lib/ (copy of shared/telemetry/lib)
  vendor/cds-maker-sdk.cjs     ← headless vendored SDK bundle (rebuilt via _vendor-build/)
  _vendor-build/               ← esbuild vendoring tooling (build.js + pinned deps)
  tests/                       ← node --test coverage for the scripts + hooks
hooks/                         ← Lifecycle hooks
  hooks.json                   ← Hook registrations (closed schema — documentation lives in README.md)
  README.md                    ← What hooks.json wires up, and why
  run-skill-posttool-validation.js ← Runs a skill's validate*.js after the Skill tool returns
  validate-icon-imports.js     ← PostToolUse: blocks unverified @fluentui/react-icons in generated .tsx
  validate-write-safety.js     ← PreToolUse: flags (non-blocking) out-of-cwd writes in model-apps sessions
  run-skill-pretool-telemetry.js   ← PreToolUse(Skill): emits skill_started (ships disabled)
  run-user-prompt-telemetry.js ← UserPromptSubmit: emits skill_started for /model-apps:<skill>
skills/
  app-builder/
    SKILL.md                   ← intent → model-driven app (create + edit)
  genpage/
    SKILL.md                   ← Orchestrator skill (delegates to agents)
    edit-flow.md               ← Edit flow steps (loaded only on edit path)
    verify-flow.md             ← Playwright browser verification (loaded only when user opts in)
  report-issue/                ← Bug-report skill (bundled shared workflow)
  telemetry/                   ← /model-apps:telemetry on|off|status control skill
```

## Skills

| Skill | Description |
|-------|-------------|
| `/genpage` | Build and deploy generative pages for a model-driven Power App |
| `/app-builder` | Build and edit a whole model-driven app — tables, columns, relationships, adaptive forms, views, Choice-column charts, generative pages, app + sitemap, sample data, and admin-gated AI features — from a natural-language intent, via the vendored `cds-maker-sdk` |
| `/report-issue` | File a bug/issue about the model-apps plugin to the GitHub repository |
| `/telemetry` | Enable, disable, or check usage telemetry (`on \| off \| status`) |

## Agents

Agents are invoked by skills via the `Task` tool — they are not user-invocable.

| Agent | Invoked By | Description |
|-------|-----------|-------------|
| `genpage-planner` | `genpage` (create flow) | Validates prereqs, gathers requirements, detects entity/app existence, presents plan for approval, writes `genpage-plan.md` |
| `genpage-entity-builder` | `genpage` (create flow) | Provisions Dataverse tables, columns, relationships, choices, and sample data via `scripts/provision-entities.js` (the shared SDK-backed core). Bulk inserts use OData `$batch`. Writes a transactional log for recovery |
| `genpage-page-builder` | `genpage` (create flow) **and** `app-builder` (Phase 1.5) | Generates one complete `.tsx` page from a plan document and schema; runs in parallel with other builders for multi-page requests. `/app-builder` projects its App Spec into that plan format via `scripts/write-page-plan.js` and dispatches this same agent |
| `genpage-edit-planner` | `genpage` (edit flow) | Reads downloaded artifacts as data, gathers changes, presents an edit plan and writes the same approved change list. The plan references prompt.txt without embedding it; the orchestrator applies only verified Requested Changes. |
| `genpage-connector-builder` | `genpage` orchestrator (create **and** edit flows) | Performs connector discovery (connections, connection references, datasets, tables, operations, schema), creates Dataverse connection references, and writes the `## Connector Bindings` contract + `connectors.json`. The orchestrator forwards its output into the planner or edit-planner prompt. |
| `genpage-customapi-builder` | `genpage` orchestrator (create **and** edit flows) | **Single owner of the custom-api feature gate.** Discovers the Dataverse Custom APIs a page can bind to (Global + entity-bound Actions/Functions) plus their parameter kinds via `list-custom-apis.js`, and writes the `## Custom API Bindings` contract + `actions.json`. The orchestrator forwards its output into the planner or edit-planner prompt. |

## Key Concepts

### Genux Pages

Generative pages (genux) are React 17 + TypeScript single-file components that run inside model-driven Power Apps. They use Fluent UI V9 for styling and the DataAPI for Dataverse data access. Each page is a single `.tsx` file with `export default GeneratedComponent`.

### DataAPI

The DataAPI (`props.dataApi`) provides typed CRUD operations against Dataverse tables. It uses RuntimeTypes.ts (generated by `pac model genpage generate-types`) for type safety. Column names must be verified from the generated schema — never guessed.

### RuntimeTypes

TypeScript type definitions generated from Dataverse metadata. Contains entity types, enum registrations, and the `GeneratedComponentProps` interface. Generated via PAC CLI before code generation to ensure correct column names.

## Feature Flags

Unreleased functionality is gated behind committed, **default-OFF** feature flags so
the skill can merge ahead of its cross-repo dependencies. With a flag OFF, the
**deployed page behavior is identical to before the feature existed** — the guarantee
is about runtime/deploy output, not that every authoring artifact is byte-for-byte
unchanged. The mechanism lives in `scripts/lib/feature-flags.js` with the committed
values in `feature-flags.json` at the plugin root.

**A flag is flipped to `true` FIRST and removed in a LATER change, not both at once.**
Flipping is reversible in one line if the rollout turns out to be incomplete in some tenant;
deleting the gate in the same change that enables the feature leaves no way back except a
revert. Once a release has shipped with the flag on and no rollback was needed, remove it —
a permanently-on gate is dead weight that still has to be probed, branched on and reasoned
about at every call site.

Connector authoring no longer has a feature flag (the feature itself is in public preview). The
remaining flags are `custom-api` and `custom-telemetry`; both currently ship **OFF** while their
dependencies finish rolling out.

- **Source of truth:** `feature-flags.json` (e.g. `{ "custom-api": false }`). Flip a
  flag to `true` in a one-line PR once its dependencies are GA in PROD, then remove
  it in a follow-up that deletes its gates.
- **Precedence (highest first):** env var `GENPAGE_ENABLE_<FLAG>` (e.g.
  `GENPAGE_ENABLE_CUSTOM_API=1` for a single run) → committed
  `feature-flags.json` → default `false`
  (fail-closed). This mirrors the telemetry opt-out env-over-config convention.
- **LLM gate:** skill/agent markdown probes a flag with
  `node "${PLUGIN_ROOT}/scripts/lib/feature-flags.js" <flag>` (prints `enabled`/`disabled`,
  exits 0/1) and skips the gated workflow when disabled. `--list` prints every known
  flag's lifecycle **status** (experimental / in-progress / ga), effective state +
  source (env/file/default), summary, how to enable, plus config-validation warnings.
  Flags are catalogued with that metadata in the `FLAGS` map in `feature-flags.js`
  (the committed `feature-flags.json` carries only the on/off value). Unknown flags
  are disabled even when a matching env var is set.
- **Script backstop:** Custom API entrypoints call the shared
  `exitIfCustomApiDisabled()` helper (DRY — no inlined gate) and fail closed with
  exit 3 when OFF: `list-custom-apis.js`. Connector scripts have no feature-flag
  backstop because connector authoring is always on.
- **Validation:** `KNOWN_FLAGS` + `validateFlags()` warn on unknown keys / non-boolean
  values in the committed file (so a typo can't silently do nothing, or — after a flip
  to `true` — accidentally enable the wrong thing).

**Each gated feature has a SINGLE OWNER agent, and every entry point must go through it or the
shared helper.** Gate a feature at the same five places, so the rule is stated once here and
only the per-feature specifics are tabled below:

1. **Discovery** — the owner agent runs the probe first; planners/edit-planners delegate to it and
   never gate inline.
2. **Scripts** — each entry-point script calls the shared `exitIf<Feature>Disabled()` helper (DRY —
   never an inlined gate) and fails closed with exit 3 when OFF.
3. **Deploy** — the SKILL phase **re-probes** the flag and treats an absent/malformed bindings
   section as *no bindings*, so a plan authored while the flag was ON cannot deploy after it goes OFF.
4. **ALM** — solution packaging honours the flag (or documents why it needs no gate).
5. **Codegen** — `genpage-page-builder` emits feature code **only** when the plan carries an actual
   binding table, never on an absent/sentinel section.

| | `custom-api` | `custom-telemetry` |
|---|---|---|
| **Owner agent** | `genpage-customapi-builder` | none — codegen-only |
| **Plan section** | `## Custom API Bindings` | none — driven by the maker request, not the plan |
| **Gated scripts** | `list-custom-apis.js` | none |
| **Deploy phase** | SKILL Phase 4.6 | SKILL Phase 4.7 (probe only) |
| **ALM** | none needed — `config.json`'s `actionBindings` travels inside the page's `uxagentprojectfile` rows automatically (the Custom APIs themselves are a separate deployment prerequisite, bound by name) | none — telemetry rides the host runtime, nothing is packaged |
| **Emits** | `executeAction` / `executeFunction` / `listBoundActions` | `props.appInsights` calls (`trackEvent` / `trackMetric` / `trackTrace` / `trackException` / `trackDependency` / `startTrack` / `stopTrack`) |

At Phase 4.7 the `/genpage` orchestrator probes and passes the verbatim result as
`Telemetry: enabled|disabled` in every page-builder dispatch — **that dispatch value wins over
the plan.** Phase 4.5 passes a `Connectors: none|<n> binding(s)` line the same way, but note the
difference: that value is the **binding count**, not a flag state. An empty binding table yields
`none`, because the page-builder only needs to know how many bindings it may call.

`custom-telemetry` is the odd one out: it has no owner agent, no discovery script, no plan
section and no deploy or ALM step. It gates **code generation only** — steps 2-4 of the
checklist above are N/A, and its Phase 4.7 "deploy phase" is nothing but the re-probe that
produces the dispatch line. It also carries a second gate the other flags do not have: even
when `enabled`, `genpage-page-builder` instruments a page **only** when the maker explicitly
asked to measure or track something. `enabled` is permission, not instruction.

The two remaining flags currently ship **OFF**, each waiting on cross-repo dependencies:

- **`custom-api`** — the AIBuilder CoderAgent action prompt, the shared `pai-gen-ux-action-runtime`
  plus the UCI and Controls host runtimes, a pac CLI `model genpage upload --actions` verb to
  persist `actionBindings` into `config.json`, and the `GenUxPluginActionAllowList` ECS setting.
  Note the maker-facing name is "Custom API" while the shipped wire contract stays
  `actionBindings` / `executeAction` (see `references/custom-api.md`).
- **`custom-telemetry`** — the page telemetry facade in the UCI host runtime, the GenUX
  authoring control (power-platform-ux), the AIBuilder CoderAgent telemetry prompt, and the
  `GenUxEnableCustomTelemetry` ECS setting (see `references/page-telemetry.md`).

## TSX source lexer — known limits

**`scripts/lib/source-literals.js` — known limits.** It is a hand-rolled TSX lexer, not a
parser: the plugin ships dependency-free, so there is no TypeScript to call. It tracks
code / line comment / block comment / string / template / regex / JSX tag / JSX text, and
backs the page structural gate (`lib/page-structure.js`, shared by `promote-intent-pages.js` and
`genpage-worker-output.js`) plus the eval's effect scoper. It also
backs the navigation oracle (`pageref-resolver.js`), which finds each call AND parses its object
in the lexer's mask — executable code inside a template's `${…}` is visible, template text and
string bodies are not — and reads each value, and each quoted key (`"pageId"`), from the source at
the same offsets, so one lexer drives both. It also backs `findElisionMarker` — the one "was code
elided?" rule the page gate and the Layer 2 eval share (a `FIXME` comment, a `TODO` that opens a comment or takes
a colon, a comment opening with `...`, "omitted for brevity", or a bare `...` line; the same words
as UI copy — "Loading…", a `'TODO'` status value — are not elision). A template's `${…}` body is
code and is read by the same lexer (`lexInto`), JSX and comments included, never by a lighter
scanner. It is **one pass** over the file with an explicit stack of code and template frames, so
its time is linear in the file's length however deeply templates nest — a lexer that re-scanned
each `${…}` body per level of nesting took over a second on a 2.5 KB page. Keep it one pass; the
`performance:` tests and the 50,000-deep nesting test in `genpage-lexer-hardening.test.js` guard it.
Whether a `/` or `<` starts a regex or JSX is judged by the code before it: never by a
comment's last word; a keyword read back as a property name (`counts.new / total`) or a postfix
`!` / `++` ends an operand; and a `)` ends one too, unless it closes an `if` / `for` / `while`
head, after which a statement starts. A `/` or `<` after a `/` or a `>` is judged by what the lexer
itself read there: it knows where a regex it blanked ended, where an element it read ended and which `/` it
took for the division operator (`ends` in `lexInto`), so `/x/ / 2`, `<b/> / 2`, `a / /y/` and `a / <b>t</b>`
are read for certain (the output alone cannot tell them from a guess: a blanked regex keeps its delimiters, an
element its `>`). A regex literal ends after its **flags**, not at its closing slash: TypeScript's scanner takes every
identifier part after the closing `/` as part of the literal, a valid flag or not (`reScanSlashToken`; an unknown flag is
a checker error and no parse error), so `const n = /x/in / 2;` is one literal and a division, and a lexer that stopped
at the slash read the keyword `in`, a regex from the second slash, and the real regex after it as code (`regexFlagsEnd`
reads the flags, characters beyond ASCII and code points beyond the BMP included, and the end it records is the last
of them). Each of those rules was once broken, and each break refused
a complete page as truncated or hid a navigation call. The judgements that are a guess — a `/` after a `}`,
a `)` whose `(` is out of reach, a word that may be a keyword or a name — report themselves through
`onAmbiguity` (see the trust frontier below). A file may start with a **hashbang**: `#!` at offset 0 is trivia
to TypeScript's scanner, to the end of its line, and is blanked and heard as a comment (so a token in it is a
stray one, like one in any comment); after a byte order mark, white space or a line break a `#!` is an error to TypeScript.
A **closing tag** is scanned as TypeScript scans it (`parseJsxClosingElement`): `</`, trivia and comments, a name
(an identifier, which a `-` continues, then either `.` and more such names or one `:` and one more, as
`parseJsxElementName` and `parseJsxTagName` read them — the `.` and the `:` are tokens of their own, so trivia and comments
may stand around them: `</a :b>`, `</a/*c*/:b>`, `</a . b>`, and no `.` follows a namespace name), trivia and comments, then `>` — never by
searching for the next `>`, which a comment inside the tag can hold (`</A /* > navigateTo(…) */>` ends at the last `>`; a
search for the first one read the call in the comment as code). The comments in it are blanked and heard as comments, as in an opening tag; a closing tag that holds
anything else before its `>` is the `jsx-open` guess. The `/` and the `>` of a **self-closing tag** are two tokens as well
(`parseJsxOpeningOrSelfClosingElementOrOpeningFragment`), with trivia of every kind between them — white space, line breaks of every
kind, comments: `<B / >`, `<B /⏎>`, `<B x="1" / /* c */ >`, `<A x=<B / >/>` — and the `>` after them ends the element. Read as the end of an opening tag, that `>`
took the text after it for the element's text, and a closing tag in a string after it for the end of the element, and a call after it was read as the data it
is not. A `/` directly followed by another `/` or by `*` is the start of a comment, so the slash of a self-closing tag has a space or a line break between it and any comment that follows. Any new scan for a delimiter (`indexOf`, a regular
expression, a loop that stops at the first `>` or `}`) has to skip comments and strings the way TypeScript's scanner does, or report a guess.
`hasDefaultExport` also needs the export
itself to be complete (a function or class reaches its body; a bare name is one the module
declares or imports, not a token that merely appears — the `as` of `import * as React` is not a
binding), because a write cut inside its export line balances; any complete `export default` will
do, for overloads. And `endsMidStatement` catches the cuts that leave every bracket balanced: the
lexer reports when a file stops inside a string, template, comment or JSX element, and a file
may not end on a token that needs more (`a +`, `React.`, `=>`). Both gates run all three checks.
A backslash continues a string over one line terminator, and CR LF is **one** terminator
(`"a\<CR><LF>b"` is a complete string): the quoted-string scans pair the CR with its LF, where skipping
only the CR read the LF as a raw line break, refused the string and every quote after it, and
rejected a complete page saved with CRLF endings.

**The navigation oracle's rules** (`pageref-resolver.js`, on top of that lexer):
- A property value is a *literal* only when it is exactly ONE string literal — the next significant
  token after it is `,` or the object's `}`. `"PAGEREF_x".slice(8)`, `&& y`, `?? y`, a ternary, a
  member/call/index tail make it an expression: never rewritten, a token inside it is
  reported as malformed (`navMalformedRefs`). The same holds for `pageType`.
- The one thing allowed between the literal and that `,` or `}` is a TypeScript cast, in a **small closed
  grammar**: `literal ( as const | as Name | satisfies Name )*`, where `Name` is a plain or dotted ASCII
  identifier (`string`, `PageKey`, `Pages.Key`; `true` and `this` are only identifiers here) with no type
  arguments, suffixes, unions or literal types. The compiler erases such a cast, so the value is still the
  literal; the span of the target is the literal alone, so a rewrite keeps the cast
  (`"PAGEREF_x" as const` → `"<page id>" as const`), and `as const` round-trips through reverse resolution.
  The grammar is closed on purpose: a reader that tried to tell "more of the type" from "an expression" by
  shape was fooled (`as unknown as true < limit > [false][0]` is a comparison), and one that read a
  string-literal type hid a `PAGEREF_` token in a span the compiler erases and the report never saw. A name
  read whole, then the end of the value, leaves nothing to tell. Anything outside it — a generic, a union, an
  array or indexed type, a string-literal type, a function type — is not a literal even where TypeScript
  would erase it: the value is reported (`pageref-malformed`) and never rewritten, and the author writes the
  literal alone. A `PAGEREF_` token inside a type is therefore reported too — a token is allowed only as the
  double-quoted `pageId` literal of a `navigateTo` call whose options object is written inline, and
  nowhere else, a comment included (`PAGEREF_RULE`, which the build and the promotion gate quote). `as` and `satisfies` must be on the line of what they cast, as in TypeScript.
  `pageref-resolver.test.js` checks the grammar against TypeScript's own parser when
  `TYPESCRIPT_ORACLE_PATH` is set (unset, those tests skip): TypeScript must erase every accepted cast
  to the literal, and across every short sequence of casts and operators whatever the oracle calls a
  literal must be the bare literal to TypeScript — a mutation that lets an expression through fails it.
- A call is found by its callee's name — bare, member, optional, or named by a string literal
  (`Xrm.Navigation?.["navigateTo"]?.(…)`) — and is a navigation only when the object literal is the
  **whole** of its first argument, because rewriting a token inside anything else changes what the page
  does. **The plain form `navigateTo({ … })` is the one to write**: the parenthesised spellings exist because a
  generated page may use them, and they are accepted in one place only. A parenthesised **callee** must wrap
  exactly the callee (`navigateTo` or a member chain ending in it: `(Xrm.Navigation.navigateTo)(…)`) AND its `(`
  must follow a token on an **allowlist** — the start of the source; `;` `{` `(` `[` `,` `:`; a ternary `?`;
  an operator ending in `=` (`=` `==` `===` `!=` `!==` `+=` `<=` `>=` …); `=>`; `&&` `||` `??`. It is an
  allowlist because the tokens that END a callable operand are many and easy to miss — `!` (a non-null
  assertion), `>` (a generic instantiation), a back-tick (a tagged template), `}` (a function expression, which
  a block's `}` cannot be told from), a name or keyword, `)`, `]`, `.`, `?.`, `++` — and each makes
  `(navigateTo)(…)` an argument list: `factory!(navigateTo)(…)`, `factory<unknown>(navigateTo)(…)`,
  ``tag`x`(navigateTo)(…)`` and `function () { return f; }(navigateTo)(…)` hand the object to whatever
  `factory`, `tag` or the function returns. (A denylist of those tokens missed four of them.) A callee group at
  the start of a template expression, after its opening back-tick, is refused for the same reason. A
  parenthesised **argument** is closed straight after the object (type-only casts may precede the `)`), and the
  argument must then end at a `,` or the call's `)`: `navigateTo(({ … }))` is a call;
  `navigateTo(({ … }).pageId.length === 14 ? a : b)`, `navigateTo({ … }.pageId)` and `navigateTo(({ … }, other))`
  hand the object to something else. Anything else — a cast on the callee, `.call`, an alias, an options object
  built in a variable — is not read, and its token is *stray*: `strayPageRefs` is the invariant that no
  `PAGEREF_` token ships unaccounted for, and the page build (`pages-stray-pageref`) and
  `promote-intent-pages.js` refuse a page that holds one.
- **No comment may hold a `PAGEREF_` token — there is no comment exemption.** A token is allowed only as the
  double-quoted `pageId` literal of an inline `navigateTo` options object (`PAGEREF_RULE`: "…and nowhere
  else — not in a comment"). An exemption for comments cannot be made sound without a parser: every form of
  it (any comment; a `//` comment; a `//` comment that starts its own line) was defeated, because *where the
  comments are* is exactly what a lexer with no parser can get wrong: the `/*` inside a misread regex opens a
  false block comment over a real call, and a line that starts with `//` can sit inside a template literal that
  holds code that runs:
  ``const message = `\n// ${navigateTo({pageType:"generative", pageId:"PAGEREF_detail"})}\n`;``.
  `// PAGEREF_detail is replaced at deploy` is refused like any other stray token; write the comment without
  the token (`// the link to the detail page is resolved at deploy`), and a comment that merely LOOKS like a
  call (`// navigateTo({pageType:"generative", pageId:"help-text"});`) is fine. The rule is the same for the
  stray scan, promotion, the page build and the eval scorer, so nothing about comments is left for them to
  disagree about.
- **The trust frontier.** The lexer has no parser, so some of what it decides is a guess: whether a `/` is a
  regex or a division, whether a `<` opens an element, how a JSX tag with type arguments is scanned. Where a
  guess is wrong it blanks real code or reads text as code, and from there on the mask is not what the page
  means. `blankNonCodePreservingTemplateExpressions(code, { onAmbiguity })` reports each such decision as data —
  `(at, kind)`, the offset of the `/`, `<` or construct — and the tokenization is **byte-identical** with or
  without a listener (the other gates, `page-structure.js` and the worker-output and icon checks, get exactly
  what they got; compare the two over every committed `.tsx` and fuzzed input when you touch it). The
  navigation reader takes the **earliest** offset as a *frontier*, and trusts nothing at or after it, **or in
  a call that reaches it**. A call's meaning is read from its whole options object (a later member — a
  getter, a computed key, a spread — can make `pageType` something else, and a guess can hide that member),
  so a call is trusted only when ALL of it lies before the frontier: the object from its `{` to the `}` the
  lexer found, and the call from its `(` to its `)`. Deciding by where the `pageId` lies rewrote
  `navigateTo({ pageType: "generative", pageId: "PAGEREF_detail", data: {valueOf(){return 12;}}/2, r: /\/*$/,
  get [typeKey]() { … } })`, whose getter the guess had hidden, and which navigates as another `pageType`.
  - every raw `PAGEREF_` token at or after the frontier is stray — a recognised call's included — and so is
    the token of a call that reaches it, though the token lies before it. The report names the frontier's
    kind, line and column (`describePageRefLocations`: "after the … ambiguity at …", or "in a call that
    reaches the … ambiguity at …") and says what to change (`pageRefAdvice`: parenthesise the operand or end
    the statement with `;`, move the navigation call above it, or avoid the construct);
  - `resolvePageRefs` rewrites no such call, and a target in one says so (`afterFrontier: true`: some part of
    its call lies at or after the frontier);
  - reverse resolution writes no token there (below), `verify-spec.js` counts no literal there as proof of
    an edge, and the eval scorer refuses one in either phase; promotion, the page build and the scorer
    refuse the tokens through `strayPageRefs`;
  - a refusal that names no token still names the guess: a declared call the lexer could not see is
    "declared-but-absent", which the author cannot act on, so the build's parity halt (`pages-nav-parity`)
    and promotion add `frontierNote(code)` — the kind, line and column of the page's first guess, what it
    could be, and what to change — when the page has one.

  **ASI and the restricted productions are read by the grammar, not guessed**, and each rule is cited at its
  branch in `readPosition`: ECMA-262 §12.10 / §12.10.1
  (<https://tc39.es/ecma262/#sec-automatic-semicolon-insertion>) and TypeScript's parser (`src/compiler/parser.ts`).
  After a line break a `!` is a prefix operator (a postfix non-null assertion needs no break before it:
  `parseMemberExpressionRest`), a `++` or `--` is a prefix increment (`parseUpdateExpression`), and `break`,
  `continue` and `return` end their statement (`canParseSemicolon`), so a `/` after any of them is a regex; on
  the line of an operand the first two are postfix and the `/` divides. A block comment that holds a line
  break is a line break to the grammar. What no grammar rule can settle is a `/` or `<` that follows an
  operand on a LATER line — `type Value = number` then `/re/.exec(x)`: the type context ends the statement
  at the break, an expression would go on — so that is the `newline` kind, as is a `/` after `throw` and a
  line break (an error in JavaScript, `throw;` to TypeScript). The words that start an expression before a
  `/` include `throw`, `default` (`export default /x/`) and `extends` (`class A extends /x/ {}`); a `/` after a
  character that begins nothing in code (`#`, `@`) is a guess (`fallback`), and a quote, a back-tick, a member dot and a name ending in a
  letter beyond ASCII end an operand. A regex or an element is no type, and ASI inserts nothing before a `/` or `<`
  that continues an expression, so after one the lexer read (`const n = /x/` LF `/ 2;`) a `/` divides on any line:
  the `newline` kind is for an operand that could be a type.

  **A `<` where an expression starts is read by TypeScript's own rule for `.tsx`**, from the next two or three
  tokens, not by looking ahead for a `=>`. `isParenthesizedArrowFunctionExpressionWorker` in TypeScript 5.8
  (`src/compiler/parser.ts`, the `LanguageVariant.JSX` branch) treats the `<` as a generic arrow's type
  parameters only when, after an optional `const`, the token after the first identifier is `extends` (and the
  token after that is not `=`, `>` or `/`), or `,` or `=`; otherwise it begins an element — so `<T,>(x: T) => x`,
  `<T extends X>(…) => …` and `<const T,>(…) => …` are arrows, and `<T>`, `<T extends>`, `<T extends/>` and
  `<div data-active={e}>` are elements. A lexer that searched for a parameter list and a later `=>` took the
  JSX text `(a): Title` in `isVisible(<div data-active={e}>(a): Title</div>) ? (() => /navigateTo(…)/.test(t)) : …`
  for parameters, and read the regex after the next arrow as code: a call, whose token was rewritten. Three
  things go beyond the three-token rule, and a test checks each against TypeScript's parser when
  `TYPESCRIPT_ORACLE_PATH` is set. The tokens are read through the trivia TypeScript's scanner skips: comments, and
  white space and line breaks of every kind (`ts.isWhiteSpaceSingleLine` and `ts.isLineBreak`: the no-break space,
  U+0085, U+2028, the zero-width space U+200B, the byte order mark and the rest). JavaScript's `\s` is all of
  them but U+0085 and U+200B, so it is not used (`skipSpaceAndComments`): `<T extends` U+0085 `>text</T>` is an
  element, where a reader that took the character for a token read a generic arrow and the regex after the
  element as code. A test compares the set with TypeScript's over every UTF-16 code unit. The set lives in one
  place (`isTrivia`, `trimTrivia` and `WS` in `source-literals.js`), and the navigation resolver, the structure
  gate and the eval's navigation contract take it from there wherever they skip, trim or split on white space:
  a `\s` or a `trim()` that stands in for it reads a character as a token that TypeScript skips (or the other
  way round), so do not write one where code is read. A `(` that follows a character beyond ASCII that is neither
  trivia nor a letter, a mark or a digit of a name is a token the lexer does not know, so a `)` that closes it is no
  head on nothing but that: a guess (`identifier`).

  **The `>` that closes a cast's type arguments is certain where the cast is** (`castKeywordIsCertain`). After a same-line `as` or
  `satisfies` TypeScript parses a type, and in a type `Name<` is type arguments, so `x as A<B> / 2` divides and `x as A<B> < y`
  compares — whatever else is true of the page. The `as` must be the keyword of a cast: no line break before it (`x` LF `as A<B> / 2`
  is a name `as` after a statement), not a property (`a.as`), not cut short by an escape or a letter beyond ASCII, not after a reserved word that is no
  operand (`break as`, `typeof as`; `this`, `null`, `true` and `false` are operands), and the operand before it must end at a position that is itself no
  guess. The type is walked back from the `<` over a name, a qualified name, closed type arguments, indexes and array brackets, string and signed
  number literals, unions and intersections (a leading operator too) and the false branch of a conditional type; `keyof`, `typeof`, `unique`, `readonly` and parenthesised types are not
  walked, and a cast with one stays the `angle` guess. A `>` run — `>`, `>>`, `>>>` — right after what the lexer knows ended an operand (a cast's closer, an element or a regex it read, or the end of a
  cast's type) is an operator, not the end of type arguments, and an operand follows it, certain too: `x as A<B> > /re/.test(y)`, `<b/> >> 1`. A chain of casts
  is followed up to `CAST_CHAIN_LIMIT` links, past which the guess stands. The mapped type's `as` (`{ [K in keyof T as Foo<K>]: V }`) passes the same
  test, and nothing can follow it there but more of the type, so nothing is read from it.

  *(1) The rule is asked only where an assignment expression starts.* After a unary or binary operator the
  operand is parsed by `parseUpdateExpression`, which tries no arrow, so a `<` and a name begin an element
  whatever follows the name — `a === <T extends X>text</T>` is JSX — and **the token before the `<` decides
  whether the rule is asked** (`ANGLE_AFTER` in `source-literals.js`; the operator is the last token of the run of
  sign characters before the `<`, cut as TypeScript's scanner cuts it, so `a!== <T…>` is `!==` and
  `x! = <T,>…` is a non-null assertion and then `=`). Element, certain: `==` `===` `!=` `!==` `<=` `<<` (after a
  space or a line break) `&` `&&` `|` `||` `^` `??` `%` `/` `*` `**` `+` `-` `!` `~`, and `typeof` `delete` `instanceof`
  `void` `await` (a `/` here is one the lexer read as the division operator: after the end of a regex or of an element no
  `<` is an element, it compares) — but a `*` after `function` is the generator mark, so the `<` opens type parameters, for certain
  (`function* <T>(x: T) {}`: an element there was read as a tag, and the closing tag was then looked for in a string
  or a comment that came after), and a `*` after `yield` (a delegation in a generator, a product outside one) or after
  a word cut short by an escape, `#` or a letter beyond ASCII is a guess. The rule: `=` and the compound assignments
  (`<<=` included), `=>` `,` `;` `:` `?` `(` `[` `{` `)` `}`, and `return` `throw` `case` `default` `else` `do` `yield`
  `of` `new` `extends` (and `break` and `continue` before a line break). After `async` with the `<` on its line the `<` is never an
  element: `isParenthesizedArrowFunctionExpressionWorker` answers True for the generic shapes — an async arrow with type
  parameters — and False for the rest, and `async` is then a method named `async` that has type parameters (an
  object literal's or a class's: `async<T>(x: T) { … }`) or the identifier, before a comparison or the type arguments of a call.
  So the text after the `<` is code, for certain, whatever the rule reads of its head (`async <T>text</T>` and
  `async <div>x</div>` parse in no reading as an element); after a line break the guess stays (`keyword`). A `>` that does not end `=>` is the `angle` guess,
  reported before the table is asked, and a run of `>` before a `=` is cut as one the lexer cannot make: the parser
  takes the first `>` for the end of type arguments where it can (`x as A<B>>= y` is `x as A<B>`, then `>=`), so
  `>=`, `>>=` and `>>>=` are each a guess, whatever the operator would be if the first `>` were not a closer.
  A guess, `operator`: those three (`a >= <T extends X>…`, or the end of type arguments and an initialiser,
  `let x: A<number>= <T extends X>(y: T): T => y`, or a shift assignment, `a >>= <T extends X>(y: T): T => y`), a `<`
  after a space (`a < <T extends X>(y: T): T</T>`), `in`
  (`"a" in <T extends X>…`, or `for (k in <T extends X>(y: T): T => y)`) and `yield *`; `newline`: `void` before a line
  break (the operator, or a type that the break ended: `let x: void` LF `<T extends X>(y: T): T => y`). In each the
  element is read, and the guess is reported only where the text after the `<` leaves both readings open. A head
  that cannot be an element — `<T,>`, `<T = X>`, or a parameter list and an arrow whose element reading fails (3) —
  is type parameters whatever stands before it, so nothing is guessed (`elementReadingFails`): after a `<` that is
  how `f< <T extends X>(y: T) => T>()` is read, a function type for a type argument. A head with a
  constraint and no parameter list, `<T extends X>text</T>`, is an element in every program that parses, since an
  arrow wants its parameters (`const k = <T extends X>text</T>` is an error), so after `<`, `in`, `yield *`, `void`
  with a line break and the cut `>=` family it is read as one, with no guess (`headWithoutParameterList`) — which rests
  on the tag reading and the type-parameter reading of the head ending at the same `>`. They do, in every head the
  tag reading accepts, but for a string: an attribute's value is a JSX string, with no escapes, and a type parameter's
  default is a JavaScript string, with them, so `<T extends X="\">">(x)=>x` is an arrow whose default is `"\">"` and a tag
  that ends at the `>` after `"\"`. A head that holds a backslash is therefore not decided, and the guess stays (a
  comment, a nested `<`, a `=>` or a character beyond ASCII outside a string are not in a head the tag reading accepts,
  and the first `>` that no list of tag type arguments holds ends both). What stays
  a guess is the head with a constraint, a parameter list and a `:`:
  JSX text, or an arrow's return type, which compile wherever an arrow may stand (after a `<` only the text does,
  which the lexer does not tell). A token that is in
  none of the classes is a guess too, and the oracle test fails for a punctuator or keyword that is neither in the
  table nor on its list of tokens the table is never asked about, so a new one cannot arrive unclassified.

  *(2) `await` and `yield` are not identifiers in every function.* The rule asks whether the first name is an
  identifier (`isIdentifier()`), and it is not for `await` in an async function (or at the top level of a module) nor
  for `yield` in a generator: there `<await extends X>text</await>` is an element, where outside them it is a
  generic arrow. The lexer does not track the function, so a `<` followed by either word is a guess (`generic`),
  and the element is read. The name after `const` is not asked about, so `<const await extends X>` stays with the
  rule.

  *(3) A generic function type is certain wherever the element reading of its text cannot parse.* What the rule
  does not say is what a TYPE does. A `<Name>` followed by a parameter list and `=>` is a generic function type
  (`const a: <T>(x: Array<T>) => T = f`, `onPick: <K>(key: K) => void`, `type H<A> = <T>(x: T) => T`) or, in an
  expression, an element whose text holds an arrow — and in a `.tsx` file there is no other reading. So it is a
  type, for certain, wherever the element reading **provably fails to parse**: no page that compiles has an element
  there (`elementFailsAt`). The text from the `>` of `<Name>` to the arrow is read the way TypeScript reads the
  children of an element, token by token, and the reading fails on what TypeScript 5.8 rejects: a `>` in the
  text, at any depth — the arrow's own, a nested arrow's, the `>` that ends the tag of `Array<T>` (TS1382); a `}`
  (TS1381); an expression container that starts with a name, a number or a quoted name and a colon, `{ label: T }`
  and `{ 'a': T }` (TS1005), or with a name, a `?` and a colon, `{ a?: T }` (TS1109); one that starts with two names
  side by side, `{ readonly a: T }` (no expression is two names, but `typeof a`, `a in b`, `a as T` and `async a => a`
  are, and are not read as one), with a bracket and a colon, `{ [k: string]: T }` and `{ [K in keyof T]: T }`, or
  with a call and a colon, `{ m(x: T): T }` and `{ new (x: T): T }` (TS1005) — and a quoted name is a string, which
  is called as a name is: `{ 'm'(x: T): T }` and `{ "m"(): T }` fail at the same token, the string read with its
  escapes (`{ 'a\'b'(x: T): T }`), which a JSX string has none of; and a container that holds nothing a
  `}` could hide — no brace, quote, back-tick, backslash or `<`, and no `/` but a comment's — which is skipped to its first `}`, because
  an expression ends there and TypeScript reports an error inside anything else before it reaches a later name
  (`{ a }`, `{}`, `{ a, b }`, `{ ...a }`, `{ a + b }`). A comment is trivia to TypeScript's scanner wherever one may stand between two
  tokens, so it is passed over whole where a container is read, and a `}` in it ends nothing: `{ /* c */ readonly a: T }` is read as `{ readonly a: T }` is
  (`skipTagTrivia`; a comment that the window ends in leaves the container unread). In a tag's own head, a `<` and a character that cannot start
  a tag name, `Array<{ a: T }>` and `Array<(y: T) => void>`, or a tag name and a token that is no attribute,
  `Record<string, T>`, `Array<T[]>` and `Array<T | U>`, or a `<` after an attribute, `<T extends A<B>>`, is TS1003,
  and a `{` where an attribute may start that is no spread, `<T extends { a: string }>`, is TS1005. A tag's own type
  arguments are read when they are only names, dots and commas, so `Array<Array<T>>` is decided too. Nothing else is
  claimed, and a test checks each class against TypeScript's
  parser, and a differential fuzz checks every verdict against it (`tests/jsx-element-reading.test.js`; its
  alphabets hold white space of every kind TypeScript skips — which an ASCII-only fuzz cannot reach — and the
  test asserts that each kind was put next to an `=` and into the heads of valid function types, and that quoted method signatures were put into their object types). **Where the reading
  cannot show the failure** — the arrow lies inside a tag or an attribute string (a JSX attribute string has no
  escapes, so `<Wrapper>(<Child x="\" y=") =>" />)</Wrapper>` is one JsxElement with no diagnostic); the text holds
  a closing tag, a fragment, a comment, a spread, a name with a `-` or a `:`, or an attribute string that does not
  follow its `=` at once (TypeScript scans `x = "a\"` as a JavaScript string, with escapes); a character beyond
  ASCII where a token could start or end in a tag — TypeScript's scanner skips trivia between a tag's tokens, and
  before an attribute value that does not follow its `=` at once, so `x=` U+00A0 `"a"` is an attribute with a value,
  and such a character may hide a tag name, a value or a colon; or a container holds a brace, a quote, a
  back-tick, a `/`, a backslash or a `<` and is none of the shapes above (`{ a = {} }`, an optional or generic quoted
  method `{ 'a'?(y: T): T }` and `{ 'a'<U>(y: U): T }`, a call signature with type parameters, `{ <U>(y: U): T }`) — it is read as the
  TYPE it almost always is, and the guess `generic` is reported at the `<`: the page is complete to the structure
  gate, and a navigation call after it is refused, naming the kind. A constraint makes it the rule's
  (`<K extends keyof V>(…) => …` is a generic, for certain). A certain function type is read as code, so a page
  that holds one is as complete to the structure gate as any other. What stays two-way, with the element read,
  is a `:` after the parameter list — a call signature
  (`interface I { <T>(x: T): T }`) and JSX text (`<span>(required): Name</span>`) both compile — and a parameter
  list too long to scan: the guess `generic`, and everything after it not trusted. One place settles even those: **directly after the head of a type alias, `type Name =` at a
  statement start** (after any `export` and `declare`), where `type Name` — two names side by side — cannot be
  an expression, so a `<` is a function type's type parameters, for certain, whatever follows it
  (`afterTypeAliasHead`; a head with type parameters, `type Fn<A> =`, is not read, and its right side is decided
  by the shape alone).

  *(4) A parameter list that neither `=>` nor `:` follows is a call signature or JSX text, and what comes after it
  tells which.* `<T>(x)` is the text of an element that starts with a parenthesis in an expression
  (`<b>(optional)</b>`) and, where a type holds members, a call or construct signature with no return type
  (`interface I { <T>(x) }`, `type L = { <T>(x); m: { a: string } }`, `interface C { new <T>(x) }`); TypeScript parses
  both with no diagnostic. A lexer that read the signature as an element read the rest of the type as text up to a
  closing tag that it found in a string or a comment after it — `const s = '</T>;navigateTo({ … });//'` — and the text
  of a call in that string was then a real call, whose token was rewritten. So the two are told apart
  (`callSignatureOrElement`), by two things. *A signature ends its member where TypeScript wants it to*: after the
  `)` comes a `,`, `;` or `}`, the end of the source, or a token on a later line (`parseTypeMemberSemicolon`,
  `canParseSemicolon`; a line break is a line feed, a carriage return, U+2028 or U+2029, in a comment too, and not
  U+0085, U+00A0 or the like). Where anything else follows on the line — a name, a `<`, a `(`, a `{`, a comment with
  no line break — no signature stands there and it is an element, for certain, and so it is where a closing tag
  follows (`</` is one token in a `.tsx` file): `<b>(optional)</b>`, `<p>({t("label")})</p>`,
  `<span>(total: {count})</span>` are decided by that token alone. *Where the member may end there, the text after
  `<Name>` is read as the children of an element up to its closing tag*, as (3) reads it up to an arrow (`readChildren`
  with a closing name): the nested elements are followed, each closed by its own closing tag, a nested tag's attribute
  containers and spreads are skipped, and an expression container that holds strings and balanced braces is skipped
  exactly, the strings read with their escapes (`{t("label")}`, `{"a}"}`, `{{ color: "red" }}`). A **failure** — a `}`
  or a `>` in the text, a closing tag that is not the open element's, a `</*` (TS1003 to an element; the `<` and the
  comment of the next signature's type parameters to a type) — means no page that parses has an element there, so it is
  a signature and code, for certain: the `}` that ends the type is the usual one. **A closing tag reached decides nothing by
  itself**: a type holds `</T>` in a string, and the text through it is the same in both programs — `interface I { <T>(x: "</T>") }`
  is a call signature and `const e = <T>(x: "</T>;` is an element, with no diagnostic in either. So the same text, from the
  `)` on, is scanned as the type would scan it, as code: a string, a template, a comment or a regex that the text opens and that
  is not closed before the closing tag hides it (`hideable`), and where none is open at the closing tag, the tag is code in the type
  reading too, no type reads `</` as code, and the element is the only reading: certain (`<b>(optional)</b>`, `<span>(total: {count})</span>`,
  `<p>({t("label")})</p>`, nested children). What opens one: a back-tick (a template with a `${`, which opens code that is not read, may), a `//` or a `/*`,
  a `/` that no word or number stands before and that so may start a regex, and a quote that starts a string closing on its line and covers the
  closing tag (a quote right after a word that is no keyword, an apostrophe or an inch mark, opens none). Where the text up to the first
  such opener cannot be the members of a type, though — two names on a line, a name and a `/`, a name and a quote (`<p>(a), see https://x.y</p>`: TS1005 in a type) —
  no type holds the closing tag in anything, nothing that follows can hide it, and it is an element (`typeMembersFail`; a word that may be a modifier or any other
  character leaves it undecided). Where one is open at the closing tag, or the reading cannot say (a container or a tag it
  does not read, a window of 2,000 characters, a spent budget), both programs compile and the text up to the decision
  is the same: the guess `generic`, and the element is read. A type of *k* signatures reads the rest of the type for
  each, up to the window, so a pass has a budget of characters to read (`READING_BUDGET_PER_CHAR` for each character of
  the source and a base for short ones); where it is spent a reading says nothing, which is the guess, and the pass
  stays linear. A `:` after the list is not settled this way: it is the guess above (`interface I { <T>(x: T): T }` and
  `<span>(required): Name</span>`). The fuzz of this reading puts the same text into a type and into an element and
  asks TypeScript which parse (`signaturePrograms` in `tests/helpers/jsx-element-fuzz.js`).
  The kinds, each with the raw example that makes the reading a guess (`AMBIGUITY_KINDS`; a test refuses a kind
  that has no wording in the report):

  | kind | what the lexer cannot tell | example |
  |---|---|---|
  | `brace` | `}` ends a block (a `/` then starts a regex) or an object/function expression (it divides) | `{valueOf(){return 12;}}/2; … /x/` |
  | `paren` | `)` ends an `if`/`for`/`while` head (a regex follows) or an operand, and its `(` is beyond the 2,000-character look-behind | `if (true /* …2,100 chars… */) /re/.test(x)` |
  | `keyword` | a word that is a keyword in some places and a name in others (`of` `await` `yield` `let` `async` `static` `get` `set` `as` `satisfies` `type` `from` `declare` `abstract` `readonly` `keyof` `infer` `is` `asserts` `override` `accessor` `using` `out` `module` `namespace` `global` `unique` `implements`) | `const of = 12; of/2; … /x/` |
  | `angle` | a `>` closes type arguments, a JSX tag or a comparison; the `>` of `=>`, the closer of a cast the lexer proves is one (`castKeywordIsCertain`) and the end of an element or a regex it read are certain, and so is a `>` run after one of those — and any other `>` before a `/` or a `<` is reported | `total as Types . Alias<number> / 2`, `f<A> / x / 2` |
  | `identifier` | an identifier written with a `\u` escape, or a word cut short by `#` or a non-ASCII letter; a `)` whose `(` follows a character beyond ASCII that is neither trivia nor part of a name (a token the lexer does not know, so "no head" would rest on nothing) | `Al\u0069as<number> / 2` |
  | `operator` | a `/` after `...` or after a run of three signs; the second `<` of a shift, before a name; a `<` that opens a generic with a constraint right after `>=`, `>>=` or `>>>=` (the first `>` may end type arguments), after a `<`, after `in` or after `yield *`, where the text after it leaves both readings open — the element of a comparison, a test or a product, or the type parameters of an arrow: a parameter list that a `:` follows, or a head the reading cannot settle | `[.../a/.exec(s)]`, `a+++/x/`, `1<<n`, `a >= <T extends X>(y: T): T</T>`, `let x: A<number>= <T extends X>(y: T): T => y`, `a >>= <T extends X>(y: T): T => y`, `a < <T extends X>(y: T): T</T>`, `for (k in <T extends X>(y: T): T => y)`, `yield* <T extends X>(y: T): T => y` |
  | `newline` | a `/` or `<` on a later line than the operand before it (name, literal, `)` `]` `}` `>`), a `/` after `throw` and a line break, or a `<` that opens a generic with a constraint after `void` and a line break: ASI may have ended the statement there | `type Value = number` LF `/re/.exec(x)`, `let x: void` LF `<T extends X>(y: T): T => y` |
  | `jsx-type-arguments` | a JSX element whose type arguments hold a string, template, object or function type: TypeScript's rules apply there and the tag is scanned by a JSX attribute's | `<Component<"quote\"\<LF>/*"> …/>` |
  | `jsx-attribute` | a JSX attribute value whose quote does not follow its `=` at once (white space or a comment stands between them) and whose text holds a backslash: TypeScript scans it as a JavaScript string, with escapes, and other compilers as a JSX string, with none, so the two end it at different quotes and read different calls after it | `<C x= '\'/>;navigateTo(…);//' />` |
  | `jsx-open` | a `<` where an element may start that is not read as one (a space after it, or a name beyond ASCII: in code, in JSX text and as an attribute's value), or a closing tag that holds anything but trivia, comments and a name (dotted, or namespaced) before its `>`, so that where it ends is not known | `< div>x</div>`, `<A x=< B/>>…</A>`, `<A></A b>` |
  | `generic` | `<Name>` and a parameter list followed by `:`, which is the call signature of a type or JSX text that starts with a parenthesis (both compile); or one followed by no return type, where a string, a template, a comment or a regex after it could hold its closing tag, or its text cannot be read to the end of an element, or the pass's budget of readings is spent (a signature with no return type is otherwise code, for certain, and JSX text that starts with a parenthesis an element: `callSignatureOrElement`); or a parameter list too long to scan (2,000 characters) — except directly after `type Name =`, where it is certainly a type. A `=>` after the list is a generic function type for certain when the element reading of the text up to the arrow cannot parse (`elementFailsAt`: a `>` or `}` in the text, a container that starts with a name, a number or a quoted name and a colon, two names, a bracket, a call or a quoted name and a call and a colon, a `<` and a character that cannot start a tag, …), and a guess, read as a type, when it may: the arrow inside the attribute string of a nested tag (TypeScript scans a JSX attribute string with no escapes), a closing tag, a fragment, a spread, a comment, an attribute value that does not follow its `=` at once, a character beyond ASCII where a token could start or end in a tag, or a container that holds a brace, a quote, a back-tick, a `/`, a backslash or a `<` and none of the shapes `elementFailsAt` knows; a `<` followed by `await` or `yield`, which are identifiers or not by the function around them | `interface I { <T>(x: T): T }`, `interface I { <T>(x); m: '</T>' }`, `<span>(required): Name</span>`, `<p>(a), b/c</p>`, `const f: <T>({ a = {} }: P) => T = g`, `const f: <T>(x: { 'a'?(y: T): T }) => T = g`, `<Wrapper>(<Child x="\" y=") =>" />)</Wrapper>`, `async function p() { <await extends X>t</await> }` |
  | `fallback` | a quote with no closing quote on its line, read as an ordinary character; a `/` after a character that begins nothing in code | `const a = 'unterminated`, `# / 2 / 3` |

  Names alone in a tag's type arguments (`<DataGridRow<Row>`, `<Select<string | number>`) are certain: the scan
  and TypeScript agree, and the shipped samples use them. **When you change the lexer, a new judgement that
  rests on a heuristic must report itself, or be documented as certain in the table above `readPosition` in
  `source-literals.js`** — the aim is to stop finding these one class at a time. An identifier written with a
  `\u` escape in code is a frontier wherever it is, so a call spelled `navigate\u0054o(…)` is refused (escapes
  inside a quoted key are inside a string and are certain). Both defences are independent: the frontier
  and the residual net below. `tests/ambiguity-sweep.test.js` holds
  the soundness claim as a property — *a page that is not refused does what the original did, with each token
  its page id* — over a construct per kind × payloads, with line breaks around `!`, `++` and `--`, the
  restricted keywords, type aliases with no semicolon, templates whose lines start with `//` and hold a
  `${}`, and calls with a guess inside the options object and a getter, computed key or spread after it:
  plain-JavaScript pages are run, original and resolved, and compared (a call counts as navigation by its
  `pageType` at run time); with `TYPESCRIPT_ORACLE_PATH` set, TypeScript pages are checked against which calls
  the TypeScript parser says are real (unset, that part skips). With the oracle set, a second sweep puts **every
  punctuator and keyword TypeScript has** before a `<` — adjacent, after a space, after a line break — in front of an
  element, two generic arrows and four function types (plain, and with a type argument, an object type and a
  comma between type arguments in the parameter list), in about fifty frames (an operand, a head, a statement, a type
  …), each followed on the line by a regex that holds the text of a navigation call and then a real call
  (`tests/helpers/angle-frames.js`): wherever TypeScript parses the program and reads a regex, the token in it
  is never rewritten and the page is never accepted. And `source-literals.test.js` checks the table of tokens
  before a `<` (`ANGLE_AFTER`) against TypeScript: every token is classified or listed as one the table is
  never asked about, each class is how TypeScript reads a `<` after it, and the lexer never reads an element's
  text as code without reporting a guess. Further sweeps run against TypeScript's parser with every trivia
  character TypeScript skips between a token and a `<` or a `/`, in the head of a statement and before its regex,
  and with a `*` before a `<` (a generator mark, a delegation and a product), with a string in the head of a
  function after each token that leaves a head undecided (a backslash in it), an element as an attribute's value, a comment in a
  closing tag and a closing tag's name with a `:` or a `.` and trivia around it, a self-closing tag with trivia of every kind between its `/` and
  its `>` (in a plain tag, one with attributes, an attribute's value, a fragment, nested children), a hashbang, a regex with flags (valid, unknown, and beyond ASCII), a `/` or
  `<` after a regex, an element or a division the lexer read, a `/` or `<` after every shape of cast (and a `>` run after its closer), a comment in an object
  type, `async` before a `<`, and a
  call or construct signature with no return type and JSX text that starts with a parenthesis (each in every place a type
  with members or an element stands, followed by every ending that ends a member or goes on to another, and by a decoy —
  a string, a template, a comment or a regex that holds the closing tag of its head and the text of a call, and a type that
  holds the closing tag in a string as the text of a call signature's parameter)
  — each read token by token against TypeScript's parser — and a differential fuzz
  (`tests/jsx-element-reading.test.js`; `JSX_FUZZ_SCALE` multiplies it) checks every verdict of the element
  reading of a head and of a function type against it, and puts the text after a parameter list that neither an arrow
  nor a colon follows into a type and into an element, where TypeScript says which parse: a type that parses is never
  read as an element for certain, nor an element that parses as code, and an element with nothing a closing tag could
  hide in is never a guess. Where `BABEL_ORACLE_PATH` points at an `@babel/parser`
  package, the sweep of JSX attribute strings that follow trivia also parses each page with Babel — which reads
  such a string with no escapes, as TypeScript does not — and the lexer must have named the guess
  (`jsx-attribute`) on every page the two read differently.
  **`tests/valid-page-differential.test.js` is the regression net for what the rules refuse.** Its pages are
  programs TypeScript parses (`tests/helpers/valid-pages.js`: generic arrows and function expressions in every
  position, casts and `satisfies` with every operator and operand after them, instantiation expressions, elements whose
  text starts with a parenthesis, interfaces and type literals with every member form (call and construct signatures with
  and without a return type), generic function types in every position and with every kind of
  parameter list, and the statements an everyday page is made of (regexes with flags, tags with trivia between their `/` and `>`, closing tags with a spaced or dotted name, a comment in an object type), each with a navigation call after it and read
  again with the text of a call in data after it (a regex, a string of closing tags). The data is never
  rewritten; every page that is refused names its guess and belongs to a **recorded class** — the cases where two
  programs share the text up to the decision and compile differently, shown by a pair in the test — and a page
  in no class, or a class that no page meets, fails it. Where `BASE_LIB_PATH` points at the `scripts/lib` of an
  earlier lexer, the pages are read by that one too, and the test counts what each resolves and the data each
  rewrites. When a change makes the lexer refuse a shape it resolved, this is where it shows: add the shape to
  the generator, and either fix the rule or record the class with the pair that justifies it.
- **The residual net does not depend on the lexer, and has no exemption.** After forward resolution the
  RESOLVED source is read again — the copy can read differently from the source, because each token became a
  longer page id, which can move a `(` out of the look-behind — as plain text: any `PAGEREF_` token left in it
  is refused (`pages-stray-pageref`), a comment's included. Nothing is exempt, so there is nothing for the
  lexer to be wrong about; the net can fire only on what the checks before it missed (a dangling target, a
  call that reaches the frontier, a page id that itself holds token-shaped text). The page build checks
  `residual` after resolution — after the targets were minted, because the copy needs their ids, and before
  any page is updated with it.
- **Reverse resolution never changes quoting, writes only what the forward path takes, and reports every id it
  leaves.** It turns a deployed id back into
  `"PAGEREF_<key>"` only for a **double-quoted** literal — what a build writes — in a call the checker trusts
  (wholly before the frontier). A single-quoted or back-ticked id, and one in a call that is not trusted, is left as
  the id. **It then reads what it would write the way the forward path reads it.** A token is usually longer than
  the id it replaces (`"<36 characters>"` against `"PAGEREF_<a long key>"`), so the code after it moves, and
  the lexer's bounded windows — the 2,000 characters it looks back for the `(` of an `if` head — can end before the
  construct they look for: a head read for certain with ids is a `paren` guess with tokens, after which promotion
  and the build refuse every call, with nothing said at the download. So the result is analysed (`rebuildRefusal`)
  and every token written must be the canonical `pageId` of a call the forward path trusts — a `pageref` with the
  key written, wholly before any frontier the result has — and must not sit inside another call's `pageId` value
  that is not a literal (`pageId: pick(navigateTo({ … "PAGEREF_x" }))`), which the forward path reports as malformed
  and the build halts on. If one is not, **nothing is written for the page**: it keeps its
  ids (a half-tokenised page is refused all the same), and every known id in it is reported with
  `why: 'would-not-rebuild'` and, when a frontier is to blame, `frontier: { kind, line, column }` in the columns of
  the page as it is. A token the page already held is not this check's business; only what reverse resolution
  writes decides. The invariant — *whatever reverse resolution writes, the forward path accepts unchanged, and
  resolving it gives the page back* — is tested across the look-behind boundary (`pageref-resolver.test.js`), over
  every sweep program with a short and a long key (`ambiguity-sweep.test.js`), and through a download. Then the
  RESULT is scanned as text for every known page id (whole, case-insensitive), and each one
  still in it is reported in `reverseResolveNavIdsReport` → `left: [{ id, key, line, column, why }]`, whether
  a recognised call holds it or not: `why` is `'quote'` (a recognised literal in other quotes), `'frontier'`
  (at or after the frontier, or in a call that reaches it; with `frontier: { kind, line, column }`, and
  `reaches: true` for the second), `'text'` (anything else: a record id, a string, a comment, an object
  built in a variable) or `'would-not-rebuild'` (above). The list comes from the text and not from the recognised
  calls because a frontier can
  hide a call, whose id then stays with nothing recognised to report it. `download-model-app.js` writes a
  `WARNING:` to stderr whenever any remains and returns `navIdsLeft`: a navigation call that keeps an id is a
  hardcoded page id, which a rebuild refuses; an id that is data can stay. What this closes: a single-quoted id
  inside a double-quoted string that the lexer had read as code became `"PAGEREF_detail"` and ended the string.
- Targets come back in source order (resolve and reverse build their output in one left-to-right pass).
- It is **linear in time and memory**: the brackets are matched once per source (a table, both directions), and
  each call's object is scanned for its own members only, jumping nested groups — never re-copied or
  re-scanned per call. A chain of n nested calls once cost n². A malformed value holds a **range of indexes**
  into the source's one sorted token list (`tokenFrom`, `tokenTo`), never a copy of its tokens — copying each
  value's tokens would grow as n²/2 (n = 8,192: 33.5 million entries, 256 MiB), so a value holds two indexes
  into the shared list — and `navMalformedRefs` reads each token once. The `performance:` tests in
  `genpage-lexer-hardening.test.js` guard the ratios and the size of what a result keeps alive. Keep any new
  scan on those tables.

Judge changes to it by **both** error directions, and weight them correctly:
- a false **accept** promotes prose as a page, and promotion is sticky — the page is then
  marked implemented and skipped on retry;
- a false **reject** blocks a real user mid-build, which is worse, because their page was
  fine.

`scripts/tests/source-literals.test.js` carries a **false-positive corpus** over every
committed `.tsx` in `samples/` and `evals/model-apps/genpage/fixtures/` (enumerated via
`git ls-files`, so it does not race the transient fixture dirs `capture-fixture.test.js`
creates). Two lexer bugs were invisible to hand-written cases and caught only by that
corpus — keep it, and add to it rather than around it. The worker-output gate
(`genpage-worker-output.test.js`) and the icon hook (`validate-icon-imports.test.js`, samples
only) run the same kind of corpus: every committed page must pass them, because a false reject
there throws away a good page or blocks a pattern the page builder was told to copy.

Residual limits, accepted deliberately:
- **`<` disambiguation is TypeScript's own rule for `.tsx`, which is structural, not semantic.** Where an
  assignment expression starts, a `<` opens a generic arrow's type parameters only by the rule above (a `,`, an
  `=`, or `extends` and a token that is not `=`, `>` or `/`); anything else is an element — and after a unary or
  binary operator it is an element whatever follows (the token before the `<` decides: `ANGLE_AFTER`). A page
  that wants a generic arrow writes `<T,>(x: T) => x` — as TypeScript requires in `.tsx`. A generic function type,
  `<T>(x: T) => T`, is a type wherever it stands when the element reading of its text cannot parse (`elementFailsAt`:
  a `>` or `}` in the text, a container that starts with a name, a number or a quoted name and a colon, two names, a
  bracket, a call or a quoted name and a call and a colon, a `<` and a character that cannot start a tag, …), which covers a type argument, an
  object type with named members, an index signature, `{ readonly a: T }`, a destructured parameter and a comma
  between type arguments in its parameter list. **What the reading cannot show to fail is a guess**: a parameter
  list whose object type holds a brace, a quote, a back-tick, a `/`, a backslash or a `<` in a shape the reading
  does not know (`{ a = {} }`, an optional or generic quoted method `{ 'a'?(y: T): T }`, a generic call signature `{ <U>(x: U): T }`),
  a tag name with a `-` (`Array<a-b>`), or white space beyond ASCII inside a tag, outside the
  right side of `type Name =`, is read as
  the type it almost always is and the guess `generic` is reported at the `<`: the page is complete, and a navigation
  call after it is refused, naming the guess (put the call before it, or give the member a name and a colon
  first). A shape the rule cannot settle at all (a signature followed by `:`) is the `generic` kind, never a certain
  one — except directly after `type Name =`, where nothing but a type can stand. A navigation call after one is
  refused naming the guess, and a page that holds a call signature in an interface is read as an element whose text
  runs on, which the structure gate refuses as truncated, as it always has; JSX text that starts with a parenthesis
  and a colon is read right, and only the call after it is refused. Put the call before the construct. A call or
  construct signature with no return type is not that shape: it is code, for certain, and JSX text that starts with a
  parenthesis an element, wherever what follows the `)` or the text read to its closing tag shows it (4); only a type
  that holds its own closing tag in a string, a template, a comment or a regex, or text the reading cannot take to an end, is the guess.
- **Valid pages that are refused, each in a recorded class** (`valid-page-differential.test.js`): the lexer refuses
  a page only where two programs share the text up to the decision and compile differently. A `>` that is not the end of `=>`, closes no cast the lexer can prove and ends no element or regex it read,
  before a `/` or a `<` (`angle`: `a > /re/` is a comparison and a regex, `f<A> / x / 2` is type arguments and a division, and only a type parser tells whether what stands between
  the `<` and the `>` is a list of types); a generic call signature with a return type in an object type, which is JSX
  text that starts with a parenthesis and a colon in an expression, a call signature with no return type whose type holds
  its own closing tag in a string, a template or a comment, which is an element that ends there, and JSX text that starts with a parenthesis and then holds a `//`, a `/*` or a
  template after a separator, which is the comment or the template of a type's members that holds the closing tag (`generic`); and a `/` on a later line than its operand
  (`newline`). A `/` or `<` that follows a `/` is no class of its own: where the lexer read the regex (flags included), the element or
  the division itself, it knows what ended there (`ends` in `lexInto`), and the page resolves — and so does a cast it proves (`castKeywordIsCertain`). What stays the `angle` guess among casts is a limit of the walk back over the type, not a place where two programs share
  their text — TypeScript reads each of these one way: a type that begins with `keyof`, `typeof`, `unique` or `readonly`, or is parenthesised; a `>>` that touches a cast's closer (`x as A<B>> / 2`); a chain past `CAST_CHAIN_LIMIT`; and, as the `newline` guess, a line break after a cast type that ends in a name or a `]`.
  A head with a constraint and a parameter list that a `:` follows, after the cut `>=`, `>>=` or `>>>=`,
  is the same kind of place (`operator`: `a >= <T extends X>(y: T): T</T>` is an element,
  `let x: A<number>= <T extends X>(y: T): T => y` an arrow); no generated page has it, so a pair of programs stands
  for it. Each says which it is and what to change in the report, and nearly every other page that compiles resolves.
- **A JSX attribute string after trivia is a guess when its text holds a backslash** (`jsx-attribute`): TypeScript
  reads a quote that does not follow its `=` at once as a JavaScript string, with escapes, and Babel and esbuild
  read a JSX string with none, so a page whose string ends at different quotes in the two does different things
  with the text after it, and neither reading is trusted. Write the value right after the `=`. An element or a
  fragment written as an attribute's value (`x=<B/>`, `x= <B>…</B>`) is not part of this: it is read exactly, as
  TypeScript's `parseJsxAttribute` does (`parseJsxElementOrSelfClosingElementOrFragment` for the value), so the
  `>` that ends it is the one that ends it and no token inside it is taken for code; only a `<` there that cannot
  start an element (`x=< B/>`) is the `jsx-open` guess.
- **Look-ahead is bounded** (`LOOKAHEAD`, 2,000 chars) so a stray `<` or `)` cannot walk the file. Where a window
  runs out the decision is a guess and reports itself (`paren`, `angle` or `generic`): a navigation call after
  it is not trusted, and its token is reported rather than rewritten.

None of these shapes occurs in the committed corpus (the test over it asserts that no page reports a guess),
and each fails *loudly* (exit 3, retryable) rather than silently. If you hit one, widen the tests first.

## Hooks & Validators

Hooks are registered centrally in `hooks/hooks.json` (auto-loaded by the plugin
host). Validators **fail open** on any internal error (exit 0). The icon validator
blocks only on a real generated-page violation (exit 2); the write-safety guard is
non-blocking by design (exit 1), so hook bugs do not break `/genpage` or
`/app-builder` authoring.

- **PostToolUse(Skill)** — `run-skill-posttool-validation.js` runs a skill's
  `skills/<skill>/scripts/validate*.js` when present. Tracked skills are discovered
  from `skills/*/SKILL.md` by `scripts/lib/modelapps-hook-utils.js`, so both
  `/genpage` and `/app-builder` are tracked automatically (the telemetry control
  skill is excluded from tracking).
- **PostToolUse(Write|Edit|MultiEdit)** — `validate-icon-imports.js` validates
  `@fluentui/react-icons` named imports in generated `.tsx` pages against
  `references/verified-icons.txt`, automating the page-builder's manual grep. It is
  gated to generated-page output (the file's `export default GeneratedComponent`
  marker) or plugin-specific sibling markers (`genpage-plan.md` or
  `model-app-plan.md`). It intentionally does **not** use `app-spec.json` as a
  sibling marker because this validator blocks (exit 2) and `app-spec.json` is too
  generic for a globally installed hook.
- **PreToolUse(Write|Edit|MultiEdit)** — `validate-write-safety.js` **flags
  (non-blocking, exit 1)** writes outside the cwd, and only during an active
  model-apps authoring session (`genpage-plan.md`, `model-app-plan.md`, or
  `app-spec.json` at/under cwd). It accepts `app-spec.json` because a false
  positive only warns; it never blocks and is a clean no-op in unrelated projects.
  Silence with `MODEL_APPS_SKIP_WRITE_GUARD=1`.
- **Master kill-switch** — `MODEL_APPS_DISABLE_HOOKS=1` (or `true`) disables **all**
  model-apps hooks (validators + telemetry emit); checked before any stdin/work.
  Both escape hatches are documented in `README.md`.

## Telemetry

This plugin ships 1DS telemetry for `skill_started`. The canonical library is the
repo-root `shared/telemetry/`; `scripts/lib/telemetry/lib` is a **physical copy**
(never a symlink) so installed plugins don't depend on symlink handling. Edit
`shared/telemetry/lib/` first, then refresh this plugin's copy in the same change.

- **Posture:** the committed `ikey.json` ships **`disabled: true`** (Tier-1 static,
  no resolver) — currently carrying the **provisioned model-apps key + collector +
  `event_stream_name`, staged disabled**. It emits nothing — no POST, no local log —
  while `disabled: true`; flip `disabled` to `false` only after the Geneva mapping
  is validated in DGrep (see the ADE provisioning runbook). `disabled: true` is the
  active guard; the placeholder-key gate is a secondary defense for un-provisioned
  copies. **Provision a fresh key; never copy another plugin's `ikey.json`**
  (CI-enforced: `node scripts/validate-telemetry-ikeys.js`).
- **Emission:** `hooks/run-skill-pretool-telemetry.js` (PreToolUse Skill) and
  `hooks/run-user-prompt-telemetry.js` (UserPromptSubmit `/model-apps:<skill>`).
- **Privacy:** while `disabled: true` nothing is built, sent or mirrored (see Posture). Once
  enabled, telemetry is default-on: events can include Dataverse organization and Entra tenant GUIDs
  when PAC is signed in, never the signed-in user's Entra object ID, and the local diagnostic mirror
  (`~/.power-platform-skills/telemetry/model-apps/sessions/<id>/events.jsonl`) retains the same
  fields — it is still written after a user opts out of transmission via
  `/model-apps:telemetry off`. CI/automation opt out via
  `POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT=1` (highest precedence).
- **Fail closed:** telemetry never changes a script's exit code; emission is
  fire-and-forget via a detached dispatcher child. See `shared/telemetry/README.md`.

## Development Standards

- **React 17 + TypeScript** — all generated code
- **Fluent UI V9** — `@fluentui/react-components` exclusively (DatePicker from `@fluentui/react-datepicker-compat`, TimePicker from `@fluentui/react-timepicker-compat`)
- **Single file architecture** — all components, utilities, styles in one `.tsx` file
- **No external libraries** — only React, Fluent UI V9, approved Fluent icons, D3.js for charts
- **Type-safe DataAPI** — use RuntimeTypes when Dataverse entities are involved
- **Responsive design** — flexbox, relative units, never `100vh`/`100vw`
- **Accessibility** — WCAG AA, ARIA labels, keyboard navigation, semantic HTML
- **Complete code** — no placeholders, TODOs, or ellipses in final output

## CLI argument contract

**Every `scripts/*.js` entry point declares its flags and validates them up front.** `parseArgs`
accepts any `--name`, and an unrecognised flag is both dropped silently *and* swallows the token
after it — so a typo does not fail, it quietly changes what the command does. Measured on
`build-model-app.js` before this was enforced: `--stage ui` planned 3 steps, while `--stagee ui`
planned all 9 and still exited 0, turning a scoped UI apply into a full data-model apply.

So a `main()` starts with:

```js
const argv = process.argv.slice(2);
const { positional, flags } = parseArgs(argv);
const flagError = validateFlags(argv, {
  known: ['env', 'spec', 'stage', 'apply'],   // every flag this CLI accepts
  needValue: ['env', 'spec', 'stage'],        // those that must carry a value
  hints: { stage: 'one of: data, ui, app, publish' }, // optional, for closed value sets
});
if (flagError) { process.stderr.write(`✗ ${flagError}\n${USAGE}\n`); process.exit(1); }
```

`validateFlags` (`scripts/lib/dataverse-auth.js`) rejects unknown flags with a single-edit "did you
mean" (via `scripts/lib/nearest-name.js`, shared with the FetchXML operator lint), and rejects a
value-bearing flag passed bare or empty. It reads flag names from `argv` rather than the parsed
object, because `--__proto__` goes through the inherited setter and never becomes an own property.

Two consequences worth knowing:

- Because `validateFlags` guarantees a `needValue` flag is either absent or a non-empty string,
  `typeof flags.x === 'string' ? flags.x : undefined` is redundant afterwards — read `flags.x`.
- `needValue` must be a subset of `known`; `validateFlags` throws if it is not, which catches a
  rename applied to one list and not the other.

When a CLI test harness cans `parseArgs` to a fixed result, use
`scripts/tests/helpers/fake-auth.js` → `validateFlagsFromParsed` so the harness exercises the **real**
validator instead of a hand-written copy that can drift from it.

**Testing a CLI end to end:** `scripts/tests/helpers/cli-harness.js` → `loadCli(scriptPath, { requires, argv })`
loads an entry point with injectable module stubs and a shadowed `process`, so a test can drive
`main()` and assert the **wire calls** it makes (the Dataverse requests, the `AddSolutionComponent`
component types, the temp-workspace cleanup) rather than regex-matching the source. It uses
`vm.compileFunction`, **not** `vm.runInNewContext`: a new VM context is a separate realm with its own
`Array`/`Object` prototypes, so every array the script builds would fail `assert.deepStrictEqual`
against a host array with "same structure but not reference-equal".

## Dataverse Access From Scripts

**Default: go through the vendored SDK.** Anything the SDK models — tables, columns, relationships,
views, charts, forms, commands, dashboards, app modules, sitemaps, solutions, roles, settings — is
read and written through `createMakerSdk`. That is not style: the SDK persists metadata under
`<app-folder>/.maker-workspace/` for reuse and edits, resolves artifact identity the same way the
build does, and owns retry/pagination behaviour. A read that bypasses it can disagree with the write
about which artifact it is talking about.

Two escape hatches exist, and both are deliberate. The maker SDK models the *maker* surface; parts of
Dataverse simply are not in it.

| Hatch | Use for | Examples in tree |
|---|---|---|
| `dataverseRequest()` in `lib/dataverse-auth.js` (and the `dataverse-request.js` CLI) | Dataverse surfaces the SDK does not model at all | `WhoAmI` (`check-auth.js`), `customapis` (`list-custom-apis.js`), `connectionreferences` (`create-connection-reference.js`), solution-component adds (`add-page-to-solution.js`) |
| The raw `httpClient` from `createAzHttpClient` | A surface the SDK *does* touch but whose response it **projects away** | **No caller today.** The one that existed — `entityPrivileges` in `verify-model-app.js` — is gone: the SDK had no privilege READ at all, and `fetchEntityMetadata` drops `Privileges` permanently by design, so the check composed its own `EntityDefinitions(...)?$select=Privileges` request. The vendored bundle now carries `getEntityPrivileges`, and the reader takes it. The hatch stays documented because the *category* recurs; opening it again needs the same justification |

**Prefer `dataverseRequest()` over the raw client.** It already handles the API path, auth, headers
and timeouts. Reach for `httpClient` only when you must share the exact client instance the SDK is
using — and check first that the SDK has not since grown the method, as it did for entity privileges.

When you do go direct, all four of these apply:

1. **Comment WHY the SDK cannot serve it** — name the SDK method you would otherwise call and what it
   drops or lacks. "Deliberately not `sdk.fetchEntityMetadata`" is the difference between a
   documented exception and something a later reader "simplifies" back into a silent bug. Say what
   would retire the hatch, so the note is actionable rather than permanent.
2. **Absolute URL including `/api/data/v9.2`** when using the raw `httpClient`. It is the transport
   the SDK drives, so it takes full request URLs and validates them with `new URL(url)` for its
   same-origin guard — a relative path throws there rather than resolving against the org.
3. **GUIDs unquoted.** Record ids and `_x_value` lookups are `Edm.Guid`; `id eq '<guid>'` fails with
   *"A binary operator with incompatible types was detected"*. See `references/troubleshooting.md`.
4. **Test the reader itself, not only an injected stub.** The `entityPrivileges` URL bug shipped
   because every test injected a fake reader into `verifySpec`, so the real one was never executed —
   and `verify-spec` catches per-entity read failures, so it would have failed silently on every live
   run rather than crashing. Drive at least one test through the real seam: the client's request path
   for a raw read, or the **real vendored bundle** for one that goes through the SDK. A hand-written
   SDK stub proves only that the mapping is self-consistent with itself.


- Keep SKILL.md under 500 lines
- Use short, descriptive `name` field (e.g., `genpage`)
- Write descriptions in third person ("Creates X" not "This skill guides you through creating X")
- Use progressive disclosure: SKILL.md for workflow, reference files for details
- Link to references inline: `See [troubleshooting.md](../../references/troubleshooting.md)`
- Immediately after the frontmatter of every user-invocable skill, run
  `node "${PLUGIN_ROOT}/scripts/check-version.js"` and show any output before
  proceeding. The check is best-effort and must never block skill execution.

## Building & Testing

**One-command regression gate (run before every commit)** — from `plugins/model-apps/`:

```bash
# Plugin unit suite only (node:test):
node scripts/run-tests.js

# Plugin suite + the vendored SDK's Jest suite (Node 20):
NODE20_BIN=/path/to/node20/bin node scripts/run-tests.js --with-sdk /path/to/power-platform-ux
```

- `run-tests.js` runs the full `scripts/tests/*.test.js` suite and prints a combined PASS/FAIL.
  **CI runs this same command** (`.github/workflows/model-apps-script-tests.yml`) on any PR into `main`
  touching `plugins/model-apps/**`, `evals/model-apps/**`, `shared/telemetry/**`, `shared/skills/**` or the
  workflow itself, across ubuntu × windows × macos and Node 20 × 22.
  Keep `POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: "1"` on any new job that could run a
  telemetry-emitting hook or script.
- The SDK's Jest suite needs **Node 20** (its `canvas` native module is built for the Node-20 ABI).
  Set `NODE20_BIN` to a Node-20 bin dir; without it the SDK suite is skipped (plugin suite still runs).
- Evals: `node --test evals/model-apps/tests/*.test.js evals/model-apps/app-builder/tests/*.test.js
  evals/model-apps/genpage/tests/*.test.js` (the first directory holds the cross-runner coverage
  contract), plus the runners (`node evals/model-apps/genpage/run-layer-{1,2}.js --tier smoke`,
  `node evals/model-apps/app-builder/run-app-builder.js`). See `## Eval Suite` below. CI's
  `test-model-apps-evals` job runs the eval tests AND all three runners (genpage Layer 1/2, app-builder)
  over every committed fixture — offline, no org — so a fixture that falls out of step fails the PR.

**The vendored SDK lives in a separate repo.** The Dataverse mechanics are in
`power-platform-ux` (Azure DevOps `msazure/OneAgile`), package `packages/cds-maker-sdk`. This plugin
ships a **self-contained bundle** at `scripts/vendor/cds-maker-sdk.cjs` (NOT the SDK source). The SDK
owns deterministic wire formats (create/query/delete, AI settings/row-summaries, `seedRecordGraph`,
`enrichDefaultViews`, artifact resolve/cascade); the plugin owns judgment (spec validation, candidate
selection, prompt authoring). To change SDK behavior:

```bash
# 1. Build the SDK (emits lib/) — from <ppux>/packages/cds-maker-sdk:
npm run build          # tsc/ppux-build
npm test               # Jest (Node 20)
npm run lint           # ppux-lint (Node 20)

# 2. Rebuild the vendored bundle here (reads the SDK's lib/, so build the SDK first) — from repo root:
node plugins/model-apps/scripts/_vendor-build/build.js --sdk /path/to/power-platform-ux
# → rewrites scripts/vendor/cds-maker-sdk.cjs (~540 KB). COMMIT the rebuilt bundle.
```

Only the SDK `src/` is committed in the SDK repo (`lib/` is gitignored). A type-only/whitespace SDK
edit produces a byte-identical `lib/*.js`, so the bundle only needs rebuilding when SDK **runtime**
changes. **Never patch the bundle** to work around an SDK defect: the next re-vendor silently
reverts it and the hash in `PROVENANCE.json` stops matching. Fix it upstream and re-vendor.

**Vendored-SDK contract invariants (regression net).** When you bump the SDK and re-vendor, the
skill relies on behaviors that must survive. The test files below lock them — run all against every
rebuilt bundle.

**Re-vendor from a COMMIT, and check the recorded provenance.** `scripts/_vendor-build/build.js`
writes `scripts/vendor/PROVENANCE.json` next to the bundle: the upstream SHA and subject, whether
that package had uncommitted changes, and the bundle's own sha256. Two things make this
load-bearing rather than bookkeeping. First, the bundler consumes the SDK's **gitignored `lib/`**,
a build output that can be arbitrarily older than `src/` — a bundle shipped in this repo was once
built from a stale `lib/` several commits behind its nominal source, and nothing could reveal it.
The bundler now **refuses** (exit 3) when `lib/index.js` predates the newest `.ts` under `src/`.
Second, "built from master" is not provenance, because master moves; the SHA is what lets a
reviewer reproduce the artifact. Re-running the build on the same inputs must reproduce the same
sha256 — check it.

⚠ **`subject` is the subject of the commit the bundle was BUILT FROM — normally master's HEAD — and
is usually unrelated to the change you are taking up.** It is recorded verbatim from git on purpose
(`sanitize-subject.js` only strips merge-tool prefixes), because editorialising it would break the
one thing provenance is for. So expect it to read like `Revert 'fix: scheduled trigger skips its
first run…'` while the uptake is about AI settings: master simply moved on after the commit that
carried the fix. Do not "correct" it, and do not read it as a description of the uptake — name the
change in `CHANGELOG.md` instead, which is where a reader looks for what actually arrived.

`scripts/tests/sdk-surface-contract.test.js` — the **method-presence** guard. Asserts every SDK
method the engines call (`SKILL_SDK_SURFACE`, kept in sync with the `provision.*` / `sdk.*` call
sites by a source-scan test that also covers `artifact-intent.js`) is a function on the real vendored
bundle. A re-vendored SDK that **renames or removes** a method the skill uses fails HERE, listing the
exact names — instead of silently at build time (the mock-based `sdk-build`/`sdk-teardown` suites
can't catch that, since the mock mimics the old interface). The skill drives Dataverse through the
SDK's **generic** surface (`createArtifact`/`addElement`/`updateElement`/`removeElement`/`getArtifact`/
`fetchArtifact`/`pushArtifact`), NOT per-artifact mutators — a bundle that drops the generic surface
fails here. Update `SKILL_SDK_SURFACE` **and** migrate the call sites together.

`scripts/tests/hardening2-real-bundle.test.js` — **compiler↔adapter integration** against the real
bundle: it drives `artifact-intent.js` + the generic surface exactly as the engine does and asserts
the real wire output — **parity** with a pre-swap golden (`fixtures/parity-golden.json`, via the pure
`wire-facts.js` normalizer), multi-tab/section create, **metadata-derived control classIds** (a Lookup
and a String field get DIFFERENT classids — the adapter defaults them from attribute type, T4, so the
plugin must NOT precompute classId), sub-grid relationship/target/view serialization, `/bag/c` events
**merge** (exactly one `<events>` root on a rebuild), field removal, and the **412 → failed
`PushResult`** signal `requireSuccessfulPush` halts on. The mock-based `sdk-build.test.js` covers the
engine ORCHESTRATION (call order, idempotency, phase selection); this covers what a mock cannot.

`scripts/tests/vendor-sdk-smoke.test.js` — the **behavior/return-shape** `CONTRACT:` tests (drive the
public `createMakerSdk` factory — the `MakerSdk`/`AppAdapter` classes are no longer bundle exports):
- **Raw OData filters pass through, single-encoded** — the skill builds raw `$filter` strings
  (quoted string literals via `lib/odata.js`, and **unquoted GUID literals** like `objectid eq <guid>`);
  a query builder may transport-encode them but must not double-encode.
- **Name-based methods accept logical/unique/schema names verbatim** — `deleteTable`, `setEntityIcon`,
  `resolveArtifact({uniqueName}/{name}/{entity})`, `createRelationship({referencedEntity,…})`. A GUID
  normalizer must apply to GUID params ONLY, never to these names.
- **Sitemap free-text (titles/URLs/descriptions) is XML-escaped, not rejected** — a "safe DOM factory"
  must escape attribute/text VALUES while only validating element/attribute NAMES.
- **`deleteAppCascade` returns a structured `{ success, deleted, failures }` result** — teardown
  reads `failures` to report orphaned sitemap/genpage rows instead of claiming a clean delete; the
  bundle must keep returning the result (not void) after a re-vendor.
- **`seedRecordGraph` returns `{ createdIds: { <entityLogical>: [ids] } }`** and dedups only on an
  explicit **`matchOn`** key (it NEVER falls back to the primary display name — `buildSeedGroup`
  supplies `matchOn` from a single-column alternate key or the primary name, validated non-empty).

`scripts/tests/sdk-async-surface.test.js` — the **sync-vs-async** guard, and the one to read first
after a re-vendor. The SDK's generic surface is asynchronous (`addElement`, `findElements`,
`getArtifact`, `moveElement`, `queryTree`, `removeElement`, `updateElement` all return Promises; a
read may revalidate against the server before serving its cached copy). Forgetting an `await` does
**not** throw: a Promise is truthy, so the engine's `|| {}` fallbacks stay dormant and the pure
helpers silently receive a Promise — `hasSubgrid` → `false` (duplicate sub-grid), `formFieldLogicals`
→ `[]` (every field looks missing), `findFieldCellPointer` → `null` (a removal never happens). Wrong
artifacts, 2xx statuses, green build. The test therefore does two things: a **source scan** that
fails on any un-awaited `provision.*`/`sdk.*` call to those methods (annotate a deliberate one with
`sdk-async-ok`), and a **dynamic check** that the real bundle still returns Promises for exactly that
list — so if a future SDK makes one synchronous again, the scan can't go on enforcing a dead rule.

`scripts/tests/workspace-projection-real-bundle.test.js` — the **upgrade** guard. The SDK refuses to
push a workspace copy stamped with another parser version (`ARTIFACT_PROJECTION_STALE`), so a
re-vendor that raises it makes every existing `.maker-workspace` old. Upgrades stay invisible only
because a plain fetch re-reads a clean old copy (and the build fetches every existing form, view,
chart and app before editing it); a copy still holding an interrupted build's edits is kept by that
fetch and refused at push — or, when the environment's copy has moved since, refused by the fetch
itself (`LOCAL_EDITS_WOULD_BE_LOST`, measured live on a 2.10.0 workspace). For the push refusal the
runner names the manual reset every workspace-reset remedy shares
(`RESET_WORKSPACE` in `lib/entity-provision.js`): stop other builds and teardowns on the workspace
first — the changed-only snapshot holds their leases and a running teardown's registration — then
delete everything except `last-applied.json` (the navigation baseline) and `destructive-approval.json`
(the approved removals), which no re-run can rebuild. The build does not reset the copy itself: the
SDK's per-artifact lock is per process, so an overwrite could discard another build's newer edits on
the same workspace. For the fetch refusal it asks for a review first: the environment has changed
since the copy was fetched (maybe by a maker — the same copy is what a concurrent-edit halt keeps as
a fence), so rebuilding the same spec over a cleared copy could overwrite that change. The halt says
to look at the change in Maker and put into the spec what should stay, then make the same reset. (A
re-download is no substitute: it captures no forms, views or charts, and an interrupted first build
can leave them before the app exists.)


**Live end-to-end (app-builder — writes to a real Dataverse env; optional).** All build/verify/
teardown scripts are **dry-run by default**; add `--apply` to write.

```bash
az account set --subscription <sub-id>
node scripts/check-auth.js --env <envUrl>       # az token + WhoAmI preflight (pac optional; --require-pac for genpage)
node scripts/build-model-app.js   --env <envUrl> --spec @<dir>/app-spec.json [--sample-data --publish] --apply --verify
node scripts/verify-model-app.js  --env <envUrl> --spec @<dir>/app-spec.json
node scripts/teardown-model-app.js --env <envUrl> --spec @<dir>/app-spec.json --apply --allow-destructive
```

AI features are **admin-gated** — preflight readiness with `node scripts/ai-preflight.js --env <envUrl>`.
Prefer a scratch env; always tear down probes so nothing app-owned is left behind. Teardown needs
`--allow-destructive` as well as `--apply` — with `--apply` alone it refuses and exits — and it
deliberately leaves **one** thing behind: the **publisher**. A publisher can own other solutions in
the environment, so deleting it is not this app's decision to make — the same fail-safe reasoning
that keeps an `external` web resource. Expect a clean environment afterwards *except* for
`<prefix>publisher`; if a probe must restore the environment exactly, remove that row yourself after
confirming it owns no other solution.

**`appmodulecomponent` rows also survive an app delete, and teardown deliberately leaves them** — this
has been re-reported as a teardown bug and re-measured. The platform exposes no way to remove them:
the table registers only `Retrieve`/`RetrieveMultiple` (a direct `DELETE` 400s), and
`RemoveAppComponents` returns `204` while removing nothing as long as the app exists, then `404`s once
it is gone. Calling it would report a cleanup that never happened. The rows are unreachable metadata
that a rebuild neither adopts nor trips over; revisit only if the platform adds a delete or a cascade.

**After modifying the plugin also:** run `claude --debug` to confirm the plugin loads, exercise the
skill (`/genpage` or `/app-builder`), and for genpage verify Playwright browser checks
(navigate/snapshot/click/screenshot).

**Hooks + telemetry:** the lifecycle hooks and telemetry hooks are covered by the plugin unit suite
(`node scripts/run-tests.js`). Keep `scripts/lib/telemetry/ikey.json` shipping `disabled: true` until a
key is provisioned (a test enforces this), and run `node scripts/validate-telemetry-ikeys.js` from the
repo root after touching `ikey.json`.

## Eval Suite

The plugin has a 3-layer eval suite under `evals/model-apps/genpage/`. Two
layers are automated (TAP v13 runners); Layer 3 is manual.

- **Comprehensive guide:** `evals/model-apps/genpage/EVAL_GUIDE.md` — what
  we evaluate, the 3 layers, tiers (smoke/full/stress), fixture types
  (synthetic vs real captures), runner output, capture flow, cadence,
  diagnosing failures, adding evals and assertions.
- **Eval definitions:** `evals/model-apps/genpage/evals.json` — prompts,
  answers, and expectations.
- **Fixtures:** `evals/model-apps/genpage/fixtures/<eval-id>-<slug>/` —
  one folder per captured or synthetic run. Each contains the `.tsx`,
  `workflow-log.md`, `genpage-plan.md`, and (when applicable)
  `genpage-entity-creation-log.md` (older captures: `entity-creation-log.md`)
  and `RuntimeTypes.ts`.
- **Coverage contract:** `evals/model-apps/tests/eval-coverage-contract.test.js`
  fails when a prompt has no fixture, an expectation has no check, or a check
  skips on every fixture, unless `eval-coverage-baseline.json` beside it records
  the gap and why; it also pins the guides' counts to the registries.

Run on every PR that touches the skill, agents, rules, or evals:

```bash
node evals/model-apps/genpage/run-layer-1.js --tier smoke
node evals/model-apps/genpage/run-layer-2.js --tier smoke
```

### /app-builder — offline structural harness

A data-driven, **offline** eval harness at `evals/model-apps/app-builder/`
(sibling of `genpage/`). Grades **structural per-stage facts** — not `.tsx`
snapshots — using the plugin's own pure primitives. No live env required.

- `evals.json` + `fixtures/<n>-<slug>/app-spec.json` — data-driven cases
- `lib/facts.js` — per-stage fact computation (`schema-facts.js` + `app-spec.js` primitives)
- `lib/assertions.js` — assertion text → check function registry
- `run-app-builder.js` — TAP v13 runner (run from the repo root)
- `EVAL_GUIDE.md` — grading guide (see [`evals/model-apps/app-builder/EVAL_GUIDE.md`](../../evals/model-apps/app-builder/EVAL_GUIDE.md))

Per-stage oracles: `author` (validate + lint), `plan` (`planFor`), `data`
(`schema-facts.js` normalized tables/columns/relationships), `ui` (view/chart/form
intent facts), `app` (sitemap facts + nav graph), `security`, `verify` (`verifySpec`
reconcile, fail-closed), `process`, `generate-pages`, `teardown`, `round-trip` and
`changed-only` — see the guide's stage → oracle table for what each grades.

```bash
# From repo root:
node evals/model-apps/app-builder/run-app-builder.js
```
