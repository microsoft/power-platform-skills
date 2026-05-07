# Headers Reference

Reference for the response headers and site settings the skill configures — what they do, how the runtime handles them, and what to verify before changing. Use this when inspecting the current setup and planning changes.

## Table of contents

- [Site-setting naming convention](#site-setting-naming-convention)
- [Recognized header catalogue](#recognized-header-catalogue)
- [Platform-managed headers (not settable)](#platform-managed-headers-not-settable)
- [Default behavior when a setting is absent](#default-behavior-when-a-setting-is-absent)
- [Content Security Policy](#content-security-policy)
- [Frame embedding](#frame-embedding)
- [Cross-Origin sharing](#cross-origin-sharing)
- [Cookies](#cookies)
- [Other security headers](#other-security-headers)
- [Power-Pages-runtime sources a CSP must allow](#power-pages-runtime-sources-a-csp-must-allow)
- [Deployment and caching](#deployment-and-caching)

---

## Site-setting naming convention

Every HTTP header site-setting uses the prefix `HTTP/` followed by the header name. Examples: `HTTP/X-Frame-Options`, `HTTP/Content-Security-Policy`, `HTTP/Access-Control-Allow-Origin`.

SameSite cookie settings use dynamic segments rather than a single header-named key:
- `HTTP/SameSite/Default` — applies to every cookie unless overridden.
- `HTTP/SameSite/<cookie-name>` — per-cookie override for the named cookie.

Each site-setting is a separate YAML file under `.powerpages-site/site-settings/`. The file name uses `-` instead of `/` (e.g. `http-x-frame-options.sitesetting.yml`) because `/` is not a filename-safe character.

---

## Recognized header catalogue

The runtime reads these `HTTP/*` site-settings and emits the corresponding response header. Names outside this catalogue are also emitted by the runtime as-is — review the inventory to spot typos or confirm that non-standard names are intentional.

**CSP**
- `HTTP/Content-Security-Policy`
- `HTTP/Content-Security-Policy-Report-Only`
- `HTTP/Content-Security-Policy/Inject-unsafe-eval` — boolean flag, not a header (see [CSP specifics](#csp-specifics))

**CORS**
- `HTTP/Access-Control-Allow-Origin`
- `HTTP/Access-Control-Allow-Credentials`
- `HTTP/Access-Control-Allow-Headers`
- `HTTP/Access-Control-Allow-Methods`
- `HTTP/Access-Control-Expose-Headers`
- `HTTP/Access-Control-Max-Age`

**Clickjacking / framing**
- `HTTP/X-Frame-Options`

**MIME sniffing / download**
- `HTTP/X-Content-Type-Options`
- `HTTP/X-Download-Options`
- `HTTP/X-Permitted-Cross-Domain-Policies`

**Cross-origin isolation**
- `HTTP/Cross-Origin-Resource-Policy`
- `HTTP/Cross-Origin-Opener-Policy`
- `HTTP/Cross-Origin-Embedder-Policy`

**Referrer / permissions / privacy**
- `HTTP/Referrer-Policy`
- `HTTP/Permissions-Policy`
- `HTTP/X-DNS-Prefetch-Control`
- `HTTP/X-XSS-Protection` — legacy; modern browsers ignore it but the runtime emits whatever value is set

**Cookies**
- `HTTP/SameSite/Default`
- `HTTP/SameSite/<cookie-name>`

---

## Platform-managed headers (not settable)

`Strict-Transport-Security` (HSTS) and `Cache-Control` are emitted by the runtime and cannot be overridden through site settings. Writing `HTTP/Strict-Transport-Security` has no effect — the runtime does not recognize it. HTTP to HTTPS redirect is enabled by default.

Because these protections are platform-managed, the skill does not propose changes for them.

---

## Default behavior when a setting is absent

When an `HTTP/<Header>` site-setting is absent, the runtime omits that header entirely. Always explicitly configure security headers as site-setting YAML files so they are reviewable in source control.

---

## Content Security Policy

CSP runtime behavior:

- **Pass-through.** The runtime emits `HTTP/Content-Security-Policy` verbatim. Power-Pages-runtime sources are NOT added automatically — the directive must include them explicitly (see [Power-Pages-runtime sources a CSP must allow](#power-pages-runtime-sources-a-csp-must-allow)). Missing a runtime source breaks the site.
- **Nonce mechanism.** When `script-src` contains `'nonce'`, the runtime replaces it per-request with `'nonce-<random>'` and injects the attribute on Liquid-rendered inline `<script>` tags. Inline event handlers are auto-hashed. Dynamically created scripts (`document.createElement`) do NOT receive the nonce.
- **`'unsafe-eval'` auto-injection.** `HTTP/Content-Security-Policy/Inject-unsafe-eval` (boolean, default `true`) auto-injects `'unsafe-eval'` into `script-src` when `'nonce'` is present. Runtime components require this. Setting to `false` may break runtime functionality — test in report-only mode first.
- **Report-Only.** `HTTP/Content-Security-Policy-Report-Only` is a separate setting. Both can run simultaneously.

---

## Frame embedding

- `HTTP/X-Frame-Options` — the runtime sets this to `SAMEORIGIN` by default.

---

## Cross-Origin sharing

CORS runtime behavior:

- **Omit `HTTP/Access-Control-Allow-Credentials` to disable.** The runtime emits whatever value is set — writing `false` produces a confusing header with no effect.
- **`*` is auto-specialized.** The runtime replaces `*` per-request with the specific requesting Origin. This means `*` with credentials effectively works (per-origin response), unlike standard HTTP.
- **CORS headers are applied to every response**, not only Web API responses.

---

## Cookies

Cookie runtime behavior:

- `HTTP/SameSite/Default` — applies to every cookie unless overridden.
- `HTTP/SameSite/<cookie-name>` — per-cookie override.
- The runtime sets `Secure` on every cookie over HTTPS, so `SameSite=None` works for HTTPS sites.
- For iframe-embedding scenarios, use `HTTP/SameSite/<session-cookie-name>: None` on the specific cookies the embed needs.

---

## Other security headers

Context to verify before changing:

| Setting | Context to verify before changing |
|---------|-----------------------------------|
| `HTTP/X-Content-Type-Options` | The runtime serves known content types, so `nosniff` does not cause issues. |
| `HTTP/Cross-Origin-Resource-Policy` | See CORP details below. |
| `HTTP/Cross-Origin-Opener-Policy` | See COOP details below. |
| `HTTP/Cross-Origin-Embedder-Policy` | `require-corp` breaks any cross-origin resource without explicit CORS headers. Only use when cross-origin isolation is specifically needed. |

### CORP (`HTTP/Cross-Origin-Resource-Policy`)

`same-origin` breaks:
- Azure AD B2C custom login pages hosted on the site — B2C loads resources from the site cross-origin
- Any cross-origin iframe embedding
- Power BI or other integrations that load resources from the site

`same-site` also breaks B2C flows — `b2clogin.com` and the site's domain are different registrable domains.

Standard redirect-based auth (Entra ID, SAML) is NOT affected — those use top-level navigations, not sub-resource loading.

Safest: leave absent or use `cross-origin`.

### COOP (`HTTP/Cross-Origin-Opener-Policy`)

`same-origin` breaks:
- Popup-based OAuth flows
- `window.opener` references between windows

Standard redirect-based auth (Entra ID, SAML) is NOT affected.

Verify whether the site uses popup-based auth before setting.

---

`HTTP/Referrer-Policy`, `HTTP/Permissions-Policy`, `HTTP/X-Download-Options`, `HTTP/X-Permitted-Cross-Domain-Policies`, and `HTTP/X-DNS-Prefetch-Control` are all pass-through — the runtime emits whatever value is set.

---

## Power-Pages-runtime sources a CSP must allow

The runtime loads resources from these hosts. Any CSP deployed on the site must include them in the corresponding directives, or the site fails to render.

**Required on `script-src`** — one cloud-specific runtime host plus the nonce keyword:

| Site's cloud | Required `content.powerapps.*` host |
|---|---|
| Public / Commercial | `content.powerapps.com` |
| US Government (GCC / GCC High) | `content.powerapps.us` |
| US Department of Defense | `content.appsplatform.us` |
| China | `content.powerapps.cn` |

Include only the one that matches the site's cloud — adding the others over-allows and defeats the point of the CSP. Resolve the cloud via `pac auth who` (the `Cloud` field) before composing the directive.

Also required on `script-src`:
- `'nonce'` — enables the per-request nonce mechanism for inline Liquid-rendered scripts

**Required on `style-src`**:
- `'unsafe-inline'` (runtime platform limitation for certain out-of-the-box styles)

**All other directives** (`style-src` hosts, `font-src`, `img-src`, `connect-src`, etc.): depends on the site's own content. Scan the project's source files, templates, scripts, etc. and add only the specific hosts the site actually uses. Do NOT use `https:` wildcards — they defeat the purpose of the CSP.

### Starter directive template

If the user is starting a CSP from scratch (with `<cloud-host>` replaced by the cloud-specific host from the table above):

```
default-src 'self';
script-src 'self' 'nonce' <cloud-host>;
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'self';
frame-ancestors 'self';
base-uri 'self';
form-action 'self';
object-src 'none';
```

Add specific external hosts to each directive based on the source file scan. Never use `https:` wildcards — list each host explicitly.

---

## Deployment and caching

Header changes land in Dataverse via `/deploy-site`. The site-setting update triggers a soft restart (no downtime); new values take effect once the restart propagates. Verify after a short wait in an incognito browser tab or via `curl -I <site-url>`.

**Maker-mode requests skip all `HTTP/*` header emission.** Requests from Power Pages Studio or other maker tools do not include headers configured via site settings. Viewing the site through maker tools will NOT show the configured headers. Always verify with a fresh browser tab that is not authenticated as a maker.
