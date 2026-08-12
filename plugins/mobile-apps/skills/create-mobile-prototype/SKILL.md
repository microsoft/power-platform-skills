---
name: create-mobile-prototype
description: Use when the user wants a quick Expo/React Native Power Apps mobile app prototype backed by local mock data instead of Dataverse. Also use for DevPlayer builder requests, local builder bridge workflows, progressive mobile preview, external approval callbacks, and /create-mobile-prototype --working-dir handoffs.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Task, Skill
model: opus
---

**Shared instructions: [shared-instructions.md](../../shared/shared-instructions.md)** — read first.

# Create Mobile Prototype

Create a mobile app prototype with **no Dataverse provisioning and no Power Platform environment requirement**. The app uses local in-memory mock services under the same import paths that real generated services use, so screens can later be rebound to Dataverse and connectors by `/prototype-to-real-app`.

## When To Use

- The user wants to explore UX quickly without creating tables or connections.
- The user has a design/brief and wants a runnable prototype first.
- The user plans to graduate the prototype later into a real Dataverse-backed mobile app.

Use `/create-mobile-app` instead when the user wants real Dataverse tables/connectors immediately.

## Inputs

- `--working-dir <fresh-template-dir>` — required unless `--project-dir <empty-dir>` is supplied.
- `--project-dir <empty-dir>` — optional convenience path; copy the bundled template into this empty folder, then run `npm install` there.
- `--from-plan <native-app-plan.md>` — optional approved plan to reuse.
- `--from-design-intake <path>` — optional design notes to preserve.
- `--project-name <name>` — optional display/slug name.
- `--no-design` — skip visual picker only; still ensure token aliases exist.
- `--devplayer-mode` — enable structured DevPlayer bridge events and bridge approvals.
- `--callback-url <url>` — DevPlayer job URL, for example `http://127.0.0.1:5177/jobs/<jobId>`.
- `--callback-token <token>` — sent only as the `x-builder-token` header.
- `--job-id <id>` — optional trace label.
- `--progressive-preview` — start Metro early after the prototype shell/scaffold gate and post `/preview`.
- `--no-plan-mode` — use bridge approval endpoints instead of Copilot Plan Mode / chat approval gates.

DevPlayer slash invocation should target this prototype skill, not `/create-mobile-app`:

```text
/create-mobile-prototype --working-dir "<generated-workspace>" --devplayer-mode --callback-url "http://127.0.0.1:5177/jobs/<jobId>" --callback-token "<token>" --progressive-preview --no-plan-mode
```

For callback schema, approval polling, preview/ready/failed payloads, and secret redaction rules, follow [`../../shared/references/devplayer-integration.md`](../../shared/references/devplayer-integration.md).

## Non-Negotiables

- Do **not** call `npx power-apps init`, `npx power-apps add-data-source`, `pac`, Dataverse Web API scripts, or connector provisioning.
- Do **not** require `az` unless the user later asks to graduate.
- Do **not** create `.datamodel-manifest.json` in prototype mode.
- Do write `.code-apps-native/state.json` with `dataMode: "prototype"`.
- Do write `power.config.json` with placeholder environment and empty `connectionReferences` / `databaseReferences` so the host imports compile.
- Do generate mock services with the same screen-facing surface as real generated services.
- In DevPlayer mode, do not use Copilot Plan Mode for gates when `--no-plan-mode` is present; post approvals to the bridge and wait for approve/reject.
- In DevPlayer mode, every fatal stop must attempt `POST <callback-url>/failed` before returning the normal Copilot summary.

## Workflow

### Step 0 — DevPlayer Callback Setup

When `--devplayer-mode` is present:

1. Require `--callback-url` and `--callback-token`; if either is absent, stop before mutating files.
2. Export local shell variables for any callback snippets:

  ```bash
  DEVPLAYER_CALLBACK_URL="<callback-url>"
  DEVPLAYER_CALLBACK_TOKEN="<callback-token>"
  ```

3. Verify the bridge when possible:

  ```bash
  curl -sS "${DEVPLAYER_CALLBACK_URL%/jobs/*}/__builder_verify" \
    -H "x-builder-token: $DEVPLAYER_CALLBACK_TOKEN" >/dev/null || true
  ```

4. Emit an initial event:

  ```json
  {"kind":"plan","level":"info","state":"running","itemId":"prototype","title":"Creating prototype","message":"Preparing mobile prototype workspace"}
  ```

Do not print the callback token.

### Step 1 — Prepare Template

If `--working-dir` is supplied, require a fresh installed template:

```bash
test -f package.json && test -f app.config.js && test -f auth.config.json && test -f tamagui.config.ts
test -d node_modules/expo
test ! -f memory-bank.md && test ! -f native-app-plan.md && test ! -f .datamodel-manifest.json
```

If `--project-dir` is supplied, require the directory to be missing or empty, copy `${CLAUDE_SKILL_DIR}/../../template/.` into it, then run `npm install` in that directory. Ask before overwriting any non-empty folder.

Set `<PROJECT_DIR>` to the chosen app root.

### Step 2 — Capture Or Reuse Brief

If `--from-plan` is supplied, copy it to `<PROJECT_DIR>/native-app-plan.md` and synthesize `<PROJECT_DIR>/brief.md` from the plan. Do not reinterpret approved entities/screens.

Otherwise ask for a concise prototype brief: domain, user role, 3-5 core actions, native features, and visual direction. Save it as `<PROJECT_DIR>/brief.md`.

### Step 3 — Plan Data, Capabilities, Connectors, And Screens

When no approved plan exists:

1. Invoke `mobile-app:data-model-architect` with prototype instructions: do not probe Dataverse; assume all tables are prototype-only; use placeholder publisher prefix `cr` when no prefix is known.
2. Write/merge `## Data Model` into `native-app-plan.md` and ask for approval.
  - Normal mode: use `AskUserQuestion` / chat approval.
  - DevPlayer `--no-plan-mode`: post `POST /approval` with title `Approve prototype data model`, summary/counts, and entity bullets; poll `GET /approval` until approved/rejected.
  - On approval, emit a `step` success event with `itemId: data-model` and entity count.
3. Plan native capabilities inline from the brief using the same template allowlist as `/create-mobile-app`; ask for approval using the same normal/DevPlayer approval split.
  - On approval, emit `itemId: native-capabilities` with capability count.
4. Follow `shared/references/connector-planning.md` to write a `## Connectors` section. In prototype mode connectors become throw-stubs, not real services.
  - In DevPlayer mode, include connector throw-stub warnings in the approval summary.
  - On approval, emit `itemId: connectors` with connector count.
5. Invoke `mobile-app:screen-planner` for the screen graph/specs, then ask for approval using the same normal/DevPlayer approval split.
  - Post one approval for screen graph and one for screen specs when the planner runs in two phases.
  - On approval, emit `itemId: screens` with screen count.

### Step 4 — Write Prototype State And Placeholder Power Config

Create `.code-apps-native/state.json`:

```json
{
  "schemaVersion": 1,
  "dataMode": "prototype",
  "environment": null,
  "lastSyncedPlanHash": null,
  "lastDataverseManifestHash": null,
  "lastSyncAt": null
}
```

Write `power.config.json` with placeholder environment and no real connections:

```json
{
  "version": "1.0",
  "appId": null,
  "appDisplayName": "<App Name>",
  "region": "prod",
  "environmentId": "00000000-0000-0000-0000-000000000000",
  "description": "Prototype mode - no real Power Platform environment bound",
  "buildPath": "./dist",
  "buildEntryPoint": "index.html",
  "localAppUrl": "http://localhost:3000",
  "logoPath": "Default",
  "connectionReferences": {},
  "databaseReferences": {}
}
```

Do not store secrets, tokens, tenant IDs, or user identities.

### Step 5 — Generate Mock Services

Run:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/gen-mock-services.js" "<PROJECT_DIR>"
npm --prefix "<PROJECT_DIR>" run type-check
```

In DevPlayer mode, emit:

```json
{"kind":"step","level":"success","state":"completed","itemId":"mock-services","title":"Mock services","message":"Local prototype data services generated"}
```

The script writes:

- `src/generated/services/*Service.ts` in-memory mocks for each table.
- `src/generated/services/*.seed.json` scenario seed rows.
- connector throw-stubs for `## Connectors` rows.
- `src/generated/services/dataSourcesInfo.ts` registry.
- `src/generated/models/*Model.ts` and `src/generated/schemas/*.Schema.ts` app-facing types.

Mock services return `{ success, data, error }` so screen code follows the same non-throwing generated-service pattern expected by `screen-builder`.

### Step 6 — Apply Design And Native Wrappers

Run `/design-system` unless `--no-design` is explicitly set. Even with `--no-design`, apply the alias-only Tamagui integration from `skills/design-system/references/tamagui-integration.md` so `$surface*` and `$accent*` tokens exist.

For approved native capabilities, invoke `/add-native` or the dedicated native helper sequentially. Do not install native packages; only use modules already in the template.

### Step 7 — Build Screens

Reuse the same create flow primitives where possible:

- Generate navigation shell and typed skeletons from `native-app-plan.md`.
- Spawn `mobile-app:screen-builder` per screen.
- In DevPlayer mode, pass callback metadata in every screen-builder prompt and ask builders to emit `screen` events after their assigned file is written.
- Run route, screen-quality, color-contrast, and TypeScript gates available in this plugin.
- Invoke `/preview-screens` after validation.

If a route/layout/screen-contract validator mentioned by older prototype docs is not present in this plugin, use available checks (`scripts/check-routes.js`, `hooks/validate-screen-quality.js`, `hooks/validate-color-contrast.js`, `npm run type-check`) and record the missing validator as `DONE_WITH_CONCERNS`, not as a silent pass.

### Step 8 — Start Dev Server / Progressive Preview

In DevPlayer mode with `--progressive-preview`, start Metro as soon as the template, placeholder config, navigation shell, and scaffold TypeScript gate are valid. Post:

```json
{"kind":"preview","level":"success","state":"running","itemId":"metro","title":"Live preview started","message":"Metro preview is available"}
```

Then call `POST /preview` with `{ "metroUrl": "http://<desktop-lan-ip>:<metro-port>" }`. Use a LAN-reachable URL for physical Android/iOS devices; do not send `localhost` unless DevPlayer is running on the same device.

After validation:

```bash
cd "<PROJECT_DIR>"
npm run dev
```

Normal mode may start Metro only at the end. DevPlayer mode should keep Metro running while screen files are generated so Expo Fast Refresh can reveal screens progressively.

When all gates pass in DevPlayer mode, call `POST /ready` with the final Metro URL.

Final summary must include:

- Project path
- `dataMode: prototype`
- Mock tables/connectors generated
- Native capabilities wired
- Validation results
- Preview path
- Next step: `/prototype-to-real-app --working-dir <PROJECT_DIR>`

## Graduation Contract

Prototype files are intentionally disposable. `/prototype-to-real-app` later overwrites mock files under `src/generated/` with real generated Dataverse/connector services, runs `npm run generate-schemas`, removes `*.seed.json` and mock markers, sets `dataMode: dataverse`, then invokes `/sync-from-plan` once.