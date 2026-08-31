# Screen Generation and Launch

### Step 11 — Build screens with one parallel builder type

Build mode is not a user-facing question. The foreground owns work orders,
channel selection, shared files, recovery, validation, and writes for
return-only results. `mobile-app:screen-builder` is the only child-agent type and
implements exactly one assigned screen.

Do not change product scope, navigation, data model, operations, design, or
assumptions during implementation. The approved compiled screen pack is the
authority.

## Step 11.0 — Create channel-neutral work orders

For each screen, read one entry from `.tmp/compiled-screen-build-pack.json` and
create `.tmp/screen-work-orders/<screenId>.unsealed.json` with:

- run ID and screen ID;
- route and parameter contract;
- exact target path;
- one screen build-pack entry;
- complete typed skeleton;
- only relevant generated-service signatures;
- permitted token and signature-component interfaces;
- exact states, test IDs, and accessibility requirements.

Do not include the whole Markdown plan, unrelated packs, generated source files,
or multiple screens. Seal and budget it:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/screen-builder-contract.js" \
  --project-root "<working_dir>" \
  --seal \
  --input ".tmp/screen-work-orders/<screenId>.unsealed.json" \
  --output ".tmp/screen-work-orders/<screenId>.json" \
  --max-input-bytes 49152
```

The sealed fingerprint is channel-neutral. Both direct-write and return-only
consume the same semantic work order. A screen whose compact work order exceeds
the input budget is implemented in foreground; never drop pack evidence to make
it fit.

Initialize run-scoped per-screen channel state:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/screen-builder-contract.js" \
  --project-root "<working_dir>" \
  --initialize-run --run-id "<runId>" \
  --work-order ".tmp/screen-work-orders/<screenId>.json" \
  --state ".tmp/screen-builder-state.json"
```

Repeat `--work-order` for every assigned screen in deterministic screen-ID
order.

## Step 11.1 — Wave 0 canary

Build Home plus one or two critical key-flow screens before any broad fan-out.
Select the screens marked as primary journey entry, core decision/capture, and
signature interaction in the compiled packs. Use the strongest available child
model for:

- Home;
- the key-flow canary;
- signature/media-heavy screens;
- scanning/capture screens;
- high-risk decisions and confirmations.

The child model implements the pack. It never decides scope, screen count,
navigation, data model, operations, design direction, signature experience, or
user-visible assumptions.

Print:

> "→ [Step 11/13] Wave 0 canary: Home + <critical screens>. Validating the product grammar before supporting fan-out."

### Direct-write channel

Use when the installed host exposes Read, Write, and Edit to the child. Pass:

```text
channel: direct-write
sealed_work_order: <exact one-screen work order>
```

Before dispatch, capture a byte-level pre-wave baseline and verified backups for
the project surfaces a child could damage. Use a unique run/wave directory and
repeat `--allowed-path` later for every target assigned in this wave:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/screen-builder-contract.js" \
  --project-root "<working_dir>" \
  --capture-direct-snapshot \
  --snapshot ".tmp/screen-builder-snapshots/<runId>-<wave>.json" \
  --backup-dir ".tmp/screen-builder-backups/<runId>-<wave>" \
  --path app --path src --path brand \
  --path package.json --path tamagui.config.ts --path app.config.js \
  --path native-app-plan.md --path memory-bank.md \
  --path power.config.json --path auth.config.json
```

The child may read only its work-order allowlist and edit exactly its pre-created
target screen.

Normalize the returned status metadata to JSON and verify it:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/screen-builder-contract.js" \
  --project-root "<working_dir>" \
  --verify-direct \
  --work-order ".tmp/screen-work-orders/<screenId>.json" \
  --result ".tmp/screen-results/<screenId>-direct.json"

node "${CLAUDE_SKILL_DIR}/../../scripts/screen-builder-contract.js" \
  --project-root "<working_dir>" \
  --audit-direct-writes \
  --snapshot ".tmp/screen-builder-snapshots/<runId>-<wave>.json" \
  --allowed-path "<target-file-for-screen-1>" \
  --allowed-path "<target-file-for-screen-N>"
```

The audit computes actual added, modified, deleted, and symlink-replaced files;
it does not trust child metadata. A nonzero exit means the assigned targets were
not all changed or an out-of-scope write occurred. Out-of-scope files are
surgically restored from hash-verified backups while valid sibling targets stay
in place. If direct verification returns `NEEDS_CONTEXT`, `BLOCKED`, malformed
metadata, or invalid generated content, restore only that assigned target before
switching its channel:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/screen-builder-contract.js" \
  --project-root "<working_dir>" \
  --restore-direct-paths \
  --snapshot ".tmp/screen-builder-snapshots/<runId>-<wave>.json" \
  --restore-path "<failed-target-file>"
```

Record a channel failure for the responsible screen. Never use a run-wide reset.
Delete the run/wave backup only after the wave validation gate passes.

### Return-only channel

Use when child file tools are unavailable or direct-write dispatch fails because
of host tool mapping. Inline the exact sealed work order and tell the child:

```text
channel: return-only
Make no tool calls. Return one complete TSX body using the run-scoped delimiters
defined in screen-builder.md. Return no plan or second file.
```

Capture the raw response and parse it:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/screen-builder-contract.js" \
  --project-root "<working_dir>" \
  --parse-return \
  --work-order ".tmp/screen-work-orders/<screenId>.json" \
  --response ".tmp/screen-responses/<screenId>.txt" \
  --output ".tmp/screen-results/<screenId>-return.json" \
  --max-output-bytes 65536
```

On `DONE` or `DONE_WITH_CONCERNS`, the foreground atomically writes only the
assigned target, then validates it. A malformed, oversized, truncated, or failed
result retries once with precise diagnostics. A second channel failure moves
only that screen to foreground implementation from the same work order.

Record channel failure or success in `.tmp/screen-builder-state.json`. Never
turn one screen's failure into a host-wide failure and never discard completed
siblings.

Time screen execution by channel. Children in a wave run concurrently, so do
not open overlapping timers on one stage. Measure wall time around each actual
dispatch batch and append it after the batch completes:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/planning-timings.js" \
  --project-root "<working_dir>" \
  --stage <screenBuildDirectWrite|screenBuildReturnOnly|screenBuildForeground> \
  --action record --duration-ms "<measured-channel-wall-ms>"
```

Use `screenBuildForeground` for per-screen foreground fallback, not for normal
foreground orchestration. Retries create another record for the same channel;
do not attribute validation or user waiting to a screen-build channel.

## Step 11.2 — Canary validation gate

Do not start supporting waves until the canary proves that navigation, tokens,
signature components, data bindings, states, and first-viewport composition work
together.

Run:

```bash
npx tsc --noEmit
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-screen-quality.js" --report <canary-files>
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-color-contrast.js" --report <canary-files>
node "${CLAUDE_SKILL_DIR}/../../scripts/compile-screen-build-pack.js" \
  --project-root "<working_dir>" --check
```

Measure each canary, wave, and final validator gate as `screenValidation` using
`--action record --duration-ms <measured-wall-ms>`. Do not double-record an
identical final validation skipped by a successful workspace fingerprint.

Inspect the required HTML experience preview and native Home/key-flow screens.
Confirm:

- one focal point and visible primary action in the first viewport;
- realistic domain content and appropriate density;
- signature components/interactions are visible;
- media source, crop/aspect treatment, and fallback are correct;
- navigation matches durable destinations and bounded flows;
- tab bars, sticky actions, and bottom safe-area insets do not overlap;
- text, controls, imagery, and actions are not cropped;
- repeated compositions do not replace product-specific hierarchy;
- offline messaging appears only when offline was approved.

Repair only failed canary screens and rerun the same gate. Do not fan out while
any canary compile, route, UX, contrast, safe-area, or inspection finding remains.

## Step 11.3 — Supporting waves

After the canary passes, routine supporting screens may use a cheaper available
child model when their complete packs make implementation mechanical. Examples
include simple list, detail, history, Profile, or settings screens. Continue to
use the strongest model for signature, media-heavy, capture, and high-risk
screens.

Resolve concurrency once:

```bash
BUILDER_CONCURRENCY="<--builder-concurrency value, or ${MOBILE_APP_BUILDER_CONCURRENCY:-4}>"
node -e '
  const value = Number(process.argv[1]);
  if (!Number.isInteger(value) || value < 1 || value > 6) process.exit(2);
' "$BUILDER_CONCURRENCY" || {
  echo "BLOCKED: builder concurrency must be an integer from 1 to 6"; exit 2;
}
```

- Default concurrency: 4.
- Maximum concurrency: 6 after every work order and return-only output passes
  its byte budget.
- One screen per child.
- Ten screens normally use Wave 0 plus two or three supporting waves.
- Launch the next wave only after the current wave's gates pass.

For every returned screen:

- `DONE`: validate and record success.
- `DONE_WITH_CONCERNS`: validate, preserve output, and aggregate concerns at the
  wave boundary.
- `NEEDS_CONTEXT`: foreground supplies only the named fact and retries once.
- `BLOCKED`: use exact corrective context when available; otherwise build only
  that screen in foreground.
- malformed/channel failure: retry once, then foreground for that screen.

After each wave, run TypeScript, route contracts, and changed-screen quality
validators. Capture complete findings once, group them by root cause, and repair
affected screens in parallel. Do not advance with a failed gate.

## Step 11.4 — Cross-screen quality sweep

After all screens compile, run the validators against generated screens only:

```bash
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-screen-quality.js" --report <screen-files>
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-color-contrast.js" --report <screen-files>
npx tsc --noEmit
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
```

Reject oversized empty cards, repeated identical shells, placeholder icons where
approved imagery is required, cropped content/actions, sticky actions behind tab
or system insets, redundant headers/back controls, arbitrary colors, unapproved
offline messaging, and generic operational dashboards for discovery/commerce
apps.

Record a successful validation fingerprint over `app`, `src`, `brand`,
`package.json`, `tamagui.config.ts`, and the compiled contracts. Before an
identical final validation, recompute the fingerprint and compare the exact
validator set through `screen-builder-contract.js`. Skip only when both match a
previous successful record. Never skip any validation after a changed byte.

Record the validated screen checkpoint:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-pipeline-state.js" \
  --project-root "<working_dir>" --record --step "11.4" \
  --artifact-tree "routes=app" \
  --artifact-tree "source=src"
```

### Step 12 — Start Metro

Run schema generation and the final validation gate synchronously. If the
successful fingerprint and exact validator set already match Step 11.4, skip
only this duplicate gate. Otherwise run it in full.

```bash
cd <working_dir>
npm run generate-schemas
npx tsc --noEmit
node "${CLAUDE_SKILL_DIR}/../../scripts/check-routes.js"
npx expo start
```

Launch Metro asynchronously, capture the terminal ID and native Metro URL,
generate/open the QR image where supported, and persist the terminal ID in
`memory-bank.md`. Do not perform route crawling or React Native Web substitution.

Offer `/debug-app` only after the user reports a concrete native symptom.

### Step 13 — Summary

Run `planning-timings.js --summary` and report `foregroundPlanningMs`, each
screen-build channel, aggregate `screenBuildMs`, `screenValidationMs`,
`userApprovalWaitingMs`, `totalExecutionMs`, and `totalMeasuredMs` separately.
Do not attribute foreground work, validation, or user waiting to child-model
performance.

Print the compact creation summary, then present exactly 5 options:

```text
What now?

1. Preview screens in browser  (/preview-screens)
2. Deploy to tenant            (/deploy)
3. Edit the app                (/edit-app)
4. Add more capabilities       (/add-dataverse, /add-connector, /add-native)
5. Configure auth later        (/set-app-registration-native)

Which option? (or "none — I'll keep iterating locally")
```

Do not recommend an option or execute one before the user chooses.