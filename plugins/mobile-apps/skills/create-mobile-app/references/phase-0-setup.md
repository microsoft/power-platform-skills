# Setup and Requirements

## Fresh-template working-directory mode

This skill assumes the user already has a **fresh** `pa-wrap-tools/templates/expo-app-standalone` template materialized with `degit` in the target working directory and has already run `npm install` there. The skill turns that fresh template into an app; it does not clone, degit, or copy a template itself.

**Fresh template required.** If the working directory is not a template, or if it already looks like an app created by this skill, STOP and tell the user to materialize a fresh `expo-app-standalone` template with `degit` into a new folder, run `npm install`, then rerun `/create-mobile-app --working-dir <fresh-template-dir>`.

Use these markers:

| State | Detection | Action |
|---|---|---|
| Fresh template | `package.json`, `app.config.js`, `auth.config.json`, `tamagui.config.ts` exist; `node_modules/expo` exists; `memory-bank.md`, `native-app-plan.md`, `.datamodel-manifest.json`, and generated Dataverse services are absent | Proceed. |
| Template not installed | Fresh-template files exist but `node_modules/expo` is absent | STOP: ask user to run `npm install` in the template folder, then rerun. Do not provision ADO npm tokens here. |
| Already-created app | `memory-bank.md`, `native-app-plan.md`, `.datamodel-manifest.json`, or `src/generated/services/*.ts` exists | STOP: this is not a fresh create target. Ask user to materialize a fresh template folder with `degit`. |
| Not template | Required template files are missing | STOP: ask user to materialize `pa-wrap-tools/templates/expo-app-standalone` into the working directory with `degit` and run `npm install`. |

This gate is intentionally simple: `/create-mobile-app` creates a new app from a fresh template. It does not adopt, repair, resume, or overwrite an already-created app.

---

## TypeScript Gate Policy — no quality compromise

`tsc` is a **phase gate**, not a reflex after every tiny edit. The app may not advance past a gate until TypeScript is clean.

**Required gates:**
- **Scaffold gate:** Step 6.6 after existing-template preparation, `npx power-apps init`, and dependency verification.
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

### Step 0 — Resume check + fresh-template gate

If `$ARGUMENTS` includes a `--working-dir` (or the user names an existing directory), check whether `<working_dir>/memory-bank.md` exists.

- **Bank present** → read it. Identify the highest-numbered completed step. Inform the user:
  > "Found existing project '<name>' at `<dir>`. Steps 1–<N> already completed (last update <date>). Resume from Step <N+1>?"
  Wait for confirmation. If the user says yes, jump to that step. Skip the wizard (Step 2) and re-use the values stored in the bank.
- **Bank absent** → fresh project. Continue to Step 1.
- **Bank present but corrupted** (missing required headings) → surface the parse error, ask the user whether to overwrite (lose history) or fix manually before proceeding.

The bank is the only resume mechanism. Do not infer resume state from `package.json` or `node_modules/` — those can lie.

When the bank exists, verify deterministic resume state before proposing a
step:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-pipeline-state.js" \
  --project-root "<working_dir>" --verify
```

If it returns `valid: true`, resume after `resumeAfterStep`. If state is
missing or stale, use the memory bank only as a human history source and
restart from the earliest phase whose artifacts cannot be verified. Never
skip a mutation or approval because a source file merely exists.

After the resume check, run the **fresh-template gate** from the section above. This is a create-only command:

- If `memory-bank.md` exists and the user confirms resume, resume as documented above.
- If any already-created-app marker exists and there is no approved resume path, STOP and tell the user to materialize a fresh template into a new folder with `degit`.
- If required template files are missing, STOP and tell the user to materialize `pa-wrap-tools/templates/expo-app-standalone` into the working directory with `degit` and run `npm install`.
- If `node_modules/expo` is missing, STOP and tell the user to run `npm install` in that template folder before rerunning this skill.

**Do not silently copy a bundled template over the user's folder.** A fresh `pa-wrap-tools-1` template may contain placeholder `power.config.json` with an empty `environmentId`; Step 5 removes that placeholder immediately before Step 6 runs `npx power-apps init`.

Do not initialize app identity yet. Step 2c is the last zero-side-effect exit,
so `app.json` must remain byte-identical until the user chooses `proceed`.

### Step 1 — Prerequisites

Run all checks first — no point gathering requirements if the toolchain isn't ready.

**Important: npm auth and Power Platform app auth are separate.** The account used for `npm install` can be different from the account used by `npx power-apps`:

| What | Uses | Typical account |
|---|---|---|
| `npm install` private feed access | npm/Azure Artifacts auth configured outside this skill | Account with feed Reader access |
| `npx power-apps init`, Dataverse, deploy | `npx power-apps` browser auth + `az login --tenant <env-tenant>` for Dataverse helper scripts | Power Platform environment account, often a test-tenant/admin account |

Renewing npm feed auth does not sign the user into `npx power-apps`. If the Power Apps CLI prompts for browser auth later, that is expected and unrelated to the npm/ADO feed token.

Then run the checks:

```bash
node --version                                      # v22+
npm  --version                                      # v10+
az account show --query "user.name" -o tsv          # Azure CLI logged in (needed for Dataverse helper scripts)
git --version                                       # optional
```

**Do NOT probe Xcode, Java, Android Studio, or CocoaPods here.** This plugin's flow is plan → scaffold → code → local Expo dev server. Build + deploy (`npm run build` / `npx power-apps push`) is a separate user-driven step via the `/deploy` skill. Local native compile is the user's choice and lives outside this skill (run the platform-specific native command directly when needed). See [`shared/version-check.md`](${CLAUDE_SKILL_DIR}/../../shared/version-check.md) — only the **Always required** tier matters here.

| Missing | Action |
|---|---|
| Node < 22 | STOP — instruct `nvm install 22 && nvm use 22` |
| `az` | STOP — instruct `az login` |

Template-only rule: this skill no longer provisions npm feed tokens, PAT fallbacks, vendor fallbacks, or registry rewrites. The user must run `npm install` in the fresh template folder before invoking `/create-mobile-app`.

Capture target Power Platform environment for the remaining flow.

**Source of truth for env selection: the generated `power.config.json` first, explicit environment ID second.** In the normal template-folder flow, `npx power-apps init` runs first and writes the selected environment ID into `power.config.json`; read that ID and pass it to `scripts/resolve-environment.js` to resolve the Dataverse URL and tenant. If `power.config.json` is missing or has an empty placeholder `environmentId`, ask for an environment ID. A Dataverse URL is useful as a resolver fallback for existing apps, but it is not enough for `npx power-apps init` because init needs `--environment-id`.

| Step | Source | When user is asked |
|---|---|---|
| 0. `power.config.json` has `environmentId` | `scripts/resolve-environment.js <environment-id>` | Never — automatic after `npx power-apps init` |
| 1. User supplies env ID | `scripts/resolve-environment.js <environment-id>` | Ask only if `power.config.json` is missing/empty or user wants a different env |
| 2. User wants a different account | Follow shared-instructions standalone CLI auth handling | Only if resolution/token acquisition fails or user asks |
| 3. User wants different env | Ask for another env ID and re-run resolver | Only if user selects "use a different environment" at Step 2 |
| 4. `npx power-apps init -t MobileApp --display-name "$DISPLAY_NAME" --environment-id $ACTIVE_ENV_ID --non-interactive` | Persists choice into `power.config.json` | Only when this skill owns the initial init path |

```bash
TARGET_ENV="<environment-id-or-empty>"
if [ -z "$TARGET_ENV" ] && [ -f power.config.json ]; then
  TARGET_ENV=$(node -e "try { const id=require('./power.config.json').environmentId || ''; console.log(id); } catch { console.log(''); }")
fi
test -n "$TARGET_ENV" || { echo "✗ Environment missing. Provide an environment ID."; exit 2; }
ENV_JSON=$(node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$TARGET_ENV" --no-cache)
ACTIVE_ENV_ID=$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.environmentId || '')" "$ENV_JSON")
ACTIVE_ENV_NAME=$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.displayName || j.environmentUrl || '')" "$ENV_JSON")
ACTIVE_ENV_URL=$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.environmentUrl || '')" "$ENV_JSON")
ACTIVE_TENANT_ID=$(node -e "const j=JSON.parse(process.argv[1]); console.log(j.tenantId || '')" "$ENV_JSON")
test -n "$ACTIVE_ENV_ID" || { echo "✗ Environment ID missing. Provide the environment ID directly."; exit 2; }
echo "✓ Target env: $ACTIVE_ENV_NAME ($ACTIVE_ENV_ID)"
echo "✓ Target env URL: $ACTIVE_ENV_URL"
echo "✓ Target tenant: ${ACTIVE_TENANT_ID:-unknown}"
```

**Orchestrator handling for `exit 2`:** ask the user for their environment ID directly, then re-run the capture block above. Do not run `npx power-apps init` here; Step 6 owns initialization after the user confirms the target environment.

Stash `$ACTIVE_ENV_ID`, `$ACTIVE_ENV_NAME`, `$ACTIVE_ENV_URL`, and `$ACTIVE_TENANT_ID` for Step 2 (env confirmation), Step 6 (`npx power-apps init`), and Step 7 (`auth.config.json` tenant/environment cache). If parsing fails, ask for an environment ID again.

If `resolve-environment.js` cannot get tokens, run `az login --tenant <env-tenant>` in the foreground. If `npx power-apps init` later uses the wrong account, follow shared-instructions standalone CLI auth handling and retry once.

### Step 1.7 — Detect publisher prefix

Detect the publisher prefix for the env's Default solution so the planner uses the correct prefix rather than assuming `cr_`.

**Deferred execution:** do not run the query at this point. Step 2b.4 first
classifies the run as `required` or `connector-only`; only `required` runs
execute the block below. Connector-only runs set
`$DETECTED_PUBLISHER_PREFIX = ""` and make no Dataverse prefix query.

```bash
PUBLISHER_PREFIX_STARTED_MS=$(node -e 'process.stdout.write(String(Date.now()))')
PUBLISHER_PREFIX_JSON=$(node "${CLAUDE_SKILL_DIR}/../../scripts/detect-publisher-prefix.js" \
  "$ACTIVE_ENV_URL" --tenant-id "$ACTIVE_TENANT_ID")
PUBLISHER_PREFIX_DURATION_MS=$(node -e \
  'process.stdout.write(String(Math.max(0, Date.now() - Number(process.argv[1]))))' \
  "$PUBLISHER_PREFIX_STARTED_MS")
echo "$PUBLISHER_PREFIX_JSON"
```

Keep `PUBLISHER_PREFIX_DURATION_MS` in memory only. Step 2c is still the last
zero-side-effect exit; persist this measurement only after `proceed` creates the
Step 3 `.tmp` directory.

Output is one line of JSON, e.g.:

```json
{"prefix": "cr8142a", "source": "detected"}
{"prefix": null, "reason": "no token (run `az login --tenant <env-tenant>`)"}
```

The script queries the Default solution's publisher via:
`/api/data/v9.2/solutions?$select=uniquename&$expand=publisherid($select=customizationprefix)&$filter=uniquename eq 'Default'`

A second solution name can be passed as a second argument if the env uses a different solution (defaults to `'Default'`).

**Token tenant note:** the script's `getAuthToken` discovers the env's tenant ID from the Dataverse HTTPS auth challenge and passes `--tenant <env-tenant>` to `az`, so detection works even when the active az identity is on a DIFFERENT tenant. If the user has not run `az login --tenant <env-tenant>` at any point, detection may return null.

**Stash the result for Step 3 (planner spawn):**

| Output | Stash as | Behavior at Step 3 |
|---|---|---|
| `{"prefix": "cr8142a", ...}` | `$DETECTED_PUBLISHER_PREFIX = "cr8142a"` | Pass to planner prompt as a fact: *"Publisher prefix (detected from env): `cr8142a_`"* |
| `{"prefix": null, ...}` | `$DETECTED_PUBLISHER_PREFIX = ""` (empty) | Pass to planner as: *"Publisher prefix: NOT DETECTED — use placeholder `cr_` and warn the user that Dataverse will normalize the actual prefix at create time."* |

Do NOT block on null detection — the user can still proceed; the Power Apps CLI normalizes prefixes when `npx power-apps add-data-source` runs. The detection step is purely to make the plan output accurate.

If the script exits non-zero (rare — should always exit 0 with `prefix: null`), treat it as the null case and continue.

### Step 2 — Gather requirements

Skip questions the user already answered in `$ARGUMENTS`.

If the user gave no description, ask one open-ended question first:

> "What would you like to build? Describe it in your own words — what it does, who uses it, and what problem it solves."

Then collect the remaining fields in one `AskUserQuestion` call. Use at most
four fields per call; only use a second call for a conditional answer such as
environment override or name collision:

| Question | Default |
|---|---|
| App display name | derived from description |
| Target platforms | `ios`, `android` (multi-select, default both) |
| Aesthetic | minimal / playful / professional / matches existing brand |
| Target environment | Confirm `<ACTIVE_ENV_URL>` / `<ACTIVE_ENV_ID>` from Step 1.6, or choose "use a different environment" and provide another environment ID |

**App slug is auto-derived** from the display name (`slugify(displayName)` — kebab-case, ASCII-only, strip non-alphanumerics). Do NOT ask the user; the derived slug is correct >95% of the time. Show the resolved slug as part of Step 2c's plan preview so the user can override via `edit` if needed.

**Environment override branch:** If the user picks "use a different environment", ask for the Power Platform environment ID via `AskUserQuestion`, then run `scripts/resolve-environment.js <id> --no-cache` again and refresh `$ACTIVE_ENV_ID` / `$ACTIVE_ENV_URL` / `$ACTIVE_TENANT_ID`. Do not persist the selection before Step 2c approval.

**App-name collision pre-flight.** Once `<displayName>` is fixed, check the chosen env for a name collision:

```bash
npx power-apps list-codeapps --environment-id "$ACTIVE_ENV_ID" --json 2>/dev/null | grep -F "<displayName>" >/dev/null && \
  echo "COLLISION" || echo "OK"
```

If `COLLISION`, ask the user via `AskUserQuestion`:
> "An app named `<displayName>` already exists in `<ACTIVE_ENV_NAME>`. Choose:
>  1. Pick a different name (recommended)
>  2. Delete the existing app in Maker portal — DESTRUCTIVE, asks confirmation outside this skill
>  3. Continue anyway (bg `npx power-apps init` will fail; you'll have to rename later — NOT recommended)"

Re-prompt for name if (1). If (2), send the user to Maker portal to delete the existing app, then re-run the collision check. Only proceed once collision is resolved.

If `npx power-apps list-codeapps` is unavailable in the installed CLI version, skip the pre-flight silently and continue.

Don't enter plan mode here — that's the planner agent's job in Step 3.

### Step 2b — Requirements discovery

> **Goal:** Turn the user's thin prompt into a confirmed feature brief before the planner runs. The planner agent receives this brief verbatim — richer input means better data model inference, accurate connector detection, and correct screen specs.

#### Step 2b.0 — Prompt richness scoring (decides which path to take)

Before asking anything, score the description on four signals. The score decides whether we ask a multi-select feature picker, a single confirmation, or skip the discovery question entirely.

Run this scorer mentally on `<description>` (the prompt the user gave with `/create-mobile-app`, plus any clarifying text from Step 2a). Count how many of the four trip:

| Signal | Trips when |
|---|---|
| **Word count** | description has ≥ 60 words |
| **Distinct nouns** | description names ≥ 5 distinct domain nouns (people, things, documents, places — e.g. "inspector", "aircraft", "gate", "defect", "evidence") |
| **Action verbs** | description uses ≥ 3 workflow verbs from this set: log, track, submit, assign, notify, scan, upload, approve, verify, complete, capture, override, dispatch, review, sign |
| **Domain phrase** | description names a known industry domain — match against the industry table in [`shared/references/universal-patterns.md`](../../../shared/references/universal-patterns.md) (airline, hospital, retail, manufacturing, field-service, finance, logistics, …) OR explicitly says "field operations" / "ground operations" / "site visit" / similar |

Tier the result:

| Score | Tier | What to do |
|---|---|---|
| **4 / 4** | `auto-plan` | **Skip both questions.** Extract the brief silently from `<description>`, write `native-app-plan.md` placeholder, fall through to Step 2c. The user's next interaction is the cost-estimate gate. |
| **3 / 4** | `one-tap` | **Skip the multi-select.** Extract the brief, show it once, ask only "Look right? (yes / adjust)". On `yes` → Step 2c. On `adjust` → fall through to walk-through. |
| **≤ 2 / 4** | `walk-through` | **Current behaviour.** Run the multi-select feature picker described in Step 2b.1, then the brief confirmation. |

Print the chosen tier so the user knows which path is running:

> "→ Prompt richness: 4/4 — skipping discovery questions, extracting brief and going straight to the plan-cost preview." *(or 3/4 / ≤2/4 with the matching path name)*

`--full-discovery` escape hatch: if `$ARGUMENTS` contains `--full-discovery`, force `walk-through` regardless of score. Use this in dogfood runs where you want to exercise the multi-select path.

`--no-discovery` escape hatch: if `$ARGUMENTS` contains `--no-discovery`, force `auto-plan` regardless of score. Use this for fully-headless runs from the wrapper templates repo.

#### Step 2b.1 — Walk-through path (only when tier = `walk-through`)

Read [`references/requirements-discovery.md`](${CLAUDE_SKILL_DIR}/references/requirements-discovery.md). Infer context-aware options from the user's description, ask exactly one structured `AskUserQuestion`, and never use markdown checkboxes in the question text.

Wait for the user's response. Summarize their answers into a **requirements brief** — 4–8 bullet points covering what users can do, what data is tracked, and integrations.

Confirm once:
> "Here's the brief I'll use for planning:
> • *(bullet 1)*
> • *(bullet 2)*
> ...
> Look right? (yes / adjust)"

Store the confirmed brief as `<requirements_brief>`. This replaces the thin `$ARGUMENTS` as the primary input to the planner.

#### Step 2b.2 — One-tap path (tier = `one-tap`)

Skip the multi-select question. Extract a 6–10 bullet brief directly from `<description>` covering: user roles, key entities, primary workflow, severity / status enums if present, integrations / connectors, native capabilities, and any explicit constraints. Show it with a single confirm:

> "Your description is detailed enough to skip the feature picker. Here's the brief I extracted:
> • *(bullet 1)*
> • *(bullet 2)*
> ...
> Look right? (yes / adjust / start over)"

- `yes` → store as `<requirements_brief>`, fall through to Step 2c.
- `adjust` → drop to Step 2b.1 (walk-through) so the user can edit via the multi-select.
- `start over` → return to Step 2a and re-prompt for the description.

#### Step 2b.3 — Auto-plan path (tier = `auto-plan`)

Skip both the multi-select AND the brief confirmation. Extract the brief silently and store it as `<requirements_brief>`. Print it as a transparency log only:

> "→ Auto-plan tier (4/4). Extracted brief from your description:
> • *(bullet 1)*
> • *(bullet 2)*
> ...
> → Going straight to the plan-cost preview (Step 2c). The brief above is locked in unless you abort there."

Do not ask for confirmation here — the user agreed to this when their prompt scored 4/4. The plan-preview gate at Step 2c remains in force as the last cheap exit before any side effects.

#### Step 2b.4 — Common to all paths

**Auto-proceed after `yes` (or after auto-plan transparency log).** Fall through directly to Step 2c (plan preview). Do NOT add a separate "Proceed to planning?" prompt — the brief confirmation IS the planning go-ahead. The only abort gate after this is Step 2c's `proceed/edit/abort` block, which is intentionally distinct because it shows the rough cost estimate.

Classify Dataverse planning before Step 2c and stash
`<dataverse_planning_mode>`:

- `connector-only` only when every record source and write target is an
  explicit non-Dataverse connector/system of record, and the app needs no
  app-owned persistent rows, Dataverse offline data, retained File/Image
  artifact, existing Dataverse table, or Dataverse-backed native capability.
- `required` for every other case, including ambiguity. Do not infer
  connector-only merely because the brief names a connector.

Also stash `<exact_target_facts_required> = yes` when planning depends on any
existing/standard/managed table, reuse or extension decision, proposed-name
collision decision, relationship target, computed column, or target
customizability fact. Otherwise set it to `no`. This flag controls only safe
planning degradation; it never relaxes `/add-dataverse` reconciliation.

Now execute the deferred Step 1.7 publisher-prefix detection only when
`<dataverse_planning_mode> = required`. For `connector-only`, set
`$DETECTED_PUBLISHER_PREFIX = ""`, print
`↷ Publisher-prefix discovery skipped — connector-only planning.`, and do not
call `detect-publisher-prefix.js`.

**Safe snapshot overlap.** After the brief is locked and Dataverse planning is
classified `required`, the foreground snapshot inputs are stable. While the
user reviews Step 2c, the orchestrator may start the read-only snapshot in the
background with its output under the host temporary directory, not
`<working_dir>`, and with no inventory-cache or telemetry output. Keep the
temporary path/process handle in memory only. On `abort` or `edit`, stop the
process and delete that exact temporary file. On `proceed`, Step 3 may adopt it
only after normal environment/identity validation succeeds; otherwise discard
it and run the standard foreground command. This overlap must never create a
project file before `proceed`.

**Design decisions are deferred to Step 6.75** — `/design-system` (ships with this plugin) handles brand inputs, the style picker, and visual companion preference in one flow after the project is scaffolded. Do NOT ask design questions here.

Set tentative defaults:

- `<visual_companion> = yes` — open `_plan_preview.html` at Gate 3 by default.
- `<design_vibe_opt_in> = deferred` — Step 6.75 materializes the approved
  Product Experience. The planner does not choose a direction from industry.

**`--no-design` escape hatch.** For headless / token-constrained runs, set
`--no-design` in `$ARGUMENTS`. It forces `<visual_companion> = no` and uses the
fast experience path: no style alternatives or component gallery, but Step
6.75 still writes neutral semantic tokens and the deterministic HTML journey
preview required for Gate 3. It never selects an inspection or other industry
preset.

### Step 2c — Plan preview (rough, always shown)

> **Goal:** Give the user a cheap exit before any mutation happens. This is the **last point** in the flow with zero side effects — no `git clone`, no `npm install`, no `npx power-apps init`, no agent tokens spent on planning. After Step 3 starts, every abort gets more expensive (half-written `native-app-plan.md`, partial `_screens_section.md`, architect tokens already burnt).

**Always runs. There is no `--no-preview` flag in v0** — we need calibration data (~10+ runs with recorded estimate-vs-actual) before we can trust the rough estimates enough to let users skip them. Once the data shows estimates are reliably within ±50%, evaluate adding a skip flag for repeat-user workflows.

**Compute the estimates from inputs already in hand** (no agent spawn — pure heuristics on the confirmed brief and the wizard answers):

| Output | Input proxy | Computation | Confidence |
|---|---|---|---|
| Tables | Independently persistent records implied by core jobs | Count only concepts likely to have their own lifecycle/ownership/history, then show `max(1, count - 1)` to `count + 1` | low — scope compiler may use columns, Choices, local state, or reuse |
| Connectors | Step 2b inferred connector list | `len(inferred)` (already exact) | high |
| Screens | Independent journeys and roles | Focused journey `4-7`; 2-3 connected journeys `7-12`; complex workflow `12-16`; multi-role `16-20` | medium — critical steps may share one surface |
| Planning min | Tables + screens | lower bound `max(10, tables × 0.3 + screens × 0.4 + 2)`; upper bound `max(15, computed upper)` | low — protects the quality-first Gate 1 budget |
| Scaffold min | Fixed | `1-2` (template preparation + npm install already happened before skill invocation) | high |
| Build min | Screens, canary plus configurable supporting waves | canary `0.6-1.2`, then `ceil(remaining screens / <builder-cap>) × 0.6`; default cap 4, maximum 6 | medium |
| Extra prompts | Contract confidence + design path | `+1 only when Gate 1 contains a consequential low-confidence assumption; +1 when the user requests style alternatives` | medium |

Print the block once, exactly in this format (substitute computed values; ranges as `low-high`):

```
─── Plan preview (rough) ─────────────────────────────────
Based on your confirmed brief, before foreground planning runs:

Scope (proxy estimates — actual numbers come from architects):
  New tables   ~<low>-<high>      ← independently persistent records only; reuse/columns/Choices may reduce this
  Connectors    <N> inferred      ← <comma-separated names>  (confirm at Gate 2)
  Screens     ~<low>-<high>       ← from journey/role complexity, not entity CRUD multiplication
  Approval reviews <1 consolidated | 4 gated> ← same sections and contracts; `--gated` keeps the legacy flow

Time (rough — excludes your approval latency at gates):
  Planning      ~<low>-<high> min ← foreground contract/data-model planning; approvals add latency
  Scaffolding   ~1-2 min          ← validates prepared template + runs power-apps init
  Screen build  ~<low>-<high> min ← strongest-model canary, then supporting waves; default cap 4, maximum 6

Model tier: foreground planning/design use the current foreground model. Screen canary, signature, capture, media-heavy, and high-risk screens use the strongest available child model; routine supporting screens may use a cheaper available child model.

⚠ These are proxies, not measurements:
  • Nouns do not automatically become tables; every new table needs a lifecycle boundary
  • Features do not automatically become 2-3 screens; jobs may share sections, sheets, or workflow steps
  • Time excludes your approval latency at the 4 gates
  • If you request style alternatives, the design step adds one choice
  • If any gate is rejected, that section regenerates (~2-3 min each)

Proceed, edit brief, or abort? [proceed/edit/abort]
─────────────────────────────────────────────────────────
```

**Three-option exit:**

| User answer | Action |
|---|---|
| `proceed` (or empty / Enter) | Initialize app identity, then continue to Step 3. Default. |
| `edit` | Jump back to Step 2b. Re-confirm the brief with the user's changes. After 2b re-confirms, return here for a fresh preview. **No working dir mutations** — Step 2c runs before `mkdir -p <working_dir>` in Step 3. |
| `abort` | Print `"Aborted at Step 2c. No files created. Re-run /create-mobile-app when ready."` and exit cleanly. No working dir, no memory bank, no scaffold. |

After `proceed`, and only after `proceed`, initialize the app identity:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/lib/app-identity.js" "<working_dir>"
```

`app-identity.js` mints `app.json`
`expo.extra.telemetry.appInstanceId`. It is idempotent and contains no app
name, path, environment data, or credential. An `edit` or `abort` response
must not run this command.

Now read
[`build-plan.md`](${CLAUDE_SKILL_DIR}/references/build-plan.md), record the
completed `requirements` milestone, launch its loopback server as a
long-running background process, and open the returned `launchUrl` once. This
is the first point where `_build_plan.html` or any Build Plan artifact may be
created. Retain the process/terminal handle through Step 13; never copy its
token-bearing URL into persisted project documentation.

**Why "always show" is correct in v0** (do not skip without explicit user request):
- Cost when user proceeds: ~30s (read + decide). Token cost ~500/run = ~$0.008.
- Cost when user aborts late (after Step 3 starts): 5-10 min + dirty working dir + frustration.
- Asymmetry: bounded 30s vs unbounded 30 min. Always show the bounded cost.
- Forced calibration: every run produces the `<estimate, actual>` data we need for v0.x model routing decisions. Skipping drops calibration data.

**Set expectations before handing off to the planner:**
> "Brief locked in. The flow has 4 approval prompts:
>  • Gate 1 — Product Experience, adaptive scope, and verified data model
>  • Gate 2 — architecture, native capabilities, and connectors
>  • Gate 3 — materialized design + interactive primary-journey preview
>  • Gate 4 — final implementation summary and confirmation
>
> For Dataverse-required apps, factual foreground milestones will show
> environment, inventory, candidate, detail, and timing counts within 30
> seconds. Connector-only apps skip those metadata milestones. While the
> architect runs, new milestone IDs from
> `.tmp/data-model-planning-status.json` are rendered without inventing
> percentages. If Gate 1 has not surfaced after 15 minutes, inspect the last
> applicable milestone before interrupting. Screen graph/spec compilation runs
> internally between Gates 2 and 3 without adding another prompt."

### Step 2d — Template-only mode
