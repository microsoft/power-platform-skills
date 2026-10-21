# AGENTS.md — Model Apps Plugin

This file provides guidance to AI Agents when working with the **model-apps** plugin.

## What This Plugin Is

A plugin for building Power Apps for **model-driven apps**. Two **authoring** skills do the work
(plus `/report-issue` and `/telemetry` — four user-invocable skills in total):

- **`/genpage`** — build and deploy standalone **generative pages** (genux): React 17 + TypeScript +
  Fluent UI V9 single-file components, written to the environment through the bundled SDK. Orchestrates specialist agents (planner,
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
- **PAC CLI > 2.10.0** — for sign-in and environment discovery (`pac auth`, `pac org who`, and `pac help` for the version
  check), for the fallbacks of `list-connections.js`, `connector.js` and `solution-settings.js` (run only when the SDK
  refuses their route), for their two `pac`-only paths (`connector.js schema --dataset --table`, and
  `solution-settings.js template --package` with no `--env`), and for `pac model genpage list-connector-tables`, which lists a
  connector's tables and has no script. Generative pages themselves — written, read, listed, downloaded, put in an app,
  taken out of one and deleted — and their type generator are the SDK's, with the `az` token, not `pac`'s
  (`scripts/genpage-upload.js`, `scripts/genpage.js`).
- **Azure CLI (`az`)** — Dataverse Web API auth (SDK + entity builder) and, for connections and connector
  metadata, the Power Apps service token (`https://service.powerapps.com/`); must be logged in with the
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
`scripts/tests/review-references-hygiene.test.js` enforces the review-provenance part for this plugin
and `evals/model-apps`: it fails on finding ids (in a comment, a message, or at the start of a test
title), numbered findings (a heading that gives a finding a number, and the test titles that carry it),
a count of the findings of a review, hyphenated finding and override labels, numbered severities, and
reviewer, round and plan pointers. Name what a group of tests pins, not its number in a review. The
plain words a pointer is made of ("Task 1", "Addendum") are data when they are a fixture value (an app
name that holds them in parentheses is still a name), an assertion's expected value or inside a code
fence, and are flagged only in a pointer's shape in prose or in a message. A message is found by its
position: the argument after what an assertion compares, so the second argument of a two-argument
`assert.equal` is data and the third a message; the error of `assert.throws` and its kin is optional, so
a string in its place is the message and a matcher is not. A comment and a test title are found from the
code's own tokens, in JavaScript, TypeScript and JSON: a `//` inside a string, a template or a JSON value,
and a template line that reads like a comment or a test call, are data. Its header lists the patterns and
what is kept on purpose (generic provenance such as "found in review", and pointers a reader can follow
such as "design §13.1").

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
alias table lists them, so `todo` must be declared alongside. Recognizing a name is not delivering the
tool, though: a Copilot CLI session gave `genpage-page-builder` no task tool at all, so an agent's
task-tracking step says what to do without one (`references/agent-interaction-contract.md`, pinned by
`scripts/tests/agent-task-tracking.test.js`). Both skills also support **unattended
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
  collision Dataverse rejects), warnings teach. The access advice is worded for what a spec can
  know (`lib/app-access.js`): no `personas[]` says the spec authors no security role and who can
  open the app only as a condition — a spec for a new app and an extension of an app that already
  has roles look alike, and the app's own roles are the ones associated with it, which a spec with
  no personas leaves as they are — except that the marks a download writes (`app.uniqueName`, a
  page or dashboard id) make it say the spec most likely edits an existing app. A new table (an `entities[]`
  entry not marked `existing`) that no persona privilege and no `roleGrants[]` entry covers gets
  one "no access declared" warning, the check an extension that leaves `personas[]` out on purpose
  still needs.
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
  deferred) so `genpage.js types` can emit `RuntimeTypes.ts`; (2) a full `--apply` build (re-discovers
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
  including auto forms, and the tab and section **labels** a layout authors, each in the language the build wrote
  it: a string label in the build's authoring language — the language the build was handed (its `--language-code`,
  which `verify-model-app.js` takes too, and, for the build's own `--verify`, what its SDK was made for), else the
  spec's `languageCode`, else the organization's base language (read once) — and a label map at every LCID it
  declares; a translation the spec leaves out is never required or changed. A caption the published form holds only
  in ANOTHER language does not stand in for the declared one: a missing caption is a mismatch, not a pass, and so is
  a caption missing in a language the form's read carries (a language the read carries no label in at all is
  read from a translation export, below); a label the spec does not write is not compared. **A string label is never held to a guessed
  language.** A build run with `--language-code` in an organization whose base language is another one publishes its
  captions in the flag's language, so verify it with the same flag (or pin `languageCode` in the spec): told nothing,
  verify holds them to the organization's language, and either the failure says so or, when the read carries no
  label in that language, the export is asked for them (below). When no language can be established at all —
  the organization cannot be read — the string labels are listed under `unverified` (the output, and the result
  JSON beside `missing`), neither passed nor failed, with the reason and the flag that settles it: the build's
  fallback to 1033 is a choice for a build, and for verify it would be a guess that passes a stale caption as
  readily as it fails a correct one (`resolveLanguageCode`'s `undetermined` hook replaces it). Everything else is
  still checked, label maps included. **A language the form's read does not carry is never reported missing — a
  translation export reads it.** The platform
  decides which languages' labels go into the FormXML a caller reads, and it can return fewer than the form stores —
  measured: a form built and published with Spanish (3082) captions in an organization whose base language is English
  (1033) keeps both languages, yet its published FormXML, with or without an
  `Accept-Language` for the other language, carries every label in 1033 alone (nor does `RetrieveLocLabels` apply to a form's
  `formxml`: HTTP 400). When no label of the form's FormXML — on any
  element, a field's included — is in the language a label is compared in, the labels compared in that language are looked up in
  ONE translation export of the app's solution (`lib/translation-labels.js`; `POST …/solutions/Microsoft.Dynamics.CRM.ExportTranslation`
  with `{ "SolutionName": "<uniquename>" }` — bound to the `solutions` collection, the unbound action answers 404 — whose answer is a
  base64 zip holding `CrmTranslations.xml`, an Excel 2003 XML spreadsheet; its `Localized Labels` sheet has one row per caption,
  `Entity name | Object ID | Object Column Name | <one column per provisioned language, headed by its LCID>`, a tab's or section's row being
  the one whose Object ID is the `id` the element has in the FormXML and whose column is `displayname`, an empty cell meaning no caption in that
  language). They are matched by the table and the `id` of the tab or section the form's read matched (`parseFormTopology` keeps it), in the
  language the spec declares: the text it holds is the declared one → the caption passes; another text, or an empty cell, is a
  `form-topology` mismatch (`… is deployed with label "Antiguo" in language 3082 (the translation export of solution 'S' shows it; the form
  read does not carry language 3082), the spec declares label: "Resumen" in language 3082`); a label map is compared the same way, language
  by language, and the languages the read carries stay compared from the read (`verifySpec`'s `carriedLanguages`). **What the export cannot
  settle stays unverified, as it was before verify read exports, and never passes:** it fails or is not readable with certainty (an
  HTTP error, an answer that holds no archive, an archive or a workbook that is damaged or is not the platform's — `lib/zip-read.js` reads
  the archive and `lib/strict-xml.js` the workbook, both strict and dependency-free, and a row or cell they do not recognise makes the
  WHOLE export unreadable, never a skipped row: every element and attribute of the `Localized Labels` sheet must be one the platform writes,
  where it writes it — a prefixed or unknown element, a namespace declaration, a Number-typed caption, a workbook nested deeper than the
  platform's or an archive whose entries do not lie end to end is refused, and refused while it is read, before it can cost the process its
  memory), the FormXML gives the element no GUID id, the export has no row for it (the
  solution's tables are exported, not only its forms, but a form of another table is no proof of this one) or more than one, or no column
  for the language (it is not provisioned): the entry then says why — `A translation export of solution 'S' could not be read (…)` or
  `… was read, but it cannot settle them: …` — before what to check in Power Apps; `ok` and the exit status are unchanged. **What it
  costs:** one `ExportTranslation` request, made only when some caption needs it (a build and verify in the language the read carries, or a spec with no labels, make
  none), once per verify pass whatever the number of forms (the pass shares one promise), and sent ONCE — never again on a throttled,
  unavailable or timed-out answer (`isTranslationExport` is the `sendOnce` rule of the verify and build HTTP clients), because it is a long
  action and a re-send would start a second export beside the first. Measured live: 7.5–11.2 s and a 5 KB zip (44 KB of XML) for a solution
  of one table, more as the solution grows — it exports every label of every form of its tables — and it reads the PUBLISHED layer (a caption
  saved and not published is not in it, which is what verify checks); Microsoft Learn documents the export for an unmanaged solution, which is what the build makes. A workbook of more than 32 MiB (about
  75,000 rows; reading it costs ~15 bytes of memory per byte of XML) is not read. A language the read does carry is compared exactly as
  above, from the read — a stale caption in it still fails — and a form whose read carries no label at all names no language, so its missing
  caption is a mismatch as ever, with no export. Field order and anchor adjacency are not verified. A field's `readOnly`/`hidden` flag goes on
  **every** cell the form holds of the field — in a section, in a maker's tab or section, in the form
  **header and footer**, and in a tab's own header and footer (`tabheader`/`tabfooter`): on a form a maker placed a
  field on twice, the first cell alone left the second editable or visible. `applyFieldControlOptions` visits each
  one; the SDK keeps those parts as raw XML (in the form's bag, or the tab's), so `findFieldOuterCells`
  (`lib/artifact-intent.js`) finds their cells there and the flag is written in place, every
  other attribute and child kept. Verify checks every cell too, saying where one is wrong ("in the form header",
  "in the footer of tab 'x'"). See the
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
  spec owns) and then writes Order 0..n-1 onto the spec's Main forms (a form the SDK creates has no
  `Order`, so a new form is always written, the first of a table included), the ones it does not
  list keeping their stored relative order. On a table it orders nothing on, a Main form it creates is
  created after the table's others: its order is written into the new form's own `<DisplayConditions>`
  before the first push (`createInPlace`), so no interrupted run or later failure can leave it with no
  order — a form with none takes no slot in the order Maker lists — and a later build could not tell it is
  new. Only declared forms are written, order-only through `setFormSecurityRoles` so roles
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
  A tile the spec does not size is built 1 column by 12 rows (`dashboardComponent`), because the app draws
  a one-row tile as its title bar alone; an authored `colspan`/`rowspan` wins, and a rebuild never resizes
  the tiles of a dashboard that exists. The cells are read back from the real bundle in
  `dashboard-roundtrip.test.js`.
  It also builds **business process flows** (`businessProcessFlows[]` — the staged process bar on a
  record): a `workflows` row of category 4 / type 1 / businessprocesstype 0 whose XAML the SDK compiles
  from ordered `stages[]`/`steps[]`, activated in the same push. The phase is additive
  discover-reconcile keyed on `(entity, name)` like `business-rules` — it creates what is missing,
  converges Active/Draft **state**, and applies a **stage or step edit in place** when that leaves every
  deployed stage where it is (below) — and `bpfFilter` scopes every query in
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
  **A rebuild applies the stage edits that cannot move a record, and refuses the rest**
  (`lib/bpf-stages.js`; `inspectBpfStages` / `applyBpfStages` in `sdk-build.js`; `bpf-stage-edits.test.js`).
  A flow that exists is read from the environment (`fetchArtifact('bpf', id, { overwrite: true })` — the plan
  is made on what is DEPLOYED, never on a workspace copy an interrupted run left holding unpushed edits) and
  its stages and steps are compared with the spec's **by name**, since the spec carries no ids. A record that
  runs the flow holds the stage it is on in `activestageid`, a lookup to the flow's `processstage` row
  ([the table](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/processstage),
  [the column](https://learn.microsoft.com/en-us/power-automate/best-practices-entity-attributes)). The
  platform does not document what becomes of a record whose stage is removed or moved, so a build never
  removes or moves one; it does apply a rename, because the SDK keeps the stage's id (that a record then stays
  where it was is measured against the vendored SDK so far, not yet against an environment). So:
  - *Applied, in ONE push*: a stage added (anywhere); a stage renamed (the deployed stage and the desired
    one that sit between the same two stages both lists have, when there are as many of each — the SDK
    keeps the stage's id, so the lookup a record holds still points at it); a step added, renamed, rebound
    to another column, made required or optional, or moved. An Active flow is written as one conditional
    `$batch` change set (the plugin's client has `postRaw`) and stays Active; a Draft flow as one PATCH. The
    Active/Draft state is converged AFTER the edit — a state change before it would move the row's version,
    and the SDK's push is conditioned on it (a 412).
    When the customization lock refuses an Active edit's whole change set, the SDK waits and re-sends the
    identical body for at most 180 seconds of scheduled waits. The guard keeps the original `If-Match`:
    another maker's intervening edit fails it with 412 rather than being overwritten. The HTTP client
    delivers each attempt once; an ambiguous 5xx envelope is not permission to replay it. These boundaries
    are pinned over the real bundle in `bpf-stage-edits.test.js`.
  - *Refused — no stage or step edit of the flow is applied, never half of them*: a stage or step the flow has
    and the spec does not list (a build never removes either, and cannot tell a spec that dropped one from
    a maker who added it in Maker); the same stages in another order; a different number of stages where one
    is replaced (a rename cannot be told from a removal); two stages or two steps that share a name; a stage
    on another table. The warning says why and the ways forward (list what the flow has, make the change in
    Maker, or delete and recreate the flow), and says: "No stage or step edits were applied; the requested
    Active/Draft state is handled independently." The state is not a stage edit — it is converged by a step of its
    own — so a flow the spec asks to be Draft is still deactivated, and the flow's stages and steps are as they were.
  - The SDK refuses a structural edit **per container**, not per flow (`NOT_IMPLEMENTED`, thrown before any
    request): a stage added, removed or reordered on a flow whose primary composite holds something that is not
    a stage (a branch, say), and a step added, removed or moved on a stage that also holds something that is not a
    step (a stage action). The edit is reported **NOT applied** with the SDK's reason, on the same terms as a
    plan refusal (no stage or step edits were applied; the requested Active/Draft state is handled
    independently) — as is a flow whose stages cannot be read. A stage action does not stop a stage being added
    to the flow; a rename, a rebind or a required/optional change works on either kind of flow and keeps what
    the SDK does not model (it states that the rest of the process round-trips losslessly; all of it is pinned
    against the real bundle in `bpf-stage-edits.test.js`). Any other push failure **halts** the build: a flow
    the SDK deactivated and could not reactivate is never skipped (`BPF_LEFT_DEACTIVATED`).
  The flow's own `description` and `order` are not reapplied, and `--verify` does not compare stages.
  `stageEditApplies` hands the change classifier the same plan, so an applied stage edit is not filed as
  `businessProcessFlow-edit-not-convergent` debt and a refused one still is.
  Following a **genpage-first policy**, overview/dashboard/analytics surfaces are authored as **generative
  pages** (`pages[]`) rather than classic dashboards — the build's `pages` phase uses a **three-authority
  model**: IDENTITY (durable `<app>_pagemanifest`, outranked by a downloaded spec's `pages[].pageId`),
  EXISTENCE (the environment's page list through the SDK, drafts included — crash-safe create-vs-reuse via `enumerateEnv`), and
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
  vendored SDK prefers a type-62 sitemap component on the app's **current** `appmoduleidunique` layer, but falls back to
  `sitemapnameunique eq '<the app's unique name>'` when that component is absent and no other live app pins the candidate. So such an app may
  hold a sitemap, and pages in it, that no component row links to it. `ensureSitemapInSolution` (sdk-build.js) still uses the naming convention
  of SDK-created apps for its best-effort, additive solution membership; it is not an ownership or deletion proof.
  The saved-layer read the scan makes anyway (it asks for `sitemapnameunique` too — no further request) shows whether it does: a sitemap of that name is joined
  like any draft app's (case-insensitively, as Dataverse compares names), several sitemaps of the name leave the app unreadable, and **none** means the app has no
  navigation at all and holds no page, so it is skipped — one draft app saved with only a name must not stop every page update in the environment (a read that
  *fails*, or a component that names no sitemap, proves nothing and is still unreadable; so is a *published* app with no sitemap
  component, which is not changed here). The scan reads the TEXT of each sitemap's XML, and finds a sitemap by a name on any of its rows: both can only widen what it
  refuses, so a page named in a comment is still reported as shared — nothing is deleted on what the scan finds (the teardown's proof reads the navigation entries). A single-app environment reads no other app's navigation: it pays the one small request for the list of
  never-published apps, and nothing more when there are none (one saved-layer read as well when a never-published app has no sitemap component, to rule out a sitemap linked by
  name). Classic `dashboards[]` are opt-in.
  **Generative pages are written through the SDK** (`lib/genpage-sdk.js` `makeGenpageSdk` — the one page backend that `genpage-upload.js`, `genpage.js`, the build's pages phase, verify, download and
  teardown all use; none of them runs a page verb of `pac model genpage` (`upload`, `download`, `list`, `add`, `generate-types`), so there is no process to start, no output to parse and no time limit of its own). A page is a set of rows (the project, its
  files, its conversation messages) that the SDK writes as **one atomic `$batch` change set**, so a write either landed whole or wrote nothing, and the SDK compiles the page itself (a page
  that does not compile is refused before anything is written). What a write that cannot say what it did leaves behind follows from that.
  A **create** mints the page's id on the client before anything is sent, so what it did can always be found out by reading that id. Only a failure that PROVES nothing was written is reported as `nothing` and
  not sent again: a typed refusal the SDK raises before it sends a write request (`PRE_WRITE_REFUSALS` in the module lists each, and where the SDK raises it — a page that does not compile, a write plan it cannot
  make, a workspace copy that cannot be pushed) or a 4xx the service answered (a change set is atomic, so a rejected one leaves nothing). Any other error at or after the send is *unknown*: a reset, a 5xx from an
  intermediary, an answer the SDK cannot account for — and an error that merely has a string `code`, since a full disk (`ENOSPC`) is raised by the SDK's own workspace write AFTER the service committed the change
  set. It is settled by reading the id: present — it landed (published, and said so in a warning); absent — nothing has landed *yet*, so it is sent **once more under the same id**: a first send that lands late
  collides on the id, so no second page can exist. A send that got no usable answer stays **open**: it can still reach the service after anything the operation has read or been told, so a later failure — a refused
  resend (a 429), a second unknown, a read that finds nothing — never turns the operation into "nothing was written"; it ends as *unknown*, with the id to look for, unless the read finds the page. Still absent after
  two sends, or unreadable, ends as *unknown*, with the id to look for. A create that **resumes** an earlier one — the build passes the id it recorded, and what was sent under it — starts with that earlier
  request **open**: it can still reach the service after anything this call reads or is told, so even a refusal before this call sent anything (a page that does not compile) is *unknown*, with the id.
  A page found under the id is recognised by what was sent under it — its name and its source (`holdsWhatWasSent`; the pending record keeps both for every create sent under the id) — never assumed. One that
  holds neither a name nor a source any of them sent was changed after it was made, or is somebody else's (`GENPAGE_CREATE_DIVERGED`): not adopted, not updated, not published. One that is ours may still
  hold what an *earlier* create under the id sent (another model, other data sources or bindings, an older name): it is brought to what this create asks for by the ordinary update, which publishes it after the
  write — never published as it is, and never acknowledged as if this create's content had been stored (a first prompt that differs is only warned about: an update records a prompt only when it changes the page).
  An **update** reads the page first and writes only what differs from it — the source, and the name, data sources, model or bindings
  the caller gave; one it left out is the page's own — records the new turn of its conversation (the page's first prompt is kept), then publishes and proves the published copy. Content the page
  already holds is not written and records no turn, but is published all the same unless the caller says it published exactly that content before (`publishedFingerprint`, the `fingerprint` — the hash of the
  content: source, name, data sources, model, bindings — an earlier result carried; the answer is `publish.kind: 'skipped'`): the server cannot say whether an earlier run's publish finished, so a page whose earlier
  publish failed converges, and a caller with no record publishes it, as it always did. The hash is only ever read together with the page: one that differs is written and published whatever the caller recorded.
  The **build** keeps that record in its workspace (`lib/page-publish-records.js`), written once a publish was *seen* to take effect (`verified`) — the hash of the content and the version number of every one of the page's
  file rows *and of the page's own row* (its name is there, in none of its files), as the PLAIN (published-layer) reads `fileVersions` and `projectVersions` answer them, taken only from a published copy that was read back and found
  to hold that content *and the compiled output the draft held when it was published*: the build reads the versions, reads the page's PUBLISHED copy back (`publishedDiffers`: plain reads of the published layer, compared field by
  field with the content it sent — the source, the name, the data sources, the model and the bindings — and, given the `runtimeSha256` that `create` and `update` answer with when asked (`runtimeEvidence`), with the hash of
  the published copy's compiled output: the source does not say what runs, and another writer that published other compiled bytes under the same source left a page whose draft, source and versions all agreed with the file),
  and reads the versions again, and records them when the two reads are the same set of rows at the same versions and the copy holds the content and the runtime (a read of them taken once after the publish was not enough: a writer that published other content and put
  this content back as a draft in between left the versions of *its* publication beside this build's hash, and every rebuild then skipped a page whose published copy was the other writer's; a page renamed inside the two reads moved
  no file's version, which is why the page's row is read beside them) — and handed back on the next
  rebuild only for a page whose rows read now (one request for the files of all of the pages, one for their rows) are exactly the
  recorded set at the recorded versions, so an unchanged page costs no write and no PublishXml (otherwise an app of ten pages would pay ten, several seconds each, on every rebuild): a page with no entry, with an entry for other
  content (the spec changed, or its publish failed after it was written — a renamed page whose publish failed is still published, because the record covers the name, not only the source), with an entry that has no versions
  (an earlier release's — the record's schema is the proof's version, 3, and a record of an earlier schema is read for its hashes and skips nothing — or one whose versions could not be proved: the copy read back differs — it was
  published again from elsewhere, and the build says so — or a publish gave no evidence of the compiled output, or a row moved while it was read, or a read failed),
  whose rows were changed, renamed or published from another workspace or machine since (a version moved, a file row added or removed, a read that fails), or whose
  publish was accepted but not seen to take effect, is published. Nothing is certified that was not verified: where the evidence is unavailable the page is not recorded, and the next build publishes it. After an unknown outcome the page is read: what was sent (turn
  included) is there — it landed; the page is as it was — nothing has landed yet, and it is sent **once more** (the SDK compares the page's version tokens, so a page anyone changed meanwhile is
  refused, not overwritten) — and is then *unknown* too if that is not answered either, or is refused while the first is still open; anything else — refused, **not** sent again, with where to look. The
  turn keeps **one identity** across that read (`newTurn.id`, minted per update): the SDK derives the turn's two message ids from it, so the resend addresses the same rows, and a first send that lands beside it
  collides on them and is rolled back whole — the conversation never holds the turn twice. The SDK documents `newTurn.id` as its own to mint; the vendored adapter keeps a GUID it is given, and a test over the real
  bundle pins that. What it sends you to look at depends on the caller (`update()`'s `caller`): the upload script's
  message names `genpage-base.js check` (the deployed page against the file and the base marker beside it), and a re-run goes back through the script's own guards; the **build** keeps no
  base marker and reads every page again when it runs, so its message says to run the build again. A `VERSION_CONFLICT` on the first send is a known answer: nothing was written (on a resend it settles nothing).
  **A first send the service refuses with a throttle (HTTP 429) is waited out and sent again** (`pushThroughThrottle`), where any other 4xx is final. A 429 is the service declining to *start* the request, so the atomic change set committed
  nothing; and sending it again cannot write a page twice: a create's ids are minted before the first send (a send that was in fact processed meets itself on them and is rolled back whole), and an update's turn carries one identity from which
  the SDK derives its messages' ids. An update's send goes through the SDK's version check again, so a page someone saved during the wait is refused as `VERSION_CONFLICT` and not written over — which is why the backend sends it again one push at a time and the
  HTTP client does not replay the request itself: an update's writes carry `If-Match: *`, and `lib/sdk-http-client.js` re-sends a `$batch` only when it is made of conditional deletes (or, for a 429, of column creates). The wait is the schedule that client gives every throttled
  request (`throttleBackoffMs`: 1 s, 2 s, 4 s, 8 s, 8 s, plus jitter) or the answer's `Retry-After` when that asks for longer, **waited whole** — the client's cap of a minute is for a client that has no budget — inside **one budget of five minutes for the waiting a throttled page write costs a build run**
  (`lib/throttle-budget.js`): the build makes it and hands it to every page write (`args.throttle`; a resumed create that brings an earlier payload up to date hands the same budget — the one it was given, or the one it made for itself — on to the update it makes, so that update does not start five minutes of its own; the upload script, which is not a build, makes a budget of its own for its run and hands it to its backend, so that its write and its backend's HTTP client draw from it, and announces a long wait on stderr as `WARNING: …`), and the build's own waits before it runs a phase again after a throttle come out of the same budget, so a service that keeps asking for a minute cannot cost one page twenty silent minutes. **The budget bounds all the waiting a run does for a throttle — the HTTP client's waits as well as the backend's and the build's.** The production HTTP client (`lib/sdk-http-client.js`) draws every wait it takes before it sends a throttled request again — a read, a publish, a delete or a column create answered HTTP 429, alone or as every operation of a `$batch` — from the run's budget (`deps.throttle`: the build hands it to the client its SDK is made over and to the page backend, which gives it to the client it makes; the upload script hands its backend one). Such a wait is what the answer's `Retry-After` asks, **whole** — the client's own cap of a minute is for a client with no budget — or its schedule (1, 2, 4, 8 and 8 s) when that is longer, and it is placed on the clock: the requests the build sends at once are throttled together and wake together, so their waits overlap, and the budget is charged for the time the run waited and not for the sum. A wait that does not fit is **not taken**: the throttled answer comes back as it came — the SDK reports the 429 it is, a refusal that started nothing, and not a failure of the transport, which it would treat as an unknown outcome — and the client tells the budget what the service asked (`decline`; the SDK's error holds no headers), which the build's retry loop reads: the build stops with `throttle-budget-exhausted`, saying what the service asked, on the last run as on the first, and does not run the phases again to meet the same answer. The line the client says about a wait it refused (`refusedWait`, on the `warn` seam) is the fact alone — what the service asked, and that the request was not sent again — and gives no advice on what to run: a request the client refuses can follow a write that committed (the upload's publish follows its create, where the same command again would make a second page), so the way on is the caller's to give — the build's halt says a later run continues, and the upload's result names the page that was saved and the command that finishes it (`--page-id <id>` added). **After the budget has refused a wait no step of the engine starts.** The refusal can be swallowed on its way up — a best-effort step reports a failure and goes on, and the column change set's fallback answers a refused request with others — and the run would keep sending requests to a service that asked it to hold back, and could end as a success. So the engine's runner (`makeRunner({ throttle })` in `lib/entity-provision.js`: the build makes one for each run of the phases and hands it the run's budget) stops the phase with the budget's halt at the next step — `run`, and each item of its `mapLimit` (`stopIfRefused` is the same check for code that must decide before it writes, as the column change set does): a best-effort step does not run and reports it as a warning, the next required step stops the build, and the retry loop reports `throttle-budget-exhausted` as it does for any refusal of the budget. The guarantee is at the grain of the engine's steps. A step that is already running finishes; what pays what the run owes is let through (`settling`: the name column's length of a table the run created, which no later run can set — a run that finds the table leaves its name column as it is, so a stop would leave the table at the platform's default for good — and which is therefore paid in the settlement of a halted data-model phase and in the pass that completes one, where the refusal of one table's update does not keep the next table's from being set; the publishes and lengths the retry loop settles after a halt use runners of their own); and a runner given no budget never stops, as before. What is not throttling keeps its own schedule and is not drawn from the budget — a 5xx (a customization lock or a SQL deadlock victim is a 500, a gateway's hiccup a 502, 503 or 504) whatever `Retry-After` it carries, a reset connection, the re-send of a deadlock victim — and so does a client that is given no budget: the pcf plugin's copy of the file has none, and neither has the client of any script but the build and the page upload (`dataverseRequest`'s own two re-sends, after 2 s and 4 s, are not the client's). `sdk-http-client.test.js` and `sdk-build-pages-deploy.test.js` pin it: ten minutes of throttling in all stop the build with the budget's halt, a client with no budget waits as it always did, and a run that waits less than the five minutes succeeds.
  The SDK's error carries no headers, so `watchThrottles` listens to the answers of the page's `$batch` as they pass (a delegating Proxy over the client, as the
  app-component scope and the guards over it are: every other member is read from the client and runs on it, so a client whose methods keep private state, or a frozen one,
  works through it, and nothing is written to the client) — at
  most six sends in all, and `dispose()` ends a wait that is under way. **A change set the service refuses as a whole is answered HTTP 200 with the one part that failed**, which the SDK can only report as an answer it cannot account for (`ConnectionError`, status 200, "cannot be confirmed"): `watchThrottles`
  reads the parts with the HTTP client's own strict parser (`isBatchThrottled`, `batchRetryAfterMs`, `completeBatchStatus`), which reads an answer only when it is complete and well-formed — its outer boundary closes, every change set in it closes, and every part is a complete response whose first line is a status line — and takes ANYTHING missing or malformed (a part with no response in it, a part with no status line or one cut off, a change set that is never closed, one that is declared and never opened, one whose delimiters are not the boundary it declares, a body shorter or longer than the `Content-Length` its response gives, a part that declares a `Transfer-Encoding`) as proving nothing: an envelope that closes its outer boundary and is incomplete inside is an unknown outcome like any other, never a refusal. When every part of a complete answer is one 429 it is a throttle like any other (the refused part's own `Retry-After` is waited out, the send goes through the SDK's version check again), and when every part is one 400, 403 or 404 the change set
  is a known refusal and is sent **once**, create and update (`refusedWith` on the push, "the service refused the change set with HTTP 403" in the message). A mix of statuses, an answer cut off or incomplete inside, a 409 or 412 (the ids of an earlier send that landed) and a 500 prove nothing about the change set and stay unknown outcomes, read for before anything is sent again; the page is never replayed blindly.
  A **resumed** create is not sent again this way: an earlier request is open, and the refusal is judged by reading the page, as above. A throttle that outlasts the waits — or whose next wait does not fit what is left of the budget — is reported as
  `outcome: 'nothing'` with the 429 as its cause and — alone among the errors a page write raises — **without** `transient: false` (`throttledError`), carrying `statusCode: 429` and what the last answer asked (`retryAfterMs`, and `retryNotBefore`: the moment before which nothing may be sent), so the build runs the phase again (`isTransientHalt` reads the 429 from the cause chain) and **waits for what the service asked, not for its own shorter backoff**
  (`throttleAskOf`, build-model-app.js); a wait that does not fit the budget is not taken, and the build stops with `throttle-budget-exhausted` — a transient halt that says the service asked to wait N seconds and that a later run continues. A wait of more than five seconds is announced on stderr (`⚠ …`, through the `warn` seam: stdout carries the JSON result). Nothing was written, so the page is sent once, by the run
  that gets through. The reads that come before any send are treated alike when the budget refused them: an update's read of the page it is about to change, and the read behind `read`, `describe` and `delete`, throttled until the budget had no room to wait for them, are `GENPAGE_UNREADABLE` with `statusCode: 429` and what the service asked — and, like the write's, **without** `transient: false` — so the build stops with `throttle-budget-exhausted` for them as well, instead of reporting a page that cannot be read; a read that failed any other way, or whose sends ran out while the budget still had room, is final, as it was. A 502, 503 or 504 is not waited out as a throttle: an intermediary answered, so the write may have committed and it is *unknown*, settled by reading the page as above; only the `Retry-After` it carries is waited for *before* that read, so a request still on its way has had the time to land — a wait that is counted in the budget (at most a minute, at most what is left) and never stops the write. A write that was throttled and then taken says so in the `warnings` of its result (which the build prints with the page's name), so a build that paused for a while says why.
  **Every other page-write error carries `transient: false`** (with `outcome`, `nothing` or `unknown`, and the page's `pageId` whenever the write got as far as the send), on the error itself: the build re-runs a phase when a failure
  reads as transient (`isTransientHalt`, build-model-app.js, by the rule of `lib/retry-policy.js`), and an error that says `transient: false` — on itself or anywhere along its causes — is never run again, so without the marker a re-run would send a write again. A *publish* that fails after a write is not an error: it is returned (`publish.kind: 'failed'`) with the
  page's id, because the caller must still record that the page exists. It carries the failure itself as a non-enumerable `cause`, which is what the build decides from. The build halts on it as `pages-publish-failed` (re-runnable: the page is reused and published, not written again) and the
  upload script reports it with the id. **How the build decides to run again is structural, never textual** (`lib/retry-policy.js`): a halt's message quotes what the maker named — a page, a view, a role, a persona, a flow, a path, the
  workspace's folder — and "SQL Timeout Reader" is a legal name for any of them, so the message is never read. Every halt is raised with a policy (`retry: RETRY.NEVER` — a refusal of the spec, an identity or ownership
  conflict, an approval, a prerequisite, a file on the maker's machine — or a policy decided from the failure it wraps: `retry: retryPolicyFor(error)` / `...retryFrom(error, words)`), and `isTransientHalt` judges a failure by the HTTP status the service answered
  (429, 502, 503, 504), a condition the service names by the `error.code` of its answer (the OData error the SDK keeps as the cause of its `ConnectionError`, or the one the engine's own failure records of an answer it read with a request of its own — `serviceFailure`'s `answered`, which `entity-provision.js` passes for the name column's length, the table a debt was recorded for, the update of a column by its ids, a column's required level and the read that identifies the holder of a relationship's name (`relationship-metadata.js` carries the answer's error beside the result it reports by value), so the same answer is judged the same way whichever of the two read it: a customization or solution lock, SQL giving up waiting, a concurrent request on the same record — `TRANSIENT_SERVICE_CODES`, each a code the platform documents — a SQL deadlock victim, and the lag of a column the spec creates, which the spec confirms), a timeout or a reset of the transport (decided by Node's own error code when the error carries one — the HTTP client puts it on what it throws, and the SDK keeps that error as the cause of its `ConnectionError` of status 0 — and by the failure's words only when it has none: a certificate that does not verify quotes the host and the names it carries, and a name can spell a reset, so it is never a blip), and the SDK's or the plugin's own types (`VALIDATION_ERROR`, `VERSION_CONFLICT`, a file system error: a refusal, whatever it quotes, and `transient: false` wins over everything). **A status that is not one of those — a 400, 403, 404, 409, 412, a 500, and the 200 of an answer the SDK could not use — is final, whatever the answer says**: the service echoes what the maker named (`Principal user is missing prvReadcontoso_customizationlockexception privilege`; `contoso_customizationlockexception` is a valid logical name), so a word of an answer decides nothing beside a status. Only a failure that carries **no HTTP status at all** (a plain error, the words a helper reported by value) is read by the *service's own words* as a fallback (a customization lock, "try again later", a SQL timeout or deadlock), from the errors the halt wraps and from nothing the plugin composed. The SQL deadlock victim a service answers with a 500 is run again, narrowly (`isDeadlockVictimAnswer`): its code, `0x80044150`, is the generic SQL error every SQL failure carries, so it takes that code — read from the `error.code` of the answer's body, never from text — AND the platform's deadlock signature (`Sql Number: 1205`, the HTTP client's `SQL_DEADLOCK_VICTIM`) in the service's own answer, which is what follows the url in the SDK's message, so a name the maker put in the url is not read. The number that counts is the LAST one the answer gives: the platform writes its own diagnostic after the SQL text, and the SQL text can quote what a maker named (a duplicate key quotes the value that collided), so a name spelled `Sql Number: 1205` in front of a unique-key violation (2627) is not a deadlock, and one that quotes another number in front of the platform's 1205 does not hide one — the same pattern is the HTTP client's own signature for its deadlock re-sends. The code beside another SQL number (a constraint, a lock timeout) and the signature with no such code — a 500 whose words only quote it, a display name that reads as one — stay final, and a deadlock victim is counted as any transient failure is: the build runs the phase again up to three times. The HTTP client and the SDK send it again first, where that is safe. One typed error is read by the answer it embeds instead of being refused: `ENRICH_DEFAULT_VIEWS_PUBLISH_FAILED` (`WRAPPED_SERVICE_CODES`), the SDK's sentence around a publish of the default views it saved that failed, which holds the publish error's message — `HTTP 503 from <url>: …` — and no cause. Only the status of that embedded answer (or a reset) is read, as the SDK's own `ConnectionError`'s is — never the sentence around it, which names the maker's table (`contoso_customizationlockexception` is a valid logical name, and `CustomizationLockException` is a word the old rule matched anywhere), nor the url; a sentence the code cannot take apart (another wording, an answer that does not open as a `ConnectionError` does) fails closed as a refusal, and `tests/halt-retry-policy.test.js` has the real bundle build the sentence so a change in a later SDK is caught. A by-value
  result (`{ ok: false, error }`) carries the failure itself as `cause` for the halt to decide from, and `retryText` names the words of an error whose own message quotes the maker. `recoverable` is not a retry decision — it says a re-run of the phase can continue, not that the service
  will have recovered. `tests/halt-retry-policy.test.js` enumerates every halt in the sources (`new BuildHalt(` and any halt-shaped literal, by the pattern `tests/helpers/halt-sites.js` documents) and holds each to a row of its table: **a halt added without a policy
  fails there**, and a code that is raised nowhere any more fails too. The pages phase's refusals that quote a page's name (or another app's, or a navigation key) and that a run again cannot change — the scan's refusals of a page's source (`pages-malformed-navref`, `pages-nav-parity`, `pages-stray-pageref`, `pages-dangling-navref`,
  `pages-source-not-utf8`, `pages-blank-provenance`, `pages-griffel-shorthand`), the identity and duplicate-name conflicts (`pages-identity-conflict`, `pages-duplicate-name-create`), the creation receipt that cannot be saved (`pages-creation-receipt-failed`), a page another app holds
  (`pages-shared-across-apps`) and an update that answers with another page's id (`pages-update-identity-mismatch`) — are `RETRY.NEVER`: a page called "SQL Timeout Report" would otherwise make any of them read as a SQL timeout, and the page
  would be run three more times, after every earlier phase, with a log that blames the service. The halts that wrap a failure of the service (`pages-publish-failed`, `pages-existence-failed`, `pages-sitemap-read-failed`, `pages-shared-check-failed`, `pages-read-throttled`) follow it: a 429 or a 503 is run again, a refusal is not. A listing that fails *before*
  anything is written leaves nothing to duplicate, and is retried like any transient halt. A transient halt *later* in the same run (a 503 on a later read or write, say) still re-runs the whole build,
  which reads each page again — as each rebuild does — and a page that already holds its content is not written (and is published only if this workspace did not record that this very content was published), so its history does not record the prompt again.
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
  A page create's identity is written down BEFORE the create is sent, as a **`pending`** record (`recordPagePending`, through the create's `beforeSend` hook — for a navigation target pre-created
  in the "resolve cross-page navigation" step as for any other page), with the name and the SHA-256 of the source it sends: one record per create sent under the id, so a build resumed under the same id with
  another name or source adds one and keeps the earlier (the page may hold either). The name and the source are what a page read back serves exactly as written, which is why they — and not the model, data
  sources, bindings or prompt, which the SDK normalizes — are what recognises a page as the one that was sent. A create that committed whose answer never arrived, and whose page could not be read back, leaves
  the page in the environment's list with no link to its spec entry — the next build would create another; the record is that link. The next build settles every record of a key the spec declares, before it
  creates anything: a record whose key and id already have a **creation receipt** — the create was acknowledged and only the removal of its record failed — is consumed first, without proving the page
  again (a page edited since its create no longer holds what was sent, and that proof would halt the build over a page it made and recorded); otherwise the page is there and holds what a create under the id sent (its name and its source, read) — it is **adopted** (a creation receipt is written, the record consumed, and the page is
  updated like any page that build created, which also brings what an earlier create sent — another model, an older name — to what this build asks for); there and holding something else — a conflict
  (`pages-identity-conflict`: not adopted, not updated); a page that cannot be read is a conflict as well, unless the read was throttled and the run's budget had no room to wait for it — the build then stops for a later run (`pages-read-throttled`, which the retry loop reports as `throttle-budget-exhausted`) and the record stays; not there — the create is sent again under the SAME id (a first send still in flight collides on it), and when the key is bound to another page
  instead, nothing is created and **the record is kept**: an absence is one snapshot, not proof that the request which would make the page cannot still land. The page that lands later is then found by the
  record — adopted for its key if the key is free, or reported as an unused page this build made (it has a creation receipt, so teardown finds it) when the key is bound to another one. A pending record is
  intent, not ownership: it is not a receipt, so it never authorizes an update (`readPageOwnership` does not see it). Teardown deletes a page it finds under a pending id — in the saved layer, so a page that
  was never published is found too — only when its stored name is one the
  create sent, and then consumes the record; an id with no page keeps its record (it is not consumed on an absence). It keeps `--clear-workspace` from clearing until it is settled — by the build, by teardown,
  or by deleting the record by hand once no such page exists, which the message says — and a key the spec does not
  declare is left as it is. **What a record cannot settle is a request still in flight.** A create whose first send got no answer and whose resend was acknowledged consumes its record (the page exists, so the first
  send collides on its id if it lands), and a teardown that deletes a page consumes its record; if that first send is still in flight when the page is deleted — a request that outlives the whole interval
  between a build and a teardown — it can make the page again under the same id, and nothing names it. This is accepted: a client can neither cancel a request it gave up on nor know when it can no longer
  arrive, so a record kept "until it is settled" could never be consumed and `--clear-workspace` would wait for it for ever, for every create that ever needed a resend; the page it makes is an ordinary
  page that Maker lists, and deleting a page in Maker has the same exposure. Once the pages are written and recorded the build also pins the default public view of the tables the pages it wrote read into the app's components — one `placeInApp` call with
  no page and only the tables, in the build's authoring language (the call `genpage-upload.js` makes with `--app-id`; the maker's "/" picker lists a page's tables from them): nothing is written when every view
  is already pinned, and a failure to pin is a warning, not a halt. The pin adds the views it names and nothing else of the app's components (the SDK's push that carries it would add every active Main form, public view and chart of each table the app's navigation opens, which is limited at the transport: `lib/app-component-scope.js`), so it cannot put back what the app's maker took out, or undo the `app.mainForms` list of the same build.
  When it does write, it pushes and publishes the app inside the page backend, so the build hands it the request that publishes the tables
  whose forms the app's publish ships (`beforeAppWrite`, below), which it awaits right before its first write — told what that write sends — and never calls for a placement that writes nothing.
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
  the structure saved with them goes live. That does not depend on who saved the label, and the app's
  publish ships the forms the app holds, so with `--publish` the same step publishes, in ONE `PublishXml`,
  every table the build changed and every table whose forms or charts the app holds once the build has written
  it (`preAppTables`, in `lib/table-publish.js`): the tables the reconcile published (what the SDK's own publish
  of them covered), the tables of the charts the run wrote, the tables whose Main forms the build's own write of
  the app adds (`appPushTables`, `appWriteTables`), and the tables of the form and chart components the app's saved component
  list names on the server (`readAppFormChartTables`), whether or not the spec names the table — a form a maker
  added to the app in the designer, on a table the spec never mentions, counts. The SDK's write of an app (the
  create, and every push of an existing one) adds the active Main forms, public views and charts of the tables
  of the sitemap's Entity subareas, and of those alone (the bundle derives the entity list from the sitemap, and
  `app.mainForms` restricts a table to the forms it names), so the tables of the navigation THAT WRITE SENDS are
  named: the forms are not in the app's component list until that write adds them, and a form that is live with a label
  saved and not published would be pinned, and published with the app, by the very write that adds it, before its
  table was. That protects the first build and the build that pins a form, in the same build. It applies to every
  write that PUSHES the app through the SDK with nothing limiting it: the create of a new app; the push of an existing one, by the app step
  or by the pages finalizer (the app step names the navigation's tables up front when its run is sure to push the app,
  as `existingAppSitemapIsWritten` says; the push that only carries the routing description, made only when the
  description differs, asks for its own tables when it is made). The placement of a default view the app lost
  (below) pushes the app too, but through the page backend, whose transport limits that push to the views it pins
  (`lib/app-component-scope.js`): it adds no Main form, so it reports no table and none is named for it. The navigation is the one the writer sends, which is not always the spec's: the create, the app step's push
  and the finalizer's write the spec's (`appWriteTables`, with the resolved `app.mainForms` list they apply), but the push that only carries
  the routing description re-sends the workspace copy's, which is the server's — so a navigation entry a maker removed in the designer names no table, one a maker pointed at another table
  names that one, and the spec's navigation is never used for a push that does not send it (`appPushTables`, from the
  Entity entries the writer reports: `entityTablesOfSiteMap`). A write that only publishes
  the app adds no form, and a table whose `app.mainForms` list keeps no form adds none and is left
  out. A table that only `app.tables` pins is a table component, which the plugin pins itself
  (`pinAppTables`); the SDK expands no form of it, so it is not named (`publish-scope-real-bundle.test.js` runs the
  real SDK to pin both facts). The spec decides nothing else here,
  because a table's publish ships everything saved on it, whoever saved it: naming a table the app is not known
  to hold a form or chart of would release a maker's unfinished work there for nothing. So it is NOT every
  table the spec names, nor the target of a lookup column, nor a table only a page reads (the pages phase pins
  its default VIEW, which is no form or chart), nor one that only `app.tables` pins. The read —
  `readAppComponentInventory` narrowed to the two component types that count — is made for every build that
  publishes into an existing app: the app's layer, one component list per type and one lookup of the tables per
  20 components, in the SAVED layer (`RetrieveUnpublishedMultiple`: the component list is the saved layer's, so a
  form a maker added in the designer and never published is in it, and a plain read, which answers the published
  layer only, would not find it and would disable the protection of every other table the app holds); no table
  metadata and no view is read, which is what an app of fifty tables would otherwise pay serially on every build.
  It must be COMPLETE and unambiguous: `requireIdentified` makes every component id come back as a row of its own
  that names a table in the shape of a table name (a dashboard's is `none`), counts a row only for an id the
  component list asked about, and takes two different tables for one id, or a value that is no table
  (whitespace, a number, two words), as an answer that cannot be relied on; one that does not make it so — a
  stale component, a record the caller may not read — makes the whole read unreadable. So does a row of the
  component list itself that cannot be placed (`unplaceableRows`: no record, no objectid or one that is no GUID —
  `{}` is braces around nothing — or a component type that is not the one asked for): such a row is dropped by the
  filter that follows, and the component it stood for would read as "the app holds no such component", an
  incomplete list that looks complete. The download keeps reading the list as it always did. Then the request names
  what the build changed and what its write of the app adds, which need no read, and the build says which proof
  failed, naming no table and recommending no publication, because it cannot say which tables the app holds
  (`describeUnreadAppComponents`): publishing what is not proven to be the app's is the one thing this step must
  not do. The request goes by name through the raw
  client, because the SDK's artifact publish names a table only through a form, view or chart it holds. It
  closes a label a maker saved and never published on a table whose forms the app holds or is about to hold, and
  publishes the
  description of a chart the run wrote (a PATCH of the saved row in the charts phase, which waited for phase 8,
  after the app's own publish; whether the platform holds it back as it holds a form's labels was not
  measured) with its table. The request takes the place of the reconciled tables' envelope, so a rebuild whose
  views or forms exist sends the same three publishes as before (the tables, the app's finalize, phase 8) and
  a build that reconciled nothing sends one more when the request is not empty (a first build has one when its
  navigation opens a table or it wrote a chart). Phase 8's envelope names only the
  tables the build has artifacts of, so a table the app holds a form of and the build did not change is published
  once, before the app, and not again by the final publish. **Every write of the app asks for the request**
  (`appWriters`, in `lib/sdk-build.js`: the create, the push, the publish, the publish after the table
  components are pinned, and the placement of default views; the publish phase and the AI features' re-issue
  publish the app through them too), and each asks for what ITS write needs, so no path can reach the app ahead of
  the tables whose forms its publish ships; the engine makes no call to the SDK for the app anywhere else
  (`publish-scope-real-bundle.test.js` reads the source and fails on one). The app step makes it once for the
  whole build, and a later writer sends only the tables it did not name — on a build that went through the app
  step, none, so the counts above do not move; a run that reaches the app by another writer first sends it there,
  before that writer's first write. The one such run the CLI allows on `--apply` is the changed-only re-upload of
  a page (the pages phase alone, with no app step and no finalizer): its placement of default views pushes and
  publishes the app by itself when it finds a view the app lost (a maker took it out), and is handed the
  request to await right before it (`beforeAppWrite`), so a re-upload that has nothing to repair still writes and
  publishes nothing (0 publishes, as before) and one that repairs a view sends the request, then the app's
  publish (2 where it sent 1), naming the tables the app holds forms and charts of — not the tables the page reads, and
  no table of the navigation. The placement pushes the app through the page backend, whose transport limits that push to
  the views it pins (`lib/app-component-scope.js`), so the push adds no Main form and the placement tells the request so
  (`beforeAppWrite` is handed no Entity table, and `pushes: false` for a completion that only publishes the app; only an
  SDK lent to the backend, whose push is not limited, reports the Entity tables of the navigation it sends): a maker's
  change to the navigation in the designer stands after a changed-only re-upload of a page, which rewrites none, and a
  table an entry was pointed at, whose forms the app does not hold, keeps what was saved on it. The placement applies none of the spec's `app.mainForms` list either, so
  the request looks no Main-form name up for it: a form renamed on the server does not stop the repair. The gate is the
  `--publish` flag, not the publish phase, which that re-upload does not have, and it comes first: what a write adds is
  worked out only once the request is going to be made, so a run without `--publish` reads no Main-form catalog and
  resolves no name for it, and a publish alone (the publish phase, the publish after the table components are pinned,
  the AI features' re-issue) resolves none either. Only the writers that apply the list — the create, and the
  pushes the app step and the finalizer make — look its names up, as they always did, before they write anything. A raw publish does not re-baseline
  the SDK's workspace copies of the views and forms it publishes; nothing pushes one again in the run, and the
  next run fetches each before it edits it (`publish-by-name-sdk-state.test.js` runs that against the real
  SDK). If the request is refused, nothing is assumed published: the reconciled tables go through the SDK as
  before, and the build says plainly that its protection did not apply to the others (`describePreAppRefusal`),
  reporting what this run saved on them (a chart's description is named as such, with the plain statement that
  whether the app's publish holds one back has not been measured) and, separately, the measured risk to the
  forms the app holds there, or its write adds — a later publish of the table does not release a label, so one
  that does not show may have to be saved again and then published with its table before the app. A table can
  carry both, and each is said. It does not stop
  the build, because stopping every build over a table it did not change would be out of proportion. Without
  `--publish` it is not made, and an SDK with no raw client (a test double) publishes the reconciled tables as
  before. The enrichment's default views (columns only) wait for the bulk publish as far as the reconciled
  tables' record goes. A table whose
  early publish the SDK refuses stops the build before the app is written
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
  build publishes, so the line for a publish a halt settles names what was deferred. A table's publish ships
  everything saved on the table, whoever saved it, and a created artifact is owed no publish, so that line is
  not all that is saved and not live: after the settle, for a build with a publish phase (an apply with
  `--publish`) that stopped before it — a final halt, not one before anything was written, not one after the
  phase completed (`owedPaid`, as a halt of the AI features' re-confirmation is), and a retried transient halt
  reads nothing — the CLI hands the spec's tables to the settle (`specTables`: the tables it declares, those its
  forms, views, charts, `app.tables` and navigation name, and its pages' data sources, which validation does
  not make it declare; this is the READ-ONLY list, wider than the one the build publishes), which reads the
  SAVED layer of their views,
  forms and charts (`readSavedNotPublished`: `RetrieveUnpublishedMultiple` of each collection, a record whose
  `componentstate` is 1 Unpublished or 3 Deleted Unpublished) and adds one line naming what it found, table by
  table — a maker's saved edit and what the build created, which nothing deferred, included. The read comes
  after the publishes, so what they made live is not claimed. If it cannot be read, or an answer carries no
  state, a record that names no id or no table, or a state that is none of the four, the line says that and
  names the tables to publish, never a partial list; and it says that columns
  and other kinds of change were not read. Settling covers
  a halt the build THROWS. A process killed outright (Ctrl-C, a crash, a closed terminal) settles
  nothing, so what a reconcile had saved stays saved but unpublished until the next build, which
  publishes it (a clean workspace copy is still published, below): no marker outlives the process, the
  default-view enrichment has the same exposure, and the app-builder skill's recovery guidance says to
  re-run. A default-view push refused by a concurrent edit fails the enrichment step, as any refused
  push does. The name column length a failed attempt left unset is carried across attempts the same way
  (`owedLengths`, `settleOwedLengths`; see *Primary name column length* below).
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
  **An existing app's name and description are applied on a rebuild** (`applyAppHeaderText`, `lib/sdk-build.js`).
  They were written at create only, so a rebuild with an edited description reported the app step as done and left
  the old text. They are edited on the fetched artifact and ride the push that already writes the app — the
  app-shell's page-less rewrite, the pages finalizer's, or the routing-description push — never a push of their own.
  Only a non-blank text is written, and only when it differs from the fetched copy (the guards a view's and a chart's
  description have), so a spec that leaves the description out or carries the `""` a download writes never blanks
  one a maker typed; the spec wins over a text changed in Maker, as it does for those. The unique name is the app's
  identity and is never written: a spec that pins `app.uniqueName` (a download does) is renamed, one that does not
  names a different app. **A text that is not plain is never sent, and it holds nothing else back.** Both columns are
  localizable, and a plain write of the base-language text has not been measured to keep the translations beside it, so
  a name or description that comes back as one text per language — or as any other value that is not a string — is never
  edited and never sent: not as a map (these are String columns), and not replaced by a scalar. Its own edit is reported
  as not applied, with the reason (change it in Power Apps) — a warning, never a halt; a localized text the spec's own
  text already equals needs no edit and no word. The other text and a requested routing description are applied as usual:
  the SDK's header PATCH carries only the texts that changed (cds-maker-sdk 9a0c9f03; pinned in
  `app-header-text-real-bundle.test.js`), so a localized name beside a changed plain description writes the description
  alone and leaves every translation of the name as it is, and the reverse. (While the SDK wrote the whole copy in every
  header PATCH, one text that was not plain held the whole header back, and this paragraph said so.)
  **A text that is not plain is kept off the wire by being taken off the workspace copy**, right before the push
  (`takeNonPlainTextOffCopy`, called by `pushAppHeader`, `removeElement('app', id, '/name')`): the SDK neither compares nor
  writes a text that is not on its copy — now its documented contract, where it was once an SDK internal (the serializer
  dropping `undefined`) whose failure, a re-vendor that writes `name: ''`, would blank an app's name; the real-bundle
  tests pin it, and that the push saves, leaves the copy clean and that a plain fetch brings the maker's text back. The
  texts to take off are what `applyAppHeader` answers as `held`; it edits the copy no further than the edits themselves.
  The push is where they come off — not the edit — because a copy that holds an edit no push follows is refused by the next
  run (`refuseUnpushedAppCopy`): the routing description of a page-backed app is pushed only when it changed.
  **Taking it off the copy is what makes it safe when the SDK's own read fails** (`lib/app-header-text.js`).
  The SDK's push reads the app's header and compares it with the copy; its "write needed" flag starts true and only a 2xx
  answer sets it, so a read that cannot be made (HTTP 503 or 403, a thrown error) leaves it true, and an empty 200 is
  compared with an empty header, which differs: it then writes every text the copy holds, the text that is not plain
  included — which is why the hold on the edit alone was never enough. With the text off the copy, only the other text is
  written then (the copy's own, on the row's token, as for a plain header), and the build goes on.
  So the HTTP client every SDK is made
  with (`lib/maker-sdk.js` is the one way a script makes one) still refuses a PATCH of an app module row whose `name` or
  `description` is not a string, before any byte is sent: `APP_HEADER_NOT_PLAIN_TEXT`, an `SdkError` the bundle rethrows
  as it is, marked `transient: false` (the build never runs the phase again on its own for it). It is the last line of
  defence, for a push of a copy the build did not clean — the page backend's push of the app, which fetches its own copy —
  and the build's own push never meets it. Nothing is sent, and the SDK writes the header before the navigation, so the
  push wrote nothing of the sitemap either; the halt is `… failed: …` with that code, and its message says the header holds
  a text that is not plain, that nothing was written, and that the SDK only tried because its own comparison read failed — so
  a re-run normally succeeds. Pinned over the real bundle for each way that read fails, a localized and an array-valued text, in
  `app-header-text-real-bundle.test.js` (the build's push goes on without the text; a push of the copy as the SDK holds it is
  refused).
  **The guard stands in front of every door the SDK's client has, not only `patch`.** A PATCH of the app module row that
  rides in a raw change set (`sdk.dataverse.postBatch`, which sends the body a caller rendered through the client's
  `postRaw`, or the same text through `post`) or in `patchRaw` is refused the same way — the same typed, non-transient
  `APP_HEADER_NOT_PLAIN_TEXT`, before the client is asked for a token. A change set is read the way the service reads it
  (`lib/batch-request.js`: the parts of the boundary its Content-Type declares, a change set one level down, one request
  in each part), so what the SDK's own atomic writes send — a table's columns, an app's delete, a page's rows — and
  every other table's batch go to the client as the very text they were given; a batch that names the app module table
  and cannot be read (cut short, another boundary, a part that is not a request) is refused as well, and so is a PATCH of
  the row whose body is text that is not JSON. Every other member of the client runs on the client itself — the guard is a
  delegating Proxy, not `Object.create`, so a client whose methods keep private state (a class with `#fields`) works, and
  a member the client lacks (`postRaw`, `patchRaw`) stays lacking, which the SDK reads. Pinned at the real SDK and the
  plugin's own HTTP client in `app-header-text-transport.test.js`, and at the guard in `app-header-text-raw.test.js`.
  A **never-published** app takes no write to its name or
  description until it is published, and the SDK refuses the push before it writes anything
  (`APP_DRAFT_HEADER_NOT_WRITABLE`). For a text edit alone that is a warning, not a halt: `pushAppHeader` puts the fetched
  text back, pushes again — the navigation and the rest of the build are then written as they always were for such an
  app — and warns *not applied: the app was never published; publish it in Power Apps and re-run*. It still halts for
  a routing description in the same push (below), for a 412 (a concurrent edit), for any refusal that survives the
  put-back, and when the text cannot be put back. **The icon
  is the one header field a rebuild cannot change** (`webresourceid` is write-once and the SDK's header push does not
  carry it): when the spec names an `app.icon` that is not the app's, `warnAppIconNotApplied` says so; a spec with no
  `app.icon` is never compared. `--verify` checks the routing description but not the name or the description.
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
  **A navigation Dataverse would refuse stops the build before it writes anything.** A new app is created in the
  app-shell phase with the navigation the spec gives it MINUS its page entries (`appDef` with `omitUnbuiltPages`: a page
  does not exist yet, and the pages phase writes it into the navigation afterwards), and Dataverse refuses to CREATE a
  sitemap with no non-empty area holding a non-empty group (measured: HTTP 400 "SiteMap needs to have a non-empty Area
  with a non-empty Group, even when ignoring all Areas, Groups, and SubAreas with an IsVisible child"; the spec models no
  such children). It does not refuse the same navigation when the sitemap of an app that ALREADY EXISTS is updated:
  measured on an app that had one entry, the SDK's update of its navigation to `areas: []` and to an area holding an
  empty group were saved, a raw PATCH of the sitemap row to an area holding an empty group answered 204, and publishing
  after each (the SDK's publish, and a raw `PublishXml` of the app and its sitemap) was accepted, the published sitemap
  then holding no entry at all. `validateAppSpec` still accepts every spec that has none — no `appShell`, `areas: []`, an
  area with no group, a group with no entry, a navigation of pages only — because data-only builds rely on it, and a
  downloaded spec carries the app's own navigation, which can be empty, so a build of a new app used to fail at the app
  step, after the solution, tables, views and forms were written. `navigationVerdict` (`scripts/lib/app-navigation.js`)
  now decides from the spec alone, whenever the app-shell phase is in the run's range (never for `--stage data`, or an
  `--only` without it). A NEW app needs one table, dashboard or url entry in a group in an area, because its first push
  creates the sitemap: a navigation of pages only, or with no entry, is refused. An EXISTING app is refused for neither.
  Its navigation is written from the whole spec once the pages exist, so a page entry counts; and an empty navigation is
  built (Dataverse accepts it on an update) with a WARNING that the app is left with no navigation entries — any it has
  now are removed, which the destructive-operation gate (`lib/op-diff.js`, wired in `buildModelApp`) asks
  `--allow-destructive` for. That is said only when the run writes the navigation to the existing app
  (`existingAppSitemapIsWritten`: the pages finalizer with the pages phase in range, except in a changed-only
  re-upload; the app step without it, for a spec with no page entry); a run that writes none leaves the app as it is
  and says nothing. A spec with no `appShell.areas` is refused for every app (`appDef` throws on it before it asks
  whether the app exists). `appDef` classifies an entry through the same `navigationEntryKind`, so the entries it
  leaves out of the first push are the ones the check does not count.
  The dry run (`checkNavigationInPlan`) marks the app step `? unknown` with the reason and `wouldHalt`, so the summary counts
  it as "would stop the build" — with a live plan and with `--no-live-plan` alike, and a summary that counts a step that
  would stop the build closes with "Fix the steps marked ? above, then re-run with --apply to execute." rather than
  inviting an apply that would stop; `--apply` (`checkNavigationBeforeWriting`, ahead of the view-filter pre-flight) halts
  with `BuildHalt` code `app-navigation-empty` (phase `preflight`, `recoverable: false`, `transient = false`, never
  retried), saying what the platform requires and what to add — `{ entity: '<table>', title: '<label>' }` in a group, and
  for a navigation of pages only that a page entry joins the navigation only once its page exists, so a new app needs one
  other entry. A navigation that is fine for an app that exists and refused for a new one — pages only, or no entry at all
  — depends on whether the app exists, so only it reads that: one `findArtifact('app')`, the read the app step makes next.
  A valid navigation adds no call, and its plan and requests are byte-identical to what they were. When that read cannot
  answer (`--no-live-plan`, a failed read) the stricter rule is not applied: the build warns what it could not check and
  goes on as before. A spec with no `appShell.areas` is refused whatever the answer. The destructive-operation gate in
  `buildModelApp` runs before the engine's check, so for an existing app whose navigation the spec empties it asks first —
  the removal is real, and the build then goes on — and it does not ask about a spec the check refuses outright:
  `discoverOpDiffState` reads the deployed navigation only for a spec that declares `appShell.areas`, so a maker is never
  asked to authorize the removal of entries from a navigation the build will not write.
  `lint-app-spec` warns (`appShell: …`) for a navigation a new app cannot be built from, and says whether an app that
  already exists is spared (not affected, or built with no entries). A test that builds a NEW app against a fake SDK must
  give its navigation an entry that is not a page: the fakes do not model the platform's rule.
  Pinned by `app-navigation.test.js` (the rule, its agreement with `appDef`, validation, lint) and
  `app-navigation-build.test.js` (dry run and apply for every shape, with every call recorded, the summary line, and the
  order of the destructive gate and the check).
  **An existing app's sitemap is rewritten ONTO its live nodes (AB#6726727).** The App Spec describes a
  node's label/title, target and icons only, and the SDK serializes a node without its fetched `bag` from
  scratch (new `Id`, `ResourceId="SitemapDesigner.NewSubArea"`, broad `Client`/`Sku`,
  `AvailableOffline="true"`). Both existing-app writers (the app-shell write and the pages finalizer)
  therefore pass appDef's tree through `adoptLiveSitemap` (`scripts/lib/sitemap-merge.js`) first: a
  subarea corresponds by navigation target (a URL keeps the case of its path and query), an area or
  group by a label its level uses once, then by the navigation entries it holds, then by the id an
  earlier build gave it, then — for an unlabelled one with no entries, which is all an earlier download
  wrote for each empty group of an environment whose base language is not 1033 — by elimination: one such
  node and one live node with no entries that nothing else paired are each other. A node none of these
  identifies is written as new rather than guessed; when that drops a live node with no entries and its
  title (the spec has more than one unlabelled empty node, or the environment more than one empty live
  one, so which is which would be a guess by position), the build names it (`has no entries, and the
  spec's unlabelled empty groups cannot be matched …`) — label the spec's node to keep it. The
  live `id` and `bag` are kept, and only
  what the spec sets is overlaid — an icon it does not name is still removed, as before. **A title it does
  not state is kept, never cleared:** an empty or absent `label`/`title` says nothing (the download of an
  environment whose base language is not 1033 once wrote every one empty, and an author who leaves a
  title out has not asked for it to go), so the live title is written back as it is and the build says so
  (`kept the environment's title '…' — the spec has none for it`). The one exception is an entry
  (subarea) whose title the baseline below shows the spec used to state: the author took it out, and the
  edit is applied. An area or group has no target to find a baseline by, so its title is always kept —
  state one to change it. Because the SDK
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
  reported. A **generative page entry that names no icon** holds the page icon the platform gives it
  (`GENPAGE_DEFAULT_VECTOR_ICON`, `scripts/lib/genpage-subarea.js` — the SDK writes it whenever it serializes
  one), so a rebuild finds an icon live that neither the spec nor its
  baseline named. That is not a change made in the designer: it is not kept, not reported and not
  rewritten (the live string is written back as it is). An icon a maker chose — any other value, or the default on
  another kind of entry — is kept and reported as before, and an icon the spec names is written over the default; a test
  over the real bundle holds the constant to what the SDK writes (`sitemap-adopt-real-bundle.test.js`). Baseline entries are lined up with live ones by the ids the baseline RECORDED for its
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
  `--language-code` → App Spec `languageCode` → the org's base language → 1033 (`--verify` resolves the language its
  string tab and section labels were written in by the same precedence — it takes the same flag — but never falls to
  1033, and compares them only in a language its form read carries: see the form-layout paragraph). Without this, an org
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
  default views), and a downloaded spec need not carry forms, views, charts or table icons and marks every table
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
  Every app push the BUILD makes carries the SDK's `components.mainFormsByTable`, after every fetch,
  and excludes conflicting explicit Main pins by ID. Create is exact; update adds only listed forms
  and never removes old ones. SDK extras are surfaced by name with the Maker remedy, and verify
  fails them. A generative-page edit of an app (`placeInApp`, `removeFromApp`) is no build push and
  carries no directive: it adds no Main form at all, because its push is limited to the sitemap and
  the views it pins (`lib/app-component-scope.js`). This does not set a default/order/security roles. Measured: changing membership after
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
  because Dataverse refuses to delete an activated process. A business rule is TWO rows (the definition and
  the activated copy the platform makes of it), deleted in that order, and the copy can no longer be deleted
  once its table is gone (400 `0x80041102`), so **a table whose business-rule step failed is kept** (see the
  solution, below). Deleting an activated BPF is also what
  removes the org-owned **backing table** the platform creates on activation. **Web resources are deleted after tables**: a table's vector/raster
  **icon** web resource is referenced by the table itself, so Dataverse refuses to delete it until the table
  is gone (form JS, referenced by its already-deleted form, is safe either way). Teardown also removes the
  build's **generated default app icon** (`<appUnique>_icon`, created in-solution when the spec sets no
  `app.icon`) so it doesn't leak as an orphan. It keeps the **page manifest** while the generative-pages
  step fails (a failed manifest or page read fails that step too), so a re-run still finds the pages the
  app's manifest lists. Before deleting the app, it resolves page candidates, their stored names
  and this app's sitemap. A page exists, and its stored name is read, in the **saved layer** (`savedPageRows`: the pages' own
  rows through RetrieveUnpublishedMultiple, the authored row when a pending edit makes the platform answer with both): a plain
  read of the page table answers the published layer only, so a page that was created and never published — a build killed
  after the create change set, a publish that was refused and never finished, a standalone create — was "not found", kept with its
  conversation messages and its receipt consumed as if it were gone. The build's own listing (`enumerateEnv`) and `apps.js` read the
  same layer. Only navigation members or corroborated local creation receipts authorize
  deletion; names alone do not. A receipt corroborates a page named as the spec calls it now or as the receipt recorded it when
  the build made, or adopted, the page (a page adopted but not used keeps the earlier name). Navigation is either layer: the published sitemap, and the saved but
  unpublished one when the published layer leaves a page unproven (`navigationProof`, the layer a download reads);
  when that saved layer cannot be read and a page stays unproven, the app is left intact for a re-run. An app that was **never
  published** has no published layer at all — a plain read answers "not found" for it, as for an app that was deleted — so its saved
  navigation is the only proof there is. When the published read finds no app, `navigationProof` asks the SDK's own app lookup (the one
  the app step deletes by), which reads the saved layer, whether the app is there: it reads the current layer's sitemap there, through
  the layer's sitemap component or, when the layer has none, the sitemap that carries the app's unique name (the rule the scan of the
  other apps follows), and the pages it names are proven like any navigation member. A sitemap found by that name is the app's only when
  the row that is read carries the name itself: the current row (the authored one, when a pending edit makes the platform answer with both
  layers) is selected first, and it and every other row of that sitemap must carry the app's unique name — a name on an older row alone would
  hand the app whatever the current row holds, though its own name says it is another's, so rows that disagree on whose it is are an unreadable
  navigation, not "no pages". An app in neither layer — the re-run of a teardown
  that deleted it — costs that one look and is left to this workspace's records, as it was. A saved navigation that cannot be read is an
  error that keeps every page, as an unreadable published sitemap does (the message says the app was never published, and what failed to
  read), and the app stays for a re-run. **A page is in a navigation when one of its ENTRIES names it**: the pages are read from the
  sitemap's elements (a `SubArea` directly under `SiteMap/Area/Group`, its `GenPageId` in either quote style and with any XML character
  reference, a GUID — or a braced one — as the SDK reads it: `navigationGenPageIds`), in every layer, never from the text of its XML. ONE
  strict XML reader reads the document in one pass, one lexical context at a time (`scripts/lib/strict-xml.js`), so a `GenPageId="…"`
  inside a comment, a CDATA section, a processing instruction or another attribute's value is no entry and proves nothing, whatever
  delimiters those hold (three passes that each took one kind of construct out of the text read `<?p <!-- ?>` then `<![CDATA[ --> ?> <SubArea
  …/> ]]>` as an entry); a single-quoted one is an entry. Names are exact — XML is case-sensitive, and so are the platform's `SiteMap`,
  `Area`, `Group`, `SubArea` and `GenPageId` and the SDK's reader of them: `genpageid=` or `<subarea>` names no page. A document that is
  not exactly ONE well-formed XML document (two roots, text outside the root, an unclosed or mismatched tag, a duplicate or unquoted
  attribute, a `<` in a value, an undeclared entity, a document type declaration, a character XML does not allow), or a page id that is no
  GUID (on any `SubArea`: the SDK's app delete refuses one wherever it is), is an unreadable navigation (`malformed`) that keeps every page
  and **records nothing** — the teardown records outlive the app, so a record made from a document that does not read would delete on a
  retry — as a published sitemap that fails `fetchSitemap`'s own check does; the reader answers no element of such a document, not even those
  before the fault. It is stricter than XML 1.0 only where the SDK's own parser (xmldom) reads a document differently or warns about it —
  a name beyond what that parser and every edition of XML accept, end tags of one name written both `</SubArea>` and `</SubArea >`, an
  XHTML `script` — so that a document it accepts is one that parser accepts too, with the same ids (`tests/strict-xml-oracle.test.js`
  holds the two to each other over a generated corpus, with the bundle's own xmldom as the oracle). The text readers (`sitemapGenPages`, `sitemapGenPageIds`, the
  `ids` of `fetchSitemap`) serve what deletes nothing — the scan of the other apps (which only refuses), the build's membership check, verify,
  download, the listings — and no page is deleted on them. A page another app's navigation still references is refused by the platform and kept, as for any
  app. The BUILD binds a page by its published navigation or a receipt only; a page only in the saved layer halts with advice to
  publish the app first (the build's shared-page scan reads OTHER apps' saved navigation as well — see above). The verified ownership set is persisted locally before app deletion,
  so a page-less retry still has proof after the app is gone. Unreadable proof or a failed record write
  leaves the app intact. Proven pages still undeleted, including dependency-blocked pages, keep the
  manifest, solution and local teardown record and make the run fail. Records are consumed only for
  completed deletions or confirmed absence. A page is deleted through the SDK (`deleteRemoteArtifact('genPage')`): its project row, whose
  files go with it, and then the conversation messages that point at it (they do not cascade). A page the platform refuses to delete
  (still referenced by another component) loses nothing, since the row goes first. If only part of the conversation history cannot be
  removed the page IS deleted: that is a warning naming the history rows, not a failed step. A "not found" from that delete is not
  taken as "already gone" on its own word: the page handler has a `confirmAbsent` that reads the saved layer back (`savedPageRows`), as the
  app handler does for its delete, so a page the platform still holds fails the step and keeps its receipt and pending record, and a read that
  cannot be made counts as "not proven gone". The SDK's delete sends no `MSCRM.IncludeUnpublished`, and its own notes say a by-id request on a page that was
  never published answers 404 without it; measured live, the platform DELETED such a row, so the read-back is insurance against an answer it has not been seen to give.
  Form-only page references are not scanned.
  **An app is TWO rows** — an `appmodule` AND a `sitemaps`
  row, with no server-side cascade. The sitemap is linked by a type-62 `appmodulecomponent` on the app's **current**
  `appmoduleidunique` layer, not necessarily by equal unique names (first-party and renamed sitemaps may have different names).
  Only an app with no sitemap component permits a same-name fallback, and only when no other live app's current layer pins that candidate.
  Deleting only the appmodule strands the sitemap
  forever and, because `sitemapnameunique` is unique-constrained, permanently **burns that unique name**:
  a later build of an app with the same name fails with *"The name &lt;x&gt; is already in use by an
  existing site map"*, which the maker cannot act on. `deleteAppCascade` therefore resolves the sitemap
  BEFORE deleting the app, rechecks the current link after reading it, deletes both rows in **one atomic OData `$batch`**, and **fails closed**.
  Missing, malformed, ambiguous or changed identity refuses as `APP_SITEMAP_UNRESOLVED`; a sitemap another live app currently pins refuses
  deletion as `APP_SITEMAP_SHARED`. Fetch/push also refuse a shared same-name fallback rather than adopting another app's navigation, and
  download returns the refusal with `ok:false` before writing output. A copy whose app was re-linked must be fetched again before pushing edits.
  The reverse-owner check is a snapshot, not a cross-app lock: another app adding a pin afterwards moves neither row token, so this does not
  promise to prevent that race. Each row's delete is conditioned on its
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
  An app-create rollback preserves the SDK's distinction between **KEPT** (a whole atomic change set was refused by the customization lock
  and deleted nothing) and **unconfirmed** (its answer cannot prove what happened). Its advice is surfaced unchanged: verify that the rows
  are this create's own before removing them; a raw outer 429 remains unconfirmed and retains its lock error, rather than proving KEPT.
  Neither `PublishXml` nor an unguarded rollback is re-sent.
  Pinned by
  `scripts/tests/app-delete-real-bundle.test.js` against the real bundle — every other teardown test
  drives a mock and would stay green through a regression here. The teardown of an app that was created and never
  published (its pages proven by the saved sitemap, the platform's refusal of a page another app references, a saved navigation
  that cannot be read) is pinned against the real bundle too, in `scripts/tests/teardown-never-published-real-bundle.test.js`:
  the app is made by `createApp` and left unpublished, so the sitemap that holds its pages is the one the SDK writes. What counts as
  navigation — a page named only in a comment or a CDATA section is not proven, a single-quoted `GenPageId` is, for a published app and for an
  app that was never published, found by its sitemap component or by name — and the rule that the current row of a sitemap found by name carries the
  app's own unique name (both row orders, nothing recorded or deleted) are pinned against the real bundle in
  `scripts/tests/teardown-navigation-proof-real-bundle.test.js`, where the pages deleted are checked against the pages the SDK's own reader of the sitemap retains;
  so are the markers of one construct inside another (a processing instruction that holds `<!--`, a CDATA section that holds `-->`), a sitemap that is not one
  well-formed document (nothing written, nothing recorded, and a retry in the same workspace after the repair deletes only what the repaired navigation names),
  and the exact requests of a published app's teardown (`scripts/tests/golden/teardown-published-requests.txt`).
  The empty solution container goes last — but a **built-in
  system solution** (`Active`/`Default`/`Basic`) is **skipped** (Dataverse 400s any delete of a restricted
  solution), so a downloaded spec whose real solution could not be recovered (and defaulted to `Default`)
  still tears down cleanly instead of erroring. It is also **kept while any earlier step failed**:
  dashboards are found by name, and the app's own are the ones its solution holds (a built-in container
  holds every dashboard, so with no real solution teardown deletes none), which makes the solution the
  only proof a re-run has — deleted after a failure, the retry kept the app's dashboards for good. A
  membership read that fails is itself a failed step, never a skip or a not-found (as either, the
  solution was deleted right after it). The same goes for a **table** while a business-rule step on it
  failed (its rows could not be read, or its definition's or its activated copy's delete failed — an HTTP 500
  included): the copy is deletable only while its table exists, so dropping the table anyway turns a failure
  a re-run could finish into a leftover nothing can remove (live: a definition delete answered 500 "There is
  no active transaction.", the table was dropped, and the re-run reported success with the copy still there —
  an answer that says "not found" reads as "already gone"). The table is reported as `table <name> (kept —
  business rule(s) on it could not be deleted ("<rule>"), …)` (`skip: 'kept'`, counted in the summary's
  "kept"); the rule is matched to it by logical name in any letter case, and a re-run deletes the rule, then
  the table, then the solution.
  Only a table the run would have deleted is kept this way — a reused (`existing: true`) or system table
  keeps its own skip reason, and what hangs on one is sent as it always was. Nothing re-sends the failed delete (a 500 does not
  prove it did not run). Keeping the table adds no error of its own: the rule's failure stays reported, and `ok` is false and the
  exit status a failure as before (so the solution is kept for the re-run too). What only the kept table's existence blocks is
  kept with it, not sent for the platform to refuse — each refusal used to be one more reported failure until the re-run: its
  icon web resource (`entities[].vectorIcon`/`icon`, matched in any letter case), a global choice one of its Choice or
  MultiChoice columns binds (the exact name the column gives, as the build binds it), and a relationship from the table to
  itself (the one relationship planned after the tables). Each is reported as `<step> (kept — …)` naming the table
  (`skip: 'kept'`), says that a re-run deletes it once the table goes, and is deleted by that re-run; an icon or a choice that a
  table the run deletes also uses stays while the kept table needs it, and a step that finds nothing in the environment still
  reads "not found". This is read from the spec alone (`planTeardown` marks such a step with `heldBy`): an icon set or a column
  bound by hand in the environment is not in the spec, so that delete is still sent — and refused — as before. A rule whose
  deactivation succeeded and whose delete failed stays deactivated until the re-run, which deletes the draft rule and its copy as
  it deletes any: teardown does not try to re-activate it, because a failed delete does not prove the rule is still there and
  a second write into a platform that has just failed one is not clearly safe. A dry run is unchanged. A failed
  **business process flow** keeps no table: its handler's notes say the platform removes the flow's
  activated copy with the flow, and nothing measured says a flow becomes undeletable once its table is gone.
  Command teardown
  removes the whole command bar for an entity the spec authored commands on (the SDK models a command bar
  per entity, not per button). Every id is resolved from a spec-declared name/logical/uniquename via an
  exact-match OData filter, so it can never wildcard-scan an org. **Dry-run by default** (`--apply`
  writes); dry-run lists every page candidate by id and stored name without writes, marking absent
  rows as "not found" with their manifest names only.
  Best-effort continue (a failed step is recorded, teardown proceeds). A not-found (already-gone)
  error is never a failure, the table delete's **not-found-on-success** is tolerated (`tolerateNotFound`),
  and system/managed artifacts that cannot be deleted are recorded as `skipped` rather than failing.
  A step reports `(not found)` — and the closing line counts it so — only where it knows nothing was there
  when it began (the handler's `absentOnNotFound`, or `foundNothing` for an answer): a default-view reset
  that finds no default view, a relationship the SDK's own lookup does not find (it sends no delete), a
  table its step's read did not list, and a global choice, whose delete is its step's only request. A
  teardown run again therefore reads `0 deleted, N not found` (it read every one of those `(1 deleted)`),
  and so does the relationship from a table to itself whose table this run deleted (it went with it). A
  not-found answer after a read that SAW the artifact — a table's, which is the not-found a re-sent metadata
  delete gets once its first send did the work, or a relationship's to its own delete — stays a deletion.
  The deletes sent are unchanged, and so is the exit status. One case can still mislabel: a global
  choice delete the client sent again (after a timeout or a gateway error) whose first send had removed it
  reads "not found", since the step makes no read that could tell.
  **A publisher is never deleted**, and no step plans one: the build reuses any publisher that carries the
  spec's prefix (`provisionSolution`) and other solutions may share the one it made, so a teardown cannot
  tell that this app alone uses it. Its closing summary says so in one line after the count, on a clean
  run and a failed one alike — `▸ the publisher with prefix '<prefix>' is kept: teardown never deletes a
  publisher, which other solutions may share — delete it in Power Apps (Solutions → Publishers) once nothing
  uses it` — so the row a maker finds left behind is expected (`teardown-model-app.test.js`, and the
  lifecycle matrix's teardown).
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
  generative page read through the SDK (its source, data sources, model, bindings and prompt, written into `pages/<id>/`), referenced entities/tables, icon web resources,
  dashboards, solution). It reads through a throwaway SDK workspace, never the folder's
  `.maker-workspace` — a copy an interrupted build left there made the download fail, or describe edits
  that were never saved to Dataverse — and writes only the baseline (`last-applied.json`) into it.
  **The navigation titles are read in the language a rebuild of the spec resolves, and only in a language the
  download knows**: `--language-code` (read as the build and verify read it), else the `languageCode` the spec
  already on disk pins, else the environment's base language (one read through the download's own client,
  `readNavigationLanguage`, before the SDK is made). The SDK projects a sitemap in the ONE language
  it is constructed with and reads a node's title as empty when it has none in that language, so an SDK
  built with no language (1033) wrote `"label": ""` for every area, group and entry of a Spanish-only
  environment. A label is a plain string, as a single-language table label is, and the language is never
  written into the spec: the flag decides what is read, not what is pinned, and a flag that names another
  language than the spec on disk pins is refused (`navigation-language-conflict`). When none of the three
  gives a language — the base language could not be read — the download stops before it writes anything
  (`navigation-language-unknown`; the spec and the baseline on disk are as they were) and says how to go on:
  run it again, pass `--language-code`, or pin `languageCode` in the spec. A `--language-code` that names another
  language than the environment's base language is read-time only, so the build and `verify-model-app.js` must be
  given the same flag — or the spec must pin it as `languageCode` — or a rebuild writes those titles as base-language
  titles. It does not fall back to 1033 as the
  build does: the spec it writes is rebuilt later, perhaps where the language can be read, and on a bilingual
  environment whose base language is not English the English titles of a guessed 1033 are non-empty labels,
  which that rebuild writes over the right ones. `--verify` makes the same choice. A title a node holds only in
  another language is not in the spec, and a rebuild into the same environment leaves it as it is (the rule
  for a title the spec does not state, under the sitemap above).
  The fetched SDK navigation must agree with the selected current XML's full target multiset:
  entities, generative pages, URLs, dashboards and custom pages, including repeated shortcuts.
  A missing SDK sitemap or a mismatch is refused with publish-then-download guidance, never emitted
  as hidden-table membership or lost Main restrictions. The immutable name is recovered from the
  fetched `uniqueName`/`uniquename` before manifest/prefix lookup; an unresolved identity is refused.
  **Round-trip scope (be precise — do not claim "complete"):** tables, sitemap/appShell, generative pages
  (with their data sources, model and connector and Custom API bindings),
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
  A view whose `<filter>` holds a `<link-entity>` (a condition on related rows, `link-type="any"`) is one more
  reason not to read a view through the SDK's typed `filters`: the SDK keeps the whole filter — the conditions
  beside the link-entity too — only in its own copy of the FetchXML, so the typed tree is empty for it. Nothing
  here reads it that way: the download carries no view and never reads a view's query, and a rebuild changes an
  existing view's columns and description only, the SDK writing the filter back whole (pinned by
  `view-related-rows-filter.test.js` and `rebuild-writes-real-bundle.test.js`).
  All four survive on the live app (a rebuild into the SAME environment preserves them), but are absent
  from the downloaded spec, so edit them in Maker or a fresh spec.
  **Portable schema is reconstructed, not only column types.** The download keeps Text format/length,
  Memo length, Integer range/format, Decimal/Double range/precision, Money range, Boolean labels, DateTime
  format, AutoNumber masks, and the primary name column's length/mask. Values equal to the SDK's
  create defaults are left implicit; explicit defaults cannot be distinguished from omission on a
  deployed column. Primary name lengths stay explicit even at 100, because the build's post-create
  correction runs only for an asked length on environments that override the create's value.
  Reads scale by the types present on each table, never by its column count:
  String, Memo, Integer, Decimal, Double and DateTime each need one conditional cast; Money detail
  rides its existing currency-twin read and Boolean labels ride the SDK projection. Money's
  `PrecisionSource` is classified there too: the SDK always creates source 2 (transaction currency).
  Only source 2 keeps numeric `Precision` metadata; its effective precision still depends on the
  transaction currency's decimal places, so equal numeric metadata is not cross-environment
  currency equivalence. Source 0 (column), source 1 (organization pricing), and missing/malformed/
  unknown sources are diagnosed; the typed column and range remain, but precision is omitted.
  Configure the required source in Power Apps on the target before relying on its behavior.
  Custom unmanaged status reasons in Active/Inactive states keep their values, labels and colors
  (stock reasons 1/2 are not re-declared; a stock table's reasons below the custom range are not
  portable). Their single label is selected only in the resolved download authoring language
  (flag, existing spec pin, then environment base), never the caller's UI language. A missing
  requested translation is named and that reason omitted, not substituted from another LCID.
  A read-time non-base-language flag must also be passed to the rebuild, or pinned in the spec.
  One Status cast per table supplies the state the SDK's flattened choices omit.
  Alternate keys, including names, columns and available display labels, ride the table-label read;
  solution/global-choice display names and dashboard tile spans ride existing reads too. A
  malformed or missing optional `Keys` array is diagnosed without losing the table, its primary
  name, typed columns or navigation.
  A table's `vectorIcon` is written only with a captured own-publisher, explicitly unmanaged SVG
  that has content. The resource is `external: true`: shared table metadata is not proof this app
  owns the file, so teardown of the downloaded spec must not delete it. Resource resolution may
  need one set-name lookup plus one read per distinct SVG; navigation/table overlaps are deduplicated.
  **Same-environment rebuilds do not re-send these schema writes when proven equal.** Scalar
  key identities ride the existing table probe. Status-label comparisons run only after all
  labelled schema creates (including deferred keys), so they cannot strip a later create's
  non-base-language labels. A halted attempt leaves its queued existing-table status reasons for
  the next successful attempt. A standalone Integer format is compared before its SDK update. Unknown
  proof keeps the existing duplicate-protected create/update path; a missing reason/key or a
  changed Integer format still writes. Table icons retain the SDK's assignment and specific-table
  publish even when the saved name matches: a failed publish can leave that same saved name behind.
  Existing status/key definitions are not rewritten on a
  name/value conflict, and ordinary column lengths/ranges remain create-only, as before.
  Missing, malformed or refused portable detail is named on stderr without dropping typed columns
  or inventing defaults. This is not full environment cloning: script resources, raster/foreign/
  managed table icons, `roleGrants[]`, `sampleData`, Boolean defaults, column capabilities and
  BigInt ranges are not reconstructed. Neither are unsupported status states or managed reasons;
  a non-primary AutoNumber's custom length/format and DateTime behavior are not authorable here.
  Dashboard tiles still bind source view/chart ids; moving them to another environment also needs
  those artifacts mapped, and removing a pinned source `dashboardId` when creating a new dashboard.
  **Form/view/chart omissions are reported, not silent** (AB#6686423): every deployed form/view/chart is listed in the
  spec's `descriptionInventory`, and each run prints a note naming the counts, the tables and the
  artifacts, plus a `notRoundTripped` block on the JSON result. It is a NOTE, never a gate — every app
  has forms and views, so failing the download would break every download, and the omission is not
  destructive in the environment the app came from. Do not "fix" this by reconstructing `forms[]`
  without also solving the lossy-layout problem above.
  **A page's connector and Custom API bindings are in the spec** (`pages[].connectorBindings`,
  `pages[].actionBindings`; the format and the rebuild rules are in `references/app-spec-schema.md` →
  `pages[]`). The page folder always held the raw lists in its `config.json`, but the spec carried only
  `dataSources` and `model`: a rebuild into the same environment kept a page's bindings only because it sent none
  (the SDK leaves a list a push omits as it is), and a copy of the spec rebuilt in another environment deployed
  the pages without them. `parseDownloadedPages` now writes a list a page holds into the spec **only WHOLE, and only
  what is known to be safe** (`lib/page-bindings.js`, whose header holds the threat model and lists every sink): each key
  one of the documented properties (`logicalName`, `connectorId`, `dataset`, `tables`, `tableDisplayNames`,
  `operations` for a connector binding; `name`, `isFunction`, `boundEntityLogicalName`, `displayName`, `parameterKinds`
  for a Custom API binding) and each value of a conservative shape positively known to be safe — an identifier, a GUID,
  a plain name or label, or an `http(s)` URL whose PARSED form (`new URL`) has no user-info, no query and no fragment and whose text is already that canonical form (a parser removes dot-segments before any check could see them, so the text that is persisted must be the text that is checked)
  and whose decoded path is labels — none of it shaped like a token (a known token prefix, an authorization scheme, a
  32+ run mixing letters and digits). **That is a security rule, not a tidiness one, and it fails closed**:
  `genpage-upload.js` writes any JSON array into a binding, so an entry can hold a connection id or a credential as a
  value, as a KEY, or inside a URL's user-info, query or fragment, encoded or not, and the spec is the artifact that is
  committed and shared. A list in which any entry holds anything else is left out of the spec **whole** — nothing is
  projected out of it, because an entry stated without its identity (or a property) would make a rebuild REPLACE the
  page's entry with less — and reported in `pageBindings.notCarried` (stderr `WARNING:`) by the page, the list, the
  entry's place and the vetted property, or "an unrecognized property": never a value, never an unrecognized key
  (`bindingProblemText`). A list left out is one a rebuild does not send, so the page keeps it: no write, no publish.
  The validator holds an authored spec to the same rule, as an ERROR in the same words, because refusing is the only
  thing that keeps a credential out of the file. The page folder's own `config.json` is the page as the environment
  holds it and is **not** rewritten, so it still holds everything — the `WARNING:` says so. A list that is no list of
  objects (`pageBindingsProblem`, also the validator's) is left out whole too. An empty list and `null` (the page's
  way of holding none) are nothing and are never written: a stated `[]` means "clear". Neither is a gate, as for a
  model the spec cannot hold. **A rebuild must not strip what a spec does not state** (an author's list, or a page that
  gained a property after its download), so the page backend reads a list a
  spec states against the page's own entries (`update` and `publishedDiffers` take `specBindings: true`, the build
  always passes it; `planEdits` → `mergeBindings`): an entry is matched by `logicalName` / `name`, the properties a
  spec can state come from the spec, and the others stay on the entry. A page that already holds what the spec
  states is therefore **not written and not published**, and an edit changes what it names and nothing else. Any
  other caller of the backend keeps replacing a list with the one it gives. The build sends a list a spec page
  states, and none it does not (`statedPageBindings`; the create that makes a page the others navigate to, and the
  create or update of the pages loop, both pass them) — an omitted list is the deployed page's own, a stated one,
  `[]` too, is the page's list. **The record of an earlier publish is recognised** (`lib/page-publish-records.js`):
  it is the hash of the content the build sent, and every record made before a download stated the lists is the
  hash of the content WITHOUT them (or without one of them, for a record made while the spec stated only the other).
  With `specBindings`, when the page already holds what the spec states and the caller's record is the hash of that
  content without one or both of the lists it states, `update` reads the PUBLISHED copy (read only) and, when it holds
  the lists too, answers `publish.kind: 'skipped'` with `receiptUpgraded: true`; the build then renews the record to
  the new hash with the versions it already holds (`rememberPublished`), so the next build reads nothing more. A
  copy that does not hold them, or cannot be read, publishes as it always did, and a page the spec changes is
  written and published whatever was recorded. Verify does not compare the lists, as it does not compare
  `dataSources` or `model`. `--changed-only` reads a change to a list as a structural change to the page, so it
  takes a full build. No `minimumPluginVersion` is set for them: an older plugin ignores the lists, which is what
  it always did, and a floor above the running version makes `validateAppSpec` refuse the spec. **A rebuild
  checks what the lists name before it writes anything** (`lib/page-binding-targets.js`, called from
  `checkPageBindingsBeforeWriting` next to the navigation check, and in a dry run's plan): it reads the
  environment's `connectionreference` rows and `customapi` rows for the names the pages it writes state —
  the pages a changed-only run selects and the navigation targets it may have to make — and **stops**
  (`BuildHalt`, phase `preflight`, code `pages-binding-reference-conflict`, never retried, nothing written) at a
  connection reference of that name whose connector is another than the binding's `connectorId` (compared by the
  connector's name, the last segment of its id). It never guesses and never makes a reference: the author gives the
  binding another logical name, or states the connector this environment has (a custom connector made separately in
  each environment has another id in each). It only SAYS, by name, a reference or Custom API that is not there (the
  page is written with its binding, and a reference made afterwards makes it work without a rebuild), a reference
  that is there with no connection (`connectionid` empty — what a solution import leaves when no settings file gives
  one), an operation a binding lists that the custom connector of its reference does not define, a Custom API that is
  the other kind or bound to another table (the runtime refuses that call itself), and a read that failed (the
  bindings were not checked); a connector that is not named on both sides is never a conflict. **Missing evidence is
  NOT CHECKED, never compatible**: a row that answers without its `connectorid`, its `connectionid`, or a GUID in
  `_customconnectorid_value` (absent, null or invalid) — or with a value of another shape: a `connectorid` that is not
  `/providers/Microsoft.PowerApps/apis/shared_<name>` (`referenceConnectorKey` checks the syntax before anything is
  compared), a `connectionid` that is not a text or null — is said by name as not checked (`unchecked`, a warning): the
  connector is not compared, the connection not judged, the operations not proven, and nothing is refused for it. The
  conflict halt needs two VALID connector ids that differ.
  Operations are read only for a CUSTOM connector: its definition is a row of the
  environment (`connector.openapidefinition`, found through the reference's `_customconnectorid_value`, parsed by
  `definedOperations` as Swagger 2.0 — every HTTP method's `operationId`, matched exactly, as the SDK matches them;
  a definition it cannot read leaves the operations unchecked, and says so), and the copy there can be another
  version than the page was made with. A reference whose row names no custom connector gets no definition read, and
  its binding's operations are said as not checked: a null lookup is what a connector the platform publishes has, but
  it is no proof of one (a reference made through the Web API can leave it unset).
  **What a rebuild cannot bring to another environment is what the lists name,
  and the download says so**: when any page holds a binding it prints `NOTE:` on stderr and returns
  `pageBindings` — `pages` (each page's key, name and the connection references / Custom APIs its bindings go by),
  `neededInTarget` (`connectionReferences`, `customApis`, and `serviceResources`: the references whose bindings
  name a `dataset` or `tables`, which are the source environment's), `notCarried` and a
  `note` — in the order the spec lists its pages, names sorted by `compareText`; the block is absent when no page
  holds one and nothing was left out. The connection reference and the connection behind it (a user's sign-in, which
  stays where it was made), the Custom API (a solution component) and the resources a connector binding points at
  are not App Spec items; the `NOTE:` names the scripts that make each one there. The `custom-api` feature flag
  gates what the `/genpage` agents author, not this: a download and a rebuild carry the bindings a page already
  holds. `page-binding-contract.test.js` pins the allowlist, the projection and the merge,
  `page-binding-targets.test.js` the reads and the judgement of the environment, `page-bindings.test.js` the
  download, the validator, the build's write sites and its check of the environment, and
  `page-bindings-real-bundle.test.js` what the real SDK does with the lists: a page read with them, a rebuild
  that writes no row, a changed list that keeps what the spec could not state, a create in another environment, and
  the record of an older publish (the build-level version, with the real pages phase, is in
  `sdk-build-pages-deploy.test.js`).
  **A download is written in a fixed order, so two downloads of one app match byte for byte** and a diff
  between them shows only what changed. Dataverse promises no row order for a query without `$orderby`,
  and a directory listing is in the file system's order (name order on NTFS, hash order on ext4), so
  nothing is written in the order it arrived: `pages[]` (and the page folders' reports) by page name, then
  id — the name first, because ids differ between environments; the id only splits two pages that share a
  name; `descriptionInventory`'s classes by table, then name, then id (global choices by name); the tables
  the app holds beyond its navigation by name, after the navigation's own tables (which keep the navigation's
  order); `notRoundTripped.appMembership` by kind, table, id, name and reason; the names in
  `app.mainForms[table]` and in the note about a Main form that cannot be named. Every one of those sorts
  through `compareText` (`lib/compare-text.js`) — UTF-16 code units after lower-casing — and never
  `localeCompare`, whose order follows the host's ICU locale and version, so the order is a function of the
  strings alone (`download-order.test.js` serves one app in three orders and compares the bytes).
  **A page's key never depends on that order.** The key is the page's identity in a rebuild: a spec deployed
  to another environment holds no page ids, so that environment binds each key to the page it built (its
  page manifest), and a key that moved between two downloads of an unchanged app makes the next deployment
  swap what two pages hold there — the build succeeds and the verifier passes, since both pages still
  exist. A page's key therefore comes from, in this order: the app's page manifest (`key → id`, the
  authority); the key an earlier download of the **same app** gave the page, read from the `app-spec.json`
  already in `--out` and matched by the page's **id** (`readPreviousPageKeys` — so an edit session downloads
  into the same working folder every time); and only for a page with neither, a fresh slug of
  its name, minted after every key above is taken and **in the order of the page ids** (`comparePageIds`),
  not of the names: two names that make one slug (`Work_Order`, `Work Order`) give the plain slug to the
  lower id and `-2` to the other — the order earlier releases minted in on a file system that lists names in
  order (NTFS, HFS+), so a spec they wrote keeps its keys. A key the manifest took from the earlier
  download's is reported on stderr with both keys.
  **A file in `--out` is the same app's history only when it says so.** A page id does not say which app a
  key belongs to — a page can be in several apps, each with its own page manifest and keys — so the file is
  read only when `app.uniqueName` is a text equal to the downloaded app's unique name (without case, as Dataverse
  compares them; read as the build reads an app's identity, `appUniqueName`). A gap is never a wildcard: a spec
  of another app is skipped silently, and one that names none (an authored spec derives its identity from its
  publisher prefix and name and writes none; a hand edit can leave a null, a blank or a number) is skipped and
  said on stderr, naming the file, when it held keys that could have been used. A file that cannot be read is
  said too.
  **Keys that cannot be told apart are never minted afresh behind the maker's back.** When the earlier spec
  gives one key to two pages, or one page two keys, and the page manifest does not bind the page, a deployed copy
  of that spec could be built with either key, and fresh keys would exchange what two pages hold there. The
  download then stops before it reads a page or writes anything — the file, which is the only record of those
  keys, and the page folders are as they were — with `{ ok: false, code: 'page-keys-ambiguous', error, pages,
  conflicts }`; the error names each page with its id and each key, and the two ways on: correct the file and
  download again, or `--reset-page-keys`, which gives exactly those pages fresh keys (page-id order, said on
  stderr) and leaves every other page's key alone. Only the rows of pages the app still has count — a row of a page
  that is gone neither voids a clear key nor makes a conflict — and a page the manifest binds is never part of it:
  the manifest is the authority. The switch is the maker's decision about every environment that holds a copy of
  the earlier spec (a skill never passes it unasked). `download-page-keys.test.js` pins each rule and
  `download-rebuild-teardown.test.js` the redeploy of a copy to another environment after a re-download.
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
  dashboard whose tiles cannot be reconstructed is dropped and surfaced in `droppedSubareas`. A tile
  that a custom control hosts (the Power Apps grid, say) is one of those that cannot: the SDK reads it as
  a list or chart with the parameters of a native tile and tells it apart only by its control class, so
  `readDashboards` leaves it out and names it (`hostsCustomControl`, in `lib/dashboard-tiles.js`, which verify
  asks too) — never emitting the plain tile that would replace the control wherever a rebuild creates the
  dashboard (a rebuild into the same environment reuses the pinned dashboard as it is).
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
  builds. It validates the spec first under the `deploy` profile, with two compatibility downgrades
  (`relationshipCollisions: 'warn'` and `columnValues: 'warn'`): a spec an earlier release accepted and built — a 1:N and an N:N
  that share a schema name, an AutoNumber column with no format, a `required` that is not `true`, `false` or `"recommended"` — is
  verified, with a warning that names the fix, and is never refused before anything is read (the build, the lint and the
  provisioning gate keep these as errors). **Every `WARNING:` line it prints on stderr — those findings, the spec's other warnings, and a page
  workspace it could not remove — is also in the result JSON's optional `warnings` array** (the same messages, without the prefix, in the order
  printed; left out when there is none, as `unverified` is), so a caller that reads only the JSON loses none of them. It is there on a failed
  verification and on a refused spec (`{ ok: false, errors, warnings }`, whose warnings are printed too) as on a passed one, and changes neither
  `ok` nor the exit status; a run that stops on an unexpected error prints that error on stderr and no JSON, as ever. **The result JSON is pure ASCII**
  (`emitResult`'s `{ ascii: true }`): every character above U+007E — the em dash of a warning, a Spanish label or a Japanese form name in a
  message — is a `\uXXXX` escape that any JSON parser reads back as the original text, because Windows PowerShell 5.1 decodes a child's stdout
  with the OEM code page and garbles a raw one; stderr is for people and is not escaped (`verify-model-app.test.js` pins both on the process, for a
  refused spec and, over `tests/helpers/fake-verify-preload.js`, for a completed verification). It works through a throwaway SDK workspace, never the folder's `.maker-workspace` (which belongs to
  the environment it was first opened for): every read it makes goes to the server, so it verifies any
  environment the app is deployed to and creates or binds nothing in the folder. It only READS the build's
  baseline, `last-applied.json`, from `--workspace`, and only when that baseline describes this
  environment. Checks **existence** (entities/columns/views/charts/forms + sitemap subareas + icons + pages by
  id) AND, best-effort, **content** so an *unapplied edit* is caught (not just a missing artifact): a
  view's **column set** (parsed from `layoutxml`; every spec column must be deployed — an extra deployed
  column passes by design, so a column REMOVED from the spec, which the additive `reconcileView` leaves
  in place, is not flagged), plus **relationship** and **command-bar existence** (previously unchecked).
  A relationship is verified by its **identity**, not its name: the answer has to state its schema name, its
  type, both its tables and, for a 1:N, its lookup column — for an N:N, its intersect table and the column each
  table has in it — and all of them have to match (`compareRelationship`, `lib/relationship-metadata.js`; an N:N's
  intersect table has to equal the spec's `intersectEntityName` when the spec names one, and any table the
  answer states will do when it names none). An answer that leaves a part out — a row without its
  lookup, an N:N row without its intersect table, an exact read that answers an empty body — does not pass: the
  check fails and says what the answer lacked. It is not listed `unverified`, which leaves `ok` and the exit
  status as they were; a relationship nobody identified must not read as a pass. (A reader that lists plain
  names, as older test doubles do, stays a name-only reader; the plugin's own reader never does.)
  **Status reasons and alternate keys** are checked too, each declared one by its name (`lib/status-reasons-keys.js`):
  `status-reason <table>.<label>` passes when one of the table's status reasons carries the label (in any language the spec
  writes it in) under the state the build gives it — Active unless the spec says Inactive — and at the `value` the spec pins,
  when it pins one. The deployed option must carry a readable integer state: a missing, null or malformed state fails with
  an explicit unreadable-state detail, never a guessed match. `alternate-key <table>.<schemaName>` passes when the table has a key of that name over exactly the
  declared columns, in any order (live, a key read back answers its columns in an order of its own). One that is there but
  different says how (the other state, another value, other columns), and a missing one says when the value the build gives
  it is another label's — a rebuild inserts the reason at that value again, which the platform refuses as already there, so a
  reason renamed in the environment stays renamed — or when a key of another name is over the same columns. The state and
  value are the build's own (`statusReasonTargets`, `lib/entity-provision.js`), so verify cannot hold a reason to anything the
  build did not write. Each is ONE narrow read on the SDK's client — the Status attribute's cast read (the one the view filter's
  label resolution makes for the column, `optionCastUrl`) and `EntityDefinitions(…)/Keys?$select=LogicalName,SchemaName,KeyAttributes`
  — made only for a table that declares any: a spec that declares neither sends no request for them
  (`lifecycle-scenarios-real-bundle.test.js` pins the difference to exactly those two reads). A key's index status is not read:
  right after its create a key is `Pending` (live-measured), and a key of the declared name over the declared columns is the
  key the spec declares. A read that fails is a failed check with its reason, never a pass.
  Content checks are additive + reader-gated (they only fire when the reader supplies `layoutxml` /
  `entityRelationships` / `commandBar` / `statusReasons` / `alternateKeys`), so existence-only callers are unaffected. A view filter's
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
  a same-named dashboard of another app sorted first and failed a correctly wired nav entry. When the reader supplies `dashboardComponents`, every native chart tile's
  visualization and view must belong to the tile's `TargetEntityType` — the cross-wiring a same-named
  chart on another table produced. A tile whose owner rows cannot be read is reported unverified, not
  passed. Only a NATIVE chart tile is held to that: the Assistant, an iframe, a web resource and any custom
  control are skipped, a chart a custom control hosts among them. The SDK types such a chart `chart` as it does
  a native one, but the spec cannot describe it and the build never writes it, so the chart and view it carries
  are not the spec's to judge — holding it to them failed a dashboard the build had left untouched. It is
  skipped, as before, and not listed `unverified` (that is for a check verify sets out to make); the
  classification is the download's (`lib/dashboard-tiles.js`; `verify-dashboard-custom-control.test.js` runs
  it on the real bundle). The tiles are the PUBLISHED dashboard's: the SDK reads them from the saved layer, and the reader
  takes them only when that layer's FormXML is the published row's, before and after the read, with the
  same `@odata.etag` in between — a dashboard with changes that are not published is unverified. The two
  FormXML reads are compared in the languages the published read carries (`lib/formxml-layers.js`): live,
  in an organization with a second language provisioned, the saved read held a caption in that language in
  every cell and the published read the base language alone, so a dashboard nothing had changed since its
  publish was "not published", and every job whose surface it is failed with it. A caption in a language
  the published read carries none of is set aside; a tile, a cell, an attribute, any text, a caption in a
  language it carries, and a FormXML that is not one well-formed XML document are still changes, and two
  equal texts are the same dashboard as before. That is the read of a user whose own language is the
  base one. For a user whose own language is the other one, live, the published read carried both
  languages, that user's own first, and one cell's caption in that language was worded another way than the
  saved read's, on a dashboard nothing had written since its publish — a read is the platform's projection
  for its reader, and no text says which of two captions is the caption. The platform's own token does: the
  published row (`queryRecords` answers its `@odata.etag` beside the FormXML) and the saved read answer the
  same `@odata.etag` until the saved layer is written (live-measured: a write moves the saved read's token
  and not the row's, even a write that puts the content back; a publish moves both to one new token). When
  the two answer the same token and the published read carries more than one language (the base-language
  user's never does), the saved layer IS the published row, and the reads are compared in everything but
  their captions: a tile, a cell, an element, an attribute and any other text still differ. With another
  token, none, or a published read of one language, the texts decide as above. So that user's published
  dashboard is verified, one with a change saved and not published (a new token) is not, and the
  base-language user's result is as it was. It fails closed where the token cannot say: a row that answers
  none, or a dashboard saved after its publish and put back, is unverified until it is published. **App
  membership is checked on the published layer:** sitemap tables union `app.tables`
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
  nothing. This is the "convergence" mitigation: the build is additive (edits to existing artifacts
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
  job with no covering surface, no generative pages, a new table no persona and no `roleGrants[]`
  entry grants a privilege on) so the orchestrator surfaces them in chat. A `roleGrants[]` entry the
  build refuses because it does not name exactly one role — `role` and `roleId` both, neither, or one
  of them malformed — is named there and in the document in lint's own words: one check decides it
  (`roleGrantIdentityErrors`, `lib/app-spec.js`), which `validateRoleGrants` reports (the gate a build
  and `lint-app-spec.js` run) and the document reads through `roleGrantRefusals` (`lib/app-access.js`).
  The document shows such an entry as that refusal, never as rows of privileges the build would add,
  and does not match it against the roles the app has. Its Security section keeps
  two questions apart — who can open the APP (the roles associated with it) and who can use the
  TABLES the spec introduces (privileges) — and never calls the app administrator-only on the
  strength of a spec with no personas alone: that is a claim about the deployed app. With `--env` it
  reads, read-only, the roles the app has associated with it (`lib/app-roles.js`: the SDK's
  saved-layer app lookup — which finds an app that was saved and never published, so a draft is not
  reported as one that does not exist — then the association rows,
  `appmodules(<id>)/appmoduleroles_association`, through `collectionRows`, the plugin's one reader of
  a paged collection) and lists them. A persona's role counts as associated with the app unless the
  persona opts out (`appAccess: false`): a build removes that association, so the document says so
  rather than listing the role as one the app will have. A `roleGrants[]` entry that gives `roleId`
  is matched to the role of that id, and is certain; an entry that names only a role, and a persona,
  are matched by name only, as "may be", with every role of that name listed — role names repeat
  across business units, so a name alone is never certain. The administrator-only conclusion is
  drawn only from that read — an app the environment has with no role, or one it does not have yet
  that the spec gives none. A read that fails or answers something that is no list of roles (a
  refusal, a 404 for a draft's roles, a row that names no role) is reported in the document and in
  `warnings` as "not checked", never as "no roles"; it never fails the command.
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
- **A relationship is reused only when the environment states its whole identity.** The build skips the create
  of a relationship that is already there — and a dry run marks it `= reuse` — only when the answer states its
  schema name, its type, both its tables and, for a 1:N, its lookup column, for an N:N its intersect table and the
  column each table has in it, and each equals what the spec declares
  (`compareRelationship` in `lib/relationship-metadata.js`, used by `relationshipExists` and the data-model
  phase). A part the answer leaves out — a collection row without its lookup, an N:N row without its intersect
  table, a typed read that answers `{}` — is not "nothing contradicts": the relationship is unproven, and a name
  is the one thing another relationship can share (a 1:N and an N:N between the same tables derive the same one;
  an N:N made elsewhere under the same name and tables can sit on another intersect table). The probe then answers "could not
  tell" (`? unknown` in a dry run), the create is tried, collides on the name, and the build reads the
  relationship itself: it is reused when that read states everything and matches, and when that read is
  incomplete too the build halts — final, since a run again reads the same answer — and leaves the relationship
  as it is. A complete answer for another relationship halts as it always did (`relationship-name-taken`). An N:N's
  intersect table is held to the spec's `intersectEntityName` only when the spec names one (the SDK creates it
  under that name, or under the lower-cased schema name when none is given); a spec that names none is held to
  none, because a download never writes one and a relationship adopted with `existing: true` has the intersect
  table its maker chose — the answer still has to state it. The SDK's own relationship projection
  (`fetchEntityMetadata`) lists an N:N without its intersect table, so it never proves one.
- **Bounded parallelism in the read-heavy and publish-heavy paths.** Each item below has tests that count
  requests and prove the overlap (`verify-parallel-checks`, `verify-page-code-batch`,
  `download-parallel-reads`, `teardown-publish-once`, `table-columns-in-create`, and the check-auth tests),
  and each keeps a one-at-a-time form (`concurrency: 1`, `inlineColumns: false`) that is the oracle its
  output is compared with byte for byte. Every fan-out is
  `mapLimit` (`lib/entity-provision.js`; its `firstInOrder` option makes the thrown error the
  lowest-numbered task's, deterministically), never an unbounded `Promise.all`, and each request still
  retries its own 429s (`lib/sdk-http-client.js`, inside the run's throttle budget when it has one) — so a throttled environment slows the pass down rather
  than being hit by a burst.
  - **Verify** (`lib/verify-spec.js`) runs its checks as ordered tasks on a pool of 4
    (`verifySpec(spec, read, { concurrency })`). Each task reports into its own buffer and the report is
    the buffers joined in listing order, so it is the same whichever read answers first; a failure stops
    anything new from starting and the failure first in report order is the one thrown. A failed pass does
    not wait for the page checks' early reads (a hung read would turn a fast failure into a hang): the
    early read and the check that consumes it both stop waiting once a check listed BEFORE the page check has
    failed. A failure in a check listed after it does not end the wait — the page check's own failure is the
    lower-numbered one and must be the one thrown, as when the checks ran one at a time. A read the pass gave
    up on is not waited for: `verifySpec` calls the reader's `endPageReads()`, which marks the page reads
    as no longer wanted (none starts until the next pass begins) and asks the page backend to close and remove
    the workspace they were writing into (`discardWorkspaces`, waited for up to 10 s, never throwing): a read
    in flight is a request and cannot be cancelled, but it can no longer write — its next storage call is
    refused — so a verify command that exits right after has left no folder of page sources in the temp
    directory. If that wait runs out, the cleanup it started goes on, and the verify CLI's final
    `dispose()` joins it: `dispose()` (and `discardWorkspaces()`) answers `{ left }`, the folders still on
    disk, only once every workspace the backend made has been dealt with — or, at the bound the CLI gives it
    (the same 10 s), names the ones still draining and prints a warning, so it never reports done while page
    source is on disk. The pages are read through a backend of their own (a
    throwaway workspace that the build and the verify CLI remove as soon as the pass ends, never the
    folder's `.maker-workspace`; the verify CLI gives it its own rather than lend the run's SDK, because only a
    workspace the backend made is one it can close). Reads that several
    checks share are single-flight: the root business unit (`resolveRoleBusinessUnit` caches the *lookup*
    in flight — caching only its answer made every concurrent caller but the first report its role
    missing), a table's and a role's privileges, the sitemap, the resolved Main forms. The reader sends the
    first read of each table alone, so the SDK resolves its `EntitySetName` once instead of once per
    overlapping read. The page checks' slow reads (the page listing, the manifest) start with the pass,
    and the code of every page whose navigation is checked comes from `readerFor().pageCodes`: each page is
    read through the SDK (`genpage.read`), four at a time (`PAGE_READ_CONCURRENCY`), and answered as `{ code }` or
    `{ error }` from its own read. A page that cannot be read — an unreadable row, or one the SDK holds as raw
    files, with no source to check — is that page's failed check, never a page with no code, and one bad page
    costs its own miss, never its neighbours'.
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
    that says the table was throttled rather than that the request failed. A refusal the run's throttle budget made — it had no room for the wait the 429 asked for, and the client handed the answer back and told
    the budget (`lib/throttle-budget.js`) — is not that fallback: the service asked the run to hold back, so the columns are NOT created one by one, no request of a column's own is sent, and the phase stops with
    the budget's halt (`throttle-budget-exhausted`; `createColumnsInOneRequest`'s `stop`, which is the runner's `stopIfRefused`). The columns are not put in
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
    calls `updateColumn` only when it differs — at the end of the data-model phase, once every table, column, new table's status reason,
    relationship and alternate key that needs no length has been created, and in the halt path too, so that a phase that
    halts after creating a table still sets that table's length (a run in a new process finds the table and leaves an
    existing table's name column alone; a length that cannot be set while the phase is halting is warned about as one such
    a run will not set either).
    There, because `updateColumn` starts by reading the column WITH its labels, and a label-bearing metadata read ahead of
    a labelled create is what strips non-base languages (measured; see `findExistingColumns`): within one attempt, nothing
    labelled in more than one language is created after it, except one kind of alternate key over the name column (below): the
    key labelled in several languages that cannot fit beside the name column before the step, which is made after it because it
    cannot be made before. (A key with one label, which is also made after it, has nothing for a read to strip.) The build's
    automatic retry of a transient halt (a 429, a lock) runs the phase again as a second attempt. The attempt that created the table sets its length in the halt path
    too; when that step fails as well (the lock that stopped the phase can still be held), the table is **owed** its
    length. `provisionDataModel` records it (`owedLengths`, a Map of `{ table, column, asked, tried, tableId, columnId? }`,
    which `runSdkBuild` hands to the phase and puts on the halt it throws, the way it carries the publishes an attempt owes
    for the views it saved), the CLI hands the record to the next attempt and keeps what each halt carries (everything
    still owed — an empty list when the attempt paid it), and the retry, which finds the table, sets the length at the
    end of its own phase instead of keeping the table as it finds it: `primary column length … -> N (owed by the attempt
    that created the table)`, or `(already N; owed by …)`. An attempt that did set the length leaves nothing owed, and
    the retry keeps the table as before.
    **A debt is paid to the table it was recorded for, and to no other.** The build pauses between attempts (at least
    three seconds), and another maker can delete the table and make it again in that time: the same logical names then
    answer for a table this build did not create, whose name column a rebuild must not shorten (it may hold data). So
    the record keeps the `MetadataId` the create answered (`tableId`) and, when the attempt read the column before its
    step failed, the column's (`columnId`, which the same typed read answers, so it costs nothing), and every way a debt
    is paid — the retry, a phase that halts before it reaches the table, the settle of a build that stops for good —
    first checks it (`checkOwedTable`, `lib/entity-provision.js`): one read by name,
    `EntityDefinitions(LogicalName='…')?$select=MetadataId,PrimaryNameAttribute`, made **only for a debt an earlier
    attempt carried** (the attempt that created the table asks nothing, and a first build, a no-op rebuild and an
    attempt that owes nothing send exactly the requests they always did), which must answer the recorded id and the
    recorded primary name column. The read of the column's length that follows answers the column's own id, which must be the
    recorded one (an answer that names another, or none, is refused too). The debt is also paid
    only as recorded: the spec must still ask that column that length. Otherwise — another table answers now, no table
    does, the primary column is another, the record holds no id to prove anything by, or the spec asks something else —
    nothing is written and the step is a skip (`(not the table the build created — kept)`, `(the table the build
    created is gone — kept)`, `(not the name column the build created — kept)`, `(nothing shows which table the build
    created — kept)`, `(no longer what the spec asks — kept)`) with a warning, the debt is dropped, and a key that waited
    for the length is made as the key on any table the build found is (the platform decides). A read that fails is a
    failed step with nothing written, which the build retries when it is transient.
    **The check is not what protects the column; the addressing is.** A check followed by an update that resolves the table
    or the column by name again only moves the window — another maker can replace the table in the few requests between the
    two, and the update would find the replacement — which is what the SDK's `updateColumn` does (a read of
    `Attributes(LogicalName='…')`, whose answer's id the two requests that follow use). So a debt is **not** paid through
    `updateColumn`: every request that follows the check is addressed by the recorded ids —
    `EntityDefinitions(<table id>)/Attributes(<column id>)`, for the typed read of the length, the read of the column's
    definition and the update, which `updateTextColumnLengthById` makes as the documented PUT of the whole definition (the
    answer's `@odata.*` members dropped, `@odata.type` set, `MaxLength` changed, `MSCRM.MergeLabels: true`, through
    the SDK's own client so a header-ful SDK adds the solution header, and inside the SDK's `schemaWrite`, which is what
    forgets the metadata the SDK cached for the table after a write of its own). Where the debt records no column id, the column
    is found by name inside the table the id names, and the update is addressed by the id that read answers. A table made
    again has other ids, and an id that no table has any more answers 404, so a replacement cannot be the target of any of
    these requests, wherever in the payment it is made: a 404 from any of them leaves the column as it is, with the same
    warning (`(the table the build created changed — kept)`) and the debt dropped. Nothing is resolved by name once the table
    is proved, except the one read that asks which table answers to the name.
    **A refusal of the run's throttle budget does not drop what the build owes.** Once the budget has refused to wait for a
    throttled request, the engine's runner starts no more steps of the phase (`makeRunner`; see the throttle budget above) —
    but the length step is not one of them (`settling`): no later run can set the length, since a run that finds the table
    leaves its name column alone, so every table the run owes one is paid in the pass that completes the phase as it is
    after a halt, and the refusal of one table's update does not keep the next table's from being set. A key over the name
    column is a step of the phase, so it is not made in that run: the build stops with `throttle-budget-exhausted`, the table
    has the length it was given, and the next run, which finds the table, makes the key. A step the runner stopped before it
    began is never taken for a length that was set: `alignPrimaryNameLength` answers `notStarted` (the stop as its error,
    nothing sent), the debt stays in `owedLengths` and is not marked `tried`, so the settlement a build that stops for good
    makes pays it, and a key waiting for it is not asked for (`runBestEffort`'s `onFailure` is how the step learns it;
    `throttle-engine-stop.test.js` and `table-columns-in-create.test.js` pin it).
    When no retry follows, the CLI makes one last try at a length that no attempt got as far as setting
    (the last one halted before its data-model phase; `settleOwedLengths`, silent unless it fails), as it settles owed
    publishes; a process killed outright, or a later run, finds the table and leaves its name column alone. What the retry
    creates comes after the read of the attempt that set the length, and the loss was measured only for a create straight
    after the read, so whether it reaches across the pause between two attempts is not known
    (`table-columns-in-create.test.js` pins what each attempt does). That is one narrated `primary column length` step,
    planned (after the relationships) and counted
    only when the spec gives a length (`planFor`, and the provision-entities plan and total): `ok … -> N` when it set the
    length, or a skip — `(already N)`, `(table exists — kept)` or `(table found after its create — kept at N, asked M)` —
    or a FAILED step naming the table, the length asked and the length the platform made (for a read as well as an
    update), with a warning, that never stops the build unless an alternate key is waiting for it (below). The warning
    says what follows from that: "the rest of the build continues" where nothing waits for the length, "the build stops
    at alt key …" where a key does, and, where the phase had stopped first, the halted wording plus the key that needed
    the length. There is no
    read for the default: a spec without a length
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
  - **Primary name column requirement level.** A `required` on `primaryAttribute` (`true` → `ApplicationRequired`, `"recommended"`
    → `Recommended`, `false` → `None`; an omitted one asks nothing) is sent in the table's create as the SDK's
    `createTable({ primaryColumnRequired })`. MEASURED on Dataverse 9.2.26101: an auto-numbered name column keeps the level the
    create sends, but a plain text one is stored not required whatever is sent (the same environment makes it 850 characters long),
    and a later update sets it. So for a level other than `None` the SDK reads the column's level back, sets it with one update
    where it differs, reads it again, and answers the level it read as `primaryColumnRequired` — or refuses with
    `PRIMARY_COLUMN_REQUIRED_NOT_APPLIED`, whose message says the table WAS created. The update is a PUT, so the HTTP client must
    implement `put()` (`lib/sdk-http-client.js` does; a client without one is refused before the table is made, for a plain text
    name column). `provisionDataModel` reports `required <table>.<column> (applied on create)` only for a table whose create it saw
    succeed, and then only for `None` (the create asked it, and the SDK has nothing to read back for it) or for a level the SDK
    answered. Anything else is a failed best-effort step, `required <table>.<column> -> <level>`, with a warning: an SDK that
    answers none or another level, a table found after the answer to its create was lost, or an existing table whose columns could
    not be read — where nothing shows what the name column holds, so an explicit `required: false` is no exception. The build goes
    on, writes nothing for it, and a re-run sets the level the way it does for any existing column. On `PRIMARY_COLUMN_REQUIRED_NOT_APPLIED` the
    build stops, as it does on `TABLE_METADATA_NOT_VISIBLE` (`createNewTable`): the table exists, so a warning says to run the build
    again — it finds the table, does not create it again, and sets the level through the existing-column path (the halt names the
    same step, `operatorRemedy`) — and, for a length asked of a plain text name column, that the length may not have been applied
    either. The SDK's code is never read as an already-exists answer, whatever its cause carries (a 409, the word "duplicate" in the
    platform's reason). A reused table's name column keeps the rule of every existing column: an explicit `required` converges on a
    rebuild, an omitted one is never read as `None`. Pinned by `entity-provision.test.js` (the stand-ins) and
    `table-columns-in-create.test.js` (the real bundle over a stub that stores a plain text name column's level as `None`).
  - **An AutoNumber column needs a format.** The SDK refuses to create an `autonumber` column without an `autoNumberFormat` — an
    `InvalidArgumentError` before any request, for `createColumn` and `createColumns` alike — where the SDK it replaced created a plain
    text column (an autonumber column is a text column that carries a format,
    [Autonumber columns](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/autonumber-fields)). So `autoNumberFormatProblem`
    (`lib/app-spec.js`) refuses a column of type `AutoNumber` whose format is missing, blank or not a string, in `validateAppSpec` AND in the
    provision-entities input gate that `/genpage` and `/app-builder` pass through (`lib/provision-input.js`), before anything is written; the
    message names the table and the column and both ways out (a format such as `"C-{SEQNUM:5}"`, or `type: "Text"`, which is also what a
    column an earlier release made from such a spec is). The structural profile — the one teardown validates under — does not apply it, and
    read-only verification (`verify-model-app.js`) gets a warning in place of the error, as it does for a relationship-name collision
    (`columnValues: 'warn'`): a spec an earlier release built must still tear down and still be verified, and verification creates and
    updates nothing — it only reads whether each column exists. Every other path (the build, the plan, the lint, the provision-entities gate)
    keeps the error; `column-rules-authoring-gates.test.js` pins that and `verify-model-app.test.js` runs the CLI over older specs. Measured against the real bundle
    (`table-columns-in-create.test.js`): a spec that got past the gate halts the data-model phase at that column, after the table is made; a
    REBUILD that finds the column already there never reaches the refusal (`columnOptions` runs only for a column the build creates, and the
    updates the build makes to an existing column carry no format). The primary name column keeps its meaning: an absent or blank
    `primaryAttribute.autoNumberFormat` is a plain text name column, as before. A format with no `{SEQNUM}` token stays the lint's warning.
    Pinned by `column-autonumber-gate.test.js`.
  - **A column's `required` is `true`, `false` or `"recommended"`.** The build reads exactly those (`REQUIRED`, `lib/entity-provision.js`: `true` →
    `ApplicationRequired`, `"recommended"` → `Recommended`, `false` → `None`) and read every other value as `None`, and a bare own-property test took
    any present key for an explicit one — so `"ApplicationRequired"`, `"true"`, `"required"`, `"Recommended"`, `1` or `null` created a new column not
    required and, on an existing column, wrote `None` where the level differed, demoting a column a maker had made Business Required. So
    `requiredValueProblem` (`lib/app-spec.js`) refuses them, on a column and on `primaryAttribute`, in `validateAppSpec` AND in the provision-entities
    input gate (`lib/provision-input.js`): the message names the table, the column and the value, says what to write for the usual slips
    (`"ApplicationRequired"`, `"true"`, `"required"` → `true`; `"Recommended"` → `"recommended"`) and that omitting the key leaves an existing column
    as it is. Neither the structural profile (teardown's) nor verification (a warning) holds a spec to it, for the reason given for the AutoNumber format. `undefined` states nothing, here and
    in the build (`hasExplicitRequired`), so a spec built in code with `required: undefined` is not an explicit `None` that demotes an existing column.
    The other `required`s are untouched: a business process flow step's (a boolean, gated where the flow is), a business rule's `SetBusinessRequired`
    action's, a form field's. What reads a column's `required` takes exactly the accepted set: the build, the form fields and the schema facts (`true`
    only: a recommended column is not a Business Required field) and the plan document (`required`, `recommended`). A downloaded spec carries no
    `required` at all (`download-model-app.js` reads no `RequiredLevel`), so it passes whatever the live columns hold.
    Pinned by `column-required-gate.test.js`.
  - **Alternate keys over the name column.** The platform validates a key when it is created, and the size it holds is bounded: the
    platform's own answer to a key that is too large names the limit (HTTP 400, code `0x80060895`, "Index size exceeded the size limit of
    1700 bytes. The key is too large. Try removing some columns or making the strings in string columns shorter."), 2 bytes for each
    character of a text column ([Dataverse alternate keys](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/define-alternate-keys-entity#create-alternate-keys)
    documents 900; 1,700 is what the environment this was measured on enforced, so the build uses the number only to know that a key
    cannot fit — `KEY_BYTES_LIMIT`, `lib/app-spec.js` — and the platform does the refusing). The 850 characters an environment may make of a
    new name column are 1,700 bytes by themselves: measured, a key over that column **alone** is accepted, and one that holds **any other
    column** beside it is refused (a column of one character, of a hundred). A key that holds a table's primary
    name column, when the spec gives that column a length and the key's label **goes out in one language**
    (`keyWaitsForNameLength`, `lib/app-spec.js`), is made after the length steps and not with its
    table, for a table whose length is still to be set: one this attempt created, or one an earlier attempt left owed.
    What counts is what is sent — not the shape of the value, and not the language the build is authored in: the SDK writes
    a string as one `LocalizedLabels` entry in the build's language, and a language map as one entry per language it names,
    so a string and a map that names one language are the same request, byte for byte, whichever language that is (a
    `{ "1033": … }` map under `languageCode: 3082` is the request it is under 1033). The same request is the same label under
    every authoring language, so where its key is made cannot depend on it — which also means the dry run, which cannot always
    know the build's language, and the apply cannot disagree about it. Such a key is made only when the length step
    came out right (`ok`, or `already N`). When it did not, the key is not sent: its own step fails with
    `BuildHalt` code `alt-key-name-length-not-set` (`recoverable`), whose text names the table, the length and why the
    step failed — not the platform's refusal of the key, which says nothing of the length — and what to do, in the proven / inconclusive
    words below (`keyRoomAtAskedLength`, `lib/entity-provision.js`): a key proven too large at the length asked is created by no run as the
    spec has it, and of any other key setting the length MAY make room, which the stop does not promise. The warning of the length step that
    failed names each key that waits for it in the same words (`alignPrimaryNameLength`), instead of claiming the key cannot be created
    while the column is that long. The halt is raised around the
    step's failure with the policy that failure gives (`retry: retryPolicyFor(…)`, `lib/retry-policy.js`) and the step's
    HTTP status, so a 429, a lock or a 503 is retried by the build and a refusal, or a failure marked `transient: false`, is
    not; the halt's own words (the key's name) never decide — a halt's code names it and is no type, where an error's own
    `code` would read as a refusal of its kind.
    The retry then finds the length owed, sets it, and asks for the key. A key made after the read that carries labels is
    safe because its label is one label, which a read has nothing to strip. That was measured for a create straight after
    the read and for a label in the base language; it has not been measured separately for a label in another language
    (a build authored in one, or a map that names one), where the key is the same request as every other label of such
    a build.
    **A key labelled in several languages keeps the place it always had**, ahead of the length step (`keyNeedsNameLength`
    holds, `keyWaitsForNameLength` does not), as every multi-language create in this file does: it cannot follow the read
    that sets the length without risking the other
    languages, and the length cannot be set without that read (the SDK's update needs the column's whole definition,
    which only that read provides). **Except** where the environment made the name column too long for the key to fit beside the
    others: the platform refuses such a key ahead of the step, and the first build used to stop there for the run that followed to
    make it. `keyHasRoomOnlyAfterLength` (`lib/app-spec.js`) says from the spec when the length can decide that — the key holds the name
    column, cannot fit while that column is 850 characters, and may fit at the length the spec asks; the size is a floor
    (`keyBytesAtLeast`: each column counts as the build creates it — a single line of text 2 bytes a character, a `Text` column at its
    `maxLength` or the SDK's default of 100, and an `AutoNumber` column or a column that gives no `type` at 100 whatever `maxLength` it
    carries, because the build sends a `maxLength` only for `Text` and `Memo` — `maxLengthSent`, the one rule `columnOptions` follows too;
    any other column counts one byte, so that what the floor shows is certain: what the platform counts for the other types a key can hold
    was not measured, and one byte changes nothing for a key that fits at the length asked) — and only for such a key does the build read the column, with one typed
    `…/StringAttributeMetadata?$select=MaxLength` GET (no labels: the kind of read the build keeps ahead of its labelled creates), before it asks for
    the key (`keyMustWaitForShorterNameColumn`, `lib/entity-provision.js`). Where the column reads too long for the key, the key waits for the
    length step like a key labelled in one language and is made after it, with both labels; where the environment kept the length asked, or the read
    fails, the key is made ahead of the step, where it always was. A key over the name column alone fits even at 850 characters, and one too large at
    the length the spec asks would be refused after the step as well, so neither is read for. **Why only then, and not every key over the name
    column:** the loss that keeps such a key ahead of the step did not reproduce in the live measurement (0 of 18 creates made right after a read
    that carries labels lost a language), while a key made after the length step kept both languages (9 of 9, and 2 of 2 in a new process) — so
    "after the step" cannot be shown safe where the loss does exist, and a key that fits keeps the place that never risked it; the one key that
    cannot be made there is the one that moves. A key that was not known to be too large and that the platform then refuses for its size (an
    environment whose limit is smaller, a read that failed, or a column the floor counts at one byte that the platform counts at more) is made where
    it always was, and `alternateKeyAheadOfLength` warns — only when the key fails — naming the key, the languages its label goes out in, why it was
    made first, and what to do, which depends on what the floor proves at the length the spec asks. **Proven too large** (the floor is over the
    limit): such a key is made there too (waiting makes no room for it), and the warning says so — the bytes its columns take at that length, that
    running the build again does not create it, and to take a column out of the key or make its text columns shorter. **Inconclusive** (the floor
    is within the limit — it counts a column that is not text, or one the spec does not describe, at one byte, so a name column of 849 characters
    beside an Integer column counts 1,699 bytes and is refused all the same): the warning promises nothing — running the build again may create the
    key (the length is set as the build stops) if the asked length leaves room for it; it states the floor, and says to compare the platform's error
    with the sizes of the key's columns if the next run is refused the same way. Neither offers a label in one language as a way out: that changes
    where a key is made, not its size. The same two wordings (`keyRoomAtAskedLength`) are what the stop for a key that waited for a length step
    that failed, and that step's warning, say of the key (above). Where the environment
    keeps the length asked and the key is made, nothing is said. Every other key —
    over another column, over the name column of a table that already existed or was found after its create (never
    written to), or in a spec that gives no length — is made with its table, as it always was; a spec that keys a name
    column without a `primaryAttribute.maxLength` leaves the column as the environment made it, so the reference tells
    an author to give one. `planFor` and the provision-entities plan list a waiting key after the length steps, where a
    table the build creates has it, and a key labelled in several languages with its table — whether the environment makes the build move
    it is known only to the build, and the count is the same either way. `table-columns-in-create.test.js` pins the order (against a
    stub that answers a key that is too large as the platform does: at 1,700 bytes, and at 900 for an environment that enforces the documented
    limit), the failure, the language rule, the warning and the stop for a key whose length step failed (proven and inconclusive, and that
    the run after agrees with each), the read and the retry,
    and that the floor counts each column as the real bundle creates it, for every type the build creates; `app-spec-key-size.test.js` pins the
    size rule.

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
  agent-interaction-contract.md ← Agents are headless: no AskUserQuestion / plan mode inside a Task subagent; a declared tool is not always a delivered one (task tracking is optional)
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
  list-connections.js          ← Connector discovery: the maker's connections + Dataverse connection references. The connections come from the SDK first (`listConnections`, with the Power Apps service token); `pac connection list --environment <origin>` runs only where the SDK refuses the route — and at once, with no SDK and no token read, for an environment outside the Public cloud, which the SDK has no route for (see "Connections, connector metadata and deployment settings") — and the output says which answered (`connectionsSource`, `connectionsFallback`)
  connector.js                 ← /genpage connector builder: a connector's operations, one operation's parameters and response, a tabular connector's table columns — `operations` and `schema --operation` from the SDK first (an environment outside the Public cloud goes to `pac` at once), `schema --dataset --table` and every SDK refusal through `pac model genpage`; one pure-ASCII JSON line with `source`
  create-connection-reference.js ← Creates Dataverse connectionreference rows for connector bindings
  list-custom-apis.js          ← Discovers bindable Custom APIs (Global + entity-bound) + parameter kinds (custom-api gated)
  list-languages.js            ← /genpage planner: the environment's base language and each provisioned language (LCID, culture code, right-to-left) — the SDK's `getEnvironmentLanguages()` over the az-token client, three reads and no write, printed as one pure-ASCII JSON line. The only source: no `pac model list-languages` stands behind it, because every /genpage page operation needs the Azure CLI
  apps.js                      ← the replacement for `pac model list` and `pac model create` that /genpage and /app-builder run (`pac-replaced-docs.test.js` pins that their text names this script, not the `pac` commands): the environment's model-driven apps and a new app that opens on generative pages, through the bundled SDK. `list` prints each app's id, name, unique name, description and two facts, apart: `published` (it has a row in the published layer: users can open it) and `unpublishedChanges` (it has a saved row that is not published) — drafts included; `pac`'s "(Saved - Not Published)" is neither of them (see the spec section) and never part of the name. `create --name --solution --page-id <guid> [--page-id …] [--unique-name] [--description] [--publish]` makes the app with one area "Main", one group "Pages" and a sub-area per page, titled with the page's stored name; the app and its sitemap join the solution (a system solution such as `Default` holds them already: `systemSolution: true`); it is published only with `--publish`. The default public view of each table the pages read (the tables come from each page's own configuration, the views from the page backend: the definition `placeInApp` pins with) joins the app's components in the create itself — `components.views` of the app the SDK creates, written by the same AddAppComponents that adds the sitemap — as `pac model genpage upload --app-id` pinned them; the output says what was pinned (`dataSources`, `pinnedViews`), a table with no default public view or a page held as raw files is named in `warnings`, and a page that cannot be read refuses the create before the first write. Every check — no page id, a page that does not exist, a solution that does not exist or is managed, a taken unique name, an unreadable base language — is a refusal printed as `{ ok: false, code, error, written: false }` before the first write; a failure after the push began reads the platform back and prints what is actually left of this create (its rows are recognised by their ids, and a row that holds the unique name under another id is named apart)
  list-tables.js               ← the replacement for `pac model list-tables` (the skills' and agents' text runs this script: `pac-replaced-docs.test.js`): the environment's tables — the SDK's `findTables(term)` for each comma-separated `--search` term, a few reads at a time, joined without repeats; `--exact` keeps the tables whose logical name IS a term and names the terms no table has (`missing`), from one read of every table; `--type custom|standard|all` is `pac`'s own filter, `custom` through the SDK's `customOnly` option. One pure-ASCII JSON line of `{ logicalName, displayName, schemaName, isCustom }` rows. An answer that is no list of tables — a 2xx with no `value` list: a sign-in page, `{}`, `null` — fails `TABLES_UNREADABLE` (exit 1) instead of reading as "no tables, every searched one missing" (`lib/collection-answers.js`)
  add-page-to-solution.js      ← Adds GenPages and optional connection references to a solution
  solution-settings.js         ← Deployment settings: `template` writes the settings file of a solution or a package (pac's own format), `import` imports a package and applies the settings in the same import — the SDK first, `pac solution create-settings` / `import --settings-file` only where it refuses (pac is given a private copy of the settings the run read, owner-only on every platform and removed however the process ends, never the file's path); ExportSolution, StageSolution and ImportSolution are each sent exactly once — but for an ImportSolution the platform refused to start because another operation held its customization lock (HTTP 429 with one of the customization-lock error codes whose documented text is "Cannot start …", or with `0x80071151` and "Cannot start …" words), which is sent again under a new job id once the refused send's job proves that nothing of the package was applied — `importjobs(<id>)` does not exist (404) or, for `0x80071151`, read once at once, is a finished job whose log says the import failed with that error before it processed the solution or any component (`lib/import-job-proof.js`); a job that proves nothing ends the retry with a sentence that says why and what to do, and so does a fifth `0x80071151` refusal, whose job is not read (at most five sends and five minutes in all — asked again after every wait — a `Retry-After` waited whole or the retry ended; `importAttempts` / `importRefusals` in the output) — every text it prints has the settings file's values taken out, and everything it prints or writes the access tokens the run sent (an HTTP 200 can be a failed staging whose message quotes what it was given), and a failed import names its job and the job log's reason; one pure-ASCII JSON line with `source`
  provision-entities.js        ← CLI wrapper for entity provisioning (solution + data-model + sample-data; --language-code)
  provision-solution.js        ← Creates a Dataverse solution via the SDK
  write-page-plan.js           ← app-builder Phase 1.5: projects an App Spec into the genpage-plan.md read by page-builder workers
  promote-intent-pages.js      ← app-builder Phase 1.5: validates every generated page, then atomically flips source: intent → tsx
  build-model-app.js           ← app-builder: narrated, idempotent SDK build (dry-run default; --stage data|ui|app|publish; --changed-only; --language-code)
  download-model-app.js        ← app-builder: pull a deployed app into an editable spec (edit flow; takes the build's --language-code: the language the navigation titles are read in, when the spec on disk pins none and the base language cannot be read)
  teardown-model-app.js        ← app-builder: classifier-safe reverse-of-build teardown
  verify-model-app.js          ← app-builder: reconcile the spec against the deployed app (takes the build's --language-code: the language its form labels were written in; its result JSON is pure ASCII and lists every `WARNING:` line it printed in an optional `warnings` array)
  preview-form.js              ← app-builder: ASCII form wireframe for authoring review
  preview-app.js               ← app-builder: ASCII whole-app design preview (data model + sitemap + forms + page-intents + design)
  write-app-spec-doc.js        ← app-builder: renders the readable model-app-plan.md design doc from app-spec.json (`--env` also reads, read-only, the roles the app has associated with it; a read that fails is reported in the document, never fatal)
  ai-preflight.js              ← app-builder: preflight AI feature availability (admin-gate report)
  run-tests.js                 ← one-command plugin + SDK regression runner
  smoke-eval.js                ← scripted live smoke eval (build → assert → teardown)
  generate-page-manifest.js    ← Phase 0.5: writes working-dir package.json + genpage.d.ts
  genpage-upload.js            ← /genpage: deploy one page through the page backend (prompt passed BY FILE, never composed into a command; a create needs no app — `--app-id` is optional for a create only: a page needs no app, so a create without it is added to no app and makes no app-scoped check; `--add-to-sitemap` and an update still need `--app-id`, and an update must prove the page is in that app's navigation; an update keeps the page's name, model, data sources and bindings unless given; a named app also gets the default views of the tables the page reads pinned into its components; `--add-to-sitemap` titles the page's entry in the environment's base language, which it reads with the backend's `baseLanguage()` before the placement — as `genpage.js add-to-app` does, and so when a later run completes the placement — and a language that cannot be read fails the placement before the app is touched — the page is written and published, the marker says the placement is unfinished, and the report says only what is known: this run changed nothing in the app's navigation (and, when it completes a placement an earlier run began, did not look at what that run saved there, so it never says the page was "NOT added"), nothing guessed in its place (an upload that places no page writes no title and asks the environment nothing); refuses a create whose `makeStyles` writes a Griffel shorthand (`griffel-shorthand`, before anything is read) and an update that ADDS one the deployed page did not already have — one it already had goes ahead with a warning — and, for an update, no-base / deployed-changed / deployed-unreadable unless --overwrite-deployed; the page's text is made from the file's bytes ONCE and that text is what is checked, hashed and written; a failed write is reported with the page's `pageId`, the backend's `outcome` and the SDK's `code`, so a caller can tell "unknown" from "failed"; a write the service throttles is waited out (`lib/throttle-budget.js`), and a wait of more than a few seconds is announced on stderr as `WARNING: …`, never in the result; a page THIS script created and did not finish — its publish failed, or the `--add-to-sitemap` placement did — is finished by running the same command again with `--page-id` added: the base marker beside the code file says `unfinished` for exactly that page, and stands in for the navigation proof an update makes for that page alone; finishing a placement asks the backend to FINISH it — the app is published again even when its saved navigation already names the page, and the marker stays while the app's published navigation can be read and does not show the page (`GENPAGE_APP_PUBLISH_UNPROVEN`, saved: the app's publish is what is left), so a placement that was saved and never published is not reported done; a published navigation that cannot be read at all clears the marker with a warning, since the publish was accepted and keeping the marker would make every later update of the page need `--add-to-sitemap` and publish the app again for as long as that layer stays unreadable)
  genpage-base.js              ← /genpage: record or check the deployed-page base marker next to a page.tsx (#673); `record` needs no `--app-id` — a first page is created before the app that will hold it, and is recorded with the page alone
  genpage.js                   ← /genpage: the page verbs the skills ran through `pac model genpage`, through the page backend and the Azure CLI token — `list`, `download`, `types` (the type generator), `add-to-app`, `remove-from-app` and `delete` (see "The page verbs" under Key Concepts); one pure-ASCII JSON line and exit 0, or a refusal as `{ ok: false, error, code, … }` and exit 1; a mistake in the command line is a usage error: stderr only, stdout empty
  genpage-plan-provenance.js   ← /genpage: quarantine a stale plan before the planner writes, then verify the written plan targets the pages the approval named and, for an edit, carries the exact approved change list
  check-page-files.js          ← /genpage: pre-dispatch gate — the page file names of the plan's one ## Pages table are safe write targets (lib/page-file-targets.js)
  genpage-worker-output.js     ← /genpage: accept a parallel worker's page only if complete (default export, balanced, no elided code)
  check-griffel-styles.js      ← /genpage and /app-builder: a page's `makeStyles` calls hold none of the ten shorthands Griffel's runtime drops (lib/griffel-styles.js; see "Griffel shorthands" below)
  capture-fixture.js           ← Copies /genpage working dir into an eval fixture and runs both runners
  lib/
    entity-provision.js        ← Shared entity-provisioning core (solution + data-model + sample-data): a new table is created with only its primary name attribute and its ordinary columns follow in one atomic change set (`createColumns`), falling back to one request per column (unless the run's throttle budget refused to wait for the change set: the phase then stops, `stop`); the primary name column's length is always sent (100 unless the spec gives one), its required level is asked in the create when the spec states one (and said applied only when the SDK confirms it) and, where the platform did not keep a length the spec gave, set last in the phase — a length a failed attempt left unset is owed to the build's retry (`owedLengths`, paid only to the table that attempt created: proved by its MetadataId, and then written by requests addressed with the ids, which a table made again cannot answer to), and an alternate key over that column is made after it; `makeRunner`, whose runner stops the phase at the next step once the run's throttle budget has refused a wait (`stopIfRefused`: `run` and each item of its `mapLimit`; a step that pays the name column length a table the run created is owed is let through); and `mapLimit`, the bounded fan-out every parallel path reuses
    retry-policy.js            ← when the build runs a failed phase again, decided from what the SERVICE said and never from what the maker named: `RETRY` (`NEVER` — a refusal of the spec, an identity or ownership conflict, an approval, a prerequisite, a file on the maker's machine; `SERVICE` — what the failure it wraps says), `judgeFailure(error, { declares })` (an explicit `transient: false` anywhere along the causes wins; then the HTTP status 429, 502, 503, 504; then a condition the service names by the `error.code` of its answer — `TRANSIENT_SERVICE_CODES`, a SQL deadlock victim (the generic SQL error code `0x80044150` AND the platform's `Sql Number: 1205` — the last SQL number the answer gives — in the service's own answer, `isDeadlockVictimAnswer`), and the lag of a column the spec creates (`declares`) — on any status; then a timeout or reset of the transport (by Node's own code when the error carries one, by its words only when it has none); then **any other HTTP status is final** whatever the answer's words say; then the SDK's or plugin's own type — a refusal, whatever it quotes (bar the SDK's wrapper of a failed publish, read by the status of the answer it embeds); then, only for a failure that carries no status at all, the service's own words, never a halt's message), `throttleAskOf` (what a throttled failure asks of the next send: `retryAfterMs` and `retryNotBefore`), `retryPolicyFor` / `retryFrom` (the policy a halt is raised with), `refusal` / `serviceFailure` (the errors the engine itself makes; `serviceFailure`'s `answered` records the OData error of an answer the engine read with a request of its own — its `code` and `message`, nothing else — and the rule reads that code as it reads the SDK's) and `withCause` (the failure a by-value result carries); `BuildHalt` takes `retry`, `retryText` and `statusCode`; build-model-app.js `isTransientHalt` is its one reader, and `tests/halt-retry-policy.test.js` holds every halt in the sources to a row of its table; an error that WRAPS the failure it carries as its `cause` (`CAUSE_WRAPPER_CODES`: `WEB_RESOURCE_UNVERIFIED`) is judged by that cause, read whether or not it is enumerable, and never by its own code or words — and one that carries no cause is run again
    throttle-budget.js         ← the budget a run allows itself for the waiting it does when a service throttles — five minutes, shared by the HTTP client's waits before it sends a throttled read, publish, delete or column create again (`deps.throttle` of `lib/sdk-http-client.js`), the page backend's waits between the sends of a page write (a `$batch` the HTTP client never re-sends) and the build's own waits before it runs a phase again (the upload script makes one for its run) (`makeThrottleBudget({ totalMs, warn })`: `fits(ms, at)` and `spend(ms, at)`, which answers what the wait added — a wait the client PLACES on the clock (`at`) adds only what runs past the waits placed before it, because requests sent together are throttled together and wake together, while the backend's and the build's, which wait one at a time, place nothing and add whole; `announce` for a wait longer than five seconds, on the `warn` seam the build wires to stderr; `decline` / `declined`, where the client says that a wait did not fit — in the words of `refusedWait`: what the service asked and that the request was not sent again, with no advice on what to run, because a refused request can follow a write that committed — and the build's retry loop and the engine's runner read it (the loop to stop with the halt, the runner so that no step starts after it), since the answer the client hands back carries nothing of what the service asked; `note`; `waitDoesNotFit`, the sentence of the `throttle-budget-exhausted` halt: what the service asked, how much is spent, that a later run of the same command continues); it only counts, each layer waits with its own seam. What is not drawn from it is a wait that is not for a throttle — a 5xx, a reset connection, a deadlock victim's re-send — and the waits of a client given no budget
    provision-input.js         ← Input validation for entity provisioning (the entry gate of `/genpage` and `/app-builder`; it applies `app-spec.js`'s own `primaryNameLengthProblem`, `autoNumberFormatProblem` and `requiredValueProblem`, so a name-column length, an AutoNumber column with no format and a `required` that is not `true`, `false` or `"recommended"` are refused here exactly as in `validateAppSpec`)
    dataverse-auth.js          ← Shared auth + HTTP helpers (`az account get-access-token`, memoized per process and replaced on a 401 — a synchronous `az` call, which a caller running other probes beside the request opts out of with `refreshOn401: false`; responses decoded as UTF-8 once; a request that fails is reported as `{ error, code? }` — the message and, when Node gave one, Node's own error code (the failures this module words itself have none), which `lib/sdk-http-client.js` reads to decide whether the request is worth sending again; an answer that is not a success, and a transport failure's text, come back from `dataverseRequest` with every token the call sent taken out — the one `scrub` of `sdk-http-client.js`, a success untouched; every token read from the Azure CLI, and every one `dataverseRequest` sends, is noted in `lib/output-redaction.js`, which keeps it out of everything the process writes, and `emitResult` cleans its own text the same way; an environment URL is used only as a Dataverse https origin, `dataverseOrigin`; a request path must stay under `/api/data/v9.2/` as both the client and the server resolve it, `webApiUrl`), the Azure CLI token for the Power Apps service (`getPowerAppsToken`: the same read for another resource, memoized apart from the Dataverse token and asked for only by the Power Apps service client and the connectivity preflight), plus the CLI arg contract (parseArgs/validateFlags, and `readLanguageCodeFlag` — the `--language-code` / `--languageCode` flag as an LCID, which `verify-model-app.js` reads exactly as the build does) and the result printer (`emitResult`, whose `{ ascii: true }` option writes stdout JSON as pure ASCII for a script an agent reads off a console)
    process-runner.js          ← how every script starts az/pac/npm/npx/git: the executable is resolved to an absolute path on PATH, never the project folder, and started without a shell (a Windows batch shim runs through cmd.exe with its arguments checked — except a launcher that only forwards to the native program beside it, the Windows MSI's two-line `pac.cmd` (`@echo off` / `"%~dp0pac.launcher.exe" %*`): it is recognised by its exact lines — `@echo off` on a line of its own, then the forwarding line, as `cmd` reads lines, so a one-line `@echo off "%~dp0x.exe" %*`, which is an `echo`, is not one — and the program beside it (`forwardedProgram`) and that program is started directly, so a `%` or a double quote reaches it unchanged; every other batch file keeps the checked route and its refusal of them); `killProcessTree` ends a stalled child AND everything it started (`taskkill /T /F` on Windows, where `pac.cmd` is cmd.exe → pac.exe, looked up with the System32 folder first on PATH so a PATH without it cannot leave the tree running, and with its window hidden; SIGKILL to the descendants `ps` lists elsewhere, each only once `ps -o lstart= -p` shows its pid still has the start time the listing saw — a descendant that exited meanwhile can have its pid given to an unrelated process; best effort, since two processes can share a one-second start time and the moment between that read and the signal is not covered), through the same audited calls; a child that has already exited is only asked to die, never ended by its pid, which may be another process's by then; synchronous, and it never throws. `spawnResultTree` is `spawnResultSync`'s asynchronous twin (same result shape, never rejects) for a call that may have to be ended: one that outlasts its `timeout`, or writes past `maxBuffer`, has its whole tree ended through `killProcessTree` before the call settles (`ETIMEDOUT`, `ENOBUFS`), after a short wait for the pipes of what was ended; the error says whether they closed (`containment`: `confirmed`, or `unconfirmed` when a process that outlived the ended tree still holds them, with the `pid` the call was started as)
    cli-failure.js             ← how a CLI child failed (timeout / missing / failed), the Azure CLI budget (60 s, `POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS`), so a slow `az` is never reported as missing or signed out; `commandArg` writes an argument of a command a message tells you (or the agent) to paste so that, run from PowerShell (Windows PowerShell 5.1 or PowerShell 7) or a POSIX shell, the program gets it unchanged as one argument — bare when it is plain, single-quoted otherwise (a path from an untrusted checkout can hold `;`, `$(…)` or backticks) — or not at all when no spelling does that in every one of those shells: a quote or a line break, and the values Windows PowerShell changes on their way to a native program (a `"`, white space with a final `\`, the empty value) or both PowerShells read as the stop-parsing token (`--%`), all measured. `commandArgOrPlaceholder` then writes a placeholder and names the value outside the command
    nearest-name.js            ← pure single-edit "did you mean" matcher for closed vocabularies (CLI flags, FetchXML operators)
    compare-text.js            ← `compareText`, the text order for any list a script writes and a diff between two runs then reads: UTF-16 code units after lower-casing, the raw text breaking a tie; never `localeCompare`, whose order follows the host's ICU locale and version (the download's lists use it)
    lcid-cultures.js           ← pure: a Windows language id (LCID) → culture code and right-to-left, from a table of Windows' own culture data (what `pac` printed; the SDK reports numbers only, and no Intl API maps an LCID); a language id with no entry stays numeric and is reported, never guessed (`list-languages.js`)
    supported-dependencies.js  ← Single source of truth for runtime + dev deps versions
    feature-flags.js           ← Default-OFF feature flag probe + Custom API script backstop
    sdk-build.js               ← app-builder build engine (idempotent; incl. the pages phase). Every way it pushes or publishes the app is one of `appWriters`, which first awaits `publishTablesBeforeApp` (the one request that publishes, before the app, the tables whose forms or charts its publish ships)
    app-components.js          ← shared current/published app layers (`currentLayerRows`, and `currentLayerRow` — the authored layer wins — for a listing), component inventory (`readAppComponentInventory`: the download's read, with two opt-ins the build's pre-app proof makes — `savedLayer`, which looks the tables of the form and chart components up in the SAVED layer, and `requireIdentified`, which reads the answer strictly: a row counts for an id the list asked about, two tables for one id or a value no table has make the read incomplete, and a row of the component list that cannot be placed — no record, no GUID objectid, another component type — makes the list unreadable), hidden-table pin/proof, Main-form resolution/membership and push directives, `collectionRows`, the one reader of a paged collection, and `savedPageRows`, the one reader of the generative-page rows in the SAVED layer (RetrieveUnpublishedMultiple, 50 ids a read): a plain read of the page table answers the published layer only, so a page that was created and never published is "not found" by it — `apps.js` and teardown read pages here
    solution-membership.js     ← one read of a solution's components (the types the build adds, plus its tables: a table held with all its subcomponents vouches for its views, forms and charts, which have no rows of their own), so a rebuild adds just what the solution is not PROVEN to hold; every doubt reads as "add"
    unsynced-edits.js          ← the SDK's own dirty tracking (`diffArtifact`) as the one proof that a reconcile has nothing to push; every doubt reads as "push"
    table-publish.js           ← the tables a spec names (`specTables`, the wide READ-ONLY list a halted build reads), the tables the build publishes before the app (`preAppTables`: what it changed — reconciled tables, the tables of the charts it wrote — the tables whose Main forms its own write of the app adds (`appWriteTables`: the navigation's tables, from the spec and how the SDK writes the app, honouring `app.mainForms` — for a writer that sends the spec's navigation; `appPushTables` takes the Entity tables of the navigation a writer does send, the placement's and the routing-description push's, and the Main-form list that push carries), and the tables the app is PROVEN to hold a form or chart of; the spec decides nothing else, so never a table that is only declared, a lookup's target, read only by a page or only pinned in `app.tables`), the proof (`readAppFormChartTables`: the app's form and chart components on the server, looked up in the saved layer, complete and unambiguous or nothing), the ONE `PublishXml` that publishes tables by name (`publishTablesXml`: the build's pre-app publish, and the lookup-label repair's), the read of which of the spec's views, forms and charts are saved but not published (`readSavedNotPublished`, the SAVED layer through `RetrieveUnpublishedMultiple`, `componentstate` 1 and 3) with the line a halted build prints from it (`describeSavedNotPublished`), and the warnings for a refused pre-app publish and for an app whose components could not be read (`describePreAppRefusal`, `describeUnreadAppComponents`); every doubt in a read says so and names the tables, never a shorter list
    publish-xml.js             ← the plugin's OWN publishes (`postPublishXml(dataverse, parameterXml)`: the tables `table-publish.js` publishes by name, and the app `app-components.js` publishes after pinning its tables) — the one place they are sent, and the one layer that re-sends one SQL rolled back as a deadlock victim (1 s / 2 s / 4 s, four sends at most, by `sdk-http-client.js`'s own predicate): the HTTP client sends a publish once, and the SDK's publishes are re-sent by the SDK's own `publishXml`
    stages.js                  ← stage→phase-range mapping + PHASES/STAGES constants
    op-diff.js                 ← destructive-op diff + --allow-destructive / --non-interactive gating
    artifact-intent.js         ← pure App Spec → canonical SDK intent compiler (new form topology; no SDK calls)
    form-occupancy.js          ← pure row occupancy (own cells + columns reserved by row-spanning cells above), shared by build and verify
    form-timeline.js           ← pure: the shape Dynamics renders the Notes timeline in (control id, tall cell, spacer rows), what a deployed one lacks, and how to read it in the SDK tree and in published FormXML (shared by the compiler, the build's repair and verify)
    form-subgrid-placement.js  ← pure: where a form's sub-grid sections go (`tab`/`column`/`after`/`before`) — resolving a placement against the declared layout, the order of a column's sections and grids, finding a grid's section in either tree shape (shared by the spec gate, build, verify and the wireframe)
    form-order.js              ← the Main Form Set order: which Main form a table opens with, and which forms the build orders (shared by the spec gate, build and verify)
    dashboard-tiles.js         ← pure: whether a tile of a deployed dashboard is a grid or chart a custom control hosts and not a native one — the control class decides, as the SDK reads both as `list`/`chart` with the same parameters (shared by the download, which leaves such a tile out of the spec, and verify, which does not hold it to a chart and view of its table)
    form-container-match.js    ← how an authored tab/section is matched to a deployed one, and the moves that put them in the layout's order (shared by build and verify)
    ai-app-settings.js         ← single source of truth for the per-app AI feature contract
    interaction-mode.js        ← whether a human is reachable in this run (shared by both skills)
    page-plan.js               ← pure App Spec → plan-document projection used by write-page-plan.js
    page-structure.js          ← the one structural gate a generated page must pass (empty, truncated, prose, elided), shared by genpage-worker-output.js and promote-intent-pages.js
    griffel-styles.js          ← the ten shorthands Griffel's runtime drops, found as keys of a `makeStyles` style object (any depth, code only — the plugin's own lexer), with their longhands and where each sits (`within`: its slot, selectors and at-rules; `owner`: the `makeStyles` hook, by the name it is bound to at the top of the page — through a type annotation, or as a property — and null for a call the page does not prove a name for; `branch` and `arms`: which style object of that call, and which object of each value below it, where a condition chooses between two); shared by check-griffel-styles.js, `genpage-upload.js` (refuses a create, and an update's NEW keys — `griffelProblemsNotIn` tells them from the deployed page's) and the build's pages-phase scan (halts a new or changed page, warns for one it sends as it is), whose texts (`describeGriffelRefusal` / `describeGriffelWarning`) say what each way out does to the page; and the tests
    page-file-targets.js       ← the one page-filename rule (absolute/backslash/traversal/.tsx only/links/case collision, incl. with files already there), shared with check-page-files.js and the evals
    app-source-path.js         ← shared lexical + realpath confinement for app source reads/uploads and hashes
    page-ownership-records.js  ← local CREATE receipts and pre-delete ownership records, scoped to app/key/id; and the `pending` records of a page create that was started and not acknowledged (written before the create is sent, under the id it will use, with the name and the SHA-256 of the source it sends — one per create sent under the id; intent, never ownership: `readPageOwnership` does not see it, `readPendingCreations` / `completePendingCreations` settle it, and only evidence settles it — an acknowledged create, a page proven to be the one sent, a teardown that deleted the page — never an absence from a listing)
    page-publish-records.js    ← `page-published.<hash>.json`, one file per app and environment in the build workspace: per page, the hash of the content (`contentFingerprint`) it was last PUBLISHED with and the version number of every one of its file rows and of its own row (the plain reads `genpage.fileVersions` and `genpage.projectVersions`), written only after a publish seen to take effect, and with versions only when they were read on both sides of a read-back of the page's published copy (`genpage.publishedDiffers`), were the same set, and the copy held the content and the compiled output the draft held when it was published (`runtimeSha256`). The build hands the hash back to `genpage.update` as `publishedFingerprint` only for a page whose rows read now are exactly the recorded set at the recorded versions (`sameFileVersions`), so an unchanged page is not published again and a page published, renamed or saved from elsewhere is; a cache, never an authority — anything missing, damaged, for other content, without versions or with a moved version reads as "not known to be published" and costs one publish, and the schema (3) is the proof's version: a record of an earlier schema is read for its hashes and skips nothing; it grants and blocks nothing (`readPublishedPages` never throws, `writePublishedPages` failing is one warning)
    web-resource-records.js    ← `web-resource-unconfirmed.<hash>.json`, one file per environment in the build workspace: the web resources this workspace's builds wrote and could not confirm were published (`WEB_RESOURCE_UNVERIFIED`), by name and id. `openUnconfirmedWebResources` is a run's view of it (`idOf`, `note`, `clear`; it never throws: a record it cannot read is "nothing recorded", said once, and a run with no workspace records nothing). A name it holds is written again by id by the next run (sdk-build.js `writeOwnedWebResource`, `persistPageManifest`) instead of being reused untouched; the entry is cleared once that write verified and the row is in the solution
    source-literals.js         ← TSX lexer (code/comment/string/template/regex/JSX) — see "Known limits" below
    sdk-teardown.js            ← app-builder teardown engine (planTeardown is pure)
    sdk-http-client.js         ← az-token HttpClient for the vendored SDK; a caller can name requests that are sent exactly once (`sendOnce(method, url)`: no retry on a transport failure, a 429 or 5xx, or a 401 refresh, and none of the replays special to a record delete and a `$batch` either) — `solution-settings.js` does for the three long solution actions; a caller can hand it the run's throttle budget (`deps.throttle`, lib/throttle-budget.js): every wait it takes before it sends a throttled request (HTTP 429, alone or as every operation of a `$batch`) again is then drawn from the budget — the answer's `Retry-After` whole, past the cap of a minute, or the schedule's wait when that is longer, placed on the clock so that requests throttled together are charged once — and a wait that does not fit is not taken: the 429 comes back as it came and the budget is told what the service asked (`decline`); every other wait (a 5xx, a reset connection, a deadlock victim's re-send) keeps its own schedule, and the budget is duck-typed and never loaded here, so the pcf copy, which has none, waits as it always did; an answer that is not a success comes back with the access token taken out of it (and a transport failure's text too, the error that carries Node's code included), a success untouched — the one `scrub` / `scrubAnswer` the Power Apps client uses as well; `needlesOf(token)` and `TOKEN_MARKER` are `lib/output-redaction.js`'s: the one list of texts a scrubber takes out of one token (the token and each of its parts of 24 characters or more) and the one marker, so the client's scrubber and what the process writes are kept free of a token by the same list, and each token the client sends is noted there (`noteToken`); `throttleBackoffMs(attempt, random)` is the capped, jittered schedule every throttled request waits on (1 s, 2 s, 4 s, 8 s, 8 s), exported because the page backend waits out a throttled page write on it (the client never re-sends a page's `$batch`: `lib/genpage-sdk.js` does, a push at a time); `retryAfterMs(headers, now, cap)` and `batchRetryAfterMs(res, now, cap)` cap what a response asks at a minute for the client's own retries, and a caller with a bound of its own passes `Infinity`: the page backend spends it inside the run's budget, the client itself does when it has that budget, and `solution-settings.js` inside the one budget of its import resend; `completeBatchStatus(res)` is the one status a COMPLETE multipart answer reports for every operation (the page backend reads a change set refused as a whole with it); the parser behind it, `isBatchThrottled` and `isBatchDeadlockVictim` is strict — an answer is read only when its outer boundary closes, every change set in it closes, and every part is a complete response whose first line is a status line; a part that declares a change set (`Content-Type: multipart/mixed; boundary=…`) must open and close exactly that boundary before the outer one goes on, a part with no response in it is an operation nobody answered, and a body is as long as the `Content-Length` its response gives, counted by the line breaks the answer has; a part that declares a `Transfer-Encoding` (chunked or any other) is not read at all, whole stream or not — the delimiters around it say nothing of whether its chunk stream is finished, so it never certifies a refusal or a deadlock victim; anything missing or malformed makes the WHOLE answer unproven (an answer that closes its outer boundary and is incomplete inside proves nothing); `isTransientTransportFailure(text, code)` says which failures of the transport are sent again — decided by Node's own error code when `makeRequest` reported one (`TRANSIENT_TRANSPORT_CODES`: `ECONNRESET`, `ETIMEDOUT`, `ESOCKETTIMEDOUT`, `ECONNABORTED`, `EPIPE`, `EAI_AGAIN`; any other code is final whatever the words say) and by the words only when it did not (a certificate's own phrases first): a reset, a timeout, an answer cut off, a temporary DNS failure, the same list `lib/retry-policy.js` calls a blip, and nothing else — a certificate that does not verify (whatever names it quotes), an unknown host and a message nobody recognises return at once; the error it throws carries the code beside the same message (this file is copied into the pcf plugin, so a test holds the two lists equal); a publish (`PublishXml`, `PublishAllXml`) is sent ONCE but for a 401 and a 429 of the service protection limits (`isServiceProtectionRefusal`, `SERVICE_PROTECTION_CODES`: the three codes the api-limits page documents) — never for the customization lock's 429, a 5xx or a failure of the transport — and its deadlock victim is the layer above's to re-send (`isSqlDeadlockVictim` and `DEADLOCK_RESENDS` are exported for `publish-xml.js`). Copied verbatim into `plugins/pcf` (`scripts/validate-plugin-copies.js`)
    maker-sdk.js               ← the one way a script makes an SDK: the vendored bundle with the vendored TypeScript compiler as its page compiler, and with the client it is handed guarded by `app-header-text.js`; `connectivity: true` (opt-in) also gives the instance the Power Apps service client, so no script wires a credential-carrying client by hand; and the `httpClient` it is given is handed over with the read of the environment's TABLE LIST held to being a list (`lib/collection-answers.js` `guardTableLists`), so every script's `findTables()` meets a failure (`TABLES_UNREADABLE`, an `SdkError`, so `error.code`) where the bundle alone would read a sign-in page, `{}` or `null` as "no tables" — none can forget it; and the `workspaceStorage` it is given is handed over with every text it is asked to write taken clean of the access tokens the process obtained (`lib/output-redaction.js` `guardWorkspaceStorage`: the SDK writes every file of its workspace through `writeTextAtomic`, and the wrapper is the storage in everything else), so a token a service repeated in an answer cannot land in a workspace file. The SDK itself — its errors, its warnings, its results — is exactly what the bundle makes: what a script WRITES is what is cleaned
    output-redaction.js        ← keeps every access token the process obtained out of everything it WRITES, and out of nothing the service or the SDK made: `noteToken(token)` (called where a token is read from the Azure CLI — `dataverse-auth.js`, both reads — and where `dataverseRequest` and the SDK's HTTP client send one) is the registry, and the first token noted guards the process: `guardStream` wraps `process.stdout.write` and `process.stderr.write` (every `console.*` call, every script's result and warning printer, a library's own output end there; text only, bytes pass), and `guardFatalErrors` prints — cleaned — what Node itself prints when an error ends the process, which never passes through `process.stderr.write` (only when nothing else handles the error: a test runner's own listener is left alone). `redactOutput(text)` is what the file writers call (`safe-fs.js` `writeFileSafe` and `appendFileSafe`, `apply-snapshot-store.js` `writeFileAtomic`) and `guardWorkspaceStorage` wraps the SDK's `writeTextAtomic` (`maker-sdk.js`). `redactTokens(text, tokens)` is the matcher: it reads the text as it SPELLS a token, one character at a time — the character itself or an escape of it (`\uXXXX` in either case, `\xXX`, `\/`), with a fold between any two of them (white space, `\r\n` `\t` `\b` and the like as JSON writes them, a run of backslashes before an escape: JSON inside JSON, a stray backslash, a terminal colour code, the quote-plus-line-break `util.inspect` prints between the pieces of a long string, in colours or not) and an escape that can also be a literal backslash and letters (`\n` before a signature that starts with `n`) read both ways — every needle (the token and each part of 24 characters or more: `needlesOf`) in ONE linear pass with a bounded set of readings beside it (a text that would need more is refused: the writer fails closed), the whole span from the token's first character to its last becoming `<token>`, so that JSON that was written is JSON still. It never touches an error, a warning or an answer: the SDK's errors keep every word the SDK gave them, and the strict `$batch` readers see the bytes the service sent. Not read: other encodings of a token (percent-encoding, base64, entities), a token another process obtained, bytes, a token written in two separate calls to `write`, and the end of a part a formatter cut short. `makeWritesBlocking(...streams)` makes a stream's writes blocking for the last writes of a process — `emitResult`, `guardFatalErrors`, and every printer of a script's own that ends the process after writing (a result, a usage error, a last-resort handler, a hook's message, the warnings a script prints right before its result) — because on Linux and macOS a pipe's writes are queued and `process.exit` does not wait for them, so a large result reached its reader cut short (`tests/result-whole-before-exit.test.js`, `tests/printers-whole-before-exit.test.js`: each process records the order in which it makes its streams blocking and writes to them — the check that fails on every runtime for a printer without the call — and the text a reader receives; nothing else about the stream changes, the guard included). `tests/exit-writes-inventory.test.js` is a syntactic tripwire, not a proof: it fails on a new exit with no such call before it in its block (or that is not listed with the bound that makes it safe: it writes nothing, or a constant), and on a call that comes after a write of its block or leaves out a stream written before the exit; it does not follow calls or control flow, and does not see writes made in an enclosing block, before an `await`, or through a helper. Copied verbatim into `plugins/pcf` (`scripts/validate-plugin-copies.js`), where it also cleans `pcf-push.js`'s receipt and guards the SDK workspace `makePcfSdk` makes
    app-header-text.js         ← an app's header texts (`name`, `description`) held to plain text at the HTTP client every SDK is made with (wired in `maker-sdk.js`): a PATCH of an app module row that carries one that is not a string is refused before any byte is sent — `APP_HEADER_NOT_PLAIN_TEXT`, an `SdkError` marked `transient: false` — whether it is the SDK's `patch`, a `patchRaw`, or a PATCH inside a raw change set (`postRaw` / `post` to `$batch`), because the SDK writes every text its workspace copy holds whenever its own comparison read of the header cannot be made (503, 403, a thrown error, an empty 200). The build takes such a text off the copy before its push, so this is the last line of defence, for a push of a copy it did not clean. A batch that names the app module table and cannot be read is refused too. A delegating Proxy: every member it does not judge runs on the client itself. Also how such a text reads in a message (`describeHeldAppText`), which the guard's refusals share
    batch-request.js           ← a multipart `$batch` REQUEST read the way the service reads it — `readBatchRequest(text, contentType)`: the parts of the boundary the Content-Type declares, a change set one level down, one HTTP request in each part, answered as `{ operations: [{ method, target, contentId, body }] }`, or `{ problem }` for text it cannot read with confidence (cut short, another boundary, a part that is not a request). A body is only ever text: a line in it that looks like a request is not an operation. `app-header-text.js` reads a raw change set with it
    throwaway-sdk.js           ← `withThrowawaySdk({ env, prefix, httpClient? }, run)`: the bundled SDK, made through `maker-sdk.js`, over a throwaway workspace folder (made by `temp-workspace.js`) that is removed whichever way the run ends (a constructor, a storage or a module that throws included); `run(make)` gets a `make(extra)` for more instances over the same folder and the one client (`make({ languageCode })` is a writer). The one copy of what `apps.js`, `list-tables.js` and `list-languages.js` each wrote out
    collection-answers.js      ← `requireCollectionAnswers(client, { reads, unreadable })`: the HttpClient the SDK is given, with one addition — a 2xx answer to a read `reads(url)` selects must be a collection (`{ value: [...] }`), or the read throws what `unreadable` says; `unreadableAnswer(error)` finds that error, itself or under the SDK's `ConnectionError`. `guardTableLists(client, makeError)` is its policy for the one read of the environment's table list (`/EntityDefinitions?…`, which only `findTables()` makes), and `maker-sdk.js` applies it to every SDK a script makes: the SDK's `findTables()` is `body.value ?? []`, and the bundle is not edited
    temp-workspace.js          ← the one maker of the plugin's throwaway workspace folders, and the sweep of the ones a KILLED run left (`makeTempWorkspace(prefix)` in place of `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`, at every entry point that makes an SDK workspace — the page backend, `withThrowawaySdk`, `sdkFirst`, build, download, teardown, verify, the `provision-*` scripts, `ai-preflight`, and `solution-settings`' pac scratch folder). A run killed outright (SIGKILL, "End task", a timeout) never reaches its `finally`, and what it left held the source of every page it read and the environment's address (`solution-settings`' pac scratch folder: a settings template, an exported package or a copy of the settings file, which can hold values; the sweep's note says which a folder held, by its prefix). The folders go together in one folder of the plugin's own, `<temp>/power-platform-skills-model-apps` (`-<uid>` after it on POSIX, where the temp folder is shared). That folder is a courtesy, never a reason for a run to fail: it must be a plain folder that only this user can change — POSIX: owned by the user and writable by no one else; Windows, which tells Node no owner and no permissions: a folder this process MAKES is given an explicit access list before anything is put in it — protected, with only this user, the system and the administrators on it, full control inherited by every workspace and record made inside — and read back, and one that cannot be made so is removed and not used; an EXISTING one is judged by its access list and its owner (`windows-folder-acl.js`) and used only if NO entry of the list, an inherit-only one too, lets anyone else add to it, write to it, delete it or take it over, and the user (or the administrators, who own what an elevated process makes) owns it) — and if it cannot be used, or will not take a new folder (mode 0500, an access list that denies this user; a Windows folder that is being removed refuses a new entry — and its access list cannot be got — for a moment, so the attempt is made again after short pauses, up to six in all, and a folder that is still refusing after the last is not asked again by that process), the workspace is made in the plain temp folder exactly as before, unrecorded and never swept, and an error is reported only when that fails too. Each folder is named for the process that made it (`genpage-4242-AbC123`: the prefix, the pid, `mkdtemp`'s six characters; a prefix that does not end in a hyphen is given one, so that the pid always follows the hyphen a sweep reads it from) and holds an owner record `.owner.json` (`process-owner.js`); the first workspace a process makes sweeps that folder (`sweepDeadWorkspaces`) — only a workspace whose owner is PROVABLY gone is removed (the name's pid must have no process — on Linux a pid that runs is looked into too, since the record's start time can show it was handed out again — and the record must agree with the name; the record is read again, and judged again, just before the removal; what is inside is removed first and the record last, and the record leaves the folder only for as long as the folder itself is being removed — it is renamed out to `<folder>.removing`, which Windows allows even while another process holds it open, and moved back if the folder will not go — and if even that is refused it stays beside the folder, whole, and is never WRITTEN into the folder instead, since a write can be cut off and a damaged record beside the whole one would strand the removal; a sweep that is killed between the move and the removal leaves that file and the empty folder, and the next sweep finishes the removal when the file is a record of the folder's own — its name, a record that names the pid in it, an owner that is gone — and the folder is empty or gone, and leaves anything that does not agree as it is — so a removal that fails, half way or at the very end, leaves a folder still known to be dead and found again by the next sweep (Windows with Node 20 keeps a file that was deleted while open, listed, until the holder lets go, and the folder cannot go meanwhile); at most 100 a run, out of 500 entries looked at: the entries are taken in name order and the next run starts after the last one looked at — a cursor, `.sweep-cursor.json`, one small file in the plugin's folder, written whole and there only while the folder holds more than a run looks at — so that a folder whose first 500 entries must be kept does not hide a dead run's workspace, or a removal a kill left half done, behind them for good), and a folder whose name names a pid that RUNS is not even opened (on Linux its record alone is read, for the start time that can show the pid was handed out again; Linux lets a file another process has open be removed) — on Windows a file that is deleted while another process has it open stays in its folder until that process lets go, so a sweep that read a live run's record could make that run's own removal fail — and the run says so on stderr (`⚠ removed 1 temporary workspace left in … by a run that is no longer running`). A run that may still be going, another machine's, a folder with no readable record (a release before this one's, a damaged record), a link, a file: left as they are. **A path inside a workspace that is given to a program of another make makes the workspace LENT, when it is made** (`makeTempWorkspace(prefix, { lent: true })`, as `solution-settings`' `templateThroughPac` does for pac): on POSIX such a program outlives a run that is killed, so the record — written ONCE, whole, to a file of its own and renamed into place, and never written again — says `lent: true`, and a sweep never takes a lent workspace because its maker is gone: only when its maker is gone AND it is old, neither the folder nor its record written to for seven days (`LENT_KEEP_MS`; pac gets an hour at most). Nothing follows the program or changes the record once it has started (a record that is changed later can be unreadable at that moment), and a record that is unreadable keeps the folder. Every caller that hands a path in a workspace to another program decides that when it makes the workspace. The plugin's folder is removed when the process ends with nothing in it, so a normal run leaves the temp folder as it found it — and so does a run that is cut short by `process.exit` or an error nothing catches (the `exit` event): it first removes the workspaces it made and did not lend that are still there, by the steps of a sweep (what is inside first, the record last), since it never reached the `finally` that would have; a LENT workspace is never taken at the end of the run that lent it, and what is not its own is never touched (`rmdir` takes the folder only when it is empty, and a run that loses the folder between making it and making its workspace in it makes it again); the one caller that removes a lent workspace itself, `solution-settings`, does it in a cleanup it registers with `lib/exit-cleanup.js`, which runs after the maker's listener has found the workspace still in the folder and left the folder, so that cleanup calls `pruneWorkspaceParents()` once its workspace is gone — the same `rmdir`, so a run that is cut short while pac runs leaves no empty plugin folder behind (a signal included: it ends a POSIX process with no `exit` event, and that cleanup is what runs). A POSIX signal is NOT one of these ends — its default action ends the process with no JavaScript run, and a listener, which would, replaces that default action in every script that makes a workspace (a process blocked in a synchronous `az` or `pac` call would no longer end when signalled, and the signal would have to be raised again to keep its status) — so a run that is signalled leaves its workspace for the next run's sweep, as a killed one does; a folder that cannot be used or a record that cannot be written costs the sweep, never the run. The sweep reads only the plugin's own folder, never the temp folder, which can hold hundreds of thousands of entries
    process-owner.js           ← who made a lock or a workspace, and whether that process is gone — one place for the pages lock, the temporary workspaces and the snapshot lease's liveness check (`processAlive`, as it always was). `ownerStamp()` is what a maker records (pid, time, host, platform, and on Linux the pid namespace and the process's start time from `/proc`); `ownerState(stamp)` answers `gone` only when the stamp was made on this machine, by this kind of system, in this pid namespace, and no process has the pid (ESRCH) — or, on Linux, a zombie or a process with another start time has it (the pid was handed out again) — `alive` for a process that runs (this one included) and `unknown` for anything else: another machine, a stamp that is missing, damaged or not understood. **On Linux a pid is only a name inside its pid namespace, so the stamp AND the reader must both name theirs (`pid:[…]`, readable and well formed) and name the same one: a side that cannot (a hidden `/proc`: a container, hidepid, a sandbox), or two that cannot, is `unknown`, never "the same pid space".** A recorded `start` that is not `<boot id>:<ticks>` — empty, cut short, damaged inside a record that is still valid JSON — makes the record untrusted (`isOwnerStamp`: kept), and a start read from `/proc` that is not well formed is not compared: only two well-formed starts that differ show a pid handed out again, in the self-pid branch too. `ownerState` is a fact about the maker and only that: a workspace that was handed to a program that outlives its maker is kept by its age instead (`temp-workspace.js`, `lent`). Every doubt keeps; where no start time is cheap to read (Windows, macOS) a pid given to another process makes a dead run look alive, which keeps its lock or folder (the state of things before this module)
    windows-folder-acl.js      ← who can change a folder on Windows, where Node reports no owner and no permissions, and the making of a folder that only this user can: `windowsFolderIsPrivate(folder)` saves the folder's access list with `icacls <folder> /save` (SDDL: SIDs, in every language, not names) and reads the user's SID with `whoami /user /fo csv /nh`, both started through `process-runner.js` with System32 first on PATH, and answers `{ ok, reason, owner? }` — private only when NO entry that grants a right to add to the folder, remove from it, delete it, write its attributes or extended attributes, change who may or take it over names anyone but this user, the system or the administrators (an INHERIT-ONLY entry counts too: it does not apply to the folder, but it is what every workspace and every owner record made in it is given; denials and audits grant nothing; SDDL writes the machine's own Administrator and Guest accounts as the aliases `LA` and `LG`, which are the user's own only for the user whose account that is, as a CI runner's renamed built-in Administrator is; an audit list after the access list, as Windows' own folders carry, is read and ignored) AND the folder is owned by this user or the administrators — whoever owns a folder can rewrite its list, so a list that names only the user does not make a foreign folder the user's. The owner is the one thing `icacls` cannot print (`/save` stores the list and nothing else), so it is read with PowerShell (`[IO.Directory]::GetAccessControl(folder, Owner)`, a SID; the folder goes in through the environment and the script is passed encoded) — half a second, which is why it is the last thing asked (a folder the list has refused never starts it), and PowerShell that cannot run is "not private". The administrators are accepted as owner because a process that runs elevated (a CI runner is one) owns what it makes through that group by default, and the list trusts them anyway. A list that icacls ran and could not save — Windows is removing the folder, which cannot be opened meanwhile — is `unreadable`, a "no" that `temp-workspace.js` does not keep: it asks again after a pause, and drops an answer about a folder that was replaced while it was being judged; whatever else cannot be read, run or understood is not private, and `temp-workspace.js` then makes its workspace in the plain temp folder as before. `makeWindowsFolderPrivate(folder)` is for a folder this process has just made: `icacls <folder> /inheritance:r /grant:r *<user>:(OI)(CI)F *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F` replaces its list, and the list is read back and must be exactly that — protected, nothing inherited, three grants, full control for the user
    power-apps-service-client.js ← the HttpClient for the SDK's connection and connector reads: GET only, https only, a host allowlist that is exactly the hosts the SDK's connectivity code calls, redirects never followed, the Azure CLI token for the Power Apps service read only for a request that passed and never in a message, a body, a header or a key the service answers with (it is scrubbed, in whole and by part)
    sdk-first.js               ← the rule `list-connections.js`, `connector.js` and `solution-settings.js` share: read through the SDK, and through `pac` for the SDK's typed refusals (`sdkFirst`, `CONNECTIVITY_REFUSALS`) — an error counts only when it IS the bundle's `SdkError` (an HTTP body that carries a refusal's code does not); any other failure is thrown with the SDK's own code. An environment outside the Public cloud is judged from its host first (`connectivityCloudOf`, pinned to the bundle by a table of hosts) and answered by `pac` at once, with the code the SDK would give. What the SDK could not clean up before it refused (`readCleanupWarnings`: a staged copy of the package it could not delete, with its upload id) is carried across the fallback — as `warnings` on the answer, or attached to the error `pac` throws when it fails — so `solution-settings.js` shows it for `template` and `import` alike (an import's, sanitized once)
    pac-fallback.js            ← runs a `pac` fallback command through `process-runner.js` (`spawnResultTree`) within a fixed time limit (`PAC_READ_TIMEOUT_MS`, 3 minutes; `PAC_IMPORT_TIMEOUT_MS`, 60) — a call that runs out has its whole process tree ended before it is reported, and the message says what the runner confirmed — "`pac` and every process that held its output were stopped" — and, when the pipes did not close, that a process `pac` started may still be running — reads the JSON `pac` prints after its header, and keeps pac's sign-in banner and version lines out of every failure text (`pacErrorText`)
    import-job-proof.js        ← what the import JOB of an import the platform refused to start proves about whether it applied anything, for `solution-settings.js`' resend of an import refused with `0x80071151` ("Cannot start …"): `proveRefusedImport({ status, body })` — a 404 is proof (the job never existed), a 200 is proof only through `refusedBeforeAnyComponent(row)`: `completedon` set, `data` read as ONE XML document by `strict-xml.js` (a pattern would miss a `processed="true"` after a `>` in a value) with the root `importexportxml` saying `succeeded="failure"` and `errorcode="-2147020463"` exactly, at least one `solutionManifest` and every one `processed="false"`, and no other element but `upgradeHandler` / `validateHandler` marked anything but `"false"`; anything else is `{ proven: false, why, reason }` with the reason in fixed words and numbers, never a text the platform wrote. Never throws; a log of more than 8 MiB is not read. `tests/import-job-proof.test.js` holds it to twins of the 347 captured job-row states (`tests/helpers/import-job-logs.js`) — it accepts exactly the 8 final rows of refused imports — and to each clause
    private-folder.js          ← a folder, and a file in it, that only the current user can use — the copy of a settings file that `pac solution import` is given: POSIX modes 0700 and 0600, set and read back; Windows an access list with the current user's SID as its ONE entry (`icacls /reset`, `/inheritance:r`, `/grant:r *<SID>:(OI)(CI)F`, read back as SDDL through `icacls /save`, the file's too before a byte is written; the SDDL aliases of the system accounts are compared as the SIDs they stand for, and `LA`/`LG` — the machine's own Administrator and Guest — only when the machine itself writes the user's SID that way, `spellingOf`), `whoami` and `icacls` looked up in the Windows folder's System32 alone through `process-runner.js`; whatever cannot be set or read back is an error with a `reason` (a tool, a step, a number — never a path or a value) and nothing is written
    exit-cleanup.js            ← a synchronous cleanup that runs if the process ends while a run's work is going — `process.exit`, an uncaught error, SIGINT, SIGTERM, SIGHUP, SIGBREAK — after which the process ends as it would have: BY the signal on POSIX (raised again once our listeners are off), with STATUS_CONTROL_C_EXIT (0xC000013A, 3221225786) on Windows, where a Ctrl+C is a console event and `process.kill` would end it with the status 1 of a failure; a program that has a handler of its own for the signal — one-shot and self-removing ones included, however they were put on the list — keeps the decision (ours is first in line, so that it sees them all, and stays first: a handler the program PREPENDS later is put behind it again before the call returns, `keepFirst`, which never puts back a cleanup that was released while it was being moved); a KILLED process runs nothing, which is its stated limit
    typescript-compiler.js     ← loads the vendored TypeScript 5.8.3 compiler (vendor/typescript/) for the SDK's page compile: lazily, once, only after its bytes match PROVENANCE.json
    spec-lint.js / app-spec.js ← App Spec guardrail lint + validation
    lookup-labels.js           ← a lookup column's default label, environment-facing half: the parent table's label read, the old-default repair's column-label read (one per child table) (the pure rule is `lookupLabelFor`, app-spec.js); `lookup-cell-labels.js` repairs the form cell
    view-filter-labels.js      ← resolves a view filter's Choice labels against the environment's option metadata; the build's pre-flight (skipped for a spec with a localized label) and views-phase gate, the dry run, verify and lint all use it
    spec-shape.js              ← shared structural normalization for both authoring gates
    surface-resolver.js        ← pure: resolve personas[].jobs[].surfaces[] to the spec artifacts that satisfy them
    role-privileges.js         ← pure: declared persona privileges + subset comparison against a deployed role
                                  (also the oracle for `roleGrants[]`, which is additive rather than converged)
    bpf-stages.js              ← pure: which stage and step edits a rebuild applies to a business process flow it reuses, in place (a stage added or renamed, a step added, renamed, rebound, made required or optional, moved) and which it refuses (a stage or step the spec does not list, the stages reordered, names that cannot be told apart, a stage on another table); `inspectBpfStages` / `applyBpfStages` (sdk-build.js) and the change classifier (`stageEditApplies`) all ask it
    odata.js                   ← OData literal escaping helpers
    genpage-sdk.js             ← the one generative-page backend, over the bundled SDK (`makeGenpageSdk(env, deps)`; it replaced the `pac model genpage` wrapper): `enumerateEnv` (every page of the environment, drafts included, with the name its own row holds — `unescapePacName` reads back the `\"` an earlier release's pac stored), `enumeratePages(appId)` (an app's navigation, saved or published layer), `read(id)` (the page as the SDK projects it, from the server), `create` (the id is minted on the client — or taken from a caller resuming a create, which passes what it sent before (`sentBefore`) and hears the new send through `beforeSend(id, { name, sourceSha256 })` before anything is sent — one atomic change set, published and proven; an unknown outcome is settled by reading the id, and sent once more under the same id; a page found under a resumed id is recognised by the name and source a create sent (`holdsWhatWasSent`), and what it still holds of an earlier create is converged by the update path) and `update` (writes only what differs, records the new turn under one identity, publishes — except a page that already holds the content and is given the `publishedFingerprint` of that content as published, which is left as it is (`publish.kind: 'skipped'`); every result of `create` and `update` carries the `fingerprint` of the content, for a caller that keeps one, and — for a caller that asks (`runtimeEvidence: true`) and a page it publishes — the `runtimeSha256` of the compiled output the draft held just before the publish; a publish that fails is returned with the failure itself as a non-enumerable `cause`; an unknown outcome is read, and sent once more only if nothing landed), `placeInApp(appId, { pages, dataSources, finish, finishIfUnpublished, beforeAppWrite })` (an app edit: the page becomes a sub-area of its navigation, and the default public view of each table the page reads joins the app's components — those views and nothing else of the app's components, since the push is limited to what the edit owns (`app-component-scope.js`); `finish` is a caller completing an earlier placement: it publishes the app even when nothing is left to write, and proves the page in the PUBLISHED navigation; `finishIfUnpublished` is the same for a caller with no record of an earlier run — it asks the app: a page the saved navigation already names is left alone when the published navigation shows it, and the app is published, and the page proved, when it does not; `beforeAppWrite` is an async function awaited once right before the call first writes the app — its push, or its publish when there is nothing to push — and never called for a placement that writes and publishes nothing: the build hands it the request that publishes the tables whose forms the app's publish ships, since only the placement knows when it is about to write and what it sends, so it is called with `{ pushes, entityTables, mainFormsByTable }` — whether the app is pushed at all, the tables whose Main forms the push adds (none for an SDK this backend made: its transport limits the push to the views it pins; for a lent SDK, whose push is not limited, the tables of the Entity entries of the navigation the push sends, the server's: `entityTablesOfSiteMap`), and the Main-form list the pushed app carries (a fetched app carries none); the edits are only in the throwaway workspace copy by then, so a hook that throws leaves the app as it was and the call throws what the hook threw), `removeFromApp(appId, pageId, { allowEmpty })` (takes every GenPage entry that names the page out of the saved navigation, whichever area and group; the page, its views and every other entry stay, and no component is added to the app; the app is published and the page proved gone from the PUBLISHED navigation, and a removal that was saved and never published is finished by running it again; a navigation left with no entry at all is refused (`GENPAGE_NAVIGATION_WOULD_BE_EMPTY`) unless `allowEmpty` — the platform accepts one on an app that exists, so this is a judgement, not a rule of the platform), `describe(pageId)` (a page's name, `dataSources` — `null`, not "none", for a page the SDK holds as raw files, which `read` refuses — and the size of its folder and conversation), `delete(pageId)` (the SDK's delete of the project row, its files and then its conversation messages, after the page is read and every app's navigation, published AND saved, is scanned for it — `GENPAGE_IN_APP` names the apps, `GENPAGE_APPS_UNREADABLE` when an app that could hold it cannot be read; what a failed delete did is judged by reading the page again, and "deleted" is only reported once it is read back as gone), `runtimeTypes(dataSources, { detail })` (the SDK's RuntimeTypes generator), `defaultViews(tables)` and `baseLanguage()`, `fileVersions(pageIds)` (the versionnumber of every file row of each page, from the PLAIN collection in chunks of 50 — one `Map<row id, version>` per page, `null` for a page whose rows are none, repeated, or not exact; the publish record's reader, see `lib/page-publish-records.js`; `{ ok: false, error }` when the read fails), `projectVersions(pageIds)` (the versionnumber of each page's OWN row, from the PLAIN collection in chunks of 50 — `Map<page id, version>`, `null` for a page whose row is absent, repeated or not exact: a page's name lives in the row and in none of its files, so a rename moves no file's version), `publishedDiffers(pageId, args, expected)` (what the page's PUBLISHED copy differs from the content `args` names — the source, name, data sources, model and bindings, normalized as `update` normalizes them — read back with plain reads of the published layer, the page's row, its file rows and the bytes of the source and `config.json`, and compared with `planEdits`, the same definition of "holds that content" `update` uses on the draft; given `expected.runtimeSha256`, `compiled output` is named too when the published copy's compiled bytes do not hash to it: `{ ok: true, differing: [field…], fingerprint }`, empty when it holds it, and `{ ok: false, error }` when it cannot be told — no published copy, a failed read, a page not laid out as a page is; the build brackets it with two reads of `fileVersions` and `projectVersions` before it records a publish), `discardWorkspaces()` and `dispose({ waitMs })` (close the throwaway workspace's storage, so work still running cannot write into it or put it back, and remove it once the storage calls under way have settled; the folder is made by `temp-workspace.js`, so one a killed run could not remove is removed by the next run's sweep; both answer `{ left }`, the folders still on disk, and `dispose()` joins every cleanup an earlier call started — within `waitMs` — and also closes the backend). A caller may lend an SDK of its own (`deps.sdk`), whose workspace is then its owner's to close, and whose transport is its owner's too: a page edit through it is not limited to the components it owns. Every page-write error carries `transient: false` and `outcome`, and `pageId` once the write got as far as the send, but one — a throttle (HTTP 429) that outlasted the waits or whose next wait did not fit the run's budget (`throttledError`, carrying `statusCode: 429`, and `retryAfterMs` / `retryNotBefore` when the last answer asked for a wait; a first send refused with a 429 — as a whole request, or as the one failing part of a change set answered HTTP 200 — is waited out and sent again, on the HTTP client's schedule or the answer's `Retry-After` whole, six sends in all, from the budget `args.throttle` carries: `pushThroughThrottle`), which wrote nothing and is left for the build to run again; only a failure that proves nothing was written is `nothing` (`PRE_WRITE_REFUSALS`, a 4xx, a change set whose COMPLETE answer is one 400, 403 or 404: `refusedWith`), every other error at or after the send is `unknown`. The text of a page is made from its bytes once (`sourceText`) and then used as it is. The pure helpers (`sourceText`, `dataSourcesOf`, `pageFolderFiles`, `genPagesOfSiteMap`, `entityTablesOfSiteMap`, `writeOutcome`, `contentFingerprint`, `watchThrottles` — the wrapper that lets the backend read the `Retry-After` of a refused `$batch`, and what a change set refused as a whole proved) are exported for the callers and the tests
    workspace-storage-guard.js ← wraps the SDK's workspace storage so it can be CLOSED: once closed every call rejects, and the calls under way can be waited for (`guardWorkspaceStorage`) — what lets `genpage-sdk.js` remove a folder only after the storage calls that were writing into it have settled
    left-on-disk.js            ← `leftOnDiskWarning(disposed)`: the one wording of "the page workspace could not be removed, so page source may be left on disk: <folders>" — what every command that makes a page backend says when `dispose()` answers a non-empty `{ left }` (verify on stderr and in the result's `warnings`, the others in the result's `warnings` or on stderr), kept apart from the backend so a test that replaces the backend module does not have to replace it too
    genpage-subarea.js         ← `genPageSubArea(base, genPageId)`, `genPageSubAreaId(pageId)` and `GENPAGE_DEFAULT_VECTOR_ICON` (the icon the platform gives a page entry that names none, so a rebuild does not take it for a designer edit): the one shape a generative page has as a sub-area of an app's navigation (`{ ...base, type: 'GenPage', genPageId }`). The build's `appDef` and `placeInApp` — and a script that creates an app around a first page — all build it here
    app-component-scope.js     ← what an edit of an app that is not about its components may ADD to them, held at the SDK's transport (`makeAppComponentScope()`: `wrap(httpClient)`, `limit(appId, { views }, work)`). Every `pushArtifact('app', …)` of an existing app (the bundle's `appApi.update`) PATCHes the sitemap and then posts ONE AddAppComponents whose list it DERIVES: for each Entity sub-area the table, EVERY active Main form, EVERY active public view and EVERY chart, for each DashBoard sub-area the dashboard — whether or not the app has them, and `components.mainFormsByTable` narrows the Main forms alone. AddAppComponents only adds, so a page edit that went through it put back what the app's maker had taken out, and its publish made it live. The bundle is never patched and cannot be told to skip the derivation, so the page backend (`placeInApp`, `removeFromApp`) keeps the SDK's sitemap write and has the post limited where it leaves the process: to the views the edit pins, and — when none is left — not sent at all (the SDK is answered with the service's 204). The action is found by the PATH of the address, percent-decoded as a whole before its trailing slashes are dropped and its last segment is read (a query string or fragment that mentions the name is not it; `AddAppComponents%2F` and `%41ddAppComponents` are it, in another spelling), and every POST is read ONCE while an edit is open — its address as text, its body as the plugin's transport takes it (text as it is, bytes copied, an object serialized as the transport serializes it and read back as plain data) — decided on in that CANONICAL form and sent in that form in every branch (the action it cuts, another app's request, a request to another address, a batch), never the object, bytes or address the caller holds, which the transport would read again: a `toJSON`, a getter or an address that answers differently the second time cannot undo the limit, and JSON text and the UTF-8 bytes of it are parsed for the action. While an edit is open, a request that IS the action in a shape the limit does not read — another spelling of the name, an address or path that cannot be decoded, a body that is JSON text (for a `post`), is not JSON or cannot be serialized, or has no list — or that does not carry every view the edit pins (a view named as a reference, or left out), or a `$batch` that may carry the action, through `post` and `postRaw` alike (a part of a batch cannot be limited: one classifier reads a multipart batch request line by line and a JSON batch entry by entry, each address as any address is read, and a JSON batch after its JSON is), is REFUSED with the bundle's `SdkError` `APP_COMPONENTS_NOT_LIMITED`: not sent whole and not answered as done. A raw POST (`postRaw`: a real POST whose body the transport does not touch, which the bundle uses for `$batch` only) is told by its address exactly as a `post` is, so the action cannot escape the limit by the method that carries it: one to the action's address is limited as the object form is when its body is JSON text of the same object, the UTF-8 bytes of it or an object, and what goes on is a form the transport sends as it is — JSON text for text and for bytes (the transport would send a Buffer as `{"type":"Buffer",…}`), the plain object for an object — with any `Content-Length` the caller declared, in whatever spelling, rewritten to one header with the exact length of what is written; it is refused when its body cannot be read that way. The SDK reports that as a warning of the push ("one or more components were not pinned"), so the sitemap the edit saved stays saved and nothing unlimited reaches the app. A page is a GenPage sub-area, which needs nothing from the app's components, and everything the SDK derives belongs to a sub-area that was there before the edit. The build owns the whole app and never opens an edit; an SDK lent to the backend keeps its owner's transport, and is not limited. Pinned against the real bundle by `genpage-app-edit-real-bundle.test.js` — the re-vendor tripwire for the request's shape, which also pushes the app through the limit — over the plugin's own transport, under a fake service that reads the wire (the body as JSON, a `Content-Length` that must be its length) — with that request changed, or sent through the raw method, to see the limit and the refusal as the user does
    genpage-base.js            ← base-marker hash, compare, and read/write (sibling dotfile of the code file; no environment URL; `appId` is optional — a page created before any app held it is recorded with the page alone, and the first update that names the app it was then placed in goes ahead on that marker and records the app; `unfinished` (`publish` or `place`) is set only by an upload that CREATED the page and did not finish it, and is what lets `genpage-upload.js --page-id` finish exactly that page — it is cleared when the page is finished, and `genpage-base.js record` never writes it)
    safe-fs.js                 ← confined output writes and deletes: the named directory's final component must not be a link or junction (readlink, not a path-text compare, so an 8.3 name and a share root stay usable); write via exclusive temp + rename, or — with `exclusive: true` — never replace a name: the content goes to a sibling file this process created exclusively and is published with a hard link to the target name (which fails if the name exists, so the file system decides and a file that appeared meanwhile is never overwritten: `IO_ERROR` with `reason: 'exists'`; where hard links do not exist the write fails closed, `reason: 'no-hard-links'`), and only that sibling is ever removed — retried, and reported (a warning after a publish, the error after a failure) when it cannot be — and a later write of a file that still has its second name is refused naming it. Every text it writes or appends has the access tokens the process obtained taken out first (`lib/output-redaction.js` `redactOutput`; bytes are written as they are): it is the one writer of the build's journal and status file, of a download's files and of a page's file and its deployed copy. Shared by genpage markers and later callers
    hydrate-spec.js            ← reconstruct an App Spec from a deployed app (edit flow)
    verify-spec.js             ← spec-vs-deployed reconciliation core (checks are ordered tasks on a pool of 4)
    status-reasons-keys.js     ← a table's status reasons (with their states) and alternate keys (with their columns), one narrow read each (`readStatusReasons`, `readAlternateKeys`: `{ state: 'ok' | 'absent' | 'error' }`, never a throw), and the checks of the declared ones against them (`statusReasonChecks`, held to the build's own `statusReasonTargets`; `alternateKeyChecks`) — verify's `status-reason` and `alternate-key` checks
    build-journal.js           ← durable JSONL build journal (resume diagnostics)
    form-preview.js            ← form wireframe renderer
    app-preview.js             ← whole-app design renderer (data model + sitemap + forms + page-intents + design)
    app-spec-doc.js            ← pure App Spec → readable Markdown design doc (model-app-plan.md)
    app-access.js              ← pure: what an App Spec says about who can open the APP (the roles associated with it) and who can use the TABLES it introduces (`personas[]` and `roleGrants[]` privileges): the marks of an existing app a download writes (`existingAppMarkers`), the new tables nothing grants (`uncoveredTables`), which personas get the app and which opt out with `appAccess: false` (`personaAppAccess`), the sentences the lint and the design document share, and the model of what a read of the environment means for the spec (`appAccessModel`: the roles read, each with what in the spec may be it — a `roleGrants[]` entry that gives `roleId` is matched by id and is certain, an entry that names only a role and a persona are matched by name only, as "maybe" — and the grants no associated role matches)
    app-roles.js               ← read-only: the roles associated with an app (`appmoduleroles`) — verify's `appIdFor` / `appRoleIdsFor` (moved here unchanged), and `appRolesOf` for the design document: `{ state: 'read' | 'absent' | 'unreadable' }`, never a throw; the app is found in the saved layer (`resolveArtifact`, which finds a draft), the roles are read through `collectionRows`, and an answer that is no list of roles is `unreadable`, never "no roles"
    schema-facts.js            ← pure data-model provisioning fact extractor for evals
    pageref-resolver.js        ← PAGEREF_<key> → GenPageId nav resolver
    page-manifest.js           ← durable <app>_pagemanifest read/write
    sitemap-pages.js           ← pure GenPageId extractors (the TEXT readers `sitemapGenPages` / `sitemapGenPageIds`, which only refuse or report; `navigationGenPageIds`, which reads the navigation ELEMENTS through `strict-xml.js` and is what a page is deleted by) + fail-closed fetchSitemap MEMBERSHIP reader + navigationProof (page ownership proof, read as navigation, from either app layer — or from the saved layer alone, for an app that was never published and so has no published one) + cross-app scan (every other app's published AND saved navigation — the saved layer in one request — and the apps that were never published, listed in one more; a never-published app with no sitemap component is looked up by the name its sitemap carries); a read that fails is reported by value with the error itself as a non-enumerable `cause` (`withCause`), for the halt raised around it to decide from
    strict-xml.js              ← `readXmlElements(xml, wanted, { spans?, maxDepth?, elementOnly? })`: ONE strict reader of ONE XML document, in one pass, no dependency — comments, CDATA sections, processing instructions and attribute values are data, never elements; anything that is not exactly one well-formed document (or that the SDK's own xmldom would read differently) is `{ ok:false, detail }` with no element at all. `maxDepth` refuses a document nested deeper than the caller allows (each answered element carries its ancestors' names, so depth costs its square), `elementOnly(name)` refuses text, CDATA, comments and instructions directly inside the elements it names; without them nothing changes. With `spans`, each element also says where it is in the text (`start`, `end`), for `formxml-layers.js`. `tests/strict-xml-oracle.test.js` holds it to xmldom over a generated corpus
    formxml-layers.js          ← `sameFormXmlAcrossLayers(published, saved, versions?)`: whether a systemform's saved FormXML (RetrieveUnpublished) is its published one in the languages the published read carries — a caption in another language is set aside, anything else that differs (and a FormXML that is not one well-formed document, read by `strict-xml.js`) is a change; and, for a published read that carries more than one language (the read of a user whose own language is the organization's second one, which orders and words the captions its own way) whose `versions` say the published row and the saved read answer the same `@odata.etag` (the saved layer has not been written since the publish), in everything but the captions, of any language; what verify's dashboard check decides "published" by
    zip-read.js                ← `readZipEntry(archive, name, { maxArchiveBytes?, maxEntryBytes? })`: ONE strict reader of ONE entry of a ZIP archive held in memory, no dependency (`node:zlib`). The archive has to agree with itself — end record, central directory, local header, sizes, CRC-32 — and its entries have to lie end to end, from the first byte to the central directory (each the local header, the data, and the data descriptor its flags announce, with the central directory's numbers), the deflate stream filling its data exactly; ZIP64, an archive in parts, an encrypted entry, a name twice, data that inflates past the size the archive declares, bytes that belong to no entry: a `ZipReadError`. The data is found from the LOCAL header's own lengths (the platform's export has an extra field there that its central directory does not). What `translation-labels.js` opens a translation export with
    translation-labels.js      ← the captions of a solution's forms in EVERY provisioned language, from ONE translation export: `readTranslationLabels(sdk.dataverse, solutionName)` → `{ ok: true, languages, lookup(table, id) }` or `{ ok: false, reason }` (it never throws); `parseTranslationWorkbook(xml)` reads `CrmTranslations.xml`, an Excel 2003 XML spreadsheet, with `strict-xml.js` and rules of its own (the `Localized Labels` sheet is validated whole first — every element and attribute the platform's, in its place — and a row, cell, type or element it does not recognise makes the WHOLE workbook unreadable; depth, name length and element counts are bounded while it reads); `settleCaption(export, { entity, id, lcid, text })` judges one caption (same, different, or unsettled with the reason); `isTranslationExport(method, url)` is the `sendOnce` rule that keeps the request from being sent twice. What `verify-spec.js` compares a tab's or a section's caption with in a language the form's own read does not carry (`readerFor`'s `translationLabels`)
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
    apply-snapshot-store.js    ← changed-only: atomic snapshot write (writeFileAtomic, also the baseline's and the page ownership and publish records', with the access tokens the process obtained taken out of its text, `lib/output-redaction.js`) + workspace lease + invalidate/claim/tombstone/delete + distrust marker. `acquireLease` is the one exclusive-create-and-reclaim protocol for a lock file in a workspace: the snapshot lease (`apply-snapshot.lock`) and the build's pages lock (`pages-<app>.lock`, `sdk-build.js` `acquireAppPagesLease`) both use it, the pages lock with the owner record of `process-owner.js` and a stricter rule for "stale" — a lock left by a build that was killed is released by the next build, which says so (`released the pages lock for '<app>': the build that held it (pid …) is no longer running`), but only when that build is provably gone; a lock whose pid runs, another machine's, one with no readable record, is refused in the words it always had, and none is ever taken by age
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
  vendor/typescript/           ← the TypeScript 5.8.3 compiler the SDK compiles generative pages with (brotli; PROVENANCE.json; licenses)
  _vendor-build/               ← esbuild vendoring tooling (build.js + build-typescript.js + pinned deps)
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
  - **The build** holds no copy of what is deployed (and never downloads a page just for this), so it decides from the page's standing, in the pre-write scan, for each page the run uploads. A page that does not exist yet (`keyToId` has no id for it: it is *created*) and a page that exists but whose source no longer hashes to the `__contentSha` that `last-applied.json` recorded for it at the last apply (*changed*) are held to the check — `pages-griffel-shorthand`, before anything is written. A page whose source hashes to that record (*unchanged*), or that has no record (*unrecorded*), is sent as it is, and the build warns (`opts.warn`) with file:line:column and both remedies. The record is `last-applied.json` read as `opts.baselineSpec` — written by every successful full or changed-only apply and by download, and returned only for this app **in this environment** (`readBaseline`; a snapshot written before it carried those stamps is no baseline), the same hashes the changed-only flow compares. For a page an apply sent, the hash recorded is of the source the pages phase *read and checked* (`created.pageSourceShas`), not of the file when the baseline is written as the build ends: a page a maker saved while the build ran reads as *changed* on the next build, where re-hashing the files would have recorded the edit as applied and let a new key through on a warning. Every page is written as the text the scan read — the SDK takes a page's text, so there is no file for a later save to reach — and a page saved after the scan does not ship: the next build checks it, because the record holds the source that was checked and the file no longer matches it. A page a changed-only run did not send keeps the record it had (with none, the hash of its file as it is). *Unrecorded* — a new, moved or cleared workspace, another environment, or an apply that predates the record — fails **open** on purpose: the release before this check built such pages with the CSS silently dropped, so refusing one now would regress a rebuild that used to complete. The cost is that an edit that adds a key to an unrecorded page is warned about, not stopped, until a build has recorded it; a page that does not exist is always held, record or not.
  - **`genpage-upload.js`** has the deployed page in hand (an update reads it for its base check), so it refuses only what that page did not already have. A create is refused outright. For an update each key is told from the deployed page's by `griffelProblemsNotIn`: only the same key set to the same value in the same place (`within`: its slot, selectors and at-rules — of the same `makeStyles` call, `owner`: the name its hook is bound to at the top of the page, read through a type annotation (`const usePanel: Hook = …` is `usePanel`, not `Hook`) and for a property it is assigned to (`hooks.panel = …`); and the same arm of every condition between the call and the key — `branch` for the call's own argument, and `arms` below it: which of the objects written in a value the key is in, level by level, in a slot, under a selector or in a spread, a spread or a computed key told by its order among those of its object) is the deployed page's own — one set to the same value in *another* place is new, so an edit that removes a key from one place and sets it in another has added one (a renamed slot or a moved rule reads the same, and so does a key moved to another hook's `root` or into the other arm of a condition, at any level: the source cannot tell it from a removal and an addition, and the cost of guessing wrong is a key that ships without its style; where the correspondence cannot be shown — another hook name, another arm, or a call whose name the page does not prove — the key is new, never inherited; hooks that swap places in the file keep their names, so their keys are still where they were). **Only a unique name at the top of the page proves which hook a call is** — not its order among the calls, not the type it is annotated with, not the function it is written in (every function may have its own `useStyles`): a call in a function, a block or a class, in an argument, an array or an object, a default export, or bound to a name two calls share is nobody's (`owner: null`), has no earlier self to be compared with, and a key in it is refused on an update like any new one (delete it, or write the longhands; a file that is the deployed page itself is a re-send and is not compared) — and each deployed key is spent once, so a second `borderColor` where there was one is. A key given **another value** is new too: Griffel drops the new value as it dropped the old one, so the page would show none of the change the maker meant (a value is compared as written — a quoted string by its text, whichever quotes, anything else as its source text with the white space collapsed — and nothing is evaluated, so `tokens.colorBrandStroke1` is that text). A file that *is* the deployed page (a BOM or final CRLF aside) is a re-send, and none of it is new. A key the deployed page already had goes ahead, with a `warnings` entry in the result; a new one is refused, and `--overwrite-deployed` is no way past that (it is about edits made to the deployed page, not about what the file writes). The deployed page can be unreadable only under `--overwrite-deployed`; nothing then says what it had, so the update goes ahead with a warning, as an unrecorded build page does.
  - **A call the checker cannot read** is not CSS Griffel drops, and is not said to be: the message says the check could not read the page's styles, quotes the call, and says what to change in the code (parenthesise the operand, end the statement, or move the call above it). It is never "already there" — what it hides cannot be compared with anything — unless the file is the deployed page itself. And the checker command a message suggests quotes a path that has white space.
  - **`check-griffel-styles.js`** has no notion of what is deployed: it reports every key it finds, a page's old ones included. For a page that already had one, deleting it is the edit that preserves the page (`/genpage`'s edit flow says so).
- **Who runs it.** Three places, so no path to an upload skips it. The orchestrators run it per page, before any transpile or upload, for quick feedback: `/genpage` (single page, multi-page, edit flow, and the §7.5 fix after a browser verify) and `/app-builder` (before `promote-intent-pages.js`, and for a page edited by hand before a rebuild). The page-builder worker has no shell, so its Step 2.6 gives it the rule and a Grep self-review instead. And the code **enforces** it where pages are uploaded, whatever the instructions did or did not get run: `genpage-upload.js` reads the code file first and refuses a create with `code: "griffel-shorthand"` (file, line, column, longhands and what each way out does in `error`, the same list in `problems`; before a backend is made or anything is read from the environment; a file it cannot read is refused) and, for an update, any key the deployed page did not already have (above), and the build's pages phase halts as `pages-griffel-shorthand` in its pre-write scan, before any page is created or updated, for each page that run uploads that is new or changed (a changed-only run checks only the pages it selects; a full build checks every implemented page). Both write the page from the text they checked, never from the file again: the upload script reads the code file once and sends exactly those bytes (an update reads the deployed page and the app's navigation first — seconds in which the file can be saved), and its base marker records their hash; the build writes every page from the text its scan read, and records their hash. `genpage-upload.js` refuses `--compiled-code-file`, since that JavaScript would be deployed instead of the checked TypeScript (the SDK compiles the page itself, from the TypeScript it is given). Both build their text with `describeGriffelRefusal` / `describeGriffelWarning`, so one defect has one wording. It is deliberately not part of `genpage-worker-output.js` / `promote-intent-pages.js`: their failure sends the page back for a full rewrite, and this one is fixed by a targeted edit. The one rule text is the same in `references/rules.md`, the genpage skill and edit flow, the page-builder agent and the app-builder skill, and `genpage-dispatch-contract.test.js` fails if any drops it or the command (and if `verify-flow.md` or the app-builder edit step drops the check).

### DataAPI

The DataAPI (`props.dataApi`) provides typed CRUD operations against Dataverse tables. It uses RuntimeTypes.ts (generated by `scripts/genpage.js types`, which replaced `pac model genpage generate-types`) for type safety. Column names must be verified from the generated schema — never guessed.

### RuntimeTypes

TypeScript type definitions generated from Dataverse metadata. Contains entity types, enum registrations, and the `GeneratedComponentProps` interface. Generated by `scripts/genpage.js types` (the SDK's generator; see "The page verbs" below) before code generation to ensure correct column names.

### The page verbs (`scripts/genpage.js`)

What the skills ran through `pac model genpage` — the listing, the download, the type generator, the placement of a page in an app — and what they had no verb for at all (taking a page out of an app, deleting it) is one script, `node scripts/genpage.js <command> --env <envUrl> [flags]`, over the page backend (`lib/genpage-sdk.js`) and the Azure CLI token every script here reads with. Every command prints ONE line of pure-ASCII JSON and exits 0, or exits 1 with `{ "ok": false, "error", "code", … }` — with `pageId`, `appId`, `outcome` (`nothing` or `unknown`: what a failed write can have done), `apps` (the apps a delete was refused for), `saved` (a placement or removal that was saved and not published), `fileRows` and `conversationMessages` (what a delete that was not confirmed would remove) and `table` (the table `types` found the environment does not have) when they are known; the message is on stderr too, and so are the warnings (`⚠ …`). A mistake in the command line itself — an unknown command or flag, a missing, blank or repeated value, an id that is no GUID, an origin that is no Dataverse origin, a bare switch given a value — is not a result: stderr names it with the usage, stdout stays empty, the exit is 1, and nothing was read or made.

| command | what it does | what it replaced |
|---|---|---|
| `list [--app-id <guid>] [--include-unpublished]` | every page of the environment, drafts included, sorted by name; with `--app-id` the pages the app's PUBLISHED navigation names (`layer: "published"`; `--include-unpublished` reads the SAVED one), in navigation order, each with the page's own name — as the page was given it: pac's `\"` for a `"` is read back, as the build and the download read it — and the entry's `title` as the navigation holds it (`name: null, exists: false` for an entry whose page is not there) | `pac model genpage list` |
| `download --page-id <guid>[,…] --output-directory <dir> [--app-id <guid>]` | `<dir>/<page id>/{page.tsx, config.json, prompt.txt}`, the layout the edit flow reads | `download` |
| `types --data-sources <table>[,…] --output-file <file> [--detail none\|colors\|descriptions]` | the page's RuntimeTypes, from the SDK's generator | `generate-types` |
| `add-to-app --app-id <guid> --page-id <guid> [--title <text>]` | the page becomes an entry of the app's navigation, its tables' default views are pinned, the app is published and the page proved in what runs | `add` |
| `remove-from-app --app-id <guid> --page-id <guid> [--allow-empty-navigation]` | takes the page's entry out of the navigation, publishes the app, proves the page gone | (done in Maker) |
| `delete --page-id <guid> [--allow-destructive]` | says what it would delete — the page, its file rows, its conversation messages — and, with `--allow-destructive`, deletes the page and its conversation | (done in Maker) |

- **`download`** reads every page before it writes a file, so a page that cannot be read leaves the folder as it was. Files are written by `lib/safe-fs.js` (a link, a junction or a hard link at the folder or at a file's name is refused — for every page before the first write, a link whose target is missing included, since the check is an `lstat` and not an `existsSync`, which follows the link — and a file is replaced by a temp file and a rename), and the output names what it `replaced` and a stale `prompt.txt` it `removed` (a page with no prompt has none, which a rebuild reads as "no prompt supplied"). The bytes are the page's own: pac wrote a byte order mark and a final CRLF, this writes neither, and `lib/genpage-base.js` hashes a page with both stripped, so a page downloaded either way hashes alike; there is no `page.js` (the SDK compiles a page itself). `--app-id` is optional (pac required it); given, every page must be in the app's SAVED navigation (`GENPAGE_NOT_IN_APP`), checked before anything is read.
- **`types`** writes the SDK's text as it came (LF, no byte order mark, a blank first line; the output name is checked before the read, a dangling linked folder included). It is the maker portal's own generator, so it is not byte for byte pac's file: it is a self-contained module (the base declarations a page imports are in it, and `GeneratedComponentProps` carries `pageInput`), it leaves out the system and derived read-only columns pac added (the `…name` and `…yominame` ones of a lookup) and the choice enums of columns that cannot be read, and its column order is the portal's. The registrations, row types and `const enum`s are those of pac's file for the columns both type. `--detail colors|descriptions` adds the SDK's comments. A table the environment does not have is `GENPAGE_TABLE_NOT_FOUND` with the `table` it names, not the SDK's `CONNECTION_ERROR`: the SDK reads each table's own metadata (`EntityDefinitions(LogicalName='<table>')`) and its 404 names that request in `url`, and only a 404 of that read, for a table that was asked for, says so (`missingTableOf`; a 404 below the table, from another path or for a table nobody asked for stays the SDK's own error). No file is made.
- **`add-to-app`** asks the backend's `placeInApp` with `finishIfUnpublished`, so it is safe to run again: a page both layers name has its entry left alone, one that was saved and never published is published, and the page is proved in the PUBLISHED navigation. It is not a no-op on a placed page: when the app lacks the default view of a table the page reads, that view is pinned — an app edit, followed by the app's publish — and nothing at all is written only when both layers name the page and no view is missing. Publishing publishes everything the app has saved, a draft app included. The navigation's titles are written in the environment's base language (`baseLanguage()`, as `apps.js` writes them, and as `genpage-upload.js --add-to-sitemap` reads it before it places a page): a title in a language the environment has not provisioned does not show. The entry is titled with the name the page was given, or `--title` exactly as typed. A page edit changes the navigation and the views it pins, and nothing else of the app's components: a Main form, public view or chart the app's maker took out of it stays out — the SDK's own push would add every active one of each table the navigation opens, so the backend limits it to what the edit owns (`lib/app-component-scope.js`). A failure of the publish carries `appId` and `pageId`, and says what was saved: the navigation, the views, or both.
- **`remove-from-app`** refuses to leave an app's navigation with no entry unless `--allow-empty-navigation` is given — a judgement of the same kind as the build's `--allow-destructive`, since the platform accepts such an app. It never touches the page or the views, and it adds no component to the app (the SDK's push of the sitemap would add every active Main form, public view and chart of each table the navigation opens; `lib/app-component-scope.js` limits it to nothing). The publish is part of it: the platform keeps an app's reference to a page until a sitemap without it is published (the teardown's measurement), so the page cannot be deleted before — and that holds for an app that was never published, which the removal therefore publishes, everything it has saved going live, and a `warnings` entry says so. A page neither layer is KNOWN to name — the published navigation was read and does not, or the app has no published form — is `wasInNavigation: false`, nothing written or published. A page the saved navigation does not name while the published navigation cannot be read (what the re-run of a removal whose publish failed looks like) is not reported as done: the app is published again, as `add-to-app` does, `wasInNavigation` is `null` (not known) and `provedPublished` is `false` unless the read-back works; and a lookup the SDK failed before it could tell whether the app has a published form at all is `GENPAGE_APP_UNREADABLE`, nothing changed.
- **`delete`** is refused while any app's navigation — published or saved, every app of the environment — names the page, and the refusal names the apps (`GENPAGE_IN_APP`; Dataverse would refuse the delete anyway, without saying which app); an app whose navigation cannot be read could hold the page, so that is a refusal too. Nothing is deleted without `--allow-destructive`, the plugin's word for a destructive run (as in the build and teardown): the page and the apps are read all the same, and the answer is the refusal `GENPAGE_DELETE_NOT_CONFIRMED` — exit 1, one line, a refusal and not a usage error — that says exactly what a confirmed run would remove, the page's name, its `fileRows` and its `conversationMessages`. The backend deletes only for `allowDestructive: true`, so no other caller can delete by leaving the flag out. The skill that runs it asks the user between the two runs, and suppressing that question never authorizes a delete. It reports what was deleted (`fileRows`, `conversationMessages`) and that the page was read back as gone (`verified`); a history that could not be fully removed is a warning on a delete that happened (`historyRemoved: false`).
- **The documents** run these commands, and `pac-replaced-docs.test.js` holds every command one gives for `genpage.js` to this table (the script's own `VERBS`: the commands and their flags) and the text around it to what the script does: the edit flow lists and downloads with `list` and `download` (the folder's files, no `page.js`, no byte order mark or line break added, `replaced` and `removed`, a `prompt.txt` only for a page that has a prompt), the type generator is `types`, and the three verbs that change an app or delete a page are offered where a document used to send the maker to Maker — an uncertain create (`add-to-app`, `delete`), the build's `pages-shared-across-apps` halt (`remove-from-app`) and its unproven-page halt (`add-to-app`, `delete`) — each with the instruction to ask the user first, since `delete` deletes nothing until it is run again with `--allow-destructive` and an unattended run never does. The build's and the upload's own messages print the command ready to run (`node scripts/genpage.js remove-from-app --env … --app-id … --page-id …` with the other app's id from the scan, `add-to-app`, `delete … --allow-destructive`) where they used to say "in Maker".

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
  plus the UCI and Controls host runtimes, the page `actionBindings` the plugin writes into `config.json`
  (through the SDK: `genpage-upload.js --actions`, and the build), and the `GenUxPluginActionAllowList` ECS setting.
  Note the maker-facing name is "Custom API" while the shipped wire contract stays
  `actionBindings` / `executeAction` (see `references/custom-api.md`).
- **`custom-telemetry`** — the page telemetry facade in the UCI host runtime, the GenUX
  authoring control (power-platform-ux), the AIBuilder CoderAgent telemetry prompt, and the
  `GenUxEnableCustomTelemetry` ECS setting (see `references/page-telemetry.md`).

## TSX source lexer — known limits

**`scripts/lib/source-literals.js` — known limits.** It is a hand-rolled TSX lexer, not a
parser. The plugin does ship the TypeScript compiler (`scripts/vendor/typescript/`), but only the SDK's page
compile loads it, and lazily: unpacking it takes ~15 ms and evaluating it ~200 ms, with ~20 MB of heap
(`lib/typescript-compiler.js`) — more than a hook that runs after every code write (`hooks/validate-icon-imports.js`, a
new process each time) or a gate that reads a page before it is deployed should pay, so those read source with
this lexer. It tracks
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
  (the misreads that this lexer refuses). **A line whose last token before the `//` leaves a regex open is read through the regex that the next line's `/` begins, and the page resolves where that regex cannot be part of a program that parses** (`regexFailsInAType`): a line
  whose last token is a `[` that nothing closes on its line (`[ // note` and a line break, then `/path`), an initializer's `=` after a `?`, a type, a computed name or in a parameter list (`m? = // note`,
  `m: A = // note`, `f(a = // note`, `[ x = // note`), or an operator in such an expression (`m: A = b + // note`). A regex that its line does not close is unterminated (TS1161); one that ends at the `/` of the closing tag, whose name is its flags (`/b</p>`:
  the body `b<`, the flags `p`), is followed by the tag's `>`, a comparison that wants an operand — so where the tag is followed by the end of the text, a `;`, `)`, `]`, `}`, `,`, `:`, a closing tag, an operator that goes between two operands (`*`, `%`, `&`, `|`, `^`, `?`, `=` and
  `>` after white space, `+=`, `-=`, `!=`, `<=`, `<<`) or a reserved word that starts no expression (`const`, `return`, `if`), TypeScript rejects every type that has the text; and one that closes before the closing tag (`/a/b</p>`) is followed by `</`, a token of its own in a .tsx
  file that no operand goes on with. Only the element compiles then, wherever the head stands (`source-literals.test.js` asks the parser for every token after the tag, and `valid-page-differential.test.js` for every position). **Where a member of a type may begin at the head, these
  lines are still refused after the guess `generic`, though only the element compiles in some, and the base may have resolved them**: a closing tag that an operand may follow — a name, a number, a string, a template, a bracket, `+`, `-`, `!`, `~`, `/` or `<`, `.5`, `#x in y`, `@d class {}`,
  `new`, `typeof`, a word that is a name where no keyword starts one (`let`, `as`, `yield`), and, right after the tag's `>`, an `=` or a `>`, which make `>=` and `>>` — where the line ends its member (`m? = // note`, `m: A = // note`) the initializer holds the regex, the `>` and the operand,
  and both programs compile (the pairs of `valid-page-differential.test.js` are the proof), and for the lines that need a closer (`[ // note`, `f(a = // note`) a closer later in the text makes a computed name or a default that holds them; and a path with a `/` of its own and text after it
  (`/a/b/c more text`): the regex ends at the second `/`, and what a type makes of the rest — a division, names, a `<` — is a parser's to say. 2.13.0 takes the word that ends the comment for the token before the `/`, which resolves the page of the element and rewrites the data of the other.
  Their shape cannot be told apart without a parser: `return <p>(a);` and a line break, then `[ // note`, is the same text in an interface that has a method named `return` and in a function that returns an element, and `return <T>(x)` and
  `m? <T>(x)` are why no place that a member may begin is excluded (above) — where none can stand at all (the braces of a function, a block, the top level, parentheses or brackets: `membersMayStandAt`) the element is the only reading. A line that ends in a `[` after a `:` or a type is none of them, since a tuple's or an indexed access's first type is no `/` (`Total: [ // note`: TS1110), and is certain
  in every place. Also refused, though no type compiles with them (the sweep lists them): a `/` or `/=` after the tag, which begins a regex that may close later, and `==`, `===`, `>>>` and `>>>=` right after it, which join its `>`. After an `=`, a `(`, a `[`, a `:` or an `=>` the same lines are certain (`NO_MEMBER_BEFORE`),
  and these lines are certain in every place: a name, a keyword or a signature and a `(` that is not closed on its line (`foo( // note`, `if ( // c`, `m(see docs) // c`: TS1138 at the `/`, TS1003 or TS1005 in the list), and a name, a number, a
  string or a signature with a `=` right after it on its line (`x = // note`, `1.5 = 1 // c`: TS1131). What the reading does not follow — a conditional type, an expression, a decorator, a `{` — leaves the type undecided, and the
  page is refused only where an opener after it (a `/` after an operator or an open bracket, a quote, a back-tick) could hold the closing tag. `valid-page-differential.test.js` with `BASE_LIB_PATH` fails on a page of its corpus that
  2.13.0 resolves and this lexer refuses, and it reports how many pages of the member-position lines 2.13.0 resolves (they are not in that corpus: they are the class above). Put the call before the text, or write the line with one name before the `//`.
- **Type parameters that start like an element's head are read as the type they are where the text after the list decides, and are a guess where the closing tag could be hidden** (`signatureHeadFollows`): type parameters that start with a modifier — a variance modifier
  (`<in U>(y): void`, `<out U>`, `<in out U>`) or one that only the checker rejects (`<public U>(y): void`, `private`, `protected`, `readonly`, `static`, `abstract`, `async`, `declare`, `override`, `accessor`: the twelve of `TYPE_PARAMETER_MODIFIERS`, which a test measures against
  the parser over every keyword; no other keyword is one), any number of them in a run, with `const` among them in either order (`<const in U>`, `<in const U>`: one more modifier of the parameter) — a modifier takes its name on its own line, and only `static` takes it across a line break
  (`<in` and a line break, then `U>` is an element's head) — an empty list (`<>(y): void`, `new <>(y)`), and a method named `delete`, `typeof`, `void` or `instanceof` that has type parameters (`delete<U>(y): void`, `typeof<U>()`), where a member of a type, a class or an object literal
  may begin at the word. A member begins after a separator (`{`, `}`, `;`, `,`), after the words that the parser takes before a member's name (`MEMBER_PREFIX_WORDS`: `abstract`, `accessor`, `async`, `const`, `declare`, `export`, `get`, `in`, `out`, `override`, `private`, `protected`, `public`,
  `readonly`, `set`, `static`: a test derives them from the parser in an interface, a type literal, a class and an object literal), after a generator's `*` and after a decorator (a class member's), and on a later line after any token that may end a member (a name, a keyword, a closing bracket, a
  string, a template, `++`, `--`, the decimal point of a number); after a token that wants its operand (`=`, `=>`, `:`, `(`, `[`, a prefix operator, `+`, `&&`, a conditional's `?`) a line break changes nothing, and the word is an operator (`const e =` and a line break, then `void <span>(x)</span>` is the `void` of an element).
  A `,` or `;` is a separator of members only in braces: inside parentheses or brackets (`f(a, void <span>…</span>)`, a `for` head, an array) and at the top level of the source no member begins after one — no member stands there at all, nor in a block: the braces of a function or a method (a `)`
  before the `{`, but not the end of an element of a class's or an interface's heritage: `class C extends mixin(A) {`, `extends (B) {`, `extends new X() {`, `implements B() {` and `extends A, B() {` have members — the parser reads each element of the list as any left-hand-side expression, and a call after
  `implements` or a comma is one, a class expression among them — with its own head, its braces and the decorators before it, `class C extends class {} implements new @d class {}, B() {` — as much as any other; a call after a comma that no heritage list holds, as in an object literal, `{ a: 1, m() { … } }`, is a method's head, and a comma that the lexer cannot read back to the keyword that begins its list leaves the braces to hold members; the word before the `(` is
  a heritage keyword only where the head of a class or an interface leads to it, read back to `class` or `interface` — `class C implements (B) {` — and is a name where a `{` that nothing closed, a `;`, a `:`, an `=`, a modifier or a decorator stands before it: `class C { implements() { … } }`, `{ extends() { … } }`
  and `{ a: implements, m() { … } }` have the body and the head of a function, and a name read whole, with a letter beyond ASCII or a `#` in it (`{ a: café, m() { … } }`, `{ a: this.#item, m() { … } }`), no more makes a comma a heritage's than an ASCII one does; a Unicode escape, which is its own guess, and a window that ends
  first leave the list open; a class or an interface that is complete before the name or the comma — the value of a property, `{ Adapter: class extends Base {}, render() { … } }`, the initializer of a field, a declaration that no `;` ends, `class Q {}` and a line break, then `function implements() {}` —
  is crossed whole by that scan, braces and head, so that its own `class`, `extends` and `implements` are no heritage of what follows (a head that ends in a name, a call, a `]`, the `>` of type arguments, a `!`, a literal or the `}` of a class expression leads back to its `class`, through no function and no braces but the bodies of class expressions — `{ a: class extends class {} {}, m() { … } }` has the braces of its base in its head, which are crossed as the head of the element they are, with the base's own head and the decorators before it (`new @d class {}`), no more than four class expressions deep (`HEAD_NESTING`) —; a `{` after `extends`, `implements`, a comma, `new` or an operator is an object literal's, and the braces of an arrow function or of a function are read back to no `class`);
  what stays the guess side is a class whose head holds braces that no class expression owns — a function expression or an object literal for the base or for an element of the list (`{ a: class extends function () {} {}, m() { … } }`, `class extends {} {}`), a class expression with type arguments after it (`class extends class {}<T> {}`: the guess `brace`) and a chain of more than four class expressions, each the base of the one before it — which is refused with the guess rather than read, a known residual: parenthesise the base. A field named `new` that a line break ends — `class C { new` and a line break, then `render() { … } }` — is a field and a method (`newNamesField`), and the call after the `new` is a method's head, not an element of a heritage: the braces around the `new` are the body of a class, read back to its `class`, a member may begin at the `new` (after the start of the body, a separator, a modifier or a decorator) and no keyword or comma of a heritage list is before it, so that `class C extends new` and a line break, then `Base() {`, the same after `implements` and after the comma of `extends A,` have members, as before. What stays the guess side is a `new` that no member of a class begins (the operator that starts a statement in a function, `new X()` and a line break, then a block; a property `x.new` that ends a field's initializer; a private name `#new`) and a field of a class whose head is not read (its base a function expression)), of `if`, `for`, `while`, `switch`, `catch`, `else`, `try`, `finally` and `do`, and the braces that follow a `;` outside parentheses and brackets (`membersMayStandAt`, `blockBraceAt`).
  Every other brace may hold members and is not taken for a block: a class after its name or its heritage, an object literal, a type literal, the block of an arrow function (`=> {` is a function type's object type as well), the substitution of a template, the braces after a `}` or a `:`, and after a name that a keyword
  spells (`class C extends a.else {`) or that an escape, a `$` or a letter beyond ASCII cuts. A decorator ends where a name, a literal, a closing bracket, the `>` of type arguments or the decimal point of a number stands whose `@` is
  at the same level of brackets, with nothing but names, dots, `?.`, `!` and closed brackets between them (`@dec`, `@a.b()`, `@(x)`, `@dec<T>()`, `@dec<T>`, `@1.`, ``@tag`x` ``); a number's digits stand alone after anything but a name or another number, and so after the white space that TypeScript skips between two tokens, a no-break space or a line separator among it, as after a space (`@` U+00A0 `1.`, `a =` U+2028 `1.` and a line break: a character beyond ASCII that the scanner skips, `isTrivia`, is no part of a name); `@dec<T>` is an instantiation expression, which the parser takes for one before a binary operator — a generator's `*`, the name `instanceof`, a field named `in` — or a line break (`@dec<T> *delete<U>() {}`), and the `>` of an arrow or of a comparison ends none; an `@` earlier on the statement says nothing about a token inside its arguments, after an `=` or in a method body that follows it.
  The same goes for a word that takes an operand before a line break (`void`, `typeof`, `delete`, `in`, `instanceof` and the rest of the words that begin an expression): `const e = void` and a line break, then `void <span>(x)</span>` is an operator and its operand, and a line break after the word ends a member only
  where the word is the name of one (`interface I { void` and a line break, then `void<U>(y): void`), a type or a name after a `:`, `|`, `&`, `=>`, `.`, `as`, `satisfies`, `is`, `keyof`, `readonly`, `unique` or `typeof` (`a: void`), or one of the three words that are names as well — `await`, `yield` and `of`, which
  a class field may be initialised with outside an async function or a generator (`class C { a = await` and a line break, then `delete<U>(y) {}`): an element after those words is refused where it can hide its closing tag and the braces may hold members (the block of an arrow function, the value of an arrow in an
  object literal); in the body of a function, a method or a block it is read for certain. A test derives both lists from the parser.
  The rule for a `<` where an expression starts reads each head as an element (a reserved word or a second name, no name, an operator that takes an element), and in a type the parser reads the type parameters of a call signature, a
  construct signature or a method, whatever the words are (the checker objects). Both programs share their text up to the list, and what follows it tells them apart: the children of an element end at its closing tag and fail at the `}` that ends the type, so a type is read for certain where
  nothing in it holds the closing tag of the head (a typed API interface, `interface Api { list<T>(): Promise<T[]>; delete<T>(url: string): Promise<T>; }`, or a method that has a return type or a body, in an interface, a class or an object literal); an element where only an element has the text;
  and the guess `generic` where a string, a template, a comment or a regex of the type could hold it (`<in U>(y): void; a: '</in>;navigateTo(…);//'` is a type, and an element when that `</in>` ends it) — a navigation call after the type is then refused, naming the guess (put the call before
  the type). That holds after a method's body too: a body is code that no reading of a type's members follows, so a comment, a string or a template after it that holds the closing tag (`class C { delete<U>(y) {} // note </U> …`) is the guess, and a body that fails as an element's text (a
  statement) is a type for certain. A list that no element has (`<in U, out V>`, a default, a constraint that holds a brace) is a type wherever it stands. A head that the readings cannot end in one place is the guess `generic` and is not decided: a string with an escaped quote in it
  (`<in U="\">">(y): void` — a JSX attribute string has no escapes and ends at the next quote, a type parameter's default is a JavaScript string — read from the wrong end, the text after the head is not the text after the list), a self-closing head after `extends` whose `/` begins a regex that
  closes on its line (`<in U extends />;…/>(y): void`), and a head with a comment or a character beyond ASCII in it, which neither reading reads — and a name written with a Unicode escape (`delete<\u0054>(): void`: the parser reads the type parameter `T`, and the name of a tag or an attribute
  holds no escape, TS17021, so the head is a list and no element; the lexer reads none of it and names the guess `identifier`). Where no member of a type may begin (after an `=`, a `(`, a `[`, a `:` or an `=>`) no call or construct signature stands, but a generic
  function type does (`callback: <in U>(y: U) => void`): the head is a type where an arrow follows its parameter list and the text between them fails as an element's (the guess `generic` where an element could hold the arrow, in an attribute string), and an element where the list is read to its end and no arrow
  follows it. The same holds where no member can stand at all — after `return`, after a comma in parentheses or brackets, and at the start of a statement in a block or at the top level (`membersMayStandAt`): `return <in U>(y); // note</in>;` is an element, for certain, whatever the text after its list could hide. It is asked only
  where the reading would be a guess, so that a head that is read without it costs no lookback; a list that cannot be read, and a head with a comment in it, are guesses wherever they stand. A list that cannot be read to its end — a template with a template or a comment in a substitution, a regex after a call in a default, an element or a regex that a default holds, a list longer than the window — shows no arrow and rules none out
  (``callback: <in U>(value: `${`prefix`}`) => void`` is a function type): the guess `generic`, as it is for a head that is no modifier's, and a navigation call after it is refused. Where the `<` is known to start an expression (a default value after an `=`) the rule's answer is the only one, and the head after one of the four words where the word is an operator
  (after an `=`, an operator, `return`, a `(`: `delete <U>(y)</U>` deletes an element) is an element. A `:` after the list is read through for these heads only: for `<U>(y): T` and `<const U>(y): void` it stays the guess `generic` of a call signature with a return type (above).
  A `{` after the list is read as a method's body for these heads, and for any head right after a word or a `?` (`class C { new <U>(y) { return y; } }`, `m?<U>(y) {}`; `in<U>(y) {}` is the guess `operator`: a method named `in` or the operator). **Not changed, and refused
  as before**: a method named by any other keyword that a `:` follows (`in<U>(y): void`, `new<U>`, `return<U>`), `get<T>(…)` and `set<T>(…)` (`keyword`), `await<U>`, `yield<U>` and `as<U>`, `delete?<U>(y): void`, a method with a body that holds a template, a line break before one of the four
  words after a `/`, `>>` or `>>>` (the `/` may end a regex that a member precedes, or divide; the `>` may close type arguments or compare), and a type in the style of JSDoc (`a: A?`), which the parser reads and the checker rejects (TS8020), so that no page that builds has one.
  (The same words in a *nested* tag, `m(p = x <a in b> '</a>' + '</T>…')` or `m: Array<keyof X>`, are read both ways: `tagMayBeCode`.) `type-parameter-heads.test.js` asks the parser for each list of words and tokens above and for each reading; `ambiguity-sweep.test.js` reads a seeded
  grammar of heads in members, function types, elements and after line breaks (`helpers/type-head-pages.js`), the element after `void`, `typeof` and `delete` with every kind of line break before the word and after a word that takes an operand, a decorator or a `,` in parentheses, the function types whose
  parameter list cannot be read to its end, the type parameters written with an escape, and a method named like an operator in every kind of braces (every heritage of a class or an interface that ends in a `)`, after `extends`, `implements` or a comma, an object literal after the `;` of a `for` head, a type literal after an `=>`), after a decorator that ends in the `>` of type arguments or in a decimal point (after white space of every kind: every character that the parser skips between tokens), and a method or a function named `implements`, `extends` or `new`, and the value before a method after a comma (a letter beyond ASCII, a private name, a word that spells a heritage keyword, a class that is complete, one whose base is a class expression), and a field named `new` that a line break ends, before a method.
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
  it is not trusted, and its token is reported rather than rewritten. A run of operators is walked in a loop and
  never by a call for each (a few thousand postfix `!` overflowed the call stack once): a page of 20,000 of them is
  read, and the braces that hold the statement are looked for from where the run begins, so that the run does not use up the window: a function's or a method's body is read for certain at any length (the block of an
  arrow is the guess `generic` whatever it holds, as for any statement in it).

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
- A **boolean flag** (`--publish`, `--exact`) is in `known` and not in `needValue`, and `parseArgs` still takes
  the next word for its value: `--publish yes` leaves `flags.publish === 'yes'`, which `=== true` reads as
  "not given" — a publish that silently never happens, and a swallowed word. A script with one refuses a
  value (`--publish takes no value (got 'yes')`) before it does anything (`apps.js`, `list-tables.js`).
- `parseArgs` keeps only the **last** of a repeated flag. A flag that repeats on purpose (`apps.js create
  --page-id`, once per page) is read from `argv` by the script (`pageIdArguments`), which also refuses an
  occurrence with no value that a later one would hide.

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
the PATH emptied, the same test shows what a machine with no `az` gets. `fake-apps-org-preload.js` does the
same for `apps.js` and `list-tables.js`, but gives the plugin's real az-token client a fake Dataverse
(`fake-apps-org.js`: apps in both layers — an app row is in the published layer by default when its
`componentstate` is 0, and `published` says otherwise, as for a published app with a saved edit — pages,
solutions, sitemaps, tables, setting definitions and the app settings the SDK writes, which are unpublished
until their app is published; it records the requests the process made into a file), so the real client and
bundle run too and a test can see that a refusal sent no write. It records the SDK's `$batch` change set too —
a multipart body, kept as the text it is, with its `operations` — and answers one of deletes by id, so the
SDK's atomic rollback of a failed create is run for real (`batchResponse` builds the platform's wording of an
answer to a change set: the fake's own, when it applies one, and the refusal a test asks for; a test that loses the
answer replies with a 502 JSON body itself). It can also refuse chosen requests (`refuseWhen`: a method, a path
pattern and, with `nth`, only the nth such request), so a run that fails half way — the second
`AddSolutionComponent`, say — can be driven end to end.

`fake-verify-preload.js` is the smallest of them: it replaces the four things `verify-model-app.js` would reach an environment with — the
HTTP client, the SDK factory, the page backend and the verification itself (`FAKE_VERIFY`: what the verification answers, and the folders
the page backend says it could not remove) — so `verify-model-app.test.js` runs a completed verification as a process (the real script, spec
validation, throwaway workspace and printer) and reads the bytes it wrote, which a refused spec alone cannot show.

`queued-stdio-preload.js` changes how a process WRITES rather than what it reaches: it gives the script the stdout and stderr a pipe gets on
Linux and macOS — sockets over descriptors 3 and 4, whose writes are queued when the pipe cannot take them at once — on every platform (Node
makes a pipe on descriptor 1 or 2 synchronous on Windows, so a Windows run with its own stdout never shows what `process.exit` does to a queued
write). Spawn with `stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']` and read `output[3]` and `output[4]`; `result-whole-before-exit.test.js`
and `printers-whole-before-exit.test.js` use it to read the text a printer that exits right after writing megabytes delivers. That text is not
what proves the fix: how much of it a printer without the blocking call loses depends on the runtime and on how far the reader reads ahead —
`printers-whole-before-exit.test.js` holds its reader back by pausing its streams, which does not stop the runtime reading below them, and on
Windows a megabyte from such a printer arrived whole under Node 20 and cut at 65,536 characters under Node 22. The proof is the ORDER:
`write-order-preload.js` records, inside the process, each `setBlocking(true)` on stdout's or stderr's handle and each write to them, and the
tests require each stream to be made blocking before its first write — which fails on every run for a printer without the call, on every
platform and runtime. The texts are megabytes long without a command line that long: `huge-failure-preload.js` makes the plugin's flag check
answer, or its argument parser throw, with such a message, and `fake-auth-check-preload.js` refuses `check-auth.js`'s WhoAmI with such a diagnostic.

`scripts/tests/helpers/run-with-fakes.js` (`runScript(script, argv, { platform, pac, files, read })`) is the wider
form, for a script that reads connections, connector metadata or deployment settings. The child runs over a fake
Dataverse, Business Application Platform and Power Apps service (`fake-power-platform.js`, installed by
`fake-power-platform-preload.js`, which replaces the token reads and the transport and nothing else) and, when the
test gives it a script, over a fake `pac` (`fake-pac.js`) that is the only thing on `PATH` — with none, the machine
has no `pac`. It returns the exit status, the stdout lines, the requests the fakes saw, the state they ended in, and each
`pac` call with the files it was handed, so a test can assert what the platform received and that a secret reached no
output.

**Testing the generative-page backend:** `lib/genpage-sdk.js` is tested at three levels. Its LOGIC — what it does with each answer the
SDK can give, including the ones a real server cannot produce on demand (a lost answer, a request that never arrived, a `VERSION_CONFLICT`)
— runs against an in-memory stand-in for the SDK calls it makes (`scripts/tests/helpers/fake-genpage-sdk.js` → `FakeSdk`, with scripted
`push` / `fetch` / `publish` / `list` behaviours) in `genpage-sdk.test.js` and `genpage-sdk-app.test.js`. The REAL vendored bundle runs against
a stateful fake of the tables behind a page (`helpers/fake-genpage-server.js`: project, files and conversation messages, drafts, etags,
atomic `$batch` change sets, a publish that rotates every token) in `genpage-sdk-real-bundle.test.js` and in the real-SDK tests of
`genpage-upload.test.js`. That server also injects the faults a real one produces: a lost response after the commit (`afterCommit`), a whole `$batch` refused with a
status (`failBatch`, a 429), and a request still in flight when its client gave up on it (`strandBatch`: the client sees a timeout, and the change set commits only when
`landStranded()` is called — after the read that looked for it, and perhaps beside its resend); a refused `$batch` may carry headers (`failBatch` answers a status, or `{ status, headers }` for a throttle with its `Retry-After`: the waits of a throttled page write are asserted against them, with the backend's `sleep` and `random` seams recording the waits instead of taking them), and so may a refused PART of a change set (`failOn` answers a status, or `{ status, headers }`: the answer is HTTP 200 with the one part that failed, which is how the service refuses a change set as a whole); with a workspace storage that can be filled or held (`ENOSPC` after the commit,
a write stopped half-way) they drive the unknown-outcome races and the disposal-while-working cases against the real bundle. The build's pages phase is run twice over one
workspace against the real backend in `sdk-build-pages-deploy.test.js` (a create whose answer is lost and whose page cannot be read, then the next build; and an unchanged rebuild, a rebuild after a failed publish, a rebuild that changes one page, a page published from another workspace, a page saved as a draft only, a file row added or removed and a record with no versions, each counted in the requests the page service received — change sets, `PublishXml` and the reads of the files' and rows' versions — against the record in `lib/page-publish-records.js`, whose own cases are in `page-publish-records.test.js`, the reader of the files' versions in `genpage-sdk-file-versions.test.js`, the evidence of the proof — the pages' own rows, the compiled output of the draft at the publish and of the published copy, and the failure a result carries — in `genpage-sdk-publish-proof.test.js`, and the read-back of the published copy in `genpage-sdk-published-copy.test.js`; and another writer that publishes over a page before, while and after the build reads its published copy back — its source, or its compiled output alone — or renames it, which leaves the page unrecorded so that the next build publishes it; and a page write the service throttles, which the backend waits out inside the phase, or which the build runs again when the throttle outlasts the backend's waits — with the wait the service asked for carried across that change of layer, and the waiting those two layers do, with the production HTTP client's own waits for a throttled read or publish, one budget of five minutes, with each layer's waits recorded in one list: two reads and two page writes throttled for a minute are waited out inside it, ten minutes of throttling are not (the build stops with the budget's halt), a read the budget has no room to wait for is handed back as the 429 it is and stops the build the same way, through the engine's own backend and client — as does the read before an update, and the read of a page a pending create left behind, which are the throttle's refusal and neither an unreadable page nor a conflict — and a client given no budget waits as it always did). The build's retry is held in `halt-retry-policy.test.js` (every halt in the sources against a table, raised by the production code with a label that reads as a transient error, and the real retry loop counted: a refusal runs once, a 429 or a 503 four times; the real SDK's answer to a read of a table called like a lock — a 403, a 400 or a 404 that echoes it runs once; and, through the production HTTP client and the real SDK, a certificate failure whose alternative name spells a reset runs once and a reset runs again), `retry-policy.test.js` (the rule, with the SDK's own `ConnectionError`: a status that is not transient is final whatever the answer echoes, a condition is named by its documented error code and not by its words, a transport failure is decided by Node's own code before its words), `throttle-budget.test.js` (the budget), `throttle-client-budget.test.js` (the wiring that gives every client of a run the one budget: the page backend's, the build's and the upload script's), `throttle-engine-stop.test.js` (the engine's runner: no step starts after the budget has refused a wait, and the name column length a run owes is still paid — in the settlement of a halted phase and in the pass that completes one, where the budget's refusal of the first of two tables' updates leaves the second's set and its key for the next run — and a step the runner stopped before it began is never taken for a length that was set (`runBestEffort`'s `onFailure`); the column change set that stops the phase instead of falling back is held against the real SDK in `table-columns-in-create.test.js`, as are the two owed lengths, through the build as well) and `sitemap-pages-cause.test.js`. And a test of a CALLER — the upload script, the build's pages phase, verify, download, teardown — takes the backend
as a seam and is handed `fakeGenpage(options)` (`helpers/fake-genpage.js`), which answers what the real backend answers (a name read from the
environment, a page created under a minted id, a read that fails) and records every call. `scripts/genpage.js` is tested at four levels: its command line, what each verb asks of the backend and prints, and what download and types write, against that stand-in (`genpage.test.js`); the backend's page verbs — `describe`, `delete`, `removeFromApp`, `runtimeTypes`, `defaultViews`, `baseLanguage` and the placement that finishes only when the app does not show the page — against `FakeSdk` (`genpage-sdk-verbs.test.js`, with a world of apps for the scan a delete makes) and against the real bundle over `appTransport` (`genpage-verbs-real-bundle.test.js`: the app's saved and published layers move as the operations claim) — and over an app whose navigation opens a table and whose maker took a Main form, a public view and a chart out of it (`helpers/fake-app-components.js` laid over `appTransport`, which answers an AddAppComponents for another app as for an app that does not exist; `genpage-app-edit-real-bundle.test.js` reads the AddAppComponents bodies a placement, a removal, a pin, an upload and the build's pin send: the views they pin and nothing else — `appTransport` alone has generative pages in its navigation only, where the SDK derives no component, which is how a page edit that put the excluded ones back went unseen; `app-component-scope.test.js` holds the limit itself — what it reads by path (percent-decoded) and what it refuses, for a `post` and for a raw POST alike, and the canonical form it decides on and sends in every branch (an object that serializes itself, an address or body that answers differently the second time, the `Content-Length` it declares, an encoded address, a `$batch` — classified the same through `post` and `postRaw`, a JSON one entry by entry), the latter also over the plugin's own transport (`helpers/wire-framing.js` gives the `Content-Length` Node's client would send) — and `genpage-upload-language-real-bundle.test.js` the language an upload titles its entry in, in a German-only environment, and what is said when it cannot be read while a placement is being completed); and the script as a PROCESS (`genpage-process.test.js`: the exit code, one ASCII line on stdout, the words on stderr, the bytes written, and the workspace removed before the process ends) over the real bundle with only the HTTP client replaced (`helpers/fake-genpage-preload.js`, which takes the pages, one app, the org's languages and a refusal from `FAKE_GENPAGE` and writes what the run did to `FAKE_GENPAGE_LOG`). `apps.js create`'s view pins run through `fake-apps-org.js`, which seeds a page fake from its `pages` (`dataSources`, `raw`) and answers a table's default view from `views`. `genpage-no-pac.test.js` scans the production
scripts for a page verb of `pac model genpage` (an allowlist: only the connector verbs `list-connector-operations` and `get-connector-schema`, which read a
connector and not a page, may stay on pac), the retired wrapper and a second shape of the page sub-area.

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
and timeouts, and a call that does not succeed hands back its answer — and throws the text of a transport failure —
with the access token taken out (whole and by part: a service that rejects a token may repeat it, and callers print
what fails), by the same scrubber the Dataverse HttpClient uses; a success is returned as it came. Reach for `httpClient` only when you must share the exact client instance the SDK is
using — and check first that the SDK has not since grown the method, as it did for entity privileges.

**What a script writes is cleaned where it is written — not in the answer, and not in what the SDK raises.** A service that rejects an access token may repeat it, whole or by a part, in a diagnostic — spelled however its
gateway wraps and escapes a long value — and the SDK quotes it: into the message of an error (a change set the service refuses as a whole is answered HTTP 200 with the one part that failed, a success to the HttpClient, and the SDK
quotes that part into the error it raises), into a warning it returns, into the data of an answer. The answer is the caller's: the strict `$batch` readers count its bytes (`completeBatchStatus`, the page backend's refusal proof,
and the retry that follows from it), and rewriting it changed what they prove (a refusal read as unproven became proven; a throttled page write went from two sends to six). An error is not the place either: the text has more
roads out of the SDK than anyone can list (a message, a stack, an object beneath it that may be frozen or hold an accessor that must not be run to look, a warning in a result), and a guard on the errors misses the roads that
are not errors. Every one of those roads ends in the same few places, and there the text is a string: `lib/output-redaction.js` keeps every access token the process OBTAINED (noted where it is read from the Azure CLI and where a
client sends it) out of everything the process writes, and changes nothing else — the SDK's errors, warnings and results, and the service's answers, are exactly what they were. The output paths it covers:

| What the process writes | How the token is kept out |
|---|---|
| stdout and stderr — every `console.*` call, every script's result printer and warning printer, the progress lines, a library's own output, the SDK bundle's | `process.stdout.write` and `process.stderr.write` are wrapped when the first token is noted (a process that has none is untouched); text only, bytes pass. `emitResult` cleans its own text too, so a result is clean where a caller has replaced `write` |
| what Node itself prints when an error ends the process (an uncaught exception, an unhandled rejection) — it never passes through `write` | a handler prints it, cleaned, with the same exit status, when nothing else handles the error (a test runner has its own listener and is left alone) |
| the build's journal and status file, a download's spec and pages, a page's file and its deployed copy, a plan, the settings template | `writeFileSafe` and `appendFileSafe` (`lib/safe-fs.js`) clean the text they write |
| the apply snapshot, the baseline `last-applied.json`, the page ownership and publish records | `writeFileAtomic` (`lib/apply-snapshot-store.js`) cleans the text it writes |
| every file of the SDK's workspace — artifacts, their metadata, the manifest | the SDK writes them through `writeTextAtomic` and through nothing else; `lib/maker-sdk.js`, the one factory, wraps the storage it is given |

`output-token-writers.test.js` lists every other write of file content in the plugin and says why none of them can carry a token (each writes what the plugin made itself or a person gave it, or runs in a process that obtains
no token), so a new writer fails there until it is classified; it also pins that the one raw write to a descriptor is `solution-settings.js`'s own, and that no script pipes a child's output to a stream. A token is looked for as
the text SPELLS it: one character at a time, each the character itself or an escape of it, with a fold between any two (white space, `\r\n` as JSON writes it, a run of backslashes for JSON inside JSON, a stray backslash, a
terminal colour code, the quote-plus-line-break `util.inspect` prints between the pieces of a long string, in colours or not), and an escape that can also be a literal backslash and its letters (`\n` before a part that starts
with `n`) read both ways — in one linear pass over the text, every needle (the token and each of its parts of 24 characters or more) at once, with a bounded set of the second readings beside it (a text that would need more is
refused, and the writer fails closed: a stream writes a notice, a file is not written), the whole span becoming `<token>` so that JSON that was written is JSON still. Not read: other encodings of a token (percent-encoding,
base64, entities), a token another process obtained, bytes (a Buffer a writer is given is written as it is), a token written in two separate calls to `write`, and the end of a part a formatter cut short (`util.inspect`
prints at most 10,000 characters of a string). Observe the boundary at the process's descriptors and files — `output-token-boundary.test.js` runs real processes (`tests/helpers/token-boundary-child.js`), in colours too — and not by replacing `process.stderr.write` in a
process of your own, which replaces the guard itself. `output-redaction.test.js` holds the matcher (against an exact reference that follows every reading over random spellings, JSON validity, cost on a large text and on texts made of nothing but escapes), the registry and the guards,
`output-token-real-bundle.test.js` the real bundle and the production client (the SDK's error is the SDK's own; the answer reaches the SDK byte for byte as the service sent it; a page write whose refusal proof and sends are
those of a client that takes nothing out). `solution-settings.js` keeps its own guard on what it writes (below), which stacks with this one. The pcf plugin carries the copy of the module and notes the tokens it reads; its
`pcf-push.js` writes its receipt through it and `makePcfSdk` guards the SDK's workspace (`plugins/pcf/scripts/tests/pcf-push-token.test.js`), and it has no SDK call that writes through a change set.

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
  The suite runs in a temporary folder of its own (TEMP, TMP and TMPDIR point into it), and the run
  FAILS when a test leaves a file or folder in it, naming what was left: a test removes everything it
  makes. `scripts/tests/helpers/temp-dirs.js` (`makeTempDir`) is the shared way — require it at the top
  of the test file, and the folders it makes are removed after the file's last test. The folder the suite
  runs in is the plugin's own, so the run FAILS too, naming the folder, when a test makes a
  `.maker-workspace` there that was not there before the run (a build opens `<app folder>/.maker-workspace`
  unless it is given a workspace, so a test must never hand a build `process.cwd()`; `sdk-build.test.js`
  gives a build that names no app folder one of its own). The runner removes such a folder only when it is
  empty, so that the next run is not blind to the leak; one with anything in it, a link or a file is left where it
  is and the run says so (`kept`), since it cannot tell a test's folder from the workspace of a build another
  process started beside the suite and deletes nothing it cannot show to be its own — delete it by hand.
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

**The TypeScript compiler the SDK compiles generative pages with is vendored too** —
`scripts/vendor/typescript/` (`typescript.min.js.br`, its `LICENSE.txt` and `ThirdPartyNoticeText.txt`, and
`PROVENANCE.json`), loaded by `scripts/lib/typescript-compiler.js` and passed to the SDK as
`MakerSdkOptions.typescript`. The SDK compiles a page's source itself on every push that changes it — TypeScript's
`transpileModule` plus its checker, to resolve enum names — and accepts only the minor version the maker portal compiles
with (5.8; another is refused with `GENPAGE_COMPILER_VERSION`), so a page is stored as the portal would store it. That compile is a
transpile, not a type check: a page with type errors, or a reference to a column its table does not have, compiles and deploys, and only
a page that does not parse, has no default export or imports a value `RuntimeTypes` does not hold is refused
(`genpage-sdk-real-bundle.test.js` runs it against the real bundle). The page-builder's Step 2.6 says so, and
`genpage-dispatch-contract.test.js` pins the sentence and scans every instruction for a claim that the compile type-checks. The
SDK's bundle holds no TypeScript (`_vendor-build/build.js` keeps it `external`), and a plugin install has no
`node_modules`, so the plugin ships the official `typescript@5.8.3` `lib/typescript.js` — only that file: the compile
reads no `.d.ts` — minified by esbuild as a SCRIPT (as a module esbuild renames the top-level `var ts`) and
brotli-compressed: ~0.8 MB on disk instead of ~8.7 MB. It is unpacked and evaluated lazily, once per process, only when
a page is compiled (~15 ms and ~200 ms), and its bytes are checked against `PROVENANCE.json` before it runs.

```bash
# Rebuild it (only when the SDK moves to another TypeScript) — from repo root:
npm pack typescript@5.8.3 --pack-destination <dir>
node plugins/model-apps/scripts/_vendor-build/build-typescript.js --tarball <dir>/typescript-5.8.3.tgz
```

`build-typescript.js` refuses a tarball that is not the pinned one (npm sha1 + sha512) and a source file that is not the
pinned SHA-256, checks that the minified file still loads both as a function body and as a bare script, and writes a
`PROVENANCE.json` with no timestamp, so a rebuild from the same tarball writes the same files.
`scripts/tests/vendor-typescript.test.js` checks every committed byte against that provenance, that a copy which does not
match it is refused before it runs, and that the vendored compiler emits exactly what the official package emits for the
pages in `scripts/tests/fixtures/vendored-typescript/` (their `.expected.js` were written by the unminified package).

**Vendored-SDK contract invariants (regression net).** When you bump the SDK and re-vendor, the
skill relies on behaviors that must survive. The test files below lock them — run all against every
rebuilt bundle.

**pcf copy sync.** The pcf plugin copies selected model-apps helpers and the vendored SDK bundle
because plugin installs are isolated. `scripts/validate-plugin-copies.js` is the source of truth for
that list and enforces it in both suites plus the every-PR metadata workflow. If you change one of
those sources, copy the corresponding file into `plugins/pcf` in the same PR; re-vendor in model-apps
first, then copy the resulting SDK bundle.

**Re-vendor from a COMMIT, and check the recorded provenance.** `scripts/_vendor-build/build.js`
writes `scripts/vendor/PROVENANCE.json` next to the bundle: the upstream SHA, whether
that package had uncommitted changes, and the bundle's own sha256. Two things make this
load-bearing rather than bookkeeping. First, the bundler consumes the SDK's **gitignored `lib/`**,
a build output that can be arbitrarily older than `src/` — a bundle shipped in this repo was once
built from a stale `lib/` several commits behind its nominal source, and nothing could reveal it.
The bundler now **refuses** (exit 3) when `lib/index.js` predates the newest `.ts` under `src/`.
Second, "built from master" is not provenance, because master moves; the SHA is what lets a
reviewer reproduce the artifact. Re-running the build on the same inputs must reproduce the same
sha256 — check it.

⚠ **`commit` is the commit the bundle was BUILT FROM — normally master's HEAD — and is usually
past the change you are taking up.** The record carries no commit subject: the subject of that commit
named whatever merged last, which is usually not about the SDK, and in a public file it told a reader
nothing. The SHA is what identifies the source, and `sdk-async-surface.test.js` fails if a `subject`
comes back. So do not read the SHA as a description of the uptake — name the change in
`CHANGELOG.md` instead, which is where a reader looks for what actually arrived.

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
and a String field get DIFFERENT classids — the adapter defaults them from attribute type, so the
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
first `try` after the call that makes the directory (`makeTempWorkspace`, or `fs.mkdtempSync`), in the same
function — so a cleanup elsewhere in the file neither
satisfies the check nor breaks it by changing shape. The read-mostly scripts (`apps.js`, `list-tables.js`,
`list-languages.js`) do not write that out: they share `lib/throwaway-sdk.js` (`withThrowawaySdk`), which
`tests/throwaway-sdk.test.js` holds to the same rule by making each thing fail — a constructor, a storage, a
module, a client, a run — and looking for the folder; the scripts' own stub tests run that helper for real
and stub only the SDK and the client it builds (its `deps` seam).

**A `finally` cannot help a run that is killed outright** (SIGKILL, "End task", an agent's timeout), and
what it leaves holds the source of every page it read and the environment's address (the `pac` work folder of
`solution-settings.js`: a settings template, an exported package or a copy of the settings file) — so no entry point
makes its folder with `fs.mkdtempSync(path.join(os.tmpdir(), …))`: each calls `makeTempWorkspace(prefix)`
(`lib/temp-workspace.js`; `tests/throwaway-sdk.test.js` and `tests/temp-workspace.test.js` scan for a script
that does not). It puts the folder, named for the process that made it and holding an owner record, in a folder of the plugin's own in the temp
directory, and the first workspace a process makes removes the workspaces of runs that are PROVABLY gone
(`lib/process-owner.js`), saying so on stderr; a run that may still be going (its folder is not even opened), another machine's, and a
folder with no readable record are left alone. A run that is cut short by `process.exit` or an error nothing catches removes its own workspaces — not a lent one —
in its `exit` event, before the plugin's folder when that is empty, so only a killed or signalled run leaves one for a sweep (a POSIX signal runs no JavaScript, and a listener for it
would replace its default action in every script: `lib/temp-workspace.js` says why that is not done; `tests/temp-workspace.test.js` ends real children each way,
beside another run's workspace and among runs that make and remove workspaces). A sweep looks at no more than 500 entries and removes no more than 100, and the entries it looks at
move on from one sweep to the next — a cursor, one small file in the plugin's folder, written whole and there only while the folder holds more than a
sweep looks at — so that a folder whose first 500 entries must be kept does not hide a dead run's workspace, or a removal a kill left half done,
behind them for good (`tests/temp-workspace.test.js` builds that folder and sweeps it in one process and in new ones). `tests/killed-run-workspaces.test.js` kills a real page
backend mid-run and runs another, kills a real run that made its scratch folder LENT to a program that outlives it (the program
is kept, and the folder with it, for as long as it is young — also while the record cannot be read, which on Windows is shown with a
real exclusive hold on it), and kills a real sweep half way through a removal, which the next sweep finishes;
`tests/temp-workspace.test.js` keeps every kind of workspace the sweep
must leave and races it against live processes, which it must never take a folder from, and holds real files open in a dead run's
folder (a folder that cannot go yet is still recorded for the next sweep — Windows with Node 20 is where that matters, and the
suite runs there). **Whoever hands a path in a workspace to a program of another make makes the workspace with
`makeTempWorkspace(prefix, { lent: true })`** — decided when it is made, never later — so that a sweep
does not take the folder from under a program that a killed run left running. A CLI test that
replaces `fs` replaces this maker too, with the very call the script used to make (as
`tests/ai-preflight.test.js` does). The same proof of death lets the build release the pages lock a killed
build left in the app's workspace (`tests/pages-lock-dead-owner.test.js`, real processes again). It proves
nothing it cannot show: on Linux a pid that is not found is "gone" only where the record and the reader both
name the same pid namespace, and a record whose start or namespace is not well formed is not believed
(`tests/process-owner.test.js` has the table). The plugin's own folder is optional — where it exists and will
not take a workspace, or (Windows) its access list lets someone else change it or someone else owns it
(`tests/windows-folder-acl.test.js`: the SDDL reader on its own, and the real `icacls` and PowerShell, with a grant to Everyone that
applies only to what is made inside the folder, a folder of the system's, and a folder made in a temp folder everyone can write to), the workspace is made in the plain temp
folder as before.

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
delete everything except `last-applied.json` (the navigation baseline), `destructive-approval.json`
(the approved removals), `web-resource-unconfirmed.*.json` (the durable ids of web resources whose publication
could not be confirmed: a later build must rewrite and verify those same rows, not create again or reuse stale
published content) and the `page-ownership.*.json` records (a page's creation receipt, a teardown's
record of the pages it is deleting, and the `pending` record of a page create that was started and never
answered — the only trace of a page that may still land: without it the next build creates a second page
for the spec entry), which no re-run can rebuild. The build does not reset the copy itself: the
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
- **An app header write is never unconditional** (`scripts/tests/app-ai-description-real-bundle.test.js`,
  `scripts/tests/app-header-text-real-bundle.test.js`). The
  SDK writes the app's name, description and routing description conditioned on the appmodule ROW token a
  fetch read, even when its own read of the header fails (the header PATCH carries only the texts that changed:
  `name`, `description` and, when one is supplied, `aiappdescription` — and every text its copy holds when that read
  fails; the icon is written at create only). A header edit made while it
  holds no token throws `APP_UPDATE_NO_ETAG` before anything is written (it used to send the PATCH plain,
  which overwrote another writer's header). The plugin edits an existing app's header only on a copy it has
  just fetched, and only its text (`name`, `description`: `applyAppHeaderText`) and the routing description
  — the icon and the unique name are written at create and never again — so the
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
- **The environment's languages come from the SDK** (`scripts/list-languages.js`,
  `lib/lcid-cultures.js`; `scripts/tests/list-languages*.test.js`, `lcid-cultures.test.js`).
  `getEnvironmentLanguages()` makes three reads — the organization's base language,
  `RetrieveProvisionedLanguages()`, `RetrieveAvailableLanguages()` — and touches no workspace; it is strict, so
  a response of an unexpected shape throws `ENVIRONMENT_LANGUAGES_UNREADABLE` and a failed read throws its own
  error. The planner runs the script: it prints one pure-ASCII JSON line with the base language and, for
  each provisioned language, its LCID, culture code and whether it is right-to-left. The SDK returns numbers
  only, so the host maps them with a table of Windows' own culture data; an LCID the table does not name stays
  numeric (the base language's too), is reported in `unmapped` and on stderr, and is never given a guessed
  code or direction. The script writes nothing and emits no telemetry of its own.
  **There is no `pac` behind it.** Before the script existed, and for a release after it, the planner ran
  `pac model list-languages --environment '<envUrl>'` when the script exited non-zero, so that a page over existing
  entities or mock data needed no Azure CLI. Every `/genpage` page operation now goes through the SDK and needs the
  Azure CLI, so that fallback bought nothing and is gone. A failed read is the end of language detection: the script
  exits 1 with an `ok: false` line carrying the SDK's code and never prints an English default in the place of an
  answer. The SDK reports a missing Azure CLI, a slow one, a token another tenant refuses and a dropped connection
  alike, as `CONNECTION_ERROR` (`statusCode` 0, or the HTTP status of a refusal), so no code tells them apart and a
  caller decides by the exit status, never by the wording of a message. `pac-fallback-commands.test.js` pins that no
  script runs the command, and `pac-replaced-docs.test.js` that no document names it (README's account of `az` — needed for
  every page operation, and no `pac` fallback for the languages — is pinned in `list-languages.test.js`). The plugin's own `readProvisionedLanguages` /
  `readOrgLanguageCode` (`lib/dataverse-auth.js`) stay: they run before an SDK exists (it needs the language
  at construction) and fail soft, where the SDK's read is strict.
- **The environment's apps and tables come from the SDK** (`scripts/apps.js`, `scripts/list-tables.js`;
  `scripts/tests/apps.test.js`, `apps-real-bundle.test.js`, `list-tables.test.js`,
  `list-tables-real-bundle.test.js`, `pac-replaced-commands.test.js`). They are the replacements for
  `pac model list`, `pac model create` and `pac model list-tables`: no production script runs any of the
  three (a source scan pins it), and no skill, agent, reference, README or doc names them either
  (`pac-replaced-docs.test.js`: an allowlist of the `pac` commands a document may still name — `pac auth`, `pac org who` (of the `org` family only
  that), `pac help` and `pac model genpage list-connector-tables`, in any letter case and as `pac.exe` or `pac.cmd` — and, for the eight scripts that replaced a `pac` command, a table of
  the subcommands and flags each document may give them, checked against the scripts' own; this file, which is guidance too, is scanned by the same test — it may name a replaced command or a
  fallback in as many sentences as it needs, and no other `pac` command, and never offered as a command to run — a line that is a command (a bare one, a prompt, a list item, also with the command in
  a code span: ``- `pac model list` ``) or one right after a positive imperative ("run", "use", "call" …) is offered; a prohibition ("do not run `pac model list`") and a statement about the command
  (``- `pac model list` was replaced by `apps.js list` ``, ``- `pac model list` → `apps.js list` ``) are not, and a code span that begins a hard-wrapped sentence is not a list item; it has to keep naming the offline settings
  template's `pac solution create-settings`, which the allowlist names as an exception; the changelog, being history, is not
  scanned). Each prints one pure-ASCII JSON line, writes a usage error to stderr alone (exit
  1, stdout empty), and reports a failure as `{ ok: false, code, error }` with the SDK's own code and message — `code` is the
  SDK's when it has one: a failure that is the script's own, such as a list that fails because the platform answered a row with
  no id, prints `{ ok: false, error }` and no `code` (`list-tables.js` gives its own: `TABLES_UNREADABLE`, below). The
  real-bundle tests drive the real client, the real bundle and the real script over a fake Dataverse
  (`tests/helpers/fake-apps-org.js`) that records every request, and the same fake, through a
  `node --require` preload, a real process.
  **Tables.** `findTables(term)` is one read of `EntityDefinitions` and a substring match of the term over
  the logical, schema and display names in any letter case — `pac`'s `--search`, measured to give the same
  tables for the whole list and for five searches — and never the entity set name (pinned). `--search` takes comma-separated terms; each is read as
  `findTables` reads it (one read of the whole list per term: the SDK keeps no list between them), at most
  four reads at a time (`READ_CONCURRENCY`; the platform limits what one user may have running), and the
  answers are joined, a table once, in the order of the terms whichever read finishes first. `--exact`
  keeps only the tables whose logical name is a term and lists the terms that have none in `missing` — what
  the planner did by hand with the substring matches — from ONE read of every table, however many terms,
  in the order of the terms: the SDK's substring rule is not applied for it, so there is no copy of that
  rule to keep in step. `--type custom|standard|all` (default all) is `pac`'s own filter: `custom` is the
  SDK's own option, `findTables(term, { customOnly: true })` — the same single read of the definitions,
  filtered inside the SDK on the platform's `IsCustomEntity` flag before the term is matched, so a table a
  managed solution brought counts as custom, as it does in `pac` — and `standard`, for which the SDK has no
  option, is the rows its answer does not flag as custom. Under `--exact` a term naming a table of the other
  type is `missing`. The real-bundle tests pin that `--type custom` is exactly what
  `sdk.findTables(term, { customOnly: true })` answers, and the stubbed ones that the script passes that
  option and filters nothing of its own for `custom`. Without `--search` and `--type` the answer is every
  table (about 200 KB for 1,700): the planner's dominant-prefix read, which wants only the custom tables,
  can ask for `--type custom`, and a caller that needs a few tables searches for them.
  **An answer that is no list of tables.** `findTables()` reads a 2xx answer with no `value` list as `[]`
  (`body.value ?? []`), and the HTTP client keeps a body that is not JSON as text, so a sign-in or proxy page, `{}`
  and `null` all read as an environment with no table — and `--exact` would then report every searched table as
  `missing`, which the planner reads as "create it". The bundle is not edited, so `lib/maker-sdk.js`, the one way a
  script makes an SDK, hands every SDK a client whose read of the table list (`/EntityDefinitions?…`, which only
  `findTables()` makes) is held to being a list (`lib/collection-answers.js`): a 2xx answer that is no
  `{ value: [...] }` fails `TABLES_UNREADABLE` — an `SdkError`, which the bundle rethrows as it is, so a caller reads
  `error.code` — with a message that says what the answer was (never its text) and that it is not an empty
  environment. Only `{ "value": [] }` is an empty answer, and no request is added or changed. Only a 2xx is judged: a
  refusal, a redirect or a 4xx stays the SDK's own `CONNECTION_ERROR` with the platform's status. `list-tables.js`
  prints it as `{ ok: false, code, error }` (exit 1). Four more callers turn the table list into a decision, and each
  meets that failure where it used to meet an empty environment. **The build's flow name check** (`sdk-build.js`: does
  a table already hold the name the flow derives) is a diagnostic that never stops a build, so it goes on to the create
  as it does for any failed read, and now says so (a warning that names the flow and the table name).
  **`findExistingTable`** (`entity-provision.js`, the data-model phase and the dry run's plan: reuse or create) decides
  by the narrow `EntityDefinitions(LogicalName=…)` read when that is conclusive, and falls back to the list when it is
  not; it halts the build before it creates that table (`BuildHalt`, `table-list-unreadable`, as it does for a localized
  table above, and `RETRY.NEVER`: a run again reads the same answer, and signing in again is the maker's) and the plan
  says `unknown`, where "no tables" created a table that may exist. What earlier steps wrote (the solution, a global
  choice, the tables before it) stays: it is a halt, not a preflight. **The teardown's table step**
  (`sdk-teardown.js`: a system table to leave alone, or a custom one to delete) fails closed: the step fails with the
  reason and no delete is sent, while teardown's other steps run as usual. Read as "no tables" it skipped the
  system-table check, and where an environment answers every request with a page it answered the DELETE with one too,
  which the SDK takes for done and `tolerateNotFound`
  for gone — a table reported deleted that nothing deleted; any other failure of that read keeps its documented
  handling, and the delete goes on. **The verifier's catalog** (`verify-model-app.js`) fails the verify, where "no
  tables" reported every declared table missing. `apps.js list` (`collectionRows`: `no readable result set`) and
  `list-languages.js` (the SDK's strict reader: `ENVIRONMENT_LANGUAGES_UNREADABLE`) were probed with the same bodies
  and do not have the hole. `unreadable-collection-answers.test.js` runs those three over the real client and the real
  bundle, and `list-tables.js` in a process (`helpers/fake-raw-answer-preload.js`);
  `unreadable-table-list-callers.test.js` runs the four callers above, each over the real bundle and a fake that
  records every request, and pins that the normal path sends the same requests as the bundle's own factory does.
  **Apps — list.** The SDK's `fetchArtifactList('app')` reads
  `/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()` (the current layer of every app, one
  never published included) but keeps only each app's id and name, so the script reads that collection
  itself with `componentstate` and the unique name; `apps-real-bundle.test.js` pins that its request is the
  SDK's own with that one column in place of `aiappdescription`, and that the two lists name the same apps, so a
  re-vendored list that carries the columns retires the read. That layer says which rows exist, not whether
  users can open the app, so the script then reads the published layer (`/appmodules?$select=appmoduleid`,
  paged, once per list) and reports two facts, apart: `published` — the app has a published row — and
  `unpublishedChanges` — it has a saved row that is not published (`componentstate` 1,
  [Unpublished](https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/appmodule);
  null when its rows name no state). Measured on a real environment: a draft app is one saved row (1) and no
  published row (`published: false`, `unpublishedChanges: true`); a published app with a saved edit answers
  ONE saved row (1) while its published row is still there (true, true); a published app is one row (0)
  (true, false); a managed app a solution import brought in is one row (0) with a published row whose
  `publishedon` is empty (true, false). **`pac model list`'s "(Saved - Not Published)" is not the reverse of
  `published`.** It marks an app whose published row has no `publishedon` — a time only a publish
  (`PublishXml`) sets — so a managed app an import brought in, which is live, carried the mark, and a
  published app with a saved edit did not (measured on all eleven apps of an environment). For the apps a
  skill makes the mark meant "never published", which a skill reads as `published === false`;
  `unpublishedChanges` is something `pac` never said. The saved layer is read first, so an app published
  between the two reads shows as published with changes (a combination real apps have), never as neither. The
  cost of that order is an app deleted between the reads: it is in the first answer as published (`componentstate`
  0) and not in the second, so it would read as neither — a pair no app has — and it is left out of the list
  (a draft deleted in that window cannot be told from one still there, and is listed as it was a moment ago).
  A pending edit can also answer two layers: the authored one (1) is the app — `currentLayerRow` in
  `lib/app-components.js`, the one place that rule is written for a listing (`currentLayerRows` is the strict
  form its other callers refuse on).
  **Apps — create.** The SDK refuses an empty navigation group (HTTP 400, "SiteMap needs to have a
  non-empty Area with a non-empty Group"), which `pac model create` got round with an empty group, so the app is
  created with the pages it opens on and `--page-id` is required (create the first page without an app, then
  the app). Every check runs, and every read, before the first write — no page id, a page id that is not a
  GUID or is given twice, a name, description or unique name the platform would refuse (lengths from the
  appmodule table, a unique name of letters, digits and underscores), a solution that does not exist or is
  managed, a page that is not in the environment (saved-only pages count: the read is
  `RetrieveUnpublishedMultiple`), a unique name an app or a leftover sitemap already has (an app and its
  sitemap share the name, and a sitemap an app was deleted without keeps it), a base language the
  organization does not answer — and each is `{ ok: false, code, error, written: false }`
  (`PAGE_ID_REQUIRED`, `PAGE_ID_INVALID`, `PAGE_ID_DUPLICATE`, `NAME_TOO_LONG`, `DESCRIPTION_TOO_LONG`,
  `UNIQUE_NAME_INVALID`, `SOLUTION_NOT_FOUND`, `SOLUTION_MANAGED`, `PAGE_NOT_FOUND`, `UNIQUE_NAME_TAKEN`,
  `LANGUAGE_UNREADABLE`) with the platform's state unchanged (the real-bundle tests compare it before and
  after). The unique name is what `pac model create` derived — the display name lower-cased, runs of
  anything but a-z and 0-9 as one underscore, `_` and 8 hex digits, no publisher prefix — unless `--unique-name`
  is given. The Microsoft Learn page "Create, manage, and publish model-driven apps using code" says the
  platform prefixes the solution publisher's prefix to the unique name on creation; the names `pac model
  create` actually made (three apps, measured in a live environment) carry none, so the derivation follows
  the measurement. Do not "correct" it to add a prefix without comparing the `uniqueName` this script prints
  with the platform's row for an app it created. The navigation's titles are written in the environment's base
  language, which a second SDK
  instance is made with (`languageCode` is a construction option), never an assumed 1033. The icon is the
  system's default icon web resource, as the Power Apps documentation gives a new app: left to the SDK, an app is
  bound to whatever image web resource it finds first, which can belong to another solution.
  The writes, in order: the SDK's create and push (the app row, its sitemap, the sitemap pinned as an app
  component, the System Administrator role association, and the app setting `HeaderAndNavigationRefresh` =
  2 — below), `AddSolutionComponent` for the app (80) and the sitemap (62) — skipped for `Default`,
  `Active` and `Basic`, which hold every component already (the output says `systemSolution: true`, with
  `inSolution` empty: a create into `Default` needs no add and did not fail) — and, only with `--publish`,
  one `PublishXml` naming the app. The app is addressed by the id the push answers with (`pushed.id`), as
  the build addresses it: the SDK moves the workspace key to the server's id when the two differ. The
  sitemap's id is chosen before the write (`AppArtifact.sitemapId`, the SDK's own field), so after a create
  that worked nothing reads the app back. The app is created unpublished (`published: false`) so that
  `--publish` means what it did to `pac model create`; this is the one script that does (see "Left off"
  below). The success output carries the two facts of `list` — `published` and `unpublishedChanges` (true
  and false after `--publish`, false and true without it) — and `inSolution`, each of `app` and `sitemap`
  as its `AddSolutionComponent` lands (`addedToSolution` is true only when both did).
  **The app setting.** The SDK's create makes every new app with the new header and navigation ON
  (`headerAndNavigationRefresh` is true unless the definition says false; a public preview) and writes that as the
  app setting `HeaderAndNavigationRefresh` = 2: `POST appsettings`, bound to the app and to the environment's
  setting definition of that name, inside the push — after the role association, before the SDK's own
  publish step and everything this script adds. It is written at create only (an edit or a publish never
  writes it), and only when the environment has that setting definition: without it the SDK adds a warning
  ("App setting 'HeaderAndNavigationRefresh' was not applied …", in `warnings`) and the app is made all the
  same. The row is saved, not published: `RetrieveUnpublishedMultiple` (and the SDK's `getAppSettings`)
  read it, and a plain read of `appsettings` finds none until the app is published — so a draft app made
  here has no setting row for a plain read (measured), and an app made with `--publish` gets the setting
  with the app. `pac model create` wrote no such setting, and the script adds only the app and its
  sitemap to the solution, never the setting. `apps-real-bundle.test.js` pins the request, its place in the
  sequence, the warning for an environment without the definition, and that a plain read does not see a
  draft's row while the SDK's own does.
  **A failure after the push began** reads the platform back before it answers: the app by its unique name in
  both layers (the saved and the published one) and the sitemap by that name. A row is this create's by its
  ID, not by the name: the app's id is the one the SDK minted before its first write and sent as the new row's
  key (so the row is at that id or does not exist) and the sitemap's is the one the script chose. A row that
  holds the unique name under another id belongs to another create — two runs under one `--unique-name`: the one
  that reaches the platform second is refused as a duplicate and writes nothing — and reporting it as this
  create's leftover would point a skill that offers to remove what a failed create left at another maker's app.
  It is named apart instead (`nameTakenBy`: `{ appId, sitemapId }`, each only when found; a retry with that
  name is refused while the row exists, and it is not this create's to remove). The SDK rolls a partial create
  back when it can, and a rollback can be refused (the rows are KEPT), lost (the SDK says "unconfirmed") or not
  needed, so neither "something was written" nor "nothing was" follows from how far the run got. `written` is
  true when something of THIS create exists (its app or its sitemap), false when the read-back found neither,
  and null when no row is known to exist and one could not be read; `left` says of each of the two rows
  whether it is there (true, false, or null when it could not be read and nothing else says); `appId` is only
  this create's app, and only when it exists, with its own `published` and `unpublishedChanges` when both
  layers were read (a publish the SDK reported as failed that the platform took reads as published);
  `sitemapId` is always the id the script chose before its first write (it is the one on the wire); `stage` is
  `create`, `solution` or `publish`; and `inSolution`, `addedToSolution`, `systemSolution` are as for a
  success. The reads are made in turn — the saved layer, the published layer, the sitemaps — and the first
  that fails ends them; the create's own error is still the one reported (a failure of the failure never
  replaces it), beside `readBackError` and `lookFor` (the unique name, the id the create used, the sitemap's
  id). A read-back that cannot be made keeps what the run knows: a push the SDK reported as saved (the stage
  is `solution` or `publish`) wrote both rows, and a row that a read found before a later read failed is
  there, so `written` is `true` and `left` says what is known. `written: null` is for a run that knows of no
  row that exists and could not read one, and `left` is then absent (nothing was read) or has a `false` beside
  a `null` (the app was read and is not there, the sitemap could not be). A failure before the push (in the
  workspace only this run sees) is `written: false` and nothing more. The SDK's `warnings` on the push (the
  System Administrator role it could not associate, say) are kept for a run that fails after it too: in the
  failure payload and on stderr, as for a run that succeeds. The tests run the SDK's own rollback — one
  `$batch` change set deleting the app and its sitemap — against the fake, with the change set accepted,
  refused (both rows kept) and answered by a lost reply, and compare what is printed with what the fake
  platform holds; a create that loses the race for its unique name, and a read-back that fails part way, are
  run against the real bundle too.
  **The reads the SDK has no method for** — the apps, the pages by id, the sitemaps by name, each from
  `RetrieveUnpublishedMultiple` through `sdk.dataverse` — go through `collectionRows` in
  `lib/app-components.js`, the one reader of a paged collection (`apps.js` asks it for `CONNECTION_ERROR`,
  the code the SDK reports its own reads under, where the app-component reads keep
  `APP_COMPONENTS_UNVERIFIED`). It follows the absolute `@odata.nextLink` the platform gives through the
  client's `getAbsolute` (`DataverseClient.get` puts the API root before what it is given, so handing it
  the link makes `/api/data/v9.0/https://…`, HTTP 404), reports a refusal with the label, the status, the
  URL and the platform's own message (`the model-driven apps: HTTP 403 from <url>: <message>`), and fails
  closed on an answer that is no list, a link that is no link and a page that repeats. A client with no
  `getAbsolute` (a test fake) is handed the link as it is. `app-components.test.js` pins it, over a fake and
  over the real client with a paged fake Dataverse.
- **Connections, connector metadata and deployment settings come from the SDK, with `pac` behind them only where
  the SDK refuses** (`scripts/list-connections.js`, `connector.js`, `solution-settings.js`; `lib/sdk-first.js`,
  `lib/power-apps-service-client.js`, `lib/pac-fallback.js`).
  - **The rule** (`lib/sdk-first.js`). The script asks the SDK. It asks `pac` the same question only when the SDK
    refuses with a code that says *this route does not serve this environment, cloud or input*, and the output
    says that it did (`connectionsSource` / `connectionsFallback`, `source` / `fallback`). Any other failure is the
    script's own, printed with the SDK's code and never answered by `pac`: an answer from somewhere else, when the
    first source is broken, hides that it is broken. The SDK never falls back by itself; this is the one place a
    script does. The throwaway workspace the SDK needs is removed before `pac` is asked. The refusals:
    - connections and connector reads — `CONNECTIVITY_NOT_CONFIGURED` (an org in the Test cloud, which the SDK
      reads only through the Power Platform API; the plugin gives the SDK no client for it, see below, so it refuses
      before any request); `CONNECTIVITY_CLOUD_UNSUPPORTED` (an org outside the Public and Test clouds — GCC, GCC
      High, DoD, China, a custom domain or a port — before any request); `CONNECTIVITY_ENVIRONMENT_UNVERIFIED`;
      `CONNECTIVITY_ROUTE_DECOMMISSIONED` (HTTP 410 from the Power Apps host: a service that has been switched
      off); `CONNECTIVITY_UNAUTHORIZED` (HTTP 401 or 403 from the Business Application Platform or the Power Apps
      host: the token the route was given was refused — a refusal because the Azure CLI's token is the only one
      the plugin has to give, because a tenant can refuse that client and still allow `pac`'s own, and because
      the fallback is not silent: the output carries the code and the SDK's words, and a `pac` that cannot read
      them either fails with its own error; a 401 or 403 from Dataverse itself, the org read, stays a failure);
      `CONNECTOR_SWAGGER_UNSUPPORTED` (a connector definition the SDK does not project: an OpenAPI 3 document, a
      path item with a `$ref`); and the plugin's own `POWER_APPS_TOKEN_UNAVAILABLE` (no Azure CLI token for the
      Power Apps service, checked beside the Dataverse token before an SDK is made);
    - `solution-settings.js template` — `SOLUTION_STAGING_FAILED`, `SOLUTION_STAGING_UNREADABLE`;
    - `solution-settings.js import` — `SOLUTION_STAGING_UNREADABLE`, and an `INVALID_ARGUMENT` that is the SDK's
      own sentence for a feature of `pac`'s that the settings FILE holds and the SDK does not apply (a non-empty
      `Workflows`, `CanvasApps` or `CopilotAgents` list, a `ConnectionInstance` in a connection reference), which
      the SDK finds before it sends anything. The feature is read from the file and the sentence is built from
      it (`pacOnlyFeatureMessages`), so an error is taken for the refusal only when it IS that sentence — a
      settings key or a name that merely contains the phrase "this SDK does not apply" is an ordinary failure
      and `pac` is not asked. `solution-settings-real-bundle.test.js` pins the sentence against the real bundle.

    Only what the SDK itself raised counts, and the check is on what the error *is*: an instance of the bundle's
    `SdkError` carrying one of those codes. The SDK's `ConnectionError` keeps the HTTP response body of a failed
    request as its `cause`, so a service that answers 403 with a body naming `CONNECTIVITY_CLOUD_UNSUPPORTED` has
    data from the network, not a refusal, and the read fails. The one wrapped refusal is
    `POWER_APPS_TOKEN_UNAVAILABLE`: a `ConnectionError` with status 0 (nothing was answered) whose cause is this
    plugin's own client error with that code.

    Left out on purpose, each a failure to report: `CONNECTIVITY_RESPONSE_UNREADABLE` (a service that answers in a
    changed shape must not be papered over), `CONNECTOR_OPERATION_NOT_FOUND`, `CONNECTOR_SCHEMA_TOO_LARGE`, any
    other `INVALID_ARGUMENT`, every `CONNECTION_ERROR` (a 404 or 5xx from a route that serves, and any status from
    Dataverse itself) and, for an
    import, `SOLUTION_STAGING_FAILED`: the platform said the package cannot go in there, and `pac` would not
    import it either. A machine with no Azure CLI token for the Power Apps service is told so before any
    request (`POWER_APPS_TOKEN_UNAVAILABLE`, answered by `pac`); a Dataverse token failure stays loud.

    **An org outside the Public cloud is answered by `pac` at once.** The SDK picks a route from the org's cloud
    (its host: `<name>.crm<N>.dynamics.com` is Public unless `N` is 9, which is GCC; `<name>.crmtest.dynamics.com` is
    Test). A Public org is read through the classic Power Apps API — the one route an Azure CLI token answers. A
    Test org is read only through the Power Platform API, which asks for a token that carries the Connectivity
    permissions; the Azure CLI's token for that API carries environment-management and app-read scopes and the route
    answers it 403, so the plugin cannot give the SDK a `powerPlatformApiClient` (nor, for a connector's tables, a
    `connectorRuntimeClient`), and `pac`, which signs in with a client of its own, reads what the SDK has no route for
    here. The SDK refuses such an org before it sends anything, so asking it first would only cost two Azure CLI
    processes and a throwaway workspace before the refusal. The host is therefore
    judged first (`connectivityCloudOf` in `lib/sdk-first.js`, a written-out copy of the SDK's own rule that
    `connectivity-real-bundle.test.js` pins against the real bundle with a table of hosts), and `pac` is asked at
    once with the code the SDK would have given (`CONNECTIVITY_NOT_CONFIGURED` for Test,
    `CONNECTIVITY_CLOUD_UNSUPPORTED` for any other) — no token read, no SDK made, nothing requested. The tabular
    reads (`connector.js schema --dataset --table`) stay with `pac` for the same reason.
  - **The Power Apps service client** (`lib/power-apps-service-client.js`; `createMakerSdk({ connectivity: true })`
    in `lib/maker-sdk.js` builds it, and nothing else does). The SDK's connection and connector reads take a
    client that signs in to the Power Apps service. This one holds the credential, so it does not trust whoever
    asks for a request: GET only (any other method is `POWER_APPS_METHOD_REFUSED`); an absolute `https` URL with no
    port or credentials on exactly the hosts the SDK's connectivity code calls — `api.bap.microsoft.com`,
    `test.api.bap.microsoft.com`, `api.powerapps.com` and `*.api.powerapps.com` (otherwise
    `POWER_APPS_URL_REFUSED`, checked before the token is read); redirects never followed (a 3xx is the answer,
    and the SDK reads it as a failure); a 60-second idle timeout; the token — the Azure CLI's for
    `https://service.powerapps.com/`, no shell — never in a message, and never in what the service answers: every
    string of an answer (body, headers, keys) has the token, and each distinctive part of it, taken out before the
    SDK sees it, while the status and the typed `error.code` stay. An instance made without `connectivity` is
    what it always was, and the SDK then refuses those reads before any request. It is the only client the plugin
    gives the SDK, and only an org in the Public cloud reaches it (the Test-cloud host stays on the list because the
    list is the hosts the SDK's classic route can name, not the clouds the plugin sends to it).
  - **`list-connections.js <envUrl>`** prints what it printed — `connections[]` (`connectionId`, `connectorId`,
    `displayName`) and `connectionReferences[]` — plus `connectionsSource: "sdk" | "pac"` and, when `pac`
    answered, `connectionsFallback: { code, message }` (for an environment outside the Public cloud, the first thing
    that happens: `pac` is asked before any token is read, see above). The environment is validated as a Dataverse origin first
    (`pac` used to run before the text was checked). The `pac` path is `pac connection list --environment <origin>`
    — pinned, because without the flag `pac` answers for the active organization of its auth profile, which can be
    another environment (an import bound to one of its connections then failed in the platform) — through the
    process runner that ends the whole tree of a call that runs out of time; its parsers are unchanged, and its
    failure text keeps `pac`'s `Error:` lines and drops its banner (signed-in account, version, links).
    A failure — of the SDK's read, of `pac`, of the connection references, a bad origin — exits 1 with one
    pure-ASCII line, `{ ok: false, error, code }`, on stdout and the message on stderr, as the other two scripts
    do. `code` is the error's own and is left out when it has none: the SDK's errors have one (`CONNECTION_ERROR`,
    `CONNECTIVITY_RESPONSE_UNREADABLE`, …); a `pac` failure, a bad origin and a refused read of the connection
    references do not. A failure of `pac` — which was asked only because the SDK refused — also carries
    `connectionsFallback: { code, message }`, the same reason a listing `pac` gave prints (`listConnectionsWithPac`
    keeps it on the error, `failureLine` prints it): `pac` read alone would send a maker to repair a `pac` they
    never chose to depend on, for a route that is the real reason. A failure that is not `pac`'s — the SDK's own
    read, the connection references read after a listing — carries none. A usage error (an unknown flag, no
    environment URL) is the problem and the usage on stderr
    alone — nothing on stdout, exit 1 — as it is in the other two.
  - **`connector.js`** — `operations`, `schema --operation <id>` and `schema --dataset <ds> --table <t>`, each with
    `--env`, `--connector-id` (the short name, or `/providers/Microsoft.PowerApps/apis/<name>`) and
    `--connection-id` (required for every form because `pac` requires it; the SDK route does not use it). It prints
    one pure-ASCII line: `pac`'s own JSON for the form, plus `ok`, `source` and, when `pac` answered an SDK refusal,
    `fallback`. The tabular form is `pac`'s alone — the SDK reads a connector's tables only through the Power Platform
    API and a connector runtime client, which the plugin cannot build on an Azure CLI token — and says
    `source: "pac"` with no `fallback`. The SDK's answer for `schema --operation` includes a connector's path-level
    parameters (a Swagger path item's own `parameters`, shared by its operations), merged with each operation's own,
    the operation's winning; as the SDK documents the difference, `pac`'s answer leaves them out, so for a connector
    that has them the SDK's list is `pac`'s plus those. Every `pac` command it runs is pinned to the environment
    (`--environment <origin>`); the commands the agent ran before were not, and without the flag `pac` answers for
    the active organization of its auth profile. JSON that is not the form's answer is refused rather than passed
    on. A SharePoint dataset address that is percent-encoded (`…/sites/My%20Site`) reaches `pac` unchanged when it is
    installed as `pac.exe` — and when it is installed by the Windows MSI, whose `pac.cmd` is a two-line forwarder to
    `pac.launcher.exe` (`@echo off` on a line of its own, then exactly `"%~dp0pac.launcher.exe" %*`, the way `cmd`
    reads lines — a one-line `@echo off "%~dp0x.exe" %*` is an `echo`, which starts nothing, and is not a forwarder),
    which the process runner starts directly; a batch launcher of any other shape cannot
    carry a `%` through `cmd.exe`, so the call is refused before `pac` starts (`PAC_REFUSED`), with the cause and
    the way through (install `pac.exe`, or run the command yourself). A failure prints
    `{ ok: false, error, code, fallback? }` and exits 1; `PAC_MISSING`, `PAC_TIMEOUT`,
    `PAC_FAILED`, `PAC_REFUSED` and `PAC_OUTPUT_UNREADABLE` are the `pac` step's own codes.
  - **`solution-settings.js`** — `template --env --solution --out [--force]` exports the solution (unmanaged: an
    installed managed one cannot be exported, and the settings are the same) and reads the package the way the
    platform does, staged in `--env` — nothing is imported and the staging copy is deleted;
    `template --package <zip> --out [--env] [--force]` reads a package you already have, and without `--env`, where
    there is nothing to stage it in, `pac solution create-settings` reads the zip offline;
    `import --env --package --settings` imports and applies the settings in the same import. The file `template`
    writes has `pac`'s shape — `EnvironmentVariables[]` (`SchemaName`, an empty `Value`, `DefaultValue`, `TypeId`,
    `IsRequired`) and `ConnectionReferences[]` (`LogicalName`, an empty `ConnectionId`, `ConnectorId`) — sorted by
    name, so a file `pac` wrote and one this wrote are read alike by both. An existing `--out` is not replaced
    without `--force` (`pac` replaced it silently, and every value already filled in with it): the early check is
    repeated where the file is installed, as an exclusive create (`lib/safe-fs.js`, `exclusive: true`), because the
    export, staging or `pac` work in between takes minutes and a file a maker started filling in meanwhile must
    survive — `OUT_EXISTS` then, the same as at the start.
    `import` checks the file before any request (a missing file, one that is not that shape, a package that is not
    a zip or is over 128 MiB — it is held in memory, then again as base64 — and an `--env` that is not a Dataverse
    origin are refused; an environment variable's `Value` is text and goes through byte for byte — leading or
    trailing white space, a JSON document ending in a newline, a value of white space alone — while a name and a
    connection id may not begin or end with white space), checks every filled entry against the package (an entry
    the package does not hold, or one that names another connector, fails the whole import: the platform would
    otherwise apply it to whatever the environment holds under that name), and prints the import job id — minted
    by the script, so that an import whose answer is lost can be looked up (on the SDK path: `pac` mints its own
    job and is not given this one). A failed import's output has `error`, `code`, `status` (the HTTP status of the
    answer that failed it, when there is one), `importJobId` (SDK path), `fallback` (when `pac` was asked) and
    `warnings` (what the SDK could not clean up, such as the staged copy — also when it refused and `pac` did the
    work — and a folder the `pac` fallback made and could not remove). When the request was SENT and failed,
    the job's own log is read once (`importjobs(<id>)?$select=data`: the first `<result result="failure"
    errortext="…"/>`, else the status of the log's root) and its reason is appended to the message — the platform's
    own answer is often only "An unexpected error occurred" — and a log that cannot be read leaves the message as it
    was. When `pac` imports because the SDK refused, `fallback.message` is the SDK's
    own — its "Nothing was imported" is about the SDK's attempt, which stopped before any request. **`pac`'s defaults** for the flags `pac solution import` takes: a plain
    synchronous import that overwrites no unmanaged customizations (`--force-overwrite` off, so
    `overwriteUnmanagedCustomizations: false` — `importSolution` requires it), activates no plug-ins or workflows
    (`--activate-plugins` off, so `publishWorkflows: false` — required too), publishes nothing afterwards and
    skips no check; none of them is a flag here.
  - **What is kept out of the output, and what is not.** A token is never printed — not by a message the SDK builds
    from a service's answer either: the az-token client takes the access token out of every answer that is not a
    success (its body in whatever mode it is read, its headers) and out of a transport failure's text, whole and by
    each part of 24 characters or more (`scrub` and `scrubAnswer`, `lib/sdk-http-client.js`, which the Power Apps
    client uses too; a success is the caller's data and is never touched; `sdk-http-client-scrub.test.js`). A change set
    the service refuses as a whole is such a success — HTTP 200 with the one part that failed — and the SDK quotes that
    part into the error it raises: the answer is not rewritten (the strict `$batch` readers count its bytes), and
    `lib/output-redaction.js` keeps the tokens the process obtained out of everything it writes (the table in
    "What a script writes is cleaned where it is written" above; `output-token-boundary.test.js`). An HTTP
    200 can be a failure all the same — StageSolution answers 200 with a status of `Failed`, and the SDK's message
    quotes the dependencies and validation results it was given; a job's log is a 200 too — so `solution-settings.js`
    takes every access token the run sent (`recordingTokens`: every client of the run is given its token through one
    function) out of a text of another party as its sanitizer reads it (`withoutTokens`: before the file's values are
    looked for), and, behind that, out of EVERYTHING it writes, by the one function `leavingWith` makes: `guardOutput`
    wraps stdout and stderr from the first line of `main`, so the result, the usage error and what a library prints
    with `console.error` are all cleaned on the way out, and the file `template` writes at `--out` and the note a
    process that is ending leaves on stderr (`writeNote`) go through the same function. The files it writes for `pac` —
    the copy of the settings, the package the SDK exported — are data for another program, not output, and are never
    altered; a text with no token in it is written exactly as it was. A script that adds another way to write fails
    `solution-settings-tokens.test.js`, which scans for it. A settings value and a connection
    id are kept out of every text a run prints as far as the text quotes them in a form that can be recognised; the output
    otherwise names entries, never values, and the settings file is read from and written to disk only. Every text
    another party wrote — the SDK's, the platform's, `pac`'s, a job log's, and the cleanup warnings of a failed run as
    well as a successful one — goes through one sanitizer built from the file (`sanitizer`), and is read WHOLE: nothing in
    it is trusted for the way it begins. Four rules.
    - *What is secret is the package's to say, and how a value is treated depends on what is known* (`secrecyOf`). A
      variable is a secret when its definition in the package says so — the type in the StageSolution reply the SDK reads
      for an import that fills anything in, recorded as it passes through the plugin's client (`recordStagedTypes`) —
      or when the file marks it secret (`TypeId` 100000005). The file's `TypeId` is informational (the SDK accepts it and
      ignores it; `pac` writes it and a file may leave it out), so it can only add secrecy, never take it away. A name
      the reply lists twice keeps the most secret type (Secret wins), and when the types differ and none is Secret nothing
      is known of it. A variable the package was not read for — the `pac` fallback, a reply that could not be read, a name
      the package does not define — is *not known* to be anything.
    - *A secret is hidden at any length; what is not known is hidden by length.* A **secret** is looked for as a
      substring, whatever its length. A value whose type is **not known** is looked for as a substring from six
      characters on (a Secret-type value is the location of a Key Vault secret, far longer), and below six only as a
      **whole word** — a boundary is required on a side where the value's own edge is a letter, digit, mark or
      underscore, and the neighbour must not be one — so a one-letter value does not withhold every message that holds the
      letter, and the SDK's account of which entry is wrong (it names entries, never values) stays readable unless the
      value is itself a whole word of that sentence (see below). A value that is **known not to be a secret** (the
      package says Text, say) and a connection id are replaced by `<redacted>` where a text spells them as written, from
      six characters on; a shorter value of that kind is **not hidden** — it is a word as much as a value ("1",
      "true", "en"), a message with every such word blanked explains nothing, and by the package's own definition
      there is nothing in it to protect.
    - *A text is looked at in every form decoding it gives.* A message that quotes a value rarely quotes it as it
      is — a JSON error writes a quote as `\"` or `\u0022`, an XML log as `&quot;`, a URL as `%22`, and any of
      them can sit inside another — so instead of a list of spellings the text is decoded (JSON string escapes, XML
      character references, percent-encoding, a form's `+`) and searched in each decoded form, to three levels, with
      runs of white space also compared as one space, and without regard to case (a service may normalise it: a GUID is
      quoted in lower case). A text that repeats a secret, or a value that is not known and is found, is not shown at
      all: it is replaced by a sentence saying it was withheld, because complete scrubbing of another party's text
      cannot be guaranteed and a service that quotes its input is not trusted for the rest of it; a value that is not
      a secret and is found only in a decoded form withholds the text too (it cannot be taken out of the text it was
      decoded from). The status and the code stay in their own fields, and so does the SDK's own `HTTP <status> from
      <url>:` line — rebuilt from the error's `statusCode` and `url` (`sdkLead`), never recognised from how a text begins:
      a job log, `pac` or a warning that begins like it is just text. A text of more than 1 MiB is withheld, not cut.
    - *Another party's text is sanitized once, and the plugin's own words are not.* `pac`'s text is sanitized where it
      is read (`lib/pac-fallback.js`, through its `redact` option); the sentence the plugin writes around it — the command, its exit status, how a
      timeout ended — is not looked at again (`COMPOSED_MESSAGE`). The same holds for the plugin's "got no answer"
      sentence for a long action (the transport's own words in it are sanitized where they are read; the SDK keeps the
      error the client threw as the `cause` of its own, and the sentence is recognised by that object together with an
      exact match with the SDK's status line, never by how a message reads) and for the feature sentence that sends a
      file to `pac`, which the plugin builds from the file's keys and accepts only by exact equality (`shownRefusal`).
      Looked at again, they would be withheld for a value of `1` ("(exit 1)"), `en` ("deployment") or `not` ("It was
      not sent again"). The SDK's own account of a staging reply it could not read, its messages and its warnings are
      another party's text and are sanitized.

    What this leaves, stated: a value of fewer than six characters that is not known to be a secret is printed when a text
    quotes it glued to letters, digits, marks or underscores (`ValuePIN42was`, `key_PIN42`), or inside an escape the
    decoders do not read (`\042`, `%u0022`, `&#x22` with no `;`) — a Secret-type value is long and its type is known on
    the SDK path, so this is a gap for a short value nothing says is a secret, not for a secret; and a value that is known
    not to be one is printed wherever it is quoted. What the decoders do not know is a limit too: a service that quotes
    only part of a value, hashes or base64-encodes it, writes it as a named HTML entity beyond XML's five, normalizes its
    Unicode, or nests the encodings more than three deep. And what the whole-word rule costs: a short value whose type is
    not known that is itself a whole word of the SDK's own sentence — `none`, `is` or `the` as a value — still withholds
    that sentence, so which entry is wrong is hidden for such a value (the status, the code and the plugin's own
    sentences stay). The short-value gap and the cost are pinned by tests (the whole-word table in
    `solution-settings.test.js`), so a change to the rule shows.

    A job's log is cut last: its reason is decoded, sanitized in full, and only then made one line and cut to 600
    characters (a value that begins before the cut, or holds runs of white space, would otherwise have been changed
    before it was looked for). An
    import's failure is rebuilt from its parts, so what the SDK attached to its own error (the raw answer,
    unfiltered warnings) does not travel with it, and an unexpected failure of the script itself prints only its kind.
  - **Long actions are sent exactly once.** The plugin's HTTP client sends a POST that got no answer again, after
    five minutes, and again after a 429 or 5xx, and replays a request after a 401 with a refreshed token. For
    `ExportSolution`, `StageSolution` and `ImportSolution` every one of those is wrong: a gateway answers 502, 504 or
    401 for an import the platform accepted and is still running, and a second send is a second import of the same
    job, a second staging copy, or a refusal that hides what the first did. So `solution-settings.js` gives each an
    hour — `pac`'s own longest wait for an import — and marks each `sendOnce` (`lib/sdk-http-client.js`): the
    first answer goes to the SDK as it came, with its status and code, and a failure that does not say how the
    import ended (no answer, 401, 408, any 5xx) says it was sent once, was not sent again, and names the import job
    to look up before importing again. `sendOnce` governs EVERY way the client sends again — the transport and status
    retries, the 401 refresh, and the replays that are special to a record delete and a `$batch` (a 429, a SQL
    deadlock): a request that is named once is sent once, whatever the answer.
  - **The one exception: an import the platform refused to start** (`sendImport` in `solution-settings.js`; the
    client itself stays absolute). While a publish, or another import, holds the environment's customization lock the
    platform answers `ImportSolution` with HTTP 429, in one of two forms, each with a proof of its own that nothing
    of the package was applied.
    **A customization-lock code.** The codes are the customization-lock codes of the platform's error reference whose
    DOCUMENTED text says the operation could not be started — `0x8004F061`, `0x8004F062`, `0x8004F063`, `0x8004F064` and
    `0x8004F067`, the `CustomizationLockEx_*` codes ("Cannot start the requested operation …", and, for `0x8004F063`,
    "Cannot start another … because there is a previous … running") — pinned as an exact set. An answer with one of the
    five codes is the one that says the import did not start, with two conditions, both shown before the second copy
    leaves. The status and the code must be the lock's (a service protection 429, `0x80072321`/`22`/`26`, is another kind
    and is sent once, like `0x80071154`, an operation that FAILED because of another, which had started); and
    `GET importjobs(<id>)` for the id the refused send carried must answer **404** — "the ID of the import job that will be
    created to perform the import" does not exist, so nothing started. Any other answer to that read (the job exists,
    401, 403, 5xx, 429, no answer, no token) is not proof, and the run ends as it always did. The wait comes first (10 s,
    then 20, 40 and 60 — or the platform's `Retry-After` when that is longer, in either of its forms and WHOLE: the
    client's own retries cap it at a minute, this one does not, since a send before the time the platform asked for is a
    send it has said it will refuse), so the proof is the latest evidence before the send.
    **`0x80071151` with "Cannot start" words.** `0x80071151` (`SolutionConcurrencyFailure`) is NOT in that set: its
    documented text says the installation or removal FAILED, which does not say that nothing started. But it is what the
    platform was measured to answer an import that meets another import or a publish — "Cannot start another [Import]
    because there is a previous [Import] running at this moment …", or "Cannot start the requested operation [Import]
    because there is another [Publish] running …" — so an answer with HTTP 429, that code (either case of its hex digits)
    AND a message that begins `Cannot start` (`concurrencyRefusalOf`) is looked into, and any other answer with the code
    is sent once and reported as it always was (the words only select what is looked into; they prove nothing). The
    proof is the refused send's own job, read ONCE and AT ONCE — before the wait: a refused send's job is final when the
    answer is in hand and is not written again, and a job that proves nothing makes the wait pointless — with
    `GET importjobs(<id>)?$select=importjobid,completedon,data` (`readRefusedImportJob`; `progress` is the same for a
    running import and a refused one, and `solutionid` is set for a solution that was never made, so neither is read).
    `lib/import-job-proof.js` holds the rule and the measurements it rests on. The job **does not exist** (404): the
    refusal came at the first lock check, before the platform made a job, and nothing started. Or it **exists** — two
    imports started together, refused at the second check — and is finished (`completedon` set) and its `data`, read as
    ONE XML document by `lib/strict-xml.js` (a log it cannot read is no proof: a pattern over the text misses a
    `processed="true"` after a `>` in an attribute value and finds the attributes in a comment), is an `importexportxml`
    whose root says `succeeded="failure"` and `errorcode="-2147020463"` (0x80071151 as a signed 32-bit integer), every
    `solutionManifest` (at least one) is `processed="false"` and no other element but the package's own checks
    (`upgradeHandler`, `validateHandler`) is marked anything but `"false"`: the import stopped at the lock before it
    applied a solution, a table or a form. Every comparison is exact (`"Failure"`, `-2147020463.0`, `"True"` are no
    proof), a log of more than 8 MiB is not read, and anything else — a job still running, one that failed AFTER it
    began (`errorcode="-2147188685"`, the manifest processed), a log of another shape, a read that answers 401, 403,
    429, 5xx or nothing — is NOT proven: the import is sent once, and the failure carries a sentence of the plugin's
    own — told by `observe.onImportRetryUnproven` — that says why in fixed words and numbers (never a text the
    platform wrote) and what to do: look up the import job (`importjobs(<id>)`, or the solution history in Maker), and
    run the import again only when it shows nothing was imported and the other operation has finished. All 347 states
    of a job's row that the measurement captured — twenty imports read every 250–500 ms until nothing changed — were
    put through the rule: it accepts exactly the 8 final rows of refused imports and none of the other 339 (running
    imports, imports that applied the package, a refused import's row before its final write, imports that failed
    after they began); `import-job-proof.test.js` holds it to a twin of each kind of state and to every clause.
    **Both kinds**: the send carries a NEW job id (the body is otherwise byte for byte the same, the package included, and
    the SDK does not stage again: the retry is below it, in the transport). At most five sends in all, and one budget of
    **five minutes** of elapsed time for the whole retry, from the first refusal to the last send
    (`IMPORT_RETRY_BUDGET_MS`: every wait and every proof read in between; not the time an import the platform ACCEPTED
    takes, which is the action's own hour, and a refused send is answered in moments). The same sends, waits and budget
    serve both kinds: they are one lock, and the measured holders are short — a publish of six tables 3–12 s, an
    import of a package of six tables 48–127 s — against the 130 s that the four waits add up to; at most four reads of
    a refused send's job are made, one for each refusal that is not the last (the fifth send's refusal is the sends
    running out, and is not looked into). Before each wait the run asks whether it fits in what is left; when it does
    not (a `Retry-After` of ten minutes) the retry ENDS there — never an early send to make it fit — and so it does when
    the proof read leaves nothing of the budget, and when a wait ENDS past it (the budget is asked again after every
    wait, for both kinds: a timer resumes later than it was asked to on a busy machine or a laptop that slept, and the
    check before the wait cannot know that): the platform's refusal is the failure, with the sends so far, and a
    sentence of the plugin's own that says why (`ImportSolution was not sent again: the next wait, …`), told by
    `observe.onImportRetryStopped`. A send that follows a refusal is judged like a first send, so a gateway's
    answer to it is the failure, "the last send was not sent again", naming ITS job. The output names the job that ran
    (`importJobId`), how many sends it took (`importAttempts`) and each refused send with the wait after it
    (`importRefusals`; a refusal with `0x80071151` also has `proof`: `job-absent` or `job-refused-before-any-component`,
    and the failure's sentence says which); when the sends run out the failure is the platform's refusal with that count
    added, and a sentence for the KIND of refusal the fifth send met (`observe.onImportRetryExhausted`,
    `exhaustedSentence`): for a lock code the advice it always had (run the import again when the other operation has
    finished); for `0x80071151` — whose job alone could show that nothing was applied, and was not read — never that
    advice outright, but what to look up first: the job must not exist (404), or must be finished with the log of an
    import refused at the lock (the rule above), and the other operation must have finished — anything else means the
    import may be running or may have applied the package. A fifth answer of any other kind (a service protection
    429, `0x80071154`, `0x80071151` with other words) is not a refusal the retry knows and gets no advice of the
    plugin's, as on a first send. The retry is opt-in (`observe.onImportRefused`, which only `runImport` gives), so
    the client of any other
    caller sends once. It happens inside the SDK's call, so it can neither become the `pac` fallback nor follow one: a
    refusal is not a fallback code, and the fallbacks all come before the first `ImportSolution`. Pinned in
    `solution-settings.test.js` (the allowlist, the waits, the budget over a clock that only the waits and the reads move,
    the order of the read and the wait for each kind), `import-job-proof.test.js` (the rule),
    `solution-settings-real-bundle.test.js` (the real SDK and client over a fake platform that refuses chosen sends and
    keeps a count of what it took) and in a child process (`instantWaits` in the preload).
  - **`pac`'s time limit** (`lib/pac-fallback.js`): two fixed constants, in the way `PAC_PROBE_TIMEOUT_MS` bounds
    `check-auth.js`'s `pac org who` — there is no environment variable to tune them — applied through
    `lib/process-runner.js`. `PAC_READ_TIMEOUT_MS` (3 minutes) bounds a read: the connection list, a connector's
    definition, the settings template of a zip — a cold start of pac's .NET runtime (about 7 s on Windows, more on
    a busy machine) plus one service call whose answer can be a few hundred kilobytes. `PAC_IMPORT_TIMEOUT_MS`
    (60 minutes) bounds an import: the platform imports synchronously, a large package takes many minutes, and a
    call stopped halfway leaves the outcome unknown, so it gets pac's own longest wait (the default of
    `--max-async-wait-time`) and its timeout message says to look at the environment's import history before
    importing again. A call that runs out is reported as a timeout, never as a missing pac, and its process tree is
    ended before the call settles (`spawnResultTree`, `killProcessTree`), so a Windows `pac.cmd` launcher's own child
    does not outlive it. What the message says was stopped is what the runner CONFIRMED, and no more: the pipes
    `pac`'s tree held have closed (`error.containment` is `confirmed`), so nothing holds `pac`'s output — "`pac` and
    every process that held its output were stopped". That does not prove that no other process `pac` started is
    running: one that never held the pipes (started detached, with streams of its own) can outlive the kill, and no
    tree that can be walked from a launcher that has already exited leads to it — so the message does not say the
    tree is gone. A process that outlived `pac` itself and still holds the pipes when the short
    wait for them ends (`unconfirmed`) is the other case, and then the message says that a process `pac` started
    may still be running (with the process id `pac` was started as, which has usually exited; the survivor's own is
    not known) and to end any leftover `pac` process before trying again. A failure is `missing` (not on `PATH`), `timeout`,
    `failed` or `refused` — the process runner will not hand an argument to a Windows batch launcher that it
    cannot carry unchanged, such as a `%` in a URL-encoded SharePoint address, when `pac` is installed as a
    launcher of any shape but the MSI's plain forwarder, and `pac` is then not started at all; the message names
    the cause and the way through — and `pac` printing something that is not the JSON the form's answer has is
    refused (`pacPayload`), never read as an empty answer. What `pac` printed about a failure is shown without its
    header (`pacErrorText`: the signed-in account, the version and the links are dropped, `Error:` lines kept), and
    redacted before it is cut to length.
  - **`pac` imports the settings the run read, not the file's path** (`importThroughPac`, `readSettingsFile`). The
    run reads `--settings` ONCE, as bytes — the sanitizer is built from them, the SDK is given what they parse to,
    `applied` names their entries — and the staging that comes before the SDK's refusal takes as long as the platform
    takes. A file saved in that time is one the run never looked at: read again by `pac`, its values would reach `pac`,
    and `pac`'s own words about them, which are printed, with no sanitizer that knows them. So `pac` is given a private
    COPY of those bytes (byte order mark and line ends included) in a folder of the run's own. The copy holds the values
    the maker filled in, and the folder is in the temp directory, whose permissions everything inside it inherits — so it
    is made PRIVATE before a byte is written, and what was set is read back (`lib/private-folder.js`). On Windows the
    folder's access list is replaced by ONE entry, full control for the current user by SID (`whoami /user /fo csv /nh`;
    then `icacls <dir> /reset`, `/inheritance:r` and `/grant:r *<SID>:(OI)(CI)F` — three steps, because a folder made in
    a user's temp folder can hold SYSTEM, Administrators and the user as entries of its OWN, which `/inheritance:r` alone
    leaves) and read back through `icacls /save` as SDDL (`D:PAI(A;OICI;FA;;;<SID>)`): protected, one allow entry, the
    user's — the SID in full, or the alias SDDL writes for it. An alias is compared as the SID it stands for, never by its
    looks: `SY`, `LS` and `NS` are the same SID on every machine; `LA` and `LG` — the machine's own Administrator and
    Guest, which is what a VM's or a CI runner's renamed administrator account is — are the RIDs 500 and 501 of the
    machine's OWN domain, and every other domain has accounts with the same RIDs, which `icacls` writes in full. So `LA`
    is the user only when the machine itself writes the user's SID as `LA` (`spellingOf`: the SID is granted to a file
    that holds nothing, in the private folder, and its list is read back — three more `icacls` runs, made only when a
    list names the user by `LA` or `LG`). The file is created exclusively (`wx`) and EMPTY, its list read back
    (`D:AI(A;ID;FA;;;<SID>)`), and only then
    are the bytes written. Both tools are `.exe`s in the Windows folder's `System32` and nowhere else, started through
    `lib/process-runner.js` with no shell. On POSIX the folder is set to 0700 and the file created as 0600 and set to it
    (a umask cannot undo that), each read back with its owner and that it is not a link. Anything that cannot be set or
    does not read back — a file system with no access lists, a tool that cannot start, an unexpected list — fails CLOSED:
    `PAC_SETTINGS_COPY_FAILED`, `pac` is not started, and the reason is a tool and a step or the system's code, never a
    path or a value. The folder is made, restricted and filled in as ONE guarded step (`inWorkFolder`'s `prepare`): the
    failure of any part of it — the folder, its protection, the file — is that same failure, carrying the reason `pac`
    was asked (`fallback`) and no SDK import job. A copy was chosen over refusing a file that changed: the import still
    happens, of the file the run checked, and an edit made during the run is neither applied nor printed — save it again
    and run the import again to apply it. `pac` still reads the package from its path. The copy and its folder are removed
    however `pac` ends (next bullet).
  - **The folder a `pac` fallback works in is removed, and said when it stays** (`inWorkFolder`, `lib/safe-fs.js`
    `removeTreeWithRetry`). `pac solution create-settings` writes into a work folder of the run's own, which holds the
    package the SDK exported and pac's template — defaults that can be values — and `pac solution import` is given its
    copy of the settings in one (above). The folder is made by `lib/temp-workspace.js` (`makeTempWorkspace(prefix,
    { lent: true })`): `solution-settings-<pid>-<random>` in the plugin's own folder of the temp directory, with the
    maker's owner record `.owner.json` in it (the process, the host, the time — no value of the run, so it is not among
    the files that are emptied below) and LENT to `pac`, which is another process and may outlive a run that is killed;
    where the plugin's own folder cannot be used it is `solution-settings-<random>` in the temp directory itself, as it
    always was, with no record, and every guarantee below holds there too. It is removed however the run ends, with the
    bounded retry a Windows lock needs (a scanner or a sync client that holds
    what pac just wrote answers `rm` with EBUSY, EPERM or EACCES: six attempts over about three quarters of a second;
    on other systems a lock code is not waited out). A folder that STILL stays is a warning with its path and what is in
    it — in `warnings` of a run that succeeded, and beside the failure of one that did not (`leftoverWarnings`, which
    `describeFailure` prints with the SDK's cleanup warnings and no sanitizer looks at: it is the plugin's own sentence, a
    path and a code) — never left unsaid. The files that hold values are EMPTIED first, so that what stays holds none: the
    copy of the settings, `pac`'s template (its defaults can be values) and the package the SDK exported (it carries the
    same defaults, and can carry current values); the warning says whether that worked. `inWorkFolder` requires its caller
    to say which files those are (`empty`, an empty list when none holds a value), so that a file is not left whole by a
    caller that did not think of it. It is removed, too, when the PROCESS ends while the work goes on, in every way
    JavaScript can see (`lib/exit-cleanup.js`): `process.exit`, an error nothing catches (both through the `exit` event),
    and SIGINT, SIGTERM, SIGHUP and SIGBREAK where the platform delivers them — the cleanup runs synchronously, the
    listeners come off (only ours: the program's own are never removed or replaced) and the process ends as it would
    have: on POSIX the signal is raised again, so it ends BY it; on Windows, where Ctrl+C and Ctrl+Break are console
    events and `process.kill` is TerminateProcess (status 1, the status of a failure), it ends with STATUS_CONTROL_C_EXIT,
    0xC000013A (3221225786), the status of a process that a console event cancels and nothing handles — so a caller can
    tell a cancelled run from a failed one. A program that has a handler of its own for the signal keeps the decision, a
    one-shot (`process.once`) or self-removing handler as much as a persistent one, however it was put on the list: ours
    is first in line (`prependListener`) and counts the others before any has run — and STAYS first when the program
    prepends a handler of its own later (`prependListener`, `prependOnceListener`, which calls it): the process's own
    `prependListener` is wrapped for as long as a cleanup is registered, and ours is put back in front before the
    program's call returns, because a signal can be raised in the very turn that the handler is put in place and a
    one-shot handler that is ahead of ours is gone from the list by the time ours counts (`keepFirst`). Moving ours is two
    calls on the process, and the process announces each (`removeListener`, and `newListener` before the listener is on
    the list), so a program that watches them can release the cleanup from one: a cleanup that was released meanwhile
    stays released — the registry is looked at again before ours is put back and after, and a listener of a registry that
    is gone is taken off — and ours is put back even when a notification throws. A process that is
    KILLED (SIGKILL, TerminateProcess)
    runs nothing, and the folder it made stays — recorded and lent, in the plugin's own folder, so that a later run's
    sweep (`sweepDeadWorkspaces`, `lib/temp-workspace.js`) removes it, the copy of the settings with it, once its run is
    gone AND the folder is old (a lent folder is kept for a week: `pac` may still be using it). A folder that was made
    in the temp directory itself, where the plugin's own folder could not be used, has no record and is never swept.
  - **A failure to install the template keeps what the run knew.** `writeTemplate` is the last step of `template`, after the
    SDK has staged, refused and cleaned up (or not) and pac has made its folder. When it fails — `OUT_EXISTS` because the
    name was taken while the run worked, or any file-system error — the SDK's cleanup warnings and the note of a pac folder
    that stayed are carried on the error (`warnings`, once each, in the order a success prints them), so the staged copy
    and the folder are still said. Nothing is sanitized there: `template` reads no settings file.
  - **Files are written without replacing another's** (`lib/safe-fs.js`). `solution-settings.js template` without
    `--force` installs its file as an exclusive create, and it must never remove a file it cannot prove it wrote:
    the whole content goes to a sibling file this process created exclusively (`.<name>.<pid>.<random>.tmp`), and is
    then published with a hard link to the target name — which fails if the name exists, so the file system decides
    and a file that appeared meanwhile is never overwritten (`IO_ERROR`, `reason: 'exists'`) — and only the sibling
    is ever removed. A file system that has no hard links (some network and FAT shares) answers the link with an error,
    and the write fails closed with `IO_ERROR`, `reason: 'no-hard-links'`: it is not replaced by a write that could
    overwrite. `--force` needs no link (it renames a finished sibling over the target) and so writes there, which the
    message says. The sibling's name is the one thing a write can leave behind, and it is never left unmentioned: on a
    failure it is removed with the bounded retry a Windows lock needs (a scanner or a sync client can hold a
    just-written file, and `unlink` then answers `EBUSY`), and one that stays is said in the error; after a PUBLISH it
    is the same retry, and one that still stays is a WARNING (`onWarning`; `template` prints it in `warnings` and exits
    0) because the file is complete under its name. The file then has two names, and the next write of it is refused as
    a hard link that names the leftover — a `.<name>.<pid>.<random>.tmp` in the same folder that is the same file. A
    `link` that answers `EEXIST` for a link it made (NFS, when the reply to a retransmitted request is lost) is read
    as published when the target is the sibling's own file — the same device and file id — and the sibling has exactly its
    two names (a link count of two: a file id alone is not proof, since ReFS, a Windows Dev Drive, does not guarantee its
    64-bit ids unique).
  - **Tests.** `power-apps-service-client.test.js` (other hosts, `http:`, a relative URL, credentials and ports,
    every other method, a redirect, a token failure, the token's absence from every message and every answer),
    `sdk-first.test.js` and `pac-fallback.test.js`, `maker-sdk.test.js` (the opt-in), `list-connections.test.js` and
    `list-connections-sdk.test.js`, `connector.test.js`, `solution-settings.test.js` (the sanitizer: the classification
    of secrets, the whole-word rule for a short value that nothing says is a secret, the decoded views, each spelling in a
    message of its own — `helpers/value-spellings.js` writes the
    spellings out independently of the script — the 600-character boundary and white space in a secret, and that the
    skill, this file and the CHANGELOG state the limits the sanitizer has), `sdk-http-client.test.js` (`sendOnce`, over
    every replay path; the strict multipart parser, held to the parser it replaced over a corpus of well-formed answers and of
    answers with a line deleted, cut in half or replaced — it may prove less, never more; and the transport's decision by Node's own
    error code, with the words read only when there is none), `safe-fs.test.js` (the exclusive create: the retry of a held sibling, the warning and the error
    that name it, the refusal that names a leftover, the lost-reply check and the link count it needs),
    `process-runner.test.js` (the forwarder grammar, and a call ended whole with real processes, containment asserted)
    and — against the real bundle
    over a fake Business Application Platform, Power Apps service and Dataverse — `connectivity-real-bundle.test.js`
    (including a table of hosts given to the real SDK, which pins `connectivityCloudOf`) and
    `solution-settings-real-bundle.test.js`, which also run each script in a process with a fake `pac` alone
    on `PATH` (or none), including a `pac` installed the way the Windows MSI installs it (a two-line `pac.cmd` and
    a native launcher beside it), and put each spelling of a secret in a run of its own. The codes and wording the
    rule leans on are pinned there, so a re-vendored SDK that
    changes one fails there. `pac-fallback-commands.test.js` is a source scan: no script runs
    `pac model list-languages`, and `pac connection list`, the two connector verbs and the two solution verbs
    are written only in the one script that asks the SDK first, in the one function that runs them, which is called
    only from its fallback (or, for the tabular form and `--package` with no `--env`, its `pac`-only path).
    `solution-settings-snapshot.test.js` says what only the operating system can: on Windows, in a temp folder that
    grants the Users group read access and in a plain one under the user's own temp folder (where Windows gives a new
    folder entries of its own for SYSTEM and Administrators), and for the work folder in each of the two places it is
    made in (the plugin's own folder, and the temp folder itself — a file where the plugin's folder would be — which is
    where a folder that cannot be used sends it), the folder and the copy each have the current user's SID as
    their ONE access entry (read back through PowerShell, a route independent of the `icacls` the code uses, and
    compared as full SIDs, never by the alias the SDDL text uses), and when
    `icacls` cannot be started the import is not run through `pac`; elsewhere the modes under a hostile umask, in each
    of the two places; and, with
    a real child process that runs the importer, that the copy is in the folder the maker made for the run (the
    plugin's own folder, the run's pid, recorded and lent) and is gone after `process.exit`, an uncaught error and — on
    POSIX — SIGINT, SIGTERM and SIGHUP (the child ends BY the signal) and — on Windows — a REAL Ctrl+C and Ctrl+Break
    (the child ends with 0xC000013A, as one that registers nothing does: `helpers/console-event.js`); and that a run
    that is KILLED for real leaves its folder, copy and all, which a sweep keeps while it is young and removes once it
    is old. `killed-run-workspaces.test.js` also runs the template path over a fake pac that cuts the run short —
    `process.exit`, an error nothing catches and, on POSIX, a SIGTERM — and holds that the workspace lent to pac goes
    and the plugin's folder it was in goes with it (the maker's own listener runs first and cannot take that folder).
    The tests find the work folder by `helpers/solution-settings-work-folder.js`: its name in either place, the
    plugin's folder of a given temp folder, the files in it but for the owner record, and a refusal of each way of
    making it (`fs.mkdtempSync`, which the maker calls for both). `private-folder.test.js` runs the Windows
    sequence over a stand-in for the process runner (the SDDL `icacls /save` writes, the CSV `whoami` prints, the order of
    the steps, the System32-only lookup, every way to fail closed, the question put to the machine about `LA` and `LG`)
    and the POSIX one over a stand-in for `fs`, and, with the real tools, how this machine writes its own Administrator
    and Guest (resolved by .NET's SDDL reader, not by the RID);
    `exit-cleanup.test.js` the signal handling over a stand-in for `process` (both platforms), and real children for the
    rest — a signal the child raises in itself (on a later turn, as a delivered one arrives, and in the very turn that
    the program put a handler in place, which is where the handler's place on the list matters; and a cleanup that the
    program releases from the process's own `removeListener` or `newListener` notification, which must stay released),
    so that the status
    logic runs on every platform, and on Windows real console events. A console event reaches EVERY process on the
    console it is sent on, so `helpers/console-event.js` starts each child in a console of its own and sends nothing
    until that console has been listed and holds the child and the sender alone (`console-event.test.js` pins the
    refusal). The same helper says when a console test SKIPS and when it FAILS, once for the three files that send an
    event (`consoleVerdict`, `controlProblem`): a machine that cannot send an event — a constrained PowerShell, a console
    that cannot be attached or listed — or whose control (a child that registers nothing) does not end as a cancelled
    process says nothing about the code, so the test skips and says why; an event delivered to a console that another
    process shared, and any defect of the sender or the child, fail. `console-test-skips.test.js` runs each file's
    console tests against a stand-in for the helper that sends nothing, as each kind of machine would answer, and
    reads what the file does. `solution-settings-tokens.test.js` runs the real script over the fake platform with the
    platform configured to quote the access token in each place a text of another party can reach an output (a staging
    that failed with HTTP 200, the reason `pac` was asked, `pac`'s own words, a template's default values, a library's
    `console.error`), reads both streams and every file, and scans the script for any other place that writes; with the
    removal of the work folder held (`helpers/fake-held-work-folder-preload.js`) it also reads what a folder that cannot
    be removed keeps on disk — `pac`'s template and the package the SDK exported, both holding the token as a default,
    emptied — on success, after a `pac` that failed, with no package, and when the process ends while `pac` runs. The two big
    files above make the copy the plain way (`helpers/plain-private-file.js`: the real one starts `whoami` and `icacls`,
    about half a second a copy, and is pinned in the two files just named), in-process and, through the preload, in a
    child process — unless its configuration says `realPrivateFolder`.
    `pac-allowlist.test.js` is the plugin-wide list of what `pac` is still started for, read over every script AND every
    hook, `.js`, `.cjs` and `.mjs` (`tests/helpers/production-scripts.js`, which skips `vendor/`, `_vendor-build/`,
    `node_modules/` and `tests/`): a new way to start it fails there until it is argued for. The one start no refusal of the
    SDK precedes — the settings template made offline from a zip, `template --package` with no `--env` — is a named route in
    that file (`NAMED_ROUTES`), pinned to its one call and its `if (!request.env)` guard.
- **Two layers re-send, and for a delete they add** (`scripts/tests/sdk-resend-layers.test.js` pins every
  count). The HTTP client re-sends a 429 or 5xx — except a record delete and a `$batch`, which it
  re-sends only for a deadlock (SQL 1205) or a 429, and a publish (`PublishXml`, `PublishAllXml`), which it
  sends ONCE but for a 401 (the token is refreshed) and a 429 of the service protection limits
  (`0x80072322`/`21`/`26`, waited out inside the run's budget): a publish the customization lock refused
  (429 `0x80071151`) is not shown to change nothing — measured under the lock, a later accepted publish
  published a web resource's OLD content, and an accepted re-send answered 204 while publishing old content —
  so it reaches the caller as it came. A publish's deadlock victim is re-sent by ONE layer: the SDK's
  `publishXml` for its own publishes, `lib/publish-xml.js` (`postPublishXml`, 1 s / 2 s / 4 s) for the
  plugin's raw table and app publishes — a persistent one costs four sends, not the client's six times the
  SDK's four. The SDK re-sends a deadlock for reads, an app
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
  model) or `ROW_SUMMARY_MODEL_NOT_DELETED` (the model left behind, naming it). It looks the skill row up itself and
  answers `{ removed }`: `true` once the row summary the table had is gone (its skill row deleted, or already gone when
  the delete arrived), `false` — deleting nothing — when the table had none. Teardown's `aiSummary` step makes no lookup
  of its own and says what that answer says: `removed` is `(1 deleted)`, and nothing is `(not found)` — counted with the
  steps that found nothing, never as a deletion — as is an environment with no AI skill table (the SDK's lookup answers
  404). (The SDK used to answer nothing in both cases, so a step that only called it printed `(1 deleted)` for every
  table without a row summary, and 2.16.0 looked for the skill row first, with a request of its own.) It is still
  best-effort for failures: a lookup or a removal that throws (`kept — 1 not removed: <the SDK's words>`; a first row
  that is no row is one — a failure of the lookup, never "no row summary") fails nothing, and the closing line counts it
  with the kept steps, not the deleted ones, as its own step line does (`teardown-row-summary-removal.test.js` holds all
  of it over the real bundle). The table delete that follows reports the dependency if the skill row is still there, and
  a model left behind blocks only a later row summary for the same table, by name.
- **A web resource whose publication the SDK cannot confirm is recorded, put in the solution, and written again by the
  next run** (`scripts/tests/web-resource-unconfirmed.test.js`). The SDK reads a web resource's PUBLISHED content back
  after every create and every content write it publishes — one GET per write (the lifecycle matrix's first build reads
  four more) — and throws `WEB_RESOURCE_UNVERIFIED` when the publish failed or the read-back could not confirm the
  content: after the row exists, with its id (`error.id`) and the failure as its non-enumerable `cause`. A second
  create of the name is refused. Measured under the customization lock, a publish the lock refused was followed by a
  later accepted publish of the OLD content, so the content has to be WRITTEN again, not only published. At each place
  the build writes one — the spec's web resources, the generated app icon, the page manifest — it keeps the row's id
  and records it in `web-resource-unconfirmed.<hash>.json`, one file per environment in the build workspace
  (`lib/web-resource-records.js`), adds it to the solution as the success path does, and stops with the SDK's words
  (the row, its id, why it is unconfirmed) and the build's: UNCONFIRMED, not lost — run the build again. The run that
  follows — the build's own re-run of the halt, and a new invocation on the same workspace — writes the content again
  by id (`updateWebResource`, which publishes and reads it back again) and clears the entry once that verified and the
  row is in the solution; a row that is gone by then is created again only if no conflicting replacement was found.
  A receipt whose id and a live row's name disagree, or whose name now belongs to another id, stops recovery without
  adopting or overwriting the other row. A failed solution add retains the receipt; its 404 is not a missing resource.
  A web resource of that name the record does not
  hold — another maker's, or one whose write was confirmed — is reused untouched, as before. The page manifest's own
  dedup compares with its PUBLISHED copy (what `readPageManifest` reads), so an update whose publication was not
  confirmed is written again whenever that copy is still old; the record supplies the id of a manifest created and never
  published, which no plain read finds (assumed, not measured). The pages a halted run created are bound by their
  creation receipts, so none is created twice. The build's retry reads the error as a wrapper of its cause
  (`CAUSE_WRAPPER_CODES`, `lib/retry-policy.js`): a lock refusal, a 503 or a reset is run again, a 400, 401, 403, 404,
  412 or a typed refusal is not, and no cause (the read-back differed or carried no content) is run again. An unchanged
  rebuild reads one local file and sends nothing more. Recovery of a recorded spec resource or icon checks its published
  name by id first (one extra GET; 404 can also mean unpublished, so only an update's 404 proves it gone). A recorded
  manifest whose name lookup is empty makes that same identity check before any page writes. Without a writable recovery
  record the build still attempts the solution add, but does not automatically replay the phase; the halt requires
  recovery by the known id. Not covered: a process killed while the SDK publishes (no error,
  so no record — the next run reuses the row as before), and another workspace (no record, and no page receipts).
- **Changes in the same SDK release that no plugin path reaches** — read these again before a plugin change
  reaches one. (`importSolution`, which now requires `overwriteUnmanagedCustomizations`
  and `publishWorkflows`, was on this list while no script called it. `solution-settings.js import` does, with
  `pac`'s defaults for both; `sdk-surface-contract.test.js` fails on a call that is not listed. An Active
  business process flow's edit in one conditional change set was on it too, while the build only created a
  flow and toggled the state of one that existed; a rebuild now edits stages through it — below.)
- **Changes in the same release that the plugin's paths DO reach, with the outcome unchanged** — re-test them
  when one of these paths changes.
  - *Business process flows.* A flow the build reuses has its stages and steps compared with the spec's, and the
    edits that leave every deployed stage in place are written through the element surface and pushed once: an
    Active flow in one conditional change set (it needs a client with `postRaw`, which the plugin's has) and left
    Active, a Draft flow in one PATCH, every stage and step keeping its id. A flow whose primary composite holds a
    branch (or another non-stage activity) refuses a stage addition before any request, a stage action does not
    refuse one, and a rename keeps what the
    SDK does not model. All of it is pinned against the real bundle in `bpf-stage-edits.test.js`.
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
- **On only for the page backend: `readConcurrency`**, which overlaps a generative page's file downloads and
  `fetchSolution`'s component reads. The page backend (`lib/genpage-sdk.js`) reads pages through the SDK, so its
  SDK is created with it (4: a page is a handful of file reads, and verify and download read many pages); no script
  fetches a solution. `scripts/tests/sdk-opt-ins.test.js` fails if the option is passed where no script reads a
  page or a solution, or if a script starts to make one of those reads without passing it.
- **Left off: creating the app as a draft (`published: false`), so the final publish covers it.** A
  draft is not in the published projection: a by-id read answers 404 and `findArtifact('app')` finds
  nothing, and so does every other probe the build, verify and download make — the collision gate, the
  sitemap and navigation reads of the pages phase, the app-shell "does it exist" check. A failed first
  build would leave an app its own re-run cannot see, the pages phase right after the create would find
  no sitemap, and a build without `--publish` would never publish it. The app is created published;
  `scripts/tests/sdk-opt-ins.test.js` pins the SDK facts this rests on and that no script but `apps.js`
  passes `published: false`. `apps.js create` does, without `--publish`, because that flag has to mean
  what it meant to `pac model create` and, after a create that worked, nothing it does looks the app up by
  name or id: the ids it needs are chosen before the first write. (A create that failed does read the app
  back, by its unique name in both layers, to say what it left; that read sees a draft, which the build's
  probes do not.)


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
`unpublished()` answers "was every saved change published?", and the saved layer of a collection
(`RetrieveUnpublishedMultiple`, `componentstate` 0 or 1 by the same test) is what a halted build's warning is compared with
(`publish-halt-warning.test.js`; `table-publish.test.js` pins the pieces, and the order and count of the publishes before the app
are pinned in `sdk-build.test.js`). Which tables the build publishes before the app is pinned end to end in
`publish-scope-real-bundle.test.js`, over the real bundle and `helpers/fake-app-build-org.js` (the same fake with the app, its
sitemap and its components added, and an `intercept` hook that makes the platform refuse a read or leave a row out): a table that
is only a lookup's target, only read by a page, or only pinned in `app.tables` keeps a maker's unfinished form unpublished, a
navigation table is published before the app by the build that writes the app (so a form already live with a saved label that
the build pins into the app in that same build is protected, the first build included), a table the app holds a form or chart
of — through a form a maker added to it, on a table the spec never names, or one never published, included — is published
before the app, a read of the app's components that is refused, incomplete or ambiguous publishes only what the build changed and
what its write of the app adds and says which read failed, and the sequences of `PublishXml` requests of a first build and of an
unchanged rebuild are pinned in order. The fake's plain read of a component by id answers the published layer only, as the
platform's does, and the saved layer (`RetrieveUnpublishedMultiple`, by table or by id) answers every record: a form the app
holds that was never published is therefore found by the saved-layer lookup and by no plain one. The same file pins every way
the build writes the app: with the real page backend over the stateful fake of the page tables (`FakeGenPageServer`) and the real
placement of default views, a page edited only by a byte order mark — which the real classifier sends down the changed-only fast
route — that has to pin a default view the app lost sends the request before the placement's first write (and, with nothing to
repair, writes and publishes nothing); the pages finalizer and the publish phase of a run with no app step, and the push that only
carries the routing description, do the same; a refused request, an unreadable component list and a row of it that cannot be
placed each give their one warning; the placement's push adds the view it pins and no form, so it names no table of the navigation (a
table an entry was pointed at, or one a maker added a Main form to, keeps what was saved on it), while the routing-description push sends
the tables of the navigation IT sends, not the spec's (a navigation entry a maker removed, or pointed at another table, in the designer is
followed); a Main form renamed on the server (the spec's
`app.mainForms` names it) does not stop the repair, with or without `--publish`; and a read of the engine's source fails on any call to the SDK for the app outside
`appWriters`. (The fake org holds the page manifest, a web resource, and lists the generative pages a test records in `org.pages`.)
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
node scripts/verify-model-app.js  --env <envUrl> --spec @<dir>/app-spec.json   # add --language-code <lcid> when the build was run with it
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
- **Commands are read as text, not as a shell.** The graders (`lib/evidence-utils.js`: its header comment is the
  reading model) take a recorded command — an event's `command` and `argv`, or a line of a workflow log — as words
  (a quoted run is one word, so a quoted mention is data), find every run of `apps.js`, `genpage.js` and
  `solution-settings.js`, and read each one's verb the way the script does: the first positional argument after
  its flags (`apps.js --env <url> create` is `create`; in `--search create` it is a value; a switch such as
  `--publish` takes none — an inference made on purpose, fail-closed: the scripts' own parser gives a switch the
  next word, so `genpage.js --include-unpublished list` has no command to the script but is read as `list`), for
  `solution-settings.js` its first argument. Every run counts, so a call that reads
  and then writes (`apps.js list …; apps.js create …`) is a mutation for the auth-gate, refusal and result-event
  checks (`lib/workflow-evidence.js`), and the phase expectations about listing, creating, downloading and
  generating types (`lib/expectation-evidence.js`: `LIST_APPS`, `CREATE_APP`, `GENERATE_TYPES`, `GENPAGE_LIST`,
  `GENPAGE_DOWNLOAD`, `TYPES_RUN`) read the same verb, so a skipped phase is not credited to a run that did it
  with its flags first. `solution-settings.js import` and the `pac solution import` it falls back to are
  mutations; `template` is not. A listing printed as the scripts print it, one line of JSON, is read as data —
  as an object, as a string result or as a log's `Result:` line; JSON that does not parse lists nothing when it is
  an event's result (on a log's `Result:` line it goes on to the PAC table reader, as before), and a PAC table
  still goes to the table reader. A phase pattern still matches its older raw-text form as well, so a run inside a
  wrapper's string (below), which the verb reader does not read, can still credit a phase, as it always did. **Limits, by design** — a reader of recorded text that modelled
  shell syntax would need a shell and never be finished: a command line handed to a wrapper as one string
  (`bash -c`, `cmd /c`, `pwsh -Command`, `eval`) is one quoted word and is not read, a variable, an escape or a
  line continuation is not followed, and the text of a here-document is read as if it were commands; prose is
  not told from a command (a log line that names a write after a read is graded as the write); `;`, `&&` and `|`
  are not told apart, so the environment a write is compared with its gate by is the call's last `--env`; the
  phase expectations count a call once and read its text, not its `argv`. `tests/script-verbs.test.js` pins
  the reading and these limits.

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
Claude Code, headless, isolated, only this plugin loaded) invokes for each of 35
prompts: `/genpage` vs `/app-builder` from both sides of their boundary, plus
negatives that share vocabulary (Power Pages, canvas, Power Automate, a generic
React dashboard, a code app — several of them saying outright that the request
is not for Power Platform, Dataverse or a model-driven app) and positives that
carry a "not" about the other skill or the schema. The offline harnesses above grade what a run *produced* and
cannot see a mis-route; both skill descriptions point at each other, so a
wording change to one can start stealing the other's prompts. The agent is
killed at its first plugin-skill call, so a trial costs about one model turn;
cases are graded as a pass rate over N trials, on the first plugin skill the agent
asks for at any turn. The decision of its **first turn** is reported beside that
grade and never in place of it: a skill it reaches for only after a first turn that
chose none (a stand-in, perhaps, when its read-only menu has no way to do the work)
still fails a negative case, and the case line says the first turn chose none. **Run it when you edit a skill
`description:`.** It is not a per-PR gate (cost, non-determinism):
`model-apps-agent-evals.yml` runs it on a same-repo PR labelled
`run-agent-evals`, weekly, and on demand, using Copilot CLI authenticated by the
workflow's own `GITHUB_TOKEN` (`copilot-requests: write`) — no secret to
provision. Its parsing/grading/process code is unit-tested on every PR against a
fake agent. See [`evals/model-apps/routing/EVAL_GUIDE.md`](../../evals/model-apps/routing/EVAL_GUIDE.md).

A skill `description:` has to stay under 1,024 characters (GitHub Copilot's limit, enforced by
`scripts/validate-skill-descriptions.js`), so say what a request needs and leave process detail to the skill
body. The descriptions of `/genpage`, `/app-builder` and every agent also say what they are **not** for: a
generic or standalone React or web app, the other Power Platform products, and a request that rules out
Power Platform, Dataverse and model-driven apps. `evals/model-apps/routing/tests/descriptions.test.js`
pins those sentences and the trigger phrases the positive cases route on.

```bash
node evals/model-apps/routing/run-routing.js --dry-run                 # what would launch
node evals/model-apps/routing/run-routing.js --tier smoke --runs 1     # quick local check
node evals/model-apps/routing/run-routing.js --out after.json --compare before.json
```
