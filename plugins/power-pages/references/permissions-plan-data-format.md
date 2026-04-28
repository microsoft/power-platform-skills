# Permissions Plan Data Format

Reference document for generating the HTML permissions plan file using `render-permissions-plan.js`. Covers the JSON data structure, role/permission/rationale formats, and rendering instructions.

## Design Rationale Items

Prepare an array of design rationale items that explain the permissions architecture. Each item has an icon, title, and description. Include rationale for:

- **Why this permissions structure** — Explain the overall security model (e.g., "The site uses a two-role model: Anonymous Users for public catalog browsing and Authenticated Users for order management.")
- **Scope decisions** — Summarize why each scope was chosen and any alternatives considered
- **Security trade-offs** — Note any permissions that are more permissive than ideal and why

## Generating the HTML Plan File

**Do NOT generate HTML manually or read/modify the template yourself.** Use the `render-plan.js` script which mechanically reads the template and replaces placeholder tokens with your data.

### Determine Output Location

- **If working in the context of a website** (a project root with `powerpages.config.json` exists): write the file to `<PROJECT_ROOT>/docs/permissions-plan.html`
- **Otherwise**: write to the system temp directory (`[System.IO.Path]::GetTempPath()`)

### Prepare Data

Write a temporary JSON data file (e.g., `<OUTPUT_DIR>/permissions-plan-data.json`) with these keys:

```json
{
  "SITE_NAME": "The site name (from powerpages.config.json or folder name)",
  "SUMMARY": "A 1-2 sentence summary of the plan",
  "ROLES_DATA": [/* array of role objects */],
  "PERMISSIONS_DATA": [/* array of permission objects */],
  "RATIONALE_DATA": [/* array of rationale objects */]
}
```

### ROLES_DATA Format

JSON array where each element is:

```json
{
  "id": "r1",
  "name": "Authenticated Users",
  "desc": "Built-in role — baseline access for logged-in users",
  "builtin": true,
  "isNew": false,
  "color": "#4a7ce8"
}
```

- `id`: Short identifier (e.g., `"r1"`, `"r2"`) used to link permissions to roles
- `builtin`: `true` **only** for `Authenticated Users` and `Anonymous Users` — these are the only built-in Power Pages roles
- `isNew`: `true` if this role is proposed by the plan and will be newly created, `false` if it already exists in `.powerpages-site/web-roles/`
- The HTML template shows three distinct badges based on these flags:
  - **BUILT-IN** (gray) — `builtin: true` (only Authenticated Users / Anonymous Users)
  - **EXISTING** (green) — `builtin: false, isNew: false` (already created, found in web-roles folder)
  - **PROPOSED** (blue) — `builtin: false, isNew: true` (will be created by this plan)
- `color`: A distinct hex color for visual identification. Use these defaults:
  - `#4a7ce8` (blue) for the first custom role
  - `#7c5edb` (purple) for the second custom role
  - `#d4882e` (orange) for the third custom role
  - `#e07ab8` (pink) for additional custom roles
  - `#8890a4` (gray) for built-in roles

### PERMISSIONS_DATA Format

JSON array where each element is:

```json
{
  "id": "p1",
  "name": "Product - Read",
  "displayName": "Product",
  "table": "cra5b_product",
  "scope": "Global",
  "read": true,
  "create": false,
  "write": false,
  "delete": false,
  "append": true,
  "appendto": false,
  "roles": ["r1", "r2"],
  "parent": null,
  "parentRelationship": null,
  "rationale": {
    "scope": "Global scope because the product catalog is public reference data with no user ownership.",
    "read": "Products must be visible to anonymous visitors for catalog browsing.",
    "append": "Orders reference products via a lookup column, requiring Append on the target table so records can be linked to it."
  },
  "isNew": true
}
```

- `name`: The permission name (used as `entityname` in the YAML file)
- `displayName`: Human-friendly table display name shown in the UI (e.g., `"Product"`, `"Order Item"`)
- `isNew`: `true` if this permission is proposed by the plan, `false` if it already exists in `.powerpages-site/table-permissions/`. Proposed permissions are highlighted with a blue background and `PROPOSED` badge; existing ones show an `EXISTING` badge.
- `roles`: Array of role `id` values from ROLES_DATA
- `parent`: The `id` of the parent permission (for Parent scope), or `null`
- `parentRelationship`: The Dataverse relationship SchemaName (for Parent scope), or `null`
- `rationale`: An object with per-aspect reasoning, rendered as a bulleted list under the "Reasoning" label. Include a key for `scope` plus one key for each **enabled** privilege explaining why it is necessary. Omit keys for disabled privileges. Available keys:
  - `scope` — Why this scope was chosen (e.g., "Contact scope because each user should only see their own orders")
  - `read` — Why read access is needed
  - `create` — Why create access is needed
  - `write` — Why write access is needed
  - `delete` — Why delete access is needed
  - `append` — Why append is needed (e.g., "Referenced by orders via a lookup column — other records link to this table")
  - `appendto` — Why appendto is needed (e.g., "This table has a lookup to Product Category set during create — this table links to other records")

### RATIONALE_DATA Format

JSON array where each element is:

```json
{
  "icon": "\uD83D\uDEE1\uFE0F",
  "title": "Least Privilege by Default",
  "desc": "Every permission uses the narrowest scope possible. Global scope is only used for read-only public content."
}
```

Use HTML entity references for icons if needed: `&#x1F6E1;&#xFE0F;` (shield), `&#x1F517;` (link), `&#x1F464;` (user), `&#x1F512;` (lock).

### Render the HTML File

Run the render script (it creates the output directory if needed):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-permissions-plan.js" --output "<OUTPUT_PATH>" --data "<DATA_JSON_PATH>"
```

The render script refuses to overwrite existing files. Before calling it, check if the default output path (`<PROJECT_ROOT>/docs/permissions-plan.html`) already exists. If it does, choose a new descriptive filename based on context — e.g., `permissions-plan-support-tables.html`, `permissions-plan-apr-2026.html`. Pass the chosen name via `--output`.

Delete the temporary data JSON file after the script succeeds.

### Open in Browser

Open the generated HTML file in the user's default browser.
