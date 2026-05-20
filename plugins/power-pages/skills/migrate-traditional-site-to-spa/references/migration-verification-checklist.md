# Migration Verification Checklist

Use this reference during `/migrate-traditional-site-to-spa` Phase 5 to build a deterministic, evidence-backed checklist from the static analyzer's and runtime discoverer's findings, and during Phase 8 as the contract the independent `migration-validator` agent checks against.

The checklist is the only artifact that survives the migration as a falsifiable claim about what was migrated. The validator's job is to read this file, walk every entry, and produce a verdict from the filesystem and (optionally) the running site — not from the main agent's self-report.

## Contents

- [File](#file)
- [Top-level shape](#top-level-shape)
- [Per-check shape](#per-check-shape)
- [Category-specific `expectation` shapes](#category-specific-expectation-shapes)
- [Derivation rules (Phase 5 builds the checklist)](#derivation-rules-phase-5-builds-the-checklist)
- [Status values (set by the validator)](#status-values-set-by-the-validator)
- [Final verdict (computed by the validator)](#final-verdict-computed-by-the-validator)

## File

`<TARGET_PROJECT_ROOT>/migration-artifacts/migration-verification-checklist.json`

## Top-level shape

```json
{
  "version": "1.0",
  "generatedAt": "<ISO timestamp>",
  "sources": {
    "static": "migration-artifacts/static-analysis.json",
    "staticForms": "migration-artifacts/forms-inventory.json",
    "runtime": "migration-artifacts/runtime-discovery.json",
    "runtimeForms": "migration-artifacts/runtime-forms.json",
    "canonicalModel": "migration-artifacts/canonical-site-model.json",
    "skillManifest": "migration-artifacts/required-skill-invocations.json"
  },
  "checks": [ /* check objects, see below */ ],
  "summary": {
    "total": <n>,
    "byCategory": { "route": <n>, "form": <n>, "api": <n>, ... },
    "bySeverity": { "blocker": <n>, "major": <n>, "minor": <n> }
  }
}
```

## Per-check shape

Every entry in `checks[]` is one falsifiable claim the validator can verify:

```json
{
  "id": "<kebab-case stable id>",
  "category": "route | form | api | auth | role | permission | server-logic | asset | metadata | drift",
  "source": "static | runtime | both",
  "description": "<one-sentence human-readable claim>",
  "evidence": [
    "static-analysis.json:pages[3]",
    "runtime-discovery.json:routes[7]"
  ],
  "expectation": { /* category-specific, see below */ },
  "severity": "blocker | major | minor",
  "status": "pending"
}
```

Status is always `pending` when the checklist is created. The validator sets it to `pass`, `pass-static-only`, `pass-with-known-gap`, `fail`, `deferred`, or `not-applicable` during Phase 8.1.

Severity drives the verdict:

- `blocker` — a failure forces the migration to `Blocked` (or `Partial` when a `user-deferred` skill explains it).
- `major` — a failure forces at least `Partial`.
- `minor` — a failure is recorded but does not affect the verdict by itself.

## Category-specific `expectation` shapes

### `route`

```json
{
  "type": "route-exists",
  "path": "/contact",
  "componentFile": "src/components/ContactUsPage.*",
  "renderTokens": ["Contact us", "We'd love to hear from you"],
  "guard": null
}
```

- `path` — the SPA route path. Use the framework's routing convention.
- `componentFile` — glob-friendly path. Validator confirms a real file (not a placeholder) exists.
- `renderTokens` — substrings the validator greps for in the component (and its imported templates) to confirm meaningful content, not just placeholder text. Pull these from the EDM source content the route migrated.
- `guard` — `"RequireAuth"`, `"RequireRole:<role>"`, or `null` for public routes. For role-gated routes the validator confirms the route registration wraps the component with the matching guard.

### `form`

```json
{
  "type": "form-implementation",
  "componentFile": "src/components/ContactUsForm.*",
  "targetTable": "contact",
  "entitySetName": "contacts",
  "webApiEndpoint": "POST /_api/contacts",
  "operations": ["POST"],
  "fields": ["firstname", "lastname", "emailaddress1", "subject", "description"],
  "successBehavior": "navigate:/thank-you",
  "requiredService": "src/services/contactService.*",
  "attachments": false,
  "antiForgery": "required",
  "captcha": "none"
}
```

- `targetTable` and `entitySetName` come from the static analyzer's form classification (`forms-inventory.json:forms[].targetTable` and `.entitySetName`).
- `webApiEndpoint` comes from the form's classification (`client-form-create` → `POST /_api/<entitySet>`, `client-form-update` → `PATCH /_api/<entitySet>(<id>)`, `client-form-readonly` → `GET /_api/<entitySet>(<id>)`).
- `fields` is the union of static-analyzer field names and runtime-form field names (runtime wins on field name when they disagree; record the static name in a `caveats[]` entry).
- `successBehavior` — one of `"navigate:<path>"`, `"message:<text>"`, `"reset-form"`, `"none"`.
- `requiredService` — the shared Web API client service `/integrate-webapi` will scaffold for the table.
- `attachments` — `true` only when the source form had `adx_attachfile` or runtime evidence showed a file upload network request.
- `antiForgery` — `"required"` whenever the runtime form posted with `__RequestVerificationToken` or the static form posted to a Power Pages endpoint. `"none"` only when the form was a pure GET search filter.
- `captcha` — `"none"`, `"manual-gap"`, or `"replaced-with-<provider>"`.

Forms classified as `client-wizard` use the same shape but list each step's `entitySetName` and `operations` under a `steps[]` array. Forms classified as `manual-gap` are still listed in the checklist (severity `major`) — the validator confirms the gap is logged in `migration-gap-log.md`, not that the form is implemented.

### `api`

```json
{
  "type": "webapi-integration",
  "table": "contact",
  "entitySetName": "contacts",
  "operations": ["GET", "POST", "PATCH"],
  "permissionsScope": "Contact",
  "serviceFile": "src/services/contactService.*",
  "permissionFiles": [".powerpages-site/table-permissions/contact-*.tablepermission.yml"],
  "siteSettingFiles": [
    ".powerpages-site/site-settings/Webapi-contact-enabled.sitesetting.yml",
    ".powerpages-site/site-settings/Webapi-contact-fields.sitesetting.yml"
  ],
  "wildcardFieldsAllowed": false
}
```

- `permissionsScope` — `Global`, `Contact`, `Account`, `Parent`, or `Self`. Mirrors the canonical model.
- `wildcardFieldsAllowed` — `true` only when the migration plan explicitly approved a wildcard `Webapi/<table>/fields` setting. Otherwise the validator fails the check if the setting is `*`.

### `auth`

```json
{
  "type": "auth-wiring",
  "provider": "EntraID",
  "authServiceFile": "src/services/authService.*",
  "shellWiring": "src/components/AppShell.*",
  "authButton": "src/components/AuthButton.*",
  "guards": ["RequireAuth", "RequireRole"],
  "settings": [
    ".powerpages-site/site-settings/Authentication-*.sitesetting.yml"
  ],
  "copilotEmbedEnvVar": "VITE_COPILOT_EMBED_URL"
}
```

- `copilotEmbedEnvVar` is set only when the source had a Copilot/bot embed. The validator confirms the env var is present in the project's `.env`, `.env.local`, or framework equivalent.

### `role`

```json
{
  "type": "web-role",
  "name": "Authenticated Users",
  "roleFile": ".powerpages-site/web-roles/Authenticated-Users.webrole.yml",
  "usedByGuard": "RequireRole:Authenticated Users",
  "usedByPermission": ".powerpages-site/table-permissions/contact-self-update.tablepermission.yml"
}
```

The validator confirms the role file exists AND is referenced by at least one guard or one permission (whichever the plan declared).

### `permission`

```json
{
  "type": "table-permission",
  "permissionName": "contact-self-update",
  "table": "contact",
  "scope": "Contact",
  "privileges": ["read", "update"],
  "permissionFile": ".powerpages-site/table-permissions/contact-self-update.tablepermission.yml",
  "auditLogged": "migration-artifacts/permissions-audit.md"
}
```

### `server-logic`

```json
{
  "type": "server-logic",
  "operation": "submitInquiry",
  "operationDir": ".powerpages-site/web-files/server-logic/submitInquiry/",
  "clientService": "src/services/submitInquiryService.*"
}
```

### `asset`

```json
{
  "type": "asset-reuse",
  "sourcePath": "web-files/hero-banner.png/hero-banner.png",
  "targetPath": "public/hero-banner.png",
  "referencedBy": ["src/components/HomePage.*", "src/styles/landing.css"],
  "originalUrl": "/hero-banner.png",
  "mediaType": "image"
}
```

The validator confirms the binary exists at `targetPath` AND at least one entry in `referencedBy[]` mentions the asset (filename or imported module reference) AND no stock-image URL remains in any slot that should have received this asset.

### `metadata`

```json
{
  "type": "metadata-file",
  "expectedFiles": [
    ".powerpages-site/site-settings/Authentication-*.sitesetting.yml",
    ".powerpages-site/web-roles/Authenticated-Users.webrole.yml"
  ],
  "kind": "site-setting | web-role | sitemarker | webpage-rule | language | publishing-state | website-access | table-permission"
}
```

### `drift`

```json
{
  "type": "drift",
  "kind": "runtime-route-missing | runtime-endpoint-missing | stock-image-remaining",
  "detail": "Runtime route '/feedback' is not in the SPA router and is not flagged as out-of-scope in the canonical model."
}
```

## Derivation rules (Phase 5 builds the checklist)

When Phase 5 generates the checklist, walk every artifact and emit checks in this order. The validator treats id collisions as authoring errors; ensure every check has a unique `id`.

### Routes

For every entry in `canonical-site-model.json:routes[]`:

- One `route` check per route, severity `blocker` for mandatory route families (see Phase 7.5 of the main skill) and `major` otherwise.
- `renderTokens` pulled from the EDM `.copy.html` / `.summary.html` headline + first meaningful paragraph.
- `guard` set when the route's `securityModel` requires authentication or a role.

For every route in `runtime-discovery.json:routes[]` not represented in the canonical model and not classified as out-of-scope, emit a `drift` check (severity `major`) with kind `runtime-route-missing`.

### Forms

For every entry in `forms-inventory.json:forms[]`:

- One `form` check per form, severity `blocker` when the form is on a mandatory route family (`/contact`, `/profile`, `/registration`, etc.) and `major` otherwise.
- If a matching entry in `runtime-forms.json:forms[]` exists, merge runtime's `spaContract` fields into the expectation (runtime wins on endpoint/method, static wins on field semantics) and set `source: "both"`.
- If the form is classified `manual-gap`, the expectation type stays `form-implementation` but adds `manualGap: true` and the validator checks for a gap-log entry instead of a component.

### Web API integrations

For every Dataverse table in the canonical model with CRUD operations:

- One `api` check, severity `blocker` when any route's `componentMapping[]` has `targetKind: "webApi"` pointing at the table, `major` otherwise.

### Auth and roles

- One `auth` check when the canonical model's `SECURITY_DATA.authProvider` is anything other than `anonymous-only`. Severity `blocker`.
- One `role` check per `SECURITY_DATA.webRoles[]` entry with status `Create` or `Update`. Severity `major`.
- One `permission` check per `tablepermission` in the migration plan. Severity `major` (or `blocker` when the table backs a `blocker`-severity route or form).

### Server logic

- One `server-logic` check per `componentMapping[].targetKind === "serverLogic"` entry. Severity `blocker` when the route is on a mandatory route family, `major` otherwise.

### Assets

- One `asset` check per `assets[]` entry. Severity `major`.
- For every stock-image URL captured in the canonical model that has a matching `assets[]` entry, emit a `drift` check (severity `major`) with kind `stock-image-remaining`. The validator confirms the stock URL is **gone**, not present.

### Metadata files

- One `metadata` check for the `.powerpages-site/` baseline (`website.yml` + at least one expected subfolder). Severity `blocker`.
- One per group of site settings/web roles/sitemarkers/etc. listed in the migration plan. Severity `major`.

### Drift

For every endpoint URL in `runtime-discovery.json:apiCalls[]` that does not appear in any SPA service from the canonical model, emit a `drift` check (severity `major`) with kind `runtime-endpoint-missing`.

## Status values (set by the validator)

- `pending` — initial state when Phase 5 created the entry. Should never appear in a final report.
- `pass` — every part of the expectation verified successfully on disk (and at runtime when `DEV_SERVER_URL` was available).
- `pass-static-only` — disk checks all passed; runtime portion was skipped because the dev server was not available. Does not downgrade the verdict by itself.
- `pass-with-known-gap` — the expectation is met within the limits the plan accepted (e.g., CAPTCHA replaced by a documented gap). Does not downgrade the verdict.
- `fail` — at least one part of the expectation is missing or wrong. Forces `Blocked` unless the failure is explained by `deferred`.
- `deferred` — the work this check covers depends on a `user-deferred` skill in `required-skill-invocations.json`. Forces at least `Partial`.
- `not-applicable` — the check no longer applies (e.g., the route was removed from scope after Phase 5 with an approved scope-narrowing event). Should be rare and include a justification.

## Final verdict (computed by the validator)

- **`Blocked`** — any check is `fail` and no `deferred` reason applies.
- **`Partial`** — every `fail` is explained by a `deferred` reason, OR at least one check is `deferred`.
- **`Complete`** — every check is `pass`, `pass-static-only`, `pass-with-known-gap`, or `not-applicable`. No `fail`, no `deferred`.

The validator writes this verdict to `migration-completion-status.json`. Phase 9 of the main skill reads that file and never overrides the verdict.
