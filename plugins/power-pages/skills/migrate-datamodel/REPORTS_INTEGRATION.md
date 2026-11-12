# HTML Reports Integration Guide

The `migrate-datamodel` skill has four high-level phases and two report owners:

| Report | Owner | When updated |
|---|---|---|
| `customization-report.html` | `scripts/generate-migration-reports.js` and `assets/customization-report.html` | After locating a PAC customization CSV |
| `datamodel-migration-report.html` | `scripts/update-state.js` and `scripts/lib/render-live-report.js` | After each state update |

The generator never writes the execution/progress report. Do not replace the live
report with a static template, example command results, or a fabricated success.
The authoritative workflow and approval gates are in [SKILL.md](./SKILL.md).

## Waiting for user input

The live report displays one required-action notice above all tabs. Existing
`--set-approval` gates retain their approve/cancel instructions. For other pauses
after initialization, use `update-state.js --set-input` with a JSON object containing
`requiredAction` and, optionally, `responseLocation`. The default response location
is the migration conversation. The notice is informational: it does not approve
a gate or change phase/step progress.

Set the notice before asking for input or handing off a manual action, and use
`--clear-input` after a valid answer or cancellation. Keep it visible while the
user is still completing the same action or correcting invalid input. Input/approval
notices suppress the now-running banner; starting a new operation clears an input
notice. Before executing resumed work, resolve any saved pending question first.
The sticky status pill links to the notice even when the user has selected another
tab. Older state files without `pendingInput` continue to render normally.

## Package installation progress

Approved agent-run package installations reuse the report-wide now-running banner:
`--set-operation` with `label: "Installing <PACKAGE_NAME>"` and a descriptive
`detail`, without `expectedDurationSec` or `poll`. This gives an animated
indeterminate bar and elapsed time, not an installation percentage or ETA.
Keep the banner through asynchronous installation and installed-package/version
verification; clear it when verified or before handing control back to the user.
See [Package installation progress](./SKILL.md#package-installation-progress).

## Restart and readiness

The restart remains in Phase 3, after activation (Authoring 3.4 / Downstream 3.6),
not after Phase 4 validation. Ask for explicit approval, show the existing
indeterminate now-running banner, and run the plugin's `scripts/restart-site.js`.
Clear the operation when it exits. Record actual submission/readiness results in
the existing `site-restart` decision and restart sub-step output.

The helper checks the saved environment, Portal ID and site origin before one
restart POST, then waits for API operation completion and anonymous HTTP
reachability. Runtime correctness is still checked in Phase 4. On failure,
show an input notice and offer read-only verification or manual fallback; never
automatically repeat an uncertain mutation or claim that a healthy site alone
proves a restart occurred. See [Restart Site](./SKILL.md#34-restart-site-api-first-manual-fallback).

## Runtime smoke testing

Phase 4.1 offers **Run now** in the migration conversation and invokes the existing
`power-pages:test-site` skill only after that choice. No separate session is
required. Report an earlier run, defer, and skip remain available.

Show an input notice for the choice and for any browser-login/continue question.
During the run, use the indeterminate `Testing migrated site` operation; keep
Phase 4 and step 4.1 in progress. Clear the operation when testing ends, including
failure or cancellation. The migration agent remains the sole state/report writer.

Accept only the current run's matching-site test report. Record its outcome,
counts, skipped scope and report path in step output and the `runtime-smoke-test`
decision. Warnings, incomplete checks, unavailable tools and user-reported results
must remain distinguishable from an executed passing test. Finishing the sub-step
for an explicit defer/skip does not mean runtime validation passed.

## Customization analysis and staged remediation

On the Authoring Track, locate the CSV at step 2.3 and remediate at step 2.4.
On the Downstream Track, these are steps 3.3 and 3.4; findings can indicate an
upstream ALM gap. Use the actual CSV emitted by the approved PAC migration, not
an additional migration command merely to obtain a report.

Generate the customization report:

```text
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/generate-migration-reports.js" --customization-report "<CSV_PATH>" --site-name "<SITE_NAME>" --website-id "<WEBSITE_ID>" --template-name "<TEMPLATE_NAME>" --output-dir "<OUTPUT_DIR>"
```

Stage supported FetchXML rewrites and Liquid annotations against downloaded source:

```text
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/generate-migration-reports.js" --customization-report "<CSV_PATH>" --site-name "<SITE_NAME>" --website-id "<WEBSITE_ID>" --site-path "<SITE_ROOT>" --automate-fetchxml --automate-liquid --output-dir "<OUTPUT_DIR>"
```

Separate invocations of the two flags preserve both selected passes. Reruns rebuild
proposals from current source and remove obsolete proposals when no changes remain.
The legacy `--automate` flag is a compatibility no-op: it does not create columns or
perform Dataverse writes. No `--env-url` is needed for local report generation.

Outputs:

- `customization-report.html`: escaped findings, HTTP(S) guidance links and snippet previews.
- `remediation-staged/`: proposed source files; live source remains unchanged.
- `remediation-diff.json`: combined FetchXML/Liquid diff, bound to its source site root.
- `plugin-remediation-prompt.txt`: guidance for customer-owned plugin source, when applicable.
- `dme-remediation-prompt.txt`: solution-package guidance for supported metadata tables.

Data Model Extensions are manual: create a reviewed custom table with a lookup to
`powerpagecomponent`, preserve the custom column types, migrate all pages of source
rows, and update consumers. Non-metadata or unmapped findings require separate manual
review and must not receive the metadata-table transformation. No direct schema writes
are made by this generator. Plugin guidance preserves the legacy `adx_*` logical
attribute names exposed by EDM while changing the registered entity/type handling.

Only after explicit review and approval, apply staged files to the same site:

```text
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/apply-remediation.js" --output-dir "<OUTPUT_DIR>" --site-root "<SITE_ROOT>"
```

Applying to a different root is rejected. Follow the track-specific upload and
approval sequence in [SKILL.md](./SKILL.md); applying local files is not deployment.

## Snapshot comparison in the live report

Capture SDM/EDM snapshots with `snapshot-site.js` and compare them with
`diff-snapshots.js` at the Phase 3.1 safety gate. Both flat downloaded sites and
configuration under `.powerpages-site/` are recognized.

The Pages & Components card uses the same identity/state/value/hash comparison
as the diff CLI, not just equal counts. Navigation includes inactive links,
state, target and display order. Site settings support aggregate and per-record
layouts. Parse errors and ambiguous identities prevent a verified match;
expected SDM-only download differences remain reviewable warnings.

## Execution report and final summary

Initialize and update state using the commands in [SKILL.md](./SKILL.md). Reuse the
resolved migration subfolder printed by initialization for every subsequent command.
To re-render the existing state without changing progress:

```text
node "${CLAUDE_PLUGIN_ROOT}/skills/migrate-datamodel/scripts/update-state.js" --output-dir "<OUTPUT_DIR>" --render-only
```

Record actual command outputs, approvals and validation outcomes throughout all
four phases. Phase 4.2 records the final status; generating a report is not evidence
that a migration or runtime test passed. Completion telemetry uses only existing
shared fields; migration-specific phase/template details remain local.

## CSV format and dependencies

PAC CSV columns are `Type of customization`, `Guidance`, `Snippet`, and `Location`:

```csv
Type of customization,Guidance,Snippet,Location
Liquid contains adx references,https://go.microsoft.com/fwlink/?linkid=2247170,"{% assign homeurl = website.adx_partialurl %}",web-templates/header/Header.webtemplate.source.html
Data Model Extension,https://go.microsoft.com/fwlink/?linkid=2247170,Table name : adx_webpage   Column name : contoso_redirecturl,Table name : adx_webpage
```

The generator uses Node.js standard-library modules, bundled validation helpers
and a built-in CSV parser;
no `npm install` is required. The parser supports quoted fields, doubled quotes,
embedded newlines and CRLF. Repeated template tokens are replaced globally, with
literal replacement values.

## Opening reports

Use the generator's printed file URL or open the HTML file directly. Code that
constructs a URL must use Node's `pathToFileURL`, not string concatenation:

```javascript
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const reportUrl = pathToFileURL(path.resolve(outputDir, 'customization-report.html')).href;
```

Both reports are self-contained HTML and can be opened offline. When changing the
customization template, update [assets/README.md](./assets/README.md) and its
placeholder tests. Migration regression tests live under
`../../scripts/tests/` and run in the Power Pages path-filtered workflow.
