# Workforce Microsoft Entra ID

**For "Microsoft Entra ID"** (workforce / employee tenant): No tenant or client info needed. Power Pages auto-configures the OIDC site settings (`Authentication/OpenIdConnect/AzureAD/*`) for the site's parent tenant when the site is created. The SPA derives the `providerIdentifier` (`https://login.windows.net/{tenantId}/`) at runtime from `window.Microsoft.Dynamic365.Portal.tenant` - no hardcoded values.

**Claims mapping is also auto-configured silently** - Phase 8.1 always writes `Authentication/OpenIdConnect/AzureAD/RegistrationClaimsMapping` and `LoginClaimsMapping` with the value `firstname=given_name,lastname=family_name,emailaddress1=upn` for the workforce Entra provider. **No question is asked for this** - the answer is deterministic. Workforce Entra ID issues v1.0 tokens by default (issuer `sts.windows.net/{tid}/`) which omit the `email` claim, so `upn` is the only reliable claim to populate `emailaddress1`. Without this mapping, contacts created on first sign-in have `oid` linked but firstname/lastname/email all empty (the User object renders with `contactId` but blank profile fields).

Only ask one optional question - the button display name. Provide a sensible default the user can accept:

| Question | Options |
|----------|---------|
| What should the login button label say? (default: `Sign in with Microsoft`) | *(free text, defaulted)* |

Store as `ENTRA_ID_DISPLAY_NAME` (default `"Sign in with Microsoft"`). Phase 3.2 adds an entry to `AUTH_PROVIDERS` with `type: 'entra-id'`, this display name, and **no `providerIdentifier`** (runtime-resolved).

> **Why no tenant ID?** The tenant ID is essentially for SPA-button wiring (the value the SPA POSTs to `/Account/Login/ExternalLogin`). Power Pages exposes the site's parent tenant ID at runtime via `window.Microsoft.Dynamic365.Portal.tenant`, so the SPA can construct the providerIdentifier (`https://login.windows.net/{tenantId}/`) without asking the user. The server-side OIDC settings are already in place from site creation. Compare this to **Entra External ID**, where the tenant is a SEPARATE customer tenant unrelated to the site's parent - there we DO need the user to provide the tenant ID + subdomain because they can't be derived from `Portal.tenant`.

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/openid-settings

>
> With these settings ("Federated logout"), `/Account/Login/LogOff` 302s to the IdP's `end_session_endpoint` with `id_token_hint` and `post_logout_redirect_uri`. The IdP signs the user out and redirects to the registered post-logout URI. **The user MUST also register that URI in the IdP app registration** (see Phase 2.1.1) - confirmed via HAR analysis that without app-registration of the front-channel logout URL, the IdP silently drops the parameter and users get stranded.

**Provider-specific settings** - create site settings for **EACH** provider selected in Phase 2.1. If the user selected multiple providers (e.g., Entra External ID + Local Authentication), create settings for ALL of them:

**Microsoft Entra ID** - Authority, ClientId, Metadata, etc. are auto-configured by Power Pages on site creation (provider name `AzureAD`). However, **always write claims mapping settings** so first-time-sign-in contacts get firstname/lastname/email populated. The auto-configured AzureAD provider does NOT have claims mapping by default - without these settings, new contacts are created with the user's `oid` linked but every other field empty (verified empirically: workforce Entra ID v1.0 tokens don't include the `email` claim, and the server doesn't auto-derive contact fields from `given_name`/`family_name` claims unless an explicit mapping is configured).

```bash
# RegistrationClaimsMapping - applied once at first sign-in, before contact is created.
# Uses `upn` for email because workforce Entra ID v1.0 tokens don't include the `email`
# claim by default. UPN (user principal name, e.g. user@contoso.com) is the standard
# substitute and matches what the user expects in their profile.
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/AzureAD/RegistrationClaimsMapping" \
  --value "firstname=given_name,lastname=family_name,emailaddress1=upn" \
  --description "Map AzureAD claims to contact fields on first sign-in (UPN as email - workforce v1.0 tokens lack email claim)"

# LoginClaimsMapping - applied every sign-in. Updates contact fields if user info
# changes in Entra (e.g., name change). Same mapping as Registration; safe to write
# both for consistency.
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/AzureAD/LoginClaimsMapping" \
  --value "firstname=given_name,lastname=family_name,emailaddress1=upn" \
  --description "Re-apply claim mapping on every sign-in so contact fields stay in sync with Entra"
```

> **Why `upn` and not `email`?** Workforce Entra ID's OIDC endpoint defaults to v1.0 tokens (issuer `sts.windows.net/{tid}/`) which do NOT include the `email` claim by default. To get the `email` claim, the app registration would need to be configured for v2.0 tokens AND request the `email` scope AND the user must have a verified email address in their Entra profile (none of which is the default). The `upn` claim, however, is always emitted for workforce users - it's the user principal name (e.g., `user@contoso.com`) which functions as the email for most workforce scenarios. This applies ONLY to workforce Entra ID (the auto-configured `AzureAD` provider). **Entra External ID uses v2.0 tokens with proper `email` claim - its mapping should be `emailaddress1=email`, NOT `emailaddress1=upn`** (see the Profile mapping question in Phase 2.1 for External ID).

> **No question is asked for this.** Unlike other external providers where the Profile mapping question (Track B) is part of Phase 2.1, the Entra ID mapping is written silently because (a) workforce Entra IS deterministic on which claim is the right substitute for email (always `upn`), and (b) without this mapping the contact is created broken, so opting out doesn't make sense.

**OpenID Connect** - create settings for the provider (ClientId from Phase 2.1.2 setup, or pasted manually):

### v1.0 vs v2.0 tokens - claim availability by Entra product

Different Entra products issue different token versions with different claim defaults. **This matters for the `RegistrationClaimsMapping` value** because some claim types don't exist in v1.0 tokens.

| Entra product | Default token version | Issuer pattern | `email` claim | `upn` claim | `preferred_username` claim | `given_name` / `family_name` |
|---|---|---|---|---|---|---|
| **Microsoft Entra ID (workforce, AzureAD)** | v1.0 | `sts.windows.net/{tid}/` | ❌ Not by default (requires v2.0 + email scope + verified email) | ✅ Yes (`user@tenant.onmicrosoft.com` or custom domain) | ❌ v2.0-only | ✅ Yes |
| **Microsoft Entra External ID (OpenIdConnect)** | v2.0 | `{subdomain}.ciamlogin.com/{tid}/v2.0` | ✅ Yes (with email user flow attribute) | ❌ Not typically emitted | ✅ Yes | ✅ Yes (with user flow attributes) |
| **Azure AD B2C (legacy)** | v2.0 | `{tenant}.b2clogin.com/{policy}/v2.0/` | ✅ Yes (if email user flow attribute selected) | ❌ Not typically | ✅ Yes | ✅ Yes (with user flow attributes) |

**Implication for `RegistrationClaimsMapping`**:
- **AzureAD (workforce)**: `emailaddress1=upn` (skill writes this silently)
- **Entra External ID**: `emailaddress1=email` (skill asks via Profile mapping question; default uses `email`)
- **Other v2.0 OIDC providers**: depends on provider - Okta, Auth0, etc. mostly emit `email`. User can choose.

If you need workforce Entra ID to emit the `email` claim instead of relying on UPN (e.g., for organizations where UPN ≠ email):

1. Edit the app registration in Entra admin center → **Token configuration** → **Add optional claim** → `email`
2. Verify the user has a verified email in their Entra profile (`mail` attribute)
3. The token will then include `email` and you can switch the mapping to `emailaddress1=email`

But for the default config that Power Pages auto-creates, `upn` is the reliable choice.
