# Configuration and Reporting Contract

## Contents

- [Configuration layouts](#configuration-layouts)
- [Configuration scopes](#configuration-scopes)
- [Report template](#report-template)
- [Companion file templates](#companion-file-templates)
- [Report structure](#report-structure)
- [Completion criteria](#completion-criteria)
- [Public references](#public-references)

## Configuration layouts

Scan every layout because framework choice does not determine serialization.

Traditional and downloaded declarative sites commonly use an aggregate file:

```text
sitesetting.yml
```

```yaml
- adx_name: Webapi/<table-1>/fields
  adx_sitesettingid: <site-setting-id-1>
  adx_value: <column-name-1>,<column-name-2>,<column-name-3>
```

Code sites can contain the same aggregate shape:

```text
.powerpages-site/sitesetting.yml
```

One-file-per-setting layouts commonly use:

```text
.powerpages-site/site-settings/*.sitesetting.yml
```

```yaml
id: <site-setting-id-1>
name: Webapi/<table-1>/fields
value: <column-name-1>,<column-name-2>,<column-name-3>
```

Modular files can use either `name` and `value` or `adx_name` and
`adx_value`. Inspect deployment-profile copies too.

## Configuration scopes

Treat each aggregate `sitesetting.yml` as its own scope. Treat modular setting
files in the same `site-settings` directory as one scope. Deployment profiles
are separate scopes even when they contain the same setting name.

For each scope:

- pair `Webapi/<table-1>/enabled` with `Webapi/<table-1>/fields`;
- identify missing, duplicate, wildcard, and already-explicit field settings;
- preserve record identifiers, key style, quoting, comments, and unrelated
  values;
- use logical table names in settings and `EntitySetName` in requests.

Table permissions and column permissions remain separate authorization
layers. Replacing `*` reduces the exposed Web API surface but does not repair
overbroad record permissions.

## Report template

Always read:

```text
${PLUGIN_ROOT}/skills/migrate-webapi-selectall/assets/report-assets.json
```

The manifest maps every generated report or ledger to its versioned template.
Copy each required asset without changing its static structure.

For the HTML report, copy:

```text
${PLUGIN_ROOT}/skills/migrate-webapi-selectall/assets/migration-report-template.html
```

to:

```text
docs/webapi-selectall-migration/migration-report.html
```

The asset is the format contract. Preserve its template version, static HTML,
section IDs, headings, table columns, accessibility attributes, and CSS.
Replace every `__TOKEN__` exactly once. Build row tokens only from `<tr>` and
`<td>` elements whose dynamic text has been HTML-escaped.

The template follows the established Power Pages report styling: Fluent
neutral surfaces, Power Pages blue accents, Segoe typography, a top bar,
responsive section navigation, stat cards, compact tables, and the standard
AI-generated-content footer. Do not substitute another visual system.

Required scalar tokens:

```text
REPORT_STATUS
GENERATED_AT
CONFIGURATION_FILE_COUNT
CONFIGURATION_SCOPE_COUNT
API_CALL_COUNT
WILDCARD_FOUND_COUNT
WILDCARD_FIXED_COUNT
WILDCARD_REMAINING_COUNT
EXPLICIT_SETTING_COUNT
UNRESOLVED_COUNT
```

Required collection tokens:

```text
LEDGER_LINKS
WILDCARD_ROWS
EXPLICIT_ROWS
API_CALL_ROWS
GAP_ROWS
VERIFICATION_ROWS
```

Use one row spanning the table's full column count when a collection is
empty. Replace `LEDGER_LINKS` with an accessible list item or an empty-state
list item. No `__TOKEN__` value may remain in a report shown at an approval
gate or in the final report.

## Companion file templates

Create every CSV by copying its header-only asset from the manifest before
appending rows. Never add, remove, rename, or reorder columns. Create
`table-identifiers.txt` from its line-list asset by replacing `<table-1>` and
then appending one deduplicated identifier per line.

Use these serialization rules for every CSV:

- UTF-8 text with the asset header as the first line;
- RFC 4180 quoting and doubled embedded quote characters;
- compact JSON arrays inside cells containing multiple values;
- canonical sorting for table, column, entity-set, and evidence-row arrays;
- lowercase `true` and `false` for booleans;
- empty fields for unavailable optional values;
- a leading apostrophe for cells beginning with `=`, `+`, `-`, or `@`.

Never put source snippets, filter literals, request bodies, response bodies,
record identifiers, environment values, or user data in companion files.

## Report structure

Write:

```text
docs/webapi-selectall-migration/migration-report.html
```

When inventory exceeds 500 configurations or call sites, the complete report
can retain machine-readable working ledgers:

```text
docs/webapi-selectall-migration/migration-report.html
docs/webapi-selectall-migration/wildcard-configurations.csv
docs/webapi-selectall-migration/explicit-configurations.csv
docs/webapi-selectall-migration/api-call-coverage.csv
```

The HTML file is the authoritative report and must contain every wildcard,
explicit configuration, and API coverage row. CSV files are working ledgers
and optional downloads, not substitutes for HTML content. Include their row
counts and relative links when retained.

The bundled asset provides one self-contained HTML5 document with:

- `lang`, UTF-8 charset, viewport metadata, and a descriptive title;
- semantic headings, tables, captions, and scoped header cells;
- text labels for every status so meaning never depends on color;
- inline CSS only, with no external scripts, fonts, styles, or network calls;
- HTML-escaped dynamic text for every path, table, column, status, and message.
- a skip link, persistent section navigation, and visible keyboard focus;
- keyboard-scrollable table regions with captions and column scopes;
- responsive layouts at 900, 560, and 360 CSS pixels;
- reduced-motion, forced-colors, and print adaptations.

Never insert repository text as raw HTML. Encode `&`, `<`, `>`, `"`, and `'`
before writing dynamic values into text or attribute contexts. Do not alter
the template to add per-run styling or sections.

Use these sections in this order:

1. **Summary**
   - configuration files and scopes scanned;
   - source table Web API call sites reviewed;
   - wildcard issues found, fixed, and remaining;
   - already-explicit settings reviewed;
   - unresolved items.
2. **Wildcard issues and proposed fixes**
   - setting and relative location;
   - logical table and matching entity sets;
   - actual required columns;
   - exact replacement value;
   - evidence references;
   - applied and verified status.
3. **Already-explicit configurations**
   - current configured columns;
   - observed required columns;
   - exact, missing, or potentially overbroad status;
   - proposed fix when a gap exists;
   - applied status when separately approved.
4. **Source Web API call-site coverage**
   - relative source and line;
   - request method and operation;
   - entity set and logical table;
   - columns required by query, body, and response consumption;
   - source `$select` change;
   - resolved disposition.
5. **Additional configuration gaps**
   - enabled tables without fields settings;
   - duplicate settings within one scope;
   - tables used without enabled settings;
   - schema or external-contract blockers.
6. **Verification**
   - fresh wildcard search;
   - approved-value comparison;
   - call-site coverage replay;
   - build or syntax result;
   - final pass, partial, or failed status.

Record only relative paths, line numbers, methods, table names, and column
names. Do not include absolute local paths, source snippets, request or
response bodies, tokens, environment URLs, hostnames, filter literals, record
identifiers, or user data.

## Completion criteria

The wildcard migration is complete only when:

- every configuration file and deployment scope was inspected;
- every original wildcard has an approved explicit replacement;
- every candidate source `/_api/` occurrence has a resolved disposition;
- every proposed field has source or contract evidence and schema validation;
- every normal table GET has an explicit `$select`;
- a fresh independent pass finds zero wildcard field settings;
- the report includes every wildcard and already-explicit configuration.

If explicit configurations still have unresolved missing or overbroad fields,
label the overall result `Wildcard migration complete; explicit follow-ups
remain` rather than claiming full Web API hardening.

## Public references

- [Important upcoming changes and deprecations in Power Pages](https://learn.microsoft.com/en-us/power-pages/important-changes-deprecations#wildcard-value--in-web-api-field-configuration)
- [Portals Web API overview](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview)
- [Query data using portals Web API](https://learn.microsoft.com/en-us/power-pages/configure/read-operations)
- [Use portals Web API write, update, and delete operations](https://learn.microsoft.com/en-us/power-pages/configure/write-update-delete-operations)
- [Overview of developer capabilities](https://learn.microsoft.com/en-us/power-pages/configure/developer-overview)
- [Create a code site using AI coding agents](https://learn.microsoft.com/en-us/power-pages/configure/create-code-site-using-claude-code)
- [Power Platform CLI pages commands](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages)
