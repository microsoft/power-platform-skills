# Required Skill Invocations Manifest

Reference for `migrate-traditional-site-to-spa-implement` Phase 7.3.a (derive the manifest) and 7.3.b (invoke in order). The manifest drives every required Power Pages skill the migration must run inline — none of these may be deferred to "Recommended Next Skills" without explicit user deferral.

## Contents

- Trigger conditions per skill (when the migration plan requires it)
- Input context (what to pass so the sub-skill does not re-prompt)
- Expected evidence (files that must exist on disk after success)
- Invocation order (and the reason for the order)
- Manifest entry shape

## Triggers, Inputs, Expected Evidence

| Skill | Triggered when (from the approved plan) | Input context to pass | Expected evidence after success |
|-------|------------------------------------------|------------------------|----------------------------------|
| `/integrate-webapi` | Any `DATAVERSE_DATA[]` table has `Read/Create/Update/Delete` operations, OR any route's `componentMapping[]` has `targetKind: "webApi"`, OR the canonical model lists `Webapi/<table>/enabled` or `Webapi/<table>/fields` site settings. | Table names, operations, field lists, scope (`Global`/`Contact`/`Account`/`Parent`). | `.powerpages-site/table-permissions/<table>-*.tablepermission.yml`, `.powerpages-site/site-settings/Webapi-<table>-*.sitesetting.yml`, and `src/services/<table>Service.*` in the SPA. |
| `/create-webroles` | Any `SECURITY_DATA.webRoles[]` entry has `status === "Create"` or `status === "Update"`. | Role names, descriptions, default flag, role-to-permission mapping. | `.powerpages-site/web-roles/<role>.webrole.yml` per created or updated role. |
| `/setup-auth` | `SECURITY_DATA.authProvider !== "anonymous-only"`, OR any route's `componentMapping[]` requires identity (e.g., `/profile`, `/access-denied`, admin routes), OR `SECURITY_DATA.constraints` describe login/redirect/return flows, OR the source has authenticated forms or Contact/Account-scoped Web API. Skip only when the source is genuinely anonymous-only with no user/role/profile/Contact-scoped behavior. | Identity provider type (Entra ID, local), web role list from `/create-webroles`, sign-in/sign-out callback URLs, optional `VITE_COPILOT_EMBED_URL` if the source had a bot/Copilot embed. | `.powerpages-site/site-settings/Authentication-*.sitesetting.yml`, auth service (`src/services/authService.*`), `AuthButton` component wired into SPA navigation, framework-specific guards/wrappers (`RequireAuth`, `RequireRole`, or equivalent). |
| `/audit-permissions` | Any `tablepermission` exists, OR Web API CRUD is introduced for any table, OR `Webapi/<table>/fields` is `*` (wildcard) anywhere, OR `SECURITY_DATA.constraints` flag risky permissions, OR there are admin/authenticated routes. | The migrated permissions and Web API site settings to audit, plus the role list. | `migration-artifacts/permissions-audit.md` with findings recorded and any over-permissive rules narrowed in `.powerpages-site/`. |
| `/add-server-logic` | Any route's `componentMapping[]` has `targetKind: "serverLogic"`. | Server-logic operation name, parameters, return shape, source Liquid/JS evidence. | `.powerpages-site/web-files/server-logic/<operation>/...` artifacts and `src/services/<operation>Service.*` clients in the SPA. |

## Invocation Order

Required skills must run in this exact order so each one has the inputs the next consumes:

1. **`/integrate-webapi`** — table permissions and Web API site settings must exist before auth or audit logic can reference them.
2. **`/create-webroles`** — required roles must exist before `/setup-auth` configures role-aware UI and before `/audit-permissions` checks role coverage.
3. **`/setup-auth`** — needs the migrated roles and Web API settings to scaffold protected routes, AuthButton wiring, and identity claims used by the profile route in Phase 7.6.
4. **`/audit-permissions`** — runs once permissions, roles, and auth are in place so its findings are actionable.
5. **`/add-server-logic`** — runs last so server-logic endpoints can rely on the auth/role context wired by the prior skills.

## Manifest Entry Shape

Each required entry records:

- `skill` — the slash-command name (e.g., `/integrate-webapi`).
- `trigger` — the specific plan evidence that satisfied the trigger (e.g., `"DATAVERSE_DATA[0] has Read/Create on contact"`).
- `inputContext` — the inputs to pass when invoking the sub-skill.
- `expectedEvidence[]` — the file paths that must exist on disk after the sub-skill completes.
- `order` — integer 1–5 reflecting the mandatory invocation order above.
- `notes` — free-text context to pass to the sub-skill.
- `status` — `required` initially. Flips to `invoked` before handing control, then `completed` once the sub-skill returns and every `expectedEvidence[]` file exists. On failure, `failed` with a remediation note. On user deferral, `user-deferred` with the recorded reason.

Skills whose triggers did **not** fire still appear in the manifest with `status: "not-required"` and a short reason, so the migration is explicit about every skill it considered.

## Exit Criteria for Phase 7.3

Phase 7.3 may only conclude when every entry has `status` in `{completed, not-required, user-deferred}` — never `required`, `invoked`, or `failed`. A `user-deferred` entry downgrades the migration to `Partial`.
