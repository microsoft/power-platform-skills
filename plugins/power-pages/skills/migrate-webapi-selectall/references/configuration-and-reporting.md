# Configuration and Reporting Contract

## Contents

- [Configuration layouts](#configuration-layouts)
- [Configuration scopes](#configuration-scopes)
- [Report](#report)
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
  adx_value: <column-name-1>,<column-name-2>
```

SPA sites can contain the same aggregate shape at
`.powerpages-site/sitesetting.yml`, or one file per setting:

```text
.powerpages-site/site-settings/*.sitesetting.yml
```

```yaml
id: <site-setting-id-1>
name: Webapi/<table-1>/fields
value: <column-name-1>,<column-name-2>
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

## Report

Copy the bundled template unchanged, then fill it in:

```text
${PLUGIN_ROOT}/skills/migrate-webapi-selectall/assets/migration-report-template.html
```

```text
docs/webapi-selectall-migration/migration-report.html
```

The asset is the format contract. Preserve its template version, static HTML,
section IDs, headings, table columns, accessibility attributes, and CSS. Do
not add sections, styling, or scripts.

Replace each token exactly once:

```text
REPORT_STATUS            Complete | Partial | Draft | Failed
GENERATED_AT             ISO 8601 date and time
WILDCARD_FOUND_COUNT     wildcard fields settings discovered
WILDCARD_FIXED_COUNT     wildcards replaced and verified
WILDCARD_REMAINING_COUNT wildcards still present
EXPLICIT_SETTING_COUNT   already-explicit settings reviewed
SCOPE_NOTE               one sentence naming the configuration scopes,
                         deployment profiles, and source call sites reviewed
WILDCARD_ROWS            one table row per wildcard setting
EXPLICIT_ROWS            one table row per already-explicit setting
```

Build row tokens only from `<tr>` and `<td>` elements matching the template's
column order. Use one row spanning the full column count when a collection is
empty. Put `Blocked` and the reason in the wildcard status cell when a
replacement cannot be proven.

Escape `&`, `<`, `>`, `"`, and `'` in every dynamic value. Record only
relative paths, line numbers, table names, and column names. Never include
absolute local paths, source snippets, request or response bodies, tokens,
environment URLs, hostnames, filter literals, record identifiers, or user
data.

## Completion criteria

The wildcard migration is complete only when:

- every configuration file and deployment scope was inspected;
- every original wildcard has an approved explicit replacement;
- every candidate source `/_api/` occurrence has a resolved disposition;
- every proposed field has source or contract evidence and schema validation;
- every normal table GET has an explicit `$select`;
- a fresh independent pass finds zero wildcard field settings;
- the report includes every wildcard and already-explicit setting.

If explicit settings still have unresolved missing or overbroad fields, set
`REPORT_STATUS` to `Partial` rather than claiming full Web API hardening.

## Public references

- [Important upcoming changes and deprecations in Power Pages](https://learn.microsoft.com/en-us/power-pages/important-changes-deprecations#wildcard-value--in-web-api-field-configuration)
- [Portals Web API overview](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview)
- [Query data using portals Web API](https://learn.microsoft.com/en-us/power-pages/configure/read-operations)
- [Use portals Web API write, update, and delete operations](https://learn.microsoft.com/en-us/power-pages/configure/write-update-delete-operations)
- [Overview of developer capabilities](https://learn.microsoft.com/en-us/power-pages/configure/developer-overview)
- [Create a code site using AI coding agents](https://learn.microsoft.com/en-us/power-pages/configure/create-code-site-using-claude-code)
- [Power Platform CLI pages commands](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages)
