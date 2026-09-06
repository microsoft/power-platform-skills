# Scaffold and Experience Approval

Follow the retained
[`Live Build Plan protocol`](./build-plan.md). Mark `scaffold` active before
Step 5 and complete only after Step 6.6 passes. Mark `design` active during
Step 6.75, `waiting` during Gates 3–4, and complete only after Gate 4 approval.

### Step 4 — Auth & environment selection

```bash
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$ACTIVE_ENV_ID"
```

If the resolved environment doesn't match what the planner used in Step 3, ask the user for the intended environment ID and re-run `resolve-environment.js`. Capture the **environment ID** for Step 6.

### Step 5 — Prepare existing template

**Telemetry checkpoint: `scaffold`**

This step is template-only and foreground-only. Do not clone/copy templates, do not run background scaffold jobs, and do not use any legacy fallback path.

**Print before starting:**
> "→ [Step 5/13] Preparing existing Expo standalone template in <working_dir> …"

Required checks:

```bash
cd <working_dir>
test -f package.json && test -f app.config.js && test -f auth.config.json && test -f tamagui.config.ts
test -d node_modules/expo
```

If any required template file is missing, STOP:
> "This folder is not a fresh `expo-app-standalone` template. Materialize a fresh template with `degit` into a new folder, run `npm install`, then rerun `/create-mobile-app --working-dir <fresh-template-dir>`."

If `node_modules/expo` is missing, STOP:
> "Dependencies are not installed. Run `npm install` in the template folder, then rerun `/create-mobile-app --working-dir <fresh-template-dir>`."

If already-created markers appear (`memory-bank.md`, `native-app-plan.md`, `.datamodel-manifest.json`, or `src/generated/services/*.ts`) and Step 0 did not enter the resume path, STOP:
> "This folder already looks like a created app. For a new app, materialize a fresh `expo-app-standalone` template with `degit` into a new folder and rerun this skill there."

Run the deterministic preparation script once:

```bash
node "${PLUGIN_ROOT}/scripts/prepare-mobile-template.js" \
  --working-dir "<working_dir>" \
  --display-name "<displayName>" \
  --slug "<slug>"
```

The script is the only owner of Step 5 mutations. It updates identity, removes
only recognized legacy example hooks/query-client files, copies shared helpers
only when missing, verifies the native-host TypeScript base, and structurally
verifies the root provider/theme/safe-area contract. It preserves custom
navigation, existing helper bytes, `offlineProfile`, provider props, every
artifact under `src/generated/`, and the template's `@ts-ignore` generation
boundaries.

**Generated ownership boundary:** Step 5 must not create, reset, delete, or
write anything under `src/generated/`. Only Power Apps schema/data-source
generation commands own that directory. A generated file required later is
created by its owning command, never by a placeholder barrel.

The script fails visibly for unsupported root-layout shapes or dangling legacy
imports. Do not fall back to a full-file rewrite or regex patch. After it
returns successfully, continue to Step 6.

**Fix 1 — App identity in `app.config.js` and `package.json`**

Substitute the hardcoded template values with wizard answers from Step 2:

| Find | Replace with |
|---|---|
| `const APP_NAME = process.env.APP_DISPLAY_NAME || 'Power Apps Standalone App';` | `const APP_NAME = process.env.APP_DISPLAY_NAME || '<displayName>';` |
| `const APP_SLUG = process.env.APP_SLUG || 'powerapps-standalone-app';` | `const APP_SLUG = process.env.APP_SLUG || '<slug>';` |
| `"name": "powerapps-standalone-app"` | `"name": "<slug>"` |

Bundle ID and scheme are left as template defaults — they are fixed across all dev builds and patched by the wrap pipeline at release time.

**Fix 2 — Remove only an empty placeholder `power.config.json`**

The preparation script parses `power.config.json` and removes it only when
`environmentId` is empty or missing. A populated file is preserved and later
validated against the approved environment. Do not use an unconditional
delete.

**Fix 3 — Remove recognized legacy examples without touching generated code**

Newer snapshots do not ship the Contacts / Accounts / UserProfile example
hooks or the old app-owned query client. The preparation script removes only
those recognized files when present. It never traverses or mutates
`src/generated/`; generated models, services, schemas, and barrels remain
owned by Power Apps generation commands.

**Do NOT overwrite `app/(app)/home.tsx` here.** The current template ships a
safe-area-aware, semantic-token starter route. The screen-builder replaces it
only when the approved Screen Map assigns that route.

Keep `src/hooks/` itself — screen-builders write new hooks into it.

**Fix 3b — Scan for dangling imports referencing deleted files (back-compat only)**

The preparation script scans `app/` and non-generated `src/` files after
cleanup. Any remaining legacy example import is an explicit failure. Do not
replace whole screens or layouts to make the scan pass; use a supported fresh
template or repair the precise stale import before continuing.

**Fix 6 — Schema generation boundary**

`app/_layout.tsx` imports `schemaMap` from `src/generated/connectorSchemas.ts`, which is generated by `npm run generate-schemas` (the `generate-connector-schemas` binary from the `@microsoft/power-apps-cli` devDep). Do not generate an empty schema map during initial scaffold: the template's `@ts-ignore` boundary lets `tsc` validate the scaffold without that artifact, and schema generation is more useful after a data source exists or immediately before dev/build entry points.

Do NOT hand-write a stub `connectorSchemas.ts` — the generated output has a specific shape that downstream code depends on; a placeholder will break `npx power-apps push`.

**Why `tsc` already passes post-clone (current template, PR #30):** the template's `app/_layout.tsx` and `src/playerConfig.ts` carry `// @ts-ignore` comments above the `power.config.json` and `connectorSchemas` imports specifically so the project type-checks before `power.config.json` and `connectorSchemas.ts` exist. **Never strip these `@ts-ignore` lines** — Fix 8 below preserves them when patching `app/_layout.tsx` to thread the project's `tamaguiConfig` into `PowerAppsProvider`, and any future `Edit` to either file MUST keep them. Removing them resurfaces a `tsc` failure against missing generated files.

**Fix 7 — Seed shared code only when missing**

The preparation script creates the shared source directories and copies each
approved sample helper only when its destination does not exist. Existing
helpers are byte-for-byte preserved, so reruns cannot overwrite user or
builder changes.

**Fix 8 — Thread the project's `tamaguiConfig` into the host provider**

The template ships `PowerAppsProvider` (composed-tree API, v0.2.0+). Fix 8 adds
`tamaguiConfig` and `defaultTheme`. The host owns baseline light/dark themes;
explicit `theme` and `darkTheme` props are added only after brand-token wiring
creates project-specific themes. Do NOT add an outer `<TamaguiProvider>` —
`PowerAppsProvider` composes it internally and duplicating triggers
"useTheme must be used within a TamaguiProvider" warnings on hot reload.

The preparation script edits the existing root layout structurally. It adds
missing imports and provider props, then wraps `PowerAppsProvider` with
`SafeAreaProvider` only when needed. It does not replace the file and it does
not wrap `<Slot />` with `SafeAreaView`; each rendered route owns its content
edges to avoid double insets.

Key points:
- **Do NOT remove the two `// @ts-ignore` lines.** They keep `tsc` green pre-`npx power-apps init`.
- **Do NOT add an outer `<TamaguiProvider>`** — `PowerAppsProvider` composes it internally.
- **`SafeAreaProvider` wraps the tree** so child screens can call `useSafeAreaInsets()` without a context error. Each route must use `SafeAreaView` or explicit insets for its own visible edges.
- `tamaguiConfig` is imported from `'../tamagui.config'` (the `default export` of `tamagui.config.ts` at project root).
- `defaultTheme` flips between light/dark via `useColorScheme()`. `/design-system --add-dark-mode` later wires per-token dark variants.

**Fix 4 — Native-host TypeScript configuration**

The upstream template's `tsconfig.json` extends
`@microsoft/power-apps-native-host/config/tsconfig`. The preparation script
verifies that inheritance instead of duplicating the host's package shims and
`@/` aliases in the app. Do not reintroduce `baseUrl`, local polyfill paths, or
a Babel alias plug-in.

`<Gradient>` (used by `components/index.tsx`) requires `expo-linear-gradient`. **Assume the upstream template ships it** — do NOT edit `package.json` to add it. If dependency verification later reveals the dep is missing, STOP and surface the template contract failure; do not silently add a different dependency.

Do not run `npm install` inside Step 5 — in template-only mode dependencies must already be installed before the skill starts.

> **Install note (current template):** The template does not read `power.config.json` during `npm install`. The Step 6 → Step 6.5 ordering is kept for predictable checkpoints, but do not run `npm run generate-schemas` during initial scaffold.

### Step 6 — Initialize

**Print before starting:**
> "→ [Step 6/13] Running `npx power-apps init -t MobileApp` to write power.config.json for environment <env-id>. ~15–30 seconds."

```bash
cd <working_dir>
CONFIG_ENV_ID=$(node -e "try { console.log(require('./power.config.json').environmentId || '') } catch { console.log('') }")
if [ -n "$CONFIG_ENV_ID" ]; then
  test "$(printf '%s' "$CONFIG_ENV_ID" | tr '[:upper:]' '[:lower:]')" = \
       "$(printf '%s' "$ACTIVE_ENV_ID" | tr '[:upper:]' '[:lower:]')" || {
    echo "BLOCKED: existing power.config.json targets $CONFIG_ENV_ID, but the approved environment is $ACTIVE_ENV_ID"
    exit 2
  }
  echo "↷ Step 6 initialization skipped — power.config.json already targets the approved environment."
else
  npx power-apps init -t MobileApp --display-name '<displayName>' --environment-id "$ACTIVE_ENV_ID" --non-interactive
fi
```

Verify `power.config.json` exists and its `environmentId` matches Step 4. If
initialization fails, report the exact error and STOP. Never run `init` over a
populated configuration; the CLI requires a new or placeholder-free target.

### Step 6.5 — Verify dependencies

This step verifies dependencies only. The user must have run `npm install` before invoking the skill.

```bash
[ -d "<working_dir>/node_modules/expo" ] && echo "✓ node_modules present" || echo "✗ missing — run npm install in the template folder and rerun"
```

If `node_modules/expo` is missing, STOP. Tell the user to run `npm install` in the template folder. Do not provision ADO tokens or run `npm install` from this skill.

### Step 6.5b — Root runtime contract verification

Step 5 already performs the idempotent structural update and postcondition
checks. Do not mutate `_layout.tsx` again here. Verify that the prepared layout
contains `SafeAreaProvider`, `tamaguiConfig`, `offlineProfile`, and
`defaultTheme`. If brand-token wiring has already run, also verify its explicit
`theme` and `darkTheme` props. If any applicable value is missing, rerun the
Step 5 preparation script and stop if it reports an unsupported layout.

### Step 6.6 — Scaffold TypeScript gate

**Print before starting:**
> "→ [Step 6.6/13] Running scaffold tsc smoke check (~10–30 seconds)."

With `node_modules/` populated, run the scaffold TypeScript gate. Do **not** run `npm run generate-schemas` here just to produce an empty `connectorSchemas.ts`; the template is intentionally type-checkable before that file exists, and the script is already run after data-source changes and again before Step 12 starts the dev server.

```bash
npx tsc --noEmit
```

`tsc` must pass here. If it doesn't, the post-clone surgery in Step 5 (Fixes 1–7) is incomplete — do not proceed to data sources or screen builders. Re-read the Step 5 fixes against the current working dir contents and reapply any missed edit.

This is the **Scaffold gate** from the TypeScript Gate Policy. If it fails, capture the full error list once, batch-fix scaffold/template causes, and rerun this gate. Do not continue to Step 6.7 or any app-specific mutation until this gate is clean. If the only failure is a missing generated schema import, preserve the template `@ts-ignore` boundary rather than generating an empty schema artifact.

### Step 6.7 — Seed the memory bank

```bash
cp "${PLUGIN_ROOT}/shared/memory-bank.md" "<working_dir>/memory-bank.md"
```

Fill in the Project facts and Power Platform context sections from Steps 2 and 4. From here on, every step appends to the relevant section of `<working_dir>/memory-bank.md` immediately after success — not at the end. This is what enables Step 0's resume on a future run.

Immediately after creating `memory-bank.md`, flush any queued planner concerns from `DEFERRED_CONCERNS[]` into `## Concerns` (append-only). This flush is unconditional: if the queue is non-empty, write it now before continuing to Step 6.75.

**Also persist the Visual Companion preference** so re-runs (`/edit-app`, `/preview-screens`, future `/design-system` runs) honor it without re-asking. Append to the Project facts section:

```
visual_companion: <yes|no>   # set in Step 2b — controls whether browser previews open automatically
```

`/preview-screens` reads this flag when invoked from inside this project; if `no`, it prints the file path instead of opening. `/edit-app` reads it to decide whether to re-open `_plan_preview.html` after a re-plan. The flag is per-project and does not leak across apps.

### Step 6.75 — Design system

**Print before starting:**
> "→ [Step 6.75/13] Locking your design system — source of truth for every screen built next. Takes 5 sec to 3 min depending on path."

Invoke `/design-system` (ships with this plugin). For normal prompt-only
generation, pass `--auto-experience`; it uses the approved experience without a
brand-input pause, cost picker, style gallery, Figma, history, or alternative
direction. Explicit brand/design flags use their existing modes instead. When
`--no-design` is present, pass `--fast-experience` for the neutral path.

Start `designMaterialization` immediately before invoking `/design-system` and
finish it only after all required design/preview artifacts and contract checks
pass. Record a bounded failure reason on `NEEDS_CONTEXT` or `BLOCKED`.

Before invoking the skill, fingerprint the approved planning authorities and
open the automatic-design write boundary:

```bash
node "${PLUGIN_ROOT}/scripts/design-run-ownership.js" \
  --project-root "<working_dir>" --begin
```

This preflight is mandatory. It seals `native-app-plan.md`, Product Experience,
Product Scope, Workflow Journey, screen and compiled packs, navigation,
scenario facts, persistence, and present data-model/data-use contracts. Design
may write only `brand/**`, `_plan_preview.html`, the canonical full and compact
preview projections, and `.tmp/design-*.json` evidence/status files.

```
Invoke skill: /design-system

Arguments:
  --working-dir <working_dir>
  [--auto-experience for normal prompt-only generation]
  [--fast-experience when --no-design is present]
```

The skill detects orchestrator mode (`CODE_APPS_NATIVE_ORCHESTRATING=1`),
materializes the approved Product Experience, writes
`brand/design-system.md`, `brand/tokens.ts`, and
`brand/signature-components.ts`, then authors and deterministically validates the
interactive journey preview at `_plan_preview.html` in that same model
invocation. Auto mode does not render the optional component gallery.

Handle the return per the status protocol (AGENTS.md rule #10):
- `DONE` → continue to Step 7. Record `brand_path`, `tokens_path`, `direction` in memory-bank.
- `DONE_WITH_CONCERNS` → surface concerns, ask user, continue.
- `NEEDS_CONTEXT` → surface question, re-invoke with answer.
- `BLOCKED` → STOP only for unsafe/unsupported capability, missing explicit
  requirements, invalid relationships that prevent compilation, or
  uncompilable output. Otherwise normalize to design-only repair/concerns.

On every return path, including `NEEDS_CONTEXT` and `BLOCKED`, run:

```bash
node "${PLUGIN_ROOT}/scripts/design-run-ownership.js" \
  --project-root "<working_dir>" --verify
```

The ownership tool restores protected files from its hash-verified preflight
snapshot and returns `NEEDS_DESIGN_REPAIR` with exact mutation paths. Retry only
the affected design artifacts; never regenerate or restamp the plan. If that
local repair still has cosmetic concerns, record `DONE_WITH_CONCERNS` and
continue. `NEEDS_CONTEXT` for genuinely missing frame evidence goes back to the
planning owner; design never reorders a journey, screen graph, or scenario facts
to improve preview selection.

After `/design-system` returns `DONE`, require
`brand/design-system.md`, `brand/tokens.ts`, `brand/signature-components.ts`,
and `_plan_preview.html`. Missing
artifacts trigger one design-only repair. If they remain absent, record
`DONE_WITH_CONCERNS` and continue without inventing a generic fallback.

The preview is the **FIRST and ONLY HTML experience preview** in the flow. Its
default storyboard contains one to three frames selected from the Workflow
Journey: entry/root, signature/core action, and outcome/review when available.
The expandable `All screens` area contains the complete graph and required
states. It is not selected from List/Form/Detail archetypes and does not claim
React Native or native pixel verification.
Neutral structural diagnostics remain separate and can never become approved visual intent.

Before continuing, verify the product-experience, scope, journey, and build-pack
contracts:

```bash
node "${PLUGIN_ROOT}/scripts/validate-product-experience.js" \
  --project-root "<working_dir>"
node "${PLUGIN_ROOT}/scripts/validate-product-scope.js" \
  --project-root "<working_dir>"
node "${PLUGIN_ROOT}/scripts/validate-workflow-journey.js" \
  --project-root "<working_dir>"
node "${PLUGIN_ROOT}/scripts/compile-screen-build-pack.js" \
  --project-root "<working_dir>" --check
node "${PLUGIN_ROOT}/scripts/validate-product-experience-preview.js" \
  --project-root "<working_dir>"
node "${PLUGIN_ROOT}/scripts/design-run-ownership.js" \
  --project-root "<working_dir>" --verify
```

This final preview check occurs only after `/design-system` has returned and all
three brand artifacts exist. Repair generated-token or preview findings only in
their owning design artifact. Browser unavailability and remaining cosmetic
preview findings are warnings; continue generation without claiming complete
visual validation. Never weaken or regenerate a valid plan to make the preview
pass.

#### Consolidated plan review (optional)

When `--consolidated-review` is present, replace the two prompts below and the
planner's earlier Gate 1–2 prompts with one `EnterPlanMode` review containing:

- Product Experience, Product Scope, and verified Data Model;
- native capabilities and connectors;
- screen map, primary Workflow Journey, and screen/table budgets;
- classified assumptions and approval-impacting concerns;
- the interactive preview path and exact implementation summary.

The artifacts, validations, and approval receipt fields are identical to gated
mode. On approval, mark Gates 1–4, experience, screen plan, and implementation
approved with current hashes, then continue to Step 7. On rejection, reopen
only the owning section, regenerate its dependent contracts, rerender the
preview, and present the consolidated review again. `--gated` or no review flag
uses the four prompts below.

#### Gate 3 — Experience + interactive HTML preview

Open or print `file://<working_dir>/_plan_preview.html` according to
`<visual_companion>`, then use `EnterPlanMode` with:

This design-system preview remains separate from `_build_plan.html` and shows
at most three phone frames: primary-journey entry, representative core or
signature work, and outcome. Loading, empty, error, permission, success, and
offline conditions remain state controls on those frames rather than routes.

```text
## Gate 3 of 4 — Product Experience

[Product Experience summary]
[primary Workflow Journey]
[screen/surface count versus approved budget]
[classified assumptions]
[interactive preview path]

Approve this experience? Review first viewport, hierarchy, required journey
steps, content/media, trust signals, primary actions, states, and signature
interaction. Reject generic CRUD substitution or unsupported behavior.
```

On rejection, revise only the owning layer and regenerate deterministically:
- visual hierarchy/tokens/content treatment → rerun `/design-system`
- journey/screen composition → revise the Workflow Journey and recompile build
  packs
- jobs, budgets, tables, or persistence → reopen Gate 1
- capabilities/connectors → reopen Gate 2

Return to `/design-system` to reauthor and revalidate `_plan_preview.html`
before re-entering Gate 3. Start `userApproval` immediately before the question
and finish it immediately after the response. On approval, record the current
plan sections, build pack, and preview through the atomic approval owner:

```bash
node "${PLUGIN_ROOT}/scripts/mobile-plan-approval.js" approve \
  --project-root "<working_dir>" --gate 3
```

Do not patch `screenPlan.status`, `experience.status`, hashes, or integrity by
hand.

#### Gate 4 — Final implementation confirmation

Before entering Gate 4, recheck `.tmp/mobile-build-plan-edits.json`. If a
newer data-model revision exists, do not approve implementation; return through
Gate 1 and the downstream gates identified by the invalidated receipt.

Use `EnterPlanMode` once more with the exact implementation summary:

```text
## Gate 4 of 4 — Ready to build

- Screens/routes: <count and names>
- App-owned tables: <count and names>
- Reused/adapted tables: <count and names>
- Native capabilities: <names or none>
- Connectors: <names or none>
- Preview: <absolute path>

Start implementation from these approved contracts?
```

Start `userApproval` immediately before the question and finish it immediately
after the response. If rejected, stop before Dataverse mutation, dependency
installation, or screen/source generation. If approved, run the final receipt
seal and continue only when it validates:

```bash
node "${PLUGIN_ROOT}/scripts/mobile-plan-approval.js" approve \
  --project-root "<working_dir>" --gate 4
node "${PLUGIN_ROOT}/scripts/mobile-plan-approval.js" validate \
  --project-root "<working_dir>"
```

Gate 4 binds the exact plan, normalized Dataverse contract when applicable,
compiled service consumers, prior gate section hashes, and implementation
approval. Never self-mint or restamp these fields in Step 8.

Immediately after Gate 4 approval, finish the `foregroundPlanning` timing wall.
Every Gate 1-4 wait must have been recorded through `userApproval`; the summary
will subtract overlapping wait time from foreground execution.

After approval, record the materialized experience checkpoint:

```bash
node "${PLUGIN_ROOT}/scripts/mobile-pipeline-state.js" \
  --project-root "<working_dir>" --record --step "6.75" \
  --mutable-artifact "plan=native-app-plan.md" \
  --mutable-artifact "approval=.tmp/mobile-plan-status.json" \
  --artifact "build-pack=.tmp/compiled-screen-build-pack.json" \
  --artifact "scenario-facts=.tmp/scenario-facts.json" \
  --artifact "preview=_plan_preview.html"
```

**Why this matters:** the user reviews one journey-specific experience with
locked tokens before code generation. This avoids both visual whiplash and the
old failure where a rich product journey became generic List/Form/Detail UI.
