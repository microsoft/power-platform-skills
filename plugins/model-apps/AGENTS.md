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

Plus **`/report-issue`** to file bugs against this repo. All Dataverse mutation flows through the
shared, vendored SDK (`scripts/vendor/cds-maker-sdk.cjs`) — see `## Building & Testing`.

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
  never duplicates a control. On `build --apply`, the destructive preflight writes `.maker-workspace/destructive-approval.json`
  when it refuses form-field or sitemap removals; a later `--allow-destructive` run may remove only that
  recorded set, consumes the file after success only when no field was kept by the fence, keeps it after failure, and fails closed if the file is
  unreadable. If live state contains a new removal, the build halts, lists only that new removal, refreshes
  the record, and the engine keeps any field that appears during the run rather than pruning beyond the
  preflight-approved set. Every push routes through `requireSuccessfulPush` (a 412 version conflict
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
  Emits `[n/total]` events the orchestrator narrates + a `BuildHalt` it gates on. Dry-run by
  default; `--apply` writes, `--sample-data` / `--publish` opt-in (`--publish` gates the final *bulk*
  publish; edit/finalize paths — reconciling an existing form/view, form events, quick-views,
  existing-app sitemap, page finalize — still publish their one artifact so the change takes effect).
  **The modern ("new look") shell is opt-in via `app.newLook`.** It is a per-app SETTING
  (`NewLookAlwaysOn`, written through the SDK's `saveSettingValue` scoped to app + solution), NOT an
  app-module column — `navigationtype` is Single/Multi *session* and unrelated, which is the reason
  this looked unavailable for a long time. Best-effort: the feature rolls out by tenant, so a failure
  warns and records `created.newLook: false` rather than failing an otherwise-good build or reporting
  a silent success.
  **`app.aiDescription` (the routing description) is written only when the spec sets it** — at create,
  and on an existing app when it differs from the fetched draft, riding that run's app push. The
  platform may author this text itself, so an omitted field is never written or blanked. A 412 on the
  appmodule row over an UNPUBLISHED header change (componentstate 1, proven by a draft read) halts with
  `app-header-unpublished` — publish, then re-run — after resetting the workspace copy, which a plain
  re-fetch would otherwise refuse to replace (`LOCAL_EDITS_WOULD_BE_LOST`). A 412 on the sitemap is a
  concurrent edit even then (the push writes the header first, so its own write left that layer). Any
  other failed push that carried the change resets the copy too — except a concurrent edit
  (`VERSION_CONFLICT` / a code-less 412), where the unrecorded copy is what stops a blind re-run — and
  without the pages phase the change is applied only after the live-page gate, so a gate halt leaves
  nothing behind; a page-backed app's standalone header push refuses a copy still holding an earlier
  run's unpushed edits (`app-copy-unpushed-edits`) rather than replay them.
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
  `--verify` now asserts the same membership INDEPENDENTLY of the write path: it resolves the app's
  `componenttype: 1` rows and fails, by table name, when a sitemap-visible table is not among them,
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
  exactly the artifacts a given App Spec declares, in dependency-safe order (**app module → security
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
  `app.icon`) so it doesn't leak as an orphan. **An app is TWO rows** — an `appmodule` AND a `sitemaps`
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
  that file for the wire contract, why a `$batch` is never retried, and why a conditional write that
  gets no answer is never re-sent). Pinned by
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
  writes); best-effort continue (a failed step is recorded, teardown proceeds). A not-found (already-gone)
  error is treated as deleted, the table delete's **not-found-on-success** is tolerated (`tolerateNotFound`),
  and system/managed artifacts that cannot be deleted are recorded as `skipped` rather than failing.
  `--clear-workspace` prunes `.maker-workspace/` after a clean apply (not while another teardown of it
  still holds the changed-only fence). `planTeardown(spec)` is pure (dry-run +
  unit-test surface); reuses `appUniqueName`/`commandsByEntity`/`topoOrderEntities` from the build engine (DRY).
- **`scripts/download-model-app.js` → `scripts/lib/hydrate-spec.js`** — the **edit flow**: pulls a
  *deployed* app back into an editable App Spec + page code (sitemap → `appShell` with icons, **every**
  generative page via `pac model genpage download`, referenced entities/tables, icon web resources,
  dashboards, solution).
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
  **Entities are the sitemap's tables UNIONED with the entities owned by the app's VIEW / CHART /
  FORM components** (`appComponentEntities`) — a maker-built app can include tables reachable only via
  a lookup/sub-grid/related view, with no sitemap entry of their own, and reconstructing from the
  sitemap alone drops them. Note `componenttype eq 1` (Entities) rows are deliberately NOT used, but
  the REASON changed: apps built before the entity-component fix carry junk rows that all share one
  `objectid` (the `entity` metadata table's own id), so on those apps the row identifies the
  component *kind*, not which table. Newly built apps now carry CORRECT per-table objectids (see the
  build note below), so reading them is viable — it is not done yet because a legacy app's junk rows
  would resolve to the table literally named `entity` and have to be filtered.
  **Scope caveat:** `/app-builder` itself never creates a hidden component — a table
  with no sitemap subarea does not become an app component at all (LIVE-verified: declaring `task` in
  `entities[]` without nav left the app's component set unchanged), so for an app-builder-built app
  the sitemap set already IS the complete set. This union therefore only adds tables for apps built
  or edited in the maker. **Download does not recover an entity component that has no sitemap subarea**
  (ADO 6603388), and a live attempt to construct the hidden component it describes did not succeed:
  pinning `task` via `AddAppComponents` with the
  now-correct reference shape returned 204 but wrote no row, before or after publish. So the
  download-side fix cannot currently be verified end to end — do not implement it speculatively.
  The component read is best-effort: a failure degrades
  to the sitemap-derived set rather than failing the download. Each entity's **`primaryAttribute` comes from
  real Dataverse metadata** (`primaryNameAttribute`) and is **never synthesized**. The old
  `<entity>_name` guess was wrong for most OOB tables (`account` → `name`,
  `contact` → `fullname`) while looking plausible on custom ones, which is why it went unnoticed.
  Because validation *requires* `primaryAttribute`, a table without one cannot simply be emitted: a
  **sitemap** table missing it FAILS the download (actionable — the user asked for that table), while a
  **component-only** table missing it is dropped with a warning (it arrived via a best-effort read and
  was absent from the spec entirely before this change, so aborting over it would regress a previously
  working download with no override flag).
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
  passed. It also reconciles
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
  `aiskillconfigs` for per-table row summaries. Feature values are `true`/`false` (the numeric settings'
  1/0) or an explicit integer such as `2` ("on for everyone"), bounded to `0..1000000` — the same range
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
  check-auth.js                ← Pre-flight: az present + logged in, pac identity, WhoAmI, identity match (pac overlaps the az probes)
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
  genpage-upload.js            ← /genpage: deploy one page via the shared wrapper (prompt passed BY FILE, never on a command line; an update must name the app the page is placed in)
  genpage-plan-provenance.js   ← /genpage: quarantine a stale plan before the planner writes, then verify the written plan targets the pages the approval named
  check-page-files.js          ← /genpage: pre-dispatch gate — the page file names of the plan's one ## Pages table are safe write targets (lib/page-file-targets.js)
  genpage-worker-output.js     ← /genpage: accept a parallel worker's page only if complete (default export, balanced, no elided code)
  capture-fixture.js           ← Copies /genpage working dir into an eval fixture and runs both runners
  lib/
    entity-provision.js        ← Shared entity-provisioning core (solution + data-model + sample-data)
    provision-input.js         ← Input validation for entity provisioning
    dataverse-auth.js          ← Shared auth + HTTP helpers (`az account get-access-token`, memoized per process and replaced on a 401; responses decoded as UTF-8 once), plus the CLI arg contract (parseArgs/validateFlags)
    nearest-name.js            ← pure single-edit "did you mean" matcher for closed vocabularies (CLI flags, FetchXML operators)
    supported-dependencies.js  ← Single source of truth for runtime + dev deps versions
    feature-flags.js           ← Default-OFF feature flag probe + Custom API script backstop
    sdk-build.js               ← app-builder build engine (idempotent; incl. the pages phase)
    stages.js                  ← stage→phase-range mapping + PHASES/STAGES constants
    op-diff.js                 ← destructive-op diff + --allow-destructive / --non-interactive gating
    artifact-intent.js         ← pure App Spec → canonical SDK intent compiler (new form topology; no SDK calls)
    form-occupancy.js          ← pure row occupancy (own cells + columns reserved by row-spanning cells above), shared by build and verify
    form-container-match.js    ← how an authored tab/section is matched to a deployed one (shared by build and verify)
    ai-app-settings.js         ← single source of truth for the per-app AI feature contract
    interaction-mode.js        ← whether a human is reachable in this run (shared by both skills)
    page-plan.js               ← pure App Spec → plan-document projection used by write-page-plan.js
    page-structure.js          ← the one structural gate a generated page must pass (empty, truncated, prose, elided), shared by genpage-worker-output.js and promote-intent-pages.js
    page-file-targets.js       ← the one page-filename rule (absolute/backslash/traversal/.tsx only/links/case collision, incl. with files already there), shared with check-page-files.js and the evals
    source-literals.js         ← TSX lexer (code/comment/string/template/regex/JSX) — see "Known limits" below
    sdk-teardown.js            ← app-builder teardown engine (planTeardown is pure)
    sdk-http-client.js         ← az-token HttpClient for the vendored SDK
    spec-lint.js / app-spec.js ← App Spec guardrail lint + validation
    spec-shape.js              ← shared structural normalization for both authoring gates
    surface-resolver.js        ← pure: resolve personas[].jobs[].surfaces[] to the spec artifacts that satisfy them
    role-privileges.js         ← pure: declared persona privileges + subset comparison against a deployed role
                                  (also the oracle for `roleGrants[]`, which is additive rather than converged)
    odata.js                   ← OData literal escaping helpers
    genpage-cli.js             ← pac model genpage upload/list/download wrapper
    hydrate-spec.js            ← reconstruct an App Spec from a deployed app (edit flow)
    verify-spec.js             ← spec-vs-deployed reconciliation core
    build-journal.js           ← durable JSONL build journal (resume diagnostics)
    form-preview.js            ← form wireframe renderer
    app-preview.js             ← whole-app design renderer (data model + sitemap + forms + page-intents + design)
    app-spec-doc.js            ← pure App Spec → readable Markdown design doc (model-app-plan.md)
    schema-facts.js            ← pure data-model provisioning fact extractor for evals
    pageref-resolver.js        ← PAGEREF_<key> → GenPageId nav resolver
    page-manifest.js           ← durable <app>_pagemanifest read/write
    sitemap-pages.js           ← pure GenPageId extractors + fail-closed fetchSitemap MEMBERSHIP reader + cross-app scan
    ai-candidates.js           ← selects good-candidate tables for auto row-summary mode
    ai-prompt.js               ← generates tailored Copilot row-summary prompts
    _graph.js                  ← entity topological ordering (shared by build + teardown)
    system-solutions.js        ← built-in system solutions (Active/Default/Basic) — shared by download recovery + teardown skip
    phase-diff.js              ← pure spec-diff → changed build phases (advisory diff foundation)
    content-hash.js / hash.js  ← content-aware phase diff: fold on-disk .tsx/contentPath byte hashes into the diff (changed-only)
    classify-changes.js        ← changed-only: classify a spec diff → fast (page-content) | full | noop + sticky debt
    apply-snapshot.js          ← changed-only: pure eligibility state machine (identity bind, debt, tombstone, generation CAS)
    apply-snapshot-store.js    ← changed-only: atomic snapshot write + workspace lease + invalidate/claim/tombstone/delete + distrust marker
    apply-snapshot-index.js    ← changed-only: build result.created → snapshot artifact map
    workspace-paths.js         ← the `.maker-workspace` name + the guard that gates destructive --clear-workspace cleanup
    changed-only-flow.js       ← changed-only: --changed-only orchestration (decide fast/full, live identity, snapshot lifecycle)
    projection.js              ← changed-only: pure post-apply verifiers (form placement / sitemap / page dual-hash)
    detect-browser.js          ← System Chromium/Edge/Chrome detection (used by the launcher)
    modelapps-hook-utils.js    ← Tracked-skill discovery + validator lookup for the hooks
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
| `genpage-edit-planner` | `genpage` (edit flow) | Reads the downloaded page artifacts (page.tsx, config.json, prompt.txt), gathers change requirements, presents edit plan, writes `genpage-edit-plan.md`. The orchestrator applies the edit inline. |
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

**A GA flag is flipped to `true` FIRST and removed in a LATER change, not both at once.**
Flipping is reversible in one line if the rollout turns out to be incomplete in some tenant;
deleting the gate in the same change that enables the feature leaves no way back except a
revert. Once a release has shipped with the flag on and no rollback was needed, remove it —
a permanently-on gate is dead weight that still has to be probed, branched on and reasoned
about at every call site.

Connector authoring is GA and no longer has a feature flag. The remaining flags are
`custom-api` and `custom-telemetry`; both currently ship **OFF** while their dependencies
finish rolling out.

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
  backstop because connector authoring is GA.
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
scanner. Whether a `/` or `<` starts a regex or JSX is judged by the code before it: never by a
comment's last word; a keyword read back as a property name (`counts.new / total`) or a postfix
`!` / `++` ends an operand; and a `)` ends one too, unless it closes an `if` / `for` / `while`
head, after which a statement starts. Each of those rules was once broken, and each break refused
a complete page as truncated or hid a navigation call. `hasDefaultExport` also needs the export
itself to be complete (a function or class reaches its body; a bare name is one the module
declares or imports, not a token that merely appears — the `as` of `import * as React` is not a
binding), because a write cut inside its export line balances; any complete `export default` will
do, for overloads. And `endsMidStatement` catches the cuts that leave every bracket balanced: the
lexer reports when a file stops inside a string, template, comment or JSX element, and a file
may not end on a token that needs more (`a +`, `React.`, `=>`). Both gates run all three checks.

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
- **`<` disambiguation is structural, not semantic.** A generic arrow is recognised by its
  shape — type parameters, then a balanced `(…)`, then `=>` (optionally via a return-type
  annotation). Exotic shapes that break the shape rule (e.g. a type-parameter *default*
  containing an unmatched `)`) can still be misread.
- **Lookahead is bounded** (`LOOKAHEAD`, 2000 chars) so a stray `<` cannot walk the file. A
  signature longer than that is not recognised as a generic.

Neither shape occurs in the corpus, and both fail *loudly* (exit 3, retryable) rather than
silently. If you hit one, widen the tests first.

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
  **CI runs this same command** (`.github/workflows/model-apps-script-tests.yml`) on any PR touching
  `plugins/model-apps/**` or `evals/model-apps/**`, across ubuntu × windows × macos and Node 20 × 22.
  Keep `POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: "1"` on any new job that could run a
  telemetry-emitting hook or script.
- The SDK's Jest suite needs **Node 20** (its `canvas` native module is built for the Node-20 ABI).
  Set `NODE20_BIN` to a Node-20 bin dir; without it the SDK suite is skipped (plugin suite still runs).
- genpage evals: `node --test evals/model-apps/genpage/tests/*.test.js`, plus the Layer 1/2 runners
  (`node evals/model-apps/genpage/run-layer-{1,2}.js --tier smoke`). See `## Eval Suite` below.

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
skill relies on behaviors that must survive. Four test files lock them — run all against every
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
- **Eval definitions:** `evals/model-apps/genpage/evals.json` — 18 evals
  with prompts, answers, and expectations.
- **Fixtures:** `evals/model-apps/genpage/fixtures/<eval-id>-<slug>/` —
  one folder per captured or synthetic run. Each contains the `.tsx`,
  `workflow-log.md`, `genpage-plan.md`, and (when applicable)
  `entity-creation-log.md` and `RuntimeTypes.ts`.

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
intent facts), `app` (sitemap facts + nav graph), `verify` (`verifySpec` reconcile).

```bash
# From repo root:
node evals/model-apps/app-builder/run-app-builder.js
```
