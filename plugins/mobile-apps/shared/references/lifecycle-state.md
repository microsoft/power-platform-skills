# Mobile App Lifecycle State

Persistent lifecycle state lives in `<project>/.mobile-app/state.json`. It is
project metadata and should be committed with the app. It is never imported by
runtime code and must never contain secrets, tokens, credentials, or personal
local paths.

## Schema

```json
{
  "schemaVersion": 2,
  "dataMode": "prototype",
  "environment": null,
  "transition": null,
  "lastSyncedPlanHash": null,
  "lastSyncedScreenContractHash": null,
  "lastSyncedExecutionContractHash": null,
  "lastDataverseManifestHash": null,
  "lastDomainModelHash": "<sha256>",
  "lastContextEnrichmentHash": "<sha256>",
  "lastWorkflowJourneyHash": "<sha256>",
  "lastNavigationContractHash": "<sha256>",
  "lastNavigationShellHash": "<sha256>",
  "lastPrototypeSemanticPlanHash": "<sha256-or-null>",
  "lastPrototypeSemanticPreservationHash": "<sha256-or-null>",
  "lastVisualCompositionHash": "<sha256>",
  "lastRepositoryMappingHash": "<sha256>",
  "lastFixtureRevision": "<sha256>",
  "lastValidation": {
    "scope": "all",
    "screenId": null,
    "status": "passed",
    "checkedAt": "<ISO timestamp>",
    "buildPackRevision": "<sha256>",
    "qualityStatus": "statically-validated",
    "nativeVisualEvidence": null,
    "contentFingerprint": "<sha256>"
  },
  "lastSyncAt": null
}
```

`dataMode` is one of:

| Value | Meaning |
|---|---|
| `prototype` | The app uses neutral domain hooks under `src/data/` backed by local repositories. No real Dataverse binding is expected. |
| `transitioning` | `/prototype-to-real-app` has started an approved conversion. Read `transition.phase` to resume; do not start the app until conversion completes. |
| `dataverse` | The app is bound to a Power Platform environment; the same domain hooks now use reconciled Dataverse repository adapters. |

`environment` may contain only non-secret facts copied from
`power.config.json` or `.resolved-environment.json`:

```json
{
  "id": "<environment-guid>",
  "url": "https://<org>.crm.dynamics.com",
  "displayName": "Contoso Dev"
}
```

During conversion, `transition` has this non-secret shape:

```json
{
  "from": "prototype",
  "to": "dataverse",
  "phase": "binding",
  "startedAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>"
}
```

Allowed phases are `binding`, `reconciliation`, `adapters`, `seeding`,
`validation`, and `sync`. Update the phase only after the preceding phase
passes. Clear `transition` when final validation commits `dataMode:
"dataverse"`.

## Invocation Flags Are Not State

Do not persist per-call flags in this file. In particular, keep these only in
skill arguments:

- `--working-dir`
- `--skip-planning`
- `--no-sample-data`
- `--force`

## Hashes

`lastSyncedPlanHash` is the SHA-256 hash of `native-app-plan.md` after the most
recent successful `/sync-from-plan` run.

`lastSyncedScreenContractHash` and `lastSyncedExecutionContractHash` are the
SHA-256 hashes of `.tmp/experience-screen-contract.json` and
`.tmp/mobile-plan-execution-contract.json`. A mismatch triggers sync even when
the readable plan text did not change.

`lastDataverseManifestHash` is the SHA-256 hash of
`.datamodel-manifest.json` after the most recent successful sync in `dataverse`
mode. It is `null` in prototype mode.

`lastDomainModelHash` hashes `.tmp/prototype-domain-model.json`. The same
neutral domain model remains canonical after Dataverse graduation.

`lastContextEnrichmentHash` hashes `.tmp/context-enrichment-contract.json`.
`lastWorkflowJourneyHash` hashes `.tmp/workflow-journey-contract.json`; stage,
guard, resume, signature, continuity, or capability-composition drift
invalidates lifecycle readiness.
`lastNavigationContractHash` hashes `.tmp/navigation-contract.json` and
`lastNavigationShellHash` hashes `.mobile-app/navigation-shell.json`. Either
changing without a new recorded validation blocks preview, debug, and deploy.
`lastPrototypeSemanticPlanHash` hashes the compact planner response and
`lastPrototypeSemanticPreservationHash` hashes its path-level final-bundle
preservation report when those prototype PR1 artifacts exist. They remain null
for workflows that do not use compact prototype planning.
`lastVisualCompositionHash` hashes the canonical
`visualCompositionIntent` projection from the Experience Contract.

`lastRepositoryMappingHash` hashes
`.tmp/dataverse-repository-mapping.json` when that mapping exists. In prototype
mode it hashes the ordered operation-to-repository/method/hook projection from
the domain model.

`lastFixtureRevision` hashes the neutral `fixtures` and `fixtureScenarios`
projection. It changes when prototype records or required states change,
independently of presentation-only edits.

`lastValidation` records only the latest successful dispatcher run. Use
`validate-mobile-app.js --record`; failed validation must never overwrite a
previous passing record. Prototype completion in this workflow records
`qualityStatus: statically-validated` and `nativeVisualEvidence: null`. It must
not claim visual completion until a later native-evidence phase succeeds.
`contentFingerprint` covers relevant source, assets, config, contracts,
fixtures, and the build pack. A duplicate check may be skipped only when this
fingerprint and the validation scope still match.

Hash file bytes. A missing file maps to `null`, not the hash of an empty
string.

## Creation And Inference

If `.mobile-app/state.json` is missing:

1. Check for the legacy test-branch file `.code-apps-native/state.json`. If it
  has `schemaVersion: 1`, copy its supported fields into the canonical path
   and leave the legacy file untouched until the user approves deleting it.
2. Otherwise infer `dataMode` conservatively:
   - `.datamodel-manifest.json` or
     `docs/plan-artifacts/.datamodel-manifest.json` exists, or
     `power.config.json.databaseReferences` is non-empty: `dataverse`.
   - `.mobile-app/prototype-domain-manifest.json` or `src/data/` exists:
     `prototype`.
   - `src/generated/.prototype-manifest.json` or
     `src/generated/services/*.seed.json` exists: legacy `prototype`; run the
     compatibility migrator before normal mutation.
   - Otherwise ask before mutating.
3. Create `.mobile-app/` and write schema version `2` with null hashes.

Read-only inspection must not fail solely because state is absent. Mutation
must stop when the mode cannot be inferred safely.

## Transition Rule

`/prototype-to-real-app` first changes `dataMode` from `prototype` to
`transitioning`, recording the selected environment and current phase. It may
commit `dataverse` only after all of these are true:

1. The project is bound to the selected environment.
2. `.datamodel-manifest.json` contains every required table and generated
  service.
3. Domain reconciliation is ready and the Dataverse repository mapping hash is
  current.
4. Planned real connectors have replaced fail-closed adapter stubs.
5. `src/data/repositories/dataverseRepositories.ts` was generated from the
  current domain and Dataverse manifest, and screens still import only
  `@/data` hooks.
6. The environment facts written to state match `power.config.json` and
   `.resolved-environment.json`.
7. `validate-mobile-app.js --scope all --record` and native critical-flow
  validation pass against real data.

Never switch the mode first and treat cleanup or provisioning as follow-up
work. A project marked `dataverse` must not contain a partly mocked data path.
If conversion is interrupted, rerun `/prototype-to-real-app`; it resumes from
`transition.phase` after rechecking the previous phase's postconditions.