# Discover existing authentication

#### 1.5 Discover Existing Auth Configuration

**Always run this discovery step, even on a first invocation** - the site may have site settings from a prior run, or from hand-editing the YAML files, even if no SPA auth code exists yet. The goal is to make sure we never silently drop a provider that's already configured server-side.

**Step 1 - Scan `.powerpages-site/site-settings/` for already-configured providers.**

Detect existing providers by matching site-setting filenames against these patterns:

| Pattern | Maps to provider type |
|---|---|
| `Authentication-OpenIdConnect-{Name}-AuthenticationType.sitesetting.yml` | OIDC (Entra External ID, Okta, Auth0, generic OIDC, B2C - all share the OIDC path) |
| `Authentication-SAML2-{Name}-AuthenticationType.sitesetting.yml` | SAML2 |
| `Authentication-WsFederation-{Name}-AuthenticationType.sitesetting.yml` | WS-Federation |
| `Authentication-OpenAuth-{Microsoft\|MicrosoftAccount\|Facebook\|Google}-{ClientId\|AppId}.sitesetting.yml` | Social OAuth; retain the discovered spelling |
| `Authentication-Registration-LocalLoginEnabled.sitesetting.yml` with value `true` | Local Authentication |

For each detected provider, read its full set of `.sitesetting.yml` files to extract: `Authority` / `MetadataAddress`, `ClientId` / `AppId`, `AuthenticationType` (the providerIdentifier), `Caption` or display name (if present), and the `{Name}` slug used in the keys (e.g., `OpenIdConnect_1`, `EntraExternalId`).

**Distinguishing Entra ID variants from OIDC** - by Authority URL pattern:

| Authority pattern | Provider type | Notes |
|---|---|---|
| `https://login.windows.net/{guid}/` (no `/v2.0/`) - site's parent tenant | **Microsoft Entra ID (workforce)** - `type: 'entra-id'` | Auto-populated by Power Pages on site creation. The `{Name}` slug is usually `AzureAD`. **Set `providerIdentifier` to undefined in AUTH_PROVIDERS** - runtime resolver derives it from `Portal.tenant`. |
| `https://{subdomain}.ciamlogin.com/{tenantId}` (no trailing `/v2.0/`) | **Entra External ID** - `type: 'oidc'` | Customer tenant. Must include explicit `providerIdentifier` matching the Authority. |
| `https://{tenant}.b2clogin.com/{tenant}.onmicrosoft.com/v2.0/{policy}` | **Azure AD B2C** (legacy) - `type: 'oidc'` | Older B2C product. Must include explicit `providerIdentifier`. |
| Any other OIDC authority (Okta, Auth0, etc.) | **OIDC** - `type: 'oidc'` | Must include explicit `providerIdentifier`. |

**The Entra ID (workforce) case is special** - when Phase 1.5 discovery detects `Authentication/OpenIdConnect/AzureAD/*` settings on the site (which Power Pages auto-creates for the parent tenant), add a single entry to `EXISTING_PROVIDERS`:

```typescript
{
  id: 'entra-id',
  type: 'entra-id',
  displayName: existingCaption || 'Sign in with Microsoft',
  // NO providerIdentifier - resolveProviderIdentifier() derives it from Portal.tenant
}
```

Do NOT extract the tenant ID from the existing Authority site setting just to hardcode it back into AUTH_PROVIDERS - the runtime resolver handles it. This keeps the SPA code portable if the site is ever cloned to a different tenant.

**Step 2 - Scan for existing SPA auth code.**

Check for these files and read their key markers:

- `src/services/authService.ts` or `.js` - look for `AUTH_PROVIDERS` array (current pattern) vs single `AUTH_PROVIDER` constant (legacy)
- `src/types/powerPages.d.ts` - exists or not
- `src/utils/authorization.ts` - exists or not
- Auth components (`AuthButton.*`, `Login.*`, `Registration.*`, `RedeemInvitation.*`, etc.) - list which exist
- `src/pages/Login.tsx` - extract which providers it currently renders (via `AUTH_PROVIDERS` import or inline)

**Step 3 - Present findings to the user.**

If providers were detected from site settings, present them with their config:

```
I found these existing auth providers on your site:

  ✓ Entra External ID
    - ProviderName: OpenIdConnect_1
    - Tenant: 00000000-0000-0000-0000-000000000001
    - ClientId: 00000000-0000-0000-0000-000000000002
    - Configured in site settings: yes
    - Surfaced in SPA UI: NO (authService.ts has no entry for this provider)

  ✓ Local Authentication
    - LoginByEmail: true
    - Surfaced in SPA UI: yes
```

<!-- not-a-gate: configuration sub-prompt selects merge mode; setup-auth:2.2.plan-approval approves any replacement before files change. -->
Ask the user:

| Question | Header | Options |
|----------|--------|---------|
| I found existing auth providers on your site. What would you like to do? | Existing auth | Keep all existing providers and add a new one (Recommended) - preserves what's there, adds what you ask for next, Keep all existing providers (no new provider this run) - re-generates SPA code to surface what's already in site settings, Replace everything with a new configuration - wipes existing site settings and SPA code, starts fresh |

**"Keep all existing providers and add a new one"** (default path):
- Store the discovered providers as `EXISTING_PROVIDERS` - these will be merged into the `AUTH_PROVIDERS` array generated in Phase 3.2
- Phase 2.1 will prompt for the NEW provider being added; the existing ones are kept untouched
- For **local auth specifically** - if `Local Authentication` is in `EXISTING_PROVIDERS`, **always regenerate the local auth SPA code** (login flow, registration page, forgot/reset password, redeem invitation) from the user's Phase 2.1 answers. Don't try to preserve hand-edited local-auth code - the local flows are complex enough that partial updates introduce more bugs than they avoid.

**"Keep all existing providers (no new provider this run)"**:
- Skip the Phase 2.1 provider selection question entirely
- Re-derive `AUTH_PROVIDERS` from `EXISTING_PROVIDERS` only
- Useful for: fixing a site where the SPA UI is missing a provider that's already in site settings (the exact bug this branch was created to fix)

**"Replace everything with a new configuration"**:
- Set `EXISTING_PROVIDERS = []`
- Delete existing OIDC/SAML2/WsFed/OpenAuth site-setting YAMLs as part of Phase 8.1
- Run Phase 2.1 as if no providers existed

> **DO NOT** offer a "skip / no changes" option. If the user invokes setup-auth, they want auth set up - silently doing nothing is worse than asking.
