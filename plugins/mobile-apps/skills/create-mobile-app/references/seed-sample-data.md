# Seed sample data

A step both build orders of `/create-mobile-app` run: [`make-it-real.md`](make-it-real.md) (screens first) and
[`data-model-first.md`](data-model-first.md) (data model first) each read it under their own numbered heading.
Fix it here and both orders get the fix.

Steps it names, by build order:

| Named here | Screens first | Data model first |
|---|---|---|
| this step | Step 12.5 | Step 8.5 |
| `Step <n>/<total>` in progress lines | 12.5/17 | 8.5/13 |
| the Apply data model step | Step 12 | Step 8 |

<!-- The step starts here; everything above is about the file. -->

Before sample data or offline setup, require the materialized table inventory
from `/add-dataverse` Step 6d, including verified reused tables. Compare its
coverage with the validated operation manifest's `service.requiredTables` and
run `verify-dataverse-services.js --project-root '<working_dir>' --manifest "$OPERATION_MANIFEST"`.
Zero schema writes is a valid reuse-only result, not failed materialization.
If an older run produced an empty or partial table inventory, recover through
`/add-dataverse` Steps 6c–6d using the approved service list and verified live
metadata. Rebuild the local manifest without replaying successful metadata
writes, then rerun coverage/service verification.

If `.datamodel-manifest.json` is missing, malformed, or contains no Dataverse
tables after that recovery, return `BLOCKED: Dataverse materialization did not
produce a usable .datamodel-manifest.json` with the remaining verification
failure. Do not seed or offer offline setup from unverified table names.

**Print before starting:**
> "→ [Step <n>/<total>] Confirming seed scope, then checking record counts for approved tables."

Run this phase after the Apply data model step for Dataverse apps. Derive the seed candidate list
from the approved service requirements and verified materialized inventory,
excluding standard system tables by default. Include reused custom tables when
the approved app needs sample data from them. Do not infer insertion permission
from `status: new`, record counts, or manifest presence. If the initial approval
did not cover the exact seed set and count/media policy, obtain that approval
before invoking; an empty or declined scope skips seeding without cloud writes.

```
Invoke skill: /add-sample-data

Context:
  MOBILE_APP_ORCHESTRATING=1
  orchestrator: create-mobile-app
  working_dir: <working_dir>
  phase: implementation
  approved_scope: <approved seed tables and count/media policy>
  retiring_tables: <empty for fresh creation>

Arguments:
  --working-dir '<working_dir>'
  --tables "<approved-seed-table-logical-names>"
```

`/add-sample-data` validates this explicit allowlist against
`.datamodel-manifest.json` before per-table discovery, then checks row counts
only for approved targets. It skips tables with enough rows and seeds the
eligible targets in dependency order. Inserted GUIDs are tracked in
`memory-bank.md` for idempotent re-runs. Missing parents cannot widen the seed
scope without returning to the owner for approval.

If the seeding step fails (network drop, permission error, etc.), surface the
failure but continue to the offline-profile phase — the app is still usable,
just empty on first launch. The user can re-run `/add-sample-data` later to
retry.
