# Creation continuation

[`SKILL.md`](../SKILL.md) Step 0 reads this only when its routing table selects **Creation continuation**; a fresh run never does.
It is the same for both build orders, and it hands the run to the flow file that creation started in.

<!-- The step starts here; everything above is about the file. -->

For an explicit request to continue this app's unfinished creation, inspect the
matching `memory-bank.md` when present, `docs/.run-plan.json` when present, the
approved creation plan, and any valid current create caller context. Establish
the unfinished creation phase and corroborate it against current app artifacts.
Do not infer the next phase from arbitrary completed entries belonging to edits,
deployment, or another workflow.

- **Missing or conflicting progress** — ask which creation phase is being
  continued or ask to restore its records, then stop. Do not guess a phase,
  restart creation, or classify the app as fresh.
- **Completed creation** — report that there is no unfinished creation to resume.
  Clarify whether the user wants an app edit or a separate new app and use the
  table's matching route.
- **Corrupt records** — report the error and ask to repair/restore them. Do not
  delete or overwrite history to make the directory pass a freshness check.
- **Verified unfinished phase** — show the phase, remaining scope, and target
  app, then obtain continuation approval unless that exact continuation already
  has current approval. Reuse only decisions approved for the same current
  scope; pending or changed decisions keep their owning approval gates.

Pre-initialization creation may have an approved plan and saved planning
progress without a memory bank. It stays on this continuation path when the
phase can be established; the plan's presence does not redirect it to editing.
For a post-initialization continuation, resume the verified phase directly; do
not rerun the fresh preparation or `pa app init` over the materialized app.

**Reopen the build plan only after continuation approval.** When
`<working_dir>/docs/create-app-plan.html` exists, reopen it. Inspect the existing
plan with the read-only
`node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' show`
command. If it reports a `failedPhase` matching the approved continuation,
reopen that phase before continuing:

```bash
cd -- '<working_dir>' || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id <failedPhase> --status active
```

Use only a validated phase ID from the recorded creation state. Do not skip
unresolved approval or validation gates merely because an older plan exists.

Before continuing or resuming native work, resolve the app against its published host/template contract. Pass its sanitized compatibility context to every planner/builder; do not use the plugin template's current dependencies as the app's inventory.

**Keep the recorded build order.** `BUILD_ORDER` names the flow this creation started in; its finished phases belong to that order, so never switch orders mid-creation.
Read that flow file and enter the verified phase at the first step its build-plan phase lists in `skillSteps` (the `phases` in `docs/.run-plan.json`).
