# WS-Federation

**For "WS-Federation"**:

| Question | Options |
|----------|---------|
| What is the metadata endpoint URL for your WS-Federation provider? (e.g., `https://adfs.contoso.com/federationmetadata/2007-06/federationmetadata.xml`) | *(free text)* |
| What is the provider realm or identifier? (e.g., `https://adfs.contoso.com/adfs/services/trust`) | *(free text)* |
| What display name should the login button show? (e.g., `Sign in with ADFS`) | *(free text)* |

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/ws-federation-settings

**WS-Federation** - create settings for the provider:

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/WsFederation/{ProviderName}/MetadataAddress" \
  --value "<metadata-url-from-user>" \
  --description "WS-Fed metadata URL"

node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/WsFederation/{ProviderName}/AuthenticationType" \
  --value "<provider-realm-or-identifier>" \
  --description "Provider identifier for ExternalLogin"

node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/WsFederation/{ProviderName}/Wtrealm" \
  --value "<site-url>" \
  --description "Relying party realm"
```

> **Note:** The `AuthenticationType` value must match what `resolveProviderIdentifier()` returns in the auth service.

### WS-Federation Provider Settings

Pattern: `Authentication/WsFederation/{ProviderName}/{SettingName}`

| Setting | Description |
|---------|-------------|
| `MetadataAddress` | URL of the WS-Fed metadata XML |
| `AuthenticationType` | Unique identifier for this provider |
| `Wtrealm` | The relying party realm (typically the site URL) |
| `Caption` | Display name shown on the login button |
| `ExternalLogoutEnabled` | `true` to enable federated logout |

**WS-Federation optional settings:**

| Setting | Description | Default |
|---------|-------------|---------|
| `Wreply` | Reply URL for the WS-Fed response | Same as Wtrealm |
| `Whr` | Home realm discovery hint (e.g., a domain name) | None |
| `SignOutWreply` | URL for post-logout redirect | Site root |
| `RegistrationClaimsMapping` | **Comma-separated `contactfield=claimtype` pairs**. WS-Fed claim types are typically SAML URIs (e.g., `firstname=http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname`). Applied once at first sign-in. | None |
| `LoginClaimsMapping` | Same format. Applied every login (overwrites contact fields). | None |
| `ExternalLogoutEnabled` | Enable federated sign-out | `true` |
| `RegistrationEnabled` | Allow new users to register via this provider | `true` |
| `AllowContactMappingWithEmail` | **Auto-link an external sign-in to an existing Dataverse contact by matching the `email` claim against `emailaddress1`.** Default `false` (a new contact is always created). **⚠ Multi-tenant Entra External ID: the server forcibly disables this** - email claims can't be trusted across tenants. If you want contact linking, use single-tenant Authority. **⚠ Security**: When `true`, anyone who can sign into this provider with a victim's email gains access to the victim's contact. Enable only when the provider is trusted to verify emails. | `false` |
| `BackchannelTimeout` | Timeout for metadata retrieval | `00:01:00` |
| `UseTokenLifetime` | Use IdP token lifetime for session | Not set |
| `IssuerFilter` | Wildcard pattern for multi-tenant issuer matching | None |
