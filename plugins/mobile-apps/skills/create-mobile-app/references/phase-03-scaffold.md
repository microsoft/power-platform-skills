# Phase 3 of 10 — Scaffold

**Steps:** 4–6.7. **Previous:** [2 — Planning](phase-02-planning.md). **Next:** [4 — Design](phase-04-design.md).
[Phase index](../SKILL.md#load-only-the-active-phase). Advance only after this phase's exit condition passes.

Read only after the foreground planning gates complete. No background template pipeline.
Load [CLI guidance](${PLUGIN_ROOT}/shared/shared-instructions-cli.md) for initialization/auth.

### Step 4 — Auth & environment selection

**Telemetry checkpoint: `select_app_environment`**

```bash
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$ACTIVE_ENV_ID"
```

Verify ID/URL/tenant match the approved planning context. If different, stop for foreground
confirmation and re-plan/reapprove required target decisions before proceeding; an environment
change cannot retain the old schema receipt. Capture the approved ID for Step 6.

### Step 5 — Prepare existing template

**Telemetry checkpoint: `prepare_template_files`**

Template-only, foreground-only: do not clone/copy templates or invoke legacy fallbacks.
Verify the four required template files and `node_modules/expo` still exist. If missing, STOP
and tell the user to materialize/install a fresh template. If `memory-bank.md`,
`.datamodel-manifest.json` or generated services appeared without a confirmed Step 0 resume, STOP.
`native-app-plan.md` is expected here because Step 3 writes the approved plan before template preparation.

Run the deterministic preparation script once:

```bash
PREPARE_SCRIPT="${PLUGIN_ROOT}/scripts/prepare-mobile-template.js"
node - "$PREPARE_SCRIPT" <<'NODE'
const { prepareMobileTemplate } = require(process.argv[2]);
// Substitute JSON.stringify output; quotes and dollar signs must remain data.
const result = prepareMobileTemplate({
  workingDir: <JSON_STRING_OF_WORKING_DIR>,
  displayName: <JSON_STRING_OF_DISPLAY_NAME>,
  slug: <JSON_STRING_OF_SLUG>,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
NODE
```

The script is the **only owner of Step 5 mutations**: identity, recognized legacy cleanup,
missing shared helpers, host TypeScript inheritance and structural provider/theme/safe-area
postconditions. Do not repeat its inline recipes. It preserves custom navigation/helper bytes,
provider props, `offlineProfile`, and the template's `@ts-ignore` generation boundaries.
Unsupported layout/dangling legacy imports are visible failures, not permission for a full-file
rewrite. Keep `src/hooks/` and the starter route; builders replace only assigned routes.

Step 5 must not create, reset, delete, or
write anything under `src/generated/`. Only Power Apps generation owns those files.
Never hand-write an empty `connectorSchemas.ts` or barrel. Preserve host TypeScript aliases
instead of making a second app-local alias map. Keep bundle/scheme defaults; wrap owns them.
No dependency installation, registry changes, token provisioning or direct source-provider edits.

### Step 6 — Initialize

**Telemetry checkpoint: `initialize_power_apps_project`**

```bash
cd <working_dir>
npx power-apps init -t MobileApp --display-name "<displayName>" --environment-id "<environment-id>" --non-interactive
```

Substitute the approved Step 2 display name and Step 4 environment ID using shell-safe quoting.
Step 5 removes only an empty `power.config.json` placeholder. If a populated file remains, STOP
and report its environment rather than overwriting or initializing again; a confirmed resume
may skip already-verified initialization, not rerun it.
Verify config exists and `environmentId`/`appDisplayName` equal the approved values.
On failure use the shared command policy, report exact error and stop if unresolved.

### Step 6.5 — Verify dependencies

Verify `node_modules/expo`. If absent, STOP and ask the user to run `npm install` in the template
folder. This phase does not install baseline dependencies or provision feed credentials.

### Step 6.5b — Root runtime contract verification

Step 5 already owns structural changes. Verify `SafeAreaProvider`, `tamaguiConfig`,
`offlineProfile`, color-scheme-driven `defaultTheme`; after brand wiring also verify matching
`theme`/`darkTheme` props. Rerun preparation only for a missing contract element; stop if unsupported.
Never add an outer TamaguiProvider or wrap Slot in a global SafeAreaView. Routes own visible edges.

### Step 6.6 — Scaffold TypeScript gate

**Telemetry checkpoint: `validate_scaffold_typescript`**

```bash
npx tsc --noEmit
```

Do not generate an empty schema artifact to make this pass. Preserve the template's `@ts-ignore`
boundaries. Capture errors once, batch repairs, rerun the same gate; do not proceed until clean.

### Step 6.7 — Seed the memory bank

Copy `${PLUGIN_ROOT}/shared/memory-bank.md` only when no bank exists. Never overwrite resume history.
Fill Project facts, Power Platform context and completed steps from verified results.
Immediately flush queued `DEFERRED_CONCERNS[]` into `## Concerns` and discovery diagnostics into
`## Discovery Notes` (no secrets); this flush is unconditional when the queue is nonempty.
Persist `visual_companion: yes|no` and later update it from `/design-system`.
From here every successful step appends to the bank immediately, not at the end.
Next load the design phase.
