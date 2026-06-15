# Inner-loop validator finding codes

Validator findings use stable diagnostic codes in the form `IL-<DOMAIN>-<NNN>`. `IL` means inner-loop, `<DOMAIN>` identifies the validator concern, and `<NNN>` is a zero-padded sequence number within that domain. Use these codes to grep validator output, reports, and this catalog.

## IL-ATTACH

| Code | Validator | Severity | Meaning | Remediation |
| --- | --- | --- | --- | --- |
| IL-ATTACH-001 | validate-blocked-attachments.js | blocker | A required file extension is present in the environment's `blockedattachments` setting. | Run the blocked-attachments fixer without check-only mode, or update the environment setting before deploying/committing affected files. |

## IL-CONFLICT

| Code | Validator | Severity | Meaning | Remediation |
| --- | --- | --- | --- | --- |
| IL-CONFLICT-001 | validate-no-action-3-conflicts.js | info | The `sourcecontrolcomponents` entity returned 404, so conflict detection is unavailable on this tenant. | Skip this pre-flight check on the tenant; CommitToGit will still report conflicts inline if they exist. |
| IL-CONFLICT-002 | validate-no-action-3-conflicts.js | blocker | A `sourcecontrolcomponents` row has `action=3` conflict state. | Resolve each row in Maker Portal Source Control → Conflicts, then rerun pre-flight. |
| IL-CONFLICT-003 | validate-no-action-3-conflicts.js | info | The server reported more conflict rows than the validator returned. | Rerun with a larger `--top` value to enumerate the remaining rows. |

## IL-CUSTOMIZABLE

| Code | Validator | Severity | Meaning | Remediation |
| --- | --- | --- | --- | --- |
| IL-CUSTOMIZABLE-001 | validate-no-iscustomizable-false-rows.js | warn | Pending metadata has `IsCustomizable.Value=false`; commit may succeed but Pull can fail on targets. | Mark the component customizable in the source environment or remove it from pending changes. |
| IL-CUSTOMIZABLE-002 | validate-no-iscustomizable-false-rows.js | info | The validator skipped a component type without a metadata-id mapping. | No action for unaffected types; rerun after adding metadata support if this type must be checked. |

## IL-DEFSOL

| Code | Validator | Severity | Meaning | Remediation |
| --- | --- | --- | --- | --- |
| IL-DEFSOL-001 | validate-not-default-solution.js | info | The binding is not solution-scoped, so the Default-solution check was skipped. | No action required for environment-level bindings. |
| IL-DEFSOL-002 | validate-not-default-solution.js | info | The manifest says `bindingType=solution` but has no `solutionUniqueName`. | Repair `.git-integration-manifest.json` to include `solutionUniqueName`. |
| IL-DEFSOL-003 | validate-not-default-solution.js | blocker | The solution binding targets a reserved system solution such as `Default` or `Active`. | Create or choose a non-Default solution, move components into it, and bind that solution to Git. |

## IL-DEP

| Code | Validator | Severity | Meaning | Remediation |
| --- | --- | --- | --- | --- |
| IL-DEP-001 | validate-dependencies.js | warn | A pending component references another component that is not in the same commit. | Confirm the referenced component already exists in target environments, or include it in the commit. |

## IL-DEPLOY

| Code | Validator | Severity | Meaning | Remediation |
| --- | --- | --- | --- | --- |
| IL-DEPLOY-001 | validate-deployment-settings.js | info | A deployment setting value is empty and will fall back to the env var definition default. | No action unless the stage requires an explicit override. |
| IL-DEPLOY-002 | validate-deployment-settings.js | info | A Secret value uses a valid Key Vault Secret Identifier URI. | No action required. |
| IL-DEPLOY-003 | validate-deployment-settings.js | info | A Secret value uses a valid Azure Key Vault resource ID. | No action required. |
| IL-DEPLOY-004 | validate-deployment-settings.js | error | A Secret env var has a placeholder value such as `@KeyVault(...)` or `<KEY_VAULT_URI>`. | Replace the placeholder with a Key Vault Secret Identifier URI or Azure resource ID. |
| IL-DEPLOY-005 | validate-deployment-settings.js | error | A Secret env var value looks like HTTPS but is not a valid Key Vault Secret Identifier URI. | Fix the host, `/secrets/` segment, secret name, or version format. |
| IL-DEPLOY-006 | validate-deployment-settings.js | error | A Secret env var has a plain-text value where a Key Vault reference is expected. | Remove the secret from `deployment-settings.json`, store it in Key Vault, and use the resulting reference URI. |
| IL-DEPLOY-007 | validate-deployment-settings.js | error | Type lookup is unavailable, but the value is still a known invalid placeholder syntax. | Replace with a real value or a canonical Key Vault reference for Secret variables. |
| IL-DEPLOY-008 | validate-deployment-settings.js | info | The env var type is unknown, so type-specific rules could not be enforced. | Rerun with `--envUrl` for Dataverse type lookup. |
| IL-DEPLOY-009 | validate-deployment-settings.js | info | A non-Secret env var value has no enforced format constraint. | No action required. |
| IL-DEPLOY-010 | validate-deployment-settings.js | error | A deployment-settings entry is missing `SchemaName`. | Add the missing `SchemaName` field or remove the malformed entry. |

## IL-OBJTYPE

| Code | Validator | Severity | Meaning | Remediation |
| --- | --- | --- | --- | --- |
| IL-OBJTYPE-001 | validate-supported-object-types.js | blocker | A pending component type is unsupported by Connect-to-Git. | Convert, remove, or otherwise replace the unsupported component before committing. |
| IL-OBJTYPE-002 | validate-supported-object-types.js | warn | A pending component type is deprecated and may round-trip poorly. | Prefer a supported modern component type before committing. |

## IL-ORPHAN

| Code | Validator | Severity | Meaning | Remediation |
| --- | --- | --- | --- | --- |
| IL-ORPHAN-001 | validate-no-orphan-source-control-rows.js | info | The `sourcecontrolcomponents` entity returned 404, so orphan detection is unavailable on this tenant. | Skip this pre-flight check on the tenant; CommitToGit will still surface orphan failures inline. |
| IL-ORPHAN-002 | validate-no-orphan-source-control-rows.js | blocker | A pending `sourcecontrolcomponents` row has no payload lookup. | Discard each orphan row in Maker Portal Source Control, then rerun pre-flight. |
| IL-ORPHAN-003 | validate-no-orphan-source-control-rows.js | info | The server reported more orphan rows than the validator returned. | Rerun with a larger `--top` value to enumerate the remaining rows. |

## IL-PFX

| Code | Validator | Severity | Meaning | Remediation |
| --- | --- | --- | --- | --- |
| IL-PFX-001 | validate-publisher-prefix-consistency.js | warn | A pending component's schema prefix does not match the bound solution's publisher prefix. | Verify the component belongs in the bound solution or move it to the correct solution. |
| IL-PFX-002 | validate-publisher-prefix-consistency.js | info | Components with Microsoft/system prefixes were skipped as expected cross-solution edits. | No action required unless a skipped prefix should be treated as custom. |

## IL-SHARED

| Code | Validator | Severity | Meaning | Remediation |
| --- | --- | --- | --- | --- |
| IL-SHARED-001 | validate-no-shared-components.js | info | The shared-component check was skipped because too many other Git-bound solutions exist. | Rerun with a larger `--max-other-solutions` value to force the check. |
| IL-SHARED-002 | validate-no-shared-components.js | info | The target solution had more components than the comparison limit. | Rerun with a larger `--max-target-components` value for full coverage. |
| IL-SHARED-003 | validate-no-shared-components.js | blocker | A component in the target solution also belongs to another Git-bound solution. | Remove the component from the solution that should not own it, then rerun pre-flight. |
| IL-SHARED-004 | validate-no-shared-components.js | info | Another Git-bound solution had more components than the comparison limit. | Rerun with a larger `--max-target-components` value for full coverage. |

## IL-SIZE

| Code | Validator | Severity | Meaning | Remediation |
| --- | --- | --- | --- | --- |
| IL-SIZE-001 | validate-file-sizes.js | blocker | An individual pending file exceeds the base64-encoded per-file cap. | Reduce or split the file before committing. |
| IL-SIZE-002 | validate-file-sizes.js | warn | An individual pending file is above the warning threshold but below the hard cap. | Consider trimming the file before it grows into a blocker. |
| IL-SIZE-003 | validate-total-payload-size.js | info | Summary of total raw and encoded payload size for pending changes. | No action required unless the paired warning also appears. |
| IL-SIZE-004 | validate-total-payload-size.js | warn | Total encoded pending-change payload exceeds the configured threshold. | Commit during off-peak hours or split changes into smaller batches. |

## IL-STAGE

| Code | Validator | Severity | Meaning | Remediation |
| --- | --- | --- | --- | --- |
| IL-STAGE-001 | validate-stage-runs-batch.js | error | A batch-validation solution spec is missing required fields. | Fix the solutions file to include `solutionUniqueName`, `solutionId`, and `stageRunId` when re-polling. |
| IL-STAGE-002 | validate-stage-runs-batch.js | error | Stage-run creation or ValidatePackageAsync failed for a solution. | Inspect the per-solution error and rerun after fixing the host, stage, solution, or package issue. |
| IL-STAGE-003 | validate-stage-runs-batch.js | warning | Validation is pending approval in Power Platform Pipelines. | Approve the validation in PPAC, then rerun in re-poll mode. |
| IL-STAGE-004 | validate-stage-runs-batch.js | warning | Validation polling timed out and is not known to be pending approval. | Check the stage run in PPAC and rerun or re-poll when it progresses. |
| IL-STAGE-005 | validate-stage-runs-batch.js | error | Validation polling failed for a non-timeout reason. | Inspect the polling error and fix the underlying stage run or connectivity issue. |

## IL-VERSION

| Code | Validator | Severity | Meaning | Remediation |
| --- | --- | --- | --- | --- |
| IL-VERSION-001 | validate-solution-version-bumped.js | info | No prior `lastCommittedSolutionVersion` baseline exists. | Let the next successful commit record the baseline automatically. |
| IL-VERSION-002 | validate-solution-version-bumped.js | warn | Pending changes exist but the solution version has not changed since the last commit. | Bump the solution patch version before committing so downstream ALM picks up the change. |
