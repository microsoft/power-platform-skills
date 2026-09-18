# Controlled real-data testing and Apply

These are separate approvals. Model/schema approval did not authorize test
records; test-record approval did not Apply the candidate or authorize import
of canonical fixtures, captured photos, or existing prototype records.

## Optional controlled write test

The default connected candidate has `src/data/test-write-permission.json` set
to `null`. It reads real data but rejects real create/update/delete calls.
Local/transient repositories remain isolated and usable.

If the maker wants a real write test, prepare an exact bounded proposal after
connected startup exists:

```bash
node "${PLUGIN_ROOT}/scripts/prototype-conversion.js" test-write-scope \
  --project-root "<candidate_root>" --entity "<logical-entity-id>"
```

Repeat `--entity` for at most ten distinct approved Dataverse entities. The
helper allocates **one fresh GUID per entity**, with a two-hour expiration,
and writes `.tmp/prototype-test-write-scope.json`. No record values or files
belong in this proposal; it is not a second fixture source. The command makes
no remote writes.

Show the maker the environment, selected entity labels, exact new IDs,
expiration, and the create/update/delete operations allowed by their domain.
Explain that only those newly created disposable rows may be edited/deleted,
and local Undo cannot roll back any successful server operation.

In Player, use the shared question transport:

```json
{
  "gateId": "prototype-test-writes",
  "kind": "schema",
  "title": "Allow this controlled real-data test?",
  "summary": "This permits the exact new disposable records in the reviewed scope, not changes to existing business records.",
  "items": ["The permission expires in two hours. Discard does not undo server writes."],
  "fields": [{"id": "allowTestWrites", "label": "Allow these disposable test writes", "type": "boolean", "choices": []}]
}
```

Substitute the actual reviewed scope summary; no placeholder entity list may
stand in for the canonical proposal. Ask with all four bindings:

```bash
node "${PLUGIN_ROOT}/scripts/mobile-authoring.js" request-question \
  --input .devplayer-builder/logs/authoring-input/test-writes.json \
  --bind .tmp/prototype-test-write-scope.json \
  --bind .tmp/prototype-domain.json \
  --bind .tmp/prototype-rules.json \
  --bind .tmp/prototype-dataverse-mapping.json
node "${PLUGIN_ROOT}/scripts/prototype-conversion.js" authorize-test-writes \
  --project-root "<candidate_root>" --receipt "<returned-receipt>"
```

The compiler uses the shared receipt verifier again, requires this `connect`
job, exact bindings, and `answer.allowTestWrites === true`. Reject/false is not
consent. A runner confirmation flag is forbidden in Player.

Ordinary CLI asks the same explicit question normally. Only after yes:

```bash
node "${PLUGIN_ROOT}/scripts/prototype-conversion.js" authorize-test-writes \
  --project-root "<candidate_root>" --confirm-disposable-test-writes
```

Revalidate and republish the changed candidate before testing. Normal form
calls may omit an ID: the repository selects that entity's reserved fresh ID.
It refuses an ID that already exists, blocks existing business rows, caps
creates at the approved slots, and permits update/delete only after that
scope's create was actually acknowledged or reconciled. Rules and persisted
photo requirements remain enforced. An interrupted create does not immediately
grant ownership; its durable journal must be reconciled first.

Revoke before an unrelated edit/teach, final Apply, or further mapping change:

```bash
node "${PLUGIN_ROOT}/scripts/prototype-conversion.js" revoke-test-writes \
  --project-root "<candidate_root>"
```

Revocation removes the runtime grant only. It preserves all server rows,
device operation/media journals, and `.tmp/prototype-test-write-approvals/`
evidence. It is not cleanup or remote rollback. Record actual observed test
results separately from merely authorized/possible effects.

## Apply is a separate transaction

First pass actual source/type/route/contract gates and review the connected
preview. Clear prototype-only record selections; fixture IDs do not become
Dataverse IDs when no data import was approved.

**Player:** submit the validated candidate through `mobile-authoring.js
candidate`. The bridge alone handles Apply/Discard and publishes the immutable
revision. Native association must call `configureDataPreview` with the
authorized active namespace **before** repositories mount, using a coordinated
reload. Only the bridge/native mounted receipt establishes the active switch.
Do not run standalone activation, write a runtime stamp, or move active Metro
from the skill.

**Ordinary CLI:** the conversion foreground owns this decision; do not call
the Player-only edit transport or fabricate a Player receipt. Obtain actual
foreground Apply approval for the current candidate, ensure exclusive
project mutation ownership, retain the last-good source, and pause the owned
candidate preview before changing activation state. Before final
promotion/recording, run:

```bash
node "${PLUGIN_ROOT}/scripts/prototype-conversion.js" activate-data \
  --project-root "<candidate_root>" \
  --expected-revision "<reviewed-shared-source-capture-revision>" \
  --confirm-standalone-apply
```

This implements the data-selection portion, not a competing transaction or
publisher. It rejects Player credentials, stale source, incomplete conversion,
unconfigured real auth, and changed compiler-owned outputs. It stages the
active data namespace, clears test grants, runs the existing TypeScript gate,
and persists the connected startup choice so reloads do not stay read-only.
Gate failure restores the previous source/profile bytes while preserving
remote evidence and activation backups. It returns shared before/after source
revisions and `published: false`. The conversion foreground performs the final
checks and any staged-source promotion, records that exact revision, and
resumes the appropriate owned preview. Retain the original local app on
promotion failure. These are bounded per-file writes, **not cross-file/root
atomicity**; do not run against a concurrently edited or unowned preview.

The helper finalizes activation metadata and backup evidence **before** its
final shared capture. The journal records the reviewed `beforeRevision` and
backup path, not its own self-referential `afterRevision`; that final revision
is returned out-of-band. Finish all intended source/plan updates before this
capture; do not write a new hashed result/receipt file afterward. Do not alter journals after capture and keep using
the single shared hash/copy policy. Remote journals and activation backups
remain available to snapshot/copy—never delete or exclude evidence merely to
make a source hash stable.

After failure or interrupted recovery, retain the bounded backup/evidence and
inspect the actual current source. If its revision changed, recapture/review
and obtain a fresh explicit retry decision; the old expected revision is not
a force flag. Never treat restored local files as rollback of Dataverse writes.

Do not treat the helper's `stagedProfile` as an authoritative active pointer.
Do not start/retarget Metro yourself in Player. Deployed connected builds use
the real host/auth provider normally; prototype builds remain development-only.
