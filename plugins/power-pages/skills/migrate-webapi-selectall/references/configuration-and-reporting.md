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
- adx_name: Webapi/<table>/fields
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
name: Webapi/<table>/fields
value: <column-name-1>,<column-name-2>
```

Modular files can use either `name` and `value` or `adx_name` and
`adx_value`. Inspect deployment-profile copies too.

## Configuration scopes

Treat each aggregate `sitesetting.yml` as its own scope. Treat modular setting
files in the same `site-settings` directory as one scope. Deployment profiles
are separate scopes even when they contain the same setting name.

For each scope:

- pair `Webapi/<table>/enabled` with `Webapi/<table>/fields`;
- identify missing, duplicate, wildcard, and already-explicit field settings;
- preserve record identifiers, key style, quoting, comments, and unrelated
  values;
- use logical table names in settings and `EntitySetName` in requests.

Table permissions and column permissions remain separate authorization
layers. Replacing `*` reduces the exposed Web API surface but does not repair
overbroad record permissions.

## Report

Write the report data, then render it. Never hand-write report HTML; the
renderer is the encoding boundary that keeps setting names, column names, and
paths as data.

Write the data file to:

```text
docs/webapi-selectall-migration/migration-report.json
```

```json
{
  "REPORT_STATUS": "Complete | Partial | Draft | Failed",
  "SCOPE_NOTE": "<one sentence naming the configuration scopes, deployment profiles, and source call sites reviewed>",
  "WILDCARD_DATA": [
    {
      "setting": "Webapi/<table>/fields",
      "status": "Pending | Migrated | Removed | Blocked",
      "usages": [
        {
          "location": "<relative path>:<line>",
          "detail": "<what this call site reads>"
        }
      ],
      "fields": [
        "<column-name-1>",
        "<column-name-2>"
      ],
      "finding": "<evidence proving this column set>",
      "fix": "<what was changed, or what is still required>"
    }
  ],
  "EXPLICIT_DATA": [
    {
      "setting": "Webapi/<table>/fields",
      "status": "Least privilege | Incomplete | Overbroad",
      "usages": [
        {
          "location": "<relative path>:<line>",
          "detail": "<what this call site reads>"
        }
      ],
      "fields": [
        "<configured-column-1>"
      ],
      "finding": "<comparison against observed usage>",
      "fix": "<proposed change, or no change required>"
    }
  ]
}
```

Both arrays are required and may be empty. One setting gets one entry, however
many call sites it has: list every call site in `usages` so the report shows the
same table read through different wrappers or pages. `status` selects the badge
tone and the counters, so use the listed values. Use `Pending` in the draft
report before replacements are proposed, and `Blocked` for a wildcard whose
replacement cannot be proven, stating in its `fix` what the user has to decide.
Use an empty `fields` array when a setting is removed or blocked.

Render with:

```bash
node "${PLUGIN_ROOT}/skills/migrate-webapi-selectall/scripts/render-migration-report.js" --output "<PROJECT_ROOT>/docs/webapi-selectall-migration/migration-report.html" --data "<PROJECT_ROOT>/docs/webapi-selectall-migration/migration-report.json"
```

The renderer refuses to overwrite, so delete the previous
`migration-report.html` before re-rendering an updated report. It stamps the
generated time itself, and also writes `power-pages-icon.png` beside the
report; leave that file in place.

Record only relative paths, line numbers, table names, and column names. Never
include absolute local paths, source snippets, request or response bodies,
tokens, environment URLs, hostnames, filter literals, record identifiers, or
user data.

## Completion criteria

The wildcard migration is complete only when:

- every configuration file and deployment scope was inspected;
- every original wildcard has an approved explicit replacement;
- every candidate source `/_api/` occurrence has a resolved disposition;
- every proposed field has source or contract evidence and schema validation;
- every normal table GET has an explicit `$select`;
- a fresh independent pass finds zero wildcard field settings;
- the report includes every wildcard and already-explicit setting;
- only `migration-report.html` remains in the migration output directory.

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
