# Common authentication settings

## Plan before writing

Collect these choices for every external provider, including a retained provider being reconfigured.
Reuse already-confirmed External ID profile-attribute answers rather than asking twice.

| Choice | Options and stored value |
|---|---|
| Profile mapping | `PROFILE_MAPPING_CHOICE`: Standard (recommended), Standard + phone, Custom, None |
| Claims sync | `PROFILE_SYNC_FREQUENCY`: First sign-in only (recommended), Both |
| Contact linking | `CONTACT_LINKING_CHOICE`: Link to existing contact by verified email (recommended for pre-provisioned contacts), Create a new contact |
| Advanced settings | Defaults (recommended), Show selected provider's optional settings |
| External logout, even if other advanced settings declined | `LOGOUT_MODE`: Local logout only (recommended), Federated logout; skip unsupported social logout |

Explain that every-login claims sync overwrites user edits to mapped fields.
Use it only when the IdP is authoritative.
For untrusted or non-verified email claims, choose new-contact creation instead of linking.
Before linking, check for multi-tenant Authority paths `/organizations/` or `/common/` and wildcard `IssuerFilter`.
Such configurations disable contact mapping: use `false`, explain why and recommend a specific single-tenant authority.
Never equate a matching unverified email with proof of identity.

For external providers, confirm Open self-service versus Controlled pre-provisioned-only registration, including when reusing an existing app.
Store `OPEN_REGISTRATION_CHOICE`; it must agree with the site audience and local registration mode when both exist.
Local registration follows the four-mode matrix in the local branch, not the generic external default.
If invitations are explicitly requested on an external-only site, collect invitation/open-registration settings and load the invitation branch.
Resolve conflicting registration choices before final plan approval.
For external-only sites, derive `REGISTRATION_MODE` from the approved global switches without asking local-account questions:

| Open registration | Invitations | REGISTRATION_MODE | Registration Enabled |
|---|---|---|---|
| true | false | Open registration only | true |
| false | true | Invitation-only | true |
| true | true | Both | true |
| false | false | Registration disabled | false |

Controlled registration alone does not enable invitations; confirm them when requested or included in an accepted recommendation.
Use the same mode for route creation and the global `Enabled`, `OpenRegistrationEnabled` and `InvitationEnabled` settings.
This does not add a local provider or local registration form.
Per-provider registration and contact-linking choices must remain consistent with this global policy.

## Create or reconcile settings

Use the existing helper:

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "<Setting/Name>" \
  --value "<approved-value>" \
  --description "<purpose>"
```

Add `--type boolean` for boolean values.
Read `.powerpages-site/site-settings/` before writing.
The helper rejects duplicates by name and filename, case-insensitively.
On a duplicate, read the existing value: reuse retained configuration or an exact match, reconcile an approved change, and surface conflicts rather than treating every exit code 1 as success.
Do not overwrite a retained provider merely because an example uses a different value.
Use `MERGE_MODE` to decide which records can be removed or replaced.

## Provider names and callbacks

Choose unique protocol slugs: `OpenIdConnect_1`, `OpenIdConnect_2`, `SAML2_1`, `WsFederation_1`.
Keep discovered/custom slugs; Entra External ID uses the OIDC path.
For every OIDC provider, default:

| Setting | Value |
|---|---|
| `CallbackPath` | `/signin-{ProviderName-lowercased}` |
| `RedirectUri` | `{SITE_URL}/signin-{ProviderName-lowercased}` |

The middleware otherwise defaults every OIDC provider to `/signin-oidc`, causing collisions.
Read all existing callback/redirect settings and ensure uniqueness before writing.
Honor an approved custom same-host Redirect URI; derive CallbackPath from its pathname, not the default slug.
Validate host, path, reserved routes and collisions.
Have the user register the exact URI, including casing and suffix, in the IdP.
`AuthenticationType` and the SPA's provider identifier must match character-for-character.

Use collected `ClientId`/`AppId` values, derived non-secret values and Key Vault secret references.
Never leave unfilled client IDs in a completed configuration.

## Global and per-provider settings

Always require `Authentication/Registration/ProfileRedirectEnabled=false`.
If an existing record is true, correct it; otherwise server redirects to reserved `/profile` break the SPA.

Set `Authentication/Registration/ExternalLoginEnabled=true` when external login is in scope.
Do not blindly enable local login on an external-only site.
For local registration, write the approved `Enabled`, `OpenRegistrationEnabled` and `InvitationEnabled` matrix.
For external-only registration, honor `OPEN_REGISTRATION_CHOICE` rather than a local default; preserve unrelated existing switches.
Do not unconditionally write `Enabled=true` when registration is disabled.

For each configured external provider, use `Authentication/{Type}/{ProviderName}/...`, where Type is `OpenIdConnect`, `SAML2`, `WsFederation` or `OpenAuth`.

| Suffix | Value |
|---|---|
| `Caption` | Approved display name; local forms have no provider Caption |
| `RegistrationEnabled` | Approved per-provider registration choice; normally true, false can block new sign-ups while preserving existing sign-in |
| `RegistrationClaimsMapping` | Mapping below unless None |
| `LoginClaimsMapping` | Same mapping only for Both |
| `AllowContactMappingWithEmail` | Approved verified-email linking choice after multi-tenant guard |

The per-provider registration switch and global external-login switch are distinct.
Keep their meaning visible in the report.

## Claims mapping

The format is comma-separated `contactfield=claimtype`, not JSON.
Malformed pairs can be silently skipped by the server, so verify the generated string.

| Choice | OIDC mapping |
|---|---|
| Standard | `firstname=given_name,lastname=family_name,emailaddress1=email` |
| Standard + phone | `firstname=given_name,lastname=family_name,emailaddress1=email,mobilephone=phone_number` |
| Custom | Ask for each pair; validate contact logical column names and the provider's actual claims |
| None | Do not create registration/login mapping settings |

SAML2/WS-Federation use claim URIs, for example `firstname=http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname`.
Social claim names vary by provider; verify them instead of copying OIDC names blindly.
Workforce Entra is the explicit exception: use `emailaddress1=upn` and deterministic registration and login mappings from its provider contract.

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/{Type}/{ProviderName}/RegistrationClaimsMapping" \
  --value "<confirmed-comma-separated-mapping>" \
  --description "Map verified IdP claims on first sign-in"
```

Repeat with `LoginClaimsMapping` only when the approved sync choice requires it.
Write `AllowContactMappingWithEmail` with `--type boolean`, using the guarded choice.

## Logout

Explain local logout: the Power Pages session ends, but the IdP session remains and may silently SSO on the next sign-in.
Local logout is the default; do not auto-write OIDC `RPInitiatedLogout` or `ExternalLogoutEnabled`.
Federated logout also signs out at the IdP.
Collect `POST_LOGOUT_REDIRECT_URI`, default `{SITE_URL}/`, as a fully qualified URL on the same host.
Verify the provider's current registration requirements; for Entra External ID, guide the maker through its Authentication/logout URL configuration.

For OIDC, write both settings together:

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/RPInitiatedLogout" \
  --value "true" --type boolean \
  --description "Enable approved federated logout"

node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenIdConnect/{ProviderName}/PostLogoutRedirectUri" \
  --value "<POST_LOGOUT_REDIRECT_URI>" \
  --description "Return to the site after IdP logout"
```

Do not write one without the other; otherwise users can be stranded at the IdP.
For SAML2/WS-Federation, use their documented logout settings, not OIDC suffixes.
For unsupported social logout, skip these settings and state the limitation.
