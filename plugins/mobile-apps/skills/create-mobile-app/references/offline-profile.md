# Offline profile

A step both build orders of `/create-mobile-app` run: [`make-it-real.md`](make-it-real.md) (screens first) and
[`data-model-first.md`](data-model-first.md) (data model first) each read it under their own numbered heading.
Fix it here and both orders get the fix.

Steps it names, by build order:

| Named here | Screens first | Data model first |
|---|---|---|
| this step | after Step 12.5 | after Step 8.5 |
| the Apply data model step | Step 12 | Step 8 |
| Seed sample data | Step 12.5 | Step 8.5 |
| the native capabilities step | Step 13 | Step 9 |

<!-- The step starts here; everything above is about the file. -->

**Print before starting:**
> "→ [Offline profile] Asking whether to set up a Mobile Offline Profile…"

Mobile Offline Profiles let the runtime package continue against Dataverse
when connectivity is unavailable and synchronize queued changes later. This phase owns Mobile Offline Profile opt-in. Apply
[`shared/references/connectivity-intent-ownership.md`](${PLUGIN_ROOT}/shared/references/connectivity-intent-ownership.md).

Before asking, parse `.datamodel-manifest.json` and require at least one
verified Dataverse table, including reused tables. If the manifest is missing,
malformed, empty, or missing a service-required table, use the read-only manifest
recovery in Seed sample data before asking. If verification still fails, report
`BLOCKED: offline setup requires the materialized Dataverse manifest from the Apply data model step`
with the specific remaining failure.
Do not infer connector-only from a missing manifest.

Skip only when `memory-bank.md` `## Offline profile` already records
`status: done` or `status: not-applicable`. Print:
`↷ Offline profile skipped — already <done|not-applicable> from a prior run.`

Otherwise ask one neutral foreground question. Say so in the plan first, and replace the note
once the user answers:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id dataverse --status active --note "Waiting for your offline support choice"
```


> **Question header:** `Offline support`
>
> **Question body:** "Mobile Offline Profiles let users continue working when
> their device is disconnected — Dataverse syncs queued changes when
> connectivity returns. Set one up now?"
>
> **Options:**
> - `Yes — create profile now (recommended)` — invoke
>   `/setup-offline-profile`, then continue to the native capabilities step
> - `Skip — I'll add it later via /setup-offline-profile` — continue to the native capabilities step
>   without recording a final answer
> - `Skip — this app doesn't need offline support` — record
>   `status: not-applicable`, then continue to the native capabilities step

If the user selects Yes, invoke `/setup-offline-profile` from the project root.
Pass `--working-dir '<working_dir>'` and invocation context
`MOBILE_APP_ORCHESTRATING=1`, `orchestrator: create-mobile-app`, the same absolute
`working_dir`, `phase: implementation`, and the selected environment ID/URL/tenant.
This choice approves entering the offline wizard, not its prerequisite or
profile mutations; the wizard retains its own gates and forwards their exact
approved scope to its helpers.
It consumes the materialized manifest, owns its own profile approval flow, and
writes `offline-profile.json`. Surface concerns and stop on a substantive
failure. Do not reopen data-model or screen approvals after this choice.

Tables and generated services now exist, so the Dataverse phase is complete:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id dataverse --status done
```
