# EDM to SPA Migration Patterns

Use this reference during `/migrate-edm-to-spa` Phases 3, 6, 7, and 8 to map EDM Power Pages artifacts to static SPA code-site equivalents.

## Contents

- [Mapping Overview](#mapping-overview)
- [Web Pages and Routes](#web-pages-and-routes)
- [Liquid Templates](#liquid-templates)
- [Entity Lists](#entity-lists)
- [Form Conversion Standards](#form-conversion-standards)
- [Basic Forms](#basic-forms)
- [Advanced Forms](#advanced-forms)
- [FAQ and Admin Content Patterns](#faq-and-admin-content-patterns)
- [Custom JavaScript](#custom-javascript)
- [Auth, Roles, and Permissions](#auth-roles-and-permissions)
- [Profile / User Account](#profile--user-account)
- [Site Settings](#site-settings)
- [Unsupported or Manual-Gap Candidates](#unsupported-or-manual-gap-candidates)
- [Assets and Images](#assets-and-images)
- [Implementation Standards](#implementation-standards)
- [Mandatory Route Families](#mandatory-route-families) — used by implement Phase 7.5
- [Reuse EDM-Source Assets](#reuse-edm-source-assets) — used by implement Phase 7.6
- [Profile Route Implementation](#profile-route-implementation) — used by implement Phase 7.6

## Mapping Overview

| EDM artifact | SPA equivalent | Notes |
|--------------|----------------|-------|
| Web page | Route and page component | Preserve route intent, content, title, and access behavior |
| Page template | Layout component or route-level wrapper | Header/footer/sidebar templates usually become shared components |
| Web template | Component, layout, content module, or server logic | Liquid must be classified by **what it does**, not by the fact that it runs server-side |
| Content snippet | Content constant, localization resource, or component prop | Keep frequently reused snippets centralized |
| Web file | Public asset or imported source asset | Reuse the EDM binary — copy it into the SPA's `public/` or `src/assets/`, preserve the original filename, and rewrite references. Do **not** substitute with stock photography. See **Assets and Images** below. |
| Web link set | Navigation model | Map to header/footer/sidebar nav components |
| Entity list | Data grid/list component plus Web API service | Requires permissions and site settings for runtime data |
| Basic form | Framework form component plus Web API create/update/read logic | Preserve validation, redirects, attachments, and success behavior where supported |
| Advanced form | Multistep SPA flow or manual gap | Preserve authentication/session/progress behavior only when understood |
| Table permission | Server-side Dataverse access rule | Do not replace with client-side checks |
| Web role | Role model for UX gating | Pair with `/setup-auth`; real security remains table permissions |
| Site setting | Granular `site-settings/*.sitesetting.yml`, runtime configuration, or migration note | EDM `sitesetting.yml` must be split into per-setting SPA metadata files when migrated |
| Custom JavaScript | Framework-specific behavior | Rewrite jQuery and portal globals into component state/effects/validation |
| Liquid FetchXML / server-evaluated logic | Server logic via `/add-server-logic`, Web API, or manual gap | See **Liquid Templates** below for the classification rule |

## Web Pages and Routes

When converting pages:

1. Use `adx_partialurl` and page hierarchy for the route path.
2. Use page templates and web templates to infer layout.
3. Use `.copy.html` and `.summary.html` for content.
4. Use page custom CSS/JS sidecars for behavior and style clues.
5. Preserve special routes such as home, profile, search, access denied, and page not found when present.

Do not migrate hidden or unpublished pages unless they are reachable at runtime or the user explicitly includes them.

## Liquid Templates

Classify Liquid by **what it does**, not by the fact that it runs server-side. Use the following rule, in order:

1. **Composition / static content** &rarr; component or content. Examples: `{% include 'Header' %}`, `{{ snippets[...] }}` for non-secret static text, simple conditionals over static content.
2. **Read-only data access that the SPA can reproduce safely with Dataverse Web API and table permissions** &rarr; **Web API**. Example: a `{% fetchxml %}` block that lists records the user is already authorized to read.
3. **Server-only context, privileged access, or server-evaluated business rules** &rarr; **Server Logic** (handed off to `/add-server-logic`). Examples:
   - Liquid that reads `user.roles`, `user.contact`, or `request` to decide what data to include.
   - FetchXML that joins/aggregates across tables or returns fields the SPA cannot reach via Web API + table permissions alone.
   - Logic that depends on `settings`, `sitemarkers`, or other server-only context to drive responses.
   - Anything that today runs as part of the portal's trusted server pipeline (authorization filtering, computed fields, signature/secret handling).
4. **Complex or ambiguous Liquid** &rarr; **Manual Gap**, with the original behavior captured in the gap log so the user can decide.

| Liquid pattern | Likely SPA mapping (apply rule above) |
|----------------|---------------------------------------|
| `{% include 'Header' %}` or reusable section includes | Component composition |
| `{{ snippets[...] }}` (static text) | Content constants or localization lookup |
| `{{ settings[...] }}` driving content/behavior | Server Logic if the value influences security/business logic; otherwise runtime config |
| `sitemarkers[...]` | Route alias; use Server Logic when sitemarkers gate access |
| `user`/`user.roles`/`request` checks driving data or content | Server Logic via `/add-server-logic` |
| Simple conditionals/loops over static content | Component conditional rendering or array map |
| `{% fetchxml %}` for plain reads the SPA can do safely | Web API service (with table permissions) |
| `{% fetchxml %}` with joins/aggregates/privileged fields | Server Logic via `/add-server-logic` |
| Complex filters or undocumented portal runtime objects | Manual Gap until reviewed |

When Liquid controls security or data access, do not implement only client-side behavior. The mapping must include the server-side replacement (Server Logic, table permissions, or both) and that replacement must show up in the migration plan.

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

## Form Conversion Standards

EDM `basic-forms` and `advanced-forms` are server-rendered WebForms-style flows that submit through portal-managed handlers. In a static SPA code site, they must be re-authored as **client-side form components** that call the Dataverse Web API directly (with the project's anti-forgery token plumbing) — they are never re-implemented as server-rendered pages. The static analyzer assigns every form to exactly one of the six patterns below; the runtime discoverer confirms or refines that classification from observed network behavior; Phase 5 records the chosen pattern in the canonical model; Phase 7.6 implements it; the verification checklist's `form` checks (see `migration-verification-checklist.md`) verify the implementation.

| Pattern | When to use it | SPA shape | Web API call |
|---------|----------------|-----------|--------------|
| `client-form-create` | EDM basic form in `Insert` mode (e.g., Contact Us, Inquiry, Feedback, Support Request, Newsletter Signup). The user fills a form and a new Dataverse record is created. | Single-page SPA form component with framework-idiomatic validation, success redirect or message, and (when the source had it) attachment upload. Never a server-rendered page. | `POST /_api/<entitySet>` with the field set the form exposed. Anti-forgery token (`__RequestVerificationToken` from `/_layout/tokenhtml`) handled by the shared API client. |
| `client-form-update` | EDM basic form in `Edit` mode targeted at the signed-in user's own record (typical `/profile` shape over `contact`, or self-scoped account/preferences edits). | SPA form component that loads the current record on mount, binds editable fields, and submits a patch. Uses identity from `/setup-auth`. | `GET /_api/<entitySet>(<id>)` on mount, `PATCH /_api/<entitySet>(<id>)` on submit. `Contact`-scoped table permission and narrowed `Webapi/<table>/fields` site setting. |
| `client-form-readonly` | EDM basic form in `ReadOnly` mode (often used for "view my submission", "view ticket status", etc.). | SPA detail component that fetches and displays the record. No edit controls. | `GET /_api/<entitySet>(<id>)`. |
| `client-form-with-attachments` | Any of the above with `adx_attachfile`, file inputs, or runtime evidence of multipart uploads (e.g., support tickets with file evidence, application forms with PDF uploads). | The base pattern (create/update/readonly) **plus** a file input wired to the Web API annotation endpoint. | Base pattern + `POST /_api/annotations` (or table-specific attachment endpoint) using `Annotation/documentbody` for the file payload. |
| `client-wizard` | EDM advanced form with multiple steps over one or more tables (multi-step application, multi-page registration, multi-step service request). Each step persists progress. | Route-level wizard component with persisted step state (URL fragment or local storage). Each step is a sub-form that calls the Web API on advance. Step-aware navigation, back/forward, and progress indicator. | One Web API call per step boundary. Use `POST` for the first step (creating the root record) and `PATCH` for subsequent steps, OR a single `POST` at the end with all collected state, depending on the source's session/progress semantics. |
| `manual-gap` | The form depends on portal-managed session/progress, server-only CAPTCHA, complex server Liquid validators, or runtime behavior the SPA cannot reproduce safely. **Reserve this for genuine blockers** — every contact/inquiry/feedback/profile/registration/support/newsletter form has one of the patterns above and must not default to `manual-gap`. | No SPA form; the route exists but explains the gap and links to `migration-gap-log.md`. | None. |

### Mandatory mappings (never default to `manual-gap`)

These form intents always map cleanly to one of the client-side patterns. The static analyzer must classify them accordingly, and the validator fails the migration when one of these is left as `manual-gap` without an explicit Phase 6 user override:

| EDM form intent | Default pattern | Target table | Notes |
|-----------------|-----------------|--------------|-------|
| Contact-us / inquiry / feedback / "get in touch" | `client-form-create` | `contact` (or `feedback` / `lead` when the source explicitly targets one) | Public, anonymous-friendly. Success behavior: navigate to a thank-you route or render an inline success message. |
| Newsletter / mailing-list signup | `client-form-create` | `contact` (with marketing-opt-in fields) or the source's chosen subscription table | Anonymous-friendly. Idempotency depends on the source — surface in `caveats[]`. |
| Profile edit (signed-in user) | `client-form-update` | `contact`, self-scoped | See `Profile / User Account` section. Always pair with `/setup-auth` and `/integrate-webapi`. |
| Self-registration (account creation) | `client-form-create` paired with `/setup-auth`'s registration flow | `contact` + identity-provider invitation | The form component handles contact creation; the identity provider handles credentials. Portal-only invitation/redemption flows go into `manualGap`. |
| Support / case submission | `client-form-create` (or `client-form-with-attachments` if the source allowed file evidence) | `incident` (or the source's case table) | Anti-forgery + Contact-scoped read of the submitted ticket if the source linked back to a "view my ticket" page. |
| "View my ticket / submission" | `client-form-readonly` | Same table as the submission | Render fields from the source's view metadata, not all columns. |

### Anti-forgery, validation, and CAPTCHA

Every Web API write from the SPA needs the Power Pages anti-forgery token. The shared Web API client (scaffolded by `/integrate-webapi`) is responsible for fetching `/_layout/tokenhtml` once and attaching the token to every mutating request — individual form components must not reimplement that handshake.

Client-side validation must reproduce the EDM source's required-field rules, format constraints (email/phone/regex), and field-level error messages. `Page_Validators` custom JavaScript becomes framework-idiomatic validation rules; jQuery-driven validation is rewritten, not copied verbatim.

CAPTCHA is a known gap. The static analyzer records `captcha: "manual-gap"` on the form check; the validator does not block the migration on it, but the route still records the gap so the user can opt into a third-party CAPTCHA replacement later.

### Output to the canonical model

Each form check in the canonical model carries `targetKind: "webApi"` (with the form's component listed alongside as `targetKind: "component"`) and links to a `forms-inventory.json` entry that records the chosen pattern, target table, entity set, operations, fields, success behavior, attachments, anti-forgery requirement, and the evidence (static path + runtime form id) that supports the classification.

The verification checklist in `migration-verification-checklist.md` translates each form entry into a `form` check the validator can verify mechanically against the SPA's component, service, and metadata files.

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

If attachments, CAPTCHA, multistep flows, or portal-managed validation are central to the form, mark them as high-risk and surface them in the HTML migration plan before implementation.

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
| Portal-managed session/progress behavior | Manual gap or custom implementation after plan approval |

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

## Profile / User Account

The classic EDM portal profile page (typically at `/profile` or `/profile/`) is a WebForms-driven editor over the `contact` entity that lets the signed-in user view and update their own profile fields (first/last name, email, phone, organization, marketing opt-ins, language preference, etc.). Do **not** classify this route as a blanket `manualGap`. The default mapping is:

| Profile capability | SPA mapping | `targetKind` |
|--------------------|-------------|--------------|
| Identity display (display name, email, signed-in state) | Read from `/setup-auth` identity claims | `component` |
| Read current contact record (name, phone, org, preferences) | Web API `GET contacts(<contactid>)` via `/integrate-webapi`, scoped to the signed-in contact | `webApi` |
| Update contact fields the user owns | Web API `PATCH contacts(<contactid>)` via `/integrate-webapi`, scoped to the signed-in contact | `webApi` |
| Profile route shell + form UI | New SPA `ProfilePage` / `ProfileForm` component | `component` |

Apply the following qualifications before assigning `webApi` to profile read/update:

1. **Self-scoped contact table permissions must be permitted.** The default plan must list a contact table permission scoped to the signed-in contact (`Contact` scope) for read and update, plus narrowed `Webapi/contact/enabled` and `Webapi/contact/fields` site settings covering only the columns the profile editor exposes. Phase 7.3 hands this off to `/integrate-webapi` and `/audit-permissions`.
2. **Only map the fields the EDM profile actually exposed.** Do not widen the Web API to columns the EDM portal did not already let the user edit. If `Webapi/contact/fields` is `*` in EDM, narrow it for the SPA.
3. **Keep portal-only behavior as a `manualGap`.** Federated identity linking flows, in-portal password reset, registration code redemption, invitation acceptance, and any portal-managed marketing list synchronization that requires server-only context belong in `GAPS_DATA` even when the rest of the profile route maps cleanly.
4. **Fallback to read-only when write is not permitted.** If the user or the existing permissions model does not allow self-update via Web API, default the profile route to a read-only component sourced from `/setup-auth` identity claims plus a Web API read of `contact`. Log the missing write capability as a manual gap rather than reclassifying the entire route as `manualGap`.

When the migration plan is generated, profile routes should usually appear with a `componentMapping` containing at least one `component` entry for the page shell and one `webApi` entry per contact read/update operation, optionally accompanied by manual gaps for federated/portal-only sub-features.

> **Phase 7 enforcement.** The migration skill's Phase 7.5 lists `/profile` as a mandatory route family and Phase 7.6 has a dedicated "Implement the profile route" step. Phase 5 emits a `blocker`-severity `route` check for `/profile` into `migration-verification-checklist.json`, and Phase 8.4's independent `migration-validator` agent fails the migration with status `Blocked` whenever the source had `/profile` but the SPA does not implement it (or implements it as a placeholder). The route may only stay stubbed when `/setup-auth` or `/integrate-webapi` was explicitly user-deferred in the Phase 7.3 manifest, in which case the migration's final status is `Partial` — not `Complete`.

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

These often require manual design or a separate skill. **Before classifying any item below as a `manualGap`, run the Phase 5.4 Gap Pre-Check in the analyze SKILL** — many gap-shaped items turn out to be configuration or component work the implement skill wires up automatically (env vars from `botconsumer.yml`, tenant IDs from `sitesetting.yml`, logos from `web-files/`).

Genuine `manualGap` candidates:

- Forums, blogs, polls, ideas, and community features.
- Knowledge management facets and article analytics that require a server-side index.
- Case deflection widgets that depend on the portal's recommendation engine.
- Portal comments and note attachment behavior.
- Complex Liquid FetchXML joins or aggregate queries that depend on server-only context (use `serverLogic` instead when the migration scope includes `/add-server-logic`).
- Internal portal APIs or undocumented runtime globals.
- CAPTCHA providers that cannot be re-implemented client-side (when the source uses a portal-managed CAPTCHA not exposed to the SPA).
- Advanced-form session/progress behavior held in portal state.
- Rich-text attachment upload/display through Web API unless verified and approved.

**Not gaps** — these look gap-shaped but are configuration / component / asset-reuse work:

- Copilot or bot embed — value extracted from `botconsumer.yml#adx_botschemaname` and wired through `.env`. The Copilot embed is a mandatory route family; never `manualGap`.
- Multilingual content — site languages translate to `.powerpages-site/site-languages/*.yml` and SPA i18n resources. Treat per-language work as separate components, not as one giant manual gap.
- Auth provider configuration — tenant + client IDs are in `sitesetting.yml` under `Authentication/OpenIdConnect/*`; `/setup-auth` reads them and wires the SPA.
- Invitations / password reset flows — the route shell is mandatory; portal-only sub-flows (invitation-code redemption, in-portal password reset) are the only `manualGap` sub-feature.

If you find yourself writing a `manualGap` entry, re-read [Mandatory Route Families](#mandatory-route-families) and the analyze SKILL's Phase 5.4 pre-check first.

Manual gaps must be visible in the migration plan and final handoff.

## Assets and Images

The migrated SPA must reuse the **source EDM imagery** wherever the source content referenced an image. EDM web-files (logos, icons, hero photos, illustrations, screenshots, downloadable documents) are part of the site's visual identity and must not be silently dropped or replaced with newly-sourced stock photography.

### Discovery (Phase 3.6)

Walk `web-files/` and capture every binary alongside its `*.webfile.yml` metadata. For each image asset, record:

- The PAC-relative source path (the binary itself, not just the YAML).
- The original EDM URL or `adx_partialurl`.
- Any alt text present on referencing markup.
- The set of pages, templates, snippets, and CSS files that reference it (search `<img src>`, `srcset`, `url(...)`, `background-image`, and Liquid asset helpers).

### Modeling (Phase 5)

Populate the canonical model's `assets[]` array. Each referenced asset becomes one entry with `sourcePath`, `originalUrl`, `mediaType`, `targetPath`, `usedBy`, and `targetKind: "staticAsset"`. Routes whose source content references an asset list the matching `assets[]` entries inside their `componentMapping[]` with `targetKind: "staticAsset"`.

### Implementation (Phase 7.6)

When implementing components and content:

1. Copy the binary from `<EDM_SOURCE_ROOT>/<sourcePath>` into the SPA's static asset folder (`public/<original-filename>` for direct static serving, or `src/assets/<original-filename>` for bundler-imported assets). Preserve original filenames whenever routes, CSS, or external links depend on them.
2. Rewrite `<img>`, `srcset`, `url(...)`, `background-image`, and Liquid asset references in migrated content to point at the new SPA path. Preserve `alt` text from the source where present; otherwise generate accessible alt text from surrounding copy.
3. Replace any third-party stock-image URLs introduced by `/create-site` (e.g., `https://images.unsplash.com/...`) with the EDM-source `targetPath` whenever the corresponding source content had an image. Stock photography is only acceptable in image slots the EDM source did not fill.
4. Wire any logo, favicon, or app-icon binary from `web-files/` into the SPA shell (`AppShell` / `Navbar` / `<head>` icons) instead of leaving the scaffold default.
5. Record each reused asset in `migration-artifacts/migration-traceability.json` mapping the SPA artifact back to the EDM `sourcePath`.

### Unreferenced assets

If `web-files/` contains binaries that no migrated route, template, or snippet references, log them in `migration-gap-log.md` with category `asset-unreferenced` so the user can decide whether to keep, drop, or re-attach them. Do not delete them silently.

### Downloadable documents and fonts

Treat non-image binaries (PDFs, Office docs, ZIPs, font files) the same way as images: preserve the original filename, copy into the SPA's public asset folder, and rewrite links from migrated content. Fonts may instead be wired through the framework's font pipeline if the source CSS implies that.

## Implementation Standards

- Keep generated components framework-idiomatic.
- Do not preserve EDM file names when they make SPA code unclear; preserve traceability instead.
- Use CSS variables and shared layout components instead of copying scattered page CSS blindly.
- Replace copied content with accessible semantic HTML.
- Avoid generating fake data for Dataverse-backed features unless clearly marked as local development mock data.
- Run the SPA build before browser verification.
- Record traceability for every generated route, component, data service, and manual gap.

---

## Mandatory Route Families

Used by `migrate-edm-to-spa-implement` Phase 7.5 (and the analyze skill's Phase 5 when building `ROUTES_DATA[]`). Whenever the source EDM site exposed any of the following route families — via web pages, sitemarkers, web page rules, web link sets, or runtime evidence captured in Phase 4 — the SPA **must** implement them as real routes in Phase 7.5 and back them with real components in Phase 7.6. None of these may be left as a `manualGap`, a placeholder shell, or a "next step".

| Route family | When the source has it | Mandatory SPA implementation |
|--------------|------------------------|------------------------------|
| Not-found / 404 | Any source web page or runtime evidence implies a not-found page (sitemarker `Page Not Found`, default 404 web page, runtime evidence of 404 routing). | Router catch-all route rendering a real `NotFoundPage` component derived from the EDM content where available. |
| Access-denied / 403 | Source has authenticated/role-gated pages, role-based web page rules, or runtime evidence of 403 redirects. | Real `/access-denied` route + `AccessDeniedPage` component used by the auth/role guards scaffolded by `/setup-auth` in Phase 7.3. |
| Search | Source has `Search` sitemarker, search snippet, search page, or runtime evidence of a search route or search-results page. | Real `/search` route with a `SearchPage` component. Choose implementation depth from source complexity: basic page/content/table search → SPA + Web API search via `/integrate-webapi`-scaffolded services; knowledge or faceted/index-backed search → real route shell + a targeted `manualGap` entry for the unsupported facet/index plumbing only. Never list `/search` as a casual "quick win" when the source exposed it. |
| Profile / user account | Source has `/profile` (or equivalent web page rule / sitemarker / authenticated profile editor). | Apply the **Profile / User Account** mapping in [Profile Route Implementation](#profile-route-implementation): real `ProfilePage` component for identity + Web API-backed read/update of `contact`. Federated linking, password reset, registration code redemption, and invitation acceptance stay as targeted `manualGap` entries — but the profile route itself is never a `manualGap`. |
| Sign-in / sign-out / auth callback | Source uses an identity provider (Entra ID, local auth, B2C, etc.) or has registration / login web pages. | Routes wired by `/setup-auth` in Phase 7.3 (sign-in, sign-out, return URL, auth callback) plus an `AuthButton` integrated into the AppShell navigation. |
| Registration / invitation / password reset | Source has registration, invitation acceptance, or password-reset web pages. | Real route shell pointing at the auth flow scaffolded by `/setup-auth`; portal-only sub-flows (in-portal password reset, invitation code redemption) may remain in `migration-gap-log.md` but the route entry point is implemented. |
| Entity list / detail / create / edit | Source's entity lists, basic forms, or advanced forms imply CRUD routes for migrated tables. | Real routes (e.g., `/<entity>`, `/<entity>/:id`, `/<entity>/new`, `/<entity>/:id/edit`) backed by services from `/integrate-webapi` in Phase 7.3 and guarded by `/setup-auth`/`/create-webroles` artifacts where applicable. |
| Admin / role-gated routes | Source has admin web pages or role-restricted web page access rules. | Real routes wrapped in `RequireRole` (or framework equivalent) guards from `/setup-auth` in Phase 7.3. |
| Copilot / bot embed | Source has a Copilot/bot widget embedded on any page (PVA, Copilot Studio, custom bot). | Component embed wired into the SPA. The bot URL goes through a configurable env var (e.g., `VITE_COPILOT_EMBED_URL`) set during Phase 7.3's `/setup-auth` invocation or captured here via `AskUserQuestion`. Deferring the env var to "next steps" is not allowed when the source had the embed. |

If a mandatory route family is implied by the source but is not yet represented in the approved plan's `ROUTES_DATA[]`, treat that as unexpected drift: update the plan with the missing entry (and its `componentMapping[]`) in `migration-artifacts/`, then implement it here. Never silently drop a mandatory route to make Phase 8 verification pass.

---

## Reuse EDM-Source Assets

Used by `migrate-edm-to-spa-implement` Phase 7.6. Walk the canonical model's `assets[]` collection from analyze Phase 5 and physically wire each entry into the SPA so the migrated site renders the **same imagery the EDM source already used**.

1. **Copy the binary into the SPA.** For each asset, copy the file at `<EDM_SOURCE_ROOT>/<sourcePath>` into the SPA's static asset folder using the planned `targetPath`. For Vite/React/Vue/Astro scaffolds this is typically `<TARGET_PROJECT_ROOT>/public/<original-filename>`; for assets that must be hashed/imported by the bundler (e.g., referenced from component source), use `<TARGET_PROJECT_ROOT>/src/assets/<original-filename>` and import them from the component module. Preserve the original filename whenever an EDM route, CSS rule, or external link depends on it.
2. **Rewrite references in migrated content.** When porting page `.copy.html`, `.summary.html`, web-template `.source.html`, content snippets, and custom CSS into SPA components or styles, rewrite each `<img src>`, `srcset`, `url(...)`, `background-image`, and Liquid asset helper that pointed at an EDM web-file to point at the new SPA `targetPath` (e.g., `/hero-banner.png` for a `public/` asset, or an imported module reference for `src/assets/`). Preserve `alt` text from the source where present; otherwise generate accessible alt text from the surrounding copy.
3. **Replace stock placeholders left by `/create-site`.** Scan the scaffolded SPA for stock-image references (Unsplash URLs like `https://images.unsplash.com/...` and similar third-party stock domains) introduced by `/create-site`'s Phase 5.3. For every component slot whose source EDM content has a matching `assets[]` entry, replace the stock URL with the EDM-source asset's `targetPath`. Only keep stock photography in slots where the EDM source had **no** corresponding image and the user has not flagged the gap for review.
4. **Reuse logo and favicon assets.** If the EDM source includes a logo, favicon, or app icon (commonly under `web-files/` with names containing `logo`, `favicon`, `apple-touch-icon`, or referenced from the header web template), wire those into the SPA shell (`AppShell` / `Navbar` / `<head>` icons) instead of leaving the scaffold's default mark.
5. **Record reuse in traceability.** For each migrated asset, add a row to `migration-artifacts/migration-traceability.json` mapping the SPA artifact (the file path under `public/` or `src/assets/`, plus any components that import it) back to the EDM `sourcePath` and the originating route/template/snippet, with `evidence: ["static:web-file"]` and the asset's confidence score.

Assets that exist in the EDM source but are not referenced by any migrated route, template, or snippet must not be deleted silently — log them in `migration-gap-log.md` (`category: "asset-unreferenced"`) so the user can choose to keep, drop, or re-attach them.

Do **not** substitute EDM source imagery with newly-sourced stock photography just because the SPA has a new design layer. Reuse the source binaries first; stock photography is only a fallback for image slots that the EDM source did not fill.

---

## Profile Route Implementation

Used by `migrate-edm-to-spa-implement` Phase 7.6 whenever the source EDM site had `/profile` (or an equivalent user-account page). Phase 7.5 added the route shell; Phase 7.6 must fill in the component, not log the page as a manual gap.

1. **Identity comes from `/setup-auth`.** Read the signed-in user's identity from the auth service that `/setup-auth` produced in Phase 7.3 (`authService`, `useAuth()`, or framework equivalent). Do not re-implement auth in the profile component.
2. **Contact read/update comes from `/integrate-webapi`.** Use the Web API service scaffolded for the `contact` table in Phase 7.3 to read the signed-in contact's profile fields and update the columns the EDM profile editor exposed. Respect the `Contact`-scoped table permission and the narrowed `Webapi/contact/fields` site setting from the migration plan — never widen the field set beyond what the source allowed.
3. **Fallback to read-only when write is not permitted.** If `/audit-permissions` flagged the write path or the permissions model does not allow self-update, render the profile as a read-only view driven by identity claims plus the Web API read. Log the missing write capability in `migration-gap-log.md` rather than skipping the whole route.
4. **Portal-only sub-features stay as gaps.** Federated identity linking, in-portal password reset, registration code redemption, invitation acceptance, and similar portal-managed flows belong in `migration-gap-log.md` (`category: "portal-only-subflow"`). The rest of the profile route must still render.
5. **Wire the profile route into the AppShell navigation.** The signed-in user's nav (typically the `AuthButton` or a user menu produced by `/setup-auth`) must link to the profile route so the path is reachable without typing it manually.

If `/setup-auth` or `/integrate-webapi` was user-deferred in Phase 7.3, the profile component must render a typed stub that clearly says `"Profile requires <deferred-skill> to run"` with a link to the gap-log entry. It must not silently render placeholder text and pretend the route is finished.

Never bypass table permissions or imply that client-side role checks enforce data security.
