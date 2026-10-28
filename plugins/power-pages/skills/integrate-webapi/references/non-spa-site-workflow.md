# Non-SPA Site Web API Workflow

Follow this workflow when `detect-project-context.js` returns `siteType: "non-spa"`. Preserve
the seven integrate-webapi phases, approval gates, task tracking, skill tracking, and deployment
handoff. Do not execute the SPA-specific TypeScript service, hook, framework-build, or
`powerPagesApi.ts` instructions in the main skill.

Non-SPA sites are native Power Pages sites. Prefer an existing Basic Form, Advanced Form,
List, or Liquid/FetchXML implementation when it already satisfies the requirement. Use browser
Web API JavaScript only when the requested interaction needs custom client-side behavior.

## Phase 1: Verify Site and Request Mode

1. Use the context returned by:

   ```bash
   node "${PLUGIN_ROOT}/scripts/lib/detect-project-context.js"
   ```

2. Record `projectRoot`, `siteRoot`, `siteName`, and `websiteRecordId`. The site root may be
   `<projectRoot>/.powerpages-site/` or the directly opened PAC export.
3. Run the shared Dataverse prerequisites and treat the environment returned by `pac env who` as
   the exact target. Non-SPA exports do not contain a reliable environment URL.
4. Read `.solution-manifest.json` when present so newly created Power Pages records can be included
   in the selected solution.
5. Classify `$ARGUMENTS`:
   - **Request-focused mode** — the user named a page, table, operation, or capability. Analyze that
     scope first and inspect dependencies only as needed.
   - **Discovery mode** — no actionable scope was supplied. Inspect the active site and present
     selectable integration opportunities; do not implement every finding automatically.

6. Parse the optional generic parent contract:
   - If `$ARGUMENTS` contains `[CALLED-BY-PARENT-SKILL]`, set `caller-suppress = true` and retain
     the optional `caller=<skill-name>` value for the final result.
   - Caller-suppress mode skips every commit and Phase 7 deployment prompt/reminder. The parent
     owns the combined commit and single deployment decision.
   - It does not skip the Phase 3 scope gate, architect plan approval, validation, or usage
     tracking. The sentinel is not user approval for local or cloud changes.
   - Without the sentinel, preserve the normal interactive commit/deployment behavior.

The `[AI-READ-ONLY]` delegated contract is SPA-only. If it is supplied for a non-SPA site,
stop and report the unsupported caller contract rather than silently changing its meaning.

Create the same seven task subjects used by the SPA workflow, but use these non-SPA
descriptions:

| Task subject | Description |
|---|---|
| Verify site exists | Resolve the non-SPA site root, identity, target environment, and metadata availability |
| Explore integration points | Analyze active Forms, Lists, Liquid, templates, JavaScript, settings, and permissions |
| Review integration plan | Present the focused request or discovered opportunities and confirm scope |
| Implement integrations | Apply only the approved native, Liquid, Web File, or caller changes |
| Verify integrations | Run non-SPA site inventory, syntax, reference, schema, and security checks |
| Setup permissions and settings | Configure approved least-privilege permissions and explicit field settings |
| Review and deploy | Present the non-SPA summary and optionally invoke the non-SPA deployment route |

## Phase 2: Discover Integration Opportunities

Use one Explore agent to inspect the exact `siteRoot`. Provide the user's request, site identity,
target environment, and request mode. Require the agent to inspect:

- `basic-forms/`, `advanced-forms/`, and `lists/`
- `web-pages/**/*.webpage.copy.html`
- `web-templates/**/*.webtemplate.source.html`
- JavaScript assets and metadata under `web-files/`
- `page-templates/`, `{% include %}` calls, and active caller relationships
- `site-settings/`, especially `Webapi/<table>/enabled` and `Webapi/<table>/fields`
- `table-permissions/` and `web-roles/`
- Liquid `{% fetchxml %}`, Liquid entity access, `/_api/`, `webapi.safeAjax`,
  `shell.getTokenDeferred`, `fetch`, `$.ajax`, and `XMLHttpRequest`
- `.datamodel-manifest.json` when present

Follow active webpage -> page-template -> web-template -> include/snippet/Web File reachability.
Plain text, navigation labels, CSS, images, and unreachable templates are not data-integration
evidence.

For every candidate, query Dataverse for the authoritative table `LogicalName`, `EntitySetName`,
column `LogicalName` values, primary key, forms, saved views, and relationship Navigation
Properties needed by the request. Do not guess plural entity-set names or case-sensitive fields.

Classify each finding:

| Classification | Meaning | Default action |
|---|---|---|
| Native capability already satisfies the request | Existing Form, Advanced Form, List, or Liquid implements it safely | Reuse; no Web API code |
| Native capability can satisfy the request | An existing downloaded native record can be embedded or reused | Prefer native composition |
| Custom Web API interaction required | Dynamic client behavior cannot be met by the available native components | Propose Web API JavaScript |
| Configuration or security defect | Existing API code lacks settings, fields, CSRF handling, permissions, or role coverage | Repair only the defect |
| Already integrated correctly | Code, settings, and least-privilege security are complete | Valid no-change result |
| Needs clarification | Evidence cannot establish the requested operation or security scope | Do not implement |

Do not construct missing Basic Form, List, Advanced Form, Dataverse form, or saved-view records
locally. If the preferred native record is absent, either propose an appropriate custom Web API
implementation or report the maker prerequisite.

## Phase 3: Review and Confirm Scope

Present:

- exact site and target environment;
- request-focused result or discovery-mode opportunities;
- affected pages, templates, and active callers;
- tables, exact fields, relationships, and CRUD operations;
- existing native components and configuration that will be reused;
- the proposed implementation type: reuse, native composition, Liquid, Web API JavaScript,
  configuration/security repair, no change, or blocked prerequisite;
- proposed Web API settings, permissions, scopes, and web roles;
- exact local files and metadata records that would change;
- ignored unreachable or presentational references.

Use the existing `integrate-webapi:3.2.confirm-tables` gate in the main skill as the scope-and-plan
approval gate. In discovery mode, let the user select one or more opportunities. In
request-focused mode, let the user approve the focused plan, request changes, or cancel. No local
or Dataverse writes occur before approval.

## Phase 4: Implement the Approved Local Integration

Apply only the approved implementation:

The component identifiers in
`${PLUGIN_ROOT}/skills/edit-site/references/non-spa-site-authoring.md` select reference workflows,
not `Skill` invocations. Keep each authoring handoff within the approved integration scope,
preserving component approvals and verification; do not request a site-wide redesign, unrelated
commits, or deployment.

### Reuse or no change

Do not manufacture file changes. Record the evidence proving that the existing native capability
or integration satisfies the request.

### Native component composition

Only embed a Basic Form, List, or Advanced Form record that already exists in the downloaded site.
Invoke `author-webpage-content` with the exact existing localized body target, native record name,
locale, Bootstrap evidence, and preservation requirements. Do not fabricate record IDs or create
backing Dataverse forms/views.

### Liquid or Web Template integration

Invoke `/edit-site` for the exact web-template or webpage metadata operation, and
`author-webpage-content` for localized body HTML/Liquid. Pass the exact active caller,
FetchXML/table requirements, output encoding requirements, and preservation boundaries. Keep data
access server-rendered when no custom client interaction is required.

### Web API JavaScript integration

1. Invoke `/edit-site` with the `author-web-file` operation to create or modify the JavaScript Web
   File and its adjacent metadata.
2. When the script is not already loaded, invoke `/edit-site` for the exact web-template or webpage
   metadata caller change, or `author-webpage-content` for a localized body caller.
3. Require:
   - relative `/_api/` endpoints using the Dataverse-resolved entity-set name;
   - anti-forgery token handling through the site's existing supported pattern
     (`webapi.safeAjax`, `shell.getTokenDeferred`, or an equivalent wrapper that sends
     `__RequestVerificationToken`);
   - explicit `$select` fields and bounded `$expand`, `$filter`, and `$orderby`;
   - safe OData literal and URL encoding;
   - correct `@odata.bind` Navigation Properties for lookup writes;
   - loading, empty, success, validation, and user-visible error states;
   - pagination when a collection can exceed one page;
   - no credentials, tokens, environment URLs, or user data embedded in source.

Do not create SPA files, framework hooks, TypeScript service scaffolds, or
`src/shared/powerPagesApi.ts`.

Do not use `git add -A`. Stage only the approved non-SPA site files if the user asks for a
commit, so unrelated worktree changes remain untouched. In caller-suppress mode, do not create a
commit even if the parent requested implementation; return the exact changed-file list instead.

## Phase 5: Verify the Local Integration

Verification must use a different path from creation:

1. Re-read every changed Web File, webpage, and template plus its metadata.
2. Verify every caller resolves to the intended asset or Liquid/template implementation.
3. Run JavaScript syntax checks for changed JavaScript assets.
4. Confirm every `/_api/` call sends an anti-forgery token, uses a relative endpoint, and requests
   only approved fields and operations.
5. Confirm there are no leftover mock-data paths or duplicate event handlers in the approved
   scope.
6. Run:

   ```bash
   node "${PLUGIN_ROOT}/skills/integrate-webapi/scripts/validate-webapi-integration.js"
   ```

7. Report runtime behavior, browser rendering, authenticated role assignment, and live Dataverse
   responses as pending until the user approves deployment and tests the uploaded site.

There is no SPA framework build for a non-SPA site.

## Phase 6: Configure Permissions and Settings

Reuse the main skill's existing permissions-source gate and Path A/Path B choices, but pass
`siteType: non-spa`, `projectRoot`, and `siteRoot` to both architects.

Use these non-SPA-only prompts rather than changing the SPA prompts in the main skill:

**Table permissions architect:**

> "Analyze this non-SPA Power Pages site and propose table permissions.
> Site type: non-SPA.
> Project root: [projectRoot].
> Site root: [siteRoot].
> The following tables and operations are in the approved integration scope:
> [tables and operations].
> Check active Forms, Lists, Liquid, JavaScript, existing web roles, and table permissions.
> Propose a least-privilege plan covering only the approved scope. After I approve the plan,
> create required web role and table permission YAML files using the deterministic scripts."

**Web API settings architect:**

> "Analyze this non-SPA Power Pages site and propose Web API site settings.
> Site type: non-SPA.
> Project root: [projectRoot].
> Site root: [siteRoot].
> The following tables, fields, and operations are in the approved integration scope:
> [tables, fields, and operations].
> Check active Forms, Lists, Liquid, JavaScript, and existing settings, then query Dataverse for
> exact column LogicalNames. Propose explicit settings with case-sensitive validated column names.
> After I approve the plan, create required site setting YAML files using the deterministic
> scripts."

For non-SPA sites, the architects must analyze the approved operations plus existing Forms,
Lists, Liquid, JavaScript, permissions, roles, and settings. They must:

- reuse equivalent records instead of creating duplicates;
- create or update `Webapi/<table>/enabled`;
- create or update `Webapi/<table>/fields` with exact explicit fields, never `*`;
- grant only the approved read/create/write/delete/append/append-to operations;
- choose Contact, Account, Parent, Self, or Global scope from actual relationships and user access;
- preserve existing broader native-component requirements when narrowing a shared permission or
  fields setting would break an active Form/List/API caller;
- require explicit user approval through the existing architect plan flow before file creation.

Use the shared deterministic scripts for new records. They resolve nested and direct PAC roots.
For an existing setting or permission, make a guarded minimal edit after comparing every active
caller; creation scripts intentionally reject duplicates.

Validate exact field casing and relationship names against Dataverse. A non-SPA site can
legitimately finish with configuration-only changes when its Web API code already exists.

## Phase 7: Review and Deploy

Present a site-type-specific summary:

| Area | Report |
|---|---|
| Native components reused | Forms, Lists, Advanced Forms, or Liquid retained |
| Local implementation | Web Files, webpages, or templates changed |
| Dataverse access | Tables, fields, entity sets, and CRUD operations |
| Security | Settings, permissions, scopes, and web roles created/reused/changed |
| Verification | Static checks passed and live checks still pending |

Record skill usage as `IntegrateWebApi`.

In caller-suppress mode, return the summary, exact changed-file list, validations, and
`caller=<skill-name>` value to the parent. Skip `integrate-webapi:7.3.deploy` and any deployment
reminder.

Otherwise, use the existing `integrate-webapi:7.3.deploy` gate. If approved, invoke `/deploy-site`
with the exact `projectRoot`; its non-SPA route performs `pac pages upload` with the explicit
data model. If deployment is deferred, state that local validation is complete but Web API
behavior is not live-verified.
