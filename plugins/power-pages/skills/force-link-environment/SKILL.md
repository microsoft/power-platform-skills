---
name: force-link-environment
description: >-
  Force-links a development or target environment to a Power Platform Pipelines
  host, overriding any existing association with a previous host. Use when
  creating a deploymentenvironments record fails with "this environment is
  already associated with another pipelines host", or when intentionally
  migrating an environment from one host to another (e.g., Platform Host →
  Custom Host, or between two Custom Hosts). Calls the documented
  `ManageEnvironmentStamp` Dataverse action (the API behind the "Force Link"
  button in the Deployment Pipeline Configuration app). DESTRUCTIVE to the
  previous host: makers lose access to any pipelines in that host that used
  this environment. Reversible by running Force Link from the previous host.
  Use when asked to: "force link environment", "force-link to new host",
  "switch pipelines host", "environment already associated with another host",
  "take over pipelines association", "relink environment to host".
user-invocable: true
argument-hint: "Optional: '--host <url>' to skip the host resolution step; '--dev-env <bapEnvId>' to skip the dev env prompt. With both flags supplied, the skill still pauses for destructive-action confirmation."
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# force-link-environment

Move a dev or target environment's Power Platform Pipelines host association from one host to another. This is the documented remediation when `deploymentenvironments` create fails with *"this environment is already associated with another pipelines host"*, and also the right tool when intentionally migrating environments between hosts.

**Microsoft Learn (ground truth):** [Using Force Link to associate an environment with a new host](https://learn.microsoft.com/en-us/power-platform/alm/custom-host-pipelines#using-force-link-to-associate-an-environment-with-a-new-host)

## What this skill changes

In the **target host** (the new host the user wants to use):
- Marks the existing `deploymentenvironments` record as the active stamp for the BAP environment.
- Re-runs validation; on success, `validationstatus` flips to `Succeeded` (200000001).

In the **previous host** (the host the env was previously linked to):
- The corresponding `deploymentenvironments` row is **delinked**. Its `validationstatus` is left stale until refreshed in the previous host's UI.
- Makers who could run pipelines through that environment in the previous host **lose access** to those pipelines via this environment.

The action is reversible by running Force Link again from the previous host.

## Phase 1.5 — Microsoft Learn grounding (required)

Before any Dataverse call, refresh the agent's grounding by fetching the doc above via `mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch`. If the doc has updated behaviors (e.g., new permission requirements, new warning text), surface them to the user before continuing. See `${PLUGIN_ROOT}/references/alm-docs-grounding.md` for the shared pattern.

## Phases

| # | Phase | Output |
|---|---|---|
| 1 | Prerequisites | Azure CLI token for the host environment; PAC CLI authenticated |
| 1.5 | MCP Learn grounding | Confirmed current behavior of Force Link / `ManageEnvironmentStamp` |
| 2 | Identify host + dev env | `hostEnvUrl`, target host's `deploymentEnvironmentId`, source BAP env GUID |
| 3 | Resolve `deploymentenvironments` record | Either an existing record on the new host, or a freshly created one |
| 4 | Confirm destructive action | Explicit user consent via `AskUserQuestion` |
| 5 | Execute Force Link | 204 from `ManageEnvironmentStamp` + post-validation Succeeded |
| 6 | Write marker + summary | `docs/alm/last-force-link.json` + human-readable summary |

Create all tasks at Phase 1 start with `TaskCreate`. Mark each `in_progress` when starting and `completed` when done.

---

## Phase 1 — Prerequisites

Reuse the shared verifier:

```bash
node "${PLUGIN_ROOT}/scripts/lib/verify-alm-prerequisites.js"
```

Specifically required:
- **PAC CLI auth** — `pac env who` must report an authenticated environment (for `--dev-env` auto-discovery).
- **Azure CLI auth** — `az account show` succeeds.
- **Host-scoped token** — the caller must have Deployment Pipeline Administrator on the target host (the host the env is being linked TO). Without it, `ManageEnvironmentStamp` returns 403.

Fetch the host token from Azure CLI using the host's Dataverse URL as the resource. Reuse `getAuthToken` from `scripts/lib/validation-helpers.js`.

## Phase 1.5 — MCP Learn grounding

Call:

```
mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch(url=
  "https://learn.microsoft.com/en-us/power-platform/alm/custom-host-pipelines")
```

Confirm the *"Using Force Link…"* section's current warnings before proceeding. If the section now mentions new prerequisites or rollback constraints not covered in this skill, surface them to the user.

## Phase 2 — Identify host + dev env

<!-- gate: force-link-environment:2.host-url | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · force-link-environment:2.host-url):** Pick the target host environment URL when arg / marker resolution paths all came up empty. Fires only on the "no `--host` arg, no `last-host-check.json`, no `last-pipeline.json`" branch (step 4 below).
>
> **Trigger:** Phase 2 resolution order steps 1–3 all returned no value.
> **Why we ask:** Auto-picking the wrong host runs `ManageEnvironmentStamp` against the wrong tenant and moves the stamp irreversibly without consent.
> **Cancel leaves:** Nothing — no API call yet.

<!-- gate: force-link-environment:2.dev-env | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · force-link-environment:2.dev-env):** Pick (or paste) the source dev env's BAP env GUID when `--dev-env` arg is absent and `pac env who` didn't confirm. Fires only on the "no arg + no confirmation" branch (step 3 below).
>
> **Trigger:** Phase 2 BAP-GUID resolution steps 1–2 all returned no value.
> **Why we ask:** Auto-picking the wrong dev env relinks a different env to the new host — makers of the wrong env lose pipeline access.
> **Cancel leaves:** Nothing — no API call yet.

Resolution order for `hostEnvUrl`:
1. `--host <url>` argument, if supplied.
2. `docs/alm/last-host-check.json` (written by `ensure-pipelines-host`) — read `finalHostEnvUrl`.
3. `docs/alm/last-pipeline.json` — read `hostEnvUrl`.
4. Prompt user via `AskUserQuestion`.

Resolution order for the source dev env's BAP env GUID:
1. `--dev-env <guid>` argument, if supplied.
2. `pac env who` (current PAC CLI env) — but ONLY if the user confirms this is the env to relink.
3. Prompt user via `AskUserQuestion`.

## Phase 3 — Resolve `deploymentenvironments` record on the new host

**Goal of this phase:** obtain the `deploymentEnvironmentId` (the new host's record ID) regardless of whether it already exists, just got created, or got created in a Failed state. Force Link in Phase 5 cannot run without that GUID.

### Step 3.1 — Look up by BAP env GUID

```bash
GET {hostEnvUrl}/api/data/v9.1/deploymentenvironments?$filter=environmentid eq '{bapEnvId}'&$select=deploymentenvironmentid,name,environmenttype,validationstatus,errormessage
```

| Result | Action |
|---|---|
| One hit, `validationstatus = 200000001` (Succeeded) | Already linked to this host. Skip to Phase 6 with a no-op summary; no Force Link needed. |
| One hit, `validationstatus = 200000002` (Failed) | This is the *"already associated with another pipelines host"* state. Capture `deploymentenvironmentid` + `errormessage`. Skip to Phase 4 with those values. |
| One hit, `validationstatus = 200000000` (Pending) | Wait briefly (3–5 s) and re-query. If still Pending after ~20 s, abort with a "validation still in progress; retry later" message. |
| Zero hits | Continue to Step 3.2 — the record needs to be created first. |

### Step 3.2 — Create the record on the new host (when Step 3.1 returned zero hits)

```bash
node "${PLUGIN_ROOT}/scripts/lib/create-deployment-environment.js" \
  --hostEnvUrl <hostEnvUrl> \
  --token <hostToken> \
  --name "<display name>" \
  --bapEnvId <bapEnvId> \
  --environmentType <200000000|200000001>
```

The helper polls `validationstatus` and **throws on Failed** without returning the new record's GUID in the error payload. Three outcomes to handle:

| Helper outcome | Action |
|---|---|
| Resolves with `validationStatus = Succeeded` | Record is fully linked. Skip to Phase 6 — no Force Link needed. |
| Throws with message containing *"already associated with another pipelines host"* (or similar host-claim wording) | The record **was** created in Failed state but the helper's error doesn't surface the new GUID. **Re-run Step 3.1's GET to recover the just-created record's `deploymentenvironmentid`**, then proceed to Phase 4 with that ID + the captured errormessage. Do NOT retry the create — it would log a duplicate `name`. |
| Throws with any other message | Surface the error verbatim and abort. Force Link is not the right tool — this is a different failure (e.g., 403 on create = caller lacks role on host; 400 = bad `bapEnvId`). |

**Why the re-query is necessary:** `create-deployment-environment.js` is idempotent on subsequent calls (it short-circuits via `findExistingByBapId`), but on the *first* call that lands in Failed validation it raises before the return path runs. Re-querying by `environmentid eq '{bapEnvId}'` is the canonical recovery — the same query Step 3.1 already uses.

After this phase ends, you must hold a non-null `deploymentEnvironmentId`. If you don't, abort Phase 4 with a clear "could not resolve record on new host" message.

## Phase 4 — Confirm destructive action

<!-- gate: force-link-environment:4.destructive | category=consent | cancel-leaves=nothing -->
> 🚦 **Gate (consent · force-link-environment:4.destructive):** Mandatory consent before `ManageEnvironmentStamp` cross-host stamp move. Previous host loses pipeline access for this env. Reversible only by re-running Force Link from the previous host. **Fires fresh on every skill invocation.** Each invocation force-links exactly one env to one host. If a maker needs to migrate multiple envs across hosts, they invoke this skill once per env — each invocation requires its own consent prompt with its own env identity echoed back. No `--yes` flag, no batch mode, no consent carry-over.

This is the **mandatory** gate. Use `AskUserQuestion` with both options and a clear destructive-action warning in the question text. Required fields to display before asking:

- Target host (the new host)
- Source environment name + BAP env GUID
- The error message from the previous host's stamp (from Phase 3), if any
- Documented side effects:
  - "Makers in the previous host lose pipeline access for this environment"
  - "The previous host's environment record is left with a stale validation status"
  - "Reversible by running Force Link from the previous host"

Question structure:

```
question: "Force-link this environment to <host name>? This will remove its association with the previous host."
options:
  - "Yes — force link" (Recommended only if user is intentionally migrating)
  - "Cancel"
```

If the user picks Cancel, exit cleanly (no marker file written) and recommend `/power-pages:ensure-pipelines-host detect-only` for further diagnosis.

## Phase 5 — Execute Force Link

```bash
node "${PLUGIN_ROOT}/scripts/lib/force-link-environment.js" \
  --hostEnvUrl <hostEnvUrl> \
  --token <hostToken> \
  --deploymentEnvironmentId <guid>
```

The helper:
1. Calls `ManageEnvironmentStamp` (returns 204 No Content on success).
2. Re-polls `validationstatus` on the same record every 3s up to 20 attempts.
3. Resolves on Succeeded (200000001), throws on Failed (200000002) with the captured `errormessage`.

If the helper throws with status 403, the caller lacks Deployment Pipeline Administrator on the target host — surface that as the remediation message.

If the helper throws with status 404, the `deploymentenvironments` record doesn't exist on the target host — Phase 3 must have failed silently; loop back.

## Phase 6 — Write marker + summary

Ensure the `docs/alm/` directory exists (`node -e "require('fs').mkdirSync('docs/alm',{recursive:true})"`), then write `docs/alm/last-force-link.json`:

```json
{
  "schemaVersion": 1,
  "hostEnvUrl": "https://...",
  "deploymentEnvironmentId": "...",
  "bapEnvId": "...",
  "previousHostEnvUrl": "https://...",
  "validationStatus": 200000001,
  "forcedAt": "2026-05-11T..."
}
```

`previousHostEnvUrl` is best-effort. Derive in this order; leave `null` if none of these yield a value:
1. **From `docs/alm/last-host-check.json`** (written by `ensure-pipelines-host`): if `finalHostEnvUrl` is set AND differs from the current `hostEnvUrl`, the discovery flow had already bound this env to that previous host — record it.
2. **From Phase 3's errormessage**: scan the captured `errormessage` for the pattern `https?://[^\s'"]+\.(crm\d*\.dynamics\.com|dynamics-int\.com|crm\.microsoftdynamics\.us)` and pick the first match that is **not** the current `hostEnvUrl`. Microsoft's error wording on the "already associated" path sometimes includes the prior host's URL, sometimes only its display name; treat the regex as opportunistic, not authoritative.
3. **Otherwise**: leave `null`. The marker schema permits this — validator does not require the field.

Do NOT prompt the user to fill `previousHostEnvUrl`; it's informational only for the post-run summary.

Present a summary table with:
- Environment force-linked
- Old host → new host
- Validation status
- Reminder: "You can undo this by running `/power-pages:force-link-environment` from the previous host."

Record skill usage per `${PLUGIN_ROOT}/references/skill-tracking-reference.md`.

---

## Failure modes & remediation

| Failure | Surface to user | Next step |
|---|---|---|
| `403 Forbidden` on `ManageEnvironmentStamp` | "You need Deployment Pipeline Administrator role on <hostName>." | Ask host admin to grant the role; documented in [share with pipeline administrators](https://learn.microsoft.com/en-us/power-platform/alm/custom-host-pipelines#share-with-pipeline-administrators). |
| `404 Not Found` on the deployment env record | "No deploymentenvironments record exists yet on this host." | Re-run Phase 3's create step. |
| Post-link validation status flips to Failed | Show the `errormessage` verbatim. | If the message mentions the env is still associated with a host, the previous host may have an immediate-reapply policy — check with the previous host's admin. |
| User cancels at Phase 4 | "Force Link not performed; previous association preserved." | Suggest `/power-pages:ensure-pipelines-host detect-only` for a wider diagnosis. |

## What this skill does NOT do

- It does not install the Pipelines application on the new host — use `/power-pages:ensure-pipelines-host` for that.
- It does not create the new host environment itself.
- It does not re-link pipeline definitions; only the env↔host stamp is moved. Pipelines that referenced this env in the previous host stay there and lose this env as a participant.
- It does not modify the user's solution. No `.solution-manifest.json` updates; no `AddSolutionComponent` calls.

## Progress tracking

| Phase | Status |
|---|---|
| 1 — Prerequisites | ⏳ |
| 1.5 — MCP Learn grounding | ⏳ |
| 2 — Identify host + dev env | ⏳ |
| 3 — Resolve deploymentenvironments record | ⏳ |
| 4 — Confirm destructive action | ⏳ |
| 5 — Execute Force Link | ⏳ |
| 6 — Write marker + summary | ⏳ |

Update this table as phases complete.
