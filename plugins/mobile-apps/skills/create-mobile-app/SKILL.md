---
name: create-mobile-app
description: Use when the user wants to start a new Power Apps mobile app (Expo / React Native / TypeScript, targeting iOS and Android) from scratch.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Task, EnterPlanMode, ExitPlanMode
model: opus
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first. Covers safety guardrails, memory bank usage, preferred-environment policy, connector-first rule, Windows CLI compat, command-failure handling.

# Create Power Apps Code App (Native)

Top-level orchestrator. Owns the user-visible flow; delegates planning to the `native-app-planner` agent and per-domain mutation to dedicated `/add-*` skills.

**Authoritative interaction contract:** read
[`four-gate-planning.md`](${CLAUDE_SKILL_DIR}/../../shared/references/four-gate-planning.md)
before Step 2. A standard run has exactly four approvals: requirements,
complete architecture, experience, and final implementation confirmation.
Visual previews, progress updates, agent fallbacks, and internal graph/spec
passes must not create extra prompts.

## Workflow

0. Resume check + fresh-template gate → 1. Prerequisites → 2. Gate 1 requirements + cost preview → 3. Internal planning + Gate 2 architecture + Gate 3 experience → 3.8 Gate 4 implementation confirmation → 4. Auth & environment → 5. Prepare existing template → 6. `npx power-apps init` → 6.5 verify `npm install` → **6.5b SafeAreaProvider gate (always runs, idempotent)** → 6.6 scaffold `tsc` smoke check → 6.7 seed memory bank → 6.75 design system → 7. Auth config → 8. Apply data model → 8.5 seed sample data → 8.6 separate offline decision → 9. Apply native capabilities → 9a. Install planned JavaScript dependencies → 9b. Design system integration → 10. Add connectors → 10b. Wire navigation layout → 11. Build screens (parallel) → 11.4 Stylistic fix sweep → 11.5 Trust Report → 12. Start Metro (`npx expo start`) → 12.5 Optional debug handoff → 13. Summary

---

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

After the resume check, run the **fresh-template gate** from the section above. This is a create-only command:

- If `memory-bank.md` exists and the user confirms resume, resume as documented above.
- If any already-created-app marker exists and there is no approved resume path, STOP and tell the user to materialize a fresh template into a new folder with `degit`.
- If required template files are missing, STOP and tell the user to materialize `pa-wrap-tools/templates/expo-app-standalone` into the working directory with `degit` and run `npm install`.
- If `node_modules/expo` is missing, STOP and tell the user to run `npm install` in that template folder before rerunning this skill.

**Do not silently copy a bundled template over the user's folder.** A fresh `pa-wrap-tools-1` template may contain placeholder `power.config.json` with an empty `environmentId`; Step 5 removes that placeholder immediately before Step 6 runs `npx power-apps init`.

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
ENV_JSON=$(node "${CLAUDE_SKILL_DIR}/../../scripts/resolve-environment.js" "$TARGET_ENV")
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

**Orchestrator handling for `exit 2`:** ask the user for their environment ID directly, then re-run the capture block above. Do not run `npx power-apps init` here; Step 6 owns initialization after the user confirms the target environment.

Stash `$ACTIVE_ENV_ID`, `$ACTIVE_ENV_NAME`, `$ACTIVE_ENV_URL`, and `$ACTIVE_TENANT_ID` for Step 2 (env confirmation), Step 6 (`npx power-apps init`), and Step 7 (`auth.config.json` tenant/environment cache). If parsing fails, ask for an environment ID again.

If `resolve-environment.js` cannot get tokens, run `az login --tenant <env-tenant>` in the foreground. If `npx power-apps init` later uses the wrong account, follow shared-instructions standalone CLI auth handling and retry once.

### Step 1.7 — Detect publisher prefix

Detect the publisher prefix for the env's Default solution so the planner uses the correct prefix rather than assuming `cr_`.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/detect-publisher-prefix.js" "$ACTIVE_ENV_URL"
```

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

Do not ask yet. Infer defaults from `$ARGUMENTS` and prepare one Gate 1
structured question containing every missing field:

| Question | Default |
|---|---|
| App display name | derived from description |
| Target platforms | `ios`, `android` (multi-select, default both) |
| Aesthetic | minimal / playful / professional / matches existing brand |
| Target environment | Confirm `<ACTIVE_ENV_URL>` / `<ACTIVE_ENV_ID>` from Step 1.6, or choose "use a different environment" and provide another environment ID |

**App slug is auto-derived** from the display name (`slugify(displayName)` — kebab-case, ASCII-only, strip non-alphanumerics). Do NOT ask the user; the derived slug is correct >95% of the time. Show the resolved slug as part of Step 2c's plan preview so the user can override via `edit` if needed.

If the Gate 1 response chooses a different environment, resolve that supplied
ID and re-render the same Gate 1 summary. This is a revision of Gate 1, not an
additional approval.

**App-name collision pre-flight.** Once `<displayName>` is fixed, check the chosen env for a name collision:

```bash
npx power-apps list-codeapps --environment-id "$ACTIVE_ENV_ID" --json 2>/dev/null | grep -F "<displayName>" >/dev/null && \
  echo "COLLISION" || echo "OK"
```

If `COLLISION`, stage a blocking Gate 1 concern and propose a deterministic
non-colliding suffix (for example `<displayName> Mobile`). Gate 1 `edit` lets
the user choose another name. Do not ask a separate pre-gate question, suggest
destructive deletion, or approve a name that will make initialization fail.

If `npx power-apps list-codeapps` is unavailable in the installed CLI version, skip the pre-flight silently and continue.

Don't enter plan mode here — that's the planner agent's job in Step 3.

### Step 2b — Requirements discovery

> **Goal:** Turn the user's prompt into Gate 1 — one grouped requirements and
> operating-mode approval. The same interaction includes the rough cost preview;
> do not ask a separate brief-confirmation or proceed question.

Read [`references/requirements-discovery.md`](${CLAUDE_SKILL_DIR}/references/requirements-discovery.md)
before scoring the prompt. Its signal inference applies to **every** richness
tier. Only its interactive feature-picker shape is limited to the
`walk-through` path.

#### Step 2b.0 — Prompt richness scoring (decides which path to take)

Before asking anything, score the description on four signals. The score decides whether we ask a multi-select feature picker, a single confirmation, or skip the discovery question entirely.

Run this scorer mentally on `<description>` (the prompt the user gave with `/create-mobile-app`, plus any clarifying text from Step 2a). Count how many of the four trip:

| Signal | Trips when |
|---|---|
| **Word count** | description has ≥ 60 words |
| **Distinct nouns** | description names ≥ 5 distinct domain nouns (people, things, documents, places — e.g. "inspector", "aircraft", "gate", "defect", "evidence") |
| **Action verbs** | description uses ≥ 3 workflow verbs from this set: log, track, submit, assign, notify, scan, upload, approve, verify, complete, capture, override, dispatch, review, sign |
| **Domain phrase** | description names a known industry domain — match against the industry table in [`shared/references/universal-patterns.md`](../../shared/references/universal-patterns.md) (airline, hospital, retail, manufacturing, field-service, finance, logistics, …) OR explicitly says "field operations" / "ground operations" / "site visit" / similar |

Tier the result:

| Score | Tier | What to do |
|---|---|---|
| **4 / 4** | `auto-plan` | Extract silently and present the brief inside Gate 1 with estimates and operating-mode decisions. |
| **3 / 4** | `one-tap` | Extract the brief and present it inside Gate 1. No preliminary confirmation. |
| **≤ 2 / 4** | `walk-through` | Use one context-aware structured Gate 1 question that gathers missing requirements and approves the resulting operating mode. |

Print the chosen tier so the user knows which path is running:

> "→ Prompt richness: 4/4 — skipping discovery questions, extracting brief and going straight to the plan-cost preview." *(or 3/4 / ≤2/4 with the matching path name)*

`--full-discovery` escape hatch: if `$ARGUMENTS` contains `--full-discovery`, force `walk-through` regardless of score. Use this in dogfood runs where you want to exercise the multi-select path.

`--no-discovery` escape hatch: if `$ARGUMENTS` contains `--no-discovery`, force `auto-plan` regardless of score. Use this for fully-headless runs from the wrapper templates repo.

#### Step 2b.1 — Walk-through path (only when tier = `walk-through`)

Infer context-aware feature and operating-mode choices and place them into the
Step 2c Gate 1 question. Do not call `AskUserQuestion` here. The Gate 1
response is both discovery and approval; summarize it into
`<requirements_brief>`.

#### Step 2b.2 — One-tap path (tier = `one-tap`)

Skip the preliminary multi-select. Extract a 6–10 bullet brief directly from
`<description>` and present it only inside Gate 1 with estimates and operating
mode. `Edit` returns to this extraction step; `Abort` exits with no files.

#### Step 2b.3 — Auto-plan path (tier = `auto-plan`)

Skip preliminary discovery. Extract the brief silently, then present it inside
Gate 1 with the cost and operating-mode summary:

> "→ Auto-plan tier (4/4). Extracted brief from your description:
> • *(bullet 1)*
> • *(bullet 2)*
> ...
> → Presenting Gate 1 requirements, operating mode, and cost preview."

Do not ask for confirmation here — the user agreed to this when their prompt scored 4/4. The plan-preview gate at Step 2c remains in force as the last cheap exit before any side effects.

#### Step 2b.4 — Common to all paths

Step 2c renders the Gate 1 summary. It is not a separate prompt after a brief
confirmation; it is the single requirements approval for every richness tier.

Before rendering it, derive `<capability_summary>` from the original prompt and
confirmed brief:

- **Data platform:** `Dataverse required` when Dataverse tables, entities, or
  record workflows are named; otherwise `not yet inferred`.
- **Native outcomes:** every explicit or strongly inferred device outcome, such
  as barcode scanning, camera/photo capture, foreground/background location,
  file picking, PDF generation/viewing, pen input, or sharing. Do not select
  packages yet.
- **External connectors:** every explicitly named or strongly inferred external
  service. Dataverse is the data platform, not an external connector. Generic
  words such as `alert`, `notify`, `document`, or `share` are insufficient
  without a delivery system such as Outlook, Teams, or SharePoint.
- **Not inferred:** high-impact native or integration categories that a user
  could reasonably mistake as included, kept to a short contextual list.

Explicit prompt requirements are selected automatically and must not be asked
again. Strong inferences are shown inside Gate 1 for approval. Ambiguous or
missing high-impact requirements use the same Gate 1 `edit` path or the
walk-through's one grouped question; never create separate native-capability or
connector approval gates.

Track an offline phrase separately as `<offline_signal>`:
`requested — separate profile decision after live Dataverse metadata`,
`not requested`, or `not applicable`. It is visible for transparency but is
not approved at Gate 1 or Gate 2.

Design direction is inferred during planning and approved visually inside Gate
3. `/design-system` later materializes those approved tokens with
`--skip-planning`; it must not ask for brand/style input after Gate 4.

Set `<visual_companion> = yes` by default. `--no-design` keeps an
industry-inferred minimal direction and skips the HTML phone-frame preview, but
Gate 3 still records the experience decision.

### Step 2c — Gate 1: requirements, operating mode, and rough plan preview

> **Goal:** Give the user a cheap exit before any mutation happens. This is the **last point** in the flow with zero side effects — no `git clone`, no `npm install`, no `npx power-apps init`, no agent tokens spent on planning. After Step 3 starts, every abort gets more expensive (half-written `native-app-plan.md`, partial `_screens_section.md`, architect tokens already burnt).

**Always runs. There is no `--no-preview` flag in v0** — we need calibration data (~10+ runs with recorded estimate-vs-actual) before we can trust the rough estimates enough to let users skip them. Once the data shows estimates are reliably within ±50%, evaluate adding a skip flag for repeat-user workflows.

**Compute the estimates from inputs already in hand** (no agent spawn — pure heuristics on the confirmed brief and the wizard answers):

Resolve authentication as part of this same gate. If `$ARGUMENTS` contains an
Entra application/client ID, validate and stage it as `existing-client-id`.
Otherwise stage `configure-later`; do not add a fifth interaction during
implementation. The user may supply/change the client ID through Gate 1
`edit`.

| Output | Input proxy | Computation | Confidence |
|---|---|---|---|
| Tables | Distinct nouns in confirmed brief | `count(unique_nouns) × [0.7, 1.3]` rounded | low — architect may merge or split |
| Connectors | Step 2b inferred connector list | `len(inferred)` (already exact) | high |
| Native outcomes | Step 2b capability summary | `len(explicit + strongly inferred)` | high for explicit, medium for inferred |
| Screens | Confirmed features in brief | `count(features) × [2, 3]` | low — depends on navigation choice |
| Planning min | Tables + screens | `tables × 0.3 + screens × 0.4 + 2` | low |
| Scaffold min | Fixed | `1-2` (template preparation + npm install already happened before skill invocation) | high |
| Build min | Screens, parallel cap of 5 | `ceil(screens / 5) × 0.6` | medium |

Print the block once, exactly in this format (substitute computed values; ranges as `low-high`):

```
─── Plan preview (rough) ─────────────────────────────────
Based on your confirmed brief, before any agent runs:

Capability and integration interpretation (approved here):
  Data platform       <Dataverse required | not yet inferred>
  Native outcomes     <comma-separated explicit/inferred outcomes | none inferred>
  External connectors <comma-separated API/service names | none inferred>
  Authentication      <existing client ID: GUID | configure later>
  Not inferred        <short contextual list, e.g. location, notifications, contacts | none>
  Offline signal      <requested — separate decision after live metadata | not requested | not applicable>
                      ← informational only; outside Gate 1 and Gate 2 approval

Scope (proxy estimates — actual numbers come from architects):
  Tables       ~<low>-<high>      ← from <N> nouns in brief; architect may merge/split
  Connectors    <N> inferred      ← external services only; exact bindings confirmed at Gate 2
  Native        <N> inferred      ← outcomes only; packages and permissions confirmed at Gate 2
  Screens     ~<low>-<high>       ← from <N> features × ~2-3 screens each
  Approval gates  4               ← fixed (requirements, architecture, experience, build confirmation)

Time (rough — agent time only, excludes your approval latency at gates):
  Planning      ~<low>-<high> min ← architects + your gate approvals add to this
  Scaffolding   ~1-2 min          ← validates prepared template + runs power-apps init
  Screen build  ~<low>-<high> min ← parallel, capped at 5 concurrent

Token tier: Opus everywhere in v0 (model routing not yet shipped).

⚠ These are proxies, not measurements:
  • Table count is "noun count in brief" — architect may collapse or split
  • Time excludes your approval latency at the 4 gates
  • If any gate is rejected, that section regenerates (~2-3 min each)

Approve requirements, edit, or abort? [approve/edit/abort]
─────────────────────────────────────────────────────────
```

**Three-option exit:**

| User answer | Action |
|---|---|
| `approve` (or empty / Enter) | Mark Gate 1, including its capability/connector interpretation and authentication decision, approved and continue to Step 3. Default. |
| `edit` | Jump back to Step 2b. Re-confirm the brief with the user's changes. After 2b re-confirms, return here for a fresh preview. **No working dir mutations** — Step 2c runs before `mkdir -p <working_dir>` in Step 3. |
| `abort` | Print `"Aborted at Step 2c. No files created. Re-run /create-mobile-app when ready."` and exit cleanly. No working dir, no memory bank, no scaffold. |

**Why "always show" is correct in v0** (do not skip without explicit user request):
- Cost when user proceeds: ~30s (read + decide). Token cost ~500/run = ~$0.008.
- Cost when user aborts late (after Step 3 starts): 5-10 min + dirty working dir + frustration.
- Asymmetry: bounded 30s vs unbounded 30 min. Always show the bounded cost.
- Forced calibration: every run produces the `<estimate, actual>` data we need for v0.x model routing decisions. Skipping drops calibration data.

**Set expectations before handing off to the planner:**
> "Gate 1 approved. Planning now performs autonomous architecture and
> experience work, then surfaces:
>  • Gate 2 — complete architecture, including exact native capabilities,
>    permissions, connectors, and data bindings
>  • Gate 3 — screens and design experience
>  • Gate 4 — final implementation confirmation
>
> Progress remains visible in `mobile-app-status.json` and the terminal. When a
> gate is ready, the plan preview shows an input-required banner."

### Step 2d — Template-only mode

No background scaffold pipeline is used. The template is already present in `<working_dir>` and dependencies are expected to be installed before this skill starts (`npm install`). Continue directly to Step 3.

### Step 3 — Plan (internal work + Gates 2 and 3)

First, create the empty working directory so the planner has a place to write:

```bash
mkdir -p <working_dir>
```

Seed visible progress immediately:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-plan-status.js" \
  --project-root "<working_dir>" \
  --phase "architecture" \
  --message "Preparing agent inputs and Dataverse snapshot" \
  --state "running" \
  --completed 1 --total 4 \
  --awaiting-input false
```

Immediately render the current run's Plan HTML. The renderer supports a
not-yet-created `native-app-plan.md`, so this first page is a useful
planning-progress shell rather than a stale artifact from another run:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/render-mobile-plan.js" \
  --plan "<working_dir>/native-app-plan.md" \
  --status "<working_dir>/mobile-app-status.json" \
  --output "<working_dir>/mobile-app-plan.html"
```

Start the loopback-only planning companion as a background process:

```bash
rm -f "<working_dir>/.tmp/mobile-plan-companion.json"
node "${CLAUDE_SKILL_DIR}/../../scripts/serve-mobile-plan.js" \
  --project-root "<working_dir>"
```

Use an async/background Bash invocation and retain the terminal ID. Wait at
most five seconds for `.tmp/mobile-plan-companion.json`, then read its `url`.
The URL contains an ephemeral token and the server binds only to
`127.0.0.1`. Print:

> "Live planning companion: <url>"

When `<visual_companion> = yes`, open that URL now using the OS-portable
`open` / `xdg-open` / PowerShell chain from Step 3b. Do not wait for Gate 2.
When `<visual_companion> = no`, print the URL without opening it.

The companion uses Server-Sent Events—no interval polling and no periodic
page reload. Status-file changes update the progress header and terminal-input
banner in place. Re-render `mobile-app-plan.html` only when a meaningful
artifact changes: architecture draft, screen graph, screen-spec batch,
experience preview, audit result, or gate state. The companion emits one plan
event for that artifact update and preserves the selected tab, expanded
sections, and scroll position across the milestone refresh. It never refreshes
while the ER editor is active.

If the companion fails to start, print and open
`file://<working_dir>/mobile-app-plan.html` as a static fallback and continue
with terminal progress. Record the companion terminal ID and URL for cleanup
and resume handling.

### Outcome-driven progress contract

Planning percentages alone are not sufficient once implementation starts.
Maintain durable user-visible outcomes in `mobile-app-status.json`; the Plan
HTML renders them under **Implementation status → Delivery outcomes**.

Use these canonical outcomes in order:

| Outcome ID | Label | Complete when | Artifact |
|---|---|---|---|
| `architecture-approved` | Architecture and experience approved | Gate 4 is approved | `native-app-plan.md` |
| `scaffold-ready` | App scaffold ready | Scaffold TypeScript gate passes | `power.config.json` |
| `data-layer-ready` | Data layer ready | Dataverse services and sample fixtures pass validation | `.datamodel-manifest.json` |
| `offline-ready` | Separate offline decision complete | The post-Dataverse offline prompt is answered and any selected profile workflow completes | `offline-profile.json` when present |
| `capabilities-ready` | Design, native capabilities, and connectors ready | Steps 9–10 pass their gates | `brand/design-system.html` when present |
| `screens-ready` | Application screens ready | All screen waves pass TypeScript | generated screen routes |
| `quality-ready` | Quality review complete | Step 11.4 and final TypeScript gate pass | `memory-bank.md` concerns/policies |
| `app-running` | App ready to run | Metro starts, the QR is generated, and the launch page is ready | `mobile-app-launch.html` |

Before starting an outcome, write it as `running`; after its gate succeeds,
write it as `completed`. Use `blocked` when the flow stops. Example:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-plan-status.js" \
  --project-root "<working_dir>" \
  --phase "data implementation" \
  --message "Creating and validating the Dataverse data layer" \
  --outcome-total 8 \
  --outcome-id "data-layer-ready" \
  --outcome-label "Data layer ready" \
  --outcome-state "running" \
  --outcome-detail "Reconciling tables, generated services, and sample fixtures" \
  --outcome-artifact ".datamodel-manifest.json"
```

Re-render `mobile-app-plan.html` after every outcome state change. Do not mark
an outcome complete because commands started; its measurable gate must pass.
Existing gate approval progress remains visible until the first implementation
outcome is recorded.

**Capability preflight before dispatch:** resolve the environment and write the
normalized metadata snapshot in the foreground. Verify the planner/leaf agent
is registered, all input paths are readable, and each output path is writable.
Pass the snapshot path explicitly. If any requirement fails, select the inline
fallback before spawning; do not launch an agent to discover a predictable
capability failure after several minutes. Follow the capability table in
`four-gate-planning.md`.

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/create-dataverse-snapshot.js" \
  --env-url "<resolved_environment_url>" \
  --output "<working_dir>/.tmp/dataverse-metadata-snapshot.json" \
  --tenant-id "<resolved_tenant_id>" \
  --concepts "<comma-separated domain nouns from requirements_brief>"

node "${CLAUDE_SKILL_DIR}/../../scripts/agent-preflight.js" \
  --agent native-app-planner \
  --working-dir "<working_dir>" \
  --plugin-root "${CLAUDE_SKILL_DIR}/../.." \
  --snapshot "<working_dir>/.tmp/dataverse-metadata-snapshot.json"
```

`status: fallback` routes directly to the returned fallback strategy. Run the
same helper before every direct leaf-agent dispatch in inline mode.

The concepts list must include every named data noun and workflow family from
the approved brief, not a representative subset. Preserve header/child
families such as `stock transfers`, `cycle counts`, `damage reports`, and
`evidence photos`; do not omit a workflow because another related noun appears.
The snapshot selector normalizes plural concepts, prefers the shortest
unversioned schema in the best matching publisher family, and expands matching
header/line/photo families. This prevents similarly named versioned test
schemas from crowding out the exact tables required for Gate 2.

**Hard rule — planner writes are restricted during Step 3.** The planner (and any sub-agents it spawns) is permitted to write to **only**:

- `<working_dir>/native-app-plan.md`
- `<working_dir>/_screens_section.md`
- `<working_dir>/mobile-app-plan.html`
- `<working_dir>/mobile-app-status.json`
- `<working_dir>/.tmp/*`

All other paths in `<working_dir>/` (notably `app/`, `src/`, `package.json`, `power.config.json`, `tamagui.config.ts`, `tsconfig.json`, `node_modules/`, `memory-bank.md`) are owned by the foreground setup phases. Do not mutate them during planning.

If the planner needs to record a `DONE_WITH_CONCERNS` from a sub-agent (data-model architect, screen-planner), add it to an in-memory queue `DEFERRED_CONCERNS[]` during Step 3. Do not write `memory-bank.md` yet. Step 6.7 must always flush `DEFERRED_CONCERNS[]` into `memory-bank.md` `## Concerns` immediately after the file is created.

**Resume-from-draft check.** Before spawning, check if `<working_dir>/native-app-plan.md` already exists with content. If yes, a previous planner run (possibly in a degraded context with no `Task`/gate tools) already drafted sections. Read it. If it has populated `## Data Model` / `## Native Capabilities` / `## Connectors` but the gates were never run (no `## Approvals` block, or the file was authored by an agent that returned `BLOCKED: tool surface missing`), pass `resume_from_draft: true` and the existing path to the planner so it loads the draft as baseline instead of regenerating from scratch.

**Planner preflight (silent).** Before the full Task spawn, do a no-op `Task` probe for `mobile-app:native-app-planner` (same pattern as Step 11.0). If the probe fails with `Agent type … not found`, `tool unavailable`, or the host clearly cannot route nested agents, fall through to **inline-gate mode** (described below) without prompting. The orchestrator has the full tool surface itself — it can run the gates directly. Do not retry, do not ask the user.

**Announce the handoff before the Task call** (so the user isn't staring at a blank screen while the planner spins up):
> "→ Spawning planner agent. First prompt (data model) appears in ~60–90 seconds while the data-model architect analyzes your requirements. Later gates take longer — see the timing breakdown above."

Then spawn the `mobile-app:native-app-planner` agent via `Task` (the plugin name `mobile-app:` prefix is required — without it `Task` returns `Agent type not found`). The planner is draft-only: nested agents never own user approval tools.

```
Spawn agent: mobile-app:native-app-planner

Prompt:
  Plan a Power Apps mobile app.

  Requirements brief (confirmed with user):
  <requirements_brief — bullet points from Step 2b>

  Design planning: <"infer-and-approve-at-gate-3" or "minimal-no-preview" when --no-design>
  Visual companion: <visual_companion — "yes" or "no">

  Original prompt: <full $ARGUMENTS verbatim>
  Wizard answers: <Step 2 answers>
  Gate 1 capability interpretation: <capability_summary verbatim>
  Gate 1 authentication: <existing-client-id: GUID | configure-later>
  Working directory: <absolute path of <working_dir>>
  Plugin root: ${CLAUDE_SKILL_DIR}/../../
  Dataverse metadata snapshot: <working_dir>/.tmp/dataverse-metadata-snapshot.json
  Agent preflight result: <paste JSON from scripts/agent-preflight.js>
  Publisher prefix (detected from env): <DETECTED_PUBLISHER_PREFIX from Step 1.7, e.g. "cr8142a" — use literally as `<prefix>_<entity>` in all logical names. If empty/NOT DETECTED, fall back to `cr` placeholder and surface a `DONE_WITH_CONCERNS` note that Dataverse will normalize at create time.>

  phase: architecture

  Follow native-app-planner.md. Draft Gate 2 architecture only: data model,
  ER columns and relationships, rationale, shared operational context, native
  capabilities, connectors, risks, and blockers. Do not generate the screen
  graph, detailed screen specs, or experience preview yet. Do not ask the user
  or enter plan mode. Gate 1 is already approved; the foreground orchestrator
  owns Gates 2, 3, and 4. Update the live planning companion at every
  architecture milestone. On terminal return, emit one of
  `DONE` / `DONE_WITH_CONCERNS:` / `NEEDS_CONTEXT:` / `BLOCKED:` as the literal
  first line per AGENTS.md rule #10.
```

The planner writes the architecture draft and renders `mobile-app-plan.html`.
After it returns, the foreground orchestrator presents Gate 2 immediately.
Detailed experience planning must not delay the first architecture review.

#### 3.0a — Inline-draft fallback (planner unavailable OR capability preflight failed)

When preflight fails OR the planner returns a capability `BLOCKED`, the
orchestrator drafts the missing sections inline. Do not re-spawn with the same
context. Gate presentation remains the same foreground flow described below.

> "→ Planner agent unavailable in this host — drafting the plan inline from the foreground snapshot. (No action needed.)"

Then execute, in order, using your own `EnterPlanMode` + `AskUserQuestion`:

1. **If a draft `native-app-plan.md` exists:** read populated sections as an
   internal baseline. Do not present them separately. Complete missing
   projections, screen bindings, and risks, then show the single combined
   Gate 2. Remove any stale offline-profile section from older drafts; offline
   setup is handled separately after Dataverse implementation.
2. **If no draft exists:** spawn `mobile-app:data-model-architect`
   directly via `Task` (single architect, not the orchestrator agent) to draft
   `## Data Model`; then build `## Native Capabilities`, `## Design Direction`,
   and `## Connectors` inline from the brief. Render and present Gate 2 now.
   Do not spawn `screen-planner` until Gate 2 is approved.

  **MUST forward `$DETECTED_PUBLISHER_PREFIX` from Step 1.7 in the architect prompt** — same line as the planner prompt at Step 3 line 1034: *"Publisher prefix (detected from env): `<DETECTED_PUBLISHER_PREFIX>` — use literally as `<prefix>_<entity>` in all logical names. If empty/NOT DETECTED, fall back to `cr` placeholder and surface a `DONE_WITH_CONCERNS` note that Dataverse will normalize at create time."* Without this, the architect defaults to `cr_` and the whole plan needs a post-hoc sweep when the real prefix is something else (e.g. `cr3e9`).

   **Why this works even though the planner just returned BLOCKED for tool surface:** the orchestrator (this skill, running in the user's slash-command session) always has the full tool surface — Task, EnterPlanMode, ExitPlanMode, AskUserQuestion, Read, Write, Bash. What's missing is the surface inside *nested* agent contexts (the `native-app-planner` agent runs in a sandbox without EnterPlanMode/AskUserQuestion, which is why its Step 0 preflight returned BLOCKED). The leaf agents `data-model-architect` and `screen-planner` only need Read/Write/Bash to draft markdown — they don't need EnterPlanMode/AskUserQuestion themselves. Spawn them; the orchestrator owns the gates.

3. Finish the architecture-level shared operational-context contract and
   cross-entity resolution rules before Gate 2. After Gate 2 approval, spawn
   `mobile-app:screen-planner` with `phase: graph` and `phase: specs`.

   **Before each `screen-planner` spawn, print a one-line ETA so the user knows
   the agent is live and roughly how long to wait**:
   - Before `phase: graph`: `> "→ Preparing the Gate 3 screen graph internally (~2 min)…"`
   - Before `phase: specs`: `> "→ Expanding Gate 3 screen specs in visible batches (~1 min/screen, ~${N} min for ${N} screens)…"`
4. Write the draft `native-app-plan.md` with only Gate 1 recorded in
   `## Approvals`. The common foreground flow records Gates 2 and 3; Step 3.8
   records Gate 4 immediately before mutation.

   **HARD RULES for the plan structure (mirror the planner agent's template at [`agents/native-app-planner.md`](${CLAUDE_SKILL_DIR}/../../agents/native-app-planner.md) Step 4):**
   - Top-level headings are EXACTLY: `## Overview`, `## App Requirements`, `## Data Model`, `## Native Capabilities`, `## Design Direction`, `## Connectors`, `## Screens`, `## Approvals`. Do NOT invent a `## Brief` super-section that nests the data model under it.
   - `## Overview` must include `Authentication:
     <existing-client-id: GUID | configure-later>` exactly as approved at Gate
     1 so Step 7 can apply it without another prompt.
   - `## App Requirements` is the user's confirmed brief verbatim (the `<requirements_brief>` from Step 2b), capped at ~80 lines. No expansion, no rewriting, no embedded preview of the data model.
   - Discovery failure notes (e.g. `az login` on the wrong tenant, 401 from `dataverse-request.js`, all entities classified Create) go to `<working_dir>/memory-bank.md` under `## Discovery Notes`, NOT into the plan. Keep at most a single one-line breadcrumb in `## Data Model` like `> Discovery skipped — see memory-bank.md.` if relevant.
   - Sample data notes, immutability plug-in notes, file-column setup notes, dispatch-block server rules go under a single `### Notes` subsection in `## Data Model`. Cap each at 2 sentences; link to `post-deployment-tasks.md` for longer write-ups instead of inlining.

If the orchestrator's own `Task` tool is unavailable, use fully-inline mode:
draft from the foreground Dataverse snapshot and screen references. Gate 1 is
already approved; the foreground flow still owns Gates 2–4.

**Hard rule:** never delegate Gate 2 or Gate 3 to a nested agent and never skip
them because drafting fell back. No mutation begins until Step 3.8 records
Gate 4.

#### 3.0b — Foreground Gate 2, then progressive Gate 3 (always)

After either the architecture planner draft or inline-draft fallback
completes, the foreground orchestrator owns both approvals:

1. Verify the architecture draft contains the data model, cross-entity
   projections, native capabilities, connectors, and a **Shared Operational Context**
   contract naming the authoritative role source and active-scope source. If a
   screen depends on role or store/site scope and no authoritative source is
   available, mark it as a Gate 2 blocker; do not let builders invent local
   role checks or active-store state.
2. Render `mobile-app-plan.html`, set status `awaitingInput: true`, and enter
   plan mode with exactly one architecture approval:

   ```text
   Gate 2 of 4 — Complete Architecture
   Approve the data model, projections, shared operational context, native
   capabilities, connectors, risks, and blockers?
   ```

   The ER diagram in the planning companion is editable. Gate 2 options are
   `Approve architecture`, `Apply browser revision`, `Revise architecture`,
   and `Abort`.

   `Apply browser revision` reads
   `<working_dir>/.tmp/mobile-er-revision.json`. Require
   `kind: mobile-er-revision`, `gate: 2`, the current status `startedAt` as
   `runId`, a `basePlanSha256` matching the current `native-app-plan.md`, and
   non-empty unique entity and field names. Pass the complete payload to the
   existing planner in `phase: architecture-revision`. Regenerate the data
   model, rationale, cross-entity contracts, capabilities affected by schema,
   and blockers before re-rendering. Archive the consumed payload under
   `.tmp/` with `.applied.json`; never mutate Dataverse from browser edits.

   On rejection, send the feedback to the existing idle planner when possible,
   otherwise re-spawn it in draft-only revision mode. Re-render and present
   Gate 2 again from the foreground.
3. After Gate 2 approval, update status to
   `Designing navigation and screen experience`, preserving `completed: 2 /
   total: 4`. Resume the existing planner when possible, otherwise re-spawn it
   with:

   ```text
   phase: experience
   Architecture in native-app-plan.md is Gate 2 approved and immutable unless
   an experience dependency proves it invalid. Generate navigation, screen
   graph, shared conventions, detailed specs in visible batches, design
   direction preview, and the cross-entity screen audit. Update the planning
   companion after the graph and every batch. Return draft-only.
   ```

   Only now run the two-phase screen planner. Open the generated preview per
   Step 3b, then enter plan mode with exactly
   one experience approval:

   ```text
   Gate 3 of 4 — Experience
   Approve the screen graph, navigation, detailed specs, and design preview?
   ```

   On rejection, revise the draft through the planner without giving it
   approval ownership, then re-render and present Gate 3 again.
4. Clear `awaitingInput` and append the approved Gate 2 and Gate 3 entries to
   `## Approvals`.

#### 3.0 — Sub-agent return-status switch (canonical)

Use the plugin-wide protocol in [`AGENTS.md`](${CLAUDE_SKILL_DIR}/../../AGENTS.md) rule #10 for every `Task` return in this skill: planner, parallel screen-builders, and future agent spawns. Parse the literal first line and branch: `DONE` continues; `DONE_WITH_CONCERNS:` surfaces + records in `memory-bank.md`; `NEEDS_CONTEXT:` re-dispatches with missing context, capped at 2 retries; `BLOCKED:` stops and records under `## Blocks`. Unknown first lines are malformed and must be treated as `BLOCKED`.

Special case for a direct or inline `data-model-architect` dispatch:
`NEEDS_CONTEXT: detailed-dataverse-metadata:<logical names>` means the table
exists in snapshot inventory but lacks detailed columns/relationships. Rerun
`create-dataverse-snapshot.js` to the same output path with the original
concepts plus those exact `--tables` names, then re-dispatch once. Do not let
Gate 2 defer exact validation to Step 8.

Legacy planner-only early-return signals are handled before the status switch:
convert their options into a least-assumptive draft, re-spawn without asking,
and surface the alternatives inside Gate 3.

#### Step 3.0a — Industry confirmation handoff (orchestrator-owned)

When the planner is uncertain about which industry the app belongs to (no keyword match, ambiguous match, or wizard-aesthetic conflict), it returns early with this single line as its message:

```
INDUSTRY_CONFIRM_REQUESTED: <inferred-industry>|<reason-code>|<top-3-alternatives-comma-sep>
```

Example: `INDUSTRY_CONFIRM_REQUESTED: productivity|no-keywords|field-ops,healthcare,e-commerce`

Legacy planner outputs may emit `INDUSTRY_CONFIRM_REQUESTED:`. Do not add a
separate prompt. Convert the signal into a low-confidence design concern and
present the inferred industry, reason, and alternatives inside Gate 3. Resume
the same planner flow with the least-assumptive alternative as the draft; Gate
3 feedback is the only place the user changes it.

#### Step 3a — Legacy style-picker signal

If a legacy planner emits `DESIGN_VIBE_REQUESTED:`, fold its options into Gate
3 and continue. Do not run a separate picker or defer design until after Gate
4.

If no legacy design signal is returned, continue directly to Step 3b.

#### Step 3b — Open the plan preview in the user's browser (orchestrator-owned)

The planner emits a line of the form `PLAN_PREVIEW_PATH: file://<abs-path>/_plan_preview.html` with its Gate 3 draft. The planner itself does NOT open the browser — sub-agent shells often lose GUI context, and silent open-failures leave the user staring at the spinner with no preview. The orchestrator owns this step because it has the user's interactive session.

**When to run this:** every time the foreground orchestrator presents or re-presents Gate 3. Detection: scan the planner's most recent visible output for the `PLAN_PREVIEW_PATH:` token; the value after the colon is the absolute `file://` URL.

**What to do:**

1. Print the link in a dedicated message so the user always has the fallback (clickable in most terminals):

   > "Plan-time visual preview: file://<abs-path>/_plan_preview.html"

2. **If `<visual_companion> = no`, stop here.** Do not attempt to open a browser. The user explicitly opted out; the printed link is their handle. Continue immediately to the foreground Gate 3 prompt.

3. **Else** attempt to open in the user's default browser via the OS-portable chain:

   ```bash
   open "<abs-path>/_plan_preview.html" 2>/dev/null \
     || xdg-open "<abs-path>/_plan_preview.html" 2>/dev/null \
     || powershell.exe -NoProfile -Command "Start-Process '<abs-path>\_plan_preview.html'" 2>/dev/null \
     || echo "Auto-open failed. Use the link above."
   ```

4. Do NOT block on success. If the chain prints "Auto-open failed", the link from step 1 is the user's fallback. Continue immediately so the foreground Gate 3 prompt surfaces without delay.

If the planner returns without a preview path, render
`mobile-app-plan.html` with `scripts/render-mobile-plan.js` before Gate 3. A
standard run must visually review design and screens at Gate 3.

#### 3.9 — Post-plan publisher-prefix gate

Before continuing to Step 4, verify the written `native-app-plan.md` actually uses `$DETECTED_PUBLISHER_PREFIX` from Step 1.7. Catches both the inline-fallback path missing the prefix and an architect that ignored the instruction.

```bash
if [ -n "$DETECTED_PUBLISHER_PREFIX" ]; then
  WRONG=$(grep -oE 'cr[a-z0-9]*_[a-z][a-z0-9_]*' "$WORKING_DIR/native-app-plan.md" \
    | grep -vE "^${DETECTED_PUBLISHER_PREFIX}_" | sort -u || true)
  if [ -n "$WRONG" ]; then
    echo "PLAN PREFIX MISMATCH — expected ${DETECTED_PUBLISHER_PREFIX}_, found:"
    echo "$WRONG"
  fi
fi
```

If mismatches are reported, sweep `native-app-plan.md` (and any auxiliary files like `.datamodel-manifest.json` if already written) replacing the wrong prefix with `${DETECTED_PUBLISHER_PREFIX}_` before Step 4. Do NOT proceed to Step 5 with a wrong-prefix plan — the sweep cost grows ~500 occurrences once services are generated.

### Step 3.8 — Gate 4: final implementation confirmation

Update status and render the latest plan:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/mobile-plan-status.js" \
  --project-root "<working_dir>" \
  --phase "implementation confirmation" \
  --message "Final scope is ready for approval" \
  --state "waiting" \
  --completed 3 --total 4 \
  --awaiting-input true \
  --input-prompt "Return to the terminal to approve implementation."

node "${CLAUDE_SKILL_DIR}/../../scripts/render-mobile-plan.js" \
  --plan "<working_dir>/native-app-plan.md" \
  --status "<working_dir>/mobile-app-status.json" \
  --output "<working_dir>/mobile-app-plan.html"
```

Open/print `mobile-app-plan.html`, then present exactly one confirmation
containing:

- included and deferred scope;
- target environment and solution;
- expected duration;
- sample-data fixture count;
- auth/deployment requirements;
- readiness blockers.

Options: `Begin implementation`, `Revise plan`, `Abort`. On approval, append
Gate 4 to `## Approvals` and immediately clear `awaitingInput`. `Revise plan`
returns to the affected Gate 2 or Gate 3 section without reopening unrelated
approvals.

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

Then apply these **safe idempotent** prep steps:

1. Update app identity in `app.config.js` and `package.json` from Step 2 answers (`displayName`, `slug`) using targeted string replacements only.
2. Ensure `src/generated/index.ts` exists with the empty generated barrel if no generated services exist.
3. Ensure `src/components/`, `src/hooks/`, `src/utils/`, `src/tokens/`, and `src/native/` directories exist.
4. Copy shared helper files from plugin samples only when the destination file is missing. Do not overwrite user-edited files.
5. Merge the six path aliases and their wildcard forms into `tsconfig.json` (`@/components`, `@/components/*`, …, `@/native`, `@/native/*`) without deleting existing aliases.
6. Verify `app/_layout.tsx` imports `PowerAppsProvider` from `@microsoft/power-apps-native-host` and imports `tamaguiConfig`. If either is missing, patch `_layout.tsx` conservatively; do not rewrite custom navigation or unrelated provider code.
7. Remove placeholder `power.config.json` if its `environmentId` is empty or missing. `npx power-apps init` in Step 6 writes the real file for the selected environment.

Do **not** preserve placeholder `power.config.json` from the template. Keeping it would let downstream steps read an empty or stale environment.

After preparation, continue to Step 6.

**Fix 1 — App identity in `app.config.js` and `package.json`**

Substitute the hardcoded template values with wizard answers from Step 2:

| Find | Replace with |
|---|---|
| `const APP_NAME = process.env.APP_DISPLAY_NAME || 'Power Apps Standalone App';` | `const APP_NAME = process.env.APP_DISPLAY_NAME || '<displayName>';` |
| `const APP_SLUG = process.env.APP_SLUG || 'powerapps-standalone-app';` | `const APP_SLUG = process.env.APP_SLUG || '<slug>';` |
| `"name": "powerapps-standalone-app"` | `"name": "<slug>"` |

Bundle ID and scheme are left as template defaults — they are fixed across all dev builds and patched by the wrap pipeline at release time.

**Fix 2 — Delete `power.config.json`**

`npx power-apps init` in Step 6 creates the correct one for the user's environment. Remove the template copy:

```bash
rm -f "<working_dir>/power.config.json"
```

**Fix 3 — Clean `src/generated/` and `src/hooks/` (idempotent)**

Newer template snapshots **no longer ship** the example models / services / hooks (Contacts / Accounts / UserProfile / Office365Users) — `src/` only contains app infrastructure files such as `global.d.ts` and `playerConfig.ts`. Older snapshots still do. If a copied template includes `src/queryClient.ts`, remove it: `PowerAppsProvider` already owns the React Query `QueryClientProvider` and screen code should use `useQueryClient()`, not an app-owned singleton. The block below is **idempotent** — a no-op on the new template, a real cleanup on the old one. Always run it; never assume one snapshot.

```bash
# Remove example generated artefacts if present (no error if missing)
rm -rf "<working_dir>/src/generated/models" \
        "<working_dir>/src/generated/services" \
        "<working_dir>/src/generated/index.ts"

# Wipe example React Query hooks and stale app-owned query client if present
rm -f  "<working_dir>/src/hooks/useContacts.ts" \
  "<working_dir>/src/hooks/useAccounts.ts" \
  "<working_dir>/src/hooks/useUserProfile.ts" \
  "<working_dir>/src/queryClient.ts"

# Reset the generated barrel so `import … from '../generated'` resolves to nothing
mkdir -p "<working_dir>/src/generated"
printf '// Populated by npx power-apps add-data-source. Do not edit.\nexport {};\n' \
  > "<working_dir>/src/generated/index.ts"
```

**Do NOT overwrite `app/(app)/home.tsx` here.** The current template ships a minimal RN stub (`View` + `Text` from `react-native`) that compiles cleanly. Our screen-builder replaces it at Step 11. Replacing it with a Tamagui stub before Fix 8 (which threads brand `tamaguiConfig` into `PowerAppsProvider`) would render under the upstream default Tamagui config instead of the project's brand tokens.

Keep `src/hooks/` itself — screen-builders write new hooks into it.

**Fix 3b — Scan for dangling imports referencing deleted files (back-compat only)**

Only meaningful on older template snapshots that shipped the example hooks. On the current template the scan returns zero matches and you can skip it. Run it unconditionally — it is fast and self-skipping.

```bash
# Scan for any remaining imports of the deleted modules
grep -rn \
  -e "useContacts" \
  -e "useAccounts" \
  -e "useUserProfile" \
  -e "from.*generated/services" \
  -e "from.*generated/models" \
  --include="*.ts" --include="*.tsx" \
  "<working_dir>/app/" "<working_dir>/src/" \
  || true
```

**If matches found:**
- For screen files (`app/(app)/*.tsx`): replace the entire file with the same minimal stub used for `home.tsx` (screen-builder will overwrite at Step 11).
- For layout files (`_layout.tsx`): remove only the import lines and any code referencing the deleted symbols. Do NOT replace the whole file — layouts have navigation structure that must be preserved.
- For barrel/index files: remove the re-export lines.

**If no matches:** Continue — template is clean.

**Fix 6 — Schema generation boundary**

`app/_layout.tsx` imports `schemaMap` from `src/generated/connectorSchemas.ts`, which is generated by `npm run generate-schemas` (the `generate-connector-schemas` binary from the `@microsoft/power-apps-cli` devDep). Do not generate an empty schema map during initial scaffold: the template's `@ts-ignore` boundary lets `tsc` validate the scaffold without that artifact, and schema generation is more useful after a data source exists or immediately before dev/build entry points.

Do NOT hand-write a stub `connectorSchemas.ts` — the generated output has a specific shape that downstream code depends on; a placeholder will break `npx power-apps push`.

**Why `tsc` already passes post-clone (current template, PR #30):** the template's `app/_layout.tsx` and `src/playerConfig.ts` carry `// @ts-ignore` comments above the `power.config.json` and `connectorSchemas` imports specifically so the project type-checks before `power.config.json` and `connectorSchemas.ts` exist. **Never strip these `@ts-ignore` lines** — Fix 8 below preserves them when patching `app/_layout.tsx` to thread the project's `tamaguiConfig` into `PowerAppsProvider`, and any future `Edit` to either file MUST keep them. Removing them resurfaces a `tsc` failure against missing generated files.

**Fix 7 — Create `src/components/`, `src/hooks/`, `src/utils/`, `src/tokens/`**

Copy the shared code structure into the project. This gives screen-builders a production-grade layout with path aliases:

```bash
mkdir -p "<working_dir>/src/components"
mkdir -p "<working_dir>/src/hooks"
mkdir -p "<working_dir>/src/utils"
mkdir -p "<working_dir>/src/tokens"

cp "${CLAUDE_SKILL_DIR}/../../shared/samples/src/components/index.tsx" "<working_dir>/src/components/index.tsx"
cp "${CLAUDE_SKILL_DIR}/../../shared/samples/src/hooks/index.ts" "<working_dir>/src/hooks/index.ts"
cp "${CLAUDE_SKILL_DIR}/../../shared/samples/src/hooks/useCursorListData.ts" "<working_dir>/src/hooks/useCursorListData.ts"
cp "${CLAUDE_SKILL_DIR}/../../shared/samples/src/hooks/useListData.ts" "<working_dir>/src/hooks/useListData.ts"
cp "${CLAUDE_SKILL_DIR}/../../shared/samples/src/hooks/useSearchFilter.ts" "<working_dir>/src/hooks/useSearchFilter.ts"
cp "${CLAUDE_SKILL_DIR}/../../shared/samples/src/utils/index.ts" "<working_dir>/src/utils/index.ts"
cp "${CLAUDE_SKILL_DIR}/../../shared/samples/src/utils/formatters.ts" "<working_dir>/src/utils/formatters.ts"
cp "${CLAUDE_SKILL_DIR}/../../shared/samples/src/utils/text.ts" "<working_dir>/src/utils/text.ts"
cp "${CLAUDE_SKILL_DIR}/../../shared/samples/src/utils/choices.ts" "<working_dir>/src/utils/choices.ts"
cp "${CLAUDE_SKILL_DIR}/../../shared/samples/src/utils/dataverse.ts" "<working_dir>/src/utils/dataverse.ts"
cp "${CLAUDE_SKILL_DIR}/../../shared/samples/src/tokens/index.ts" "<working_dir>/src/tokens/index.ts"
```

**Fix 8 — Thread the project's `tamaguiConfig` into the host provider** (required so screens render under brand tokens, not upstream defaults)

The template ships `PowerAppsProvider` (composed-tree API, v0.2.0+). Fix 8 adds `tamaguiConfig`, `defaultTheme`, `theme`, and `darkTheme` props so screens render under brand tokens. Do NOT add an outer `<TamaguiProvider>` — `PowerAppsProvider` composes it internally and duplicating triggers "useTheme must be used within a TamaguiProvider" warnings on hot reload.

Write `app/_layout.tsx` (run AFTER `npm install`):

```tsx
import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { PowerAppsProvider, lightTheme, darkTheme } from '@microsoft/power-apps-native-host';
import type { ThemeTokens } from '@microsoft/power-apps-native-host';

import authConfig from '../auth.config.json';
// @ts-ignore - power.config.json is auto-generated at build time
import powerConfig from '../power.config.json';
// @ts-ignore - connectorSchemas is auto-generated at build time
import { schemaMap } from '../src/generated/connectorSchemas';
import tamaguiConfig from '../tamagui.config';

// lightTheme / darkTheme are the built-in defaults from @microsoft/power-apps-native-host.
// When brand/tokens.ts exists, the Brand-token wiring block (Step 9b) replaces
// these props with brand-derived ThemeTokens objects instead.

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <SafeAreaProvider>
      <PowerAppsProvider
        msalConfig={authConfig.msal}
        powerConfig={powerConfig}
        schemaMap={schemaMap}
        tamaguiConfig={tamaguiConfig}
        defaultTheme={colorScheme === 'dark' ? 'dark' : 'light'}
        theme={lightTheme}
        darkTheme={darkTheme}
      >
        <StatusBar style="auto" />
        <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1 }}>
          <Slot />
        </SafeAreaView>
      </PowerAppsProvider>
    </SafeAreaProvider>
  );
}
```

Key points:
- **Do NOT remove the two `// @ts-ignore` lines.** They keep `tsc` green pre-`npx power-apps init`.
- **Do NOT add an outer `<TamaguiProvider>`** — `PowerAppsProvider` composes it internally.
- **`SafeAreaProvider` wraps the tree** so child screens can call `useSafeAreaInsets()` without a context error. `SafeAreaView` around `<Slot />` keeps content out of the status-bar / home-indicator areas — required by `validate-screen-quality.js`.
- `tamaguiConfig` is imported from `'../tamagui.config'` (the `default export` of `tamagui.config.ts` at project root).
- `defaultTheme` flips between light/dark via `useColorScheme()`. `/design-system --add-dark-mode` later wires per-token dark variants.

Write the file directly when applying this fix.

**Fix 4 — Path aliases in `tsconfig.json` (idempotent JSON merge)**

The upstream template's `tsconfig.json` only ships `paths` polyfills for `react-native`, `expo-auth-session`, `expo-secure-store`, `expo-web-browser` — it does NOT define the `@/components`, `@/hooks`, `@/utils`, `@/tokens` aliases that screens (and the helpers Fix 7 just copied) import from. Without this fix, every `import { lookupName, formattedValue, newId } from '@/utils'` at screen-build time fails to resolve at both `tsc --noEmit` and Metro bundle time. Run this merge script in `<working_dir>`:

```bash
node -e '
  const fs = require("fs");
  const file = "tsconfig.json";
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.compilerOptions = json.compilerOptions || {};
  json.compilerOptions.baseUrl = json.compilerOptions.baseUrl || ".";
  json.compilerOptions.paths = json.compilerOptions.paths || {};
  const aliases = {
    "@/components": ["src/components"],
    "@/components/*": ["src/components/*"],
    "@/hooks":      ["src/hooks"],
    "@/hooks/*":    ["src/hooks/*"],
    "@/utils":      ["src/utils"],
    "@/utils/*":    ["src/utils/*"],
    "@/tokens":     ["src/tokens"],
    "@/tokens/*":   ["src/tokens/*"],
    "@/generated":  ["src/generated"],
    "@/generated/*": ["src/generated/*"],
    "@/native":     ["src/native"],
    "@/native/*":   ["src/native/*"],
  };
  for (const [k, v] of Object.entries(aliases)) json.compilerOptions.paths[k] = v;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
'
```

Key points:
- **Idempotent.** Re-running the script (e.g. on `/create-mobile-app` resume) overwrites the twelve managed alias keys with the same values — it does NOT touch `react-native`, `expo-auth-session`, `expo-secure-store`, `expo-web-browser`, or any other existing `paths` entries.
- **Six alias roots plus six wildcard forms, not four roots.** TypeScript path keys are exact patterns: `@/native` does not match `@/native/camera`. Keep both forms for every root. `@/generated/*` and `@/native/*` are required for generated service/model and native-wrapper subpath imports.
- **`baseUrl: "."`** is preserved if already set (the template ships it). The merge script defaults it to `"."` only if missing.
- Metro auto-resolves `paths` defined in `tsconfig.json` for any project running `expo`-based bundling, so this single edit covers both the type checker AND the bundler. No `babel.config.js` plugin needed.

`<Gradient>` (used by `components/index.tsx`) requires `expo-linear-gradient`. **Assume the upstream template ships it** — do NOT edit `package.json` to add it. If `npm install` (Step 6.5) later reveals the dep is missing, STOP and ask the user to wait for the next template release; do not work around by adding the dep here (same lockdown rule as `/add-native`).

Do not run `npm install` inside Step 5 — in template-only mode dependencies must already be installed before the skill starts.

> **Install note (current template):** The template does not read `power.config.json` during `npm install`. The Step 6 → Step 6.5 ordering is kept for predictable checkpoints, but do not run `npm run generate-schemas` during initial scaffold.

### Step 6 — Initialize

**Print before starting:**
> "→ [Step 6/13] Running `npx power-apps init -t MobileApp` to write power.config.json for environment <env-id>. ~15–30 seconds."

```bash
cd <working_dir>
npx power-apps init -t MobileApp --display-name '<displayName>' --environment-id <environment-id> --non-interactive
```

Verify `power.config.json` was created and `environmentId` matches Step 4. If `npx power-apps init` fails, report the exact error and STOP — do not proceed.

### Step 6.5 — Verify dependencies

This step verifies dependencies only. The user must have run `npm install` before invoking the skill.

```bash
[ -d "<working_dir>/node_modules/expo" ] && echo "✓ node_modules present" || echo "✗ missing — run npm install in the template folder and rerun"
```

If `node_modules/expo` is missing, STOP. Tell the user to run `npm install` in the template folder. Do not provision ADO tokens or run `npm install` from this skill.

### Step 6.5b — Ensure SafeAreaProvider wraps the root layout (always runs, idempotent)

> **Why this step exists.** This step idempotently ensures safe-area context is present in the root layout so screens do not render under system bars.

**Print before starting:**
> "→ [Step 6.5b/13] Verifying SafeAreaProvider wraps the root layout (idempotent — usually a no-op)…"

```bash
cd <working_dir>

if [ -f app/_layout.tsx ] && ! grep -q 'SafeAreaProvider' app/_layout.tsx; then
  echo "→ [6.5b] Patching app/_layout.tsx to add SafeAreaProvider + SafeAreaView"
  node -e '
    const fs = require("fs");
    const FILE = "app/_layout.tsx";
    let src = fs.readFileSync(FILE, "utf8");
    // 1. Add the import if missing — splice in right after the react-native
    //    import; fallback is prepend after the first import line.
    if (!/from\s*["\047]react-native-safe-area-context["\047]/.test(src)) {
      const importLine = "import { SafeAreaProvider, SafeAreaView } from \"react-native-safe-area-context\";\n";
      if (/^import\s*\{[^}]*\}\s*from\s*["\047]react-native["\047];?/m.test(src)) {
        src = src.replace(/(^import\s*\{[^}]*\}\s*from\s*["\047]react-native["\047];?\n)/m, "$1" + importLine);
      } else {
        src = src.replace(/(^import[^\n]*\n)/m, "$1" + importLine);
      }
    }
    // 2. Wrap the outermost <PowerAppsProvider> ... </PowerAppsProvider> with
    //    <SafeAreaProvider> AND wrap the inner <Slot /> with <SafeAreaView>.
    src = src.replace(
      /<PowerAppsProvider([\s\S]*?)>([\s\S]*?)<\/PowerAppsProvider>/,
      "<SafeAreaProvider>\n      <PowerAppsProvider$1>$2</PowerAppsProvider>\n    </SafeAreaProvider>"
    );
    if (!/<SafeAreaView/.test(src)) {
      src = src.replace(
        /<Slot\s*\/>/,
        "<SafeAreaView edges={[\"top\", \"bottom\"]} style={{ flex: 1 }}>\n          <Slot />\n        </SafeAreaView>"
      );
    }
    fs.writeFileSync(FILE, src);
    console.log("  ✓ app/_layout.tsx wrapped with SafeAreaProvider + SafeAreaView");
  ' || { echo "SafeArea patch of app/_layout.tsx failed — see error above"; exit 19; }
elif [ ! -f app/_layout.tsx ]; then
  echo "  ↷ app/_layout.tsx does not exist yet, skipping patch"
else
  echo "  ↷ SafeAreaProvider already present, skipping"
fi

echo "✓ [Step 6.5b] SafeAreaProvider verified"
```

**If the patch fails:** the node script exits with an error. The most common cause is an unusual `_layout.tsx` shape (custom rewrite). Fix manually by importing `SafeAreaProvider` + `SafeAreaView` from `react-native-safe-area-context`, wrapping the outermost provider with `<SafeAreaProvider>`, and wrapping the inner `<Slot />` with `<SafeAreaView edges={['top', 'bottom']} style={{ flex: 1 }}>`.

### Step 6.6 — Scaffold TypeScript gate

**Print before starting:**
> "→ [Step 6.6/13] Running scaffold tsc smoke check (~10–30 seconds)."

With `node_modules/` populated, first materialize the minimum semantic-token contract, then run the scaffold TypeScript gate. Shared components copied in Fix 7 use `$surface0`–`$surface3`, `$accentBase`, `$accentSoft`, `$accentDeep`, `$accentOnAccent`, and status aliases. Those aliases must exist before `tsc`; Step 9b may later replace their values with approved brand tokens.

Apply [`../design-system/references/tamagui-integration.md`](../design-system/references/tamagui-integration.md) in **alias-only mode** now if `tamagui.config.ts` does not already define the complete semantic alias set. This bootstrap is idempotent and is not a substitute for the user-facing design-system step.

Do **not** run `npm run generate-schemas` here just to produce an empty `connectorSchemas.ts`; the template is intentionally type-checkable before that file exists, and the script is already run after data-source changes and again before Step 12 starts the dev server.

```bash
npx tsc --noEmit
```

`tsc` must pass here. If it doesn't, the post-clone surgery in Step 5 or the semantic-alias bootstrap is incomplete — do not proceed to data sources or screen builders. Re-read the Step 5 fixes and the alias-only integration against the current working dir contents and reapply any missed edit.

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
planning_companion_url: <localhost URL from .tmp/mobile-plan-companion.json>
planning_companion_terminal_id: <background Bash terminal ID>
```

`/preview-screens` reads this flag when invoked from inside this project; if `no`, it prints the file path instead of opening. `/edit-app` reads it to decide whether to re-open `_plan_preview.html` after a re-plan. The flag is per-project and does not leak across apps.
The planning companion remains active through implementation so the same page
can display durable delivery outcomes. A resumed run checks the stored URL; if
it is unavailable, restart `serve-mobile-plan.js`, update these facts, and
continue from the saved status and Plan HTML.

### Step 6.75 — Design system

**Print before starting:**
> "→ [Step 6.75/13] Materializing the design system approved at Gate 3…"

Do not collect brand inputs or run a cost/style picker here. Gate 3 already
approved the design direction and visual preview. Invoke `/design-system` in
orchestrated application mode:

```
Invoke skill: /design-system

Arguments:
  --working-dir <working_dir>
  --skip-planning
  --plan <working_dir>/native-app-plan.md
```

It writes `brand/design-system.md`, `brand/tokens.ts`, and
`brand/design-system.html` from the approved Gate 3 contract. If
`--no-design` was approved, write the minimal industry-inferred token set rather
than prompting.

Handle the return per the status protocol (AGENTS.md rule #10):
- `DONE` → continue to Step 7. Record `brand_path`, `tokens_path`, `direction` in memory-bank.
- `DONE_WITH_CONCERNS` → record and surface the concern; do not open a new design decision.
- `NEEDS_CONTEXT` → return `BLOCKED` because the approved Gate 3 contract is incomplete.
- `BLOCKED` → surface error, STOP.

### Step 7 — Auth config

**Print before starting:**
> "→ [Step 7/13] Configuring app authentication (Entra ID app registration)…"

The template ships `auth.config.json` with blank `msal.clientId` and
`msal.tenantId`. There are no baked-in registration IDs to reuse. Consume the
authentication decision approved at Gate 1; do not ask another question here.

`auth.config.json` may also contain a non-secret sibling `environment` object written by `scripts/resolve-environment.js`:

```json
{
  "msal": { "clientId": "...", "tenantId": "..." },
  "environment": {
    "environmentId": "<guid>",
    "environmentUrl": "https://orgXXX.crm.dynamics.com",
    "tenantId": "<guid>",
    "cachedAt": "<iso timestamp>"
  }
}
```

Keep this block when editing `auth.config.json`. It lets later skills avoid re-running the environment-specific Power Platform API. Do not store tokens, secrets, or current-user Dataverse identity fields there.

#### 7.1 Resolve selected Power Platform tenant

Use the environment selected in Step 4. Prefer `$ACTIVE_TENANT_ID`, then `.resolved-environment.json`, then the cached `auth.config.json.environment.tenantId`. Do not use the old `msal.tenantId` as an authority source; it may be blank or stale from a previous registration.

```bash
TENANT_ID="$ACTIVE_TENANT_ID"
if [ -z "$TENANT_ID" ]; then
  TENANT_ID=$(node -e "const j=require('./.resolved-environment.json'); console.log(j.tenantId || '')" 2>/dev/null || true)
fi
if [ -z "$TENANT_ID" ]; then
  TENANT_ID=$(node -e "const j=require('./auth.config.json'); console.log((j.environment && j.environment.tenantId) || '')" 2>/dev/null || true)
fi
echo "$TENANT_ID"
```

If `TENANT_ID` is empty, rerun `scripts/resolve-environment.js` using the environment ID in `power.config.json`:

```bash
ENV_ID=$(node -e "console.log(require('./power.config.json').environmentId || '')")
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" "$ENV_ID" > .resolved-environment.json
TENANT_ID=$(node -e "const j=require('./.resolved-environment.json'); console.log(j.tenantId || '')")
```

If `TENANT_ID` is still empty, STOP and ask the user to fix environment resolution before continuing. Do not guess the tenant and do not copy `msal.tenantId` from `auth.config.json`.

#### 7.2 Apply the approved authentication decision

Read the Gate 1 authentication entry from `native-app-plan.md`.

- `existing-client-id` → run 7.3 with the already-approved GUID.
- `configure-later` → run 7.4.
- Missing or malformed entry → `BLOCKED`; the four-gate plan is incomplete.

#### 7.3 Write client ID into `auth.config.json`

Validate the Gate 1 client ID as a UUID. Write `auth.config.json` using `Edit`:
- Replace `msal.clientId` with the user's value
- Replace `msal.tenantId` with `<tenant-guid>` from 7.1
- Preserve the existing top-level `environment` block if present. If it is missing but `.resolved-environment.json` exists, add that JSON as top-level `environment`.

Do not create or modify the registration from this skill. The user owns it. Just wire the IDs into `auth.config.json`.

Print:
> "→ Wired app registration into auth.config.json.
> Client ID: `<id>`
> Tenant: `<tenant-guid>`"

Jump to Step 8.

#### 7.4 Configure auth later

Write `auth.config.json` using `Edit`:
- Set `msal.tenantId` to `<tenant-guid>` from 7.1
- Leave `msal.clientId` as `""`
- Preserve or add the top-level `environment` block from `.resolved-environment.json` if available

Print:
> `⚠️ Auth client ID is not configured. The app will fail to sign in until you add one. Run /set-app-registration-native later, or paste an app registration client ID into auth.config.json for tenant <tenant-guid>.`

Do NOT touch `src/playerConfig.ts` — auth identifiers live in `auth.config.json` only.

### Step 8 — Apply data model

**Print before starting:**
> "→ [Step 8/13] Invoking /add-dataverse to create/extend tables and generate TypeScript services. This is the longest single phase — expect 2–5 minutes for a typical 4–6 table model."

**Environment pre-check (before invoking /add-dataverse):** Verify that `.resolved-environment.json` / `power.config.json` match the environment captured in Step 1. If they differ, warn the user immediately — creating tables in the wrong environment is the #1 silent breakage in this step. `/add-dataverse` Step 3a does its own check, but catching it here saves a failed attempt.

Read the `## Data Model` section from `native-app-plan.md`. Invoke `/add-dataverse` with the working directory and a flag to skip its own planning (since the plan section is already approved):

```
Invoke skill: /add-dataverse

Arguments:
  --working-dir <working_dir>
  --plan-section <native-app-plan.md#data-model>
  --skip-planning   (the planner already ran)
```

`/add-dataverse` creates Tier 0 → N tables, applies extensions, runs `npx power-apps add-data-source --api-id dataverse --org-url <envUrl> --resource-name <name>` per table from the app root, type-checks, returns.

After `/add-dataverse` returns, run the **Dataverse/generated-services gate**:

```bash
npm run generate-schemas
npx tsc --noEmit
```

If this fails, do not continue to native capabilities, connectors, navigation, or screens. Capture the full error list once, batch-fix generated-service/model or alias-map issues, then rerun the gate. If the failure is a hidden Dataverse collision already recovered via an alias (for example `aircraft` → `aircraftv2`), make sure the alias is reflected in `native-app-plan.md`, `memory-bank.md`, and the Generated Services snapshot before rerunning.

### Step 8.5 — Seed sample data (auto)

**Print before starting:**
> "→ [Step 8.5/13] Reconciling exact sample fixtures by business key and seeding missing rows."

Invoke `/add-sample-data` after Step 8. This step is **not optional** — every fresh-scaffolded app must have data to render on first launch:

```
Invoke skill: /add-sample-data

Arguments:
  --working-dir <working_dir>
```

`/add-sample-data` reads `.datamodel-manifest.json`, discovers live insertion
metadata, creates stable business keys for every fixture, validates required
lookups and choice values, and executes `scripts/seed-sample-data.js` in
dependency order. `.sample-data-journal.json` is the authoritative resume
state; unrelated existing records never satisfy a fixture.

If `.datamodel-manifest.json` is missing, return `BLOCKED`; Step 8 did not
complete cleanly enough to seed safely.

If seeding returns `BLOCKED`, stop before Step 9 and preserve the journal. The
user can fix the reported metadata, dependency, permission, or row error and
re-run the same command; successful fixtures are reused by business key. A
partial fixture must not be presented as a completed generated app.

### Step 8.6 — Separate offline profile decision

Offline is not a Gate 1 requirement, a Gate 2 architecture item, or part of the
data-model plan. Ask only after the Dataverse manifest and live table metadata
exist.

| Project state | Action |
|---|---|
| No `.datamodel-manifest.json` / no Dataverse tables | Skip and mark `offline-ready` completed with `not applicable` |
| `memory-bank.md` says offline `done` or `not-applicable` | Reuse the recorded answer and mark the outcome completed |
| Dataverse-backed app without a recorded decision | Ask the separate question below |

Ask:

> **Offline support**
>
> Mobile Offline Profiles let users continue working when disconnected and
> synchronize queued Dataverse changes later. Set one up separately now?

Options:

1. `Create offline profile now` — invoke `/setup-offline-profile --working-dir <working_dir>` with its normal planning and approval flow. Do not pass `--skip-planning`; the offline skill must derive scope from live metadata.
2. `Skip for now` — continue without writing `not-applicable`, so the user can run `/setup-offline-profile` later.
3. `This app does not need offline` — record `status: not-applicable` in `memory-bank.md`.

This prompt is outside the four planning gates. Do not copy its answer into
`native-app-plan.md` or reopen Gate 2. `/setup-offline-profile` owns
`offline-profile.json`, live eligibility checks, row scope, selected columns,
relationships, and sync intervals.

After the answer and any selected sub-skill complete, update the
`offline-ready` outcome and re-render `mobile-app-plan.html`. On `BLOCKED`,
propagate the block and preserve the offline skill's resume state.

### Step 9 — Apply native capabilities

**Print before starting:**
> "→ [Step 9/13] Wiring <N> native capabilities: <list>. Each runs sequentially."

Read the `## Native Capabilities` section from `native-app-plan.md`. For each capability, invoke `/add-native` — it routes to nested helpers for camera/PDF/pen controls when needed, otherwise generates a generic wrapper:

```
Invoke skill: /add-native

Arguments:
  --working-dir <working_dir>
  --capability <name>
```

Run sequentially. Each writes a single file under `src/native/` and does not touch `package.json` or `app.config.js`, so they could in principle run in parallel — but sequential keeps the orchestration log readable.

If the plan says "None — this app uses only standard React Native components and Power Platform connectors", skip only the native-capability invocation above and continue to Step 9a. Do NOT skip Step 9a or Step 9b; an app can need a pure-JavaScript library without any native capability, and Tamagui aliases/brand tokens are always required.

### Step 9a — Install approved pure-JavaScript dependencies

Read and execute the Installation Contract in [`shared/references/javascript-dependency-planning.md`](${CLAUDE_SKILL_DIR}/../../shared/references/javascript-dependency-planning.md) for every approved row in `## Screens → ### JavaScript Dependencies`. If the subsection is absent or says `None.`, continue without changing dependencies.

Gate 3 approval is consent for exactly the packages and versions in the table.
Install them into `<working_dir>` before any skeleton or builder imports them,
validate `package.json` and the lockfile, and verify module resolution. Do not
substitute another package/version or route a JS-only package through
`/add-native`.

### Step 9b — Apply design system

`/design-system` owns user-facing brand/design choices. This step owns the internal Tamagui integration that makes those choices usable by generated screens. Even if the user accepts the default design path, run the alias-only integration so screens can rely on the semantic token contract.

Read the `## Design` section from `native-app-plan.md` and follow the execution mapping in [`shared/references/design-planning.md`](${CLAUDE_SKILL_DIR}/../../shared/references/design-planning.md):

| Condition | Action |
|---|---|
| `brand/tokens.ts` exists | **Highest priority.** Apply [`../design-system/references/tamagui-integration.md`](../design-system/references/tamagui-integration.md) in brand-import mode, then wire brand `ThemeTokens` into `app/_layout.tsx` (see below). |
| `## Design` says `required` | Apply the same reference using the approved `## Design` section. Builds custom token system + aliases. |
| `## Design` says `add-aliases` | Apply the same reference in alias-only mode. Adds semantic surface/accent aliases over `defaultConfig`. |
| Custom font only | `npx expo install expo-font` + `useFonts()` in `_layout.tsx` + `add-aliases` mode. |

**No skip path.** Screen-builders require `$surface0`–`$surface3` and `$accent*` aliases. Step 6.6 already bootstrapped the minimum aliases before the scaffold gate; this step must idempotently preserve them and apply the approved brand values. Pass the complete `## Design` section verbatim — not a summary. Re-run `npx tsc --noEmit` after Tamagui config changes.

**Brand-token wiring** — when `brand/tokens.ts` exists, update `app/_layout.tsx` to spread brand values over the built-in `lightTheme`/`darkTheme` with nullish fallback:

```tsx
import { tokens as brandTokens } from '../brand/tokens';
import { PowerAppsProvider, lightTheme as hostLightTheme, darkTheme as hostDarkTheme } from '@microsoft/power-apps-native-host';
import type { ThemeTokens } from '@microsoft/power-apps-native-host';

const brandedLightTheme: ThemeTokens = {
  ...hostLightTheme,
  accentDeep: brandTokens.color.primary,
  accentBase: brandTokens.color.primary,
  accentSoft: brandTokens.color.accent,
  surface0: brandTokens.color.bg,
  surface1: brandTokens.color.surface,
  surface2: brandTokens.color.surface,
  surface3: brandTokens.color.border,
  text0: brandTokens.color.text,
  text1: brandTokens.color.textMuted,
};
const brandedDarkTheme: ThemeTokens = {
  ...hostDarkTheme,
  accentDeep: brandTokens.color.primary,
  accentBase: brandTokens.color.primary,
  accentSoft: brandTokens.color.accent,
};

// In RootLayout:
<PowerAppsProvider ... theme={brandedLightTheme} darkTheme={brandedDarkTheme}>
```

The generated schema has one brand palette, so dark surfaces and text retain the host defaults while brand accents carry across modes. For runtime theme switching (in-app theme pickers, per-tenant branding), use `useThemeControl()` from `@microsoft/power-apps-native-host`: `setTheme({ ...hostLightTheme, accentBase: color })` / `resetTheme()`.

### Step 10 — Add connectors

**Print before starting:**
> "→ [Step 10/13] Adding <N> connectors: <list>. Each runs sequentially (parallel writes would race)."

Read the `## Connectors` section from `native-app-plan.md`. If it says "None", skip this step entirely.

For each row in the table, route to the correct skill based on the API name:

| API name | Invoke |
|---|---|
| `sharepointonline` | `/add-sharepoint --working-dir <working_dir>` |
| anything else | `/add-connector --working-dir <working_dir> --connector <api-name>` |

Run sequentially — each generates files under `src/generated/`. Parallel writes would race.

**Mutation-heavy steps stay sequential.** Dataverse table creation (Step 8), connector adds (Step 10), and generated-service writes are all sequential by design. The fast path in this skill is **parallel screen generation** (Step 11) plus **fewer prompts** (token cache, sticky policies, auto-proceed) — NOT parallelizing the data-source/service mutations. Do not attempt to parallel-batch `npx power-apps add-data-source` or `/add-connector` invocations; they share `src/generated/` and `power.config.json` and will race or corrupt state.

### Step 10b — Wire navigation layout

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
- `name` for `[id].tsx` is literally `[id]` (with brackets).
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

Run `npx tsc --noEmit` after the edit. If it fails, check that the `Tabs.Screen name` values exactly match the file names under `app/(app)/` (without `.tsx`).

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

Run `npx tsc --noEmit` after the edit. If it fails, check that the `Drawer.Screen name` values exactly match the file names under `app/(app)/` (without `.tsx`).

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
5. **Operational context** — if any screen varies behavior by role or active
   store/site/location, read the approved Gate 2 Shared Operational Context
   contract and generate one shared provider/hook before any screen skeleton.

**Decision rules:**

| Pattern in specs | Generate | Where |
|---|---|---|
| Same entity shown as list-item on 2+ screens | `<Entity>Card.tsx` or `<Entity>Row.tsx` | `src/components/` |
| Same choice column referenced on 2+ screens | `constants.ts` with `ENTITY_STATUS` map + tone mapping | `src/utils/` |
| Same bounded service + similar `.getAll()` params on 2+ screens | `use<Entity>List.ts` wrapping `useListData` | `src/hooks/` |
| Same cursor-paginated service on 1+ unbounded screens | `use<Entity>CursorList.ts` wrapping `useCursorListData` | `src/hooks/` |
| Entity detail + edit screens for same entity | `use<Entity>.ts` with get + save + delete | `src/hooks/` |
| Any role-aware or active-scope-aware screen | `OperationalContextProvider` + `useOperationalContext` | `src/hooks/useOperationalContext.tsx` |

**Operational-context contract (hard rule):**

- The provider must resolve `role`, `activeScope`, loading, and error from the
  exact authoritative sources approved at Gate 2. It may use generated
  Dataverse services, authenticated claims, or an explicit route selection.
- Wrap the protected app layout with `OperationalContextProvider` before
  skeleton generation, and export the hook from `src/hooks/index.ts`.
- Skeletons that need role/scope import the shared hook. They must not create
  local active-store state, hardcode manager roles, or independently query the
  same membership/current-scope records.
- If Gate 2 says role or scope is not applicable, do not generate the provider.
  If a screen requires it but the source is unresolved, stop at the
  Navigation/skeleton gate rather than generating locked controls or silent
  fallback behavior.

**Write the files directly into the project** (not into samples — these are app-specific):

```bash
# Example — if plan has "Inspections" entity used on list + detail + home screens:
cat > "<working_dir>/src/components/InspectionRow.tsx" << 'EOF'
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
npx tsc --noEmit
```

If this fails, do not launch Step 11. Capture the full error list once, batch-fix layout names, route paths, skeleton imports, shared component exports, generated service imports, or hook signatures, then rerun the gate. Screen-builders should start only from a clean shell with typed skeletons that compile with `return null`.

### Step 11 — Build screens (parallel)

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
npx tsc --noEmit
```

If the wave gate fails, capture the full error list once, group failures by root cause, and repair in batch. For screen-owned files, re-spawn the affected screen-builder(s) with the consolidated TypeScript output appended to their prompts. Affected builders can be re-spawned in parallel. Cap retries at 2 per screen, then surface the failure to the user. Do not launch the next wave until the current wave gate is clean.

Common wave-gate repair classes to batch instead of fixing line-by-line:
- Generated service/model names: singular vs plural generated names, stale aliases after Dataverse rename.
- Service option shapes: `orderBy` must match the generated type, usually `string[]`.
- UI prop mismatches: invalid Tamagui shorthand props on components that do not support them.
- React Native style types: percent widths must use a typed percentage or shared `ProgressBar` helper.
- Dataverse create/update payload typing: prefer typed helper wrappers; if generated base types require server-owned fields, isolate any `as any` at the helper boundary, not throughout screen JSX.
- Stale connector TODOs: remove `TODO(connector-not-yet-added)` when the service exists in the Generated Services snapshot.

**After all waves return and the last wave gate is clean**, run one final `npx tsc --noEmit` before Step 12 to catch cross-screen issues that only appear when all screens exist. If it fails, use the same consolidated batch-repair flow.

**Sticky tsc/build error policy (run-level).** The first time a `tsc` or `npm run build` failure surfaces in this run, ask the user once:

> "tsc found <N> error(s) in <files>. Patch + continue, or stop and let me investigate?"

Record the answer in `memory-bank.md` under `## Policies` as `tsc_error_policy: patch_continue` or `tsc_error_policy: stop_for_review`. **For every subsequent tsc/build error of the same class in the same run** (e.g., another screen failing typecheck after a builder retry, the cross-screen `tsc` after Step 11.4 fixes), apply the recorded policy automatically:

- `patch_continue` → re-spawn the matching builder with the error appended (or auto-patch in inline mode), respecting the 2-retry cap. Do not re-prompt the user.
- `stop_for_review` → STOP and surface the new error.

Reset the policy only if the user explicitly says "ask me again" or `/edit-app` is invoked. This avoids the same class of question being asked 3–5 times per run while still letting the user override at any point.

This sticky policy controls **how to handle a failed gate**, not whether the gate is required. Even with `patch_continue`, every required TypeScript gate must end clean before the flow advances.

### Step 11.4 — Stylistic fix sweep (parallel)

Run one controlled stylistic debt sweep after all screen-builder waves and TypeScript gates are clean, before preview or dev-server launch. This keeps screen-builder retries focused on critical compile/data/route issues, then fixes visual and accessibility quality across the full screen set in batches.

**Print before starting:**
> "→ [Step 11.4/13] Running stylistic validators in batch + auto-fixing contrast / accessibility / typography / action consistency across all screens (~2-3 min)"

**Scope:** generated screen files only: every file from the Screen Map plus any `app/(app)/**/*.tsx` screen written by Step 10.8/Step 11. Exclude layout files unless the reported issue is clearly inside generated screen chrome for that route group. Do not scan `src/generated/`, `brand/`, `node_modules/`, `.expo/`, or sample files.

**Available validators in v0:**

```bash
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-screen-quality.js" --report <screen-files-or-app-dir>
node "${CLAUDE_SKILL_DIR}/../../hooks/validate-color-contrast.js" --report <screen-files-or-app-dir>
```

`validate-screen-quality` includes accessibility-label/role, safe-area, touch-target, raw-hex, token, empty-state, shadow, and status-visual checks. If future stylistic hooks exist (for example `validate-accessibility-labels.js`), include them here only if they support `--report` and emit the same JSON issue shape.
It also enforces the mobile visual contract: semantic typography tokens and
explicit size/radius on any direct primary Button. Shared action primitives are
the preferred fix.

For each available stylistic validator:

1. Run in `--report` mode against all generated screens. Report mode is non-blocking; it emits JSON issues with `file`, `line`, `rule`, `match`, `fix`, and `autoFixable`.
2. Merge issues by file and rule. Keep exact line numbers for user/debug output, but do not rely on stale line numbers after the first edit in a file.
3. Split findings into deterministic auto-fixes and judgement calls:
  - **Auto-fixable:** weak foreground tokens, white-on-yellow/orange status pairs, missing icon-only `aria-label`, missing tappable `role`, tiny icon button `hitSlop`, obvious raw hex/token substitutions, raw numeric Tamagui text sizes, undersized/unshaped direct primary buttons, top-only safe area with bottom UI, `allowFontScaling={false}`. Apply these web-standard accessibility props to Tamagui 2 components; raw React Native components retain their React Native accessibility props.
  - **Needs review:** complex safe-area restructuring, dominant red detail headers, redundant status cue design, ambiguous brand colors, empty-state restructuring that requires moving JSX across large blocks.
4. Build one file-level edit batch per affected file. Apply affected files in parallel because screen files are independent. Do not run one edit per issue when multiple issues are in the same file; that reintroduces slow per-write loops and line-number drift.
5. Re-run the same validator in `--report` mode for the touched files. Cap retries at 2 per file per validator.

These validators are invoked explicitly by this mobile workflow. They are not registered as plugin-wide hooks because that would run them during unrelated Canvas Apps and other plugin operations.

After all validators report no auto-fixable issues, run:

```bash
npx tsc --noEmit
```

If `tsc` fails, use the existing TypeScript batch-repair policy. If stylistic issues remain after 2 retries or are judgement calls, do not keep looping. Record them in `memory-bank.md` and surface them as:

```text
DONE_WITH_CONCERNS: Step 11.4 left <N> stylistic issue(s) for review: <file:line rule summary>
```

Then continue only if TypeScript is clean. Step 11.4 may leave concerns, but it may not leave the app in a broken TypeScript state.

### Step 11.5 — Generate the Trust Report

**Print before starting:**
> "→ [Step 11.5/13] Generating a static trust report from the approved plan and project evidence…"

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/generate-mobile-trust-report.js" \
  --project-root "<working_dir>" \
  --plan "<working_dir>/native-app-plan.md" \
  --output "<working_dir>/mobile-app-trust-report.html"
```

The report must cover:

- device capabilities used, planned, and intentionally not enabled;
- contextual permission behavior;
- authentication and Dataverse data boundaries without exposing identifiers,
  tokens, secrets, record values, or user data;
- direct network calls outside generated services;
- background tasks and continuous sensor registrations;
- offline profile presence and table count;
- battery, network, and storage considerations;
- evidence file paths supporting each finding.

This is a static evidence report and does not require a simulator or device.
Device testing is optional release assurance for operating-system permission
wording, enforcement, and measured battery/network usage.

If generation fails, stop before Metro and surface the exact error. On success,
record `mobile-app-trust-report.html` as the `quality-ready` outcome artifact
and re-render `mobile-app-plan.html`.

#### Optional static preview

After `tsc` passes, offer a static HTML preview. The dev server starts next (Step 12), so default is skip:

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

### Step 12 — Start dev server (background)

**Print before starting:**
> "→ [Step 12/13] Launching Metro dev server in the background so you can scan the QR."

This skill **launches** Metro in an async/background terminal so:

1. The QR code prints in the terminal — the user can scan with their dev client immediately.
2. Hot-reload works on file edits — no restart needed for screen tweaks.
3. **The agent owns the terminal** — when the user says "the screen is blank" / "data isn't showing" / "it crashed", the agent can read Metro's `console.log`, BUNDLE errors, and red-box stack traces directly via `BashOutput` (or its equivalent terminal-output tool) without asking the user to copy-paste.

**Launch commands:**

```bash
cd <working_dir>
npm run generate-schemas    # refresh schema map for any data sources added since last run (idempotent)
npx tsc --noEmit            # final gate — dev server starts only from a clean TypeScript state
```

Run the schema regen and final `tsc` synchronously and check both exits. If either fails, do not launch Metro. Capture the full output once, batch-fix by root cause, rerun the final gate, and continue only when clean. Then launch Metro async:

```bash
# Async / background — DO NOT block on this. Capture the terminal id.
npx expo start
```

Use `npx expo start` here instead of `npm run dev` because the orchestrator has already run `npm run generate-schemas` for the final gate. The template keeps `predev: npm run generate-schemas` as a safety net for humans running `npm run dev` manually, but the orchestrated path should not regenerate schemas twice.

When invoking the Bash tool: set `run_in_background: true` (or the equivalent async flag in your tool surface). Capture the returned terminal/shell id as `$METRO_TERMINAL_ID`.

**After launch, wait ≤8s for the "Metro waiting on" line, then:**

1. Read the terminal output once (`BashOutput` with the captured id).
2. **Extract the native Metro URL** from the terminal output:
   - Locate the line beginning `› Metro:` — it has the form `exp+<scheme>://expo-development-client/?url=<encoded-http-url>`. Capture the full Metro URL.
3. **Generate the QR code PNG:**
  - Run `npx --yes qrcode -o <working_dir>/.expo/metro-qr.png "<metro-url>"` to generate the PNG. If the project's npm config requires auth and the fetch fails with `E401`, retry once with `npm_config_registry=https://registry.npmjs.org/ npm_config_always_auth=false` prefixed.
  - Verify the PNG was created: `test -f <working_dir>/.expo/metro-qr.png` (exit code 0 = success). If it fails, print the qrcode error and continue to step 4.
4. **Generate and open the dedicated launch page:**

   ```bash
   node "${CLAUDE_SKILL_DIR}/../../scripts/generate-mobile-launch-page.js" \
     --project-root "<working_dir>" \
     --metro-url "<metro-url>" \
     --terminal-id "<id>" \
     --qr "<working_dir>/.expo/metro-qr.png" \
     --plan "<working_dir>/native-app-plan.md" \
     --trust-report "<working_dir>/mobile-app-trust-report.html" \
     --output "<working_dir>/mobile-app-launch.html"
   ```

   Verify the HTML exists, print its `file://` URL, and open it with the
   OS-portable chain:

   ```bash
   open "<working_dir>/mobile-app-launch.html" 2>/dev/null \
     || xdg-open "<working_dir>/mobile-app-launch.html" 2>/dev/null \
     || powershell.exe -NoProfile -Command "Start-Process '<working-dir>\\mobile-app-launch.html'" 2>/dev/null \
     || echo "Auto-open failed. Use the file:// link above."
   ```

   The launch page is the primary handoff. It embeds the QR and shows player
   installation links, authentication readiness, environment/app identity,
   network requirements, Plan HTML, Trust Report, direct launch action, and
   troubleshooting. If launch-page generation fails, surface the exact error
   and fall back to opening `.expo/metro-qr.png`; do not hide a running Metro
   session.

5. **Chat-first QR render (best effort):** read and base64-encode the PNG
   (`base64 <working_dir>/.expo/metro-qr.png`) and embed it as a data URI so
   hosts that support inline images also show the QR directly in chat. Surface
   the native Metro URL and the launch-page path immediately after it.

6. **Optional: ASCII terminal QR for power users.** Extract and print the terminal's ASCII QR banner as a secondary/backup option:
   - Locate the first line composed of unicode block glyphs (`▀ ▄ █`) — that is the top of the QR.
  - Print every line from that line through the `› Metro:` line.
   - Cap at 30 lines as a safety net. Print as-is inside a fenced code block so terminal renderers preserve glyph alignment.
  - If the ASCII QR banner is not yet in the output, re-read `BashOutput` once more after another 4s before giving up. If still absent, skip the ASCII QR — PNG delivery from step 3 is the primary path.
7. Follow with:

   > "✓ Metro is running in background terminal `<id>`.
  > 📱 Launch guide: `<working_dir>/mobile-app-launch.html`
  > Scan its QR code with your native dev client, or use the direct launch action. Metro URL: `<metro-url>`
  > 🔄 Edits hot-reload automatically."

**Persist the terminal id to memory bank** so resumed sessions and downstream skills (`/preview-screens`, `/edit-app`, `/add-*`) can find it:

```markdown
## Project facts
...
- Metro terminal id: <id> (started <ISO date>)
- Metro launch cmd: cd <working_dir> && npx expo start
- Launch page: <working_dir>/mobile-app-launch.html
```

This skill stops after Step 12 so the user can iterate locally. Production build + tenant push is a separate, explicit user action via the `/deploy` skill.

### Step 12.5 — Optional debug handoff

Do not perform screen-by-screen runtime verification. Do not crawl routes, open browser targets, use React Native Web, or call Metro HTTP endpoints directly.

After Metro is running and the QR has been presented, offer a single optional debug handoff:

> "If the app shows an error or a workflow looks wrong after you load it in the native dev client, tell me the symptom and I can run `/debug-app "<symptom>"` using the Metro terminal logs."

Only invoke `/debug-app` if the user asks for debugging or gives a concrete symptom. `/debug-app` must use the captured Metro terminal output as its diagnostic source; it must not probe `localhost`, request a bundle URL, or run any React Native Web setup. If the user gives no symptom, proceed directly to Step 13.

When the user is ready to deploy:

```
/deploy            # runs npm run build + npx power-apps push
```

### Step 13 — Summary

Print a compact status block, then present exactly 4 options with no explanation. Do not add prose, tips, or "you might want to" text — keep it concise.

```
✅ Native code app created
─────────────────────────────────────────────
App name      : <displayName>
Project       : <working_dir>
Environment   : <env name> (<env id>)
Data model    : <N tables — M reuse, K extend, L create>
Native caps   : <list>
Connectors    : <list>
Screens       : <N total — M from template, K built in parallel>
Trust report  : <working_dir>/mobile-app-trust-report.html
Launch page   : <working_dir>/mobile-app-launch.html
Dev server    : npx expo start — running in background terminal <id>
                (scan QR there when you want to run locally)
─────────────────────────────────────────────
```

If Step 1 emitted warnings, list them in one line each under the block (no decoration).

Then present exactly these 4 options:

```
What now?

1. Preview screens in browser  (/preview-screens)
2. Deploy to tenant            (/deploy)
3. Edit the app                (/edit-app)
4. Add more capabilities       (/add-dataverse, /add-connector, /add-native)
5. Configure auth later        (/set-app-registration-native)

Which option? (or "none — I'll keep iterating locally")
```

**Hard rules for this step:**

- Do NOT add explanatory paragraphs after the options.
- Do NOT recommend an option ("most users want #2").
- Do NOT list alternative `npm` commands — the dev server is already running and is the only local iteration process the user needs to know about.
- Wait for the user's choice before doing anything else. If they pick none, stop.

## Notes

- This skill is the only entry point for new project creation. Do not invoke `/add-*` skills directly during a fresh-project flow — they don't know how to read the plan and would re-prompt the user.
- Planner and leaf agents are draft-only. This foreground skill owns Gates 2,
  3, and 4 and is the only planning layer that enters plan mode.
- For mid-project changes after Step 13, the user should run individual `/add-*` skills, or `/edit-app` for plan-backed app iteration.

## Reference

- [shared/shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)
- [shared/references/screen-templates.md](${CLAUDE_SKILL_DIR}/../../shared/references/screen-templates.md)
- [agents/native-app-planner.md](${CLAUDE_SKILL_DIR}/../../agents/native-app-planner.md)
