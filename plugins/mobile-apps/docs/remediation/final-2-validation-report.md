# Final 2 Mobile Apps Validation Report

Date: 2026-09-06

Branch: `feat/final-2-main-integration`

Validated merge base: `381549387e7c60ab0615eafa0c1e66bfbb07b39a`

This report covers only `plugins/mobile-apps`. The final fixes and this report
are represented by the commit containing this file.

## Result

**Release readiness: ready for review with documented upstream residuals.**

No reproducible Mobile Apps-owned blocker remains in the tested planning,
contract, template-preparation, TypeScript, Android export, iOS export, or
codegen-bundle surfaces. Live Dataverse mutation and tenant deployment were
not performed and are explicitly outside this result.

## Defects found and fixed

### Pre-preview zero-side-effect boundary

The auto-plan requirements path instructed the workflow to write a
`native-app-plan.md` placeholder before the Step 2c proceed/edit/abort gate,
while the same phase promised no project writes before approval.

The auto-plan path now retains the extracted brief in memory and writes no
project file before `proceed`. Contract coverage rejects future instructions
that recreate the pre-preview plan write.

### Screen work-order route integrity

A screen work order previously bound its build-pack entry and compiled
revision but accepted an unrelated `route` or `routeContract`.

Sealing now requires:

- `route` to equal the assigned compiled screen route;
- `routeContract.route` to equal that route; and
- `routeContract.params` to equal the compiled implementation contract's route
  parameters.

Regression coverage verifies that stale or tampered route values cannot be
sealed.

### Dataverse proposal status integrity

The data-model architect contract requires `DONE_WITH_CONCERNS` when any table,
column, relationship, or alternate key uses `adapt` or `defer`, and plain
`DONE` otherwise. The parser previously checked only whether the concerns
array was empty.

The parser now derives the required status from all proposal decision-bearing
surfaces. Regression coverage rejects both a defer-containing `DONE` proposal
and a create-only `DONE_WITH_CONCERNS` proposal.

## Automated test matrix

| Validation | Result |
|---|---|
| Node 20 full Mobile Apps suite | 620 tests: 618 passed, 2 skipped, 0 failed |
| Node 22 full Mobile Apps suite | 620 tests: 618 passed, 2 skipped, 0 failed |
| Node 22 serial suite (`--test-concurrency=1`) | 620 tests: 618 passed, 2 skipped, 0 failed |
| Node 22 concurrent suite (`--test-concurrency=16`) | 620 tests: 618 passed, 2 skipped, 0 failed |
| Critical contract stress loop | 10 consecutive runs of 153 tests; 1,530 passed |
| JavaScript syntax audit | 189 files passed `node --check` |
| JSON parse audit | 15 files parsed |
| Markdown reference audit | 132 files and 159 relative references; no missing target |

The two standard skipped tests are environment-dependent coverage and are not
silent failures.

Representative suite command:

```bash
POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT=1 \
  node --test scripts/tests/*.test.js
```

## Disposable contract exercises

### Data-model architect

A sealed, tool-free proposal harness exercised:

- create-only proposals;
- evidence-backed table reuse;
- bounded `NEEDS_CONTEXT` metadata requests;
- contradictory-input `BLOCKED` responses;
- malformed proposal rejection;
- envelope parsing;
- deterministic contract compilation; and
- planning-decision validation.

All 46 harness checks and 15 directly related repository tests passed after
the status-integrity fix. The harness made no network request and did not
perform broad Dataverse discovery.

### Screen builder

A real compiled commerce screen pack and canonical scenario projection were
used to exercise both supported channels:

- return-only output parsed through run-scoped delimiters;
- malformed return output was rejected;
- direct-write output changed exactly one assigned screen;
- a deliberate out-of-scope write was detected and restored;
- build-pack, scenario, route, package, TypeScript, screen-quality, contrast,
  and required-test-ID checks passed.

The route-binding defect found by this exercise is covered by the final
regression tests.

### Create workflow

A disposable create-flow exercise covered:

- the fresh-template and pre-Step-2c no-write boundary;
- connector-only persistence with no Dataverse artifacts;
- synthetic Dataverse planning through proposal compilation and approval
  artifacts, stopping before live reconciliation or writes;
- deterministic template preparation, repeat execution, rollback, and
  generated-source preservation;
- navigation and screen-contract acceptance;
- all seven static telemetry checkpoints; and
- pipeline-state integrity through Step 3.9.

External authentication and Power Apps initialization commands were stubbed;
the harness never represented a live environment operation as successful.

## Fresh template runtime validation

A clean copy of `plugins/mobile-apps/template` was installed with Node 22. The
following passed:

- all native-host configuration export resolutions;
- deterministic template preparation;
- a second preparation run with identical file hashes;
- preservation of generated-source ownership;
- `npx tsc --noEmit`;
- all-source Mobile Apps validation;
- Android Expo production export;
- iOS Expo production export;
- `npm run bundle:android`; and
- `npm run bundle:ios`.

## Dependency health

### Expo Doctor

The merged template dependency versions were intentionally left unchanged.
Expo Doctor passed 18 of 20 checks and reports two categories of residual
findings.

Duplicate dependency findings:

| Package | Cause |
|---|---|
| `react-dom` | `burnt@0.12.2` brings React DOM 18 through `sonner`, while the template uses React DOM 19 |
| `expo-modules-core` | Current Microsoft native-host subpackages can resolve SDK 57's package alongside Expo SDK 55 |
| Expo SDK modules | Older direct patch pins can coexist with newer copies nested under `expo` |

Package-version findings include:

| Package | Reported condition |
|---|---|
| `expo` | Doctor requests an unpublished newer SDK 55 patch |
| `expo-dev-client` | Doctor requests an unpublished newer SDK 55 patch |
| `react-native-get-random-values` | Doctor expects the older `~1.11.0` line while the template uses published `2.0.0` |
| `@react-navigation/drawer` | Doctor reports `7.13.9` against `^7.9.4`, although the installed version satisfies that range |

These findings did not prevent TypeScript, Android export, iOS export, or
either codegen bundle. They should be resolved in the canonical template
update rather than independently changing this integration branch. The
recommended template follow-up is to evaluate the latest compatible Expo SDK
55 patches, `burnt@0.13.0`, and an SDK-55-compatible
`expo-modules-core` resolution together, then publish them as one tested
template update.

### Production dependency audit

`npm audit --omit=dev` reports:

- 0 critical;
- 0 high;
- 9 moderate.

The findings are in the Expo Router / React Navigation /
`query-string` / `decode-uri-component` chain. npm provides no compatible fix
for the central chain. Its force-fix suggestion would replace the SDK 55 Expo
Router with an incompatible major-version downgrade, so it was not applied.

### Power Apps package export warning

Metro reports that
`@microsoft/power-apps/dist/data/powerAppsData` is not declared in the
package's `exports` map and falls back to file-based resolution. The import is
inside the installed Power Apps package boundary rather than this plugin's
source. Both platform exports and both codegen bundles complete successfully.

## Live-environment boundary

This validation did not perform:

- real Dataverse schema creation or modification;
- real `npx power-apps init` authentication against an environment;
- live generated-service registration;
- sample-data insertion;
- offline-profile publication;
- native-device sign-in; or
- tenant deployment.

Those operations require an explicitly selected environment and user
authorization. The synthetic tests validate the deterministic contracts and
stop before their live write boundaries.

## Conclusion

The final branch state is suitable for pull-request review and non-live
release validation. All discovered workflow-owned defects were fixed with regression coverage.
The unchanged merged template builds for both platforms. Its dependency
findings remain documented for a coordinated canonical-template update rather
than being changed only on this integration branch.
