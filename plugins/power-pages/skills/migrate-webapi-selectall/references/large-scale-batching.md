# Large-Scale Batching

Use this workflow when inventory can exceed one model context. It is designed
for tens or hundreds of thousands of configurations and call candidates
without replacing semantic review with scripted inference.

## Scale principles

1. Keep semantic decisions with the reviewing agent.
2. Persist completed rows before releasing batch context.
3. Never load the complete inventory or report appendix at once.
4. Query Dataverse once per unique table, not per configuration or call.
5. Process batches sequentially to avoid duplicated work and conflicting
   edits.
6. Reconcile counts after every batch and phase.
7. Stop on unreadable inputs, unresolved rows, or count drift.

Do not create one task per item. Keep the seven phase tasks from `SKILL.md` and
track batch-level progress in files.

When a batch needs a separate context, dispatch one `Task` reviewer with the
batch paths, exact row range, schema snapshot, output file, and completion
rules. Wait for it, reconcile its output, then dispatch the next batch.
Sequential review prevents duplicate decisions and concurrent edits.

## Persistent work files

Create this report package:

```text
docs/webapi-selectall-migration/
├── migration-report.html
├── batch-ledger.csv
├── table-identifiers.txt
├── table-schema.json
├── table-schema.pass-<N>.json
├── table-column-evidence.csv
├── wildcard-configurations.csv
├── explicit-configurations.csv
├── api-call-coverage.csv
└── verification-ledger.csv
```

Create each HTML, CSV, and line-list file from the matching template in
`assets/report-assets.json`. The Dataverse schema utility produces schema JSON
files directly; do not hand-author or template those files.

Use stable row identifiers:

- configuration: relative path, setting name, and name line;
- API candidate: relative path, marker line, and occurrence number.

Never use only an array index because insertions change it.

The `batch-ledger.csv` header is fixed by its asset. Allowed status values are
`pending`, `in_progress`, `completed`, and `blocked`. A completed batch must
have `item_count = output_rows`.

## Batch sizing

Start with:

- 200 configuration records per batch;
- 100 straightforward API candidates per batch;
- 25 dynamic or wrapper-heavy API candidates per batch.

Reduce a batch when source tracing crosses many files. Increase it only when
records are repetitive and each remains individually represented. Do not
exceed 1,000 records in one review batch.

For one very large aggregate YAML or source file, use line ranges with a small
overlap. Deduplicate overlapping rows by their stable identifier.

## Inventory batching

Inventory configurations by directory and file. For large aggregate YAML:

1. locate every `Webapi/` name line;
2. read bounded ranges containing complete records;
3. classify each fields setting as wildcard or explicit;
4. record enabled, missing, and duplicate settings;
5. append each reviewed row immediately to the appropriate CSV;
6. reconcile batch input and output counts before continuing.

Inventory source in two passes:

1. identify authoritative source roots and exclude every compiled, generated,
   minified, cached, deployment-output, and source-map path;
2. within each file batch, locate occurrences and trace each call through
   callers and consumers.

For code/SPA sites, derive exclusions from `powerpages.config.json`
`compiledPath`, bundler configuration, and `.powerpages-site/web-files/`.
Exclude content-hashed assets even when checked in. If editable source is
missing, create a `missing-source` blocker; never analyze the output bundle.

## Compact global evidence

Do not keep all call rows in context while planning fields. Maintain
`table-column-evidence.csv` with one row per table and column using its fixed
asset header.

Append or update this compact matrix after each API batch. `evidence_row_ids`
contains stable API row identifiers, not source snippets or data.

Before configuration planning, reconcile:

```text
Source API candidates discovered
= mapped + non-table + not-a-call
```

Any difference means the inventory is incomplete.

## Schema batching and throttling

Maintain one deduplicated identifier per line in `table-identifiers.txt`.
Include setting logical names, request entity sets, and directly represented
related entity sets.

Run the schema utility once for that unique list:

```bash
node "${PLUGIN_ROOT}/skills/migrate-webapi-selectall/scripts/query-table-schema.js" --project-root "<PROJECT_ROOT>" --environment-url "<ENVIRONMENT_URL>" --tables-file "<PROJECT_ROOT>/docs/webapi-selectall-migration/table-identifiers.txt" --output "<PROJECT_ROOT>/docs/webapi-selectall-migration/table-schema.json"
```

After the initial query, resolve used navigation properties through the
returned relationship metadata. Put only newly discovered target logical names
in `table-identifiers-pass-<N>.txt` and write each result to
`table-schema.pass-<N>.json`. Repeat for nested expansion paths. Treat all
snapshots as one schema package and never query a logical table already
present in any snapshot.

The utility:

- deduplicates identifiers before requests;
- queries tables sequentially;
- paginates metadata results;
- refreshes authentication between bounded table batches;
- retries transient HTTP 408, 429, and 5xx failures with exponential delays;
- checkpoints completed table batches beside the output file.

Do not run concurrent schema utilities against the same environment. If
throttling persists after bounded retries, stop, wait, and resume the
checkpoint. Never create one metadata request sequence per configuration.

## Configuration planning batches

After API evidence is complete:

1. calculate the evidence-backed union for each logical table;
2. review wildcard configurations in bounded batches;
3. copy the table proposal only after confirming that batch uses the same site
   behavior and configuration scope;
4. give every wildcard row its exact replacement and evidence identifiers;
5. review explicit configurations separately for missing or unnecessary
   columns;
6. reconcile each configuration batch before marking it completed.

Do not assume identical table names across separate sites share behavior.
Process separate project roots independently.

Before approval, reconcile:

```text
Fields configurations discovered
= wildcard configurations + explicit configurations

Wildcard configurations
= ready replacements + blocked replacements
```

Approval requires zero blocked replacements.

## Batched editing

Apply source and configuration edits one completed batch at a time:

1. re-read the target range immediately before editing;
2. apply only approved rows;
3. re-read every changed range;
4. compare the scoped diff with the batch;
5. update report status and batch counts;
6. create a git checkpoint after a manageable group of completed batches.

Use one configuration file as the maximum transaction boundary when files are
large. If a batch fails, stop that batch and leave later batches pending. Do
not issue concurrent edits to the same file.

## Scalable reporting

For 500 or fewer configurations, write all tables directly into
`migration-report.html`. Above that threshold:

- keep summary counts, decisions, and every reviewed row in
  `migration-report.html`;
- put every wildcard row in `wildcard-configurations.csv`;
- put every already-explicit row in `explicit-configurations.csv`;
- put every API candidate in `api-call-coverage.csv`;
- optionally link all three ledgers from the HTML report.

Build large HTML tables in bounded, ordered row fragments and assemble them
without loading the complete report into one model context. The final HTML
must contain every row and reconcile to the ledgers. Escape dynamic HTML text
and escape CSV cells beginning with `=`, `+`, `-`, or `@` to prevent markup or
spreadsheet formula execution.

Each fragment must match the column order of its corresponding row token in
`assets/migration-report-template.html`. Each CSV row must match its own asset
header. Assemble fragments only into the matching template table body and
preserve every static template element.

## Independent verification

Create a new `verification-ledger.csv`; do not overwrite the review ledger.
Repeat discovery in fresh batches and reconcile:

```text
Original wildcard count
= fixed wildcard count + remaining wildcard count

Verification candidates
= resolved verification rows
```

Completion requires zero remaining wildcards, zero unresolved verification
rows, exact approved values, and all report appendix counts matching their
ledgers.
