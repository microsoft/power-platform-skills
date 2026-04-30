# Header Rules

Reference for the response headers and Power Pages site settings the skill checks, why they matter, and what a safe default looks like. Use this as the source of truth when scoring the current setup in Phase 3 and when planning changes in Phase 4.

## Table of contents

- [Site-setting naming convention](#site-setting-naming-convention)
- [Recognized header catalogue](#recognized-header-catalogue)
- [Power Pages-managed headers (not settable)](#power-pages-managed-headers-not-settable)
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

In code sites, each site-setting is a separate YAML file under `.powerpages-site/site-settings/`. The file name uses `-` instead of `/` (e.g. `http-x-frame-options.sitesetting.yml`) because `/` is not a filename-safe character.

---

## Recognized header catalogue

The Power Pages runtime reads these `HTTP/*` site-settings and emits the corresponding response header. Names outside this catalogue are also emitted by the runtime as-is. The `inspect-headers.js` inventory script categorizes all `HTTP/*` settings it finds under the `advanced` category — review the inventory to spot typos or confirm that non-standard names are intentional.

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
- `HTTP/X-XSS-Protection` — legacy; modern browsers ignore it but the runtime will emit whatever you set

**Cookies**
- `HTTP/SameSite/Default`
- `HTTP/SameSite/<cookie-name>`

---

## Power Pages-managed headers (not settable)

`Strict-Transport-Security` (HSTS) and `Cache-Control` are emitted by the runtime and cannot be overridden through site settings. Do not attempt to write `HTTP/Strict-Transport-Security` — it is rejected. HTTP to HTTPS redirect is enabled by default for all Power Pages sites.

Because these protections are platform-managed, the skill does not propose changes for them. If either is flagged in a penetration test report, the request may have been blocked at the application service level — response codes >= 400 are a false positive.

---

## Default behavior when a setting is absent

When an `HTTP/<Header>` site-setting is absent, the runtime omits that header entirely. The one exception is CSP: sites created after November 10, 2025 receive a default policy that allows scripts from the site's own origin, Power Pages content delivery domains, and nonce-validated inline scripts. Older sites have no policy unless one is added manually. Explicitly configure `HTTP/Content-Security-Policy` so the policy is reviewable in source control.

---

## Content Security Policy

Power Pages controls Content Security Policy through the `HTTP/Content-Security-Policy` site setting.

| Setting | Recommended | Severity if missing |
|---------|-------------|---------------------|
| `HTTP/Content-Security-Policy` | A specific allow-list. Start in report-only mode, then enforce. | `critical` |
| `HTTP/Content-Security-Policy-Report-Only` | Same shape as the enforcement policy; use while testing. | `info` when set without an enforcement counterpart |

Plain-language explanation: this setting tells the browser exactly which scripts, stylesheets, images and frames a page may load. Without it, an attacker who manages to inject HTML into a page can pull in scripts from anywhere on the internet, steal data, or hijack signed-in sessions.

### CSP specifics

**Policy is pass-through, not merged.** The runtime emits whatever value you write in `HTTP/Content-Security-Policy` verbatim. Power-Pages-runtime sources are NOT added automatically — your directive must include them explicitly (see [Power-Pages-runtime sources a CSP must allow](#power-pages-runtime-sources-a-csp-must-allow)). If a runtime source is missing from your policy, those resources fail to load and parts of the site will not render.

**Nonce mechanism.** When `script-src` contains the keyword `'nonce'`, the runtime replaces it per-request with `'nonce-<random>'` and injects a matching `nonce` attribute on every Liquid-rendered inline `<script>` tag. Inline event handlers (e.g. `onclick=...`) are auto-hashed and those hashes are injected into the same directive. Scripts that are dynamically created in the browser via `document.createElement` do NOT receive the server-side nonce — refactor them to a file loaded from an allowlisted origin if the policy blocks them.

**`'unsafe-eval'` auto-injection.** The site-setting `HTTP/Content-Security-Policy/Inject-unsafe-eval` (boolean, default `true`) causes the runtime to auto-inject `'unsafe-eval'` into `script-src` when a `'nonce'` placeholder is present. This exists because several Power-Pages-runtime components require `'unsafe-eval'`. Setting it to `false` hardens the policy but may break runtime functionality — only disable after testing the site in report-only mode first.

**Report-Only.** A separate site-setting (`HTTP/Content-Security-Policy-Report-Only`) emits the standard Report-Only header. Enforcement and report-only can run simultaneously — the standard iteration workflow is:
1. Start with only the Report-Only setting configured.
2. Review the browser console for `Content-Security-Policy-Report-Only` violations on real traffic.
3. Add sources incrementally to a draft of the enforcing policy until Report-Only runs clean.
4. Promote the draft to `HTTP/Content-Security-Policy` (the enforcing setting).
5. Optionally delete the Report-Only setting once the enforcing policy is stable.

**Supported directives** include `default-src`, `img-src`, `font-src`, `script-src`, `style-src`, `connect-src`, `media-src`, `frame-src`, `frame-ancestors`, `form-action`, `object-src`, `worker-src`, `manifest-src`, `child-src`.

**`X-Frame-Options` vs CSP `frame-ancestors`.** Modern browsers use `frame-ancestors` when both are present; older browsers use `X-Frame-Options`. Setting both is safe. If the user only wants same-origin framing, `frame-ancestors 'self'` in CSP plus `HTTP/X-Frame-Options: SAMEORIGIN` covers both eras.

### CSP severity patterns

| Pattern | Severity |
|---------|----------|
| No `HTTP/Content-Security-Policy` set | `critical` |
| `unsafe-inline` or `unsafe-eval` in `script-src` | `warning` |
| `*` in `script-src` | `critical` |
| `*` for any directive other than `img-src` | `warning` |
| Policy present in report-only mode without an enforcement counterpart | `info` |

---

## Frame embedding

Goal: prevent another website from putting your sign-in or admin pages inside an iframe to trick users into clicking buttons that look harmless ("clickjacking").

| Setting | Recommended | Severity if missing |
|---------|-------------|---------------------|
| `HTTP/X-Frame-Options` | `SAMEORIGIN` (the platform default) or `DENY` | `warning` |
| CSP `frame-ancestors` directive | `'self'`, or a specific domain list. Never `*`. | `critical` |

Notes:

- Power Pages sets `HTTP/X-Frame-Options` to `SAMEORIGIN` by default.
- Modern browsers prefer the CSP `frame-ancestors` directive over `X-Frame-Options`. When CSP `frame-ancestors` is set and strict, `X-Frame-Options` is acceptable but redundant.
- If the user genuinely needs to embed the site (e.g., inside a corporate intranet), record the allowed parent domains explicitly in `frame-ancestors`. Bare `*` is never acceptable.

---

## Cross-Origin sharing

Goal: control which other websites are allowed to call this site's Web API from a browser context.

Power Pages exposes CORS through site settings under the `HTTP/Access-Control-` prefix.

| Setting | Purpose | Safe default |
|---------|---------|--------------|
| `HTTP/Access-Control-Allow-Origin` | Which origins may call the API | A specific HTTPS origin (e.g., the Dataverse instance URL) |
| `HTTP/Access-Control-Allow-Methods` | Allowed HTTP methods | Comma-separated list (e.g., `GET, POST, OPTIONS`) |
| `HTTP/Access-Control-Allow-Headers` | Allowed request headers | Comma-separated list (e.g., `Origin, Accept, Authorization, Content-Type`) |
| `HTTP/Access-Control-Allow-Credentials` | Whether the browser may send cookies | `true` only when needed; omit entirely otherwise |
| `HTTP/Access-Control-Expose-Headers` | Headers the browser may read from the response | Comma-separated list |
| `HTTP/Access-Control-Max-Age` | How long the browser caches preflight results (seconds) | A reasonable duration (e.g., `3600`) |

Plain-language explanation: this controls which other websites are allowed to call your site's data API from a browser. If you set it too widely, a malicious page can read or change your data while a user is signed in.

### CORS specifics

**`HTTP/Access-Control-Allow-Credentials` only accepts the value `true`** (case-sensitive). Browsers reject any other value. To disable credentials, omit the setting entirely — do not set it to `false`.

**`HTTP/Access-Control-Allow-Origin: *` is auto-specialized.** The runtime replaces `*` per-request with the specific requesting Origin — the browser sees a single-origin header, not a wildcard. This means `*` with credentials effectively works (since the response is actually per-origin), unlike the browser wildcard + credentials rule in raw HTTP. It also means CDN / cache design that assumes a static wildcard header will see a different `Vary: Origin` behavior — plan cache keys accordingly.

**Preflight (`OPTIONS`) behavior** follows standard browser mechanics. Configure `HTTP/Access-Control-Allow-Methods` to include every method your Web API exposes; configure `HTTP/Access-Control-Max-Age` to cache the preflight response (in seconds) and reduce round-trips. If browsers still send preflights on every request, check that the requested headers are covered by `HTTP/Access-Control-Allow-Headers`.

CORS headers are applied to every response, not only Web API responses — a missing `Allow-Origin` on a static asset response is visible in browser dev tools even for same-origin requests.

### CORS severity patterns

| Pattern | Severity |
|---------|----------|
| No `HTTP/Access-Control-Allow-Origin` set — no CORS allowed | `pass` |
| `HTTP/Access-Control-Allow-Origin` lists a specific HTTPS origin | `pass` |
| `HTTP/Access-Control-Allow-Origin` is `*` and credentials are not allowed | `info` |
| `HTTP/Access-Control-Allow-Origin` is `*` together with `HTTP/Access-Control-Allow-Credentials` set to `true` | `critical` |
| `HTTP/Access-Control-Allow-Methods` includes write methods with a wildcard origin | `warning` |

---

## Cookies

The Power Pages session cookie's cross-site behavior is controlled by `HTTP/SameSite/Default` (for all cookies) and `HTTP/SameSite/<CookieName>` (for individual cookies, e.g., `HTTP/SameSite/ASP.NET_SessionId` or `HTTP/SameSite/.AspNet.Cookies`).

Power Pages sets `HTTPOnly` and `SameSite` flags on every critical cookie. Some non-critical cookies may not carry these flags, which is expected behavior.

### SameSite values

| Value | When acceptable | Severity |
|-------|-----------------|----------|
| `Lax`  | Default for normal sites | `pass` |
| `Strict` | When the site is never embedded or linked from another site | `pass` |
| `None`  | Only when the site is intentionally embedded in another site via iframe, and only over HTTPS | `warning` (with reason) -> `critical` (without HTTPS) |

Plain-language explanation: this setting tells the browser when it is allowed to send your sign-in cookie. Setting it to "None" without a clear reason makes the user vulnerable to attacks that trick a third site into making requests on the user's behalf. When hosting the site inside an iframe on another domain, `None` is required — but the site must use HTTPS.

### SameSite specifics

**`HTTP/SameSite/Default`** — applies to every cookie the site sets unless overridden. Accepted values: `None`, `Lax`, `Strict`.

**`HTTP/SameSite/<cookie-name>`** — per-cookie override. Use when the global default is too restrictive for a specific cookie (e.g., the site is hosted in an iframe on a third-party domain and needs `None` for its session cookie).

**`None` requires `Secure`.** Browsers reject a `SameSite=None` cookie without the `Secure` attribute. The runtime sets `Secure` on every cookie when the site is served over HTTPS, so `None` works in practice for HTTPS sites.

For iframe-embedding scenarios (hosting a Power Pages site inside a third-party page), use `HTTP/SameSite/<session-cookie-name>: None` on the specific cookies the embed needs so they survive cross-site contexts.

---

## Other security headers

| Setting | Recommended | Severity if missing or wrong |
|---------|-------------|------------------------------|
| `HTTP/X-Content-Type-Options` | `nosniff` | `warning` |
| `HTTP/X-Download-Options` | `noopen` | `info` |
| `HTTP/X-Permitted-Cross-Domain-Policies` | `none` | `info` |
| `HTTP/Cross-Origin-Resource-Policy` | `same-origin` or `cross-origin` depending on use | `info` |
| `HTTP/Cross-Origin-Opener-Policy` | `same-origin` | `info` |
| `HTTP/Cross-Origin-Embedder-Policy` | `require-corp` (only if cross-origin isolation needed) | `info` |

The advanced settings UI in the Security workspace (currently a **preview** feature) also supports configuring **Referrer-Policy** and **Permissions-Policy** directives. These are managed through the UI rather than individual site setting YAML files:

- **Referrer-Policy** — controls how much referrer information is sent when navigating away. Configurable options: No Referrer, No Referrer When Downgrade, Same Origin, Origin, Strict Origin, Origin When Cross-Origin. Severity if misconfigured: `info`.
- **Permissions-Policy** — disables browser features the site does not need (camera, geolocation, microphone, etc.). Severity if not set: `info`.

---

## Power-Pages-runtime sources a CSP must allow

The runtime loads resources from these hosts. Any CSP you deploy must include them in the corresponding directives, or the site fails to render.

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
- `https:` (broad but matches the default)

**Required on `font-src` / `img-src` / `connect-src`**: depends on the site's own content. The `scan-external-urls.js` helper detects these.

### Starter directive template

If the user is starting a CSP from scratch, a reasonable starting directive (with `<cloud-host>` replaced by the cloud-specific host from the table above) is:

```
default-src 'self';
script-src 'self' 'nonce' <cloud-host>;
style-src 'self' 'unsafe-inline' https:;
img-src 'self' data: https:;
font-src 'self' https: data:;
connect-src 'self' https:;
frame-ancestors 'self';
```

Run `scan-external-urls.js` to tighten the `https:` wildcards into specific hosts before promoting to enforcement.

---

## Deployment and caching

Header changes land in Dataverse via `/deploy-site`. The site-setting update triggers a soft restart (no downtime); new values take effect once the restart propagates. Verify after a short wait in an incognito browser tab or via `curl -I <site-url>`.

**Maker-mode requests skip all `HTTP/*` header emission.** Requests from Power Pages Studio or other detected maker tools bypass the header middleware. Viewing the site through maker tools will NOT show your headers. Always verify with a fresh browser tab that is not authenticated as a maker.
