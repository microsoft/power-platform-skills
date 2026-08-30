# Scaffold and Experience Approval

### Step 4 — Auth & environment selection

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$ACTIVE_ENV_ID"
```

If the resolved environment doesn't match what the planner used in Step 3, ask the user for the intended environment ID and re-run `resolve-environment.js`. Capture the **environment ID** for Step 6.

### Step 5 — Prepare existing template

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
node "${CLAUDE_SKILL_DIR}/../../scripts/prepare-mobile-template.js" \
  --working-dir "<working_dir>" \
  --display-name "<displayName>" \
  --slug "<slug>" \
  --allow-planning-artifacts
```

`--allow-planning-artifacts` is reserved for this foreground Phase 3 → Phase 5
handoff. It permits the validated `native-app-plan.md` produced earlier in the
same create run, but still rejects `memory-bank.md`, `.datamodel-manifest.json`,
and generated service markers. Standalone preparation remains fail-closed.

The script is the only owner of Step 5 mutations. It updates identity, removes
only recognized legacy example hooks/query-client files, copies shared helpers
only when missing, upgrades the marked Tamagui customization block to the
bundled semantic-token baseline when an older supported template is detected,
merges aliases without `baseUrl`, and structurally verifies the root
provider/theme/safe-area contract. It preserves content outside the Tamagui
customization markers, custom navigation, existing helper bytes,
`offlineProfile`, provider props, and the template's `@ts-ignore` generation
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

**Fix 8 — Thread the project's `tamaguiConfig` into the host provider** (required so screens render under brand tokens, not upstream defaults)

The template ships `PowerAppsProvider` (composed-tree API, v0.2.0+). Fix 8 adds `tamaguiConfig`, `defaultTheme`, `theme`, and `darkTheme` props so screens render under brand tokens. Do NOT add an outer `<TamaguiProvider>` — `PowerAppsProvider` composes it internally and duplicating triggers "useTheme must be used within a TamaguiProvider" warnings on hot reload.

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

**Fix 4 — Path aliases in `tsconfig.json` (idempotent JSON merge)**

The upstream template's `tsconfig.json` includes runtime polyfill paths but may
not include the six shared-code aliases. The preparation script merges
`@/components`, `@/hooks`, `@/utils`, `@/tokens`, `@/generated`, and
`@/native`, preserves unrelated aliases, and deletes deprecated `baseUrl`.
Modern TypeScript bundler resolution supports these `paths` entries directly,
so no Babel alias plug-in is required.

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
checks. Do not mutate `_layout.tsx` again here. Verify only that the prepared
layout still contains `SafeAreaProvider`, `tamaguiConfig`, `offlineProfile`,
and the host light/dark theme props; if any are missing, rerun the Step 5
preparation script and stop if it reports an unsupported layout.

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
cp "${CLAUDE_SKILL_DIR}/../../shared/memory-bank.md" "<working_dir>/memory-bank.md"
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

Invoke `/design-system` (ships with this plugin). When `--no-design` is
present, pass `--fast-experience`; this skips alternatives and the component
gallery but still materializes neutral semantic tokens and the required
journey preview.

```
Invoke skill: /design-system

Arguments:
  --working-dir <working_dir>
  [--fast-experience when --no-design is present]
```

The skill detects orchestrator mode (`CODE_APPS_NATIVE_ORCHESTRATING=1`),
collects optional brand inputs, presents the cost picker, materializes the
approved Product Experience, writes `brand/design-system.md` +
`brand/tokens.ts`, renders `brand/design-system.html`, renders the interactive
journey preview at `_plan_preview.html`, and returns with status.

Handle the return per the status protocol (AGENTS.md rule #10):
- `DONE` → continue to Step 7. Record `brand_path`, `tokens_path`, `direction` in memory-bank.
- `DONE_WITH_CONCERNS` → surface concerns, ask user, continue.
- `NEEDS_CONTEXT` → surface question, re-invoke with answer.
- `BLOCKED` → surface error, STOP.

After `/design-system` returns `DONE`, require
`brand/design-system.md`, `brand/tokens.ts`, and `_plan_preview.html`. Missing
artifacts are `BLOCKED`; do not silently continue with a generic fallback.

The preview is the **FIRST and ONLY HTML experience preview** in the flow. It
must contain at least three representative user-facing screens and all
critical screens in a primary journey of five or fewer. It must be selected
from the Workflow Journey, not from List/Form/Detail archetypes.

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
node "${PLUGIN_ROOT}/scripts/render-product-experience-preview.js" \
  --project-root "<working_dir>"
```

If any validator fails, return to the owning planner/design step. Do not let a
generic or incomplete preview advance to React Native generation.

#### Consolidated plan review (optional)

When `--consolidated-review` is present, replace the two prompts below and the
earlier pending Gate 1–2 review with one foreground `approveSection` review
containing:

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

For consolidated review and Gates 3–4, use structured Plan Mode/question tools
when available and normal foreground conversation in Copilot CLI, VS Code, or
any host without those tools. Before yielding, persist `waiting_for_user` with
the exact section, question, affected decisions, and revision. Resume the same
gate/revision from the next answer; never restart planning because Plan Mode is
absent.

#### Gate 3 — Experience + interactive HTML preview

Open or print `file://<working_dir>/_plan_preview.html` according to
`<visual_companion>`, then call `approveSection` with:

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

Revalidate and rerender `_plan_preview.html` before re-entering Gate 3. On
approval, mark Gate 3 approved in `native-app-plan.md` and set
`screenPlan.status` plus `experience.status` to `approved` in
`.tmp/mobile-plan-status.json`, recording current plan, contract, build-pack,
and preview hashes.

#### Gate 4 — Final implementation confirmation

Call `approveSection` once more with the exact implementation summary:

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

If rejected, stop before Dataverse mutation, dependency installation, or
screen/source generation. If approved, mark Gate 4 and
`implementation.status` approved, refresh the receipt integrity hash, and
continue to Step 7.

No mutation command or mutating skill may run unless the approval receipt's
current `implementation.status` is `approved` and its bound plan/contract hashes
still match. `pending-consolidated-review`, `waiting_for_user`, rejected, stale,
missing, or malformed approval state always stops before mutation.

After approval, record the materialized experience checkpoint:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-pipeline-state.js" \
  --project-root "<working_dir>" --record --step "6.75" \
  --artifact "plan=native-app-plan.md" \
  --artifact "approval=.tmp/mobile-plan-status.json" \
  --artifact "build-pack=.tmp/compiled-screen-build-pack.json" \
  --artifact "preview=_plan_preview.html"
```

**Why this matters:** the user reviews one journey-specific experience with
locked tokens before code generation. This avoids both visual whiplash and the
old failure where a rich product journey became generic List/Form/Detail UI.
