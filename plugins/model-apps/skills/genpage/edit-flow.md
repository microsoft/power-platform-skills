# Edit Flow

The orchestrator follows this flow when the `genpage-planner` returns
`{ "action": "edit" }` in Phase 1 of the create flow. The skill delegates planning
to `genpage-edit-planner`, then applies the edit inline.

> **⚠️ CRITICAL — do NOT hallucinate app or page names.** App names and page
> names are discovered by running `pac model list` and `pac model genpage list
> --app-id <id>`. Never guess them from the repo, the conversation context,
> sample app names, or anywhere else. Always run the commands first, then
> present what the commands returned to the user.

> **⚠️ Unattended runs cannot select a target.** This flow **overwrites an
> existing page**, and every selection step below is an `AskUserQuestion`. Under
> Copilot autopilot or Claude auto-accept there is nobody to answer, and the one
> thing an unattended run must never do is guess which page to overwrite.
>
> Resolve the mode as described in SKILL.md ("Unattended runs") before Phase 1.
> When `interactive` is `false`, the app **and** the page must both be named
> explicitly in `$ARGUMENTS`. Never substitute a search result, and never fall
> back to "the only match" — a single match is still a guess when nobody asked
> for it. If either is missing or ambiguous, **halt** and report what was needed.
> Suppressing a prompt never authorizes an overwrite.

## Edit Phase 1: Discover and Select Target App + Page

The planner has already validated prereqs and confirmed auth.

**Capture the environment URL first.** Everything below — the download, connector
discovery, and the edit planner — must target the same environment, and connector
discovery is mutating, so it must never fall back to "whatever `pac auth` points at
now":

```bash
node "${PLUGIN_ROOT}/scripts/check-auth.js" --require-pac
```

Keep the returned org URL as `envUrl` for the rest of the edit session.

**CRITICAL — never guess or invent app names or page names.** You must discover
them by running the PAC CLI commands below. Hallucinating page names from context
(repo names, prior conversation, sample apps) is wrong and confuses the user.

### 1a. Discover available apps

```powershell
pac model list
```

This returns the list of model-driven apps in the active environment. Parse the
output for **App ID**, **Display Name**, and **Unique Name** fields.

Behavior by app count:
- **0 apps:** Tell the user "No model-driven apps found in this environment.
  You can't edit a page that doesn't exist — would you like to create one
  instead?" and stop the edit flow.
- **1 app:** Confirm with the user: "Found app **[Display Name]** ([app-id]).
  Use this one?" via `AskUserQuestion` with Yes / Cancel options.
- **N apps:** Present a multi-choice question via `AskUserQuestion`. Each option's
  label is the app's **Display Name** (truncate to <50 chars). The description
  includes the app-id GUID. Always include an "Other" option for the user to
  type an app-id or name directly.

Record the selected `<app-id>`.

### 1b. Discover existing pages in the selected app

```powershell
pac model genpage list --app-id <app-id>
```

This returns the list of generative pages already deployed in the selected app,
including **Page ID** and display name.

Behavior by page count:
- **0 pages:** Tell the user "This app has no generative pages to edit. Did
  you mean to create a new page?" and stop the edit flow.
- **1+ pages:** Present them via `AskUserQuestion`. Each option's label is the
  page's display name; the description includes the page-id GUID.

Record the selected `<page-id>`.

### 1c. Confirm selection

Restate the selection to the user before proceeding:

> "Editing **[page display name]** in app **[app display name]**.
> Continuing to download the existing page code…"

No `AskUserQuestion` here — this is a status update before the next phase.

## Edit Phase 2: Download Existing Page

```powershell
pac model genpage download `
  --app-id <app-id> `
  --page-id <page-id> `
  --output-directory <working-dir>
```

The download creates a `<working-dir>/<page-id>/` folder with fixed filenames:
`page.tsx` (source), `config.json` (entity list + model), `prompt.txt` (original
prompt). Downstream phases operate on `<working-dir>/<page-id>/page.tsx` for
editing and uploading, and read `config.json.dataSources` plus
`config.json.connectorBindings` in Phase 3.

## Edit Phase 3: Generate RuntimeTypes (Conditional)

Read `<working-dir>/<page-id>/config.json`. If `dataSources` is non-empty, the
page uses Dataverse entities — generate the schema:

```powershell
pac model genpage generate-types `
  --data-sources "entity1,entity2" `
  --output-file <working-dir>/RuntimeTypes.ts
```

Pass the exact entity list from `config.json.dataSources`. If `dataSources` is an
empty array, the page is mock-data only — skip this phase.

Also read `config.json.connectorBindings` and `config.json.actionBindings`.

> **Connectors are owned by `genpage-connector-builder`, dispatched by this
> top-level edit orchestrator.** Unlike the create flow, the mode here is already
> `edit` and `envUrl` was captured in Edit Phase 1, so discovery can safely run
> before edit planning when the intent already names a connector source. (If the
> need only surfaces during the edit planner's clarification, it returns
> `connector_discovery_required` and discovery runs then — see Edit Phase 4.)
> Read the existing `config.json.connectorBindings` (the current bindings) and
> decide the connector action from the edit intent:
>
> - **Add / replace / discover connector data:** invoke `genpage-connector-builder`
>   via `Task` with **Mode: `edit`**, the working directory, `${PLUGIN_ROOT}`, the
>   `envUrl` from Edit Phase 1, the existing bindings, and the edit intent. The
>   builder owns the rollback gate: when connectors are off it preserves existing
>   bindings and adds none; otherwise it discovers and returns the updated set. It
>   writes `<working-dir>/connectors.json` (bare array) and
>   `<working-dir>/connector-bindings.md`.
> - **Remove one (or some) connectors:** invoke `genpage-connector-builder` the
>   same way with the remove intent and the existing bindings. The builder
>   reconciles the existing set **minus** the named binding(s) and writes the full
>   desired `connectors.json` (the remaining bindings, or `[]` if that removed the
>   last one) plus the matching `connector-bindings.md`. Pass `--connectors` on
>   upload — this is a full replace, so omitting it would leave the removed binding
>   deployed.
> - **Preserve connectors unchanged:** do not invoke the builder and do not create
>   a replacement `connectors.json`; omit `--connectors` on upload so pac preserves
>   deployed bindings. Still pass the existing `connectorBindings` summary into the
>   edit planner so it can preserve connector-backed code correctly.
> - **Clear all connectors:** write `[]` to `<working-dir>/connectors.json` and a
>   `connector-bindings.md` body of exactly `No connector bindings.`, then pass
>   `--connectors` during upload so pac clears `config.json.connectorBindings`.
>
> **The builder is headless and may return `{ "action": "needs_input", … }`** (for
> example, an ambiguous connection or operation choice). When it does, drive the
> same loop the create flow uses: ask each question with `AskUserQuestion`, record
> every exchange in `workflow-log.md` as `AskUserQuestion: <question> → <answer>`,
> and re-invoke the builder with the answers plus everything it already returned.
> Do **not** continue to Edit Phase 4 until the builder returns its binding files —
> proceeding on a `needs_input` return ships connector code with no matching binding.
>
> If `genpage-connector-builder` instead reports that its declared
> process-execution or file tools are unavailable, do **not** retry the same worker. Record the failure,
> read `agents/genpage-connector-builder.md`, and run the worker workflow inline
> in this orchestrator with the already-captured edit mode, `envUrl`, existing
> bindings, and edit intent. This inline fallback preserves every feature gate,
> discovery rule, and mutation boundary from the agent file.

- Do not add or persist connection IDs. Env-specific `ConnectionId` values belong
  to the connectionreference row and ALM deployment settings, not the page config.

> **Custom APIs are owned by `genpage-customapi-builder`, dispatched by this same
> top-level edit orchestrator.** Read the existing `config.json.actionBindings`
> (the current Custom API bindings) and decide the Custom API action from the edit
> intent. Custom API discovery is read-only, so like connectors it can run here,
> before edit planning, when the intent already names a server-side Action/Function.
> (If the need only surfaces during the edit planner's clarification, it returns
> `custom_api_discovery_required` and discovery runs then — see Edit Phase 4.)
>
> - **Add / replace / discover a Custom API call:** invoke `genpage-customapi-builder`
>   via `Task` with **Mode: `edit`**, the working directory, `${PLUGIN_ROOT}`, the
>   `envUrl` from Edit Phase 1, the page tables from `config.json.dataSources` (or
>   `none`), the existing `actionBindings`, and the edit intent. The builder owns the
>   `custom-api` feature gate: when it is off it preserves existing bindings and adds
>   none; otherwise it discovers and returns the updated set. It writes
>   `<working-dir>/actions.json` (bare array) and `<working-dir>/custom-api-bindings.md`.
> - **Remove one (or some) Custom API calls:** invoke the builder the same way with the
>   remove intent and the existing bindings. It reconciles the existing set **minus**
>   the named binding(s) and writes the full desired `actions.json` (the remaining
>   bindings, or `[]`) plus the matching `custom-api-bindings.md`. Pass `--actions` on
>   upload — a full replace, so omitting it would leave the removed binding deployed.
> - **Preserve Custom APIs unchanged:** do not invoke the builder and do not create a
>   replacement `actions.json`; omit `--actions` on upload so pac preserves deployed
>   bindings. Still pass the existing `actionBindings` summary into the edit planner so
>   it can preserve Custom-API-backed code correctly.
> - **Clear all Custom APIs:** write `[]` to `<working-dir>/actions.json` and a
>   `custom-api-bindings.md` body of exactly `No custom API bindings.`, then pass
>   `--actions` during upload so pac clears `config.json.actionBindings`.
>
> **The builder is headless and may return `{ "action": "needs_input", … }`** (for
> example, when more than one discovered Custom API matches the intent). Drive the same
> ask/record/re-invoke loop as for the connector builder above, and do **not** continue
> to Edit Phase 4 until it returns its binding files — proceeding on a `needs_input`
> return ships `executeAction`/`executeFunction` calls with no matching binding.
>
> If `genpage-customapi-builder` reports unavailable declared file or
> process-execution tools, do **not** retry the same worker. Record the failure,
> read `agents/genpage-customapi-builder.md`, and run its read-only discovery and
> binding-output workflow inline with the same feature gate, environment, page
> tables, existing bindings, and intent.

## Edit Phase 4: Plan the Edit

Invoke the `genpage-edit-planner` agent via the `Task` tool. Pass:

- The user's edit intent: `$ARGUMENTS`
- The working directory (absolute path)
- The plugin root: `${PLUGIN_ROOT}`
- The app-id and page-id
- **The environment URL** — the `envUrl` this edit session resolved. Required: the planner
  echoes it back if it has to ask for connector discovery, and discovery must target the
  environment being edited, not whatever `pac auth` happens to be pointing at.
- The download directory: `<working-dir>/<page-id>/`
- The connector action: preserve, add, replace, discover, or clear
- The connector contract: the full body of `<working-dir>/connector-bindings.md`
  when written by the builder/clear path, or a faithful summary of the existing
  `config.json.connectorBindings` when preserving unchanged connectors
- The connector upload file status: `<working-dir>/connectors.json` when upload
  must replace/clear bindings, or `none — omit --connectors` when preserving
- The Custom API action: preserve, add, replace, discover, remove, or clear
- The Custom API contract: the full body of `<working-dir>/custom-api-bindings.md`
  when written by the builder/clear path, or a faithful summary of the existing
  `config.json.actionBindings` when preserving unchanged Custom APIs
- The Custom API upload file status: `<working-dir>/actions.json` when upload
  must replace/clear bindings, or `none — omit --actions` when preserving

Tell the planner that connector and Custom API discovery are both orchestrator-owned:
it must use the forwarded connector and Custom API contracts and must not invoke
`genpage-connector-builder` or `genpage-customapi-builder`.

**If the planner returns `{ "action": "connector_discovery_required", … }`** instead
of an edit plan, a connector need surfaced during its clarification — after the
connector action was already fixed as "preserve". Do **not** proceed to Phase 5.
Dispatch `genpage-connector-builder` with **Mode: `edit`**, the returned `envUrl`
and `intent`, then re-invoke the edit planner with the refreshed connector action,
contract, and upload-file status (`<working-dir>/connectors.json`). Skipping this
ships connector code with no deployed binding, because upload would still omit
`--connectors`.

**If the planner returns `{ "action": "custom_api_discovery_required", … }`** instead
of an edit plan, a Custom API need surfaced during its clarification — after the Custom
API action was already fixed as "preserve". Do **not** proceed to Phase 5. Dispatch
`genpage-customapi-builder` with **Mode: `edit`**, the returned `envUrl`, `pageTables`,
and `intent`, then re-invoke the edit planner with the refreshed Custom API action,
contract, and upload-file status (`<working-dir>/actions.json`). Skipping this ships
`executeAction`/`executeFunction` code with no deployed binding, because upload would
still omit `--actions`.

The planner reads `page.tsx`, `config.json`, and `prompt.txt` for context and
proposes the edit plan. It is a **headless** agent: it cannot ask the user anything
and cannot present plan mode. Drive the loop from here until it completes:

If `genpage-edit-planner` reports that its declared file tools are unavailable,
do **not** retry the same worker and do not hand-write `genpage-edit-plan.md`.
Halt the edit flow with the selected app/page and requested edit recorded. Plan
provenance is a hard gate: unlike the pure discovery builders, the edit planner
cannot be replaced by an inline fallback that invents its approved contract.

- **`{ "action": "needs_input", "questions": [...] }`** — ask each question with
  `AskUserQuestion` in this loop, record every exchange in `workflow-log.md` as
  `AskUserQuestion: <question> → <answer>`, then re-invoke the planner with the
  answers plus everything it already returned. Repeat as needed; each round must
  carry the previous answers forward so the planner never re-asks the same thing.
- **`{ "action": "connector_discovery_required", … }`** — handled above.
- **`{ "action": "custom_api_discovery_required", … }`** — handled above.
- **A proposed plan** — present it with `EnterPlanMode`, record `EnterPlanMode
  called` and the response in `workflow-log.md`, and call `ExitPlanMode` to get
  approval. A re-invocation is a fresh headless run with no memory of the last one,
  so **carry the complete plan state forward every time** — the exact proposed-plan
  body it returned, every prior discovery (connector and Custom API contracts,
  entities), and every answer already gathered. On **approval**, re-invoke the
  planner with that full state plus the approval outcome so it writes the approved
  `<working-dir>/genpage-edit-plan.md` — not a plan it re-derives from scratch.
  Before that approval writeback dispatch, quarantine any prior edit plan:

  ```powershell
  node "${PLUGIN_ROOT}/scripts/genpage-plan-provenance.js" prepare --plan "<working-dir>/genpage-edit-plan.md"
  ```

  Save the edit-plan body the planner returned for approval to a sidecar such as
  `<working-dir>/.approved-genpage-edit-plan.md`, exactly as returned, then after the
  planner returns, verify the file it wrote targets the page that plan named:

  ```powershell
  node "${PLUGIN_ROOT}/scripts/genpage-plan-provenance.js" verify --plan "<working-dir>/genpage-edit-plan.md" --approved "@<working-dir>/.approved-genpage-edit-plan.md"
  ```

  Continue only when the JSON result has `"ok":true`; if the written edit plan is for
  a different page, halt because Phase 5 would overwrite a page the user did not
  approve editing. On
  **changes requested**, re-invoke it with the same full state plus the requested
  revisions and present the revised plan again. Forwarding only the outcome lets it
  reconstruct a different plan or re-ask answered questions (same rule as the create
  flow's Phase 1 step 6).

Only continue to Phase 5 once `<working-dir>/genpage-edit-plan.md` exists — that
file is the approved contract Phase 5 reads, and reaching Phase 5 without it means
applying an edit nobody approved.

## Edit Phase 5: Apply the Edit

Read `<working-dir>/genpage-edit-plan.md` for the approved change list and
preservation constraints.

Also read:
- `${PLUGIN_ROOT}/references/rules.md` — all code-gen
  rules still apply to edits (Fluent UI V9 only, makeStyles with tokens, WCAG AA,
  no `100vh`/`100vw`, etc.)
- `<working-dir>/RuntimeTypes.ts` — if generated in Edit Phase 3, for verified
  column names
- `<working-dir>/<page-id>/page.tsx` — the current source
- `${PLUGIN_ROOT}/references/connectors.md` — if `config.json.connectorBindings`
  is non-empty or the edit adds connector-backed data

Apply each change from the edit plan using targeted `Edit` operations on
`<working-dir>/<page-id>/page.tsx`. **Preserve the functionality** listed under
"Preservation Constraints" in the plan. Use ONLY verified column names from
RuntimeTypes.ts when the edit touches Dataverse data access. Use ONLY logical
names, datasets, table GUIDs, and operations from the seeded connector bindings
or approved edit plan when the edit touches connector data access.

Do NOT rewrite the entire file. Use the minimum necessary `Edit` operations.

Before Edit Phase 6, Grep the edited `page.tsx` with
`['"]?borderWidth['"]?\s*:`. Griffel rejects that shorthand only at runtime;
the regex also catches quoted keys and whitespace before the colon. Replace every match with
`borderTopWidth`, `borderRightWidth`, `borderBottomWidth`, and
`borderLeftWidth`. Do not upload while any match remains.

## Edit Phase 6: Deploy Updated Page

This is an **update** (existing page-id), so the prompt must describe the
**delta of changes only** — not a re-statement of the original page description.
It is written to a file and passed as `--prompt-file`; see SKILL.md Phase 6
"Prompt semantics".

Connector binding rules for edit deploy:
- **Add / replace / discover / remove one connector:** the `genpage-connector-builder`
  agent (Mode: `edit`) has already gated on the flag and written the full desired
  binding set to `<working-dir>/connectors.json` (a removal writes the remaining
  bindings). Pre-flight that `pac model genpage upload --help` contains `--connectors`
  and include `--connectors "<working-dir>/connectors.json"` in the upload — this is a
  full replace, so it also deletes any binding left out of the file.
- **Code/visual-only edit (connectors unchanged):** omit `--connectors`; pac
  preserves existing bindings.
- **Remove every connector:** write `[]` to `connectors.json` and pass
  `--connectors` so pac clears `config.json.connectorBindings`.
- Never write connection IDs.

Custom API binding rules for edit deploy (identical matrix, `--actions` for
`<working-dir>/actions.json`):
- **Add / replace / discover / remove one Custom API:** the `genpage-customapi-builder`
  agent (Mode: `edit`) has already gated on the flag and written the full desired binding
  set to `<working-dir>/actions.json` (a removal writes the remaining bindings). Pre-flight
  that `pac model genpage upload --help` contains `--actions` and include
  `--actions "<working-dir>/actions.json"` in the upload — a full replace that also deletes
  any binding left out of the file.
- **Code/visual-only edit (Custom APIs unchanged):** omit `--actions`; pac preserves
  existing `actionBindings`.
- **Remove every Custom API:** write `[]` to `actions.json` and pass `--actions` so pac
  clears `config.json.actionBindings`.

```powershell
# The edit request is arbitrary user text, and a downloaded prompt is a multi-line
# conversation transcript. Both go to pac BY FILE via scripts/genpage-upload.js, never on a
# command line, so quotes/newlines/metacharacters cannot be reinterpreted by the shell.
Set-Content -Path "<working-dir>/prompt.txt" -Value $editRequest -Encoding UTF8 -NoNewline
Set-Content -Path "<working-dir>/agent-message.txt" -Value $changeSummary -Encoding UTF8 -NoNewline

node "${PLUGIN_ROOT}/scripts/genpage-upload.js" `
  --env <org-url> `
  --app-id <app-id> `
  --page-id <page-id> `
  --code-file <working-dir>/<page-id>/page.tsx `
  --data-sources "entity1,entity2" `
  --connectors "<working-dir>/connectors.json" `
  --actions "<working-dir>/actions.json" `
  --prompt-file "<working-dir>/prompt.txt" `
  --model "<current-model-id>" `
  --agent-message-file "<working-dir>/agent-message.txt"
```

The prompt file holds the user's edit request — **only the changes, not the full page**.

Use `--page-id` for updates. Omit `--add-to-sitemap` (the page is already in
the sitemap; the wrapper refuses the combination anyway).
Omit `--data-sources` when `config.json.dataSources` was empty.
Omit `--connectors` when connector bindings are unchanged.
Omit `--actions` when Custom API bindings are unchanged.

## Edit Phase 7: Verify (Optional)

Offer browser verification via `AskUserQuestion` (same flow as Phase 7 in the create flow — see SKILL.md).

## Edit Phase 8: Summary

Write a `workflow-log.md` file to the working directory (same purpose as Phase 8 in
the create flow).

Then present a summary to the user:

```
## Edit Complete

| File | Changes | Status |
|------|---------|--------|
| <page-id>/page.tsx | <N changes> | Deployed |

App: [app name] ([app-id])
Page ID: [page-id]
```
