# Non-SPA Site Web Roles Workflow

Follow this workflow only when the existing SPA lookup found no `powerpages.config.json` and
`detect-project-context.js` returned `siteType: "non-spa"`. Preserve the same six phases,
task subjects, caller-suppress contract, role-selection gate, uniqueness rules, skill tracking,
and deployment handoff as the SPA workflow.

Do not execute the SPA-specific `.powerpages-site` deployment prerequisite or project lookup.
Non-SPA sites already have downloaded PAC metadata, and `siteRoot` may be nested under
`<projectRoot>/.powerpages-site` or may be the directly opened PAC export.

## Phase 0: Detect Caller-Suppress Mode

Parse `[CALLED-BY-PARENT-SKILL]` and optional `caller=<skill-name>` exactly as the main skill does.
When caller-suppress mode is active:

- do not issue deployment prompts or reminders;
- return the created-role summary to the caller after validation and tracking;
- if no non-SPA site root is available, stop with a clear caller-contract violation.

When the sentinel is absent, use the normal interactive role-selection and final deployment flow.

## Phase 1: Verify Site Structure

1. Use the context returned by:

   ```bash
   node "${PLUGIN_ROOT}/scripts/lib/detect-project-context.js"
   ```

2. Require `siteType: "non-spa"` and record `projectRoot`, `siteRoot`, `siteName`, and
   `websiteRecordId`.
3. Confirm `siteRoot` contains non-SPA metadata (`.portalconfig/` or `website.yml`).
4. Detect role storage before creating anything.
   - If `<siteRoot>/webrole.yml` exists, use aggregate storage.
   - If `<siteRoot>/web-roles/` contains role records, use per-record storage.
   - If both contain records, stop with a mixed-storage error and identify both paths.
   - If neither exists, the deterministic writer creates the per-record directory.
   - Do not invoke the SPA `create-webroles:1.deploy-first` gate: a resolved non-SPA PAC root is
     already the required local metadata.
   - If no site root resolves, stop without writing files.

Use these task descriptions:

| Task subject | Description |
|---|---|
| Verify site structure | Resolve the non-SPA site and detect aggregate or per-record role storage |
| Discover existing roles | Normalize current non-SPA roles and compile existing names, IDs, and flags |
| Determine new roles | Analyze non-SPA site access needs and confirm roles through the existing selection gate |
| Create web role files | Create approved role YAML through the deterministic script |
| Verify web roles | Validate role files, UUIDs, names, booleans, and uniqueness constraints |
| Review and deploy | Present the non-SPA site summary and optionally invoke non-SPA deployment |

## Phase 2: Discover Existing Roles

Read roles from aggregate `<siteRoot>/webrole.yml` or per-record
`<siteRoot>/web-roles/*.webrole.yml`. For each normalized role, collect:

- `name`;
- `id`;
- `anonymoususersrole`;
- `authenticatedusersrole`.

Also inspect active table permissions, Forms, Advanced Forms, Lists, webpages, and access-control
metadata for evidence of role names already referenced by the site. Treat that evidence as context
for suggestions; do not create a role merely because a label appears in content.

Present the same existing-role summary as the SPA workflow. If no roles exist, report that clearly.

## Phase 3: Determine New Roles

Use the existing `create-webroles:3.role-selection` gate.

- If `$ARGUMENTS` names one or more roles, treat them as requested candidates, filter out existing
  names case-insensitively, and ask the user to approve the remaining roles and flags.
- Otherwise, suggest roles based on the site's active access requirements and business purpose.
- Preserve the standard role suggestions from the SPA workflow.
- Never suggest a role that already exists.
- Never set `anonymoususersrole: true` or `authenticatedusersrole: true` when an existing role
  already owns that flag.

No files are written before approval.

## Phase 4: Create Web Role Files

For each approved role, invoke:

```bash
node "${PLUGIN_ROOT}/skills/create-webroles/scripts/create-web-role.js" \
  --projectRoot "<projectRoot>" \
  --name "<Role Name>" \
  [--anonymous] \
  [--authenticated]
```

The script resolves nested or direct PAC roots, generates a UUID through the shared UUID helper,
appends atomically to aggregate `webrole.yml` or creates a PAC-compatible `*.webrole.yml` file,
and returns `{ id, filePath, storage }`. It rejects mixed storage.

Before each invocation, re-check all existing and newly created roles so the one-anonymous and
one-authenticated uniqueness constraints cannot be violated. Do not write role YAML manually.

## Phase 5: Verify Web Roles

1. Re-read all roles from the detected aggregate or per-record storage.
2. Verify every created file path returned by the script is inside the resolved site root.
3. The `PostToolUse` hook runs
   `${PLUGIN_ROOT}/skills/create-webroles/scripts/validate-webroles.js` automatically after the
   skill returns. Do not run the hook script directly: it expects the hook JSON payload on stdin.
4. Independently confirm:
   - each role has the approved name and a valid UUID;
   - both role flags are booleans;
   - IDs and role names are unique;
   - at most one role is anonymous and at most one is authenticated.

Fix validation failures before proceeding.

## Phase 6: Review and Deploy

Record skill usage as `CreateWebroles` using the exact `projectRoot`; the tracking script resolves
the direct or nested aggregate/per-record site-settings storage.

Present the same role summary table as the SPA workflow. When caller-suppress mode is inactive,
use the existing `create-webroles:6.deploy` gate. If approved, invoke `/deploy-site` with the exact
`projectRoot`; its non-SPA route uploads the PAC metadata. If deployment is deferred, state
that the roles exist locally but are not active in the environment.

In caller-suppress mode, skip the gate and deployment reminder and return the created-role summary
to the parent skill.
