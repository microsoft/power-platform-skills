# Configuration create recovery

A default `/app-builder` build creates declared environment variables, connection references, Custom APIs
(with their request parameters and response properties) and duplicate detection rules (with their
conditions) one row at a time, each at an id fixed before the first request. Before it sends anything it
saves a **receipt** in the app workspace (`<app-folder>/.maker-workspace/configuration-create-state.v1.json`)
that records each row's id, parent and public fields. If the build stops before it has read every row
back, the receipt keeps the unit **open**, and every later build, `--changed-only` run and teardown of
that workspace stops until the unit is resolved.

This page explains why the build stops, and the read-only recovery command that is the way forward.

## Why a build does not simply run again

A create whose answer was lost may still have run, and it may still run later. Sending it again could
make a second row, overwrite another maker's work, or repeat a side effect that only looks idempotent. So
the plugin never resends, recreates, updates or deletes on its own to recover. It reads what is there,
tells you, and changes only its local receipt when you decide.

- **Stable singleton creates.** Each row is a plain `POST` at its recorded id; children are separate
  `POST`s bound to the recorded parent. A second `POST` of the same id is refused by Dataverse, which
  stops a duplicate row but does not prove that the earlier request's side effects ran exactly once.
- **Verification reads.** After a create the build reads the row, its children and its solution
  membership back. A unit is finished only when every read agrees.
- **Values stay outside solutions.** An environment variable value is never sent with the solution
  header and is not a required solution member.
- **Membership.** A child row can become a solution member when it is created or later, when the build's
  existing membership step adds it. Either way, recovery requires that membership to be observable.

## Leave the workspace folder to the plugin

The receipt, the quarantine markers and their archives in the app workspace belong to the plugin. While a
build or a `configuration-recovery.js` command runs, nothing else may change, rename, create, sync or
restore files in that workspace folder:

- Pause file sync clients (OneDrive, Dropbox, a network share's offline sync) and backup restores for the
  folder while you build or recover.
- Do not edit, move or delete those files by hand, and do not copy them in from another folder.

The plugin's own builds, teardowns and recovery `prepare` and `resolve` commands never run at the same time
for one app in one workspace: each holds the app's build lock, and a second one is refused (it does not wait)
while the first runs. Every change to the receipt also holds the receipt's own lock. An outside change made
while one of them runs is not protected against. If one happened, stop, keep the workspace exactly as it is
(do not delete or restore anything in it), and run `inspect` to see where it stands.

## The commands

All commands print one JSON object on stdout. `prepare` and `resolve` hold the app's build lock, so no build
or teardown of that app can run at the same time. `inspect` only reads and takes no lock.

```text
node "${PLUGIN_ROOT}/scripts/configuration-recovery.js" inspect
  --app-dir "<app-folder>" [--env "<envUrl>"]

node "${PLUGIN_ROOT}/scripts/configuration-recovery.js" prepare
  --app-dir "<app-folder>" --env "<envUrl>" --unit "<unitId>"
  --resolution accept-current|defer|cancel-unsent [--deployment-settings "<file>"]

node "${PLUGIN_ROOT}/scripts/configuration-recovery.js" resolve
  --app-dir "<app-folder>" --env "<envUrl>" --unit "<unitId>"
  --resolution accept-current|defer|cancel-unsent --approval-token "<token>"
  [--accept-current-private-state] [--deployment-settings "<file>"]

node "${PLUGIN_ROOT}/scripts/configuration-recovery.js" resolve
  --app-dir "<app-folder>" --resolution quarantine-unreadable
  --acknowledge-unknown-dispatch [--quarantine-id "<quarantineId>"]
```

`--spec @<app-folder>/app-spec.json` and `--workspace <dir>` are accepted as the build accepts them, and
the workspace is found the same way the build finds it. `--language-code <lcid>` overrides the language
the receipt recorded.

These commands send `GET` requests only. They never create, update or delete a row, never add solution
membership and never publish.

- **`inspect`** reports the receipt, its units, any quarantine and the next steps. With `--env` it reads
  each recorded row, its children and its membership, and reports per unit an `outcome` (`match` when
  everything agrees), the stop that applies and a `nextStep`. Without `--env` it reports only what the
  workspace holds. It exits 0 even when the workspace is blocked: read its `clear` field.
- **`prepare`** observes a unit for one resolution and prints a one-use `approvalToken` bound to what it
  saw.
- **`resolve`** repeats the reads, checks the token and changes only the local receipt. A completed
  resolution is **not** a build success: it exits 1 with `configuration-create-reconciled`. Run the next
  build as a fresh command.

`--env` is required for `prepare` and `resolve` of a unit, even a deferral: the receipt keeps only a
fingerprint of its environment, and a resolution is checked against the environment it is meant for
before anything is read. A receipt saved for another environment, solution, app or language stops with
`configuration-create-context-mismatch`; use that environment's workspace instead of copying or resetting
the receipt.

## Resolutions

- **`accept-current`**: every recorded row is present at its recorded id and parent, the complete public
  graph matches what was sent, the App Spec still declares the same thing, and the required solution
  membership is visible. A new duplicate detection rule must be published, unless the App Spec declares it
`status: "unpublished"`: then it must still be unpublished. An environment variable or a
  connection reference unit also needs `--accept-current-private-state` after you review
  its private values, which recovery neither compares nor prints. For a data-source variable that was
  bound to a parent definition, recovery reads that parent and checks that it is still the parent the App
  Spec names: an App Spec that now names another parent, or a parent that no longer exists, is
  `configuration-create-intent-changed`. Acceptance records that you accept the current state; it does not
  prove what an earlier request did.
- **`defer`**: first remove the unit's root (and anything that depends on it) from the App Spec. That
  includes a page binding that names it: an `actionBindings` entry naming a Custom API, or a
  `connectorBindings` entry naming a connection reference (an action binding named exactly `WhoAmI` or
  `RetrieveVersion` is a built-in operation and names no Custom API). The unit stays recorded. A later
  build can do unrelated work, but stops again if the App Spec brings the root back, under its key, its
  name or its id, or a page binding names it again. Deferral does not cancel the earlier request and does not
  make the workspace safe to delete.
- **`cancel-unsent`**: only for a unit no request of which was sent. It is local cancellation, not a
  conclusion drawn from rows being absent.

## Missing rows: completing by hand

Recovery never sends a missing row. `inspect` prints a `manualCompletion` description of each missing
row: its entity set, id column, recorded id, parent and public fields. It is not executed and holds no
private input. To complete a row, send one `POST` at the **same recorded id**, adding the private inputs
yourself. Never `PATCH`, upsert, use a new id, or delete and recreate. The earlier request may still run.
Then run `inspect` again and resolve.

A missing row that the build did **not** create (a preserved row someone deleted) is a conflict, not
missing work: recovery offers no recipe to recreate it. Preserve the other maker's work and defer the
root, or resolve it outside the plugin.

If required solution membership is missing, add the recorded component through normal solution
management, then run `inspect` again.

## Duplicate detection rules

A new rule needs publication unless the App Spec declares it `status: "unpublished"`; the receipt records which.
For one that does, the build sends `PublishDuplicateRule` once; publication takes some seconds.
If its answer is lost or the rule cannot be shown published, the build stops with
`configuration-create-publication-pending` and does not send it again. Run `inspect`: when the rule is
published and the whole unit matches, use `accept-current`. If it stays unpublished or its state is
unknown, publish it in the environment's duplicate detection rule settings (the earlier request may still
run), or defer it. A rule declared unpublished is never published for recovery: `accept-current` needs it
to be still unpublished, and nothing is to be published by hand.

Adding a condition to a **published** rule unpublishes it, so a build does not mix that with other
changes: it stops with `configuration-create-mixed-edit`. Unpublish the rule (the unbound
`UnpublishDuplicateRule` action with `{ "DuplicateRuleId": "<ruleId>" }`), build the added condition, then
publish the rule again. To publish it through a build, set `status: "published"` on the rule in that later
build: a rule declared without `status` keeps its current state, so it stays unpublished.

## Mixed edits

A build that adds rows to a configuration root and also edits, removes or changes the lifecycle of rows
the root already has stops with `configuration-create-mixed-edit`. Split it into two builds: one with only
the additions, then one with the rest (or the other way round).

## An unreadable receipt: quarantine

If the receipt is truncated, of an unknown version or cannot be verified, every build and teardown stops
with `configuration-create-state-invalid`. Keep the file and fix file access first. Restore a trustworthy
copy if you have one. If you do not, run `resolve --resolution quarantine-unreadable
--acknowledge-unknown-dispatch`. It records a tombstone and moves the receipt's exact bytes next to it,
changing nothing in the environment. If it is interrupted, run it again with the `--quarantine-id` it
printed to finish the same move.

After quarantine, a build without configuration can run. A build with configuration stops with
`configuration-create-quarantined` unless you pass, to that one build:

```text
node "${PLUGIN_ROOT}/scripts/build-model-app.js" --spec "@<app-folder>/app-spec.json" --env "<envUrl>" --apply
  --acknowledge-quarantined-configuration "<quarantineId>[,<quarantineId>...]"
```

naming every quarantine of the workspace. This says that the build may send rows again at ids an earlier
build may already have used, because the lost receipt cannot show what was sent. The option is accepted
for that one command only: it is never saved, never carried into an automatic retry and never accepted by
teardown. It does not lift any other stop.

## Teardown

A teardown stops with `configuration-create-workspace-in-use` while the workspace holds an open or
deferred unit, an unreadable receipt, an unfinished quarantine, or a quarantine archive or tombstone. It
checks before it deletes anything and again before it moves or removes the workspace, and it holds the
same build lock as a build. Resolve readable units first. For lost evidence, keep or archive the
workspace and manage the configuration rows by hand; quarantine never makes the workspace disposable.

## Stop codes

Every stop has `retry: "never"`: do not rerun the same command blindly; take the step below.

| Code | Meaning | Way forward |
|---|---|---|
| `configuration-create-pending` | An open unit exists, or a sent create was not fully read back | `inspect --env`, then resolve, complete by hand, or defer |
| `configuration-create-publication-pending` | A new rule's publication answer was lost or not proved | `inspect`; accept-current when published, or publish by hand, or defer |
| `configuration-create-reconciled` | A resolution or quarantine finished locally | Run the next build as a fresh command |
| `configuration-create-mixed-edit` | Additions mixed with edits, removals or lifecycle changes, or a condition added to a published rule | Split the change as described above |
| `configuration-create-intent-changed` | The App Spec no longer declares what was sent | Restore that declaration to resolve, or defer |
| `configuration-create-context-mismatch` | Another environment, solution, app or language | Use the recorded context; do not copy or reset the receipt |
| `configuration-create-shape-refused` | An unsupported kind, field or shape | Correct or split the declaration |
| `configuration-create-graph-unreadable` | A read was incomplete, refused or ambiguous | Restore read access and `inspect` again |
| `configuration-create-identity-conflict` | A row is at another id or under another parent | Preserve that row; resolve outside the plugin, or defer |
| `configuration-create-content-conflict` | A row's or a child set's public content differs | Preserve the other work; resolve outside the plugin, or defer |
| `configuration-create-row-missing` | A recorded row is absent | Same-id completion by hand, or defer |
| `configuration-create-membership-incomplete` | Required solution membership is not visible | Add the recorded component through solution management, then `inspect` |
| `configuration-create-private-review-required` | Public content matches; private values cannot be proved | Review them, then resolve with `--accept-current-private-state`, or defer |
| `configuration-create-approval-stale` | The workspace, environment or token changed since `prepare` | `prepare` again |
| `configuration-create-state-invalid` | The receipt cannot be read or verified | Keep it; restore a copy, or quarantine it |
| `configuration-create-state-busy` | Another build, teardown or recovery holds the app's lock | Wait. If no process uses the workspace, remove the named lock only if abandoned; keep every other file |
| `configuration-create-persistence-uncertain` | A receipt write could not be verified | Fix storage, then `inspect` |
| `configuration-create-quarantined` | A quarantine exists and the build has configuration | Omit configuration, or acknowledge every quarantine on that one build |
| `configuration-create-workspace-in-use` | Teardown found recovery evidence | Resolve the units, or keep the workspace |

The existing refusals for an older plugin's workspace copy (`WORKSPACE_LEGACY_CONFIGURATION_COPY`) and for
unsynced drafts keep their codes and remedies, and recovery checks them too: keep the drafts, restore the
original/snapshot pair, then `inspect` again.
A Custom API or duplicate rule whose copy in the app's workspace holds an edit never sent stops `prepare` and
`resolve` with `create-completion-required`, as it stops a build: move that change into the App Spec, or delete
the copy and its `.metadata` snapshot once nothing in it is needed, then `inspect` again.

## Not supported

- Resending, recreating, updating, deleting or publishing from recovery.
- Rebasing an accepted unit on a changed declaration: resolve the old attempt first, or defer it.
- Running a workspace with an older plugin version after a newer one saved a receipt in it, or copying a
  workspace to another app or environment to get past a stop.
