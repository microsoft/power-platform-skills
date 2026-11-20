# Post-plan publisher-prefix gate

A step both build orders of `/create-mobile-app` run: [`make-it-real.md`](make-it-real.md) (screens first) and
[`data-model-first.md`](data-model-first.md) (data model first) each read it under their own numbered heading.
Fix it here and both orders get the fix.

Steps it names, by build order:

| Named here | Screens first | Data model first |
|---|---|---|
| this step | part of Step 10 | part of Step 3 (3.9) |
| the auth step | Step 11 | Step 4 |
| the first step that acts on the plan | Step 12 | Step 5 |
| the data model gate | data model gate | Gate 2 |

<!-- The step starts here; everything above is about the file. -->

Before continuing to the auth step, verify the written `native-app-plan.md` actually uses `$DETECTED_PUBLISHER_PREFIX` from Step 1.7. Catches both the inline-fallback path missing the prefix and an architect that ignored the instruction.

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

If mismatches are reported, sweep `native-app-plan.md` (and any auxiliary files like `.datamodel-manifest.json` if already written) replacing the wrong prefix with `${DETECTED_PUBLISHER_PREFIX}_` before the auth step. Do NOT proceed to the first step that acts on the plan with a wrong-prefix plan — the sweep cost grows ~500 occurrences once services are generated.

For `required`, apply the same prefix correction to
`.tmp/dataverse-schema-contract.json`, then normalize it. Before the auth step, require
both approved artifacts:

```bash
test -f "$WORKING_DIR/native-app-plan.md"
test -f "$WORKING_DIR/.tmp/dataverse-schema-contract.json"
node "${PLUGIN_ROOT}/scripts/build-dataverse-operation-manifest.js" \
  --normalize-contract "$WORKING_DIR/.tmp/dataverse-schema-contract.json" \
  --output "$WORKING_DIR/.tmp/dataverse-schema-contract.json"
node "${PLUGIN_ROOT}/scripts/validate-dataverse-planning-decisions.js" \
  --contract "$WORKING_DIR/.tmp/dataverse-schema-contract.json" \
  --snapshot "$SNAPSHOT_PATH"
```

The same validation MUST run before the data model gate is shown in the planner and inline
paths. On exit `3`, preserve and branch on the exact stderr first line:
`NEEDS_CONTEXT: detailed-dataverse-metadata:<sorted-names>` uses the incremental
detail set-difference path, while
`NEEDS_CONTEXT: proposed-dataverse-names:<sorted-names>` uses the separate
incremental collision-check path. Never rewrite one signal as the other or
repeat a network request for an already-attempted name.
On exit `4`, preserve
`NEEDS_REVISION: dataverse-plan-validation` plus its safe error lines and route
them through the existing planner/direct-architect revision path with the same
snapshot and compact evidence. This path performs no metadata read and asks no
user question. If the same conflict survives re-dispatch, use the inline
data-model revision path; ask the user only when choosing among materially
different business designs. Exit `2` is reserved for an invalid
contract/snapshot artifact and is `BLOCKED`. Do not approve Reuse, Extend, or
Adapt from `core` or missing detail, or Create/Adapt names without
checked-missing collision evidence. Do not fall back to parsing the Markdown
ER diagram when a sidecar is missing or malformed.
