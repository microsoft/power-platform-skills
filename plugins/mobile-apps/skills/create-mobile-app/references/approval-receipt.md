# Foreground-owned approval receipt

Load at Gate 1 acceptance and later approved-plan revisions. This documents the existing live
contract; it does not introduce another schema or approval authority.
The authoritative normalization, hash and validation functions are exported by
`${PLUGIN_ROOT}/scripts/build-dataverse-operation-manifest.js`:
`normalizedContract`, `contractApprovalContent`, `stableJson`, `sha256`,
`declaredServiceRequiredTableNames`, and `validateApprovalReceipt`.
Read their current contract when constructing the receipt; do not invent copied hash algorithms.

Only the foreground skill that **captured the user's acceptance** may write/advance
`<working_dir>/.tmp/mobile-plan-status.json`. Children and Step 8 cannot create, repair or
restamp it. A valid integrity hash detects accidental replacement, not a malicious local writer.

## Lifecycle

1. Before Gate 1, require the normalized schema sidecar and explicit executable decisions;
   every `unverified` row is non-executable. Adapt rows must fully name adapted schema/logical/
   intersect identities; the execution worker cannot choose them.
2. **Approved:** only at explicit Gate 1 user acceptance, foreground initializes
   `<working_dir>/.tmp/mobile-plan-status.json` from `contractApprovalContent(contract)`,
   preserving the exact normalized content. The `dataModel` approval record contains the
   acceptance time and approved contract hash. Later gates remain pending until accepted.
3. On Gate 2 acceptance update only `nativeCapabilities` and `connectors` approval records.
   Gate 4a acceptance is recorded in the human plan; `screenPlan` remains pending until Gate 4b.
4. On Gate 4b acceptance finalize structured `serviceRequiredTables` from approved screen,
   hook, identity and lookup consumers. Each row needs a deterministic consumer identifier.
   Its exact logical-name set must equal the normalized contract's non-deferred serviceRequired
   table and M:N intersect declarations. New services require earlier contract reapproval.
5. On final acceptance compute `approvedPlanSha256` from final plan **bytes**,
   `approvedContractSha256` from `sha256(stableJson(approvedContract))`, and
   `integritySha256` from stable receipt JSON with that integrity field omitted.
6. Validate via `validateApprovalReceipt(receipt, { contract, planBytes })`.
   Missing receipt, partial records, changed contract/plan, service mismatch or bad hashes block Step 8.

The live receipt fields are:

```text
schemaVersion: 1
workflow: create-mobile-app
approvals:
  dataModel: { status: approved, approvedAt: ISO time, approvedContractSha256: hash }
  nativeCapabilities: { status: approved, approvedAt: ISO time }
  connectors: { status: approved, approvedAt: ISO time }
  screenPlan: { status: approved, approvedAt: ISO time }
approvedPlanSha256: hash of final native-app-plan.md bytes
approvedContractSha256: hash of stable approvedContract
approvedContract: exact normalized contract approval content
serviceRequiredTables: [{ logicalName, consumers: ["screen:<name>", ...] }]
integritySha256: hash of stable receipt without this field
```

Do not use the manifest builder to create or restamp this receipt. Its normalization/validation
exports are pure helpers, not a grant of approval. `--bind-plan` consumes a valid completed
receipt and binds the schema; it cannot approve an unaccepted contract.

## Revisions, including post-scaffold design

Before changing an approved section, mark its approval and dependent later approvals pending
and invalidate the completed receipt integrity. Preserve unaffected approval timestamps.
Show the actual delta and re-run the owning foreground gate; refresh hashes only after acceptance.
This applies to prefix corrections, environment changes, cross-entity read addenda and **Step 6.75
design changes to native-app-plan.md before Step 8**. Never silently refresh a whole-plan hash
because the change "only adds design". Gate 4b must accept affected specs/design delta; schema
changes additionally require Gate 1 and fresh evidence for the intended environment.

Connector-only planning records user approvals in the plan but creates no Dataverse contract
or receipt. Later Dataverse requirements return to required-mode planning, not an invented receipt.
