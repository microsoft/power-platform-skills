# Data model first - `/create-mobile-app`

Read this file in full when Step 0 of [`SKILL.md`](../SKILL.md) chooses the **data model first** build order.
`SKILL.md` has already routed the request, confirmed a fresh template or a creation continuation, resolved the Power Apps CLI (`PA_KIND`), and gathered the requirements into `.tmp/requirements.json`; choosing this order confirmed the brief.

## Workflow

Intent and creation-state checks, the requirements (iOS + Android fixed), and the build-order choice ([`SKILL.md`](../SKILL.md) Step 0) → prerequisites →
rough plan preview → Gate 1 architecture (native capabilities, connectors,
then data platform) → Gate 2 Dataverse model when selected → Gates 3 and 4
screen graph/specifications → environment and template preparation → app
initialization → design system → conditional Dataverse materialization and
sample data → Mobile Offline Profile offer for Dataverse apps → native
capabilities and connectors → navigation and screens → validation, preview,
and summary.

---

## TypeScript Gate Policy — no quality compromise

`tsc` is a **phase gate**, not a reflex after every tiny edit. The app may not advance past a gate until TypeScript is clean.

**Required gates:**
- **Scaffold gate:** Step 6.6 after existing-template preparation, `pa app init`, and dependency verification.
- **Dataverse/generated-services gate:** immediately after Step 8 returns and generated services/models are refreshed.
- **Navigation/skeleton gate:** after Step 10b layouts and Step 10.8 shared code/skeletons are written, before Step 11 builders launch.
- **Screen-wave gate:** after each Step 11 screen-builder wave returns, before launching the next wave.
- **Final gate:** before Step 12 starts the dev server.

**When a gate fails:**
1. Capture the full `tsc --noEmit` output once.
2. Classify errors by root cause (for example: generated model names, service option shapes, invalid UI props, typed percentage values, create/update payload typing, missing imports).
3. Repair in a batch.
4. Re-run the same gate once after the batch.
5. Continue only when the gate is clean, or stop/block according to the retry policy.

**Do not run full-app `tsc` after every microscopic local edit inside the same repair pass.** That is slower and encourages line-by-line patching. Batch root-cause fixes, then re-run the gate. This is a speed improvement only; it does **not** lower the quality bar.

**Hard stops:**
- Do not launch data-source work from a broken scaffold gate.
- Do not launch screen-builders from broken generated services, layouts, shared code, or skeletons.
- Do not launch wave N+1 until wave N passes its `tsc` gate.
- Do not start the dev server until the final gate is clean.
- Do not hide approved capability failures behind mocks or TODOs just to satisfy `tsc`.

---

## Build documentation protocol

This protocol applies after Step 0 selects fresh creation or an approved
creation continuation. Routing an existing-app request elsewhere, asking for
unclear intent, or declining creation does not create, reopen, or reset the
creation plan or change its phase status.

The run also writes a plan the user can read while it happens and keep afterwards:
`<working_dir>/docs/create-app-plan.html`, rendered by
[`scripts/app-docs.js`](${PLUGIN_ROOT}/scripts/app-docs.js) in the same Fluent format the
Power Pages `/create-site` plan uses. It is the record of *why* the app looks the way it does,
so a teammate opening the repo months later can see the environment, the approved data model,
and the screen plan without re-reading a transcript.

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' <command>
```

| Command | Use |
|---|---|
| `init --json-file <path>` | Once, at Step 2b, with `{"appName","dataPlatform","buildOrder":"data-model-first"}`. Safe to re-run: a resume keeps recorded progress. The display name is user text, so it travels in the file, never as an argument. |
| `step --id <phase> --status <pending\|active\|done\|skipped\|failed> [--note "<text>"]` | At every phase boundary. Marking a phase `active` closes any previous one. |
| `set --section <name> --json '<object>'` or `--json-file <path>` | When a decision is made. Merges, so a later step can add to a section. |
| `step --id <phase> --status failed --note "<what stopped it>"` | Before surfacing any unrecoverable STOP. Best-effort like the rest: if it fails, still stop. |
| `phone --stage building\|screens\|qr` | Moves the plan's phone through its three stages: the building animation, the screen carousel at Step 6.75, and the Metro QR at Step 12. |

**Open the plan in the user's browser as soon as `init` creates it**, with the host's file opener
or `open` / `xdg-open` / `cmd /c start ""` on the quoted path. A plan the user never sees is a plan
that only ever existed as terminal text, and terminal text scrolls away during a long run. Opening
it once is enough: the page reloads itself as each phase lands.

**Phases** (`--id`): `requirements`, `architecture`, `data-model`, `screen-plan`, `scaffold`,
`design`, `auth`, `dataverse`, `capabilities`, `screens`, `run`. Any other id is rejected by name.

**Write each gated section into the plan *before* asking for approval**, with `--state proposed`,
then flip it to `--state approved` once the user says yes. The plan is already open in their
browser, so a rendered ER diagram or screen graph is what they answer the gate against. Recording
the decision afterwards means approving from terminal text and seeing the picture only once it is
too late to change it.

Step 3's Architecture gate lists every gate with its phase and section. The Gate 2 calls below are
the pattern each one follows:

```bash
DOCS="${PLUGIN_ROOT}/scripts/app-docs.js"
# 1. propose - the tab shows "Proposed - review this, then answer the prompt in your terminal"
node "$DOCS" --working-dir '<working_dir>' set --section dataModel --json-file <tmp>/data-model.json --state proposed
node "$DOCS" --working-dir '<working_dir>' step --id data-model --status active --note "Gate 2 — awaiting your approval"
# 2. point the user at that tab, then ask the gate question
# 3. on approval
node "$DOCS" --working-dir '<working_dir>' set --section dataModel --json-file <tmp>/data-model.json --state approved
node "$DOCS" --working-dir '<working_dir>' step --id data-model --status done --note "Gate 2 — approved"
```

Pass a fresh `--note` when you close a gate. A note belongs to the status it was written with, so
changing status without one clears it rather than leaving "awaiting your approval" under a step the
user has already approved.

If the user asks for changes, rewrite the section with `--state proposed` again and re-ask. The
page reloads itself, so they see the revision without touching anything.

**Record each other section as soon as it is known** — not in a batch at the end, or an abort
leaves a plan that explains nothing:

| Section | Written at | Contents |
|---|---|---|
| `environment` | Step 1, confirmed Step 4 | `displayName`, `environmentId`, `environmentUrl`, `tenantId`, `publisherPrefix` |
| `requirements` | Step 2b | `appName`, `slug`, `platforms`, `aesthetic`, `industry`, `brief`, `features[]` |
| `architecture` | Gate 1 | `dataPlatform`, `nativeCapabilities[]` and `connectors[]` as `{ name, reason }` — a bare name cannot be approved or rejected, the reason is the decision |
| `dataModel` | Gate 2 | `connectorOnly` when there are no tables; otherwise `tables[]` with `logicalName`, `displayName`, `status` (`new`/`reused`/`modified`, or the plan's `create`/`reuse`/`extend`), `purpose` (what it holds), **`reason` (why it is created, reused or extended)**, `columns[]` (`logicalName`, `displayName`, `type`, `key: PK\|FK`), `relationships[]` (`relatedTable`, `name`, `cardinality`) |
| `offline` | Gate 2 | `enabled`, `mode`, `tables[]`, `rationale` |
| `screens` | Gates 3 and 4 | `navigation`, `list[]` with `name`, `route`, `purpose`, `data`, `capabilities[]` |
| `design` | Step 6.75 | `direction`, `headingFont`, `bodyFont`, `darkMode`, `palette[]` (`name`, `value` as `#rrggbb`). Use the real family names from [`typography-and-tone.md`](${PLUGIN_ROOT}/shared/references/typography-and-tone.md) (`Inter`, `JetBrains Mono`, …) — the plan renders each name in the typeface it names, so a label that is not a real family shows as the fallback. |
| `auth` | Step 7 | `status` |
| `trust` | Step 10, after capabilities and connectors are wired | `permissions[]` (`name`, `status` as one of the acquisition patterns below, **`detail`: when access is requested and why**), `handles[]`, `notCollected[]`, `battery[]` (`name`, `detail`) |

The ER diagram is **built from `dataModel.tables`**, so populate the structured fields rather
than only a Mermaid string — that is what makes the diagram, the column tables, and the
new/reused/extended colouring agree with each other.

**Every reuse, create and extend decision needs a `reason`.** "Reusing `account`" is not
reviewable; "Reusing `account` — sites are already maintained there by the service desk, and a
second Site table would drift" is. Write the reason the architect actually used, including what
was rejected, since that is what the user is being asked to approve at Gate 2.

**Use `--json-file` for anything the user wrote.** Size is not the test — an app called
`Dave's Rounds` is enough. A value interpolated into a single-quoted shell argument ends that
quoting at the first apostrophe, which at best corrupts the JSON and at worst leaves whatever
follows to the shell. App names, briefs, feature lists, table reasons and design directions are
all user-authored, so they are written to a file with the `Write` tool and passed by path.

`--json` inline is for values this skill controls end to end, such as a fixed status string.

**Every one of these calls is best-effort.** If `app-docs.js` fails, say nothing and carry on:
the documentation must never gate, retry, or fail a build.

**Mark the active creation phase `failed` before stopping on a creation error.**
Step 0 routing exits leave existing creation history untouched. Once creation is
underway, a STOP is a terminal state the user has to act on, and the plan is
probably still open in their browser. Without this the last
phase stays `active`, so the page keeps reloading and keeps reporting work in progress on a run
that ended. A failed phase settles the page, so the final thing it shows names what stopped.

**No argument switches this protocol off.** `--no-design` suppresses design previews and
`--no-preview` does not exist (Step 2c). The plan is how an abandoned or failed run explains
itself, so it is written on every creation path after Step 0's routing decision.

---

### Step 1 — Prerequisites

**Telemetry checkpoint: `validate_development_toolchain`**

Run all checks first — no point planning if the toolchain isn't ready.

**Important: npm auth and Power Platform app auth are separate.** The account used for `npm install` can be different from the account used by the Power Apps CLI (`$PA`):

| What | Uses | Typical account |
|---|---|---|
| `npm install` private feed access | npm/Azure Artifacts auth configured outside this skill | Account with feed Reader access |
| `pa app init`, Dataverse, deploy | Power Apps CLI browser auth + `az login --tenant <env-tenant>` for Dataverse helper scripts | Power Platform environment account, often a test-tenant/admin account |

Renewing npm feed auth does not sign the user into the Power Apps CLI. If the Power Apps CLI prompts for browser auth later, that is expected and unrelated to the npm/ADO feed token.

Then run the checks:

```bash
node --version                                      # v22+
npm  --version                                      # v10+
az account show --query "user.name" -o tsv          # Azure CLI logged in (needed for Dataverse helper scripts)
git --version                                       # optional
```

**Do NOT probe Xcode, Java, Android Studio, or CocoaPods here.** This plugin's flow is plan → scaffold → code → local Expo dev server. Build + deploy (`npm run build` / `pa app push`) is a separate user-driven step via the `/deploy` skill. Local native compile is the user's choice and lives outside this skill (run the platform-specific native command directly when needed). See [`shared/version-check.md`](${PLUGIN_ROOT}/shared/version-check.md) — only the **Always required** tier matters here.

| Missing | Action |
|---|---|
| Node < 22 | STOP — instruct `nvm install 22 && nvm use 22` |
| `az` | STOP — instruct `az login` |

Template-only rule: this skill no longer provisions npm feed tokens, PAT fallbacks, vendor fallbacks, or registry rewrites. The user must run `npm install` in the fresh template folder before invoking `/create-mobile-app`.

Capture target Power Platform environment for the remaining flow.

**Source of truth for env selection: the setup question's answer first, the generated `power.config.json` second.** The setup question in `SKILL.md` Step 0 offers the template's `ENV=<id>` or takes another environment ID, and records the answer as `environmentId` in `.tmp/requirements.json`; pass that ID to `scripts/resolve-environment.js` to resolve the Dataverse URL and tenant. If both are empty, ask for an environment ID. A Dataverse URL is useful as a resolver fallback for existing apps, but it is not enough for `pa app init` because init needs `--environment-id`.

| Step | Source | When user is asked |
|---|---|---|
| 0. `.tmp/requirements.json` has `environmentId` | `scripts/resolve-environment.js <environment-id>` | Never — the setup question already asked |
| 1. User supplies env ID | `scripts/resolve-environment.js <environment-id>` | Ask only if the requirements and `power.config.json` hold no ID, or the user wants a different env |
| 2. User wants a different account | Follow shared-instructions standalone CLI auth handling | Only if resolution/token acquisition fails or user asks |
| 3. User wants different env | Ask for another env ID and re-run resolver | Only if resolution fails or the user asks to change it |
| 4. `$PA app init -t MobileApp --display-name "$DISPLAY_NAME" --environment-id $ACTIVE_ENV_ID --non-interactive` | Persists choice into `power.config.json` | Only when this skill owns the initial init path |

```bash
TARGET_ENV=$(node -e "try { console.log(require('./.tmp/requirements.json').environmentId || '') } catch { console.log('') }")
if [ -z "$TARGET_ENV" ] && [ -f power.config.json ]; then
  TARGET_ENV=$(node -e "try { const id=require('./power.config.json').environmentId || ''; console.log(id); } catch { console.log(''); }")
fi
test -n "$TARGET_ENV" || { echo "✗ Environment missing. Provide an environment ID."; exit 2; }
ENV_JSON=$(node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$TARGET_ENV")
printf '%s\n' "$ENV_JSON" > .resolved-environment.json
ACTIVE_ENV_ID=$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.environmentId || '')" "$ENV_JSON")
ACTIVE_ENV_NAME=$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.displayName || j.environmentUrl || '')" "$ENV_JSON")
ACTIVE_ENV_URL=$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.environmentUrl || '')" "$ENV_JSON")
ACTIVE_TENANT_ID=$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.tenantId || '')" "$ENV_JSON")
test -n "$ACTIVE_ENV_ID" || { echo "✗ Environment ID missing. Provide the environment ID directly."; exit 2; }
echo "✓ Target env: $ACTIVE_ENV_NAME ($ACTIVE_ENV_ID)"
echo "✓ Target env URL: $ACTIVE_ENV_URL"
echo "✓ Target tenant: ${ACTIVE_TENANT_ID:-unknown}"
```

**Orchestrator handling for `exit 2`:** ask the user for their environment ID directly, write it as `environmentId` in `.tmp/requirements.json` with the `Write` tool, then re-run the capture block above. Do not run `pa app init` here; Step 6 owns initialization after the user confirms the target environment.

Stash `$ACTIVE_ENV_ID`, `$ACTIVE_ENV_NAME`, `$ACTIVE_ENV_URL`, and `$ACTIVE_TENANT_ID` for Step 2 (name-collision pre-flight), Step 6 (`pa app init`), and Step 7 (`auth.config.json` tenant/environment cache). If parsing fails, ask for an environment ID again.

If `resolve-environment.js` cannot get tokens, run `az login --tenant <env-tenant>` in the foreground. If `pa app init` later uses the wrong account, follow shared-instructions standalone CLI auth handling and retry once.

### Step 1.7 — Detect publisher prefix

**Shared step:** read [`publisher-prefix.md`](publisher-prefix.md) and follow it in full.

### Step 2 — Read the requirements

[`SKILL.md`](../SKILL.md) Step 0 gathered the requirements, and recorded their telemetry checkpoint, before the build-order question; choosing this order confirmed the brief.
Read `<working_dir>/.tmp/requirements.json` and ask none of it again:

| Field | Use |
|---|---|
| `appName` | `<displayName>` |
| `slug` | The app slug, derived from the name. Step 2c shows it, so the user can change it with `edit`. |
| `aesthetic` | The overall look |
| `environmentId` | The target environment, resolved at Step 1 |
| `industry`, `features` | The domain and the feature list, for Step 2c's estimates and the planner |
| `dataPlanningMode` | `connector-only` or `required`; see Step 2b |
| `brief` | `<requirements_brief>`, the confirmed brief. It replaces the thin `$ARGUMENTS` as the primary input to the planner. |

Set `<target_platforms> = "ios, android"` for every new app. Do not ask the
user to choose between iOS and Android; the mobile template targets both and
downstream planning must retain platform-specific behavior for each.

**App-name collision pre-flight.** Once `<displayName>` is fixed, check the chosen env for a name collision:

```bash
$PA app list --environment-id "$ACTIVE_ENV_ID" --json 2>/dev/null | grep -F "<displayName>" >/dev/null && \
  echo "COLLISION" || echo "OK"
```

If `COLLISION`, ask the user via `AskUserQuestion`:
> "An app named `<displayName>` already exists in `<ACTIVE_ENV_NAME>`. Choose:
>  1. Pick a different name (recommended)
>  2. Delete the existing app in Maker portal — DESTRUCTIVE, asks confirmation outside this skill
>  3. Continue anyway (bg `pa app init` will fail; you'll have to rename later — NOT recommended)"

Re-prompt for name if (1). If (2), send the user to Maker portal to delete the existing app, then re-run the collision check. Only proceed once collision is resolved.

If `pa app list` is unavailable in the installed CLI version, skip the pre-flight silently and continue.

Don't enter plan mode here — that's the planner agent's job in Step 3.

**Application Insights requirement normalization:** If the user's description asks for Application Insights, telemetry, app analytics, diagnostics, traces, or monitoring of this generated app, note it for a post-creation `/setup-app-insights` run (Application Insights is no longer configured during creation) and explicitly tell the planner that it is host/runtime configuration, not a data connector or planning constraint. The planner must not propose the Azure Application Insights connector, a custom telemetry connector, telemetry tables, or telemetry screens unless the user separately asked to build an in-app analytics dashboard. If the user names specific custom events (for example `OrderSubmitted` or `InspectionCompleted`), preserve those event names and their approved scalar properties in the corresponding per-screen specs so screen builders can emit them through `getCustomEventsLogger()`; do not convert them into connectors or data-model artifacts.

### Step 2b — Open the plan

Create the plan now, record the brief, and open the first phase. Write `<working_dir>/.tmp/plan-init.json` with the `Write` tool first — the display name is the user's own text, and
a `"`, a backtick or `$(…)` in it would break out of a shell argument before Node saw it:

```json
{"appName":"<displayName>","dataPlatform":"unknown","buildOrder":"data-model-first"}
```


```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' init --json-file '<working_dir>/.tmp/plan-init.json'
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' set --section requirements --json-file '<working_dir>/.tmp/requirements.json'
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id requirements --status active --note "Brief confirmed"
```

The phase stays open: Step 2c still asks the user to approve the plan preview, and a closed phase cannot report that the run is waiting on them.
A `--note` is what raises the waiting-for-input banner on the plan, so the user can tell from the page that the run is blocked on them rather than still working.
**Set one whenever you are about to ask a question and the answer gates the run.** It clears itself on the next status change, so there is nothing to remember to take down.

**Go straight to Step 2c (plan preview).** Do NOT add a separate "Proceed to planning?" prompt — choosing this build order confirmed the brief, and that IS the planning go-ahead. The only abort gate after this is Step 2c's `proceed/edit/abort` block, which is intentionally distinct because it shows the rough cost estimate.

Read the provisional Dataverse planning mode before Step 2c: `dataPlanningMode` in the requirements, which [`SKILL.md`](../SKILL.md) Step 0 classified while gathering them, applying
[`shared/references/connectivity-intent-ownership.md`](${PLUGIN_ROOT}/shared/references/connectivity-intent-ownership.md).
A `connector-only` brief always arrives here, because it skips the build-order question.

Store it as `<recommended_dataverse_planning_mode>`. The first
user-visible data-platform choice happens in the planner's architecture gate
after native capabilities and connectors have been presented. Dataverse
discovery does not run before that gate.

Also stash `<exact_target_facts_required> = yes` when planning depends on any
existing/standard/managed table, reuse or extension decision, proposed-name
collision decision, relationship target, computed column, or target
customizability fact. Otherwise set it to `no`. This flag controls only safe
planning degradation; it never relaxes `/add-dataverse` reconciliation.

**Design decisions are deferred to Step 6.75** — `/design-system` (ships with this plugin) handles brand inputs, the style picker, and visual companion preference in one flow after the project is scaffolded. Do NOT ask design questions here.

Set tentative defaults (the preview preference applies at Step 6.75):

- `<visual_companion> = yes` — render `_plan_preview.html` at Step 6.75, after the design choice. **Nothing is opened in a browser during a create run**, whatever this is set to: the build plan shows the same screens in its phone frame and links out to the file, and every opener in `/design-system` and its style picker is gated on `CODE_APPS_NATIVE_ORCHESTRATING=1`, which this skill passes. The flag governs `/preview-screens` wherever it runs — including the Step 11.4 offer, which is a browser window the user asked for by picking (a) or (b), not one that appears on its own — and a later `/edit-app` re-plan. Gate 4 remains markdown-only regardless. `/design-system` may change it to `no`; persist the final value to memory-bank for future runs.
- `<design_vibe_opt_in> = deferred` — Step 6.75 sets the real value. While `deferred`, the planner does NOT prompt for a direction; it writes a placeholder `## Design Direction: <deferred — set by /design-system>` block so screen-planner can still run.

**`--no-design` escape hatch.** For headless / token-constrained runs, set `--no-design` in `$ARGUMENTS`. It forces `<visual_companion> = no`, skips the style-picker handoff at Step 3a entirely, and short-circuits Step 6.75 to a no-op (placeholder block stays in `native-app-plan.md`; screen-builders fall back to industry-inferred defaults).

### Step 2c — Plan preview (rough, always shown)

> **Goal:** Give the user a cheap exit before any mutation happens. This is the **last point** before the run touches the app itself — no `pa app init`, no Dataverse writes, no agent tokens spent on planning. The only things already written are the requirements in `.tmp/requirements.json` and the build plan under `docs/`, which Step 2b created so the user has something to read while answering; an abort here leaves those and nothing else. After Step 3 starts, every abort gets more expensive (half-written `native-app-plan.md`, partial `_screens_section.md`, architect tokens already burnt).

**Always runs. There is no `--no-preview` flag in v0** — we need calibration data (~10+ runs with recorded estimate-vs-actual) before we can trust the rough estimates enough to let users skip them. Once the data shows estimates are reliably within ±50%, evaluate adding a skip flag for repeat-user workflows.

**Compute the estimates from inputs already in hand** (no agent spawn — pure heuristics on the confirmed brief and the wizard answers):

| Output | Input proxy | Computation | Confidence |
|---|---|---|---|
| Tables | Distinct nouns in confirmed brief | `count(unique_nouns) × [0.7, 1.3]` rounded | low — architect may merge or split |
| Connectors | Connector keywords in the confirmed brief | `len(candidates)` | low — Gate 1 confirms the actual list |
| Screens | Confirmed features in brief | `count(features) × [2, 3]` | low — depends on navigation choice |
| Planning min | Tables + screens | lower bound `max(10, tables × 0.3 + screens × 0.4 + 2)`; upper bound `max(15, computed upper)` | low — protects the quality-first Gate 2 data-model budget |
| Scaffold min | Fixed | `1-2` (template preparation + npm install already happened before skill invocation) | high |
| Build min | Screens, parallel cap of 5 | `ceil(screens / 5) × 0.6` | medium |
| Extra prompts | `<industry_confidence>` + `<design_vibe_opt_in>` | `+1 if low-confidence industry; +1 if vibe-opt-in == yes` | high |

Print the block once, exactly in this format (substitute computed values; ranges as `low-high`):

```
─── Plan preview (rough) ─────────────────────────────────
Based on your confirmed brief, before any agent runs:

Scope (proxy estimates — actual numbers come from architects):
  Tables       ~<low>-<high>      ← from <N> nouns in brief; architect may merge/split
  Connectors    <N> inferred      ← <comma-separated names>  (confirm at Gate 1)
  Screens     ~<low>-<high>       ← from <N> features × ~2-3 screens each
  Approval gates  4               ← architecture, data model when applicable, screen graph, screen specs

Time (rough — agent time only, excludes your approval latency at gates):
  Planning      ~<low>-<high> min ← includes the quality-first 10–15 min data-model target; approvals add latency
  Scaffolding   ~1-2 min          ← validates prepared template + runs power-apps init
  Screen build  ~<low>-<high> min ← parallel, capped at 5 concurrent

Token tier: Opus everywhere in v0 (model routing not yet shipped).

⚠ These are proxies, not measurements:
  • Table count is "noun count in brief" — architect may collapse or split
  • Time excludes your approval latency at up to 4 applicable gates
  • If industry inference is low-confidence, +1 picker prompt
  • If you opted into the design vibe picker, +1 prompt + planner re-spawn
  • If any gate is rejected, that section regenerates (~2-3 min each)

Proceed, edit brief, or abort? [proceed/edit/abort]
─────────────────────────────────────────────────────────
```

**Three-option exit:**

| User answer | Action |
|---|---|
| `proceed` (or empty / Enter) | Continue to Step 3. Default. |
| `edit` | Revise the brief from the user's changes, write it to `.tmp/requirements.json` with the `Write` tool, re-run Step 2b's `set --section requirements`, and return here for a fresh preview. **No app changes** — only the requirements file and the plan are rewritten; Step 2c runs before Step 3 touches the template. |
| `abort` | Print `"Aborted at Step 2c. The app is unchanged. Re-run /create-mobile-app when ready."` and exit cleanly. No memory bank, no scaffold. |

**Why "always show" is correct in v0** (do not skip without explicit user request):
- Cost when user proceeds: ~30s (read + decide). Token cost ~500/run = ~$0.008.
- Cost when user aborts late (after Step 3 starts): 5-10 min + dirty working dir + frustration.
- Asymmetry: bounded 30s vs unbounded 30 min. Always show the bounded cost.
- Forced calibration: every run produces the `<estimate, actual>` data we need for v0.x model routing decisions. Skipping drops calibration data.

**Set expectations before handing off to the planner:**
Raise the wait before showing the estimate, and close the phase once the user approves:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id requirements --status active --note "Waiting for you to approve the plan preview"
# ... after they approve ...
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id requirements --status done
```

> "Brief locked in. Planning surfaces up to 4 approval prompts (data platform + native capabilities + connectors → data model when Dataverse is selected → screen graph → screen specs). Data-model readiness is quality-first, with a 10–15 minute target:
>  • Gate 1 (architecture) — confirm Dataverse choice, native capabilities, and connectors before schema work
>  • Gate 2 (data model, Dataverse only) — budget 10–15 min for verified reuse/extend/create decisions, ER columns, relationships, tiers, and risks; auto-skipped for no-Dataverse apps
>  • Gate 3 (screen graph) — approve destinations, navigation, and shared conventions
>  • Gate 4 (screen specs) — **3–8 minutes** for detailed screen contracts
>
> For Dataverse-required apps, factual foreground milestones will show
> environment, inventory, candidate, detail, and timing counts within 30
> seconds of starting metadata work after Gate 1 approval. Connector-only apps
> skip those metadata milestones. While the
> architect runs, new milestone IDs from
> `.tmp/data-model-planning-status.json` are rendered without inventing
> percentages. If Gate 2 has not surfaced after 15 minutes of data-model planning, inspect the last
> applicable milestone before interrupting."

### Step 2d — Template-only mode

No background scaffold pipeline is used. The template is already present in `<working_dir>` and dependencies are expected to be installed before this skill starts (`npm install`). Continue directly to Step 3.

### Step 3 — Plan (planner agent + up to 4 applicable approval gates)

**Telemetry checkpoint: `plan_app_architecture`**

First, create the working and planning-artifact directories:

```bash
mkdir -p <working_dir> <working_dir>/.tmp
```


### Architecture gate

Planning is now the live phase. Open it with what the run is doing rather than with a question:
between gates the agents work for minutes, and the plan must not tell the user the run is waiting
on them while it is not.

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id architecture --status active --note "Planning the architecture"
```

**Raise every gate in the plan as you present it, and take it down as soon as it is answered** -
here, in the inline fallback below, and in every revision loop. The plan is open in the user's
browser, and its banner is how they can tell the run is waiting on them rather than still working.

| Gate | `--id` | Section written first, `--state proposed` | Once approved, open next |
|---|---|---|---|
| 1 - architecture | `architecture` | `architecture` | `data-model`, note "Designing the data model" (`connector-only`: `screen-plan`, note "Planning the screens") |
| 2 - data model, `required` only | `data-model` | `dataModel`, and `offline` when the plan has one | `screen-plan`, note "Planning the screens" |
| 3 - screen graph | `screen-plan` | `screens` | `screen-plan`, note "Writing the screen specs" |
| 4 - screen specs | `screen-plan` | `screens` | nothing - Step 3.9 closes the phase |

```bash
DOCS="${PLUGIN_ROOT}/scripts/app-docs.js"
# Just before presenting gate <N>:
node "$DOCS" --working-dir '<working_dir>' set --section <section> --json-file <tmp>/<section>.json --state proposed
node "$DOCS" --working-dir '<working_dir>' step --id <id> --status active --note "Gate <N> — awaiting your approval"
# As soon as the user approves it:
node "$DOCS" --working-dir '<working_dir>' set --section <section> --json-file <tmp>/<section>.json --state approved
node "$DOCS" --working-dir '<working_dir>' step --id <next id> --status active --note "<note from the table>"
```

Flip each section to `approved` when its gate is answered, not later in the Step 3.9 batch. A
section left `proposed` while the next phase works reads as a question nobody is asking. The
architecture-only planner pass does nothing but present Gate 1, so raise Gate 1 before dispatching
it. When the planner's completion pass presents Gates 2-4 itself, the plan cannot see inside it and
keeps its progress note until the result comes back.

Run the planner once in architecture-only mode before any Dataverse discovery:

```
Spawn agent: mobile-app:native-app-planner

Prompt:
  Plan and approve architecture inputs for a Power Apps mobile app.
  Architecture phase: gate-only
  Requirements brief: <requirements_brief>
  Original prompt: <full $ARGUMENTS verbatim>
  Wizard answers: <Step 2 answers>
  Target platforms: iOS and Android
  Recommended Dataverse planning mode: <recommended_dataverse_planning_mode>
  Working directory: <absolute path>
  Plugin root: ${PLUGIN_ROOT}
  Dataverse planning snapshot: NOT SUPPLIED
  Dataverse planning evidence: NOT SUPPLIED
```

The planner presents native capabilities, then connectors, then the
data-platform choice in Gate 1. On approval it writes
`<working_dir>/.tmp/approved-architecture.md` and returns exactly
`NEEDS_CONTEXT: dataverse-planning-mode:<required|connector-only>`.

Treat that signal as the successful architecture result, set
`<dataverse_planning_mode>` only after the architecture-result checks in the
canonical status switch below pass, and continue. Any other terminal status
follows that switch. If the nested planner is unavailable, prepare and approve
all three architecture decisions inline: native capabilities, connectors, and
the data-platform choice. Use the planner's Gate 1 dependency checks, write
the same approved artifact, and continue without adding another approval.

Now execute the deferred Step 1.7 publisher-prefix detection for `required`.
For `connector-only`, set `$DETECTED_PUBLISHER_PREFIX = ""`, print
`↷ Publisher-prefix discovery skipped — connector-only planning.`, and do not
call `detect-publisher-prefix.js`.

### Foreground Dataverse planning snapshot and evidence

**Shared step:** read [`dataverse-planning-snapshot.md`](dataverse-planning-snapshot.md) and follow it in full.

**Hard rule — planner writes are restricted during Step 3.** The planner (and any sub-agents it spawns) is permitted to write to **only**:

- `<working_dir>/native-app-plan.md`
- `<working_dir>/_screens_section.md`
- `<working_dir>/.tmp/*`

All other paths in `<working_dir>/` (notably `app/`, `src/`, `package.json`, `power.config.json`, `tamagui.config.ts`, `tsconfig.json`, `node_modules/`, `memory-bank.md`) are owned by the foreground setup phases. Do not mutate them during planning.

If the planner needs to record a `DONE_WITH_CONCERNS` from a sub-agent (data-model architect, screen-planner), add it to an in-memory queue `DEFERRED_CONCERNS[]` during Step 3. Do not write `memory-bank.md` yet. Step 6.7 must always flush `DEFERRED_CONCERNS[]` into `memory-bank.md` `## Concerns` immediately after the file is created.

**Resume-from-draft check.** Before spawning, check if `<working_dir>/native-app-plan.md` already exists with content. If yes, a previous planner run (possibly in a degraded context with no `Task`/gate tools) already drafted sections. Read it. If it has populated `## Data Model` / `## Native Capabilities` / `## Connectors` but the gates were never run (no `## Approvals` block, or the file was authored by an agent that returned `BLOCKED: tool surface missing`), pass `resume_from_draft: true` and the existing path to the planner so it loads the draft as baseline instead of regenerating from scratch.

**Planner preflight (silent).** Before the full Task spawn, do a no-op `Task` probe for `mobile-app:native-app-planner` (same pattern as Step 11.0). If the probe fails with `Agent type … not found`, `tool unavailable`, or the host clearly cannot route nested agents, fall through to **inline-gate mode** (described below) without prompting. The orchestrator has the full tool surface itself — it can run the gates directly. Do not retry, do not ask the user.

**Announce the handoff before the Task call** (so the user isn't staring at a blank screen while the planner spins up):
- `required`: > "→ Spawning planner agent from the verified foreground planning snapshot. Gate 2/data-model readiness is quality-first with a 10–15 minute target. I will print each factual `data-model-planning-status.json` milestone and elapsed count as it lands."
- `connector-only`: > "→ Spawning planner agent in connector-only mode; a foreground planning snapshot and data-model mutation are not required."

Then spawn the `mobile-app:native-app-planner` agent via `Task` (the plugin name `mobile-app:` prefix is required — without it `Task` returns `Agent type not found`):

```
Spawn agent: mobile-app:native-app-planner

Prompt:
  Plan a Power Apps mobile app.

  Requirements brief (confirmed with user):
  <requirements_brief — the `brief` in `.tmp/requirements.json`>

  Design vibe opt-in: <design_vibe_opt_in — always "deferred" unless `--no-design` is in $ARGUMENTS, in which case use "skip". Never invent yes/no/other values.>
  Visual companion: <visual_companion — "yes" or "no">

  Original prompt: <full $ARGUMENTS verbatim>
  Wizard answers: <Step 2 answers>
  Target platforms: iOS and Android (fixed; no platform question)
  Working directory: <absolute path of <working_dir>>
  Plugin root: ${PLUGIN_ROOT}
  Architecture phase: complete
  Approved architecture artifact:
  <working_dir>/.tmp/approved-architecture.md
  Dataverse planning mode: <required | connector-only>
  Dataverse planning failure reason: none
  Normalized Dataverse foreground planning snapshot: <absolute SNAPSHOT_PATH verbatim for required; otherwise NOT SUPPLIED>
  Compact Dataverse architect evidence: <absolute ARCHITECT_EVIDENCE_PATH verbatim for required; otherwise NOT SUPPLIED>
  Structured schema contract: <absolute
  `<working_dir>/.tmp/dataverse-schema-contract.json` for required; otherwise
  NOT SUPPLIED>
  Publisher prefix (detected from env): <DETECTED_PUBLISHER_PREFIX from Step 1.7, e.g. "cr8142a" — use literally as `<prefix>_<entity>` in all logical names. If empty/NOT DETECTED, fall back to `cr` placeholder and surface a `DONE_WITH_CONCERNS` note that Dataverse will normalize at create time.>

  Follow native-app-planner.md. Restore the approved architecture without
  re-asking Gate 1, then run conditional Dataverse modeling and the remaining
  applicable approval gates. On terminal return, emit one of
  `DONE` / `DONE_WITH_CONCERNS:` / `NEEDS_CONTEXT:` / `BLOCKED:` as the literal
  first line per AGENTS.md rule #10.
```

The planner runs gates internally for architecture → conditional data model →
screen graph → screen specs, and writes `<working_dir>/native-app-plan.md`.
Wait for it to return before continuing — do not proceed on a
partially-approved plan.
On a successful `required` return, require both
`.tmp/dataverse-schema-contract.json` and `.tmp/mobile-plan-status.json`
before continuing. If the receipt is missing, STOP as `BLOCKED`; this
orchestrator must not synthesize it after the planner has returned.

#### 3.0a — Inline-gate fallback (planner unavailable OR returned `BLOCKED: tool surface missing`)

When the preflight fails OR the planner returns `BLOCKED: tool surface missing <…>`, the orchestrator runs all applicable gates inline. Do NOT re-spawn the planner — it cannot succeed in this host. Print **once**:

> "→ Planner agent unavailable in this host — running approval gates inline. (No action needed; this is automatic.)"

Then execute, in order, using your own `EnterPlanMode` + `AskUserQuestion`:

1. Read `<working_dir>/.tmp/approved-architecture.md`. If it is missing or malformed, return to the Architecture gate
  above and recover the artifact from recorded user acceptance, or run that
  gate inline when approval is absent. Do not invent approval or infer the
  data platform from missing artifacts. Only then perform the conditional
  foreground snapshot step and resume here; retain a valid existing approval
  without re-asking it.
2. Restore the approved native capabilities, connectors, and data-platform
   mode without re-presenting Gate 1:
   - In `connector-only`, write an explicit zero-table/no-Dataverse
     `## Data Model` section and no schema contract or data-model approval
     receipt.
   - In `required`, spawn `mobile-app:data-model-architect` directly via
     `Task`, passing `Approved native capabilities:` and
     `Approved connectors:` verbatim along with the foreground
     snapshot/evidence paths. Present its result as Gate 2 and require approval
     before screen planning.

  **MUST forward the approved architecture in the direct architect prompt.**
  Include the exact Gate 1-approved native capabilities and connectors. In
  `required`, pass `Dataverse planning mode: required` and forward
  `SNAPSHOT_PATH` and `ARCHITECT_EVIDENCE_PATH` verbatim. The full snapshot is
  validator input only; read only the compact evidence. Do not resolve the
  environment or run Dataverse discovery again. A
  `connector-only` run never dispatches this architect.

  **MUST forward `$DETECTED_PUBLISHER_PREFIX` from Step 1.7 in the architect prompt:** *"Publisher prefix (detected from env): `<DETECTED_PUBLISHER_PREFIX>` — use literally as `<prefix>_<entity>` in all logical names. If empty/NOT DETECTED, fall back to `cr` placeholder and surface a `DONE_WITH_CONCERNS` note that Dataverse will normalize at create time."* Without this, the architect defaults to `cr_` and the whole plan needs a post-hoc sweep when the real prefix is something else (e.g. `cr3e9`).

  In `required`, also require the direct architect to write and normalize
  `<working_dir>/.tmp/dataverse-schema-contract.json` per its agent contract.
  A draft Markdown section without that sidecar is not an executable Gate 2
  result.

  Before presenting Gate 2, run
  `validate-dataverse-planning-decisions.js --contract <contract> --snapshot <snapshot>`.
  Apply the native planner's Step 5 decision-validation handling: preserve the
  exact metadata signal on exit `3`, revise against the same compact evidence
  on exit `4`, and permit approval only on exit `0`. This check also applies to
  every direct revision and the fully-inline fallback; architecture approval
  never substitutes for data-model approval.

   **Why this works even though the planner just returned BLOCKED for tool surface:** the orchestrator (this skill, running in the user's slash-command session) always has the full tool surface — Task, EnterPlanMode, ExitPlanMode, AskUserQuestion, Read, Write, Bash. What's missing is the surface inside *nested* agent contexts (the `native-app-planner` agent runs in a sandbox without EnterPlanMode/AskUserQuestion, which is why its Step 0 preflight returned BLOCKED). The leaf agents `data-model-architect` and `screen-planner` only need Read/Write/Bash to draft markdown — they don't need EnterPlanMode/AskUserQuestion themselves. Spawn them; the orchestrator owns the gates.

3. **Prepare and approve screens in order.** Create the `native-app-plan.md` skeleton
   from the planner's Step 6 template, including the approved architecture,
   approved or not-applicable Data Model, an empty `## Screens`, and
   `## Approvals` containing only approvals actually received.
   For both screen dispatches, pass `plan_path: <working_dir>/native-app-plan.md`
   and the approved model, native capabilities, and connectors verbatim. Pass
   `skip_preview: true` for deferred or skipped design; graph generation never
   renders a preview. Keep any explicitly selected legacy preview policy for
   the specs phase separate from its canonical-plan write target.
   - Spawn `mobile-app:screen-planner` with `phase: graph` first. Present its
     navigation, screen map, and shared conventions as Gate 3 after its Step 5b
     completeness repair; wait for approval.
   - Embed the approved graph from `_screens_section.md` into `## Screens` in
     `native-app-plan.md` and record Gate 3 acceptance before proceeding.
   - Verify that the canonical plan contains the locked graph, then spawn
     `mobile-app:screen-planner` with `phase: specs`. It reads that plan and
     replaces only the phase-owned subsections using its Step 5 single-write
     contract, without rewriting the approved graph or graph scratch file.
   - On `NEEDS_CONTEXT: graph missing <thing>` from specs, leave the failed
     specs output uncommitted, mark the screen approvals pending, and rerun
     `phase: graph` with the missing items and approved context. Reopen Gate 3
     and require fresh user approval before merging the corrected graph and
     resuming specs. Do not retry specs against the same incomplete graph.
   - Present the expanded canonical plan as Gate 4. On rejection revise only
     specs using replacement, not append, unless the user changes the graph,
     which requires Gate 3 again.
   Print each phase and its ETA before dispatch. Design picking remains at
   Step 6.75 via `/design-system`; do not generate a default-design preview.
4. **Finalize the existing `native-app-plan.md`**, preserving the approved graph
  and current specs. Update `## Approvals` with each actual user acceptance
   and timestamp; do not rebuild it from `_screens_section.md`.

   **HARD RULES for the plan structure (mirror the planner agent's template at [`agents/native-app-planner.md`](${PLUGIN_ROOT}/agents/native-app-planner.md) Step 6):**
   - Top-level headings are EXACTLY: `## Overview`, `## App Requirements`, `## Data Model`, `## Native Capabilities`, `## Design Direction`, `## Connectors`, `## Screens`, `## Approvals`. Do NOT invent a `## Brief` super-section that nests the data model under it.
   - `## App Requirements` is the user's confirmed brief verbatim (the `<requirements_brief>` from Step 2), capped at ~80 lines. No expansion, no rewriting, no embedded preview of the data model.
   - Discovery failure notes (e.g. `az login` on the wrong tenant, 401 from `dataverse-request.js`, all entities classified Create) go to `<working_dir>/memory-bank.md` under `## Discovery Notes`, NOT into the plan. Keep at most a single one-line breadcrumb in `## Data Model` like `> Discovery skipped — see memory-bank.md.` if relevant.
   - Sample data notes, immutability plug-in notes, file-column setup notes, dispatch-block server rules go under a single `### Notes` subsection in `## Data Model`. Cap each at 2 sentences; link to `post-deployment-tasks.md` for longer write-ups instead of inlining.

5. **Record the same structured approval receipt as the planner path in
  `required` mode only.** At data-model acceptance, initialize
   `<working_dir>/.tmp/mobile-plan-status.json` with the exact normalized
   contract content/hash. After each later gate is accepted, update only that
  gate's approval record and the current plan hash; after Gate 4, record the
   final structured service dependencies and integrity hash. Follow
   `agents/native-app-planner.md` Step 6 exactly. Never call the operation
   manifest builder to create or restamp this receipt. A changed approved
   section invalidates its record until the existing inline gate approves it
   again.

  In `connector-only`, do not create `.tmp/mobile-plan-status.json` or any
  Dataverse schema/approval artifact.

If the orchestrator's OWN `Task` tool is unavailable (rare — would mean even
leaf agents cannot be spawned), fall further to fully-inline mode. Draft and
approve native capabilities, connectors, and data platform first. In
`required`, then draft the data model from `ARCHITECT_EVIDENCE_PATH`, using
`SNAPSHOT_PATH` only through deterministic validation. With no live OData probe,
write/normalize the same structured schema
contract required by `agents/data-model-architect.md`. In `connector-only`,
write an explicit zero-table/no-Dataverse `## Data Model` section and no
contract or Data Model gate. Then draft the screen graph + specs against
`shared/references/screen-templates.md`. This is the last-resort path —
functional but slower because the orchestrator does work the architects
normally perform.

**Hard rule:** never silently skip an applicable gate just because the planner
could not run. Connector-only intentionally skips the non-applicable Data Model
gate; every other section must be approved before mutation starts.

The architecture-only pass is the sole owner of the
`NEEDS_CONTEXT: dataverse-planning-mode:<required|connector-only>` signal.
During the completion pass, receiving that signal again is malformed and must
be treated as `BLOCKED`.

#### 3.0 — Sub-agent return-status switch (canonical)

**Architecture-gate result (handle before generic retries).** Only a planner
dispatched with `Architecture phase: gate-only` may return exactly
`NEEDS_CONTEXT: dataverse-planning-mode:required` or
`NEEDS_CONTEXT: dataverse-planning-mode:connector-only` as success. Read
`.tmp/approved-architecture.md`: its mode must match the returned value, it
must contain the exact approved Native Capabilities and Connectors sections,
the data-platform choice, and a user-approval timestamp. A missing or malformed
artifact returns to the Architecture gate recovery path, not to metadata
discovery. On success, restore those inputs, set `<dataverse_planning_mode>`,
and continue to deferred publisher/snapshot work only for `required`. This
does not consume the generic retry budget and must not re-present Gate 1.
In `complete` phase or from any other agent, that signal is malformed; do not
let it change an already approved data platform.

**Screen-graph recovery (handle before generic retries).** A `screen-planner`
dispatched with `phase: specs` may return `NEEDS_CONTEXT: graph missing <thing>`.
Follow the graph-repair and Gate 3 approval loop in Step 3.0a above (or the same
loop inside `native-app-planner`). Preserve other approved sections, invalidate
the affected screen approvals, and require fresh user acceptance before specs
resume. This does not authorize a specs pass to modify the approved graph.

For all other first lines, use the plugin-wide protocol in
[`AGENTS.md`](${PLUGIN_ROOT}/AGENTS.md) rule #12 for every `Task` return.
`DONE` continues after output validation; `DONE_WITH_CONCERNS:` surfaces and
queues concerns for the memory bank; `NEEDS_CONTEXT:` re-dispatches with missing
non-Dataverse context, capped at 2 retries; `BLOCKED:` reports the blocker. Unknown first
lines are malformed. Recoverable artifact/input failures return to their
owning phase for repair; they never authorize skipping an applicable gate.

#### Dataverse planning recovery

**Shared step:** read [`dataverse-planning-recovery.md`](dataverse-planning-recovery.md) and follow it in full.

#### Step 3.0a — Industry confirmation handoff (orchestrator-owned)

When the planner is uncertain about which industry the app belongs to (no keyword match, ambiguous match, or wizard-aesthetic conflict), it returns early with this single line as its message:

```
INDUSTRY_CONFIRM_REQUESTED: <inferred-industry>|<reason-code>|<top-3-alternatives-comma-sep>
```

Example: `INDUSTRY_CONFIRM_REQUESTED: productivity|no-keywords|field-ops,healthcare,e-commerce`

This fires during the completion pass before screen planning — it's not a gate, just a confidence check so the wrong industry doesn't silently lock in the design language for the entire app.

**Skip this section if `<design_vibe_opt_in>` is `yes`, `done`, `deferred`, or
`skip`**. The normal create flow uses `deferred`, so `/design-system` owns the
user-facing design decision without another planning question.

**When you see `INDUSTRY_CONFIRM_REQUESTED:` and `<design_vibe_opt_in>` is `no`:**

1. Parse the three pipe-delimited fields. Map reason codes to a short user-facing explanation:
   - `no-keywords` → "no clear industry signal in your description"
   - `ambiguous-match` → "your description matches multiple industries"
   - `wizard-conflict` → "your aesthetic answer doesn't match the inferred industry"

2. Map each industry slug to a one-line description for the picker (use these exactly):

   | Slug | Description |
   |---|---|
   | `field-ops` | Field/Ops — high contrast, large targets, camera-forward (Uber Driver, ServiceTitan) |
   | `finance` | Finance — blue palette, conservative type, generous whitespace (banking apps) |
   | `healthcare` | Healthcare — warm palette, friendly type, compassionate copy (patient apps) |
   | `education` | Education — bright playful, gamification, streak/progress (Duolingo) |
   | `productivity` | Productivity — near-monochrome, dense layout, monospace data (Linear, Notion) |
   | `e-commerce` | E-commerce — brand-forward color, product imagery, frictionless CTAs (retail apps) |
   | `tech-iot` | Tech/IoT — dark + accent gradients, data-dense cards, real-time indicators (monitoring dashboards) |

3. Ask one `AskUserQuestion`:

   > "Quick sanity check before I build the design: I inferred this is a **<inferred-industry-description>** app, but <reason-explanation>. Confirm or pick another:
   >
   > **(a) <inferred-industry-description>** — recommended
   > **(b) <alt-1-description>**
   > **(c) <alt-2-description>**
   > **(d) <alt-3-description>**
   > **(e) Other / let me describe** — free text
   >
   > Which? (a / b / c / d / e — default: a)"

4. Persist the answer:

   ```bash
   echo "<chosen-industry-slug>" > '<working_dir>/.industry-confirmed'
   ```

   For option (e), let the user free-text a description; map it to the closest slug (or `productivity` as final fallback) and store that.

5. **Re-spawn the planner.** Use the same prompt as Step 3, plus an extra line:

   ```
   Industry confirmed: <chosen-industry-slug>
   ```

   The planner will see this on re-spawn, skip its detection + confidence check, and lock the industry to your value. After the re-spawn, re-check the planner's return value — it may now return normally, or it may still return `DESIGN_VIBE_REQUESTED:` (handled in Step 3a) if the user opted into the vibe picker.

#### Step 3a — Style-picker handoff (no-op in current plugin layout)

`/design-system` ships with this plugin and always runs at Step 6.75, so the style-picker handoff at Gate 4 is a no-op. Behavior:

- The planner writes a placeholder `## Design Direction: <deferred — set by /design-system>` block into `native-app-plan.md` at Gate 4 and proceeds without asking the user. Step 6.75 rewrites the placeholder with the real direction.
- If a legacy planner output emits `DESIGN_VIBE_REQUESTED:` as its first line, write the placeholder block yourself (insert before `## Design`, or before `## Screens` if `## Design` is absent), then re-spawn the planner with `Design vibe opt-in: done`. Do NOT run a vibe picker here — Step 6.75 owns that.
- If `--no-design` is in `$ARGUMENTS`, write the placeholder block, mark `<design_vibe_opt_in> = skip`, and Step 6.75 also no-ops. Screen-builders fall back to industry-inferred defaults from `universal-patterns.md`.

If the planner's first return is anything other than `DESIGN_VIBE_REQUESTED:` — i.e. it ran all gates including Gate 4 normally — skip directly to Step 3b.

#### Step 3b — Structural review and legacy preview output

Gate 4 remains markdown-only in this create flow, including reject/re-plan loops.
For deferred or skipped design, screen-planner receives `skip_preview: true`, so
no `PLAN_PREVIEW_PATH:` token is expected. Its absence is not an error, and
`<visual_companion> = yes` does not request an earlier preview.

If a legacy planner emits `PLAN_PREVIEW_PATH: file://<abs-path>/_plan_preview.html`,
ignore that early preview output. Do not open it or request a replacement HTML
preview at Gate 4. Step 6.75 produces the fresh preview after the design choice,
using locked brand tokens or the design-system Skip path's defaults, and honors
the persisted Visual Companion preference for automatic browser opening.

After the structural review, print:

> "Gate 4 reviewed structurally. Visual preview is deferred to Step 6.75."

With `--no-design`, Step 6.75 and its HTML preview are both skipped. Print instead:

> "Gate 4 reviewed structurally. HTML preview skipped (--no-design)."

#### 3.9 — Post-plan publisher-prefix gate

**Shared step:** read [`post-plan-publisher-prefix.md`](post-plan-publisher-prefix.md) and follow it in full.

### Step 3.9 — Confirm the approved plan

Each gated section was written `proposed` before its gate and flipped to `approved` when the user
answered it (the gate table under the Architecture gate). Restate them here, before any mutation
starts, so a call missed at a gate cannot leave a proposal on record and an abort still leaves a
document explaining what was agreed:

```bash
DOCS="${PLUGIN_ROOT}/scripts/app-docs.js"
node "$DOCS" --working-dir '<working_dir>' set --section architecture --json-file <tmp>/architecture.json --state approved
node "$DOCS" --working-dir '<working_dir>' step --id architecture --status done --note "Gate 1 — approved"
node "$DOCS" --working-dir '<working_dir>' set --section trust --json-file <tmp>/trust.json --state proposed
node "$DOCS" --working-dir '<working_dir>' set --section dataModel --json-file <tmp>/data-model.json --state approved
node "$DOCS" --working-dir '<working_dir>' step --id data-model --status done --note "Gate 2 — <n> tables approved"
node "$DOCS" --working-dir '<working_dir>' set --section screens --json-file <tmp>/screens.json --state approved
node "$DOCS" --working-dir '<working_dir>' step --id screen-plan --status done --note "Gates 3-4 — <n> screens approved"
```

**Write a first-pass trust report here.** Gate 1 settles the device capabilities and connectors,
which is everything the `permissions[]` and `battery[]` lists are derived from, so the Trust report
tab fills as soon as the user approves rather than staying empty for most of the run. Mark it
`proposed`: it states what the approved plan intends, and Step 10 rewrites it as `approved` once
the capabilities are actually wired. Leave `handles[]` and `notCollected[]` out for now — those
depend on the data model and offline profile, which are not settled yet.

Build each JSON from the approved `native-app-plan.md` using the shapes in the
[Build documentation protocol](#build-documentation-protocol). Populate `dataModel.tables[]`
structurally — `logicalName`, `status`, `columns[]` with `key: PK|FK`, `relationships[]` — because
the ER diagram, the column tables, and the new/reused/extended colours are all derived from it.

**Connector-only apps:** mark both Dataverse phases as not applicable rather than leaving them
pending, or the plan never reaches 100%:

```bash
node "$DOCS" --working-dir '<working_dir>' step --id data-model --status skipped
node "$DOCS" --working-dir '<working_dir>' step --id dataverse --status skipped
```

### Step 4 — Auth & environment selection

**Telemetry checkpoint: `select_app_environment`**

```bash
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$ACTIVE_ENV_ID"
```

If the resolved environment doesn't match what the planner used in Step 3, ask the user for the intended environment ID and re-run `resolve-environment.js`. Capture the **environment ID** for Step 6.

### Step 5 — Prepare existing template

**Telemetry checkpoint: `prepare_template_files`**

Open the scaffold phase:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id scaffold --status active
```

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

If already-created markers appear (`memory-bank.md`, `.datamodel-manifest.json`, or `src/generated/services/*.ts`) and Step 0 did not enter the resume path, STOP. `native-app-plan.md` is expected here because Step 3 writes the approved plan before template preparation:
> "This folder already looks like a created app. For a new app, materialize a fresh `expo-app-standalone` template with `degit` into a new folder and rerun this skill there."

Run the deterministic preparation script once:

```bash
PREPARE_SCRIPT="${PLUGIN_ROOT}/scripts/prepare-mobile-template.js"
node - "$PREPARE_SCRIPT" <<'NODE'
const { prepareMobileTemplate } = require(process.argv[2]);

// Replace these placeholders with JSON.stringify(...) output so user-provided
// quotes and dollar signs remain data rather than becoming shell syntax.
const result = prepareMobileTemplate({
  workingDir: <JSON_STRING_OF_WORKING_DIR>,
  displayName: <JSON_STRING_OF_DISPLAY_NAME>,
  slug: <JSON_STRING_OF_SLUG>,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
NODE
```

Capture `result.writtenFiles` as the exact project-relative preparation validation targets.
This list contains only files created or changed by this preparation call, excluding unchanged
preserved files and deletions. Keep `removedPowerConfig` and `removedLegacyFiles` as removal
outcomes, not `--file` targets: Step 6 can recreate the same config path with a different owner.
Union targets across any preparation reruns rather than replacing earlier pending changes.
Do not rebuild this list from `git status` or a directory scan after initialization.

The script is the only owner of Step 5 mutations. It updates identity, removes
only recognized legacy example hooks/query-client files, copies shared helpers
only when missing, verifies that TypeScript inherits the host configuration,
and structurally verifies the root provider/theme/safe-area contract. It
preserves custom navigation, existing helper bytes, `offlineProfile`, provider
props, and the template's `@ts-ignore` generation boundaries.

Preparation also copies missing app-local guidance from `template/AGENTS.md`,
`template/CLAUDE.md`, and `template/.github/copilot-instructions.md`. Existing
customer guidance is preserved byte-for-byte; no symlinked destination is
followed. `copiedGuidanceFiles` and `preservedGuidanceFiles` describe the result,
and only actual copies appear in `writtenFiles`. Do not overwrite a preserved
file just to make the default skill routing appear.

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

**Fix 1b — Verify template-owned development lifecycle scripts**

Manual `npm run dev` remains the development entry point, and npm invokes `predev` before it. The template owns the command bodies for both lifecycle scripts and may change them as the native host evolves. Verify only that both entries exist as non-empty strings; do not compare, rewrite, or otherwise enforce their command bodies.

The template's `metro.config.js` delegates to `createPowerAppsMetroConfig` from `@microsoft/power-apps-native-host/config/metroConfig`; that factory installs sanitized Metro terminal and HTTP bundle-failure logging under `.powernative/metro-logs/`. Manual starts and `/debug-app` use the same log source without a process-owning wrapper.

```bash
node - '<working_dir>' <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const packagePath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
for (const scriptName of ['dev', 'predev']) {
  if (typeof pkg.scripts?.[scriptName] !== 'string' || pkg.scripts[scriptName].trim() === '') {
    throw new Error(`Expected package.json scripts.${scriptName} to be a non-empty command.`);
  }
}
NODE
```

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

`app/_layout.tsx` imports `schemaMap` from `src/generated/connectorSchemas.ts`, which
is generated by the template's `npm run generate-schemas` script. This builds the
runtime schema map; Power Apps CLI add/refresh/remove commands own source
registrations and generated models/services. Do not generate an empty schema map
during initial scaffold: the template's `@ts-ignore` boundary lets `tsc` validate
the scaffold without that artifact, and schema generation is more useful after a
data source exists or immediately before dev/build entry points.

Do NOT hand-write a stub `connectorSchemas.ts` — the generated output has a specific shape that downstream code depends on; a placeholder will break `pa app push`.

**Why `tsc` already passes post-clone (current template, PR #30):** the template's `app/_layout.tsx` and `src/playerConfig.ts` carry `// @ts-ignore` comments above the `power.config.json` and `connectorSchemas` imports specifically so the project type-checks before `power.config.json` and `connectorSchemas.ts` exist. **Never strip these `@ts-ignore` lines** — Fix 8 below preserves them when patching `app/_layout.tsx` to thread the project's `tamaguiConfig` into `PowerAppsProvider`, and any future `Edit` to either file MUST keep them. Removing them resurfaces a `tsc` failure against missing generated files.

**Fix 7 — Seed shared code only when missing**

The preparation script creates the shared source directories and copies each
approved sample helper only when its destination does not exist. Existing
helpers are byte-for-byte preserved, so reruns cannot overwrite user or
builder changes.

**Fix 8 — Thread the project's `tamaguiConfig` and active theme into the host provider**

The template ships `PowerAppsProvider` with host-owned light and dark theme
defaults. Fix 8 ensures the project `tamaguiConfig` and color-scheme-driven
`defaultTheme` are present. It preserves explicit `theme` and `darkTheme`
overrides when an app already has them, but does not add redundant overrides
to a fresh template. Step 9b adds explicit themes only when applying generated
brand tokens. Do NOT add an outer `<TamaguiProvider>` — `PowerAppsProvider`
composes it internally and duplicating triggers "useTheme must be used within
a TamaguiProvider" warnings on hot reload.

The preparation script edits the existing root layout structurally. It adds
missing imports and provider props, then wraps `PowerAppsProvider` with
`SafeAreaProvider` only when needed. It does not replace the file and it does
not wrap `<Slot />` with `SafeAreaView`; each rendered route owns its content
edges to avoid double insets.

Key points:
- **Do NOT remove the two `// @ts-ignore` lines.** They keep `tsc` green pre-`pa app init`.
- **Do NOT add an outer `<TamaguiProvider>`** — `PowerAppsProvider` composes it internally.
- **`SafeAreaProvider` wraps the tree** so child screens can call `useSafeAreaInsets()` without a context error. Each route must use `SafeAreaView` or explicit insets for its own visible edges.
- `tamaguiConfig` is imported from `'../tamagui.config'` (the `default export` of `tamagui.config.ts` at project root).
- Import `app.json` and pass it through the `appConfig` prop. `PowerAppsProvider` reads `expo.extra.appInsightsConfig` and enforces its `enabled` opt-in; this explicit app-config boundary is required because the fixed Dev Player does not expose the loaded app's extras through `Constants.expoConfig`. Never print the connection string, copy it to `memory-bank.md`, or include it in a summary.
- `defaultTheme` flips between light/dark via `useColorScheme()`. `/design-system --add-dark-mode` later wires per-token dark variants.

**Fix 4 — Shared TypeScript configuration**

The current template extends
`@microsoft/power-apps-native-host/config/tsconfig`. That host configuration
owns the runtime package paths and the six shared-code aliases:
`@/components`, `@/hooks`, `@/utils`, `@/tokens`, `@/generated`, and
`@/native`. The preparation script verifies this inheritance and does not
create a second template-local alias map. Expo Metro consumes the resulting
effective TypeScript paths, so no Babel alias plug-in is required.

`<Gradient>` (used by `components/index.tsx`) requires `expo-linear-gradient`. **Assume the upstream template ships it** — do NOT edit `package.json` to add it. If `npm install` (Step 6.5) later reveals the dep is missing, STOP and ask the user to wait for the next template release; do not work around by adding the dep here (same lockdown rule as `/add-native`).

Do not run `npm install` inside Step 5 — in template-only mode dependencies must already be installed before the skill starts.

> **Install note (current template):** The template does not read `power.config.json` during `npm install`. The Step 6 → Step 6.5 ordering is kept for predictable checkpoints, but do not run `npm run generate-schemas` during initial scaffold.

### Step 6 — Initialize

**Telemetry checkpoint: `initialize_power_apps_project`**

**Print before starting:**
> "→ [Step 6/13] Running `pa app init -t MobileApp` to write power.config.json for environment <env-id>. ~15–30 seconds."

```bash
cd <working_dir>
$PA app init -t MobileApp --display-name "<displayName>" --environment-id "<environment-id>" --non-interactive
```

Substitute the approved Step 2 display name and Step 4 environment ID using
shell-safe quoting; do not ask for either value again. Step 5 must leave
`power.config.json` absent. If a populated file remains, STOP and report its
environment instead of overwriting it or running `init` again.

Verify `power.config.json` exists and both its `environmentId` and
`appDisplayName` match the approved Step 2/Step 4 values. If initialization
fails, report the exact error and STOP.
Record the successful CLI command as the config's writer. These checks are read-only;
do not add this CLI-generated file to Step 5's manual validation targets or hand-edit it.

### Step 6.5 — Verify dependencies

This step verifies dependencies only. The user must have run `npm install` before invoking the skill.

```bash
[ -d '<working_dir>/node_modules/expo' ] && echo "✓ node_modules present" || echo "✗ missing — run npm install in the template folder and rerun"
```

If `node_modules/expo` is missing, STOP. Tell the user to run `npm install` in the template folder. Do not provision ADO tokens or run `npm install` from this skill.

### Step 6.5b — Root runtime contract verification

Step 5 already performs the idempotent structural update and postcondition
checks. Do not mutate `_layout.tsx` again here. Verify only that the prepared
layout still contains `SafeAreaProvider`, `tamaguiConfig`, `offlineProfile`,
and the color-scheme-driven `defaultTheme`. If brand-token wiring has already
run, also verify its explicit `theme` and `darkTheme` props. If any applicable
contract element is missing, rerun the Step 5 preparation script and stop if
it reports an unsupported layout.

### Step 6.6 — Scaffold TypeScript gate

**Telemetry checkpoint: `validate_scaffold_typescript`**

**Print before starting:**
> "→ [Step 6.6/13] Running scaffold tsc smoke check (~10–30 seconds)."

With `node_modules/` populated, run the scaffold TypeScript gate. Do **not** run `npm run generate-schemas` here just to produce an empty `connectorSchemas.ts`; the template is intentionally type-checkable before that file exists, and the script is already run after data-source changes and again before Step 12 starts the dev server.

```bash
npx --no-install tsc --noEmit
```

`tsc` must pass here. If it doesn't, the post-clone surgery in Step 5 (Fixes 1–7) is incomplete — do not proceed to data sources or screen builders. Re-read the Step 5 fixes against the current working dir contents and reapply any missed edit.

This is the **Scaffold gate** from the TypeScript Gate Policy. If it fails, capture the full error list once, batch-fix scaffold/template causes, and rerun this gate. Do not continue to Step 6.7 or any app-specific mutation until this gate is clean. If the only failure is a missing generated schema import, preserve the template `@ts-ignore` boundary rather than generating an empty schema artifact.

A clean scaffold gate is what completes the scaffold phase:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id scaffold --status done
```

### Step 6.7 — Seed the memory bank

```bash
cp "${PLUGIN_ROOT}/shared/memory-bank.md" '<working_dir>/memory-bank.md'
```

Fill in the Project facts and Power Platform context sections from Steps 2 and 4. From here on, every step appends to the relevant section of `<working_dir>/memory-bank.md` immediately after success — not at the end. This is what enables Step 0's resume on a future run.

Before leaving this step, run the shared changed-file gate on Step 5's `writtenFiles`, `memory-bank.md`,
and any other pending skill/subagent-authored files or scaffold repairs, using an exact `--file`
argument for each. Exclude files verified as CLI-generated and not manually modified afterward;
`power.config.json` is covered by the read-only identity checks in Step 6, not this write gate.
The successful TypeScript check does not replace either validation.

Immediately after creating `memory-bank.md`, flush any queued planner concerns from `DEFERRED_CONCERNS[]` into `## Concerns` (append-only). This flush is unconditional: if the queue is non-empty, write it now before continuing to Step 6.75.

**Also persist the Visual Companion preference** so re-runs (`/edit-app`, `/preview-screens`, future `/design-system` runs) honor it without re-asking. Append to the Project facts section:

```
visual_companion: <yes|no>   # default from Step 2b; applied at Step 6.75 and later previews
```

`/preview-screens` reads this flag when invoked from inside this project; if `no`, it prints the file path instead of opening. `/edit-app` reads it to decide whether to re-open `_plan_preview.html` after a re-plan. The flag is per-project and does not leak across apps.

### Step 6.75 — Design system

**Print before starting:**
> "→ [Step 6.75/13] Locking your design system — source of truth for every screen built next. Takes 5 sec to 3 min depending on path."

**Skip this step if `--no-design` is in `$ARGUMENTS`** — record it as skipped rather than leaving
it open, because this branch never reaches the `done` call below:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id design --status skipped
```

Marking it `active` here instead would leave it active through auth and most of Step 8, until
opening the next phase auto-closed it as `done` — reporting a design system that was never built.

**On the skip branch** — placeholder `## Design Direction: <deferred>` block stays in the plan, screen-builders fall back to industry-inferred defaults from `universal-patterns.md`.

**Otherwise**, open the phase and invoke `/design-system` (ships with this plugin). `/design-system`
asks for brand inputs, a cost choice and a style pick, so the phase opens as waiting:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id design --status active --note "Waiting for your brand and design choices"
```

```
Invoke skill: /design-system

Environment:
  CODE_APPS_NATIVE_ORCHESTRATING=1

Context:
  MOBILE_APP_ORCHESTRATING=1
  orchestrator: create-mobile-app
  working_dir: <working_dir>
  phase: design
  approved_scope: <confirmed app intent; design-system owns its design approval>

Arguments:
  --working-dir '<working_dir>'
```

The `Environment` block is load-bearing, and follows the nested-skill handoff `/edit-app` already
uses. `/design-system` and its style picker gate every browser opener on that variable; without it
they detect a standalone run and open tabs over the build plan.

The scoped `MOBILE_APP_ORCHESTRATING=1` context identifies the owner and approval
boundary; `CODE_APPS_NATIVE_ORCHESTRATING=1` separately suppresses nested browser
openers. The skill collects brand inputs, presents the cost picker (a/b/c/d),
runs the internal style picker, writes approved brand artifacts, and returns
with status.

As soon as `/design-system` returns, replace the note — the user has answered and the run is
working again:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id design --status active --note "Applying your design system"
```

Handle the return per the status protocol (AGENTS.md rule #10):
- `DONE` → finish the applicable preview branch below, then continue to Step 7. Record `brand_path`, `tokens_path`, `direction` in memory-bank.
- `DONE_WITH_CONCERNS` → surface concerns, ask user, continue.
- `NEEDS_CONTEXT` → surface question, re-invoke with answer.
- `BLOCKED` → surface error, STOP.

If the user picked path (c) Skip in the cost picker, the skill returns immediately with `DONE` and no `brand/` files. Screen-builders fall back to `## Design Direction` — same as today's behavior. **But the user still needs a visual preview before code is written** — fall through to the "Skip path preview" block below.

**After `/design-system` returns `DONE` — two branches:**

#### Branch A — `brand/` files exist (user picked path a, b, or d)

`/design-system` owns rendering of `_plan_preview.html` at its Sub-step 6.5 using the locked brand tokens — no re-spawn from the orchestrator is needed, the file is fresh when the skill returns. Gate 4 was a structural-only review (markdown screen-graph, no HTML), so this is where screens first become visual. The user sees them in the build plan's phone carousel, and the rendered file is linked underneath it. Nothing opens a browser window: `/create-mobile-app` sets `CODE_APPS_NATIVE_ORCHESTRATING=1`, and every opener in `/design-system` and its style picker is gated on that, so the plan stays the single surface the user is watching.

#### Branch B — Skip path preview (user picked path c — no `brand/` files)

The user skipped the design system but still deserves to see their screens before code is written. Render a preview with Field/Ops defaults:

1. **Print:**
   > "→ Design system skipped — rendering screen preview with Field/Ops defaults so you can validate the layout before code is written."

2. **Render `_plan_preview.html`** — read the screen specs from `native-app-plan.md` `## Screens` section and render key screens (one List + one Form + one Detail, first match per archetype) using the `tamagui-html-mapping.md` reference and industry-inferred defaults from `## Design Direction`. Write to `<working_dir>/_plan_preview.html`.

3. **Do not open it in a browser.** The build plan already shows these screens in its phone
   frame and links out to the full-size file underneath, so a second tab opening mid-run
   interrupts the user rather than telling them anything new. Print the path and continue:

   > `→ Full-size screens at <working_dir>/_plan_preview.html (also linked under the phone in the build plan).`

4. **Auto-continue — no prompt.** The user already approved the applicable planning gates; the preview does not introduce another approval gate. Print one line and proceed:

  > `→ Preview rendered with default styling. Continuing to Step 7. (Interrupt and re-run /design-system or /edit-app to revise.)`

**Preview timing:** For current and legacy planner output, Gate 4 remains markdown-only.
Step 6.75 is the only screen-preview stage in this create flow: Branch A uses locked
brand tokens; Branch B uses defaults. `visual_companion: no` disables automatic
browser opening, not rendering. `--no-design` skips this stage and its HTML preview.

Offline profile setup is intentionally deferred until after the approved
Dataverse model has been materialized. Follow the shared connectivity-intent
ownership contract during this phase.

**Switch the plan's phone to the screen carousel.**
`/design-system` has just rendered `_plan_preview.html`, with plan-time mockups built from the locked brand tokens before any TSX exists.
Pass that complete file to the carousel:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' phone --stage screens --preview-file '<working_dir>/_plan_preview.html'
```

The page extracts every `.screen` block in document order and takes its label from the matching `data-screen` tab.
It preserves shared styles, root tokens, and ancestor selectors inside a sandboxed 375 × 812 viewport, scaled to fit the phone.
The gallery's outer phone shell and controls stay outside the carousel.
Pass the file unchanged; copying only a screen's markup loses its stylesheet.
The legacy `--screens-file` JSON input remains supported for self-contained screen documents.

**Carry over exactly the screens `_plan_preview.html` contains - no more, no fewer.**
Option (a) at `/design-system` Sub-step 6.5 renders every screen; the default (b) renders only the List, Form and Detail archetypes.
A three-screen carousel is the expected shape, not a failure.

**When there is no preview to carry over, leave the phone on the building animation.** That is
`--no-design`, or Sub-step 6.5 option (c) "Skip preview" — in both cases `_plan_preview.html` was
never written, so there is nothing to show and nothing to invent. Skip the `phone --stage screens`
call entirely; the plan keeps animating until the Step 12 QR replaces it.

**This is the moment the plan stops being abstract** — the user sees real screens, in their real
brand, while the data model is still being built. Do not skip it because they are "only mockups":
they are the same mockups `/preview-screens` would produce, and they are the first concrete thing
in the whole run.

**Record the design** once `/design-system` returns, taking the palette from `brand/tokens.ts`.
Write `<tmp>/design.json` with the `Write` tool — the direction is free text the user chose, so it
goes to a file rather than through the shell:

```json
{"direction":"<direction>","headingFont":"<font>","bodyFont":"<font>","darkMode":"<enabled|disabled>","palette":[{"name":"Primary","value":"#rrggbb"}]}
```


```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' set --section design --json-file <tmp>/design.json
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id design --status done
```

Only `#rrggbb` literals render as swatches; any other value is shown as text rather than
becoming an arbitrary CSS value.

### Step 7 — Auth config

**Telemetry checkpoint: `configure_native_authentication`**

**Shared step:** read [`auth-config.md`](auth-config.md) and follow it in full.

### Step 8 — Apply data model

**Telemetry checkpoint: `apply_dataverse_data_model`**

**Shared step:** read [`apply-data-model.md`](apply-data-model.md) and follow it in full.

### Step 8.5 — Seed sample data (approved scope)

**Shared step:** read [`seed-sample-data.md`](seed-sample-data.md) and follow it in full.

### Offline profile (Dataverse-backed apps)

**Shared step:** read [`offline-profile.md`](offline-profile.md) and follow it in full.

### Step 9 — Apply native capabilities

**Telemetry checkpoint: `configure_native_capabilities`**

**Shared step:** read [`native-capabilities.md`](native-capabilities.md) and follow it in full.

### Step 9a — Install approved pure-JavaScript dependencies

**Telemetry checkpoint: `install_approved_javascript_dependencies`**

Read and execute the Installation Contract in [`shared/references/javascript-dependency-planning.md`](${PLUGIN_ROOT}/shared/references/javascript-dependency-planning.md) for every approved row in `## Screens → ### JavaScript Dependencies`. If the subsection is absent or says `None.`, continue without changing dependencies.

Gate 4 approval is consent for exactly the packages and versions in the table. Install them into `<working_dir>` before any skeleton or builder imports them, validate `package.json` and the lockfile, and verify module resolution. Do not substitute another package/version, infer a package from a compiler error, or route a JS-only package through `/add-native`. If final inspection finds native code/config or incompatible runtime dependencies, remove only the newly added package and STOP with the exact failed criterion.

### Step 9b — Apply design system

`/design-system` owns user-facing brand/design choices. The native-host
`createPowerAppsTamaguiConfig` factory owns the baseline semantic aliases,
contrast handling, animations, and font fallback. This step applies generated
brand tokens without copying that host logic into the app.

Read the `## Design` section from `native-app-plan.md` and follow the execution mapping in [`shared/references/design-planning.md`](${PLUGIN_ROOT}/shared/references/design-planning.md):

| Condition | Action |
|---|---|
| `brand/tokens.ts` exists | **Highest priority.** Apply [`../design-system/references/tamagui-integration.md`](../../design-system/references/tamagui-integration.md) in brand-import mode, export the resolved app light/dark themes, then wire matching `ThemeTokens` into `app/_layout.tsx`. |
| `## Design` says `required` | Apply the same reference using the approved `## Design` section. Builds custom token system + aliases. |
| `## Design` says `add-aliases` | Verify `tamagui.config.ts` uses `createPowerAppsTamaguiConfig`; the host already provides the semantic aliases. |
| Custom font only | `npx --no-install expo install expo-font` + `useFonts()` in `_layout.tsx`; preserve the host config factory. |

**No unchecked path.** Screen-builders require `$surface0`–`$surface3` and
`$accent*` aliases. On the default path, verify the host factory rather than
rewriting the config. Pass the complete `## Design` section verbatim — not a
summary. Re-run `npx --no-install tsc --noEmit` after Tamagui config changes.

**Brand-token wiring** — when `brand/tokens.ts` exists, the Tamagui integration
exports `appLightTheme` and `appDarkTheme`. Map those resolved semantic values
into the host themes so `useTheme()` and `useThemeTokens()` cannot drift:

If the approved design includes a custom dark palette, apply the reference's
**Approved dark palette** branch first: import `darkTokens` from
`brand/tokens.dark.ts` in `tamagui.config.ts` and derive `appDarkTheme` from
`darkTokens.color`. The provider mapping below then consumes that resolved theme;
do not leave the base accent-only dark declaration in place.

```tsx
import {
  PowerAppsProvider,
  lightTheme as hostLightTheme,
  darkTheme as hostDarkTheme,
} from '@microsoft/power-apps-native-host';
import type { ThemeTokens } from '@microsoft/power-apps-native-host';
import tamaguiConfig, {
  appDarkTheme,
  appLightTheme,
} from '../tamagui.config';

const brandedLightTheme: ThemeTokens = {
  ...hostLightTheme,
  surface0: appLightTheme.surface0,
  surface1: appLightTheme.surface1,
  surface2: appLightTheme.surface2,
  surface3: appLightTheme.surface3,
  surface4: appLightTheme.color6,
  text0: appLightTheme.text0,
  text1: appLightTheme.text1,
  text2: appLightTheme.text2,
  text3: appLightTheme.text3,
  accentDeep: appLightTheme.accentDeep,
  accentBase: appLightTheme.accentBase,
  accentSoft: appLightTheme.accentSoft,
  accentOnAccent: appLightTheme.accentOnAccent,
};
const brandedDarkTheme: ThemeTokens = {
  ...hostDarkTheme,
  surface0: appDarkTheme.surface0,
  surface1: appDarkTheme.surface1,
  surface2: appDarkTheme.surface2,
  surface3: appDarkTheme.surface3,
  surface4: appDarkTheme.color6,
  text0: appDarkTheme.text0,
  text1: appDarkTheme.text1,
  text2: appDarkTheme.text2,
  text3: appDarkTheme.text3,
  accentDeep: appDarkTheme.accentDeep,
  accentBase: appDarkTheme.accentBase,
  accentSoft: appDarkTheme.accentSoft,
  accentOnAccent: appDarkTheme.accentOnAccent,
};

// In RootLayout:
<PowerAppsProvider ... theme={brandedLightTheme} darkTheme={brandedDarkTheme}>
```

Without an approved custom dark palette, the exported dark app theme retains
Config v5 dark surfaces and text while carrying brand accents and statuses.
With an approved custom dark palette, `appDarkTheme` instead resolves the full
`darkTokens.color` palette, including its surfaces and text, and the provider
mapping above uses that same resolved theme. For runtime theme switching, use `useThemeControl()` from
`@microsoft/power-apps-native-host`.

### Step 10 — Add connectors

**Telemetry checkpoint: `generate_connector_data_sources`**

**Shared step:** read [`connectors.md`](connectors.md) and follow it in full.

### Step 10b — Wire navigation layout

**Telemetry checkpoint: `wire_app_navigation`**

Open the screens phase here rather than at the first screen wave. Navigation, shared code and the
first wave are most of what is left of the run, and the plan should say what is being built:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id screens --status active
```

Read `## Screens → Navigation Pattern` from `native-app-plan.md`.

- **Stack** — skip. `app/(app)/_layout.tsx` already renders `<Stack>`. Nothing to do.
- **Tabs** or **Tabs + Stack** — write outer `<Tabs>` in `app/(app)/_layout.tsx` AND a per-folder inner `<Stack>` in each `app/(app)/<folder>/_layout.tsx`.
- **Drawer** — write outer `<Drawer>` in `app/(app)/_layout.tsx` AND a per-folder inner `<Stack>` in each `app/(app)/<folder>/_layout.tsx`.

> **⚠️ The phantom-tab fix lives here.** expo-router auto-registers every top-level `.tsx` file under `app/(app)/` as a tab/drawer entry. Step 10b prevents phantom entries by walking the **File** column in the Screen Map (not the Screen names): each unique top-level entry under `app/(app)/` — file OR folder — becomes ONE tab/drawer entry. Folders contain detail/modal screens *inside* their own stack, so they never leak as siblings.

#### Step 10b.1 — Compute the layout structure from the Screen Map

Read the Screen Map's **File** column. For every row whose File starts with `app/(app)/`, classify each path into one of three groups:

| Path shape | Classification | Example |
|---|---|---|
| `app/(app)/<name>.tsx` (no subfolder) | **Top-level flat file** — one outer entry, no inner layout | `app/(app)/home.tsx` |
| `app/(app)/<folder>/index.tsx` | **Folder root** — one outer entry, needs inner `_layout.tsx` | `app/(app)/inspections/index.tsx` |
| `app/(app)/<folder>/<child>.tsx` (any other file inside a folder) | **Folder child** — pushed into the folder's stack, NOT an outer entry | `app/(app)/inspections/[id].tsx` |

Build two lists from the classification:

1. **Outer entries** = unique `<name>` from the top-level flat files + unique `<folder>` from the folder roots. These get one `<Tabs.Screen>` or `<Drawer.Screen>` each in the outer layout.
2. **Inner stacks** = one entry per unique `<folder>`. For each folder, list its children (root + non-root files), with each child's `Presentation` value from the Screen Map.

**Sanity check before writing anything:** if any folder has children but no `index.tsx` row in the Screen Map, STOP and report: `BLOCKED: folder app/(app)/<folder>/ has children (<list>) but no index.tsx row in the Screen Map. The screen-planner must emit an index.tsx row for every folder.` This catches a planner mistake that would render the folder unreachable from the outer tab.

Normalize every Screen Map file to its Expo route (strip `.tsx`, collapse trailing `/index`, preserve dynamic segments). If two files normalize to the same route, STOP before writing layouts. In particular, reject `<parent>/[id].tsx` together with `<parent>/[id]/<child>.tsx`; move the detail contract to `<parent>/[id]/index.tsx`.

```text
BLOCKED: duplicate Expo route <route> from <file-a> and <file-b>. Use [id]/index.tsx when a dynamic detail route owns child screens.
```

#### Step 10b.2 — Write per-folder inner `_layout.tsx` files (if any folders exist)

For each entry in the Inner stacks list, create the folder if missing and write `app/(app)/<folder>/_layout.tsx` with this template:

```tsx
import { Stack } from 'expo-router';

export default function <FolderName>Layout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      {/* one <Stack.Screen> per non-index child, with presentation from Screen Map */}
      <Stack.Screen name="<child-without-tsx>" options={{ presentation: '<Presentation>' }} />
    </Stack>
  );
}
```

Rules:
- `headerShown: false` at the Stack level — each screen sets its own header inline via `<Stack.Screen options={{...}}>` at the top of its component (the Expo Router idiom).
- `<Stack.Screen name="index" />` is required — without it, the folder root won't render.
- `presentation: 'modal'` and `presentation: 'formSheet'` come from the Screen Map's Presentation column. Skip the `options` prop entirely for `default` presentation.
- `name` for `[id].tsx` is literally `[id]` (with brackets). When `[id]` owns child routes, create `<folder>/[id]/_layout.tsx` with `<Stack.Screen name="index" />` and child entries; do not register both `[id].tsx` and a `[id]/` folder.
- Folder name in the function name is PascalCase (e.g. `InspectionsLayout`).

**Why this must run BEFORE Step 11:** screen-builders write their files in parallel, multiple builders may target the same folder, and any of them creating `_layout.tsx` would race. The orchestrator owns these files.

#### Step 10b.3 — Write outer `app/(app)/_layout.tsx`

Now rewrite only the `return` statement in `app/(app)/_layout.tsx`. Keep every line above the `return` untouched (auth guard, all imports).

**How to build the `<Tabs>` block (Tabs / Tabs + Stack pattern):**

For each entry in the Outer entries list, emit one `<Tabs.Screen>`. The `name` is the file/folder name without `.tsx`:

For each tab, infer a Ionicons icon name from the screen name:

| Screen name contains | Icon |
|---|---|
| home, dashboard, overview | `home-outline` |
| inspect, audit, checklist, task | `clipboard-outline` |
| profile, account, me, user | `person-outline` |
| settings, config, preferences | `settings-outline` |
| report, analytics, chart, stats | `bar-chart-outline` |
| map, location, sites, field | `map-outline` |
| message, chat, inbox, notify | `chatbubble-outline` |
| anything else | `apps-outline` |

**The Edit to apply:**

Add `import { Tabs } from 'expo-router';`, `import { Ionicons } from '@expo/vector-icons';`, and `import { useThemeTokens } from '@microsoft/power-apps-native-host';` to the import block if not already present. Inside `AppLayout`, after the auth state is read, add `const theme = useThemeTokens();`. Then replace:

```tsx
return (
  <Stack
    screenOptions={{
      headerShown: false,
    }}
  />
);
```

with:

```tsx
return (
  <Tabs
    screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: theme.accentBase,
      tabBarInactiveTintColor: theme.text2,
    }}
  >
    <Tabs.Screen
      name="<screen-file-name>"
      options={{
        title: '<Screen Title>',
        tabBarIcon: ({ color }) => <Ionicons name="<icon>" size={22} color={color} />,
      }}
    />
    {/* one Tabs.Screen per top-level tab */}
  </Tabs>
);
```

Run `npx --no-install tsc --noEmit` after the edit. If it fails, check that the `Tabs.Screen name` values exactly match the file names under `app/(app)/` (without `.tsx`).

**How to build the `<Drawer>` block (Drawer pattern only):**

Same Outer-entries computation as Tabs — one entry per top-level flat file or folder root from Step 10b.1. Detail, modal, and nested routes are inside their folder's inner stack, not drawer items.

Use the same icon mapping table as Tabs (above).

**The Edit to apply:**

Add `import { Drawer } from 'expo-router/drawer';`, `import { Ionicons } from '@expo/vector-icons';`, and `import { useThemeTokens } from '@microsoft/power-apps-native-host';` to the import block if not already present. Inside `AppLayout`, after the auth state is read, add `const theme = useThemeTokens();`. Then replace the existing `<Stack>` return with:

```tsx
return (
  <Drawer
    screenOptions={{
      headerShown: true,
      drawerType: 'front',
      drawerActiveTintColor: theme.accentBase,
      drawerInactiveTintColor: theme.text2,
      drawerStyle: { width: 280 },
    }}
  >
    <Drawer.Screen
      name="<screen-file-name>"
      options={{
        title: '<Screen Title>',
        drawerIcon: ({ color }) => <Ionicons name="<icon>" size={22} color={color} />,
      }}
    />
    {/* one Drawer.Screen per top-level destination */}
  </Drawer>
);
```

**Key differences from Tabs:**
- Import is `from 'expo-router/drawer'` (not `from 'expo-router'`)
- `headerShown: true` — drawer needs the hamburger icon in the header; hiding it makes the drawer unreachable
- `drawerType: 'front'` — standard mobile pattern (drawer slides over content)
- Icon prop is `drawerIcon` (not `tabBarIcon`)

Run `npx --no-install tsc --noEmit` after the edit. If it fails, check that the `Drawer.Screen name` values exactly match the file names under `app/(app)/` (without `.tsx`).

### Step 10.7 — Snapshot generated services into the plan

**Print before starting:**
> "→ [Step 10.7/13] Probing src/generated/services/ and writing the service registry into native-app-plan.md…"

Before spawning N parallel screen-builders, the orchestrator probes `src/generated/services/` ONCE and writes the result into `native-app-plan.md`. Without this, every builder runs its own `Glob`, may spell service names differently, and ends up with mixed states inside one app (some screens use `CrXxxService.getAll()`, others write `// TODO(connector-not-yet-added)` for the same service).

```bash
cd <working_dir>
ls -1 src/generated/services/*.ts 2>/dev/null | sed 's|src/generated/services/||;s|\.ts$||'
```

For each service file found, run a quick grep to list its exported methods so builders know what's actually available without re-reading the (large) generated file:

```bash
for svc in $(ls -1 src/generated/services/*.ts 2>/dev/null); do
  name=$(basename "$svc" .ts)
  methods=$(grep -oE 'static async [a-zA-Z_]+' "$svc" | sed 's/static async //' | tr '\n' ',' | sed 's/,$//')
  echo "| \`$name\` | \`src/generated/services/$name.ts\` | $methods |"
done
```

Write the result into `native-app-plan.md` as a new section **immediately after `## Screens`** (and refresh it on every re-run — services come and go as the user runs `/add-dataverse`, `/add-sharepoint`, etc.):

```markdown
## Generated Services (snapshot at <ISO timestamp>)

| Service | Path | Methods present |
|---|---|---|
| `Cr3e9_projectsService` | `src/generated/services/Cr3e9_projectsService.ts` | `getAll, get, create, update, delete` |
| `Cr3e9_tasksService` | `src/generated/services/Cr3e9_tasksService.ts` | `getAll, get, create, update, delete` |

**For screen-builders:** if a service your spec references is in this table, import it and use the exact name + methods listed. If it is NOT in this table, the data source has not been added yet — write the screen with the expected import path and a `// TODO(connector-not-yet-added): run /add-dataverse to generate <ServiceName>` comment so the user can see what's blocked. Do not invent or rename services.
```

If the directory is empty (no data sources added yet), still write the section with an empty table and a one-line note: "No generated services yet — builders will emit TODO stubs for any service their spec references."

### Step 10.8 — Generate app-specific shared code + screen skeletons

**Telemetry checkpoint: `generate_shared_code_and_screen_skeletons`**

**Print before starting:**
> "→ [Step 10.8/13] Generating app-specific components, hooks, utils, and screen skeletons from the plan…"

This step analyzes the per-screen specs and generates **shared code that multiple screens will use** plus **typed skeleton files** for each screen. Builders then fill in the JSX rather than starting from zero. This cuts builder output by ~50% and eliminates import-path guessing errors.

---

#### 10.8a — Analyze plan for cross-screen patterns

Read all per-screen specs in `## Screens → ### Per-Screen Specs`. Identify:

1. **Entity cards/rows** — if 2+ screens render the same entity (same Service) in a card/row format, generate a shared component.
2. **Choice column maps** — if 2+ screens reference the same choice column (e.g. `status: 1=Pending, 2=Active`), generate a constants file.
3. **Custom hooks** — if 2+ screens call the same service with similar params (e.g. both list + detail call `InspectionsService`), generate a domain hook.
4. **Shared formatters** — if screens need entity-specific formatting (e.g. "inspection title" = `${name} · ${equipment}`), generate a formatter.

**Decision rules:**

| Pattern in specs | Generate | Where |
|---|---|---|
| Same entity shown as list-item on 2+ screens | `<Entity>Card.tsx` or `<Entity>Row.tsx` | `src/components/` |
| Same choice column referenced on 2+ screens | `constants.ts` with `ENTITY_STATUS` map + tone mapping | `src/utils/` |
| Same bounded service + similar `.getAll()` params on 2+ screens | `use<Entity>List.ts` wrapping `useListData` | `src/hooks/` |
| Same cursor-paginated service on 1+ unbounded screens | `use<Entity>CursorList.ts` wrapping `useCursorListData` | `src/hooks/` |
| Entity detail + edit screens for same entity | `use<Entity>.ts` with get + save + delete | `src/hooks/` |

**Write the files directly into the project** (not into samples — these are app-specific):

```bash
# Example — if plan has "Inspections" entity used on list + detail + home screens:
cat > '<working_dir>/src/components/InspectionRow.tsx' << 'EOF'
... generated component ...
EOF
```

If no cross-screen patterns are found (e.g. only 2 screens total with no overlap), skip this sub-step — the shared scaffold is sufficient.

---

#### 10.8b — Generate screen skeletons

For each screen in the plan's Screen Map that will be built by a screen-builder, write a **typed skeleton** file at its `target_file` path. The skeleton contains:

1. All imports (components, hooks, utils, services, types) pre-resolved
2. The exported component function with typed props/params
3. The hook calls (e.g. `useListData`, `useSearchFilter`, `useLocalSearchParams`)
4. An empty return with a `// TODO: screen-builder fills JSX here` marker

**Skeleton template for a Cursor List screen (`Pagination: cursor`):**
```tsx
import React from 'react';
import { FlatList, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { YStack, XStack, Text, Input, Spinner } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LoadingState, ErrorState, EmptyState, ScreenHeader } from '@/components';
import { useCursorListData } from '@/hooks';
import { containsFilter, formatDate, choiceLabel } from '@/utils';
import { <Service> } from '@/generated/services/<Service>';
import type { <Entity> } from '@/generated/models/<Entity>Model';
// App-specific imports (if generated at 10.8a):
import { <Entity>Row } from '@/components/<Entity>Row';
import { <ENTITY>_STATUS } from '@/utils/constants';

export default function <ScreenName>() {
  const router = useRouter();
  const { items, loading, refreshing, loadingMore, hasNextPage, error, query, setQuery, onRefresh, refetch, loadMore } = useCursorListData<<Entity>>({
    queryKey: ['<entityPlural>'],
    fetchPage: ({ pageSize, search, skipToken }) => <Service>.getAll({
      maxPageSize: pageSize,
      orderBy: ['<orderField> desc', '<primaryKey> asc'],
      select: [<renderedColumns>],
      ...(search ? { filter: containsFilter('<searchColumn>', search) } : {}),
      ...(skipToken ? { skipToken } : {}),
    } as any),
  });

  // TODO: screen-builder fills JSX here. FlatList MUST wire:
  // - data={items}
  // - refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
  // - onEndReached={hasNextPage ? loadMore : undefined}
  // - ListFooterComponent={loadingMore ? <Spinner /> : null}
  return null;
}
```

**Skeleton template for a Bounded List screen (`Pagination: none`):**
```tsx
import React from 'react';
import { FlatList } from 'react-native';
import { useRouter } from 'expo-router';
import { YStack, XStack, Text, Input } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LoadingState, ErrorState, EmptyState, ScreenHeader } from '@/components';
import { RefreshControl } from 'react-native';
import { useListData, useSearchFilter } from '@/hooks';
import { formatDate, choiceLabel } from '@/utils';
import { <Service> } from '@/generated/services/<Service>';
import type { <Entity> } from '@/generated/models/<Entity>Model';
// App-specific imports (if generated at 10.8a):
import { <Entity>Row } from '@/components/<Entity>Row';
import { <ENTITY>_STATUS } from '@/utils/constants';

export default function <ScreenName>() {
  const router = useRouter();
  const { items, loading, refreshing, error, onRefresh, refetch } = useListData(
    () => <Service>.getAll({ orderBy: ['<orderField> desc'], top: 50 }),
  );
  const { query, setQuery, filtered } = useSearchFilter(items, [<searchKeys>]);

  // TODO: screen-builder fills JSX here
  return null;
}
```

Do NOT use the bounded skeleton for a screen whose spec says `Pagination: cursor`. `useListData` fetches one bounded page; `useSearchFilter` filters only loaded rows. Cursor screens must use `useCursorListData`, `useInfiniteQuery`, or an app-specific cursor hook generated in 10.8a.

**Skeleton template for a Detail screen:**
```tsx
import React from 'react';
import { ScrollView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { YStack, XStack, Text, Button } from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LoadingState, ErrorState, BottomActionBar, InfoRow } from '@/components';
import { formatDate, choiceLabel } from '@/utils';
import { <Service> } from '@/generated/services/<Service>';
import type { <Entity> } from '@/generated/models/<Entity>Model';

export default function <ScreenName>() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [item, setItem] = React.useState<<Entity> | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!id) return;
    <Service>.get(id).then(r => { setItem(r.data ?? null); setLoading(false); });
  }, [id]);

  // TODO: screen-builder fills JSX here
  return null;
}
```

**Skeleton template for a Form screen:**
```tsx
import React, { useState } from 'react';
import { Alert, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { YStack, Text, Button, Input } from 'tamagui';
import { ModalHeader, FormField, RowPick } from '@/components';
import { <Service> } from '@/generated/services/<Service>';

export default function <ScreenName>() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  // Form state fields from spec:
  <field_declarations>

  const submit = async () => {
    // TODO: screen-builder fills validation + service call
  };

  // TODO: screen-builder fills JSX here
  return null;
}
```

**Skeleton template for the Profile screen** (`/(app)/profile`, always generated; app-specific content comes from the Profile spec):
```tsx
import React from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { YStack, XStack, Text, Button } from 'tamagui';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@microsoft/power-apps-native-host';

export default function <ScreenName>() {
  const router = useRouter();
  // AuthState shape (@microsoft/power-apps-native-host): { isLoading, isAuthReady, isSignedIn, error, acquireToken, signIn, signOut }
  // There is NO `user` / `account` field. Display name comes from the ID-token claim, not from useAuth().
  const { isSignedIn, signOut } = useAuth();

  const handleSignOut = React.useCallback(() => {
    Alert.alert('Sign out?', 'You can sign in again with your work or school account.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          void Promise.resolve()
            .then(() => signOut())
            .finally(() => router.replace('/login'));
        },
      },
    ]);
  }, [router, signOut]);

  // TODO: screen-builder fills JSX here. Any visible Sign out button calls handleSignOut.
  return null;
}
```

**Rules for skeleton generation:**
- Replace `<Service>`, `<Entity>`, `<ScreenName>`, `<searchKeys>`, `<orderField>`, `<field_declarations>` with actual values from the plan's per-screen spec + Generated Services table.
- If a service is NOT in the Generated Services table, still write the import but add `// TODO(connector-not-yet-added)` above it.
- Profile skeletons may also include generated service/model imports when the Profile spec's `Profile content` or `Data` fields require persisted app-specific user context. Keep the sign-out helper regardless of whether Profile also loads data.
- The skeleton is a **valid TypeScript file** (compiles with `return null`) — builders replace the `return null` with real JSX.
- Do NOT write skeletons for screens that already exist in the template (e.g. `home.tsx` if it's already present).
- The Profile skeleton must keep the `handleSignOut` helper and wire the planned `Sign out` button to it. Do not inline a second auth/logout path, and do not make Profile a sign-out-only screen.
- Do not merge sign-out imports or helpers into non-Profile screen skeletons. The Profile screen is the only sign-out owner.
- **Never destructure `user`, `account`, `profile`, or `claims` from `useAuth()`** — those fields do not exist on `AuthState`. The only fields are `isLoading`, `isAuthReady`, `isSignedIn`, `error`, `acquireToken`, `signIn`, `signOut`. If the screen needs the signed-in user's name/email, add a `// TODO: decode ID token claim` comment — do not invent a field.

---

#### 10.8c — DEPRECATED (skeleton is the import source of truth)

This sub-step previously appended `### Standard Imports` + per-screen `#### Resolved Imports` blocks into the plan. That added ~150 lines on a 14-screen plan and duplicated the imports already pre-resolved into each skeleton file at Step 10.8b.

**The skeleton file IS now the single source of truth** for per-screen imports + hook calls. The screen-builder reads the skeleton at `target_file` and fills the JSX. Do NOT append duplicate import documentation into the plan.

#### 10.8d — Navigation/skeleton TypeScript gate

After Step 10b layouts, Step 10.7 service snapshot, and Step 10.8 shared code/skeletons are all written, run the **Navigation/skeleton gate**:

```bash
npx --no-install tsc --noEmit
```

If this fails, do not launch Step 11. Capture the full error list once, batch-fix layout names, route paths, skeleton imports, shared component exports, generated service imports, or hook signatures, then rerun the gate. Screen-builders should start only from a clean shell with typed skeletons that compile with `return null`.

### Step 11 — Build screens (parallel)

**Telemetry checkpoint: `build_and_validate_screens`**

**Build mode is NEVER a user-facing question.** Do not ask "Build mode? parallel/inline" or any variant. The orchestrator decides automatically per the preflight below.

**Quality rule — screen count/time is NOT a fallback trigger.** If `Task` can spawn `mobile-app:screen-builder`, always use screen-builder waves, even for 10+ screens. Do NOT write "given the scale/time, I'll write screens inline" or any equivalent shortcut. Screen-builder agents carry the quality checklist, domain-pattern rules, resolved-import discipline, safe-area/contrast/a11y checks, and per-screen return protocol. Inline mode exists only for host/tooling failure, not for convenience.

#### 11.0 — `Task` preflight (silent)

Before the first wave, do a one-shot probe to confirm `Task` can spawn `mobile-app:screen-builder`. Spawn ONE no-op builder via `Task` with `screen_name: __preflight__` and `target_file: <working_dir>/.preflight-probe.tsx` (the probe agent should return `DONE` immediately and the orchestrator deletes the file).

- **Probe returns `DONE` (any status code)** → parallel mode. Proceed with normal fan-out below. Do not downgrade later because there are many screens or because inline writing seems faster.
- **Probe errors with `Agent type … not found`, tool unavailable, or any nested-Task failure** → silent inline fallback. Print **once**:
  > "→ Parallel screen-builders unavailable in this host — building screens inline. (No action needed; this is automatic.)"
  Then iterate the screen list and apply the full screen-builder workflow inline (the orchestrator becomes the builder, reading the same per-screen specs and writing TSX directly). Inline does NOT mean "concise but functional" — it must still satisfy `screen-builder.md` quality gates, operational pattern requirements, safe-area/contrast/a11y rules, resolved imports, and the final checklist for every screen. Do NOT prompt the user.

**Hard rule — never ask the user about build mode.** The probe is the only decision input. If the host changes mid-run (rare), treat the next failure the same way: silently downgrade to inline and continue.

**Hard rule — no nested agent spawning.** Screen-builder agents MUST NOT spawn further agents (no nested `Task` calls). The top-level orchestrator owns the entire screen-builder fan-out: one `Task` batch per wave of up to 5 screens. If a builder needs help that previously would have been a nested spawn, it returns `NEEDS_CONTEXT:` and the orchestrator handles the follow-up at the wave boundary.

**Print before spawning** (substitute computed values; `<W>` = total waves = `ceil(N/5)`):
> "→ [Step 11/13] Building <N> screens in <W> wave(s) of up to 5 concurrent.
> Wave 1/<W> starting: <comma-separated screen names in this wave>."

Read the `## Screens` section's per-screen specs. For each screen the plan marks as new (skip baseline screens already in template), spawn a `mobile-app:screen-builder` agent via `Task` **in a single message** so they run in parallel. The `mobile-app:` plugin-name prefix is required.

```
Spawn N agents (parallel): mobile-app:screen-builder

Each prompt:
  working_dir: <working_dir>
  screen_name: <name>
  route: <route>
  target_file: <working_dir>/<File from Screen Map>
  plan_path: <working_dir>/native-app-plan.md
  skeleton_exists: true

  Follow screen-builder.md. Build from the user's compact per-screen spec, shared conventions, and design direction — inherited defaults are intentional, and samples are API/import references only, not layouts to copy. A typed skeleton already exists at your target_file with all imports and hook calls pre-resolved from the Generated Services table + per-screen `**Data**` field — fill in the JSX, do not discard imports. The skeleton file IS the import source of truth; the plan no longer documents per-screen imports separately. Return per AGENTS.md rule #10: literal first line is `DONE` / `DONE_WITH_CONCERNS:` / `NEEDS_CONTEXT:` / `BLOCKED:`, then a blank line, then the one-line summary.
```

**`target_file` resolution (HARD):** read the **File** column from the Screen Map row for this screen and prefix it with `<working_dir>/`. The path may be nested (e.g. `<working_dir>/app/(app)/inspections/[id].tsx`). The folder is guaranteed to exist because Step 10b.2 created it and wrote the inner `_layout.tsx`. **Do NOT compute the path as `<working_dir>/app/(app)/<screen-name>.tsx`** — that strips the folder structure and produces phantom-tab files. If the Screen Map row has no File column (older planner output), fall back to the flat path and surface a `DONE_WITH_CONCERNS: Screen Map missing File column — used flat fallback paths, expect phantom tabs` after the wave.

**Cap at 5 concurrent.** If the plan has more than 5 new screens, batch them in waves of 5.

**Progress streaming — print one line per builder as the wave returns, then a wave summary.** The `Task` tool returns all parallel results together, but you can still narrate per-builder by iterating the returned results in order before doing the status-switch branching. Format:

```
  ✓ [3/8] HomeScreen — DONE
  ✓ [4/8] ListScreen — DONE_WITH_CONCERNS (1 connector stub)
  ✓ [5/8] DetailScreen — DONE
─── Wave 1/2 complete (5/8 screens built; 0 blocked, 1 with concerns) ───
```

Use `✓` for DONE / DONE_WITH_CONCERNS, `↻` for NEEDS_CONTEXT (will retry), `✗` for BLOCKED. Always print the running counter `[K/N]` so the user sees forward motion. The wave summary line goes on its own line after the per-builder block.

After the wave's TypeScript gate passes, and only then, print the next wave start line (if any):
> "Wave 2/<W> starting: <names>."

**After each wave returns, run the Step 3.0 status switch on every builder's first line.** Branch per builder:

- `DONE` → continue.
- `DONE_WITH_CONCERNS: <list>` (typical case: a `// TODO(connector-not-yet-added)` stub was emitted because the referenced service is not in the Generated Services table) → batch concerns across all builders, surface the consolidated list to the user once at the end of the wave (not per-builder — that would be noise), and ask whether to fix any pending connectors via `/add-connector` before continuing to Step 12. Record in `memory-bank.md`.
- `NEEDS_CONTEXT: <missing>` → re-spawn that one builder with the missing context appended to its prompt (cap 2 retries per screen, then `BLOCKED`). Print `↻ [K/N] <name> — retrying (missing: <missing>)` so the user understands the wave isn't fully clean yet.
- `BLOCKED: <reason>` → STOP for that screen, print `✗ [K/N] <name> — BLOCKED (<reason>)` and ask the user whether to (1) fix and retry, (2) skip the screen and continue with a placeholder, or (3) abort the whole flow.

After handling every builder status in the wave, run the **Screen-wave gate** before launching the next wave:

```bash
npx --no-install tsc --noEmit
```

**Mark screen progress in the plan** once the wave's TypeScript gate is clean:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id screens --status active --note "<n> of <total> screens built"
```

The plan's phone is already showing the screen carousel from Step 6.75, so there is nothing to
re-point here — only the count to keep honest.

If the wave gate fails, capture the full error list once, group failures by root cause, and repair in batch. For screen-owned files, re-spawn the affected screen-builder(s) with the consolidated TypeScript output appended to their prompts. Affected builders can be re-spawned in parallel. Cap retries at 2 per screen, then surface the failure to the user. Do not launch the next wave until the current wave gate is clean.

Common wave-gate repair classes to batch instead of fixing line-by-line:
- Generated service/model names: singular vs plural generated names, stale aliases after Dataverse rename.
- Service option shapes: `orderBy` must match the generated type, usually `string[]`.
- UI prop mismatches: invalid Tamagui shorthand props on components that do not support them.
- React Native style types: percent widths must use a typed percentage or shared `ProgressBar` helper.
- Dataverse create/update payload typing: prefer typed helper wrappers; if generated base types require server-owned fields, isolate any `as any` at the helper boundary, not throughout screen JSX.
- Stale connector TODOs: remove `TODO(connector-not-yet-added)` when the service exists in the Generated Services snapshot.

**After all waves return and the last wave gate is clean**, run one final `npx --no-install tsc --noEmit` before Step 12 to catch cross-screen issues that only appear when all screens exist. If it fails, use the same consolidated batch-repair flow.

Then run the canonical route-contract gate from the app root:

```bash
node "${PLUGIN_ROOT}/scripts/check-routes.js"
```

This gate is required even when TypeScript passes. It detects duplicate normalized routes, `[id].tsx` plus `[id]/<child>.tsx` file/folder collisions, and sender/destination parameter drift. If it fails, repair the affected route files or re-spawn their screen builders with the consolidated findings, then rerun once. Do not continue to Step 11.4 or start Metro while route findings remain.

**Sticky tsc/build error policy (run-level).** The first time a `tsc` or `npm run build` failure surfaces in this run, ask the user once:

> "tsc found <N> error(s) in <files>. Patch + continue, or stop and let me investigate?"

Record the answer in `memory-bank.md` under `## Policies` as `tsc_error_policy: patch_continue` or `tsc_error_policy: stop_for_review`. **For every subsequent tsc/build error of the same class in the same run** (e.g., another screen failing typecheck after a builder retry, the cross-screen `tsc` after Step 11.4 fixes), apply the recorded policy automatically:

- `patch_continue` → re-spawn the matching builder with the error appended (or auto-patch in inline mode), respecting the 2-retry cap. Do not re-prompt the user.
- `stop_for_review` → STOP and surface the new error.

Reset the policy only if the user explicitly says "ask me again" or `/edit-app` is invoked. This avoids the same class of question being asked 3–5 times per run while still letting the user override at any point.

This sticky policy controls **how to handle a failed gate**, not whether the gate is required. Even with `patch_continue`, every required TypeScript gate must end clean before the flow advances.

### Step 11.4 — Stylistic fix sweep (parallel)

**Telemetry checkpoint: `validate_screen_design_quality`**

**Shared step:** read [`stylistic-sweep.md`](stylistic-sweep.md) and follow it in full.

#### Optional static preview

After `tsc` passes, offer a static HTML preview. The dev server starts next (Step 12), so default is skip.
Mark the wait, since the run does not continue until the user picks:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id screens --status active --note "Waiting for your preview choice"
```


> "→ N screens built and type-checked. The live app starts next.
>
> Want a static HTML preview first, or go straight to the live app?
>
> (a) Preview all screens — HTML phone frames for every screen
> (b) Preview key screens — List + Form + Detail archetypes only
> (c) Skip preview
>
> [default: c]"

- **(a)** → invoke `/preview-screens` (all screens)
- **(b)** → invoke `/preview-screens` with only List + Form + Detail screen files (skip Login, Splash, Profile, OAuth)
- **(c)** → proceed directly to Step 12

---

Every screen is built and type-checked, so close the screens phase:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id screens --status done
```

### Step 12 — Start dev server (Metro writes project-local logs)

**Telemetry checkpoint: `launch_metro_dev_server`**

Open the final phase (Step 13 marks it done):

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id run --status active
```

**Shared step:** read [`dev-server.md`](dev-server.md) and follow it in full.

### Step 12.5 — Optional debug handoff

**Shared step:** read [`debug-handoff.md`](debug-handoff.md) and follow it in full.

### Step 13 — Summary

**Shared step:** read [`summary.md`](summary.md) and follow it in full.

## Notes

- This skill is the only entry point for new project creation. Do not invoke `/add-*` skills directly during a fresh-project flow — they don't know how to read the plan and would re-prompt the user.
- The planner agent owns the approval gates. This skill never enters plan mode itself — that would create a duplicate gate.
- For mid-project changes after Step 13, the user should run individual `/add-*` skills, or `/edit-app` for plan-backed app iteration.

## Reference

- [shared/shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)
- [shared/references/screen-templates.md](${PLUGIN_ROOT}/shared/references/screen-templates.md)
- [agents/native-app-planner.md](${PLUGIN_ROOT}/agents/native-app-planner.md)
