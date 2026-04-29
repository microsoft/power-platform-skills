# EDM to SPA Migration Patterns

Use this reference during `/migrate-edm-to-spa` Phases 3, 6, 7, and 8 to map EDM Power Pages artifacts to static SPA code-site equivalents.

## Mapping Overview

| EDM artifact | SPA equivalent | Notes |
|--------------|----------------|-------|
| Web page | Route and page component | Preserve route intent, content, title, and access behavior |
| Page template | Layout component or route-level wrapper | Header/footer/sidebar templates usually become shared components |
| Web template | Component, layout, content module, or custom logic | Liquid must be classified by intent before rewriting |
| Content snippet | Content constant, localization resource, or component prop | Keep frequently reused snippets centralized |
| Web file | Public asset or imported source asset | Preserve filenames only when routes or CSS require them |
| Web link set | Navigation model | Map to header/footer/sidebar nav components |
| Entity list | Data grid/list component plus Web API service | Requires permissions and site settings for runtime data |
| Basic form | Framework form component plus Web API create/update/read logic | Preserve validation, redirects, attachments, and success behavior where supported |
| Advanced form | Multistep SPA flow or manual gap | Preserve authentication/session/progress behavior only when understood |
| Table permission | Server-side Dataverse access rule | Do not replace with client-side checks |
| Web role | Role model for UX gating | Pair with `/setup-auth`; real security remains table permissions |
| Site setting | Granular `site-settings/*.sitesetting.yml`, runtime configuration, or migration note | EDM `sitesetting.yml` must be split into per-setting SPA metadata files when migrated |
| Custom JavaScript | Framework-specific behavior | Rewrite jQuery and portal globals into component state/effects/validation |
| Liquid FetchXML | Web API query, server logic, or manual gap | Complex joins/aggregates may need custom backend/server logic |

## Web Pages and Routes

When converting pages:

1. Use `adx_partialurl` and page hierarchy for the route path.
2. Use page templates and web templates to infer layout.
3. Use `.copy.html` and `.summary.html` for content.
4. Use page custom CSS/JS sidecars for behavior and style clues.
5. Preserve special routes such as home, profile, search, access denied, and page not found when present.

Do not migrate hidden or unpublished pages unless they are reachable at runtime or the user explicitly includes them.

## Liquid Templates

Classify Liquid by intent before rewriting:

| Liquid pattern | Likely SPA mapping |
|----------------|--------------------|
| `{% include 'Header' %}` or reusable section includes | Shared component composition |
| `{{ snippets[...] }}` | Content constants or localization lookup |
| `{{ settings[...] }}` | Runtime configuration value or migration note |
| `sitemarkers[...]` | Route alias or navigation helper |
| `user` or role checks | Auth/role-aware UI via `/setup-auth` |
| Simple conditionals/loops over static content | Component conditional rendering or array map |
| FetchXML/entity access | Web API service, backend/server logic, or manual gap |
| Complex filters or portal runtime objects | Low-confidence custom code until reviewed |

When Liquid controls security or data access, do not implement only client-side behavior. Mark the server-side implication in the auth/security plan.

## Entity Lists

Entity lists usually become list pages or data grids.

Inspect:

- Target table (`adx_entityname`).
- Page size, search, filters, and view settings.
- Create/details/edit/delete actions in embedded `adx_settings`.
- Redirect pages and query-string parameter names.
- Custom JavaScript sidecars.
- Whether entity permissions are enabled.

SPA implementation usually needs:

- Route and list component.
- Web API service and types.
- Loading, empty, and error states.
- Search/filter/pagination behavior.
- Table permissions and Web API site settings.

Use `/integrate-webapi` for actual API service generation when the user approves the data scope.

## Basic Forms

Basic forms usually become create/edit/detail form components.

Inspect:

- Target table and form mode.
- Form name and redirect behavior.
- Success messages.
- Attachment settings and allowed extensions.
- Required-field settings and metadata.
- Custom JavaScript validators, especially `Page_Validators`.
- Field dependencies expressed through DOM selectors.

SPA implementation usually needs:

- Framework form component.
- Field schema and validation rules.
- Web API create/update/read service.
- Redirect/success behavior.
- Attachment handling plan, if supported.

If attachments, CAPTCHA, multistep flows, or portal-managed validation are central to the form, mark them as high-risk and require user approval before implementation.

## Advanced Forms

Advanced forms represent portal-managed web form flows and are usually more complex than basic forms.

Inspect:

- Authentication requirement.
- Whether users may edit existing records.
- Whether multiple records per user are allowed.
- Whether a new session starts on load.
- Progress indicator settings.
- Localized messages.
- Page templates or routes that render the web form runtime.

SPA implementation options:

| Advanced form pattern | SPA mapping |
|-----------------------|-------------|
| Single-step, one-table flow | Framework form component plus Web API service |
| Multistep flow with simple state | Route-level wizard component with persisted state |
| Authenticated registration or event flow | Auth-aware wizard plus server-side permission plan |
| Portal-managed session/progress behavior | Manual gap or custom implementation after user approval |

Do not flatten an advanced form into a one-page SPA form unless the user approves the behavior change.

## FAQ and Admin Content Patterns

FAQ-style templates may include public article/topic pages plus admin routes for creating and editing articles or topics.

Map:

- Public article/topic pages to read-only routes and content/detail components.
- Admin article/topic pages to authenticated, role-gated CRUD routes.
- FAQ tables such as `faq_topic` and `faq_article` to Web API services when the site has matching Web API site settings.
- Rich text and file tables, such as `msdyn_richtextfile`, to manual or custom upload/display handling unless the behavior is simple and verified.

Treat admin route families separately from public routes in the migration plan so the user can approve or defer authoring/admin functionality independently.

## Custom JavaScript

Classify custom JavaScript:

| Source behavior | SPA rewrite |
|-----------------|-------------|
| DOM show/hide or enabling fields | Component state and conditional rendering |
| `Page_Validators` custom validation | Framework validation rule |
| jQuery event handlers | Framework event handlers |
| Redirects | Router navigation |
| `/_api/` calls | Shared Web API service |
| `shell.getTokenDeferred`, `validateLoginSession`, or `safeAjax` wrappers | Framework API client with anti-forgery token handling, usually via `/integrate-webapi` patterns |
| Portal globals or internal APIs | Manual gap unless equivalent is known |
| Inline HTML injection | Component rendering with sanitization review |

Do not copy jQuery code directly into a framework component unless it is explicitly approved as a temporary compatibility shim.

## Auth, Roles, and Permissions

Power Pages security is server-side. The SPA can improve UX by hiding or showing UI, but table permissions and web roles enforce access.

For a new SPA code site, deploy the scaffold once before finalizing security metadata. `/deploy-site` creates `.powerpages-site/`, which is required before the migration can reliably create or update table permissions, web roles, site settings, server logic metadata, and skill tracking YAML.

Treat the deployment-created `.powerpages-site/` as the target schema. EDM metadata is often aggregate and `adx_`-prefixed; SPA code-site metadata is more granular and commonly normalizes keys. Translate intent and records, not files.

Map:

- `webrole.yml` to role names and UX gates.
- `table-permissions/` to required server-side permissions.
- Auth and registration site settings to deployment/admin tasks.
- Profile and redirect settings to `/setup-auth` follow-up work.

Use:

- `/setup-auth` for login/logout and client-side role-aware UX.
- `/create-webroles` when new roles are needed.
- `/audit-permissions` when existing permissions are complex or risky.

## Site Settings

Classify site settings:

| Setting category | Treatment |
|------------------|-----------|
| Authentication and registration | Auth plan and setup/admin tasks |
| Profile redirects | SPA auth redirect handling and `/setup-auth` |
| Web API settings | `/integrate-webapi` permissions/settings plan |
| `Webapi/enableReadOperationPreview` | Web API read behavior note; verify against current platform behavior before relying on it |
| Wildcard Web API fields (`Webapi/<table>/fields` = `*`) | High-risk access setting; review permissions carefully |
| Search and facets | Search component, Web API/server logic, or manual gap |
| Knowledge management | Usually manual or custom data implementation |
| Product filtering | Data/filtering plan, often manual if relationship-heavy |
| Header/footer output cache | Usually not relevant to SPA runtime |

Do not assume every EDM site setting has a direct SPA equivalent.

Do not copy or create target site-setting YAML until `.powerpages-site/site-settings/` exists. If deployment has not hydrated the metadata folder, keep site-setting work in the migration plan or gap log and require `/deploy-site` before finalization.

When migrating site settings from EDM, split the aggregate `sitesetting.yml` records into individual `site-settings/<sanitized-name>.sitesetting.yml` files. Preserve IDs only when they belong to the target site; otherwise let existing creation scripts generate target-site IDs.

Example: an EDM FAQ site may contain `Webapi/faq_topic/enabled` and `Webapi/faq_topic/fields` as records inside one `sitesetting.yml` file. In the migrated SPA, those become separate files under `.powerpages-site/site-settings/`, such as `Webapi-faq_topic-enabled.sitesetting.yml` and `Webapi-faq_topic-fields.sitesetting.yml`, using the target code-site field shape.

## Unsupported or Manual-Gap Candidates

These often require manual design or a separate skill:

- Forums, blogs, polls, ideas, and community features.
- Knowledge management facets and article analytics.
- Case deflection widgets or bot integrations.
- Portal comments and note attachment behavior.
- Complex Liquid FetchXML joins or aggregate queries.
- Internal portal APIs or undocumented runtime globals.
- Multilingual content beyond simple copied strings.
- CAPTCHA, invitations, or registration policies that depend on portal-managed flows.
- Advanced form session/progress behavior.
- Rich-text attachment upload/display through Web API unless verified and approved.

Manual gaps must be visible in the migration plan and final handoff.

## Implementation Standards

- Keep generated components framework-idiomatic.
- Do not preserve EDM file names when they make SPA code unclear; preserve traceability instead.
- Use CSS variables and shared layout components instead of copying scattered page CSS blindly.
- Replace copied content with accessible semantic HTML.
- Avoid generating fake data for Dataverse-backed features unless clearly marked as local development mock data.
- Run the SPA build before browser verification.
- Record traceability for every generated route, component, data service, and manual gap.
