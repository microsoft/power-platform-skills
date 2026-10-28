# Non-SPA Site Permissions Audit

Follow this workflow only when the existing SPA lookup found no `powerpages.config.json` and
`detect-project-context.js` returned `siteType: "non-spa"`. Preserve the same seven phases,
task tracking, autonomous analysis, A-K table-permission checklist, report schema, skill tracking,
final fix-offer gate, and read-only boundary as the SPA workflow.

Do not execute the SPA-specific source-code discovery or `.powerpages-site` deployment prerequisite.
A non-SPA site is already represented by downloaded PAC metadata. Its component root may be
`<projectRoot>/.powerpages-site/` or the directly opened PAC export.

Non-SPA data model and local serialization are separate facts:

- Determine the **Standard or Enhanced data model** from authoritative `pac pages list -v`
  output for the resolved website. Do not infer it from filenames or field prefixes.
- Detect **aggregate or per-record storage** independently. Both data models can use aggregate
  `webrole.yml`, `sitesetting.yml`, and `webpagerule.yml`; downloaded records can also use
  per-record directories.
- Table permissions can use normalized or `adx_`-prefixed fields independently of the model.

The audit must read every supported storage shape without converting one serialization into
another. Treat mixed aggregate/per-record storage for the same component type as ambiguous and
fail closed for deterministic validation or fixes.

## Phase 1: Verify the Non-SPA Site

1. Use the context returned by:

   ```bash
   node "${PLUGIN_ROOT}/scripts/lib/detect-project-context.js"
   ```

2. Require `siteType: "non-spa"` and record `projectRoot`, `siteRoot`, `siteName`, and
   `websiteRecordId`.
3. Confirm `siteRoot` contains `.portalconfig/` or `website.yml`. Do not require
   `powerpages.config.json`.
4. If `table-permissions/` is absent or empty, retain that as possible evidence rather than
   stopping. The site may still contain active Forms, Lists, Liquid, or Web API callers that need
   permissions.
5. Keep analysis read-only. No local or Dataverse mutation occurs before the final fix offer.

Use the same seven task subjects as the SPA workflow with these descriptions:

| Task subject | Description |
|---|---|
| Verify site deployment | Resolve the non-SPA project/site roots, identity, data model, and metadata storage |
| Gather configuration | Inventory roles, table permissions, page rules, native components, settings, and active content |
| Run local schema validation | Validate supported aggregate or per-record metadata and block ambiguous mixed storage |
| Discover relationships | Query Dataverse for exact lookup and relationship metadata |
| Run audit checks | Audit every actively used or permission-bearing table and cross-check page/component access |
| Generate audit report | Render the normal permissions audit report under the non-SPA project root |
| Present findings | Summarize, record usage, and use the existing fix-offer gate |

## Phase 2: Gather Non-SPA Permission Evidence

Run the deterministic collector:

```bash
node "${PLUGIN_ROOT}/skills/audit-permissions/scripts/collect-non-spa-permission-evidence.js" \
  --projectRoot "<projectRoot>"
```

The collector normalizes:

- per-record `web-roles/*.webrole.yml` and aggregate `webrole.yml`;
- `table-permissions/*.tablepermission.yml` with normalized or `adx_`-prefixed fields;
- per-record `site-settings/*.sitesetting.yml` and aggregate `sitesetting.yml`;
- per-record `webpage-rules/*.webpagerule.yml` and aggregate `webpagerule.yml`;
- Basic Forms, Advanced Forms and their steps, Lists, webpages, Liquid/FetchXML, Web API endpoints,
  and active component tags.

Treat every `parseErrors` entry as a critical local-metadata finding with the exact file path. Read
the cited source file to establish the malformed shape; do not guess missing values.

### 2.1 Build the active source graph

Use the collector as a normalized inventory, then establish reachability:

```text
Webpage
  -> Page Template
    -> Web Template
      -> included Web Templates
      -> referenced Content Snippets
      -> referenced JavaScript Web Files
```

Follow:

- `{% entityform name: '...' %}` to an existing Basic Form;
- `{% webform name: '...' %}` to an Advanced Form and all of its steps;
- `{% include 'entity_list' key: '...' %}` to an existing List;
- `{% include %}` calls between reachable templates;
- Liquid `{% fetchxml %}`, `entities[...]`, and entity references;
- relative `/_api/` calls and their HTTP methods;
- webpage/page-template/web-template IDs and names from adjacent metadata.

Do not treat an unused Form, List, template, snippet, or Web File as active merely because it is
downloaded. Plain text, navigation labels, CSS, images, fonts, and unreachable templates are not
data-access evidence.

### 2.2 Inventory access-control surfaces

For every reachable data component, retain:

- source page/template/Web File;
- bound table and exact component name;
- operation evidence: read, create, write, delete, append, append-to, or relationship traversal;
- `entitypermissionsenabled` state for each Basic Form, Advanced Form step, and List;
- table permission scope, CRUD flags, relationships, and associated role IDs;
- active Web API settings, including explicit fields;
- webpage rule right, page ID, state/status, and role IDs;
- page ancestry because a Restrict Read rule can apply to descendants;
- authoritative data model, metadata storage, and record field shape as separate evidence.

`right: 2` is a Restrict Read page rule and is relevant to visitor access. `right: 1` is a Grant
Change rule for content management; report it separately and do not infer table-data access from it.
Ignore inactive page rules when their state/status proves they are inactive, but include that
evidence in the report.

### 2.3 Run local schema validation

Read `metadataStorage` and `metadataStorageByComponent` from the collector. If the global mode is
`aggregate`, `per-record`, or `hybrid`, run:

```bash
node "${PLUGIN_ROOT}/scripts/validate-permissions-schema.js" --projectRoot "<projectRoot>"
```

The shared validator is authoritative for supported aggregate and per-record table permissions,
site settings, and web roles, including normalized and `adx_`-prefixed records. `hybrid` means
different components use different valid conventions, such as aggregate roles with per-record
settings; validate each component in its own detected convention. Merge findings using the SPA
severity mapping. Validation never authorizes changing a component's storage convention.

If `metadataStorage` is `mixed`, report a critical local-metadata finding and do not run
deterministic fixes. `mixed` means at least one component contains both aggregate and per-record
records; it does not mean that separate components use separate valid conventions. Use the
collector's normalized output and source files for read-only analysis, and independently verify
required IDs, booleans, scopes, role references, parent chains, and duplicate IDs/names. An empty
or `unknown` inventory is not automatically invalid, but any proposed write must wait until the
target component's storage convention is known.

## Phase 3: Resolve Dataverse Metadata

Use `pac env who` to establish the exact target environment. Non-SPA exports do not contain a
reliable environment URL, so display the resolved environment in the report. Run `pac pages list
-v` and match the resolved website identity to determine its Standard or Enhanced data model.
If the website cannot be matched unambiguously, report the model as unknown; never derive it from
aggregate/per-record storage or `adx_` field names.

Reuse the main workflow's deterministic scripts:

```bash
node "${PLUGIN_ROOT}/skills/audit-permissions/scripts/query-table-lookups.js" \
  --envUrl "<envUrl>" --table "<table>"

node "${PLUGIN_ROOT}/skills/audit-permissions/scripts/query-table-relationships.js" \
  --envUrl "<envUrl>" --table "<table>"
```

Query lookup metadata for tables with create/write operations and relationship metadata for
Contact, Account, Parent, `$expand`, FetchXML link-entity, and native-component relationships.
Resolve native Dataverse form and saved-view bindings when component YAML does not expose enough
operation or field evidence.

When Dataverse access is available and metadata storage is unambiguous, rerun the shared schema
validator with live relationship verification exactly as the SPA workflow describes. For mixed
storage, keep validation read-only and use the deterministic lookup/relationship scripts against
the normalized records instead. If auth or metadata queries fail, continue with local evidence
and identify the skipped checks. Never invent relationship names, entity-set names, component
modes, or field access.

## Phase 4: Run the Non-SPA Audit

Build the table inventory from the union of:

1. existing table permissions;
2. reachable Basic Forms;
3. reachable Advanced Form steps;
4. reachable Lists;
5. reachable Liquid/FetchXML and linked entities;
6. reachable Web API calls and Web API settings;
7. `.datamodel-manifest.json` entries that are corroborated by active site evidence.

Create one per-table task and reuse the main workflow's A-K checklist in the same order. Substitute
non-SPA evidence for SPA source-code evidence:

| Main check | Non-SPA evidence |
|---|---|
| A. Permission existence | Reachable native component, Liquid/FetchXML, or Web API operation versus table permissions |
| B. Web role association | Permission role IDs versus normalized roles and inherited page Restrict Read roles |
| C. Scope appropriateness | Native component filters, page audience, Liquid filters, relationships, and actual user ownership |
| D-G. CRUD flags | Form mode, Advanced Form step behavior, List actions, Liquid reads, and Web API HTTP methods |
| H/H2. Append and AppendTo | Dataverse lookup maps plus native form/step writes and `@odata.bind` |
| I. Parent chain integrity | Normalized parent IDs/relationships plus live relationship metadata |
| J. Related-table coverage | FetchXML link-entity, `$expand`, List/view relationships, and native component dependencies |
| K. Record and complete | Exact non-SPA file/component/page evidence |

### Non-SPA-only security checks

Add these checks without changing the SPA checklist:

1. **Native permission enforcement disabled**
   - If a reachable Basic Form, Advanced Form step, or List performs create/write/delete or exposes
     personal/sensitive data while `entitypermissionsenabled` is false, report a critical finding.
   - For verified public read-only reference data, report a warning and require explicit review.
   - Do not flag an unreachable downloaded component.
2. **Page and table role mismatch**
   - Resolve inherited Restrict Read rules through page ancestry.
   - If the active page audience and table-permission roles do not overlap, report a critical
     functional finding.
   - If table permissions grant materially broader roles than the page, report a warning, or
     critical when write/delete access is exposed to the broader role.
3. **Anonymous access drift**
   - Cross-check the Anonymous Users role, unrestricted pages, native components, Web API settings,
     and table permissions. Report anonymous write/delete access as critical unless exact evidence
     proves it is intentional and safely scoped.
4. **Component operation drift**
   - Report missing CRUD flags required by active Form/List/step actions as critical.
   - Report enabled create/write/delete privileges with no active caller as informational, subject
     to the same reachability caveat as the SPA unused-permission check.
5. **Web API fields and token safety**
   - Reuse the SPA wildcard-field critical finding and explicit-field rules.
   - For reachable `/_api/` calls, require anti-forgery handling and least-privilege fields.
6. **Page rule integrity**
   - Report active Restrict Read rules with missing pages, invalid role IDs, or no intended role as
     critical.
   - Report Grant Change rules separately; do not count them as visitor read protection.

After per-table checks, run the main cross-table validations plus:

- every reachable component has a resolved table and permission-enforcement posture;
- every page-rule role resolves to an existing normalized web role;
- page ancestry and inherited Restrict Read coverage are internally consistent;
- data-model identity, metadata storage, and record field shape remain distinct in every proposed
  remediation.

## Phase 5: Generate the Report

Use the same `FINDINGS_DATA` and `INVENTORY_DATA` schema and the same mechanical renderer:

```bash
node "${PLUGIN_ROOT}/scripts/render-audit-report.js" \
  --output "<projectRoot>/docs/permissions-audit.html" \
  --data "<temporary-data-json>"
```

Use `siteName` from detected context or `website.yml`. Write under `<projectRoot>/docs/` for both
nested and directly opened PAC roots. If the default report already exists, use the same
non-overwriting descriptive-name behavior as the SPA workflow. Delete the temporary JSON after a
successful render and open the actual report path.

Include in the report:

- authoritative PAC data model (`standard`, `enhanced`, or `unknown`);
- metadata storage (`aggregate`, `per-record`, `mixed`, or `unknown`);
- exact project root, site root, site identity, and target environment;
- active versus ignored/unreachable evidence;
- native component enforcement findings;
- page-rule and table-role cross-checks;
- skipped live checks and their reason;
- whether each suggested fix is supported by deterministic storage-aware tooling, is blocked by
  mixed/unknown storage, or requires a maker action because the owning record is not supported.

## Phase 6: Present Findings and Offer Fixes

Record usage as `AuditPermissions` using the exact `projectRoot`; shared tracking resolves nested
or direct site roots and preserves aggregate or per-record site-setting storage. If storage is
mixed or cannot be determined safely, report that tracking was not written.

Use the existing `audit-permissions:6.fix-offer` gate from the main skill. Do not add another
approval question.

When the user accepts fixes:

- For supported aggregate or per-record table permissions, invoke `table-permissions-architect` with
  `siteType: non-spa`, exact `projectRoot`, exact `siteRoot`, tables, operations, role IDs,
  page/component evidence, relationships, authoritative data model, metadata storage, and current
  record field shape. The architect must preserve the detected storage and field conventions.
- Do not run deterministic fixes for mixed storage. Explain the conflicting paths and require the
  maker to reconcile the export before retrying.
- Native Form/List/Advanced Form permission-enforcement changes and webpage access-rule changes are
  not table-permission-file fixes. Identify the owning record and required maker action; do not
  silently edit unrelated metadata.
- Keep informational cleanup suggestions separate from critical access fixes.

Declining the gate leaves only the generated report. No permissions, roles, components, page
rules, site settings, or Dataverse records are modified.

## Phase 7: Complete and Verify

Before completing:

1. Confirm every inventory table has a completed task.
2. Confirm every finding cites a concrete file, component, page, rule, or Dataverse result.
3. Confirm data model was not inferred from serialization, normalized evidence stayed in memory,
   and no source metadata changed before an accepted fix.
4. Confirm the rendered report has no placeholder tokens.
5. Report live runtime behavior as unverified unless the user separately deploys and tests the
   site.

The normal `validate-audit.js` PostToolUse hook validates the report after the skill returns. Do
not run the hook directly; it expects hook JSON on stdin.
