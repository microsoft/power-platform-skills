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
| `AGENTS.md` (this file) | Per-component behavioral specs, the canonical file tree, conventions, build/test | You add/rename a script, change a component's behavior, or change how to build/test |
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
  **The Notes timeline** (#680, `lib/form-timeline.js` — one definition shared by the compiler, the
  build's repair and verify) is written in the shape Dynamics renders: the fixed control id
  `notescontrol` in a 23-row cell with `auto="false"` (its `auto`/spelled-out `showlabel`/`colspan`/
  `rowspan` ride in the cell's bag), over the 22 empty spacer rows the cell spans. The old shape — a
  generated control id in a one-row cell — is published and never rendered. What platform forms share is
  the id, `showlabel="false"` and a cell of N rows followed by N−1 empty rows — N is 5, 20, 23 on different
  forms, `auto="false"` is on some and not others, `colspan` is 1 or 2 — so the helpers take ANY N of two or
  more as in shape: 23 and `auto` are what a NEW host is written with, never what an existing one is held to.
  A rebuild repairs the engine's own host (the `section_notes` section holding the timeline control)
  **in place** on every layout: one atomic rows write, same section, position and cell identity, and only
  what is missing — the id, a span of one row, rows under the span (to the span the maker chose; extra rows
  are never deleted); `auto` is written only with the conversion of an old cell, never alone. The repair
  (`repairTimelineHost`) runs **last** of the passes that touch a form's fields — after the prune and the
  `fieldOptions.after` moves — because it rewrites only the host's own rows and refuses a host that holds
  another control: run first, it would refuse an old host whose stray field the same build then prunes, and
  the form would stay old until a second build. The topology
  pass does not narrow that host below its timeline's `colspan` (a widened timeline is the maker's width).
  It never edits a maker's timeline elsewhere and never writes a second `notescontrol` — a form that
  already has a control by that id gets no new host (the explicit-layout topology pass and the auto-layout
  path share `timelineCreationBlocked`), and a host whose id cannot be renamed for that reason, or that
  still holds another control once the prune and moves are done, is left whole and reported in
  `skipped.layout`. That is one rule (`timelineRefusal`) applied to two different trees, not one decision
  that both reach alike: the build judges the form as its field passes have left it, `--verify` the form as
  published, BEFORE them. So verify predicts what the passes take out of the host (`notesHostInspector`
  in `verify-spec.js`: a field an explicit layout declares in another section; one a `fieldOptions.after`
  anchor places beside an anchor that is not in a section the build owns — an anchor that sits in the host
  but is itself anchored is moved out first, because anchored fields are placed in dependency order, and
  the field follows it; one an explicit layout with prune on does not list — `formRemovals`, the destructive
  gate's own function) and hands the rule those cells as `leaving`. What a pass does is predicted only for
  a field the form has ONE cell of. Each pass acts on a single cell of a field — the first it finds once the
  topology pass has reordered tabs and sections (`planOrderMoves`), and the prune removes one cell of a
  field per run — so for a field the form carries twice that a pass would act on (or one anchored, directly
  or down a chain of anchors, to a field it carries twice with a cell in a section the build owns; the
  reason names that field, not an anchor of one cell on the way to it) verify cannot know which cell a
  build acts on. It says so (`unsure`), in every shape of its advice — the taken-id one included, since
  freeing the id does not decide that cell: no promised repair (a full build repairs the timeline
  *unless* it leaves the cell, which verify cannot tell), no certain refusal, and no sending the maker off
  to do what the build may do itself. Only a pruned duplicate becomes predictable by itself (the prune
  removes one cell per run, so verify is exact once one is left); one a declaration or an anchor places can
  stay unpredictable build after build, since a build that acts on the cell already in place leaves the
  others — the maker moves them, as the advice says. A field that no pass touches stays whichever cell is
  acted on, one cell of it or several, so that is still said plainly. It is a prediction from the spec and the
  published form, not the build: it also cannot see a removal that was not authorized or that the build
  holds back, or a `fieldOptions` move skipped for a row-span or an overflowing row. Where it and a build
  differ the build's report is the authority — the cases in `form-timeline-real-bundle.test.js` run both on
  each shape, including forms whose published section order is not the build's, so a change to which
  fields a pass takes out is made in the pass and the prediction together. An `auto` form that asks for
  Notes and has no host gets one on rebuild (`addTimelineHost`, before the sub-grids: it has no topology
  pass to add it). Fields never go into an
  engine host: the no-section fallback skips hosts (`firstFieldSectionRowsPointer` — quick views use it
  too), a `fieldOptions.after` anchor inside one is refused, and the narrowing re-flow never runs on one (it
  would delete the spacer rows as "beyond the new count").
  Verify's `form-timeline` check needs ONE timeline that renders (id `notescontrol`, a cell spanning
  more than one row) on any form the spec gives Notes — and, for the engine's own host, the N−1 rows under
  its span, since the build converges them; a maker's timeline is judged by id and span alone. So an
  old-shape form fails it until rebuilt — and its detail says what a build WILL do about that form
  (`timelineVerifyProblem`): "run a full build" where the build repairs or adds it, what the maker must do
  first where it declines (another control holds `notescontrol`; the host holds a control no pass of the
  build takes out — a maker's own control, or a field no rule of the spec moves or removes, which the maker
  moves out of the section; on an `auto` layout, which declares no section for a field and prunes none,
  that is any field already on the form that no `fieldOptions` anchor places). A field the build itself
  prunes or places elsewhere is not the maker's to move:
  the advice stays "run a full build" and names what the build takes out first, a removal with the
  `--allow-destructive` it needs. A field it cannot predict is neither: where a full build would repair the
  timeline the advice says it does so unless it leaves that field, which verify cannot tell; where the
  advice is something else first (a control that stays, a taken id) it says verify cannot tell whether the
  build takes the field out first — and, either way, what to do if the build's report says the timeline
  was left as it is. Always a
  FULL build: a `--changed-only` run of an unchanged spec is a no-op ("nothing to apply"), so a form an older
  version left — which no change to the spec reaches — is never repaired by it.
  Download does not reconstruct `forms[]` (see `hydrate-spec.js`), so `notes`/`hasNotes` are authored
  and there is no form read-back to adapt.
  **Where a sub-grid's section goes** (AB#6651699, `lib/form-subgrid-placement.js` — the pure rules the
  spec gate, build, verify and wireframe all read): `forms[].subgrids[]` takes `after`/`before` (a
  section of the declared layout), `tab`, `column`. An `after`/`before` grid sits in its anchor's tab and
  form-column DIRECTLY beside it (`columnSequence` builds the order — grids that share an anchor keep
  declared order, each directly beside the one declared before it — and `neighbourOf` names the token a
  grid must touch); a `tab`(+`column`) grid is a question of MEMBERSHIP, created at the end of that column
  and, once in it, left wherever it is within it. The names are what `formLayoutNames` (app-spec.js)
  derives — an auto layout is `tab_general` holding `section_general`, pinned to the compiler by a test —
  and `subgridPlacementProblems` is the one function behind both the spec gate and the lint (a key a
  sub-grid entry does not read is only a warning — `subgridUnknownKeys` — because entries written before
  the placement keys existed may carry extras the build never read). A form holds ONE grid per
  relationship, so `subgridDuplicateProblems` (gate and lint, one function) refuses a relationship listed
  twice when an entry places the grid — those keys are new, so no spec that built is turned away — and only
  warns for a repeat that places nothing (the build has always ignored the extra entry); verify fails the
  later entry rather than pass it. A grid with
  NO key takes the original path exactly (end of the first tab's first column, never moved): a test
  records its writes. The build (`addSubgrids` → `placeGridSection`) runs after the
  topology pass, using the tab/section matches that pass recorded (`reconcileFormTopology` returns
  `{ sectionTargets, tabIndexOf }`) — so an anchor matched by label under another name is still the
  anchor. Grids with no anchor are appended first, in declared order, as they always were; the anchored
  ones follow — `after` grids in declared order, `before` grids in reverse — each put directly beside the
  nearest token toward its anchor already on the form (`anchoredPosition`), which is where a NEW form
  puts it: a new grid is added there in one write, an existing one is MOVED (same section, one
  `moveElement`, within a column or across form-columns), and one already directly beside it writes
  nothing. ONLY THE GRID MOVES: `planOrderMoves`, the fewest-moves planner the topology pass uses, is
  deliberately not used here — it moves whichever section is cheapest, and on the layout every released
  build left behind (`notes: true` + a grid: the grid BEHIND the Notes section) that is an authored
  section or the timeline, leaving the Notes section mid-form; a section in between (the Notes section, a
  maker's own) is simply left behind the grid. Only the engine's own `section_grid_*` host is ever moved;
  a grid a maker put in a section of their own is reported in `skipped.layout` — unless it is already
  where the spec puts it, which is neither written nor reported — as is an anchor/tab the
  deployed form lacks (the grid is then added at the end of the first tab, never lost). Adding or moving
  a section shifts the indices of the sections behind it, so everything that holds a section across
  `addSubgrids` is kept by what it is, not where it is: `shiftSectionTargets` corrects the topology pass's
  recorded targets, and a field being ADDED is queued with its section's id and name
  (`queuedSectionPointer` finds it again through `findSectionById`, then by name and place) — an index goes
  stale when a grid section is inserted ahead of it or taken out of the column, and the field would land
  in the grid's section or halt the forms phase on a pointer that addresses nothing; a section gone
  altogether sends the field to the first field section, reported. Quick views go to the first FIELD
  section too, never a grid's. Verify's
  `form-subgrid` check judges each placed grid
  against the DEPLOYED form with the same `neighbourOf` — directly beside its neighbour, anything between
  them named — (`RelationshipName` is element text — `parseFormTopology` reads it), on explicit and auto
  layouts; a failing detail says to run a full build where the build moves the grid, and what the maker
  must do where it is in a maker's own section. The wireframe and the offline eval reader read a compiled
  column by PLACE (`columnItems`; `columnSequence` tokens carry `at`), never by name — a layout may declare
  a section named `section_notes` too. A grid is as wide as its form-column, so a full-width grid wants a
  one-column tab (documented,
  not engineered). Download does not reconstruct `forms[]`, so placement is authored too.
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
  identity conflicts, read failures) and, before any page is created or updated, on a page that would ship a Griffel
  shorthand (`pages-griffel-shorthand`: a page it creates, or one whose source changed since the last recorded apply — a page it
  sends again as it is gets a warning; see "Griffel shorthands"). The cross-app shared-page scan (`fetchAppsForPages`) enumerates every app via the vendored SDK's
  `@odata.nextLink` pagination (`queryRecords({ paginate:true })`), so it verifies EVERY app in the
  environment rather than one 5000-row page; a pagination fault (the SDK's repeated-nextLink guard) still
  fails **closed** rather than scanning a partial list. It reads each other app's PUBLISHED sitemap and also its
  SAVED (current, unpublished) one: a page another app has saved into its navigation but not published still
  halts the update (`pages-shared-across-apps`, naming the app `[saved, not published]`). The scan is a snapshot: another maker
  can take a page into another app's navigation while the build runs, and nothing reaches far enough to stop it — the lease is
  this workspace's, Dataverse offers no write conditional on another app's sitemap, and the update goes through `pac`, which
  takes no precondition. So a build that writes pages in place takes the scan twice more, over the pages it began with and now
  overwrites (one this run created, a navigation target included, was not there to share and is left out): right before the
  first of them is written, where a page that became shared halts the build before any page it began with is updated in place
  (`pages-shared-across-apps`, "became shared across apps while this build ran", `transient: false`); and after the last — or
  after the loop stops early, since what it wrote is written — where a page taken in while the uploads ran is reported as a
  warning naming the page and the app (one that only saved it shows the new content once that app is published; a scan that
  fails there is a warning too: nothing is left to refuse). Each scan reads every other app's navigation (three requests per
  other app, and three more), which is why it is not taken before every page. The saved layer of
  every other app is **one** extra request — the `sitemap` collection's `RetrieveUnpublishedMultiple`, joined to each app by the
  sitemap id its published read found, with the same current-row rule `navigationProof` uses — and it is fail-closed too: a
  read that fails as a whole halts as `pages-shared-check-failed`, and an app whose saved row is missing, ambiguous or
  malformed is listed unreadable. An app that was **never published** has no row in the published app list, so the scan lists those
  as well — one request, the `appmodule` collection's `RetrieveUnpublishedMultiple` (`draftOnlyApps`) — and joins each one's saved
  sitemap from the same saved-layer read, by the sitemap id its layer's sitemap component names (one more read per such app); it has
  no published layer, so whatever it holds is saved only. That list is fail-closed like the others: a read that fails halts as
  `pages-shared-check-failed`, and a never-published app whose layer, sitemap component or saved sitemap cannot be read is listed
  unreadable. A never-published app whose component read **succeeds** and finds **no sitemap component** is not yet shown to have no navigation: the
  vendored SDK links an app to its sitemap **by name** — it looks the sitemap up with `sitemapnameunique eq '<the app's unique name>'` and takes one for the app only
  while that column holds the app's name, and `ensureSitemapInSolution` (sdk-build.js) resolves it the same way — so such an app may hold a sitemap, and pages in it, that no component row links to it.
  The saved-layer read the scan makes anyway (it asks for `sitemapnameunique` too — no further request) shows whether it does: a sitemap of that name is joined
  like any draft app's (case-insensitively, as Dataverse compares names), several sitemaps of the name leave the app unreadable, and **none** means the app has no
  navigation at all and holds no page, so it is skipped — one draft app saved with only a name must not stop every page update in the environment (a read that
  *fails*, or a component that names no sitemap, proves nothing and is still unreadable; so is a *published* app with no sitemap
  component, which is not changed here). A single-app environment reads no other app's navigation: it pays the one small request for the list of
  never-published apps, and nothing more when there are none (one saved-layer read as well when a never-published app has no sitemap component, to rule out a sitemap linked by
  name). Classic `dashboards[]` are opt-in.
  **Every `pac model genpage` call is time-bounded** (`lib/genpage-cli.js` `runPac`): 3 minutes to list or download and
  10 minutes to upload by default, or `POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS` (1 s to 60 min; one value sets all three). When
  the time is up the whole process tree is ended — a page upload once stalled for 17 minutes with no CPU and no network — and the call is
  reported as `timedOut`, which no exit code is. What happens next follows from what the call can have done. pac's upload writes the
  page, records the prompt and the agent message (two more requests), prints `Page ID`, then publishes, so a stopped upload has done
  anywhere from nothing to all but its last step. A timed-out list or download is read-only, so it is retried once. A timed-out
  **update** is **not** retried, though it names a page that exists: a re-send can record the prompt a second time (a call stalled in the
  publish has already written everything) and goes out minutes after the caller's own checks, so it can overwrite a change saved in
  between. It is reported as one that *may have landed*, and what it sends you to look at depends on the caller (`upload()`'s `caller`):
  the upload script's message names `genpage-base.js check` (the deployed page against the file and the base marker beside it), and a
  re-run goes back through the script's own guards. The **build** keeps no base marker, so that check could only answer "unknown", and
  every page's code file is a staging copy its cleanup deletes, so the command would fail on a missing file: the build's message
  tells you to read the deployed page with `pac model genpage download` (the call the build already uses, for that page id — and to open the `page.tsx` in the folder named for the id, which pac writes in its own letter case) and then run
  the build again, which sends the page once more to the same id — nothing new is created, but if the stalled send did land, the page's
  history now records its prompt a second time, and anything saved to the page in Maker since is replaced by the app folder's version.
  The error carries `transient: false`, so the build's own retry of transient halts never re-sends it. An **update** that **fails** — a non-zero exit, or an
  exit 0 with no `Page ID` — is handled the same way, for the same reason (pac can fail in the publish, after everything else is written): it is **not** retried,
  it is reported as one that *may have landed*, with what pac had printed (a `Page ID` means the page and its messages were written and the failure came in the
  publish) and the same caller-specific check, and it carries `transient: false`. Only a non-zero exit that pac reports for its own arguments or input files
  (`isDeterministic`) is an ordinary error, because pac checks those before it sends anything — and only when pac printed no `Page ID`:
  after the Page ID its one remaining step is the publish, whose error carries the server's own text, so a Page ID proves the page
  was written whatever the words. An update answered with another page's id also carries
  `transient: false`. That covers the halt an upload causes; a transient halt *later* in the same run (a 503 on a later read or
  write, say) still re-runs the whole build, which sends each page this run sent once more — as each rebuild does — so the page's
  history then records the prompt once more. A timed-out **create** is an
  uncertain create and is never run again, because a second create is how a duplicate is
  made. A `Page ID` pac had already printed names the page it created, whether the call then stalled or **failed** (exited non-zero): it is reported as
  *created as `<id>`, stalled (or failed) before publish or placement*, the create is **not** sent again however the environment's listing looks (the page need
  not be in it yet), and the way on is to place it (`pac model genpage add`, or Maker) and then update it, or to delete it and re-run the
  create — never "update it" outright (refused: not in the app's navigation) and never a bare re-run. With no id printed, the
  env-wide id diff reports any page already visible — a create that failed and left a candidate gets the same way on, not "re-run it as an update with `--page-id`" — and a page that
  is not visible *yet* proves nothing: a create that stalled with nothing visible, or whose listing cannot be read, is reported as uncertain with the advice to wait and list
  `pac model genpage list --environment <envUrl> --include-unpublished` before anything is created again. **Every error that follows a create whose outcome is not known to be nothing carries
  `transient: false`** (`neverRetriedError`) — a stall, a printed Page ID, a candidate in the listing, a listing that cannot be read: the build re-runs a phase when a halt reads as transient (`isTransientHalt`, build-model-app.js), and it reads the halt's *text* — which
  quotes the page's name (a page called "SQL Timeouts" matched) and pac's own words ("… try again later") — so without the marker a re-run would be a second create and a
  duplicate page, with the run reporting success. The page that was created but whose local receipt could not be saved (`pages-creation-receipt-failed`) carries it too. A create that
  failed outright and left nothing in the listing, and a listing that fails *before* the create was sent, leave nothing to duplicate: both are still retried — by the upload (3 sends) and,
  when the error's text reads as transient, by the build — as in 2.13.0. (`pac connection list` and
  the auth probes have their own limits or none; this bound is the genpage calls'.)
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
  publish; without it the edit/finalize paths — reconciling an existing form/view, form events,
  quick-views, existing-app sitemap, page finalize — still publish their one artifact so the change
  takes effect, and with or without it the lookup-label repair publishes the tables whose columns it
  relabelled). The bulk publish is ONE `PublishXml` envelope (`publishArtifacts`) for every table and
  the app, and with `--publish` the default-view enrichment, the reconcile of an existing view or form,
  form-event wiring and quick-view placement all defer their own publish to it: an entity publish ships
  every pending customization on that table, so one per artifact only repeated it, at ~2-2.5 s each.
  The tables the reconcile, form-event and quick-view paths touched are also published together once,
  in one envelope at the start of the app step, before anything publishes the app
  (`publishReconciledTables`). Measured live: a `PublishXml` naming only the app, sent after an existing
  form's save and before its table's publish, leaves the form's label changes unpublished for good, while
  the structure saved with them goes live. The enrichment's default views (columns only) wait for the
  bulk publish. A table whose early publish the SDK refuses stops the build before the app is written
  (`reconciled-publish-failed`), since the app's publish would strand its labels; the halt carries what
  is owed, so the CLI's retry, or its settle once no retry follows, publishes the table without the app.
  A deferred publish is recorded as owed, and a build that halts before the publish phase hands what is
  still owed to the CLI, which keeps each attempt's debt across transient retries until a publish phase
  pays it, and settles the rest per target once no retry follows (`settleOwedPublishes`) — so a halted
  build leaves those views and forms live, as it did before the batching. The record also keeps the NAME
  of every view and form deferred onto a table (`view Open Tickets`, `form Ticket events`; the CLI
  unions them across attempts), and `default views of <table>` when that table's default-view
  enrichment saved its generated Active/Inactive pair — whether the enrichment makes the record or joins
  one an authored view's reconcile already made — because one artifact stands for its whole table in the
  envelope: when that publish fails or cannot be confirmed, the warning names what is saved but not
  live, as the per-artifact publish it replaced did, rather than the table's Main form. That warning
  also names the views, forms and charts the run created on the table (and a chart whose description it
  wrote), each name once: a first build creates them all and defers no publish for them, so its record
  would otherwise name only the default views and the line would read as if only the generated pair
  were not live. Those names are labels only and stay out of the owed record, which is what a halted
  build publishes, so the warning after a halt names what was deferred. Settling covers
  a halt the build THROWS. A process killed outright (Ctrl-C, a crash, a closed terminal) settles
  nothing, so what a reconcile had saved stays saved but unpublished until the next build, which
  publishes it (a clean workspace copy is still published, below): no marker outlives the process, the
  default-view enrichment has the same exposure, and the app-builder skill's recovery guidance says to
  re-run. A default-view push refused by a concurrent edit fails the enrichment step, as any refused
  push does.
  **An unchanged rebuild writes almost nothing, and no write is skipped on a guess.** An existing view
  or form is pushed only when the SDK reports that its workspace copy differs from its last-synced
  snapshot (`diffArtifact`, `lib/unsynced-edits.js`): an edit this run made, or one an interrupted run
  left in the workspace — which a plain fetch keeps while the server has not moved, so comparing what
  this run computed with what it fetched would call it unchanged and never push it. An SDK without the
  method, or a diff that fails, pushes as before. A clean copy is the UNPUBLISHED layer, so it says
  nothing about what is published: without `--publish` the reconcile still publishes its artifact even
  when it skipped the push, since an earlier run may have saved and stopped. The reconcile of a reused
  component also re-asserts its solution membership, and one read answers all of them
  (`lib/solution-membership.js`: a single paginated `solutioncomponent` query for the component types
  the build adds plus the solution's tables, made at first use, so a build that reuses nothing and
  deploys no pages never makes it). A component the read proves present is not added again — views,
  forms, charts, business rules, the process flow, the app, its sitemap, the page manifest and persona
  roles. There are two proofs: a row of the component's own, or, for a view, chart or form ONLY, its
  table being held by the solution with ALL its subcomponents (`rootcomponentbehavior` 0). A table the
  build creates is held that way, and the platform does not list such a table's views, forms and
  charts one by one — an explicit `AddSolutionComponent` for one leaves no row — so a rebuild that
  looked only for rows sent those adds every time (measured live: 10 of the 19 an unchanged rebuild
  sent). The table's MetadataId, which is the `objectid` of its row, is read once per table, only for a
  component without a row and only when the solution holds some table that way, through the raw client
  the build already uses for table metadata (`tableRefs`). A table held at 1 (its own metadata only) or
  2 (shell only) proves nothing, and neither does a row with no behavior: those components need rows of
  their own, and are added without one. Anything the read does not prove (the read or the table lookup
  failed, the solution is a built-in one) is added exactly as before. A component this run creates is
  added directly, except the page manifest: it is persisted through the same check after every page
  create and once more at the end, so a first build that deploys pages makes the read too — and still
  adds the manifest, which the solution does not hold yet. What an unchanged rebuild still sends: the
  phase-8 envelope; the SDK's own default-view enrichment (it pushes both generated views of each table
  it enriches); the default-form promotion of a table the build owns (`isdefault`); the existing app's
  sitemap push with its component pins and publish; the AI-feature setting writes; and each persona
  role's privilege replace and app association.
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
  **A label-bearing metadata read must not run ahead of a create that may carry a localized label**
  (AB#6686428). Measured, order-controlled: a broad read that returns labels (`findTables`,
  `findColumns`, `fetchEntityMetadata`) made right before `createTable` / `createColumn` /
  `createRelationship` leaves Dataverse with only the base-language label of a multi-language one, with
  no error. That is why the existence probes are narrow keyed reads without labels, and why a probe that
  cannot answer halts, or assumes absent, instead of falling back to the broad read when a label is
  localized (`findExistingTable`, `relationshipExists`). The view-filter **pre-flight**
  (`preflightViewLabels`, `lib/sdk-build.js`) reads option labels and whole global choices before the
  first write, and those reads were never measured to be exempt — so a spec that carries ANY localized
  label (`localizedLabelLcidsInSpec`: a map on a table, primary column, column, inline option, alternate
  key or lookup; which of them the environment lacks cannot be known without more reads) does not run it.
  The views phase, which follows every create, makes the check instead, so a label that names no option
  still stops the build before any view is written; what is lost is only the guarantee that nothing had
  been written yet. Offline lint and validation, and the dry run (it creates nothing, so no create
  follows its reads), are unchanged. Lookup labels keep the same discipline: the parent-label read sits
  right before a single-language create, the relationships whose lookup label is localized are created
  before any other (`relationshipsInCreateOrder`, `lib/entity-provision.js`) so that none follows such a
  read whatever order the spec declares them in, and the repair's reads come after every create. Lifting
  the skip needs a live measurement of these reads ahead of a localized create in a two-language environment.
  The vendored SDK now sends `Consistency: Strong` on every metadata read (see "Newer SDK behaviors" below);
  whether that changes this effect has not been measured, so every rule above stands until a live
  two-language rebuild says otherwise.
  **A lookup column's label defaults to the PARENT table's name** (ADO 6691205). An omitted
  `relationships[].lookup.displayName` reached the SDK as `lookupDisplayName: undefined`, which the
  vendored SDK fills with the referenced table's **logical name** (`label(opts.lookupDisplayName ??
  opts.referencedEntity)`), so the column — and every form cell the SDK derives from it — read
  `new_project`. One rule, `lookupLabelFor` (`lib/app-spec.js`), now serves the build, the form cell,
  the previews, `app-spec-doc`, `schema-facts` and the download: the explicit label → the declared
  parent's `displayName` (string or LCID map, kept as the map) → the display name the **environment**
  reports for a parent the spec cannot name → a humanized table name. A parent the spec cannot name is a
  table it does not declare, **or one it declares WITHOUT a `displayName` that the build did not create**
  — `existing: true`, or found already there by the data-model phase — because the environment's name is
  then the only one it has (an `existing: true` `incident` is "Case", `systemuser` "User", not a
  humanized "Incident"/"Systemuser"). `lookupParentNeedsEnvironment` (`lib/app-spec.js`) decides who asks;
  the read is `readTableLabel` (`lib/lookup-labels.js`), and a label that is only the table's own
  identifier — what a build writes for a table with no `displayName` — is ignored. A parent that sets a
  `displayName`, and one the build creates itself without one, are never read. Offline surfaces cannot read
  the environment, so they show the humanized name wherever the build would read one — the plan adds "or the
  label from the environment if `<parent>` is already there" for a declared parent with no `displayName`
  that the build may find already present.
  The build has no general column-label reconcile, so the **rebuild repair** is its own pass
  (`reconcileLookupLabelsPass`, `lib/entity-provision.js`; opt-in through `reconcileLookupLabels`, which
  only `sdk-build.js` sets, because `provision-entities.js` counts its own steps). It acts only when the
  spec omits the label AND the live label is exactly the old default — for a **column**, the lower-case
  logical name of the parent (what the SDK labels the column with; `isOldLookupColumnLabel`),
  **case-sensitive** (a correct "Contact" is not one, so it costs no read and a maker's "Contact" is never
  overwritten; neither is a column that carries the lookup's own name — no build ever wrote that on a
  column) — in a single language that is the
  **build's own** (an old default in another language is left alone, with a warning: the write would add
  the build's language beside it, leaving two languages of which one is still an identifier, and every
  later rebuild would skip the column) — and writes **one language** (the authoring LCID) through
  `updateColumn`'s merge, never a map. It converges to the same label a fresh build writes, the
  environment's name included. A column's label is part of its table's definition, which Microsoft documents as
  reaching model-driven apps only once the table is published, so the pass then publishes every table it relabelled,
  in one `<entities>` PublishXml, with or without `--publish` — in the data-model phase, before anything can publish
  the app; a failed publish is a warning that names the tables. Nothing else in the build is sure to publish them:
  its other table publishes follow from what the spec puts on a table (a form, view, chart or icon, or its enriched
  default views), and a downloaded spec carries no forms, views, charts or table icons and marks every table
  `existing: true`, whose default views the build leaves alone. No metadata read can confirm that publish: measured
  live, `RetrieveEntity` returns the new label right after the PUT even with `RetrieveAsIfPublished=false`, so a
  live check of it has to trace the request. The labels are read **once per child table**
  (`Attributes?$select=LogicalName,DisplayName&$filter=LogicalName eq '…' or …`, the read the SDK itself makes for
  column hints), for the lookups the run did not just create, and a failed read is warned about once per table.
  `lib/lookup-cell-labels.js` applies the same rule to
  the form cell that stored the old label (the SDK takes a cell's label from the column only when the
  cell has none), whose old default is the parent's lower-case logical name **or the lookup's own** — what the
  SDK labels a field with when it cannot resolve the column at push (`isOldLookupFieldLabel`); it is a separate
  module so `entity-provision.js` and `artifact-intent.js` do not
  require each other. A cell that still holds the old default follows the column's CURRENT label — the
  repaired one, or a maker's. Every cell of the lookup is held to that rule on its own label: a form can hold a
  field more than once (`findFieldCellLocations`), and a first cell that is right, or a maker's, says nothing
  about a second one an older build left. A label-bearing metadata read immediately before a labelled create makes Dataverse
  keep only the base-language label, which is why the existence probe stays narrow for a localized
  label, the live parent-label read sits right before the plain create only (a localized lookup is created
  before any relationship that needs one), and repair reads run
  after every create. Download leaves `lookup.displayName` out when it equals what a rebuild would
  write **or is the old default** (the parent's logical name): an explicit label is never repaired, so
  writing the identifier out would carry the defect through download → edit → rebuild, where leaving it
  out hands it to the repair. Any other label is written as it is. Pinned by
  `scripts/tests/lookup-label-default.test.js` (its REAL BUNDLE tests drive the `createRelationship`
  body, the `updateColumn` PUT and a pushed form cell through the vendored bundle) and
  `scripts/tests/lookup-label-download.test.js`.
  **Choice labels in view filters resolve against the ENVIRONMENT** (ADO 6691114,
  `lib/view-filter-labels.js`). The spec alone (`choiceValueMap`, 100000000 + index) is right only for an
  option set this build created. A view on a table the spec reuses without declaring the column
  (`{ "schemaName": "account", "existing": true }` filtered on `industrycode`, a LOCAL option set — or a
  column bound to a system global choice) sent the LABEL as the condition value; lint passed, and Dataverse
  rejected the saved view MID-BUILD, after the tables and columns were written, leaving a half-built app.
  A declared global choice that already existed with other values did too (`createGlobalOptionSet` REUSES an
  existing set unchanged). A column bound to a global choice the spec does NOT declare is a lint ERROR
  (`spec-lint.js`, "references unknown globalChoice") — the build would create it with no options — so it is
  not a case the resolver serves, and lint adds no second word about it. (That check is lint's only:
  `validateAppSpec`, which the build runs, does not repeat it.)
  `readChoiceAttributes` reads a table's option sets (four narrow cast reads — Picklist,
  MultiSelectPicklist, State, Status — expanding `OptionSet`, which a global-bound column fills as a local one
  does) once per reader, and a build has up to two: one for the pre-flight and a fresh one for the views phase
  (the data model has been written since), so a table is read **at most twice per build** — and not at all for
  a table no label names — and a label matches in any language, an ambiguous alias refused. It is deliberately not
  `fetchEntityMetadata`: that costs about eleven requests, WRITES the workspace (a dry run must not) and keeps
  only the caller's language. The label is judged twice, on purpose:
  - **Before the build writes anything** (`preflightViewLabels`, `lib/sdk-build.js`, run by any apply that
    includes `solution` or `data-model` — so the staged flow's data run too — **unless the spec carries a
    localized label**, see the AB#6686428 note above) through
    `checkViewFilterLabelsBeforeBuild`. Before the build runs the environment cannot hold what the build is
    about to create, so each label is judged by whichever side is AUTHORITATIVE and only a DEFINITE answer
    halts: a column the environment already has (its options are final), or a column the spec declares and the
    environment lacks (the spec's inline options — or, bound to a declared global choice, the environment's
    copy when `readGlobalChoiceOptions` finds the set, since it is reused unchanged, else the spec's). A
    status reason the build inserts, a table it creates, a read that failed or was partial, and a label that
    the spec's own number stands in for (see the views phase) are NOT problems
    here — a false halt would stop a good build — and are the views phase's to judge. What the environment
    already held and resolved is handed on as final — a column's own options, and the values of the
    existing global choice a column the build creates will be bound to — so a failed read in the views phase
    cannot make it fall back to the spec's 100000000 + index.
  - **In the views phase, once the data model exists** (`resolveViewLabelsOrHalt`, a fresh reader): the final
    answer and the values. For a column bound to a declared global choice whose own options could not be read,
    the **set itself** is read (`readGlobalChoiceOptions`), because that is what the column is bound to — which
    is how a spec with a localized label, having no pre-flight to hand a value on, still resolves it. The spec's
    own options answer only where the environment cannot (table not there yet, failed read), for a declared
    Choice column — a FALLBACK, right only for an option set this build created, so the build **warns**
    whenever it uses it. An undeclared column whose table cannot be read is used as written, with a warning.
    **Where the spec numbers the options** — a column with inline `options[]`, or one bound to a global choice
    that `globalChoices[]` declares — and the environment has options for the column (or the set) but none
    labelled as the filter says (a maker renamed "Gold" to "Gold Tier", or a localized option's translation never
    reached the environment), the spec's own number is used, **with a warning**, when the environment has an
    option with that number (`specNumberStands`). That is what the build did before labels were resolved against
    the environment, so halting the apps it built would be a regression — and for a declared global choice a
    maker's rename would make `build --apply --verify` fail on every run with nobody having touched the spec.
    That the option on the number is the one the label named is an ASSUMPTION, so the warning says so and says
    how to take the choice out of the build's hands (use the option's integer value). It is **never made against
    the environment's own evidence**: the number is refused, and the label is a problem — the build halts, before
    it writes anything where the pre-flight can see it — when the environment has no option on the spec's number
    (a set from another publisher's range has none, so it halts too), or when the option on it goes by the name of
    another option of the spec (in any of its languages), or when the environment carries a label of this spec only
    on other numbers **and that shows the numbering moved**: the label is the filter's own option's (any alias, in any
    language), or it sits on a number the spec gives another option — options the author inserted or reordered after
    the column was built, since a rebuild never changes an existing column's options; a column made elsewhere; a set
    another app created in another order. A label on a number the spec does not use at all is an option a maker added
    or re-made (one added in the Default solution takes another publisher's range, one deleted and re-created takes
    the next free number): every number the spec has is where it was, so it is not held against the spec — a maker who
    adds an option and renames another does not stop a build the numbers still serve, as they served 2.13.0. That
    check compares labels without regard to case (a label still **resolves** by its exact text only), since an
    environment that differs from the spec in case alone must not hide a different numbering. **A refusal says why**:
    the problem line adds *The spec numbers "Gold" 100000001, but the environment shows another numbering ("Bronze" is
    numbered 100000003 there, 100000002 in the spec), so that number is not used.* — in the halt, in the dry run's
    reason, in `--verify`'s detail and in the line for a view that already exists. What the rule cannot see is the
    residual: where nothing the environment carries contradicts the number — every option renamed, a column made
    elsewhere in another order with options the spec lacks and the filtered option renamed, or options the author
    removed from the spec so that later ones now sit past its numbers — the number is the one earlier builds used (so
    never a different value than 2.13.0 sent), and the warning, which names the option the number landed on, is the
    only trace; `--verify` passes such a view, as it did under 2.13.0. A label two options share resolves the same
    way, to the one the spec numbers, when the spec's number is one of them.
  Both halt with `BuildHalt` code `view-filter-label-unresolved` (phase `preflight` for the pre-flight's halt,
  `views` for the views phase's, `recoverable: false`,
  `transient = false`), naming each view, column and the valid labels, and only a view the build would CREATE
  can halt it: `reconcileView` never reapplies an existing view's filters, so for one the build only says — as a
  warning — that its filters are left as they are and verify will report the label. The dry run
  (`annotateLivePlan`) asks the pre-flight's question and reports such a view as `? unknown` — with
  `wouldHalt` on the plan item, so the summary counts it as "would stop the build" and not as "could not be
  read", which it was not — and says (as a warning, once) what the apply will say: for a view it leaves as `create`
  or `reuse` because the spec's number stands in for a renamed option, the assumption it will warn of; for an
  existing view whose label names no option, which stays `reuse`, that its filters are left as they are and verify
  will report it; `--verify`
  expects the resolved value through the reader-gated `choiceAttributes` capability (`verify-model-app.js`),
  and a label whose option metadata could not be READ is reported as **unresolved**, with the reason, never as
  a missing filter — unless the deployed view has no condition on that column with that operator at all, which
  is a missing filter whatever the options are (a deployed value equal to the build's fallback still verifies);
  and `lint-app-spec` says offline that a label is "checked against the environment at build time" when the
  spec alone cannot prove it. Sample-data labels still resolve from the spec alone. Pinned by
  `scripts/tests/view-filter-labels.test.js`, which includes REAL BUNDLE reads of a global-bound column's
  option set and of a global option set, a build test per gap, tests that no write precedes the
  pre-flight's halt, and tests that no label-bearing read precedes a create of a localized spec.
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
  layer and proves the rows. An SDK create already publishes (the build keeps it that way — see
  "Newer SDK behaviors" under `## Building & Testing`), so a fresh app's new pins are
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
  binds a page by its published navigation or a receipt only; a page only in the saved layer halts with advice to
  publish the app first (the build's shared-page scan reads OTHER apps' saved navigation as well — see above). The verified ownership set is persisted locally before app deletion,
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
  ran — a SQL deadlock or a 429 for conditional deletes, a 429 for a change set that only creates columns — and why a conditional write that gets no answer is never re-sent).
  The SDK re-sends an app delete itself when the platform's search-index insert race refuses it (HTTP
  400, SQL 547) — an answer this client never re-sends — so the two layers add and never multiply
  (counts pinned in `scripts/tests/sdk-resend-layers.test.js`).
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
  builds. It works through a throwaway SDK workspace, never the folder's `.maker-workspace` (which belongs to
  the environment it was first opened for): every read it makes goes to the server, so it verifies any
  environment the app is deployed to and creates or binds nothing in the folder. It only READS the build's
  baseline, `last-applied.json`, from `--workspace`, and only when that baseline describes this
  environment. Checks **existence** (entities/columns/views/charts/forms + sitemap subareas + icons + pages by
  id) AND, best-effort, **content** so an *unapplied edit* is caught (not just a missing artifact): a
  view's **column set** (parsed from `layoutxml`; every spec column must be deployed — an extra deployed
  column passes by design, so a column REMOVED from the spec, which the additive `reconcileView` leaves
  in place, is not flagged), plus **relationship** and **command-bar existence** (previously unchecked).
  Content checks are additive + reader-gated (they only fire when the reader supplies `layoutxml` /
  `entityRelationships` / `commandBar`), so existence-only callers are unaffected. A view filter's
  Choice label is expected as the value the **environment** gives it, which needs the reader's
  `choiceAttributes` (one memoized read per table per pass); without it the spec-only expectation
  applies. A label whose option metadata could not be read is reported as **unresolved** with the
  reason — never as a missing filter, which would call a correct view wrong because a read failed (a
  deployed value equal to the build's own fallback still verifies) — unless the view has no condition on
  that column with that operator at all: that filter is missing, and is said to be. **Dashboards** are
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
  the app is published** (live-measured: the write reported `notPersisted` and `appsettings` held no row
  at all, while publishing and re-issuing the same call applied every feature). This is not read lag, so
  re-*proving* after publish cannot fix it — the build **re-issues** the write after publish for anything
  the first attempt did not apply, `skipped` INCLUDED. (The SDK now also proves a write against the app's
  UNPUBLISHED layer — `appsettings/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()` — so a row it
  saved but that is not published yet comes back `applied` with `pendingPublish` instead of
  `notPersisted`. That is still not in force: `--verify` and the runtime read the published row. So
  `rebucketPendingPublish` in `lib/ai-app-settings.js` moves it out of `applied` into a `pendingPublish`
  bucket of the plugin's own, and the post-publish pass gives it the publish — not a second write, since
  its row is already saved: with `--publish` the publish phase has put it in force and the pass only
  PROVES it, otherwise the pass fetches and publishes the app first. A feature the SDK did not save at all
  is still re-issued after that publish, and the re-issue's result is filed the same way: a publish that
  failed, or could not be confirmed, leaves the row in the unpublished layer, and the SDK then answers
  `applied` + `pendingPublish` again. Whatever the proof does not find in the published layer is reported
  `NOT YET PUBLISHED` (and listed under `pendingPublish` in `--json`), never `applied`. That proof reads
  an absent row up to three times, 500 ms apart — the budget `--verify` has (`AI_PROOF_BUDGET`, one value
  in `lib/ai-app-settings.js`; `sdk-build.test.js` and `verify-spec.test.js` pin both sides) — because a
  publish can answer before its row is readable, and a single read
  reported that lag as `NOT YET PUBLISHED` in a run whose own `--verify` passed. A check that could not run
  (the app, the definition or the row could not be read) says so first in the warning — "the check after
  the publish could not run: …" — ahead of what the SDK said, so a failed read is never taken for a look that
  found nothing. Without the move,
  a build with no `--publish` would end with unpublished rows that `--verify` fails on. Pinned in
  `ai-app-features-real-bundle.test.js`, `sdk-build.test.js` and `sdk-build-publish-batch.test.js` — the
  batched publish tells the pass whether the app's own publish went through.) On a fresh app nothing persists pre-publish, so
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
- **Bounded parallelism in the read-heavy and publish-heavy paths.** Each item below has tests that count
  requests and prove the overlap (`verify-parallel-checks`, `verify-page-code-batch`,
  `download-parallel-reads`, `teardown-publish-once`, `table-columns-in-create`, and the check-auth tests),
  and each keeps a one-at-a-time form (`concurrency: 1`, `inlineColumns: false`) that is the oracle its
  output is compared with byte for byte. Every fan-out is
  `mapLimit` (`lib/entity-provision.js`; its `firstInOrder` option makes the thrown error the
  lowest-numbered task's, deterministically), never an unbounded `Promise.all`, and each request still
  retries its own 429s (`lib/sdk-http-client.js`) — so a throttled environment slows the pass down rather
  than being hit by a burst.
  - **Verify** (`lib/verify-spec.js`) runs its checks as ordered tasks on a pool of 4
    (`verifySpec(spec, read, { concurrency })`). Each task reports into its own buffer and the report is
    the buffers joined in listing order, so it is the same whichever read answers first; a failure stops
    anything new from starting and the failure first in report order is the one thrown. A failed pass does
    not wait for the page checks' early reads (a hung `pac` run would turn a fast failure into a hang): the
    early read and the check that consumes it both stop waiting once a check listed BEFORE the page check has
    failed. A failure in a check listed after it does not end the wait — the page check's own failure is the
    lower-numbered one and must be the one thrown, as when the checks ran one at a time. A read the pass gave
    up on is ended before the pass returns or throws: `verifySpec` calls the reader's `endPageReads()`, which
    ends every `pac` run in flight with its whole process tree (`killProcessTree` — `pac` can be a `.cmd`
    shim, and Node's own kill reaches only the `cmd.exe`), starts no new run — a listing paused between two
    attempts included: the pac client's `abort()` makes every run of a call that began before it answer
    "ended" without starting anything — and makes no download folder until the next pass begins, and waits
    (bounded) for the downloads in flight to remove their `verify-page-*` folders — the verify CLI exits the
    moment the pass does. Reads that several
    checks share are single-flight: the root business unit (`resolveRoleBusinessUnit` caches the *lookup*
    in flight — caching only its answer made every concurrent caller but the first report its role
    missing), a table's and a role's privileges, the sitemap, the resolved Main forms. The reader sends the
    first read of each table alone, so the SDK resolves its `EntitySetName` once instead of once per
    overlapping read. The page checks' slow reads (the `pac` listing, the manifest) start with the pass,
    and the code of every page whose navigation is checked comes from `readerFor().pageCodes`: one
    `pac model genpage download --page-id a,b,c` per chunk of 25 ids instead of one run per page. A page the
    batch cannot answer (a failed batch, an id with no directory in the output) is asked for by itself, so
    one bad page costs its own miss, never its neighbours'.
  - **check-auth** starts `az account show` and (with `--env`) the Dataverse token read together, and
    WhoAmI as soon as the token is ready, so it overlaps the `pac` probe. The verdict order is unchanged
    (account → token timeout → pac → no environment → WhoAmI), and an early verdict cancels the probes
    still running — on Windows the token read's whole process tree (the `cmd.exe` that runs `az.cmd`, and
    the Python process it starts), through `killProcessTree` in `lib/process-runner.js`, because Node's own
    abort signals only the `cmd.exe` wrapper. The early WhoAmI is sent with `refreshOn401: false`: a 401
    would otherwise refresh the token with a synchronous `az` call (seconds, with every other probe's timer
    frozen), so a 401 on the early request is re-sent at WhoAmI's old place, after `pac`, where that refresh
    costs nothing.
  - **Download** overlaps each table's auxiliary reads (entity and attribute labels, the money
    base-currency flags, option sets) and the per-table relationship reads, bounded at 4
    (`runDownload({ concurrency })`; `1` is the sequential oracle), and merges them in the original fixed
    order, so the written spec, pages and stderr are byte-identical. Tables themselves are still read one
    at a time (the SDK's `fetchEntityMetadata` already fans out), and dashboards are not overlapped.
  - **Teardown** saves the default-view resets with `publish: false` and publishes ONCE, in one
    `publishArtifacts` envelope, at a barrier after the last reset and before the relationship deletes. A
    failed envelope is retried table by table with `publishArtifact` (the SDK fails every target of an
    envelope with one shared error), and a table that still cannot be published is named in a warning —
    teardown does not fail on it. A single table keeps the one-table publish.
  - **Data model** (`provisionDataModel`): a NEW table is created exactly as the previous release created it — one
    request that carries only its primary name attribute — and its ordinary columns (Text, Memo, the number types,
    Money, DateTime, Boolean, Choice and MultiChoice with inline options, AutoNumber; at most 25) then follow in ONE
    atomic change set instead of one request each: the SDK's `createColumns`, an OData `$batch` of POSTs to the table's
    `Attributes` collection. Dataverse runs the operations in order and, if one fails, rolls back the ones already done
    ([change sets](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/execute-batch-operations-using-web-api#change-sets)),
    so a refused change set has created nothing, and the build then creates the columns one by one as it always did,
    with a warning that says why (the platform's own message when its answer carries one). The same fallback covers a
    transport that cannot send a change set — the SDK refuses before sending anything when its HTTP client has no
    `postRaw` (`DataverseClient.supportsAtomicBatch`; `lib/sdk-http-client.js` has it) — and a change set whose answer
    was lost or could not be read (a transport failure, a server error, an unreadable success), which may have
    committed: the table is read once, and when it has EVERY column the change set is taken as committed and its
    columns are narrated as created, with their ids, after a warning that the answer was lost; otherwise each column
    already there answers "already exists" and is skipped, so a lost answer costs requests, never a column or a
    duplicate. A refusal (any 4xx) is not followed by that read. The HTTP client sends the change set again
    only when its answer is a 429 — the platform refused it, so nothing in it committed (the change set is atomic), as it can while the table
    just created is still held by its customization lock — on the schedule of any other throttled write (six attempts,
    1 s / 2 s / 4 s / 8 s / 8 s with jitter, longer when `Retry-After` asks, `isColumnCreateBatch` in
    `lib/sdk-http-client.js`). It never sends it again after another transient status or a lost answer (a change set can
    commit behind those), so such a refusal costs one request and then the per-column path's own 429 retries, never a
    burst; a change set still refused with a 429 once the attempts are spent falls back the same way, with a warning
    that says the table was throttled rather than that the request failed. The columns are not put in
    the table's own create request, which Dataverse also accepts (an `Attributes` array beside the primary name
    attribute, [Create columns](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/create-update-column-definitions-using-web-api#create-columns)):
    a table create that carries columns is not a request the previous release ever sent, and an environment can treat it
    differently (see the next bullet). The SDK builds each operation's body with the same function `createColumn` uses,
    so a column's body is its per-column body — `table-columns-in-create.test.js` compares them column by column and,
    where `MODEL_APPS_RELEASED_SCRIPTS` names the `scripts` directory of the previous release (the CI job that installs
    the parser oracles sets it), with the requests the
    released code itself posts — and each operation carries the solution header (the one on the outer `$batch` request is
    ignored by the platform). Customer, File, Image, Calculated, Rollup and global-choice columns, columns past 25, and
    every column of a table that already exists, or that was found after its create (the answer to the create was lost,
    so nothing shows what it holds), keep the one-request-per-column path. A column also stays out of the change set
    when its name is one the platform would create twice — the primary name, `<table>id`, a companion of a column of the
    table (a Money column's `<name>_base` twin, a Choice, MultiChoice or Boolean column's `<name>name` shadow, reserved
    even when that column takes the per-column path itself), or a repeat of an earlier name in any case — because
    Dataverse then refuses the WHOLE change set
    ([0x80060304](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/web-service-error-codes),
    "Attribute {0} already exists for entity {1}.") where the one-by-one path meets the collision in one
    column's own request and skips it. A column whose name EXTENDS the name of a column that takes the
    per-column path (Customer, File, Image, Calculated, Rollup, global-choice) stays out as well, and the
    build does not try to list what the platform makes beside such a column: `<name>name`, `<name>yominame`
    and `<name>idtype` beside a Customer column (measured), `<name>_name` beside a
    [File column](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/file-column-data#file-name-column),
    `<name>id`, `<name>_timestamp` and `<name>_url` beside an
    [Image column](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/image-column-data#download-url),
    `<name>_date` and `<name>_state` beside a
    [rollup column](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/define-rollup-fields).
    Such a column is made AFTER the change set, so a twin inside it would be made before its owner and the
    owner's own create would answer "already exists" — a skip — dropping the owner without a word, where one by
    one the owner comes first and the twin is the skip. The twin is made in spec order after the change set, as
    before; a longer name that merely starts like its neighbour's costs one request. The mirror rule keeps the order
    the spec's for the columns that DO go in the change set: one by one the first column to name something creates
    it and the next is skipped, so when a twin is listed BEFORE its owner the twin is the column kept — and the
    change set, which runs before every per-column create, would reverse that. A column therefore stays out of the
    change set when an earlier column has a name that extends its own — every name a column's creation can take
    (a companion listed for it, or one the platform makes that the build does not know) is named after the column —
    and is made after that column, in spec order; where an earlier column merely starts like a later one's name that costs one
    request. One narrow
    read of the table's `Attributes` (ids and names, no labels) then confirms the columns and returns the ids
    `createColumn` would have (a change set answers none), keyed by the column object, never by its name: a second
    column of exactly the same name is a repeat, skipped as already existing and never given the first one's id. A
    column the read does not show — unreadable, lagging, or ignored by the platform — is created the per-column way,
    where an already-exists answer is a skip. A table whose create answer was lost and that is found afterwards
    is given no change set. Used only when the SDK has `createColumns` and a raw Dataverse client is there to read the
    columns back (`inlineEnabled`); otherwise every column takes the per-column path.
  - **Primary name column length.** Every table create sends the primary name attribute's `MaxLength` explicitly: the
    spec's `primaryAttribute.maxLength` (a whole number from 1 to 850, one rule — `primaryNameLengthProblem` in
    `lib/app-spec.js` — applied by `validateAppSpec` AND by the provision-entities input gate that `/genpage` and
    `/app-builder` pass through), else 100 — what the previous release always sent (it is the SDK's own default for the
    option), for a plain and an auto-numbered name column alike. So a spec without a length posts the previous release's
    table request byte for byte and gets its result on every environment. What an environment makes of the length asked
    of a create that carries only the primary name attribute was measured on two: one keeps it (100 → 100); the other
    makes a plain text name column 850 characters long whatever length is asked (100 and 120 both came back 850) but
    keeps the length asked of an auto-numbered one (100 → 100), and keeps the length asked in a create that also carries
    other columns (120 → 120) — which is why the columns are not put in the table's create: no one length asked of such
    a create matches the previous release on both environments. More than 850 is refused (HTTP 400, "The maximum length
    of Primary attribute '…' is 4000. The maximum allowed limit is 850." — measured in a create that carried other
    columns), and a PUT of the finished column — the SDK's `updateColumn`, with `MSCRM.MergeLabels: true` — is honored
    (850 → 120 → 850). So when the spec gives a length and THIS build created the table, it reads the length back with
    one typed `…/Attributes(LogicalName='…')/Microsoft.Dynamics.CRM.StringAttributeMetadata?$select=MaxLength` GET and
    calls `updateColumn` only when it differs — LAST in the data-model phase, once every table, column, status reason,
    alternate key and relationship has been created, and inside a `finally`, so that a phase that halts after creating a
    table still sets that table's length (a re-run finds the table and leaves an existing table's name column alone; a
    length that cannot be set while the phase is halting is warned about as one a re-run will not set either).
    Last, because `updateColumn` starts by reading the column WITH its labels, and a label-bearing metadata read ahead of
    a labelled create is what strips non-base languages (measured; see `findExistingColumns`): within one attempt, nothing
    labelled is created after it. The build's automatic retry of a transient halt (a 429, a lock) runs the phase again as a
    second attempt: the attempt that created the table has already set its length (the `finally` runs after a halt too), and
    the retry finds the table and keeps its name column as it finds it, so the length is set once — but what the retry
    creates comes after the first attempt's read, and the loss was measured only for a create straight after the read, so
    whether it reaches across the pause between two attempts is not known (`table-columns-in-create.test.js` pins what
    each attempt does). That is one narrated `primary column length` step, planned (after the relationships) and counted
    only when the spec gives a length (`planFor`, and the provision-entities plan and total): `ok … -> N` when it set the
    length, or a skip — `(already N)`, `(table exists — kept)` or `(table found after its create — kept at N, asked M)` —
    or a FAILED step naming the table, the length asked and the length the platform made (for a read as well as an
    update), with a warning, that never stops the build. There is no read for the default: a spec without a length
    leaves the column as the environment made it, which is what the previous release did. A rebuild leaves an existing
    table's name column alone, like every column's `maxLength`, because it must not shorten a column that may hold data
    or undo a length widened in Maker. A table found after the answer to its create was lost (or that another maker
    created first) is treated as not made by this build, since nothing shows that it was not made by someone else, so
    its column is never written — but it is read, once, and a length that differs from the spec's, or cannot be read, is
    a warning (`reportFoundPrimaryNameLength`). And a build that stops on `TABLE_METADATA_NOT_VISIBLE` out of the create
    warns that the length asked may not have been applied (some environments make a name column created this way 850
    characters long), since the re-run that follows treats the table as an existing one — except for an auto-numbered
    name column, which keeps its length, and for 850, which the column comes out as either way. The
    build reads only `schemaName`, `displayName`, `autoNumberFormat`, `required` and `maxLength` from
    `primaryAttribute`; any other key inside it is still accepted and ignored (unlike the table level, it has
    no key allow-list).

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
  check-auth.js                ← Pre-flight: az present + logged in, pac identity, WhoAmI, identity match (the az probes, the token read + WhoAmI and pac overlap; the verdict order is fixed); a CLI too slow to answer is `az_timeout`/`pac_timeout`
  check-version.js             ← Skill-start update notice: compares the plugin clone with its origin/main (git runs in the plugin, never the user's repo)
  resolve-interaction-mode.js  ← Reports whether a human can answer in this run (unattended defaults)
  lint-app-spec.js             ← Validate + lint an App Spec without touching an environment
  dataverse-request.js         ← General Dataverse Web API wrapper (escape hatch)
  list-connections.js          ← Connector discovery: PAC connections + Dataverse connection references
  create-connection-reference.js ← Creates Dataverse connectionreference rows for connector bindings
  list-custom-apis.js          ← Discovers bindable Custom APIs (Global + entity-bound) + parameter kinds (custom-api gated)
  list-languages.js            ← /genpage planner: the environment's base language and each provisioned language (LCID, culture code, right-to-left) — the SDK's `getEnvironmentLanguages()` over the az-token client, three reads and no write, printed as one pure-ASCII JSON line. The planner's FIRST choice: when it exits non-zero, for any reason (most often the Azure CLI), the planner runs `pac model list-languages --environment '<envUrl>'` instead (as before the script existed, but pinned to the same environment), and says so
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
  genpage-upload.js            ← /genpage: deploy one page via the shared wrapper (prompt passed BY FILE, never on a command line; an update must name the app the page is placed in, and keeps the page's name, model and bindings unless given; refuses a create whose `makeStyles` writes a Griffel shorthand (`griffel-shorthand`, before anything is read) and an update that ADDS one the deployed page did not already have — one it already had goes ahead with a warning — and, for an update, no-base / deployed-changed / deployed-unreadable unless --overwrite-deployed)
  genpage-base.js              ← /genpage: record or check the deployed-page base marker next to a page.tsx (#673)
  genpage-plan-provenance.js   ← /genpage: quarantine a stale plan before the planner writes, then verify the written plan targets the pages the approval named and, for an edit, carries the exact approved change list
  check-page-files.js          ← /genpage: pre-dispatch gate — the page file names of the plan's one ## Pages table are safe write targets (lib/page-file-targets.js)
  genpage-worker-output.js     ← /genpage: accept a parallel worker's page only if complete (default export, balanced, no elided code)
  check-griffel-styles.js      ← /genpage and /app-builder: a page's `makeStyles` calls hold none of the ten shorthands Griffel's runtime drops (lib/griffel-styles.js; see "Griffel shorthands" below)
  capture-fixture.js           ← Copies /genpage working dir into an eval fixture and runs both runners
  lib/
    entity-provision.js        ← Shared entity-provisioning core (solution + data-model + sample-data): a new table is created with only its primary name attribute and its ordinary columns follow in one atomic change set (`createColumns`), falling back to one request per column; the primary name column's length is always sent (100 unless the spec gives one) and, where the platform did not keep a length the spec gave, set last in the phase; and `mapLimit`, the bounded fan-out every parallel path reuses
    provision-input.js         ← Input validation for entity provisioning (the entry gate of `/genpage` and `/app-builder`; it applies `app-spec.js`'s own `primaryNameLengthProblem`, so a name-column length is refused here exactly as in `validateAppSpec`)
    dataverse-auth.js          ← Shared auth + HTTP helpers (`az account get-access-token`, memoized per process and replaced on a 401 — a synchronous `az` call, which a caller running other probes beside the request opts out of with `refreshOn401: false`; responses decoded as UTF-8 once; an environment URL is used only as a Dataverse https origin, `dataverseOrigin`; a request path must stay under `/api/data/v9.2/` as both the client and the server resolve it, `webApiUrl`), plus the CLI arg contract (parseArgs/validateFlags) and the result printer (`emitResult`, whose `{ ascii: true }` option writes stdout JSON as pure ASCII for a script an agent reads off a console)
    process-runner.js          ← how every script starts az/pac/npm/npx/git: the executable is resolved to an absolute path on PATH, never the project folder, and started without a shell (a Windows batch shim runs through cmd.exe with its arguments checked); `killProcessTree` ends a stalled child AND everything it started (`taskkill /T /F` on Windows, where `pac.cmd` is cmd.exe → pac.exe, looked up with the System32 folder first on PATH so a PATH without it cannot leave the tree running, and with its window hidden; SIGKILL to the descendants `ps` lists elsewhere, each only once `ps -o lstart= -p` shows its pid still has the start time the listing saw — a descendant that exited meanwhile can have its pid given to an unrelated process; best effort, since two processes can share a one-second start time and the moment between that read and the signal is not covered), through the same audited calls; a child that has already exited is only asked to die, never ended by its pid, which may be another process's by then; synchronous, and it never throws
    cli-failure.js             ← how a CLI child failed (timeout / missing / failed), the Azure CLI budget (60 s, `POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS`), so a slow `az` is never reported as missing or signed out, and the budget of one `pac model genpage` call (3 min to list or download, 10 min to upload; `POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS`, 1 s to 60 min, sets all of them); `commandArg` writes an argument of a command a message tells you (or the agent) to paste so that, run from PowerShell (Windows PowerShell 5.1 or PowerShell 7) or a POSIX shell, the program gets it unchanged as one argument — bare when it is plain, single-quoted otherwise (a path from an untrusted checkout can hold `;`, `$(…)` or backticks) — or not at all when no spelling does that in every one of those shells: a quote or a line break, and the values Windows PowerShell changes on their way to a native program (a `"`, white space with a final `\`, the empty value) or both PowerShells read as the stop-parsing token (`--%`), all measured. `commandArgOrPlaceholder` then writes a placeholder and names the value outside the command
    nearest-name.js            ← pure single-edit "did you mean" matcher for closed vocabularies (CLI flags, FetchXML operators)
    lcid-cultures.js           ← pure: a Windows language id (LCID) → culture code and right-to-left, from a table of Windows' own culture data (what `pac` printed; the SDK reports numbers only, and no Intl API maps an LCID); a language id with no entry stays numeric and is reported, never guessed (`list-languages.js`)
    supported-dependencies.js  ← Single source of truth for runtime + dev deps versions
    feature-flags.js           ← Default-OFF feature flag probe + Custom API script backstop
    sdk-build.js               ← app-builder build engine (idempotent; incl. the pages phase)
    app-components.js          ← shared current/published app layers, component inventory, hidden-table pin/proof, Main-form resolution/membership and push directives
    solution-membership.js     ← one read of a solution's components (the types the build adds, plus its tables: a table held with all its subcomponents vouches for its views, forms and charts, which have no rows of their own), so a rebuild adds just what the solution is not PROVEN to hold; every doubt reads as "add"
    unsynced-edits.js          ← the SDK's own dirty tracking (`diffArtifact`) as the one proof that a reconcile has nothing to push; every doubt reads as "push"
    stages.js                  ← stage→phase-range mapping + PHASES/STAGES constants
    op-diff.js                 ← destructive-op diff + --allow-destructive / --non-interactive gating
    artifact-intent.js         ← pure App Spec → canonical SDK intent compiler (new form topology; no SDK calls)
    form-occupancy.js          ← pure row occupancy (own cells + columns reserved by row-spanning cells above), shared by build and verify
    form-timeline.js           ← pure: the shape Dynamics renders the Notes timeline in (control id, tall cell, spacer rows), what a deployed one lacks, and how to read it in the SDK tree and in published FormXML (shared by the compiler, the build's repair and verify)
    form-subgrid-placement.js  ← pure: where a form's sub-grid sections go (`tab`/`column`/`after`/`before`) — resolving a placement against the declared layout, the order of a column's sections and grids, finding a grid's section in either tree shape (shared by the spec gate, build, verify and the wireframe)
    form-order.js              ← the Main Form Set order: which Main form a table opens with, and which forms the build orders (shared by the spec gate, build and verify)
    form-container-match.js    ← how an authored tab/section is matched to a deployed one, and the moves that put them in the layout's order (shared by build and verify)
    ai-app-settings.js         ← single source of truth for the per-app AI feature contract
    interaction-mode.js        ← whether a human is reachable in this run (shared by both skills)
    page-plan.js               ← pure App Spec → plan-document projection used by write-page-plan.js
    page-structure.js          ← the one structural gate a generated page must pass (empty, truncated, prose, elided), shared by genpage-worker-output.js and promote-intent-pages.js
    griffel-styles.js          ← the ten shorthands Griffel's runtime drops, found as keys of a `makeStyles` style object (any depth, code only — the plugin's own lexer), with their longhands and where each sits (`within`: its slot, selectors and at-rules); shared by check-griffel-styles.js, `genpage-upload.js` (refuses a create, and an update's NEW keys — `griffelProblemsNotIn` tells them from the deployed page's) and the build's pages-phase scan (halts a new or changed page, warns for one it sends as it is), whose texts (`describeGriffelRefusal` / `describeGriffelWarning`) say what each way out does to the page; and the tests
    page-file-targets.js       ← the one page-filename rule (absolute/backslash/traversal/.tsx only/links/case collision, incl. with files already there), shared with check-page-files.js and the evals
    app-source-path.js         ← shared lexical + realpath confinement for app source reads/uploads and hashes
    page-ownership-records.js  ← local CREATE receipts and pre-delete ownership records, scoped to app/key/id
    source-literals.js         ← TSX lexer (code/comment/string/template/regex/JSX) — see "Known limits" below
    sdk-teardown.js            ← app-builder teardown engine (planTeardown is pure)
    sdk-http-client.js         ← az-token HttpClient for the vendored SDK
    spec-lint.js / app-spec.js ← App Spec guardrail lint + validation
    lookup-labels.js           ← a lookup column's default label, environment-facing half: the parent table's label read, the old-default repair's column-label read (one per child table) (the pure rule is `lookupLabelFor`, app-spec.js); `lookup-cell-labels.js` repairs the form cell
    view-filter-labels.js      ← resolves a view filter's Choice labels against the environment's option metadata; the build's pre-flight (skipped for a spec with a localized label) and views-phase gate, the dry run, verify and lint all use it
    spec-shape.js              ← shared structural normalization for both authoring gates
    surface-resolver.js        ← pure: resolve personas[].jobs[].surfaces[] to the spec artifacts that satisfy them
    role-privileges.js         ← pure: declared persona privileges + subset comparison against a deployed role
                                  (also the oracle for `roleGrants[]`, which is additive rather than converged)
    odata.js                   ← OData literal escaping helpers
    genpage-cli.js             ← pac model genpage upload/list/download wrapper, plus a page's own name read from its row (pac stores `"` as `\"`; `unescapePacName`); an uncertain create reports its candidates and stops without adopting one as an UPDATE. Every pac call is time-bounded (`runPac`: the process tree is ended when the budget runs out and the result is `{ status: null, timedOut: true }`); a timed-out list or download is retried once, a timed-out UPDATE is not (it may have landed, and a re-send can record the prompt twice or overwrite a later change: it is reported with the check to run — `genpage-base.js check` for the upload script, a `pac model genpage download` of the page and then a re-run of the build for the build, which keeps no base marker), nor is an UPDATE that failed (a non-zero exit, or an exit 0 with no Page ID: it too may have landed, and is reported the same way; only a refusal of pac's own arguments or input files is an ordinary error), and a timed-out CREATE is an uncertain create that is never run again (a Page ID pac had printed names the page it created, stalled before publish or placement; a create that fails after the Page ID is reported the same way and never sent again; every error that follows a create whose outcome is not known to be nothing carries `transient: false`, so the build's own retry of a halt that reads as transient cannot re-send it, while a create that failed outright and left nothing in the listing is retried, as in 2.13.0); `runPac` also takes an AbortSignal and the client's `abort()` ends the pac runs it has in flight, each with its whole process tree (through the same `killProcessTree` as a timeout), and keeps a call that is paused between two attempts from starting another (an attempt that was ended is not followed by another pause either, and an ended upload is never sent again; a verify pass ends the page reads it gave up on this way)
    genpage-base.js            ← base-marker hash, compare, and read/write (sibling dotfile of the code file; no environment URL)
    safe-fs.js                 ← confined output writes and deletes: the named directory's final component must not be a link or junction (readlink, not a path-text compare, so an 8.3 name and a share root stay usable); write via exclusive temp + rename. Shared by genpage markers and later callers
    hydrate-spec.js            ← reconstruct an App Spec from a deployed app (edit flow)
    verify-spec.js             ← spec-vs-deployed reconciliation core (checks are ordered tasks on a pool of 4)
    build-journal.js           ← durable JSONL build journal (resume diagnostics)
    form-preview.js            ← form wireframe renderer
    app-preview.js             ← whole-app design renderer (data model + sitemap + forms + page-intents + design)
    app-spec-doc.js            ← pure App Spec → readable Markdown design doc (model-app-plan.md)
    schema-facts.js            ← pure data-model provisioning fact extractor for evals
    pageref-resolver.js        ← PAGEREF_<key> → GenPageId nav resolver
    page-manifest.js           ← durable <app>_pagemanifest read/write
    sitemap-pages.js           ← pure GenPageId extractors + fail-closed fetchSitemap MEMBERSHIP reader + navigationProof (page ownership proof from either app layer) + cross-app scan (every other app's published AND saved navigation — the saved layer in one request — and the apps that were never published, listed in one more; a never-published app with no sitemap component is looked up by the name its sitemap carries)
    sitemap-merge.js           ← pure: re-attach an existing app's rewritten sitemap to its live nodes (ids + everything the spec cannot describe), keep designer nav edits the spec did not make
    deployed-baseline.js       ← `.maker-workspace/last-applied.json`: the spec last applied or downloaded, stamped with its environment + app and the dashboard/page ids deployed there, each page with the hash of the source the pages phase read and sent (what the build's Griffel check compares a later source with)
    ai-candidates.js           ← selects good-candidate tables for auto row-summary mode
    ai-prompt.js               ← generates tailored Copilot row-summary prompts
    _graph.js                  ← entity topological ordering (shared by build + teardown)
    system-solutions.js        ← built-in system solutions (Active/Default/Basic) — shared by download recovery + teardown skip
    phase-diff.js              ← pure spec-diff → changed build phases (advisory diff foundation)
    content-hash.js / hash.js  ← content-aware phase diff: fold on-disk .tsx/contentPath byte hashes into the diff (changed-only); `recordedContentSha` reads a page's recorded hash back (the build's pages phase compares it with the page's source to tell an unchanged page from a changed one)
    classify-changes.js        ← changed-only: classify a spec diff → fast (page-content) | full | noop + sticky debt
    apply-snapshot.js          ← changed-only: pure eligibility state machine (identity bind, debt, tombstone, generation CAS)
    apply-snapshot-store.js    ← changed-only: atomic snapshot write (writeFileAtomic, also the baseline's) + workspace lease + invalidate/claim/tombstone/delete + distrust marker
    apply-snapshot-index.js    ← changed-only: build result.created → snapshot artifact map
    workspace-paths.js         ← the `.maker-workspace` name + the guard that gates destructive --clear-workspace cleanup
    workspace-binding.js       ← a persistent `.maker-workspace` belongs to the environment it was first opened for (only `--apply` opens it; a dry run uses a temporary workspace): turns the SDK's `WORKSPACE_ORG_MISMATCH`, and a manifest the JSON parser rejects, into the build's halt (both environments as origins, the safe remedies — the teardown one only for another environment that was built in, with the folder printed on its own line; a folder that was only opened gets no build-there/teardown advice; a folder with no usable environment is moved aside, not deleted; never clears or re-binds) and into the dry run's warning
    changed-only-flow.js       ← changed-only: --changed-only orchestration (decide fast/full, live identity, snapshot lifecycle)
    projection.js              ← changed-only: pure post-apply verifiers (form placement / sitemap / page dual-hash)
    detect-browser.js          ← System Chromium/Edge/Chrome detection (used by the launcher)
    modelapps-hook-utils.js    ← Tracked-skill discovery + validator lookup for the hooks
    utf8-stream.js             ← reads a hook's stdin as UTF-8 without splitting a multibyte character across pipe chunks
    telemetry/                 ← Bundled 1DS telemetry: ikey.json (this plugin's per-region keys) + resolver.js + region/ (copy of power-pages' router) + lib/ (copy of shared/telemetry/lib)
  vendor/cds-maker-sdk.cjs     ← headless vendored SDK bundle (rebuilt via _vendor-build/)
  _vendor-build/               ← esbuild vendoring tooling (build.js + pinned deps)
  tests/                       ← node --test coverage for the scripts + hooks
hooks/                         ← Lifecycle hooks
  hooks.json                   ← Hook registrations (closed schema — documentation lives in README.md)
  README.md                    ← What hooks.json wires up, and why
  run-skill-posttool-validation.js ← Runs a skill's validate*.js after the Skill tool returns
  validate-icon-imports.js     ← PostToolUse: blocks unverified @fluentui/react-icons in generated .tsx
  validate-write-safety.js     ← PreToolUse: flags (non-blocking) out-of-cwd writes in model-apps sessions
  run-skill-pretool-telemetry.js   ← PreToolUse(Skill): emits skill_started
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

### Griffel shorthands

Fluent UI V9 styles are Griffel's, and Griffel's runtime silently drops ten shorthands from a `makeStyles` style object — `all`, `borderColor`, `borderStyle`, `borderWidth`, `borderBlock`, `borderBlockStart`, `borderBlockEnd`, `borderInline`, `borderInlineStart`, `borderInlineEnd` (`UNSUPPORTED_CSS_PROPERTIES` in `@griffel/core`; it skips the key and logs a console error). A page that writes one type-checks, transpiles, deploys and renders without it (AB#6691124); the guard used to be a grep for `borderWidth`, one of the ten. `scripts/check-griffel-styles.js --file <page.tsx>` is the gate now (the rule is `lib/griffel-styles.js`): one JSON line, exit 0 clean / 3 problems / 1 usage or an unreadable file, each finding with its line, column and the longhands to write (and where it sits, `within`, and what it is set to, `value`, which `genpage-upload.js` compares with the deployed page).

- **What it reads.** Every key of every slot's style object at any depth (`':hover'`, `'@media …'`, nested selectors; quoted, spaced, computed-from-a-string and escaped keys; `{ borderColor }` shorthand members; objects written inline in a spread), in code only — the plugin's own lexer (`source-literals.js`) masks strings, comments, templates, regexes and JSX text, so the same names there, and in an inline `style={{ … }}`, are not keys. Slot names are not properties, and an `animationName`'s keyframes are serialized as written, so neither is reported. `makeStyles` is found under its own name, an `import { makeStyles as ms }` alias and a `Fluent.makeStyles` namespace import from `@fluentui/react-components`, `@griffel/react` or `@griffel/core`.
- **`makeResetStyles` is not checked, on purpose.** The work item names it, but `resolveStyleRules` is the only code that consults the unsupported set, and `makeResetStyles` goes through `resolveResetStyleRules`, which writes every key as given (`@griffel/core` 1.19 and 1.20: `makeStyles` drops `borderColor`, `makeResetStyles` emits `border-color:red;`). Refusing a page that works would be a false reject. To check it too, add `['makeResetStyles', { slots: false }]` to `STYLE_FUNCTIONS`.
- **A style object the check cannot see is a problem, never a pass.** `makeStyles(styles)`, a slot or a selector given a variable (`root: base`, `':hover': hover`), and a spread of anything but an object written inline (`...base`, `...helper()`, `...(a || { … })`) are each `unread-style-object` — the keys behind them may be any of the ten — and the gates treat it as they treat a call the check cannot read: refused on a create or a change, warned for a page sent again as it is. So is a getter that runs, whatever key it defines (`get root() { return … }`, `get color() { … }`, with or without a space after `get`): Griffel calls it as it reads the key and a spread as it copies its object — even one whose value a later definition then replaces — and its body is code the check does not read, which may return anything and rewrite or delete what Griffel reads after it; a getter that never runs (replaced in its own object before anything reads it, or inherited under an own key) is not reported, and nor is one whose object never reaches Griffel (in a value a later definition replaces, in a prototype a spread does not copy, in an animation's keyframes), though a spread or Griffel may run it — its own object is all it can change there. Code that writes shared state (`Object.prototype.borderWidth = …`, a property of an import, a variable) changes what every object holds, as a statement anywhere else in the page could; no check of the style objects can see it, and this one does not follow it, wherever it runs (a getter's body, a Proxy's trap or a `toString` Griffel calls on a fallback value, a template's substitution) — the gate checks what a page asks Griffel for, not code written to get past it. So is a computed key the check cannot read as one string (`[key]`, `['border' + 'Width']`), which may name one of the ten or a selector — unless it is a template whose text before its first `${` no one of the ten begins with (`--${name}`, `& .${className}`, `@media (min-width: ${width}px)`), in which case its start tells what it is, and the object under one that starts as Griffel's nested keys do (`:`, `[`, `>`, `&`, `@`) is read. What a spread or a prototype (`__proto__: { … }`) brings into an object is read at that object's level — slots beside slots — and the object is resolved as JavaScript resolves it: a key's last definition is the property, own keys hide inherited ones, a spread copies only its object's own keys, and a key is the string JavaScript makes of it (a CR LF or a lone CR written in a template is one LF, however the file ends its lines; U+2028 and U+2029 stay as written), so a definition that provably never reaches Griffel is not checked, while one that may (a spread a condition chooses, a key computed at run time) is. A function member ends where its body closes, not at a comma of its type parameters or return type. Read in full: an object literal, or object literals chosen by a condition (`c && { … }`, `c ? { … } : { … }`), through parentheses, a non-null `!` and `as`/`satisfies` with a type the check reads — `as const`, or a type name with or without type arguments (no page wrote a cast in `makeStyles` at all); a keyword or literal type (`number`, `null`, `this`, …) ends at its word, so a `<` after it is a comparison; any other type leaves the value unread, so a type is never read as a value — for a slot, a selector, a spread and the call's own argument alike. Each `<` is matched to its `>` once per page (matchAngles), so a page of casts is read in linear time. Past 64 levels of nesting a value is unread and an object is reported as nested too deep, so a pathological page gets an answer rather than an exhausted stack. A number is read as a key (`{ 0: { … } }` is a slot), and a slot called `animationName` is a slot: only an `animationName` inside a style object holds keyframes. Spread without reading, alone or chosen by a condition, only as a value import from a Griffel module that the page never declares again (a read after `=` or `typeof` is not a declaration; an arrow parameter is), and only by the helper's own export names (`STYLE_HELPERS`: Griffel's 23 `shorthands` helpers and Fluent's 17 `typographyStyles` entries — never a name they inherit, since `shorthands.constructor(x)` is `Object(x)` and hands x back unexpanded; and `shorthands.transition` only where it builds its own array — any number of arguments but one, none of them a spread, or one array, string or number written in place — since given one array it returns what that array's own `reduce` returns): Fluent's `shorthands.*(…)` (it writes the longhands) and `typographyStyles.*` (font longhands only). Measured before the rule: no page among the samples, eval fixtures and pages generated on real environments (59 distinct) wrote a style object anywhere but inline, computed a key or wrote a getter, and the only spreads were `shorthands.*(…)`.
- **Lexer uncertainty fails closed**, as in the navigation oracle: a call that reaches the first place the lexer guessed what a `/` or `<` is — or a `makeStyles(` in the text after it, which a wrong guess may have blanked — comes back as an `unverifiable-style-call` problem with the remedy; a call that never closes is `unbalanced-style-call`. No committed page hits a guess (`source-literals.test.js`), so this costs a realistic page nothing.
- **What the gates hold a page to.** The check is held against what a run is about to *ship*. A page deployed by an earlier release of the plugin — whose only guard was a grep for `borderWidth`, so `borderColor` under `:hover` passed — can already carry a key Griffel drops, and it renders without it today. Sending the same bytes again ships nothing new, and refusing them would stop a rebuild (or a one-line edit) over a defect the maker did not touch, with only one way through: edit the page, and writing the longhands *changes how it renders* (those declarations never applied; deleting the key keeps today's look). So every refusal and warning says both: *deleting a key changes nothing on screen; writing the longhands makes the style start to render*.
  - **The build** holds no copy of what is deployed (and never downloads a page just for this), so it decides from the page's standing, in the pre-write scan, for each page the run uploads. A page that does not exist yet (`keyToId` has no id for it: it is *created*) and a page that exists but whose source no longer hashes to the `__contentSha` that `last-applied.json` recorded for it at the last apply (*changed*) are held to the check — `pages-griffel-shorthand`, before anything is written. A page whose source hashes to that record (*unchanged*), or that has no record (*unrecorded*), is sent as it is, and the build warns (`opts.warn`) with file:line:column and both remedies. The record is `last-applied.json` read as `opts.baselineSpec` — written by every successful full or changed-only apply and by download, and returned only for this app **in this environment** (`readBaseline`; a snapshot written before it carried those stamps is no baseline), the same hashes the changed-only flow compares. For a page an apply sent, the hash recorded is of the source the pages phase *read and checked* (`created.pageSourceShas`), not of the file when the baseline is written as the build ends: a page a maker saved while the build ran reads as *changed* on the next build, where re-hashing the files would have recorded the edit as applied and let a new key through on a warning. What is sent is what was checked: every page, a navigation source or not, goes to pac from a staging copy of the bytes the scan read (`writeStagingFile`), never from its own file, so a save made after the check does not ship until a build has checked it. A page a changed-only run did not send keeps the record it had (with none, the hash of its file as it is). *Unrecorded* — a new, moved or cleared workspace, another environment, or an apply that predates the record — fails **open** on purpose: the release before this check built such pages with the CSS silently dropped, so refusing one now would regress a rebuild that used to complete. The cost is that an edit that adds a key to an unrecorded page is warned about, not stopped, until a build has recorded it; a page that does not exist is always held, record or not.
  - **`genpage-upload.js`** has the deployed page in hand (an update downloads it for its base check), so it refuses only what that page did not already have. A create is refused outright. For an update each key is told from the deployed page's by `griffelProblemsNotIn`: the same key set to the same value in the same place (`within`: its slot, selectors and at-rules), or failing that the same key and value anywhere that nothing else has claimed — so a renamed slot or a moved rule is not new — and each deployed key is spent once, so a second `borderColor` where there was one is. A key given **another value** is new too: Griffel drops the new value as it dropped the old one, so the page would show none of the change the maker meant (a value is compared as written — a quoted string by its text, whichever quotes, anything else as its source text with the white space collapsed — and nothing is evaluated, so `tokens.colorBrandStroke1` is that text). A file that *is* the deployed page (a BOM or final CRLF aside) is a re-send, and none of it is new. A key the deployed page already had goes ahead, with a `warnings` entry in the result; a new one is refused, and `--overwrite-deployed` is no way past that (it is about edits made to the deployed page, not about what the file writes). The deployed page can be unreadable only under `--overwrite-deployed`; nothing then says what it had, so the update goes ahead with a warning, as an unrecorded build page does.
  - **A call the checker cannot read** is not CSS Griffel drops, and is not said to be: the message says the check could not read the page's styles, quotes the call, and says what to change in the code (parenthesise the operand, end the statement, or move the call above it). It is never "already there" — what it hides cannot be compared with anything — unless the file is the deployed page itself. And the checker command a message suggests quotes a path that has white space.
  - **`check-griffel-styles.js`** has no notion of what is deployed: it reports every key it finds, a page's old ones included. For a page that already had one, deleting it is the edit that preserves the page (`/genpage`'s edit flow says so).
- **Who runs it.** Three places, so no path to an upload skips it. The orchestrators run it per page, before any transpile or upload, for quick feedback: `/genpage` (single page, multi-page, edit flow, and the §7.5 fix after a browser verify) and `/app-builder` (before `promote-intent-pages.js`, and for a page edited by hand before a rebuild). The page-builder worker has no shell, so its Step 2.6 gives it the rule and a Grep self-review instead. And the code **enforces** it where pages are uploaded, whatever the instructions did or did not get run: `genpage-upload.js` reads the code file first and refuses a create with `code: "griffel-shorthand"` (file, line, column, longhands and what each way out does in `error`, the same list in `problems`; before any listing or download; a file it cannot read is refused) and, for an update, any key the deployed page did not already have (above), and the build's pages phase halts as `pages-griffel-shorthand` in its pre-write scan, before any page is created or updated, for each page that run uploads that is new or changed (a changed-only run checks only the pages it selects; a full build checks every implemented page). Both send `pac` what they checked, never the file again: the upload script reads the code file once and uploads a copy of those bytes (an update lists the environment and downloads the deployed page first — seconds in which the file can be saved), and its base marker records their hash; the build sends every page from a staging copy of the bytes its scan read, and records their hash. `genpage-upload.js` refuses `--compiled-code-file`, since `pac` would deploy that JavaScript instead of the checked TypeScript. Both build their text with `describeGriffelRefusal` / `describeGriffelWarning`, so one defect has one wording. It is deliberately not part of `genpage-worker-output.js` / `promote-intent-pages.js`: their failure sends the page back for a full rewrite, and this one is fixed by a targeted edit. The one rule text is the same in `references/rules.md`, the genpage skill and edit flow, the page-builder agent and the app-builder skill, and `genpage-dispatch-contract.test.js` fails if any drops it or the command (and if `verify-flow.md` or the app-builder edit step drops the check).

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
  an operator ending in `=` (`=` `==` `===` `!=` `!==` `+=` `<=` `>=` …); `=>`; `&&` `||` `??`; and the keyword
  `return` (`return (navigateTo)({ … })`) on the line of the `(` — a line break between them makes `return;` a
  statement of its own — as the whole word (white space, the start of the source or one of `;` `{` `)` `:` right
  before it, so no `xreturn` and no `\u0061return`; `}` is not one, because `\u{61}return` ends in it) and not
  after a `.` (a member named `return`). It is an
  allowlist because the tokens that END a callable operand are many and easy to miss — `!` (a non-null
  assertion), `>` (a generic instantiation), a back-tick (a tagged template), `}` (a function expression, which
  a block's `}` cannot be told from), a name or keyword, `)`, `]`, `.`, `?.`, `++` — and each makes
  `(navigateTo)(…)` an argument list: `factory!(navigateTo)(…)`, `factory<unknown>(navigateTo)(…)`,
  ``tag`x`(navigateTo)(…)`` and `function () { return f; }(navigateTo)(…)` hand the object to whatever
  `factory`, `tag` or the function returns. (A denylist of those tokens missed four of them.) `await` and
  `yield` are **not** on it, although `await (navigateTo)(…)` is a navigation in an async function: outside
  one — and in an arrow that is not async, inside an async function — `await` is a name, and the object goes
  to what `await(navigateTo)` returns; the lexer cannot tell where it stands (the oracle test
  in `pageref-resolver.test.js` holds TypeScript's reading and the execution of both). A callee group at
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
  `<div data-active={e}>` are elements. The `/` is the one that rule does not settle for the lexer: in a type the same
  `<T extends /` opens type parameters, whose constraint is read as an expression where it starts no type
  (`parseTypeParameter`), here a regex — `let f: <T extends />;…[/]/>(a: T) => T` is a function type — and the lexer
  does not always know which of the two it is in, so `extends` and a `/` is the guess `generic`, read as the element
  (`/=` is another token, and type parameters in both) — unless the regex that the `/` would begin does not end on its line,
  which no type-parameter list has (TS1161: TypeScript's scanner ends a regex at a line break, `regexEnd`), so `<Flag extends />`
  with no other `/` after it on the line is the element's for certain. A lexer that searched for a parameter list and a later `=>` took the
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
  cast's type) is an operator, not the end of type arguments, and an operand follows it, certain too: `x as A<B> > /re/.test(y)`, `<b/> >> 1`. The operand after
  that binary operator is a unary expression, so a `<` there opens an element and nothing else — `x as A<B> > <T extends X>text</T>` is an element, never read by the
  arrow rule as type parameters. A chain of casts
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
  escapes, so `<Wrapper>(<Child x="\" y=") =>" />)</Wrapper>` is one JsxElement with no diagnostic; where the list's
  first token is the `<`, as there, it holds no parameters and the element is certain — see `parameterListMayStart` below); the text holds
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
  list too long to scan: the guess `generic`, and everything after it not trusted. The list is matched as JavaScript reads it, with comments, strings and
  templates skipped (a template whole only where each substitution closes, and holds no `<` after something that may start an expression, where JSX —
  whose quotes are no strings — may stand: `templateSkipIsWhole`). In a type that reading is exact until something in the
  list may start an expression — an initializer's `=` (any `=` but the `=>` of a function type and the `=` of `==`, `===`, `!=` and `!==`, which stand only in an expression already entered), a `[` other than `[]`, a decorator's `@`, an import
  type's `import`, an accessor's body in a type literal (`get`/`set` before an accessor's name — a `[`, a name, a string or a number; before a `:`, a `?`,
  a `(` or a `<` each is a name and starts nothing; TypeScript parses a block after an accessor and only its checker objects), a type parameter's
  constraint (`extends` before what starts no type — a `/`, `class`, `super`, `delete`, an operator, a `#` or an `@` — for a constraint that starts a
  type is read as one, and a conditional type's `extends` is always followed by a type) (`expressionMayStart`) — and a type holds no `/` outside a comment, a string or a
  template, so a `/` before one leaves only the element (`<p>(see: /docs)</p>`, `<span>({done}/{total})</span>`). After one the scan is still exact while
  it reads no `/`, `<` or back-tick (no regex, no JSX, no template: every quote is a string and every parenthesis code), so `<span>(@username)</span>` and
  `<p>(x = 5)</p>` are read as before; once it reads one, the expression may hold a `)` of its own — a regex's, JSX text's, a nested template's — and
  with no arrow after the `)` it found, the list is the guess (`interface I { <T>(a = /[)]/); m: '</T>…' }` ended the list at the `)` in the regex's class).
  Three things are read exactly instead, because TypeScript reads each one way (`initializerReading` and the scan's loop), and none of them needs a parser:
  the first token of the first default, where it is a `/` — nothing is there to divide, so it begins a regex, which ends at its own `/` on its line (`(a = /x/)`,
  `(a = /[)]/)`; a line break before the closing `/` is TS1161, and no program that parses has it) — or a `<` that the arrow rule above leaves an element, which is read to its
  closing tag (`(a = <b>c</b>)`); a `/` after a name or a number, which divides in an expression (`(a = b/(c))`, `(score = 3/5)`), unless a `{` has been read, which may open a function body, where a
  statement starts and a `/` after a `)` may begin a regex; and a template with no `${`, which holds only its own text. The `=` must be an initializer's, so no `<` stands before it (it may be a
  type parameter's `=` default, where a `<` opens a function type); an `=` that `</` follows is no default in any signature or function type (TS1109, TS1110), so `(Tip: use <code>=</code>)` is the
  element's alone. A second default, a regex or an element that is not a default's first token (`(a = f(/x/))`, `(a = <b>c</b> / 2)`), a `/` after a bracket, a `)` or a comment of either kind, and a template
  with a `${` stay the guess. A comment is trivia to TypeScript, so after one the last token is the one before it, and a `/` after one is a regex or a division by that token: a block comment ends in a `/`, which is no
  word (`1 + /* c */ /[)]/`), and a line comment ends in whatever its text does — a name, a number, a `$` — which is no operand: in `a = 1 + // fallback` and a line break, `/[)]/)` is a regex whose `)` is not the
  one that ends the list, and a scan that took the `/` for a division ended the list there and read the string of the type after it as code. The scan of a list does not find its comments one by one, so a `/` after a comment of either
  kind is the guess there (`slashFollowsAnOperand`); the reading of the text after a signature opens its comments itself and judges a `/` by the token before them (below) — the same misread hid the closing tag of
  `interface I { <T>(x); m(a = 1 + // c` LF `/[</T>;navigateTo(…)//]/): void }` in a regex, and read what followed as code. The character before a line break is in a line
  comment only if a `//` stands before it on its line (`lineMayEndInComment`), so a `/` after a name or a number on a line that holds no `//` still divides (on a line of its own after a comment's line, too); the `//` of a
  string, which a line may begin inside of, is not told from a comment, nor is a line that begins beyond the window: each is the guess too, the safe side.
  A list that can hold no parameters is
  the element's alone, with a `:` after it or without: its first token a number, a string, a template, a `#` or an operator
  (`<li>(1): First</li>`) is TS1003 in every signature and function type (`parameterListMayStart`; a character beyond ASCII and a
  `.`, which may start `...`, are not judged); so is one whose parameters fail before a default, a pattern or a modifier, or at the second token of
  their type — a name followed by anything but `?`, `:`, `=`, `,` or `)`, a keyword that is no parameter's name, a later parameter that starts as no
  parameter does, or a type whose second token is a name (`<span>(press [/] to search)</span>`, `(see docs)`, `(optional, <a>…</a>)`,
  `(get the <b>app</b>)`, `(extends <code>Base</code>)`, `(Note: see the <a href="/x">docs</a>)`, `(Note: <a href="/x">docs</a>)`: TS1005/TS1003;
  `parameterSyntaxFails`). A keyword there is read as TypeScript reads it: the thirteen modifiers it takes before a parameter's name (`public`,
  `readonly`, `async`, `in`, `out`, …) end the reading, the thirty-three words that are no parameter's name (`extends`, `import`, `new`,
  `class`, …) fail the list — but `default`, a modifier before what it can head (`interface`, `class`, `function`, `abstract`, `async` or a
  decorator), ends the reading there — and every other keyword (`get`, `set`, `of`, `type`, `this`, …) is a name. A type is read to its second token
  (`typeStartFails`): a name after a type reference is TS1005 unless the first word takes a type (`keyof`, `typeof`, `readonly`, `unique`, `infer`,
  `asserts`) or the second is a conditional's `extends`; `this` and `is` on one line are a type predicate, which TypeScript reads in any type, and the
  type after `is` is read the same way (`this field` fails, `this is string` does not); a type reference's first type argument is read the same way
  (`see<a href` fails at `href`); a name after a generic function type's first type parameter is TS1005 unless the first word is a modifier, which
  TypeScript parses there whatever it is (`<private x>`); and a type that is one name and a `,` lets the next parameter be read as the first was
  (`(Type: string, <a href="/x">docs</a>)` fails at the `<`). Four more types fail at their own second token, each measured over every keyword after it: a number
  literal and a name that is not a conditional's `extends` (`(Size: 10 MB max, <a href="/x">upgrade</a>)`: TS1005; the number may be negative or have a fraction, and white space or a comment follows it);
  an object type whose first member is a name and then a `.` or an operator no member has (`(Name: {user.name}, <a href={profile}>edit</a>)`: TS1131, a line break and a comment
  before it as well; a `.` and a digit is a numeric name, so it is no failure); `new`, which a `(` or a `<` must follow (`(Mode: new <a href="/x">beta</a>)`, and after the `<` the type parameters are read
  as above); and `import`, which a `(` must follow (`(Hint: import <a href="/x">docs</a>)`). Tests measure the classes over every keyword TypeScript has, every keyword before every
  other one, and every two-word type start and second parameter with the endings that could complete it. One place settles even those: **directly after the head of a type alias, `type Name =` at a
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
  `<span>(total: {count})</span>` are decided by that token alone. **Where no member of a type can begin at the head, there
  is no signature at all**: right after an `=` or a compound assignment (`+=`, `||=`, …), an `=>`, a `(`, a `[` or a `:`
  (`NO_MEMBER_BEFORE`) a call or construct signature, a method and an index signature cannot stand, and a function type needs the `=>` that
  this shape lacks, so `<Name>(…)` that neither `=>` nor `:` follows is an element, for certain, whatever its text holds (`const help = <p>(optional);` and
  a line break, then `foo( // note` and a line break, then `/docs</p>;`). After a `,`, a `;`, a `{`, a `}`, a `)`, a `?` or a keyword a member may begin — `return <T>(x)` is a method named `return`,
  `m? <T>(x)` is a method with an optional mark, and TypeScript parses both, so neither a keyword nor a `?` is in the set — and the text is read as
  follows. (The set was measured against TypeScript's parser over every place a token can stand: no program has type parameters with no
  arrow and no `:` after a token of it, and a program has them after each token the rule reads that is left out: `source-literals.test.js`.) *Where the member may end there, the text after
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
  a `/` that no word or number stands before and that so may start a regex (a keyword that an expression follows is no such word: `return`, `typeof`, and
  `implements`, whose heritage clause takes one, as in a computed name `[class C implements /…/ {}]`; and a `/` after the comments that the text opened is judged by the token before them, which a type reads as trivia:
  `b // c` and a line break, then `/d`, divides, and `1 + // c` and a line break, then `/[</T>…]/`, does not — and a `)` or `]` before the `/` divides, since a regex follows a `)` only after the head of a statement, which has a block, whose braces
  are not read: `slashFollowsAnOperand`), and a quote that starts a string closing on its line and
  covers the closing tag (a quote right after a word that is no keyword, an apostrophe or an inch mark, opens none; a keyword is a reserved word, a contextual one,
  or a modifier, which TypeScript takes before a quoted member name: `public'…'`). A nested tag is an element's or, to a type, something else: the type arguments of a name (`Array<b>`), a comparison (`a<b>c`), the type parameters of
  a signature or of a method (`<b>(y): T`, `<U extends A>(y): T`, `m<b>(y)`), where the text after its `>` is code and what looks like its closing tag is inside a string, a template or a comment that the text opened before it. So a
  string, a template or a comment that the text of a nested element opens — and the run of comments that a `/` is judged by — and that is still open at the closing tag of that element is read **both ways** (`scanChildren`, run
  twice by `readChildren`): as an element, where it ends there and the code goes on after the closing tag (`m(a = <b>'x</b> + '</T>…')`: the string that holds the closing tag begins after the element; `m(a = <b>x // y</b> +` and a line
  break, then `/[</T>…]/`: the regex does), and as code, where it goes on past it (`m: Array<b> = '</b>' + '</T>…'`, `<b>(y): '</b>'; q: '</T>…'`): the closing tag of the head is hidden if either reading hides it. A tag that no type has
  (`tagMayBeCode`) is an element to every reading: there is only the first, the region is cut at its closing tag, and its text is JSX text, which opens nothing (`jsxText`: a URL, an apostrophe or a back-tick in the text of a link is
  text). That is a tag in which every word has a value (`<a href="/x">`; and `<button type="button">`, `<label for="x">`, `<Link as="span">`, where the word that has a value is an attribute's even when it spells a keyword: the only `=`
  in a list of type parameters is a default, which its name owns; and one whose attributes stand each on a line of their own, as a formatter lays a tag out, has every `=` on the line of its word), an attribute that `extends` does not introduce (`<b d>`), a dotted name with an attribute, and a fragment where no empty list can stand. **Every other tag may be code,
  by the words in it**: a keyword of TypeScript's, other than `extends`, in a word that has no value is a modifier of a type parameter (`<public U>`, `<in out U>`, `<readonly U>`: `parseTypeParameter` takes them all, and only the checker
  objects), an operator of a comparison or a tagged template with type arguments (`x <a in b> y`, `x <typeof U> …`, `x <new b> …`, `x <A.B as T> …`), or a type operator in type arguments (`Array<keyof X>`) — and so is a dotted or dashed word
  that has one — **or by the lines it takes**: a line break between a word and its `=` (`href` and a line break, then `="/x"`), or before a `get` or a `set` that has a value (`get="/x"`). A line break ends a member of a type, so where the tag stands
  in one, `m: A = x <a` ends its initializer at the break, `href` is a member of its own, and `="/x"> '</a>' + '</T>…'` is that member's initializer, with the string that holds the closing tag in it (a name and a `=` on one line are no member,
  TS1131, but `get` and `set` begin one before the parser looks at what follows, so `get="/x"` on a line of its own is a property with an initializer: `isTypeMemberStart`). And a fragment is an empty list of type parameters or arguments right after a name,
  a `)`, a `]`, a `}`, a `!`, a quote, a number or a `.` (`f(x)<> || …`, `a[0]<>`, `'s'<>`, `{}<>`, `1.<>`: the parser accepts an empty list there and the checker
  rejects it) or right before a `(` or a back-tick (`<>(y)`, `m<>(y)`, `` x <>`t` ``), and after a line break when the line before it may end in a comment, whose last character may be any (`f // note:` and a line break, then `<> || …` is `f<> || …`:
  `lineMayEndInComment`) (`fragmentMayBeList`); after a `,`, a `;`, an operator or nothing, on a line that has no comment before it, it is a fragment, for certain. The keywords are TypeScript's own list (`TS_KEYWORDS`), and the
  sweeps draw their tags from every keyword it has, joined to names, dots, dashes and values, **including the tags the rule calls no code** — a rule that is wrong about a word can only be met that way (`nestedTagPages`; the sweep of
  the valued keywords keeps the precision of the rest). A tag that a type may have and an element may too (`<b>`, `<U extends A>`, `<A.B>`, `<public U>`) is read both ways, and a tag that is not read leaves it possible; two such places
  in one text are taken for hidden, as the second reading depends on the choice made at the first. A place is a region that the text of a nested element opened and that is still open at that element's closing tag, **told by where the region starts**,
  not by where it ends: two `//` comments on one line, each opened in the text of an element of its own (`m(a = <b>//</b> - <i>//</i> ??` and a template that starts on the next line), end at the same line break and are two places (`skipFrom`; `nestedPairPages`). A tag inside a string, a template or a
  comment that the type's own text opens is no element's to the type (`'a <b>' + \`</b>\` + '</T>…'` holds `<b>` and `</b>` in two literals): it opens and closes in the element reading and counts for nothing in the depth
  that those rules use (a ghost, `realDepth`); and a tag inside a region that the text of a nested element opened is a ghost in the reading where that element is code, which pairs the quotes after it as a type does
  (`m: Array<b> = '<>' + '</>' + '</b></T>…'`: the element reading cuts the second string at `</>`, the type reads three strings), so where one stands the text is read both ways too (`tagged`). Where the text up to such an opener cannot be the members of a type, though — two names on a line,
  a name and a `/`, a sign, a `.` or a quote (`<p>(a), see https://x.y</p>`, `<p>(a); well-known // c </p>`, `<p>(a), it's // c </p>`: TS1005 in a type), a `:` after a type
  (`Docs: https://x.y`), a `/` where a type must follow a `:` (`https://x.y` and a line break, then `/b`: TS1110), a template or a regex where a member would begin (``<p>(a); `x ${y} </p>``: TS1131;
  after a member's colon a template is a type and stays possible) —
  no type holds the closing tag in anything, nothing that follows can hide it, and it is an element (`typeMembersFail`, asked at each opener from where it stopped, through the comments between them). It is a small
  reader of where a member is — its start, a name, a `:`, a type, an initializer; the next line of a name and the next line of a type are different places (`PROSE_*`) — and what it reads is TypeScript's: a number is one name by
  the scanner's rule (`1e-5`, `.5`, `0x1F`; a hex, octal or binary literal ends at its last digit, so `0x1Fin` is `0x1F` and the operator `in`, where a word right after a decimal literal is TS1351), a keyword is a name where a member begins
  unless it may be a modifier (which a `:` after it makes a name too), a word after a `.`, `typeof` or `infer` is a name, whatever it spells (`A.new`, `typeof new`, `infer keyof`; but `typeof import` is an import type, whose `(` has no line-break rule: `typeof import` and a line break, then `('./m')`, is a type, `typeofImport`), after `keyof`, `readonly` or `unique` it is a type, of which a
  keyword is the name (`keyof new`), and a word that starts a type a word may follow (`asserts b`) is not read; a word written with an escape (`a\u0061b` is ONE name) is not read; a `(…)` or `[…]` that closes is one thing (a signature's parameters,
  a computed name, a parenthesised type, an array), `<T>` is type parameters only where a parameter list follows, a type goes on with `.`, `|` and `&`, and two operands of an initializer side by side are an error unless a keyword is one
  of them. A name or a keyword that a `(` follows opens a parameter list, whose first parameters are read as a head's are (`parameterListMayStart`, `parameterSyntaxFails`): a `/` right after the `(` and its comments is TS1138, a number,
  a string or an operator there is TS1003, and two names are TS1005 — so `foo( // note` and a line break, then `/docs` is no type's, and neither is `m(see docs) // note` (the `(` of an import type is no parameter list, and is not read as one: `typeof import`). A name, a number, a string or a signature with a `=` right after it on its line
  is no member (TS1131; TS1005 after a signature): the initializer that a property signature may have — the parser accepts it and the checker rejects it — follows a `?`, a type, a computed name, `get` or `set`, or a line break
  (`m? = 1`, `m: A = 1`, `[m] = 1`), and `m = 1` is TS1131. A `[`, a name and a `,` or a `:` are an index signature for certain (`isUnambiguouslyIndexSignature`) — unless `get` or `set` stands before the `[`, which then begins an accessor's computed name,
  an expression that a regex may hold (`get [a, /[</T>…]/]()`: `parseContextualModifier` takes the keyword first, whatever its line) — and neither a parameter nor a type starts with a `/` (TS1138, TS1110):
  `[ a, // note` and a line break, then `/path` is no type's, where `[ // note` and a `/` is a computed name that a regex may follow, and neither is `Total: [ // note` and a line break, then `/docs`, where the `[` after a `:` opens a tuple. Each place has the characters that fail there, **measured over every ASCII character against TypeScript's parser**, and the sweeps in `tests/source-literals.test.js` put every claim back to TypeScript. What it cannot
  follow — a `[` that nothing closes on its line, an initializer after a `?`, a type or a computed name, a conditional type, an expression, a decorator, a `{` — leaves the rest undecided, and the closing tag may be hidden there. Where one is open at the closing tag, or the reading cannot say (a container or a tag it
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
  | `generic` | `<Name>` and a parameter list followed by `:`, which is the call signature of a type or JSX text that starts with a parenthesis (both compile; a list that can hold no parameters, `<li>(1): First</li>`, is the element's alone); or one followed by no return type, where a string, a template, a comment or a regex after it could hold its closing tag, or its text cannot be read to the end of an element, or the pass's budget of readings is spent (a signature with no return type is otherwise code, for certain, and JSX text that starts with a parenthesis an element: `callSignatureOrElement`); or a parameter list too long to scan (2,000 characters), or one with no arrow after it in which something may start an expression (`expressionMayStart`: an `=`, a `[` other than `[]`, an `@`, `import`, `extends` before what starts no type, and `get` or `set` before an accessor's name) and a `/`, a `<` or a back-tick follows that the scan does not read exactly (a first default's regex or element, a `/` after a name or a number that is no line comment's last word, a template with no `${`: `initializerReading`), or a template whose substitutions do not close or hold a `<` after an expression start (`templateSkipIsWhole`), or `<T extends` and a `/` that begins a regex which its line ends (an element where an expression starts, type parameters with a regex constraint in a type) — except directly after `type Name =`, where it is certainly a type. A `=>` after the list is a generic function type for certain when the element reading of the text up to the arrow cannot parse (`elementFailsAt`: a `>` or `}` in the text, a container that starts with a name, a number or a quoted name and a colon, two names, a bracket, a call or a quoted name and a call and a colon, a `<` and a character that cannot start a tag, …), and a guess, read as a type, when it may: the arrow inside the attribute string of a nested tag (TypeScript scans a JSX attribute string with no escapes), a closing tag, a fragment, a spread, a comment, an attribute value that does not follow its `=` at once, a character beyond ASCII where a token could start or end in a tag, or a container that holds a brace, a quote, a back-tick, a `/`, a backslash or a `<` and none of the shapes `elementFailsAt` knows; a `<` followed by `await` or `yield`, which are identifiers or not by the function around them | `interface I { <T>(x: T): T }`, `interface I { <T>(x); m: '</T>' }`, `<span>(required): Name</span>`, `<p>(a), b/c</p>`, `const f: <T>({ a = {} }: P) => T = g`, `const f: <T>(x: { 'a'?(y: T): T }) => T = g`, `async function p() { <await extends X>t</await> }` |
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
  holds the closing tag in a string as the text of a call signature's parameter, in a member name quoted after `public`, or in
  a regex after `implements`), a label and a list that no signature has (`(Size: 10 MB max, <a>…</a>)`, an object type that is none,
  `new`, `import`, an `=` and a closing tag: TypeScript rejects each in a call signature, a construct signature and a function type,
  and the element is certain) and a parameter list whose default is a regex, an element, a template or a division (read exactly where the
  scan can say where the list ends, a guess for the rest, and never a misread token), a regex or a division after a line comment (one that ends in a name, a number, a `$`,
  a letter beyond ASCII or a sign, and every line break TypeScript has, in the scan of a list, behind `>=`, `in` and the other tokens that leave a `<` undecided, and in the reading of the text after a signature), JSX text of several lines with a `//` in one and a
  `/` at the start of a later one (a URL on a line of its own, a label and a URL, a name and a note, with `;`, `,` and a line break after the `)`: read for certain wherever no type has the text, and the lines of every class that no type has —
  a bracket, a quote, a tag, an operator, a number, a modifier, a postfix, a line that goes on over a line break or after a type — are certain too; a closing tag in the comment, in an element and as the members of a type, a guess; and
  the same lines in an expression of a type, where a regex after the comment may hold the closing tag), a member named by a number with a signed exponent (`1e-5` is one name), the text of a nested element in a default value or
  a computed name (what it opens ends with it, unless the element may be code), a literal that holds the tags of an element (in one string, or `<b>` in one and `</b>` in the next), the text of a nested element drawn from quotes, back-ticks,
  comment openers and tags, a nested tag that no element has (type arguments, a comparison, the type parameters of a signature or a method, in front of a string that holds its closing tag: read both ways, and
  the closing tag of the head hidden) — drawn from every keyword TypeScript has, joined to names, dots, dashes and values, spread over lines (a line break of every kind before an `=` or a valued `get`; a formatter's layout), with fragments after every operand, after a comment of every ending and before a parenthesis, **the tags that the rule calls no code included**
  (`nestedTagPages`) — two or three nested elements whose texts open regions that end at one place (`nestedPairPages`), a keyword that is the name of an attribute with a value (certain: nothing is refused),
  strings and elements that hold fragments, tags with attributes and closing tags after such a tag (the quotes pair differently in the two readings), links and other tags with attributes in a
  hint (certain: their text is text), and a parenthesised callee after `return`
  — each read token by token against TypeScript's parser — and every claim of `typeMembersFail` that a text is no type's members, put to TypeScript's parser (every text of up to three tokens of a vocabulary of the pieces of a
  member and what is rejected there, seeded draws of more, runs of valid members mutated at one or two places, every keyword of TypeScript in each place a word may stand, after each of the words that start a type or a member, after a `.`,
  `typeof`, `infer`, `keyof`, `readonly` and `unique`, and a number of every spelling with a word, a quote or a `/` right after it, a `/` after every operand that ends in a bracket, import types and accessor names of every spelling, and tuples: `tests/helpers/type-member-texts.js`) — and a differential fuzz
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
  rewrites. What that asks of the base depends on it: one from before the lexer was hardened misreads shapes the
  corpus holds, and the net must see at least 100 of its decoys rewritten (and none of this lexer's); the previous
  release reads every page of the corpus right, so it rewrites none and nothing is demanded of its count — the
  comparison is then the pages this lexer resolves and the base does not (at least 100), and the pages it refuses that
  the base resolves, of which there must be none: a page that 2.13.0 resolved and this lexer refuses is a regression, and the test fails on it. When a change makes the lexer refuse a shape it resolved, this is where it shows: add the shape to
  the generator, and fix the rule. **The oracle tests skip themselves where the variable is not set** (`TYPESCRIPT_ORACLE_PATH`, `BABEL_ORACLE_PATH`, `BASE_LIB_PATH`) **and fail where it is set and the package or the lexer cannot be loaded**
  (`tests/helpers/typescript-oracle.js` throws), so a wrong path or a renamed file cannot turn the job green without running them. The CI job `test-model-apps-lexer-oracles` (`.github/workflows/model-apps-script-tests.yml`) installs
  TypeScript 5.8.3 and `@babel/parser` 7.29.7 under `$RUNNER_TEMP` — outside the plugin, which ships no dependency, with `--ignore-scripts`, at exact versions — fetches the lexer of the 2.13.0 release by its commit hash, sets
  the three variables, and runs `node scripts/run-tests.js`. A new TypeScript release can change what a sweep judges: raise the pin in the same change, and run the sweeps.
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
  template after a separator, which is the comment or the template of a type's members that holds the closing tag, and JSX text that starts with a parenthesis and holds a default whose
  regex, element, division or template the scan does not read (`(a = f(/x/))`, `(a = <b>c</b> / 2)`, ``(a = `${b}`)``: the `)` it finds may be one of that expression's), and a `/` that a line comment stands before
  (`(a = 1 + // c` and a line break, then `/[)]/)`: the comment may end in a word, and the regex is no division), and JSX text of lines with a `//` in one and a `/` at the
  start of a later one, where the members of a type could hold the closing tag in the comment (the next bullet), and
  `<T extends />` with another `/` after it on its line (`generic`); and a `/` on a later line than its operand
  (`newline`). A `/` or `<` that follows a `/` is no class of its own: where the lexer read the regex (flags included), the element or
  the division itself, it knows what ended there (`ends` in `lexInto`), and the page resolves — and so does a cast it proves (`castKeywordIsCertain`). What stays the `angle` guess among casts is a limit of the walk back over the type, not a place where two programs share
  their text — TypeScript reads each of these one way: a type that begins with `keyof`, `typeof`, `unique` or `readonly`, or is parenthesised; a `>>` that touches a cast's closer (`x as A<B>> / 2`); a chain past `CAST_CHAIN_LIMIT`; and, as the `newline` guess, a line break after a cast type that ends in a name or a `]`.
  A head with a constraint and a parameter list that a `:` follows, after the cut `>=`, `>>=` or `>>>=`,
  is the same kind of place (`operator`: `a >= <T extends X>(y: T): T</T>` is an element,
  `let x: A<number>= <T extends X>(y: T): T => y` an arrow); no generated page has it, so a pair of programs stands
  for it. Each says which it is and what to change in the report, and nearly every other page that compiles resolves.
- **JSX text of lines, one with a `//` in it and a later one that starts with a `/`, is read for certain wherever no type has the text, and is a guess where the reading of a type's members cannot show it.** `<p>(a);` and a line break,
  then `https://contoso.com`, a line break and `/docs`, is the text of an element, and the same text could be the members of a type — a name, a `:`, a comment, then a `/` where a type must be, which no type has (TS1110). The lexer
  reads the text after a signature's `)` as those members (`typeMembersFail`, above), and a `/` after the comments that the text opened follows the token before them (`slashFollowsAnOperand`), so a URL, a label and a URL, a name
  and a note, and every line of the classes below resolve: a line that begins with a bracket, a quote, a tag or an operator (`(x) // c`, `[x] https://x.y`, `'x': https://x.y`, `<b/> // c`, `|| // c`), has a number for its name
  or ends in a postfix (`1.5 https://x.y`, `x! // c`, `f() // c`, `x = 1 https://x.y`), starts with a modifier (`readonly https://x.y`, `in // note`, `default // note`: where a member begins these are names, and a `/` after one is
  TS1131), or goes on over a line break or after a type (`m` and a line break, then `&"x"`; `a: A.B, // c`). The base took the last word of the comment for the token before the `/`, which is right for these pages and wrong for others
  (the misreads that this lexer refuses). **Where a member of a type may begin at the head, a few lines are still refused after the guess `generic`, though only the element compiles, and the base may have resolved them**: a line
  whose last token before the `//` is a `[` that nothing closes on its line (`[ // note` and a line break, then `/path`), an initializer's `=` after a `?`, a type, a computed name or in a parameter list (`m? = // note`,
  `m: A = // note`, `f(a = // note`, `[ x = // note`), or an operator in such an expression (`m: A = b + // note`). A regex may begin at the `/` of the next line, and the closing tag may be inside it; both programs compile
  (the pairs of `valid-page-differential.test.js` are the proof), and 2.13.0 takes the word that ends the comment for the token before the `/`, which resolves the page of the element and rewrites the data of the other. Their
  shape cannot be told apart without a parser: `return <p>(a);` and a line break, then `[ // note`, is the same text in an interface that has a method named `return` and in a function that returns an element, and `return <T>(x)` and
  `m? <T>(x)` are why no place that a member may begin is excluded (above). A line that ends in a `[` after a `:` or a type is none of them, since a tuple's or an indexed access's first type is no `/` (`Total: [ // note`: TS1110), and is certain
  in every place. A rule over the regex that the next line's `/` would open could win more of these pages back — where it ends at the closing tag's own `/` (or the regex does not close on its line) and what follows the tag cannot be an operand, only the element compiles — and no rule reads that
  today. After an `=`, a `(`, a `[`, a `:` or an `=>` the same lines are certain (`NO_MEMBER_BEFORE`),
  and these lines are certain in every place: a name, a keyword or a signature and a `(` that is not closed on its line (`foo( // note`, `if ( // c`, `m(see docs) // c`: TS1138 at the `/`, TS1003 or TS1005 in the list), and a name, a number, a
  string or a signature with a `=` right after it on its line (`x = // note`, `1.5 = 1 // c`: TS1131). What the reading does not follow — a conditional type, an expression, a decorator, a `{` — leaves the type undecided, and the
  page is refused only where an opener after it (a `/` after an operator or an open bracket, a quote, a back-tick) could hold the closing tag. `valid-page-differential.test.js` with `BASE_LIB_PATH` fails on a page of its corpus that
  2.13.0 resolves and this lexer refuses, and it reports how many pages of the member-position lines 2.13.0 resolves (they are not in that corpus: they are the class above). Put the call before the text, or write the line with one name before the `//`.
- **Shapes of type parameters among a type's members are read as the element they are not, exactly as 2.13.0 reads them** (the same output in 2.13.0 and in this lexer, measured over every keyword TypeScript has): type parameters
  that start with a modifier — a variance modifier (`<in U>(y): void`, `<out U>`, `<in out U>`, also with no return type) or one that only the checker rejects (`<public U>(y): void`, `private`, `protected`, `readonly`, `static`, `abstract`,
  `async`, `declare`, `override`, `accessor`) — and an empty list (`<>(y): void`, `new <>(y)`), wherever a member of an interface or an object type begins (a page is refused at an earlier call signature that was guessed at; a `const` is refused too, a guess); and a method named by `delete`,
  `typeof`, `void` or `instanceof` (`delete<U>(y): void`, `typeof<U>()`), where the other 79 keywords are refused. A `<` after a keyword, or a head that starts with a reserved word, a modifier or `>`, is the tag of an element to the lexer, and a type reads it
  as type parameters. Where a string, a template or a comment later in the same type holds a closing tag with the name, a `;` and the text of a navigation call (`<in U>(y): void; a: '</U>;navigateTo(…);//'`), the element ends there and the call
  in the string is read as code and rewritten. Where nothing closes the element, the rest of the page is its text, which is read as code where it has a container: a typed API interface (`interface Api { list<T>(): Promise<T[]>; delete<T>(url: string): Promise<T>; }`)
  followed by a handler builds as it should, since the handler's container is code in the swallowed text, and a `{…navigateTo({ pageType: "generative", pageId: "PAGEREF_x" })…}` in a later comment or template literal is
  rewritten, though it is data — so this is not a failure that is always loud. No page in the committed corpus has these shapes, and telling a type's members from an expression is what the lexer has no parser to do. (The same words in a
  *nested* tag, `m(p = x <a in b> '</a>' + '</T>…')` or `m: Array<keyof X>`, are read both ways: `tagMayBeCode`.)
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

- **Posture:** the committed `ikey.json` ships **live** (`disabled: false`) with this
  plugin's own per-region keys (`internal`, `us`, `eu`, `gov`, `high`, `dod`, `mooncake`;
  US and EU share the public key and differ only by collector) and the Power Apps client
  `event` stream. `disabled: true` is the repo-wide hard-off (no POST,
  no local log). **Provision a fresh key; never copy another plugin's `ikey.json`**
  (CI-enforced: `node scripts/validate-telemetry-ikeys.js`).
  The sole exception is pcf, which ships a verbatim copy of this `ikey.json` (the same tenant); a key rotation must update both, as the copy check enforces.
- **Wire shape:** these tenants ingest **only** the `event` stream, into the Power Apps client
  `event` table; any other stream name is accepted by the collector and then dropped. So
  `resolver.js` also exports `formatEnvelope`, which mirrors mobile-apps' envelope:
  `app_Name: "powerappsclient"`, `event_Name`, `session_Id`, `tenantId`, and every other
  allowlisted field as a `customDimensions` JSON string. `clientType` is
  **`ModelAppsAIPlugin`** (never mobile's `PowerAppsNative`), so rows are separable from
  real client traffic. Query the tenant's `event` table (raw 1DS copies prefix columns with `data_`):
  `event | where clientType == "ModelAppsAIPlugin" | extend d = parse_json(customDimensions)
  | summarize count() by tostring(d.pluginName), tostring(d.skillName)`.
  The local mirror keeps the flat, readable shape.
- **Routing:** `scripts/lib/telemetry/resolver.js` picks the key + collector per event.
  `region/` beside it is a **verbatim copy** of power-pages' Artemis geo + cloud-stamp
  router — refresh it by copying, and keep model-apps logic in `resolver.js`
  (`telemetry-lib-copy.test.js` fails on drift, and the workflow runs on a power-pages
  `region/` change). A public-cloud
  org routes to `us`/`eu` by its geo (cached per org for 24 h under
  `~/.power-platform-skills/region-cache/`, shared with power-pages — it stores only the
  region, never a key); if its geo can't be determined (Artemis down, unknown geo) it sends
  nothing rather than defaulting to US, and only a signed-out PAC (no org) takes the `us`
  default. Unlike power-pages, a sovereign or internal PAC cloud (`UsGov`,
  `UsGovHigh`, `UsGovDod`, `China`, `Tip1`/`Tip2`/`Test`/`Preprod`) routes from the stamp
  alone, with no Artemis call and **never** a fallback to the public collector; an
  unrecognized cloud, or a signed-in org with no cloud line, sends nothing. `ikey.json`
  deliberately has no top-level static key, so a `null` resolution really does mean no
  transmission.
- **Emission:** `hooks/run-skill-pretool-telemetry.js` (PreToolUse Skill) and
  `hooks/run-user-prompt-telemetry.js` (UserPromptSubmit `/model-apps:<skill>`).
- **Privacy:** telemetry is default-on: events can include Dataverse organization and Entra tenant GUIDs
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

**Testing a CLI in a real process:** what only a process shows — its exit status, the one line on stdout and
that line's bytes — is tested by spawning the script. `scripts/tests/helpers/fake-org-languages-preload.js`
(`node --require …`) swaps the az-token client for a fake Dataverse that answers the three language reads, so
`list-languages.test.js` runs the real script, bundle and `emitResult` with no Azure CLI and no network; with
the PATH emptied, the same test shows what a machine with no `az` gets.

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

**pcf copy sync.** The pcf plugin copies selected model-apps helpers and the vendored SDK bundle
because plugin installs are isolated. `scripts/validate-plugin-copies.js` is the source of truth for
that list and enforces it in both suites plus the every-PR metadata workflow. If you change one of
those sources, copy the corresponding file into `plugins/pcf` in the same PR; re-vendor in model-apps
first, then copy the resulting SDK bundle.

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

`scripts/tests/form-timeline-real-bundle.test.js` (with `form-timeline.test.js` for the pure helpers) — the
**Notes timeline shape** against the real bundle: the exact FormXML a new host serializes to (control id
`notescontrol`, a 23-row `auto="false"` cell, 22 empty rows, no duplicate control id), the engine's own
create path, the in-place repair of an old-shape host on an explicit and an auto layout (same section,
position and cell identity; ONE atomic write; a second rebuild mutates nothing), hosts of the heights and
widths platform forms use (a 5-, 20- or 23-row cell, with or without `auto`, a widened timeline) that a
rebuild leaves alone and verify accepts, a host that only lacks rows being topped up to its own height, the
refusals (a maker's own timeline, a taken `notescontrol`, a host with a field added), the **order** of the
repair (a field the layout dropped, or one a `fieldOptions` anchor moves, leaves the old host first so the
SAME build repairs it), and what `--verify` reports — with the advice that follows from the reason — before
the build as well as after it: for each way a field leaves the host or stays in it (including a chain of
anchors, one anchored to another that is itself moved out, up to three links), the advice has to be what a
real build then does (`verify before the build and the build itself agree about …`); for a field the form has
twice (sections the build orders differently from the published form, a pruned field removed one cell per
run, a chain of anchors that reaches one, a taken `notescontrol` beside one) verify says it cannot tell, and
what the build then does is pinned both ways. `form-timeline.test.js` pins each rule of
verify's `notesHostInspector` on its own, one inspector asked about every cell as `--verify` does. It shares
`tests/helpers/form-store-harness.js` — the SDK over a stub HTTP client that stores one systemform row.

`scripts/tests/form-subgrid-placement-real-bundle.test.js` (with `form-subgrid-placement.test.js` for the pure
rules, the spec gate and lint parity, verify over hand-built FormXML, the wireframe and the plan) — **sub-grid
placement** against the real bundle: where a new grid lands (between sections, before/after an anchor, in a tab
or form-column, on an auto layout), a rebuild moving the grid an older build appended into place (one move OF
THE GRID, the same section id, a second rebuild writes nothing), **the form the released builds deployed**
(`notes: true` + a grid behind the Notes section, the old timeline: every placement ends in the order a new
form gets, the timeline repaired in place, nothing but the grid moving), a section between a grid and its
anchor left behind the grid, the refusals (a grid in a maker's section — reported only when it is NOT already
in place — an anchor the deployed form lacks),
the sweep of an emptied same-named section still resolving after a grid shifted the indices, **fields the
build adds** landing in their own section whichever way a grid shifts the sections around it (an auto
form, a section the spec adds, a grid added in front, leaving the column, moving down past it or up from
behind it — each of which wrote the field into the grid's section or halted the forms phase when the field
was queued by index — and a section that is gone altogether), and a recorded
**regression guard** — a spec without placement keys writes exactly what it always did.

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
The same file pins the **throwaway-workspace lifecycle**: a CLI that makes a temporary workspace must
build its SDK behind a `try` whose own `catch` or `finally` removes it (`cleanup()`, `dispose()` or
`rmSync`), or a failed construction strands the directory. The guard is read from the syntax tree — the
first `try` after the `mkdtempSync`, in the same function — so a cleanup elsewhere in the file neither
satisfies the check nor breaks it by changing shape.

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

**Newer SDK behaviors the plugin adopts, and the options it leaves off.** Each is pinned against the
real bundle, because a stub stays green through a change in the SDK's own rule.

- **A workspace belongs to its environment** (`scripts/tests/workspace-binding.test.js`). The SDK
  records the environment a workspace was first opened for in `manifest.json` and refuses an SDK for
  another one (`WORKSPACE_ORG_MISMATCH`) before it reads or writes anything. Only `build-model-app.js
  --apply` opens the app folder's workspace — a dry run, download, `ai-preflight`, the `provision-*`
  scripts, teardown and the standalone verify use throwaway ones (verify reads only the build's
  `last-applied.json` from the folder, so it verifies any environment the app is deployed to and never
  binds a fresh folder). A **dry run** works in a temporary workspace inside the SDK's own temp dir and
  creates nothing in the app folder: opening binds, a preview builds nothing, and a folder it bound to the
  environment it only previewed would refuse the environment the operator meant (a preview against the wrong
  environment followed by `--apply` against the right one would be told the folder's saved copies belong to
  the wrong environment, though nothing was built there). Every read its live plan makes goes to the server, so it
  needs nothing from the folder; the folder is only ASKED, read-only, which environment it belongs to
  (`getManifest`: it parses `manifest.json` and no saved copy, and writes nothing), and the answer is a `⚠` note on stderr
  (`workspaceBindingNote`) that an `--apply` would stop — the preview itself, its plan and its "No spec
  changes since the last apply" advisory (read from the baseline file) are unchanged. The question is not
  a listing of the app artifacts, which would check the environment just as well: listing also parses every
  artifact's saved copy and its metadata (to flag unpushed edits), so a corrupt copy in a folder that belongs to
  THIS environment would throw the very error a corrupt manifest does and be reported as one. A saved copy says
  nothing about which environment a folder belongs to, so the preview reads none and says nothing about one (an
  `--apply` opens such a folder; the SDK meets the copy when it first reads it). A link or a file where
  the folder should be is still refused; a folder that is not there is just one with no workspace. So
  `--apply` is the one entry point that turns the refusal into a halt (`lib/workspace-binding.js`) that
  names both environments as normalized origins, never the manifest's own text, and offers the safe ways
  forward: build against the environment the workspace belongs to, use a fresh app folder or `--workspace`,
  or — only when that environment's copy of the app is no longer wanted — tear it down there with
  `--clear-workspace`. The folder is printed on a line of its own and the teardown command takes it as
  `--workspace <the folder printed above>`, never embedding it: teardown otherwise clears the folder beside
  its spec, and no quoting of a path is right for every shell (inside double quotes PowerShell and POSIX
  shells still expand `$name`, so a folder named `$work` would point the delete elsewhere; single quotes are
  not quotes in cmd.exe), so the halt says to pass it quoted for the operator's shell. Teardown already keeps
  the folder while a page-ownership receipt remains. A folder that holds **nothing a build saved** (the SDK's
  manifest listing no artifact, and its empty folders, and nothing else — `holdsNothing`, which is
  conservative: any other file, a link or an unreadable entry counts as saved work) was only ever opened —
  by a preview of an earlier release, or a build that stopped at its start — so nothing was built in that
  environment: the halt says so and offers neither `--env <that environment>` nor the teardown, only
  deleting or moving the folder aside, or a fresh one. A manifest the JSON parser rejects would otherwise
  surface the parser's own "Unterminated string in JSON at position N" (no path, no advice); it is
  recognized by the error's name (enough, because opening a workspace and asking it for its manifest parse
  `manifest.json` and no other file, so a corrupt saved copy is never mistaken for it), never echoed (newer
  Node versions quote the file), and halts with
  `WORKSPACE_MANIFEST_INVALID` as the folder with no usable environment does: move it aside — rename it, do
  not delete it, it can hold page-ownership receipts and the baseline a new workspace does not get back.
  The plugin never clears or re-binds a workspace for the operator — the SDK's own remedy,
  `cleanWorkspace()`, discards its saved copies, metadata and baselines, a copy can hold an edit that was
  never pushed, and the receipts and baseline beside them are the other environment's — and no script
  calls it. Not even an empty folder is cleared automatically: the check and the act cannot be made atomic
  against a build that starts in that folder in between.
  The SDK compares the recorded URL as text (trimmed, lower-cased, trailing slashes dropped), and `--env`
  takes an https origin and nothing more, so the one spelling of the SAME environment a run of this
  plugin can meet is the `.api.` host (`<org>.api.crm.dynamics.com` against `<org>.crm.dynamics.com`).
  The plugin does not fold the two — the baseline, the receipts, the token and the HTTP client's origin
  guard all key on the host it was given — so the halt says it is the same environment (never "another"),
  gives the host to re-run with, and offers no teardown, whose target would be the run's own
  environment. A manifest another tool wrote with a path or port has no `--env` that matches it, and
  gets a fresh folder only. Handing the SDK one canonical origin would prevent neither: it already
  ignores case and trailing slashes, and the plugin does not treat the two hosts as one.
- **`createRecovery: 'adoptExact'` on the SDK that creates forms** (`provisionSdk` in
  `build-model-app.js`; `scripts/tests/form-create-recovery-real-bundle.test.js`). The HTTP client
  re-sends a create whose answer never arrived, and the platform answers the re-send 412 because the SDK
  mints the `formid`. The SDK then reads that row and adopts it only when it is exactly what was sent (a
  Main form with the same XML, name, table and type). The push comes back `{ saved: false,
  adoptedExisting: true }` having written nothing, so `pushFailed` (`lib/entity-provision.js`) does not
  count it as a failure and `reportPartialPush` says it happened. An inexact row, a Quick Create form,
  or an environment that answers a replayed create with 404 halts as before, now with the SDK's reason.
  The header-carrying `sdk` does not get the option: it does no workspace I/O, so it never creates forms.
- **An AI override saved but not yet published is `pendingPublish`** — see the AI features note above.
- **A form or dashboard is read and written only as its own kind**
  (`scripts/tests/form-kind-real-bundle.test.js`, `form-order-real-bundle.test.js`,
  `sdk-resend-layers.test.js`). A fetch and a push decode the row's `type` from a read they already make — a
  fetch's `RetrieveUnpublished()` selects it, a push's content-token read selects `formid,type` — so the check
  costs no request; only a delete adds one, a `RetrieveUnpublished()?$select=type` before it, because it reads
  nothing else first (forms are types 2, 6, 7 and 11, dashboards 0 and 10). The SDK refuses
  another kind — or a row whose type it cannot read — with `SYSTEMFORM_KIND_MISMATCH`, naming the kind it
  found; a push that would change an existing form's type is refused `FORM_TYPE_IMMUTABLE` (the plugin never
  changes one). A fetch refused this way stores nothing, a push of a copy whose row has since become another
  kind writes nothing, and teardown reports a refused delete as the step's failure in the SDK's own words,
  never as "already gone". Download's dashboard read reports a sitemap dashboard subarea whose id is a form as
  unreadable and leaves it out, so the usual gate stops the run. The plugin's own pin checks
  (`resolveExistingFormId`, `findPinnedDashboard` — a type-0 dashboard only) refuse a wrong pin first, so this
  is the second line. A fake Dataverse that stores a systemform must answer its `type` (a Main form is 2),
  honour `$select` and leave a null column out, as the platform does; otherwise every form read in a
  real-bundle test is refused.
- **An app header write is never unconditional** (`scripts/tests/app-ai-description-real-bundle.test.js`). The
  SDK writes the app's name, description and routing description conditioned on the appmodule ROW token a
  fetch read, even when its own read of the header fails (the header PATCH carries `name`, `description` and,
  when one is supplied, `aiappdescription`; the icon is written at create only). A header edit made while it
  holds no token throws `APP_UPDATE_NO_ETAG` before anything is written (it used to send the PATCH plain,
  which overwrote another writer's header). The plugin edits an existing app's header only on a copy it has
  just fetched, and only the routing description — every other header field is written at create — so the
  build does not meet the refusal; a sitemap-only push needs no header token at all. If a push ever did meet
  it, `pushAppHeader` resets the copy and the next run, whose fetch reads a token, saves the edit.
- **Metadata reads ask for the latest definition** (`scripts/tests/sdk-uptake-contract.test.js`). The SDK
  sends `Consistency: Strong` on every read of `/EntityDefinitions`, `/RelationshipDefinitions` and
  `/GlobalOptionSetDefinitions` — about 10% more per read — and on no other path, so a read right after a
  metadata write is not served the definition from before it, and a schema write drops the cached
  definitions of the tables it changes. The plugin's HTTP client passes a caller's headers through, so the
  header reaches the wire. The plugin still carries three waits for the metadata-read lag (`lib/entity-provision.js`),
  and keeps them, because it is not measured whether `Consistency: Strong` leaves any lag: `readTextColumnLength`
  asks a 404 on the attribute of a table created a moment ago again, twice; `confirmInlineColumns` re-reads the
  attribute collection of a new table, up to three reads in all; and the relationship create, told that its
  name is already used while no read shows the row, reads twice more (about 2 s, then 4 s) before it calls the
  name unidentified. They are candidates for removal once a live run shows no lag. The `MetadataCache` 400 that
  a form, view or chart lookup on a table that does not exist yet answers (`resolveExistingFormId`, the plan's
  artifact probes) is the platform's answer to a read of a DATA table, which the header does not cover, so
  that handling stays. See the localized-label note above for the one effect that is not measured.
- **The environment's languages come from the SDK, with `pac` behind it** (`scripts/list-languages.js`,
  `lib/lcid-cultures.js`; `scripts/tests/list-languages*.test.js`, `lcid-cultures.test.js`).
  `getEnvironmentLanguages()` makes three reads — the organization's base language,
  `RetrieveProvisionedLanguages()`, `RetrieveAvailableLanguages()` — and touches no workspace; it is strict, so
  a response of an unexpected shape throws `ENVIRONMENT_LANGUAGES_UNREADABLE` and a failed read throws its own
  error. The planner runs the script first: it prints one pure-ASCII JSON line with the base language and, for
  each provisioned language, its LCID, culture code and whether it is right-to-left. The SDK returns numbers
  only, so the host maps them with a table of Windows' own culture data; an LCID the table does not name stays
  numeric (the base language's too), is reported in `unmapped` and on stderr, and is never given a guessed
  code or direction. The script writes nothing and emits no telemetry of its own.
  **The script is the preferred source, not the only one.** It reads through the `az` token, and `/genpage` has
  never needed `az` for a page over existing entities or mock data (README). So when it exits non-zero — for
  any reason; most often the Azure CLI is missing, signed out, slow or signed in to another tenant — the
  planner runs `pac model list-languages --environment '<envUrl>'`, as before the script existed but pinned to the
  environment the script was given (without the flag `pac` answers for the active organization of its auth
  profile, which is not necessarily the environment the plan is for), records both in the log and says so,
  and stops only when `pac` fails too. The rule is the exit status, on purpose: the SDK reports a missing
  Azure CLI, a slow one, a token another tenant refuses and a dropped connection alike, as `CONNECTION_ERROR`
  (`statusCode` 0, or the HTTP status of a refusal), so no code tells them apart, and a rule keyed on the
  wording of the sign-in advice (`Run 'az login' first`) is met by a signed-out Azure CLI only. The planner's section
  and README's promise are pinned (`list-languages.test.js`), and so is the eval grader's reading of a run
  that fell back (`phase-expectations.test.js`). The plugin's own `readProvisionedLanguages` /
  `readOrgLanguageCode` (`lib/dataverse-auth.js`) stay: they run before an SDK exists (it needs the language
  at construction) and fail soft, where the SDK's read is strict.
- **Two layers re-send, and for a delete they add** (`scripts/tests/sdk-resend-layers.test.js` pins every
  count). The HTTP client re-sends a 429 or 5xx — except a record delete and a `$batch`, which it
  re-sends only for a deadlock (SQL 1205) or a 429. The SDK re-sends a deadlock for reads, an app
  create, `PublishXml`, a form create, a view create, a publisher create and each delete of a row-summary
  removal (there a 400 quoting SQL's "chosen as the deadlock victim" counts too), and re-sends an app delete
  that hits the platform's search-index insert race (HTTP 400, SQL 547). An app delete's two triggers are
  different answers, so a race, then a deadlock, then success is three change sets, and a persistent one of
  either is four — never four times four. A POST's deadlock is a 500 the client has already re-sent by
  the time the SDK sees it, so one deadlock costs one re-send in all; only a deadlock that never
  clears multiplies, bounded by the client's six attempts times the SDK's four (24 requests, measured
  on a form create and on a view create). A row-summary delete is re-sent by both layers for a 500/1205
  (one that clears costs one re-send; one that never clears at most 16, the client's four times the SDK's
  four), and by the SDK alone for the 400 form.
- **A row-summary removal settles each delete** (`sdk-resend-layers.test.js`). The skill row is deleted first
  and alone, then the AI model — only when it is the one `configureRowSummary` made (named
  `<table> row summary`, built from the row-summary template). A delete is re-sent while it loses a deadlock
  and, when its answer is lost or odd, settled by reading the row back. A model another component still
  uses is refused by the platform (HTTP 400, `0x8004f01f`) and KEPT, which is success — a removal that threw
  there would fail the teardown step of every table whose model another component had adopted. What the SDK
  cannot settle throws `ROW_SUMMARY_REMOVAL_UNCONFIRMED` (the skill-row delete's outcome unknown, naming our
  model) or `ROW_SUMMARY_MODEL_NOT_DELETED` (the model left behind, naming it). Teardown's `aiSummary` step
  still treats every failure as best-effort and does not surface these: the table delete that follows reports the
  dependency if the skill row is still there, and a model left behind blocks only a later row summary for the
  same table, by name.
- **Changes in the same SDK release that no plugin path reaches** — read these again before a plugin change
  reaches one. `importSolution` now requires `overwriteUnmanagedCustomizations` and `publishWorkflows` (no
  script calls it, and `sdk-surface-contract.test.js` fails on a new call until it is listed). An Active
  business process flow is edited in one conditional change set and stays Active — it needs a client with
  `postRaw`, which the plugin's has — where the build only creates a flow and toggles the state of one that
  exists, never editing a definition.
- **Changes in the same release that the plugin's paths DO reach, with the outcome unchanged** — re-test them
  when one of these paths changes.
  - *Commands.* A command push writes only its own table's bar, with every check before the first write. The
    build's commands phase is a command push (`createArtifact('command')`, then `pushArtifact`), so the
    anchoring, the table-id resolution and the write plan run on it; the requests are the same two as before
    — one table-id read, one write — and a bar that exists is skipped (`command-real-bundle.test.js`).
  - *The app-publish token bracket costs requests.* Every `publishArtifact('app')` — the app shell's rewrite of
    an existing app, the pages finalizer, the AI re-confirm step, and phase 8's envelope when it carries the
    app; a typical build makes two or three — now reads the app before the publish and again after it, to adopt
    the tokens the publish rotated when its content is unchanged and its whole token vector was proven, so
    that a header edit right after needs no fetch. That is about **10 more GETs per app publish** (probed over
    a fake app after a fetch: none on the previous bundle, ten on this one). The adoption is of no use to the
    plugin, which fetches before every header or sitemap write because a pages run changes the live app
    between its first fetch and its finalize, and no step of it was a workaround for a token a publish
    rotated. The bracket is best-effort: a failed or throttled read leaves the app un-rebaselined and never
    fails the publish.
  - *Component proofs.* An app create or update that pins tables reads the app's current layer at most once for
    its component proofs — the table proof and, when the spec lists the Main forms of a table, the Main-form
    proof — where each proof read it for itself (one read fewer when both run; the same requests when only the
    table proof does). An ambiguous layer fails closed (`APP_COMPONENTS_UNVERIFIED`): a create unwinds, an
    update reports a warning. The plugin's own component reader (`lib/app-components.js`) is separate.
  - *Unchanged pushes.* A push of an unchanged artifact skips its artifact write and reads less from the
    workspace. The plugin's own push-if-changed decision (`hasUnsyncedEdits`, which asks the SDK's
    `diffArtifact`: the copy against its snapshot) is made before the push and is unaffected
    (`rebuild-writes-real-bundle.test.js`).
- **Left off: `readConcurrency`**, which overlaps a generative page's file downloads and
  `fetchSolution`'s component reads. The plugin makes neither read — pages go through
  `pac model genpage`, and no script fetches a solution — so the option would change nothing.
  `scripts/tests/sdk-opt-ins.test.js` fails if a script starts to make one of those reads without
  passing it.
- **Left off: creating the app as a draft (`published: false`), so the final publish covers it.** A
  draft is not in the published projection: a by-id read answers 404 and `findArtifact('app')` finds
  nothing, and so does every other probe the build, verify and download make — the collision gate, the
  sitemap and navigation reads of the pages phase, the app-shell "does it exist" check. A failed first
  build would leave an app its own re-run cannot see, the pages phase right after the create would find
  no sitemap, and a build without `--publish` would never publish it. The app is created published;
  `scripts/tests/sdk-opt-ins.test.js` pins the SDK facts this rests on and that no script passes
  `published: false`.


`scripts/tests/rebuild-writes-real-bundle.test.js` — the **unchanged-rebuild write budget**, against the
real bundle and a stateful fake Dataverse (`tests/helpers/fake-dataverse.js`), so what is asserted is
what reaches the wire, not which SDK methods a mock saw. Every test name starts `rebuild writes:`. A
first build followed by a rebuild of the same spec with `--publish` must send only the phase-8
envelope; every change a reconcile makes (a view column or description, a form field, a form event
handler) must still be pushed exactly once and end up published; an edit an interrupted run left in the
workspace must still be pushed; an edit a maker made in Dataverse since the last build (a column
removed from a view, a description changed, a field removed from a form) must be pushed back — the
workspace copy is clean but the server has moved — and one made while the workspace also holds an
interrupted run's edit must halt (`LOCAL_EDITS_WOULD_BE_LOST`) without writing; without `--publish`
each reconcile must still publish its artifact; a build that halts after a reconcile must hand its
caller the publish it owes; a phase-8 publish that fails or cannot be confirmed must name the views and
forms it carried — the enriched default views of a table included — on the publish phase and on the halt
path alike, and on the publish phase also the views, forms and charts the run created (a first
build's, a rebuild's additions, a chart whose description it wrote), each once and never as a bare id,
with the requests it sends unchanged, while a first build that halts owes nothing for what it merely
created; a build killed between its reconcile and its publish must leave a re-run able to publish
the edit without writing it again; and the membership read must happen once, follow paging, and fall
back to adding everything when it fails. A table the solution holds with ALL its subcomponents must
vouch for its views, forms and charts (which have no rows of their own, so the rebuild adds none of
them), and nothing else: a table held at 1 or 2, another table's components, a failed table lookup and
a table the maker has since re-segmented must all still get their adds. The fake models only views,
charts, forms, solution components and `PublishXml` — it throws, naming the request, on anything else
— and it answers the way the platform does: table rows carry the `rootcomponentbehavior` and the
table's MetadataId, the subcomponents of a whole table get no row, and `$select` is honoured.
`unpublished()` answers "was every saved change published?".
`rebuild-writes-reuse-sites.test.js` and the `rebuild writes:` tests in `sdk-build.test.js` pin each
reuse site (rule, flow, role, app, sitemap, page manifest) the same way; `solution-membership.test.js`
and `unsynced-edits.test.js` pin the two helpers' contracts, every doubt of which reads as "add" and
"push".

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
(`node scripts/run-tests.js`); `resolver.test.js` pins the shipped `ikey.json` (live, a real key and the
right collector per region) and the sovereign/unknown-cloud routing. A test also forbids shipping a
placeholder key enabled. Run `node scripts/validate-telemetry-ikeys.js` from the repo root after
touching `ikey.json`.

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

### Skill routing — agent in the loop

`evals/model-apps/routing/` grades which skill a real agent CLI (Copilot CLI or
Claude Code, headless, isolated, only this plugin loaded) invokes for each of 20
prompts: `/genpage` vs `/app-builder` from both sides of their boundary, plus
negatives that share vocabulary (Power Pages, canvas, Power Automate, a generic
React dashboard). The offline harnesses above grade what a run *produced* and
cannot see a mis-route; both skill descriptions point at each other, so a
wording change to one can start stealing the other's prompts. The agent is
killed at its first plugin-skill call, so a trial costs about one model turn;
cases are graded as a pass rate over N trials. **Run it when you edit a skill
`description:`.** It is not a per-PR gate (cost, non-determinism):
`model-apps-agent-evals.yml` runs it on a same-repo PR labelled
`run-agent-evals`, weekly, and on demand, using Copilot CLI authenticated by the
workflow's own `GITHUB_TOKEN` (`copilot-requests: write`) — no secret to
provision. Its parsing/grading/process code is unit-tested on every PR against a
fake agent. See [`evals/model-apps/routing/EVAL_GUIDE.md`](../../evals/model-apps/routing/EVAL_GUIDE.md).

```bash
node evals/model-apps/routing/run-routing.js --dry-run                 # what would launch
node evals/model-apps/routing/run-routing.js --tier smoke --runs 1     # quick local check
node evals/model-apps/routing/run-routing.js --out after.json --compare before.json
```
