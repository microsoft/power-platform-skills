---
name: edit-app
description: "Use when the user wants to iterate on an existing generated Power Apps mobile app after /create-mobile-app: update the plan, data model, native capabilities, design, screens, generated app code, and preview without restarting the full project flow."
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, Task, Skill
model: opus
---

**Shared instructions: [shared-instructions.md](../../shared/shared-instructions.md)** — read first.

# Edit App (`/edit-app`)

Post-generation editor for an existing mobile app. `native-app-plan.md` remains the source of truth, but the default outcome is a fixed generated app, not a plan-only diff. After the user approves the plan delta, continue into Dataverse/native/design/screen mutations, run verification, update `memory-bank.md`, and regenerate the static preview when UI changed.

Use `--plan-only` only when the user explicitly asks to update planning docs without changing app code. Normal follow-up prompts in Copilot Chat Agent mode should apply the app change end to end.

## When to use

- "Improve the search screen to make it easier to use on mobile"
- "Add loading, empty, and error states to the list screen"
- "Add a detail screen for the selected record"
- "Update the design to better match the company branding"
- "Add a form to create a new record in Dataverse"
- "Add barcode scanning and use the scanned value to search records"
- "Generate a new static preview of the updated app"
- "Add a `case` table to the data model"
- "Replace the Drawer navigation with Tabs"
- "Add `expo-camera` to the native capabilities"
- "Add signature capture to approvals and store it in Dataverse"
- "Generate an evidence PDF and retain it on the inspection record"
- "Add a View PDF action for an HTTPS report URL"
- "Reorder screens — move profile out of tabs, into a modal from the home header"

## When NOT to use

- Brand-new project → `/create-mobile-app`
- Just adding one connector with no screen changes → `/add-connector` directly
- Just adding a single native wrapper with no screen changes → `/add-native` directly
- The plan file is missing → re-run `/create-mobile-app` (don't try to reconstruct)

## Workflow

0. Locate app + health/drift probe → 1. Discover intent + inspect existing app → 1.5 Impact preview → 2. Re-plan affected sections → 3. Gate intent, plan + mutation preview → 4. Write plan diff → 5. Apply app mutations → 6. Rebuild affected screens → 7. Verify + quality sweep → 7.5 Targeted runtime smoke/debug → 8. Preview + memory-bank update

---

## Edit Quality Gate Policy — no quality compromise

This is a focused edit workflow, not a lighter quality bar. Reuse `/create-mobile-app` gates at edit scale.

**Required gates by edit type:**

| Edit touches | Required gates |
|---|---|
| Any source file | Existing-app health gate, final `npx tsc --noEmit` |
| Dataverse/schema/connector | Environment drift gate, data-source/schema gate, Generated Services snapshot refresh, final `tsc` |
| Navigation/routes | Navigation/layout gate, route contract check, final `tsc` |
| New screen | Shared scaffold gate, skeleton gate, screen-builder wave gate, style-quality sweep, route check, final `tsc` |
| Existing screen TSX | Screen edit gate, style-quality sweep, route check when navigation changed, final `tsc` |
| Native capability | Native allowlist gate, wrapper existence gate, final `tsc` |
| Design/component/density | Design-system gate, affected-screen style sweep, preview |
| Runtime behavior | Targeted smoke/debug gate when Metro is running or user requested runtime verification |

**When a gate fails:** capture full output once, classify by root cause, repair in a batch, rerun the same gate once. Do not make line-by-line fixes with `tsc` after every tiny edit. Continue only when the gate is clean or record a `BLOCKED:` / `DONE_WITH_CONCERNS:` entry in `memory-bank.md`.

**Hard stops:**

- Do not run data-source mutations if the app root/environment cannot be identified.
- Do not launch screen-builders from broken generated services, route layouts, shared code, or skeletons.
- Do not import native wrappers in screens before `/add-native` has generated them.
- Do not hide unsupported native capabilities behind mocks or TODOs just to satisfy TypeScript.
- Do not mark an edit successful if changed screens fail TypeScript, route contracts, or required validators.

### Step 0 — Locate app + health/drift probe

```bash
test -f native-app-plan.md && echo "OK: plan found" || echo "ERROR: no plan"
test -f package.json && echo "OK: package found" || echo "ERROR: no package"
test -d app && echo "OK: app routes found" || echo "ERROR: no app routes"
test -f memory-bank.md && echo "OK: memory bank found" || echo "WARN: no memory bank"
git status --short
```

If `native-app-plan.md` is missing → STOP. Tell the user this skill edits an existing generated app; they should re-run `/create-mobile-app` on a fresh template or manually recreate the plan before using this editor.

Read if present:

- `memory-bank.md` — project facts, target environment, visual companion flag, prior blocks
- `.datamodel-manifest.json` — existing Dataverse tables/columns
- `brand/design-system.md` and `brand/tokens.ts` — design constraints and token availability
- `src/generated/services/*.ts` and `src/generated/models/*.ts` — generated data surface

Run these existing-app health checks before any mutation:

| Check | Action if unhealthy |
|---|---|
| `memory-bank.md` exists and has expected headings | If missing/corrupt, ask whether to proceed with reduced resume safety; create/update only after approval |
| `power.config.json`, `.resolved-environment.json`, and memory bank env agree | For data-source/schema edits, STOP until the user confirms the intended environment |
| `src/components/index.tsx`, `src/hooks/index.ts`, `src/utils/index.ts`, `src/tokens/index.ts` exist | Restore missing shared scaffold from `shared/samples/src/` before screen-builder work; do not overwrite existing files |
| `app/_layout.tsx` still wraps providers and SafeAreaProvider correctly | Patch conservatively before screen work; route/safe-area validators depend on this |
| `src/generated/` compiles when the edit depends on generated services | Regenerate schemas/services first, or block before screen work |
| `node_modules` and package scripts needed for verification exist | If missing, ask user to run install; do not pretend verification passed |

If the worktree has uncommitted changes that overlap likely edit targets, show the affected files and ask before continuing. Do not revert or stash automatically.

If the app already fails `npx tsc --noEmit`, capture the errors once. Continue only when the failures are in files this edit will touch or are generated-service drift this edit can repair; otherwise surface the pre-existing failure and ask whether to proceed. If the edit would add screens or generated services, clean the prerequisite gate before continuing.

### Step 1 — Discover intent + inspect existing app

Infer from `$ARGUMENTS` when possible, but do not mutate files until you have a concrete edit brief. This is the mini `/create-mobile-app` requirements phase for one existing-app change.

First inspect the app so questions can use real options instead of abstractions:

```bash
find app -name '*.tsx' -not -name '_layout.tsx' -not -name '+not-found.tsx' | sort
ls -1 src/generated/services/*.ts 2>/dev/null | sed 's|src/generated/services/||;s|\.ts$||'
ls -1 src/generated/models/*.ts 2>/dev/null | sed 's|src/generated/models/||;s|\.ts$||'
find src/native -maxdepth 1 -type f -name '*.ts*' 2>/dev/null | sort
```

Also read the relevant `native-app-plan.md` sections (`## Data Model`, `## Native Capabilities`, `## Design`, `## Screens`, and `## Generated Services` if present) plus the existing TSX for any candidate screen. If `brand/design-system.md` exists, read it before asking design/screen questions so the edit preserves product grammar, density, component rules, and negatives.

Ask only for information that cannot be inferred from the app. If there is exactly one plausible screen/table/service, state the inferred choice in the mutation preview instead of asking. If there are multiple plausible choices, ask a small multiple-choice question with those real names.

Build an edit brief before Step 2:

```markdown
## Edit Brief
- Intent: <what user wants to accomplish>
- Target screens/routes: <existing or new>
- Data surface: <generated service/table/connector, or none>
- Native capability: <wrapper/control needed, or none>
- Design scope: <tokens/component grammar/screen-specific, or none>
- Plan sections to update: <Data Model / Native Capabilities / Screens / Design / Connectors>
- App files likely touched: <routes/layouts/src/native/src/generated/brand/etc.>
- Verification gates: <schema, tsc, routes, validators, preview>
```

If the edit brief is incomplete after inspection, ask scenario-specific questions before continuing.

Ask via `AskUserQuestion`:

> "What should this app edit change?
> (a) Data model — add/extend/reuse Dataverse tables
> (b) Native capability — camera, scanner, PDF, pen, files, secure storage
> (c) Screens/navigation — list, search, detail, form, tabs, states
> (d) Design — palette, typography, components, density, brand rules
> (e) Connector/data source — SharePoint, Office, custom connector
> (f) Multi-section feature — one user-visible change that needs several of the above
> (g) Preview only
> (h) Cancel"

Then ask: "Briefly describe the change you want."

Scenario-specific questions to ask only when the answer is not already obvious:

| Scenario | Required intent questions before planning |
|---|---|
| Search/mobile usability | Which existing search/list screen? Which fields should search cover? Should search run locally over loaded rows or query Dataverse/connector server-side? Are filters/sort/scope needed? |
| Loading, empty, error states | Which list screen(s)? If no list screen exists, should `/edit-app` create a new list screen or apply states to another data screen? Are there already loading/empty/error components that should be improved rather than duplicated? |
| Detail screen | From which source screen does the user select a record? Which table/service is the record from? Which fields/actions must appear? Should the route be push detail, modal, or formSheet? |
| Branding/design | What is the brand source (brand doc, logo, URL, text description, existing app)? Is this palette-only, typography, component/density, or full reskin? Should all screens update or only named screens? |
| Dataverse create form | Which Dataverse table? Existing table or new table? Which fields are required/editable? Where should the form launch from? What happens after save (back, detail, add another)? Are there lookup/file/image fields? |
| Barcode/QR scan search | Where should scanning live (new scanner screen, existing search screen action, form field)? What does the scanned value represent (record ID, serial number, asset tag, SKU, custom field)? Which table/service/field should it search? What happens on no match or multiple matches? |
| New requirement + screen | What user workflow is being added? Who uses it? What data/native/connectors does it need? Where does it sit in navigation? What is success/failure behavior? |
| New data source | What job does the data source support? Is it structured business data (Dataverse), SharePoint list/library, cloud flow/action, or another connector? Which screen(s), if any, should use it now? |
| Preview only | Preview all screens or only changed/key screens? Should Visual Companion auto-open behavior be honored? |

Existing-state checks before deciding to add vs edit:

- For a named screen, confirm the route file exists. If it does not, ask whether to create it or choose an existing screen.
- For list states, grep the target screen for `LoadingState`, `EmptyState`, `ErrorState`, `refreshing`, and `onRefresh`; improve missing or weak states, do not duplicate existing ones.
- For forms, check generated service methods for `create`/`update` before planning UI. If methods or table are absent, add/refresh the data model first.
- For scanner work, check `src/native/` and the plan's Native Capabilities table for scanner/camera wrappers before screen work.
- For detail screens, check Navigation Contracts and existing dynamic routes before creating another `[id].tsx`.
- For branding, check `brand/design-system.md`, `brand/tokens.ts`, and `tamagui.config.ts` before deciding whether TSX rebuilds are needed.

Use this scenario coverage matrix for common follow-ups. The goal is one user prompt -> one orchestrated edit, not a list of commands the user must run manually.

| User asks | Plan sections | Apply path | Screens / verification |
|---|---|---|---|
| Improve search screen for mobile | Screens | `mobile-app:screen-planner` edit pass only | Rebuild the named search/list screen; run `tsc`, route check, preview |
| Add loading, empty, and error states | Screens | Screen spec + existing TSX edit | Rebuild affected list screen; verify visible loading, empty, error, retry, refresh states |
| Add a detail screen for selected record | Screens; Data Model only if fields/services are missing | Update Screen Map + Navigation Contracts; run `/add-dataverse` or `/add-datasource` only if data surface is missing | Create route/folder/layout as needed; build detail screen and source list/search navigation |
| Update design to match company branding | Design; Screens only if component grammar/density changes | `/design-system --refresh <dimension>` or `--reskin` | Rebuild affected screens only when tokens alone are insufficient; always preview |
| Add a form to create a new Dataverse record | Screens; Data Model if table/columns/lookups/create service are missing | `/add-dataverse --skip-planning` when schema/service is missing | Build form route, create payload helper, parent navigation, and focus refresh; verify create/update payloads |
| Add barcode scanning and use scanned value to search records | Native Capabilities, Screens; Data Model if scan target field is missing | `/add-native barcode-scanner`; `/add-dataverse` only if target field/table is absent | Build scanner/search flow, pause/lock scan callback, search via service filter, preview |
| Add a new requirement with a new screen | Usually Screens plus whichever of Data Model, Connector, Native, Design the requirement implies | Decompose into one coherent feature; apply data/connector/native/design first, then screens | Generate/refresh service snapshot, layouts, skeletons/shared code, then build affected screens |
| Add a new data source but no screen | Connector/Data Source; sometimes Data Model | `/add-datasource` when ambiguous; `/add-sharepoint`, `/add-connector`, or `/add-dataverse` when clear | Refresh generated services and memory bank; no screen rebuild unless the user asked for UI |
| Add a new table/entity but no screen | Data Model | `mobile-app:data-model-architect` -> `/add-dataverse --skip-planning` | Refresh generated services; optionally seed sample data; no preview unless UI changed |
| Remove, rename, reorder, or change a screen archetype | Screens | `mobile-app:screen-planner` edit pass | Update route files/layouts/navigation contracts; delete only approved files; run route check |
| Generate a new static preview | None unless source is stale | `/preview-screens` | No source edits; do not run data/native/design work |

One user-visible feature may require multiple plan sections. That is allowed and expected. Multiple unrelated features in one prompt should be split: list the features, ask which to run first, and do not bundle their mutations.

Loophole checks before continuing:

- If the request adds UI that reads or writes data, confirm the generated service exists or add the data source before screen work. Never let screen-builders invent services.
- If the request is ambiguous about Dataverse vs SharePoint vs another connector, route through `/add-datasource` rather than guessing.
- If a screen requires a native wrapper, run `/add-native` before screen-builders import `src/native/*`.
- If a native capability is not shipped by the template, stop with a clear block; do not install native packages or fake support.
- If the request changes navigation, update route layouts and navigation contracts before spawning screen-builders.
- If the request adds a new screen, generate any needed route folder, generated-service snapshot, shared code, and skeleton before building TSX.
- Do not stop after writing `native-app-plan.md`. The plan update is an internal checkpoint; the app mutation and verification are the user-visible result.

For PDF/signature requests, map the change to every affected section instead of editing only the first obvious one:

| User request | Required plan updates |
|---|---|
| Add signature capture, sign-off, pen, ink, drawing | Native Capabilities: `pen-input`; Data Model: Image/File column or child Evidence/Signature table; Screens: capture action, preview state, cancelled state, upload failed state |
| Store signed approval as Dataverse image | Data Model: Image column; Screens: normalize `data:image/png;base64,...` before update; Native Capabilities: `pen-input` if capture is in-app |
| Generate/export/print evidence PDF | Native Capabilities: `pdf-report` only when `expo-print` is present, plus `sharing` only when local share is needed and `expo-sharing` is present; Data Model: File column only if retained; Screens: generation pending/failed/success states |
| Persist generated PDFs | Data Model: Dataverse File column or child Attachment table; Screens: create/update row first, then upload File bytes; Native Capabilities: `pdf-report` |
| View/open/preview PDF | Native Capabilities: `native-pdf-viewer` only for HTTPS PDF URLs and only when `@microsoft/power-apps-native-pdf-viewer` is present; Screens: invalid URL and viewer failed states |

If a single PDF/signature request requires multiple plan sections, say so and run the edit loop section-by-section. Do not write a native capability entry that references a Dataverse column or screen state that remains absent from the plan.

### Step 1.5 — Impact preview (cheap abort gate)

Before spawning architects or mutating files, show a rough impact preview and ask for proceed/edit/cancel. This mirrors `/create-mobile-app` Step 2c at edit scale.

Compute:

- **Cost tier:** Cheap (single existing screen), Medium (new route/form/detail or one data source), Heavy (multi-screen/nav/design/data/native), Major (reskin or broad screen rebuild).
- **Likely plan sections:** Data Model, Native Capabilities, Connectors/Data Sources, Design, Screens.
- **Likely files:** exact screen/layout/native/brand/generated/memory files when known.
- **Likely skills/agents:** `mobile-app:data-model-architect`, `mobile-app:screen-planner`, `mobile-app:screen-builder`, `/add-datasource`, `/add-dataverse`, `/add-sharepoint`, `/add-connector`, `/add-native`, `/design-system`, `/preview-screens`, `/debug-app`.
- **Verification gates:** schema, generated services, route contracts, screen validators, runtime smoke/debug, preview.
- **Main risks:** environment drift, unsupported native package, generated service missing, navigation contract change, broad design churn, stale installed plugin cache.

Print:

```text
─── Edit impact preview ─────────────────────────────
Intent        <one sentence>
Tier          <cheap|medium|heavy|major> (~<time range>)
Plan          <sections>
Skills/agents <list>
Files         <screen/layout/data/native/brand/memory summary>
Verification  <gates>
Preview       <yes/no>
Risks         <none or bullets>

Choose:
  (a) Proceed
  (b) Edit intent / answer more detail
  (c) Cancel
```

If the user chooses **edit**, return to Step 1 and refine the edit brief. If cancel, stop with no file mutations. If proceed, continue to Step 2.

**If the user picks (d) Design:**

Read and execute the `/design-system` skill instead of spawning a planner agent. Determine the dimension from the user's description:

| User says | Route to |
|---|---|
| "change colors", "palette", "accent" | `/design-system --refresh palette` |
| "change fonts", "typography", "font" | `/design-system --refresh typography` |
| "change components", "buttons", "cards" | `/design-system --refresh components` |
| "change spacing", "density", "compact" | `/design-system --refresh density` |
| "add rule", "remove rule", "negatives" | `/design-system --refresh negatives` |
| "change animations", "motion" | `/design-system --refresh motion` |
| "full redesign", "reskin", "new theme" | `/design-system --reskin` |

**One-major-change-per-prompt enforced.** If the user asks to change palette AND typography → refuse, ask which first. This matches `/design-system`'s own behavior.

After `/design-system --refresh` returns, print:

```
✅ Design system updated. brand/design-system.md + brand/tokens.ts refreshed.

Continuing with verification and preview. Rebuilding screens only if component shapes, density, navigation, or screen-specific design rules changed.
```

Do not stop after design refresh. Continue to Step 7 verification and Step 8 preview. If the refresh changed component shapes, density, negatives, or a full reskin requires TSX adjustments, include Screens in the affected sections and rebuild those screens.

### Step 2 — Re-plan affected sections

Reuse the same planning primitives as `/create-mobile-app`, but only for the affected surfaces:

| Surface | Reuse from create flow | Edit-app scope |
|---|---|---|
| Dataverse schema | `data-model-architect` + `/add-dataverse` Step 8 | New/changed tables, columns, lookups, calculated fields, generated services |
| Connector choice | `/add-datasource`, `/add-sharepoint`, `/add-connector` | New or changed external data/action surface |
| Native capability | `/add-native` Step 9 | New wrappers/controls needed by edited screens |
| Design | `/design-system` Step 9b | Token refresh, reskin, density/component rules |
| Navigation | `/create-mobile-app` Step 10b | Changed tabs, stacks, route groups, modal/formSheet presentation |
| Service snapshot | `/create-mobile-app` Step 10.7 | Refresh after any data source/schema change before builders run |
| Shared code + skeletons | `/create-mobile-app` Step 10.8 | New screens, changed data imports, new shared row/card/hooks |
| Screen implementation | `/create-mobile-app` Step 11 | Only affected screens, via `mobile-app:screen-builder` waves |
| Quality sweep | `/create-mobile-app` Step 11.4 | Changed screen files and route layouts |

Read each affected section verbatim from `native-app-plan.md` and pass it as input to the relevant read-only agent. Use the plugin namespace for every `Task` invocation.

Before the first `Task`, run a silent preflight for the leaf agent you need (`mobile-app:data-model-architect`, `mobile-app:screen-planner`, or `mobile-app:screen-builder` preflight later). If the host cannot spawn agents, print once:

> "→ Planner agents unavailable in this host — running inline planning. (No action needed; this is automatic.)"

Inline fallback rules:

- Data Model: draft the section inline from the existing plan, `.datamodel-manifest.json`, generated models, and the user's edit brief; then gate it exactly like an agent result.
- Screens: draft Screen Map / Navigation Contracts / per-screen spec changes inline using `agents/screen-planner.md`, `shared/references/screen-templates.md`, and the existing screen TSX; then gate it exactly like an agent result.
- Native Capabilities and Connectors: already handled inline by this skill.
- Never skip approval just because a leaf agent is unavailable.

| Section | Agent (read-only) | Output file |
|---|---|---|
| Data Model | `mobile-app:data-model-architect` | `_dm_section.md` |
| Native Capabilities | (handled inline — no separate agent) | `_native_section.md` |
| Screens | `mobile-app:screen-planner` | `_screens_section.md` |

```
Spawn agent: mobile-app:<agent-name>

Prompt:
  Update the existing <section-name> section based on the user's change request.

  User request: <verbatim>
  Current section content: <verbatim>
  Working directory: <absolute path>
  Plugin root: ${CLAUDE_SKILL_DIR}/../../

  Mode: edit (preserve existing decisions where the change doesn't affect them).
  Existing generated app must be updated after approval, so include enough detail for builders to mutate code without guessing.
  Return the updated section as a markdown file.
```

Parse the first line of every agent result using the return-status protocol in `AGENTS.md`. `DONE` continues, `DONE_WITH_CONCERNS:` must be surfaced and recorded, `NEEDS_CONTEXT:` gets one clarified retry, `BLOCKED:` stops before any file mutation, and unknown first lines are treated as `BLOCKED: malformed agent return`.

For Native Capabilities (no separate agent), do it inline: read the current capability table, apply the change, regenerate the table. For PDF/pen rows, include storage/output notes in the table or immediately below it:

- `native-pdf-viewer` opens HTTPS URLs only; it does not support `file://`, `content://`, or `blob:`.
- `pdf-report` generates a local PDF only when `expo-print` is present; local output is shared with `expo-sharing` only when that package is present, or uploaded to Dataverse File storage before later HTTPS viewing.
- `pen-input` returns a PNG data URI; cancellation is a non-error state; Dataverse target must be Image, File, or child Evidence/Signature row.

For connector/data-source edits, read and execute `/add-datasource` when the source type is unclear; use `/add-sharepoint`, `/add-connector`, or `/add-dataverse` directly only when the source type is clear. If the connector drives new screens or forms, update the Screens section too before applying code.

### Step 3 — Gate intent, plan + app mutation preview

Show the user a side-by-side diff (or before/after) for every changed plan section. Also show an app mutation preview:

- Edit brief: intent, target screens/routes, data/native/design dependencies, and assumptions
- Data/schema operations to run (`/add-dataverse --skip-planning`, connector add, native wrapper add)
- Screen files to create, rewrite, rename, or delete
- Navigation/layout files to update
- Verification commands to run
- Whether `preview.html` will be regenerated

Ask:

> "Approve this edit and apply it to the app?
> (a) Approve and apply
> (b) Revise — give feedback for another pass
> (c) Cancel — discard changes"

If revise → loop back to Step 2 with the user's notes appended. If approve → continue. If cancel → STOP, leave the plan and app untouched.

If `$ARGUMENTS` includes `--plan-only`, change option (a) to "Approve and save plan only" and stop after Step 4 with a clear note that the app was intentionally not changed.

### Step 4 — Write plan diff

Replace the approved section(s) in `native-app-plan.md` with the approved content (preserve all other sections verbatim). Print a unified diff so the user has a record:

```
diff --git native-app-plan.md native-app-plan.md
---
+++ Section: Data Model
- | 🆕 Create (Tier 2) | contoso_workitem | ... |
+ | 🆕 Create (Tier 2) | contoso_workitem | ... |
+ | 🆕 Create (Tier 2) | contoso_case | Lookup → account, severity, status |
```

If this is `--plan-only`, update `memory-bank.md` with `plan_only: true`, print the exact follow-up commands, and stop. Otherwise continue immediately.

### Step 5 — Apply app mutations

Apply sections in dependency order so screens always build against the current data/native surface:

0. **Environment drift gate for data edits** — before Dataverse, SharePoint, connector, or sample-data work, compare `memory-bank.md`, `power.config.json`, and `.resolved-environment.json`. If they disagree, show the values and ask the user which environment is intended. Do not create tables or connections until confirmed.
1. **Data Model** — read and execute `/add-dataverse --skip-planning` with the approved Data Model section. It must create/extend Dataverse tables, refresh generated services/models, update `.datamodel-manifest.json`, and leave generated services compiling. After it returns, run `npm run generate-schemas` and `npx tsc --noEmit`; do not continue to screens until clean.
2. **Sample Data** — if a new Dataverse table was created and any changed screen will show list/detail data from it, read and execute `/add-sample-data` for the project. If seeding fails, record a concern and continue only if the app handles empty states.
3. **Connector/Data Source** — read and execute `/add-datasource` when ambiguous, or `/add-sharepoint` / `/add-connector` for approved connector changes. Regenerate services and record connection notes in `memory-bank.md`.
4. **Native Capabilities** — read and execute `/add-native <capability>` for every new capability. Do not install missing native packages or fake wrappers. If a capability is unsupported by the current template, stop before rebuilding screens that import it, record the block, and tell the user what upstream template support is missing.
5. **Design** — read and execute `/design-system --refresh <dimension>` or `/design-system --reskin` for design edits. Token-only changes usually do not require TSX rewrites; component/density/negative-rule changes may.

After any Data Model, Connector/Data Source, or Native Capabilities mutation, rerun the generated-service/native-wrapper probe before screen work. Screen prompts must reflect what exists on disk now, not what the earlier plan expected.

#### Step 5.5 — Refresh generated service snapshot

Run this after any data-source/schema/connector mutation and before any screen-builder prompt:

```bash
cd <working_dir>
for svc in src/generated/services/*.ts; do
  [ -e "$svc" ] || continue
  name=$(basename "$svc" .ts)
  methods=$(grep -oE 'static async [a-zA-Z_]+' "$svc" | sed 's/static async //' | tr '\n' ',' | sed 's/,$//')
  echo "| \`$name\` | \`src/generated/services/$name.ts\` | $methods |"
done
```

Replace or create the `## Generated Services (snapshot at <ISO timestamp>)` section in `native-app-plan.md` immediately after `## Screens`. If there are no services, write an empty table and a note. Screen-builders must treat this table as authoritative.

Do not ask the user to run these follow-up skills manually. This skill is the orchestrator.

### Step 6 — Rebuild affected screens

Use the plan diff plus the user's request to build the affected screen set:

| Change type | Screens to rebuild |
|---|---|
| Existing screen behavior/layout/state/search change | The named screen(s) |
| New detail screen | The new detail screen plus the source list/search screen that navigates to it |
| New create/edit form | The form screen plus parent list/detail screens that launch it and refresh on focus |
| New scanner/camera/PDF/pen workflow | The capability screen plus any result/detail/form screens it routes to |
| Data-model field added for visible UI | Every screen that displays or writes the field |
| Navigation pattern changed | Every tab/root screen and any route whose contract changed |
| Design component/density/reskin changed | All screens whose layout grammar is affected; for full reskin, run a broad screen wave or controlled style sweep |

Before spawning builders:

- Update route layout files using the `/create-mobile-app` Step 10b layout rules if navigation changed.
- Create missing route folders for new screens.
- Refresh the `## Generated Services` table using `/create-mobile-app` Step 10.7 rules if any data source/schema changed.
- Generate or refresh app-specific shared code from `/create-mobile-app` Step 10.8a when two or more affected screens share an entity row/card, choice map, cursor hook, or save helper.
- For brand-new screens, write typed skeleton files using `/create-mobile-app` Step 10.8b patterns before calling builders.
- For existing screens, do not overwrite with skeletons. Pass the current file content and the change request to the builder in edit mode. If imports/data hooks changed, update them surgically before the builder fills or revises JSX.
- For removed screens, delete route files and remove layout entries only when the user approved deletion in Step 3.

Navigation/layout algorithm:

- Read the approved `## Screens` Screen Map and Navigation Contracts.
- For every new route, create the parent folder and inner `_layout.tsx` when the route is nested.
- For modal/formSheet/detail routes, add the correct `<Stack.Screen name="..." options={{ presentation: 'modal' | 'formSheet' }} />` in the owning folder layout.
- For tab/root changes, patch only the route list in `app/(app)/_layout.tsx`; preserve auth/provider logic and imports not related to route registration.
- For removed routes, delete the route file and remove layout entries only after explicit user approval in Step 3.
- After route/layout edits and before builders, run `npm run check-routes --if-present` or `node scripts/check-routes.js` if available.

Shared scaffold algorithm:

- If `src/components/index.tsx`, `src/hooks/index.ts`, `src/utils/index.ts`, or `src/tokens/index.ts` is missing, copy the missing file from `shared/samples/src/`. Never overwrite an existing shared file.
- If affected screens share an entity card/row, choice map, cursor hook, detail hook, or save helper, create or update a focused app-specific shared file before spawning builders.
- For brand-new screens, write a typed skeleton at the `target_file` using the relevant `/create-mobile-app` Step 10.8b template. The skeleton must compile with `return null` before screen-builder runs.
- For existing screens, never replace the whole file with a skeleton. Patch imports/hooks only when the approved edit changes the data/native surface, then ask the builder to preserve existing behavior.

Run the navigation/skeleton gate before screen-builder work:

```bash
npx tsc --noEmit
```

If it fails, batch-fix layouts, route names, skeleton imports, generated-service names, shared exports, or hook signatures, then rerun once. Do not launch screen-builders from a broken shell.

#### Step 6.1 — Screen-builder preflight + waves

Before the first wave, run a silent `Task` preflight for `mobile-app:screen-builder` using a no-op screen name. If unavailable, print once and build inline using `agents/screen-builder.md`; inline mode must satisfy the same quality rules.

Batch affected screens in waves of up to 5. For each wave:

1. Print the wave start: `Wave <N>/<W> starting: <screen names>`.
2. Spawn all builders in one message so they can run in parallel.
3. Parse each first line per `AGENTS.md` (`DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, `BLOCKED`). Unknown first lines are `BLOCKED`.
4. Retry `NEEDS_CONTEXT` once with the missing context from plan/files/services.
5. Stop on `BLOCKED` unless the user chooses to skip with an approved placeholder.
6. Run `npx tsc --noEmit` after the wave before launching the next wave.
7. If the wave gate fails, group errors by root cause and respawn affected builders with consolidated TypeScript output. Cap at 2 retries per screen.

Do not launch wave N+1 until wave N is clean.

Spawn `mobile-app:screen-builder` agents in waves of up to 5 screens. Prompt each builder with:

```text
Follow screen-builder.md.
Mode: edit existing generated app.
User change request: <verbatim>
working_dir: <absolute path>
screen_name: <screen id>
route: <route>
target_file: <absolute path>
plan_path: <absolute path>/native-app-plan.md
current_file: <paste current file content if the file exists>

Preserve unaffected behavior from the existing screen. Apply the approved plan diff. If this is an existing screen and no skeleton marker is present, update the screen from current_file instead of falling back to sample layout.
```

### Step 7 — Verify

Run verification after mutations. Batch-fix root causes, then rerun the failed gate once. Verification is selected by what changed, but TypeScript is always required after an app mutation.

Required gates, selected by what changed:

```bash
npm run generate-schemas      # if any data source/schema/connector changed
npx tsc --noEmit              # always after app mutation
npm run check-routes --if-present
```

If `npm run check-routes` is absent but `scripts/check-routes.js` exists, run:

```bash
node scripts/check-routes.js
```

When screen files changed, also run the available validators from `hooks/` if this repository is the plugin checkout, or the equivalent project scripts if the generated app exposes them:

```bash
node hooks/validate-screen-quality.js --report <changed-screen-files-or-app-dir>
node hooks/validate-color-contrast.js --report <changed-screen-files-or-app-dir>
node hooks/validate-icon-imports.js <changed-screen-files-or-app-dir>
node hooks/validate-navigation-idempotency.js <changed-screen-files-or-app-dir>
node hooks/validate-protected-paths.js <changed-files>
node hooks/validate-connector-first.js <changed-files>
node hooks/validate-dataverse-payload.js <changed-files>
node hooks/validate-package-deps.js <project-root>
```

Only run validators that exist and are relevant to the changed files. Treat validator failures like create-flow gate failures: capture once, batch by root cause, repair, and rerun the same validator/gate once.

#### Step 7.1 — Targeted style-quality sweep

When screen files changed, run a focused version of `/create-mobile-app` Step 11.4 against the changed screen files plus any route layouts changed by this edit.

Rules:

1. Run `validate-screen-quality.js --report` and `validate-color-contrast.js --report` when available.
2. Merge issues by file and rule.
3. Auto-fix deterministic issues: weak readable tokens, yellow/orange badges with white text, missing icon-only `accessibilityLabel`, missing `accessibilityRole`, tiny icon hit targets, raw hex tokens, missing safe-area padding, `allowFontScaling={false}`.
4. Treat judgement calls as concerns, not infinite loops: complex safe-area restructuring, ambiguous brand color choices, large hierarchy redesigns, or empty-state rewrites that require large JSX movement.
5. Re-run the same report validators for touched files. Cap retries at 2 per file per validator.
6. Run `npx tsc --noEmit` after style fixes. Style concerns may remain, but TypeScript may not.

If auto-fixable issues remain after retries, record `DONE_WITH_CONCERNS` in `memory-bank.md` with file/rule summaries.

If verification fails because the edit exposed stale generated services, rerun the relevant data-source regeneration once before changing screens by hand. If failures are unrelated pre-existing issues, report them separately and do not hide them as successful edit results.

### Step 7.5 — Targeted runtime smoke/debug

Run runtime verification for changed screens when Metro is already running, when the user asked for runtime behavior, or when the edit affects navigation, create/update flows, scanner/camera/PDF/pen interactions, or data-loading behavior.

Preferred path:

1. If `/debug-app` applies and the app is loaded, invoke `/debug-app "<symptom or changed workflow>"` with the changed screen/workflow as the symptom.
2. If Expo MCP tools/log collection are available, walk only the changed screens and their source/destination routes.
3. If Metro is not running and runtime smoke was not explicitly requested, record `runtime_smoke: skipped (Metro not running)` in memory and final summary.

Targeted smoke checks copied from `/create-mobile-app` Step 11.5:

- Red error overlay, blank/white screen, layout overflow, clipped controls.
- Unhandled promise rejection, `ERROR`, duplicate list keys, nested VirtualizedLists, raw string outside `<Text>`, render-time state updates.
- Loading branch renders skeleton/structured loading instead of a lonely spinner when list content is expected.
- Empty state has icon/context/CTA when user action is possible.
- Error state is inline and actionable with retry, not only `Alert.alert()` or toast.
- Create/edit child returns refresh parent list/detail via `useFocusEffect` or equivalent.
- Scanner callback is locked/paused, handles no match and multiple matches, and resets on focus.
- Dynamic route IDs are normalized before service calls.

Fix loop:

- Fix one changed screen/workflow at a time.
- Cap runtime retries at 3 per screen/workflow.
- If unresolved, mark that screen `NEEDS ATTENTION`, record the last error/visual issue, and continue only if TypeScript and route gates remain clean.

### Step 8 — Preview + memory-bank update

If any UI, design, navigation, native interaction, or visible data state changed — or if the user explicitly asked for a preview — read and execute `/preview-screens` after verification. This regenerates `preview.html` and opens it according to the project's `visual_companion` setting.

Append an edit entry to `memory-bank.md`:

```markdown
### Edit: <yyyy-mm-dd> <short title>
- Request: <verbatim or concise summary>
- Intent brief: <target screens/routes, data surface, native capability, design scope>
- Assumptions: <inferred choices or none>
- Skills/agents invoked: <data-model-architect, screen-planner, add-dataverse, screen-builder, etc.>
- Plan sections changed: <Data Model / Native Capabilities / Screens / Design / Connectors>
- App changes: <screens/routes/native wrappers/data sources>
- Verification: <commands/gates + pass/fail/skipped with reason>
- Runtime smoke: <passed / skipped with reason / needs attention>
- Preview: <preview.html path or not generated>
- Blocks/concerns: <none or list>
```

Final summary must say what changed in the app, what verification ran, what runtime smoke did or why it was skipped, and where the preview is. Do not end by saying the codebase was not changed unless this was explicitly `--plan-only`.

## Notes

- `native-app-plan.md` is still the durable source of truth. The change should be planned before it is applied, but planning is not the end state.
- For complex multi-section edits, update and gate every required section first, then apply the mutation in dependency order. Do not leave a native capability entry that references missing Dataverse storage or a screen state that was never planned.
- The architect agents are the same ones used by `native-app-planner` during initial creation, so planning improvements flow through here.
- This skill intentionally covers post-generation iteration. It is acceptable for `/edit-app` to touch Dataverse, `src/native/`, route layouts, screen TSX, brand tokens, `preview.html`, and `memory-bank.md` when the approved edit requires it.
