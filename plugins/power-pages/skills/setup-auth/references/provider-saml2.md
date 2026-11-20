# SAML2

**For "SAML2"**:

| Question | Options |
|----------|---------|
| What is the metadata endpoint URL for your SAML2 identity provider? (e.g., `https://adfs.contoso.com/FederationMetadata/2007-06/FederationMetadata.xml`) | *(free text)* |
| What display name should the login button show? (e.g., `Sign in with ADFS`, `Sign in with Login.gov`) | *(free text)* |

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/saml2-settings
> Login.gov (US government SAML IdP) - get its metadata endpoint from the SAML developer guide: https://developers.login.gov/saml/getting-started/

**SAML2** - create settings for the provider:

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/SAML2/{ProviderName}/MetadataAddress" \
  --value "<metadata-url-from-user>" \
  --description "SAML IdP metadata URL"

node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/SAML2/{ProviderName}/AuthenticationType" \
  --value "<site-url>" \
  --description "Provider identifier for ExternalLogin - MUST match providerIdentifier in authService exactly"

node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/SAML2/{ProviderName}/ServiceProviderRealm" \
  --value "<site-url>" \
  --description "SP entity ID"
```

> **CRITICAL for SAML2:** The `AuthenticationType` site setting value and the `providerIdentifier` in the auth service code MUST be character-for-character identical - including protocol (`https://` vs `http://`), trailing slashes, and casing. A mismatch causes login to silently fail. Use the exact same `<site-url>` value in both places.

**SAML2 optional settings:**

| Setting | Description | Default |
|---------|-------------|---------|
| `AssertionConsumerServiceUrl` | ACS URL (typically `{site-url}/signin-{ProviderName-lowercased}`) | Derived from site URL |
| `RegistrationClaimsMapping` | **Comma-separated `contactfield=claimtype` pairs**. SAML assertion types are URIs (e.g., `firstname=http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname,lastname=http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname`). Applied once at first sign-in. | None |
| `LoginClaimsMapping` | Same format. Applied every login (overwrites contact fields). | None |
| `ExternalLogoutEnabled` | Enable SAML Single Logout (SLO) | `true` |
| `RegistrationEnabled` | Allow new users to register via this provider | `true` |
| `AllowContactMappingWithEmail` | **Auto-link an external sign-in to an existing Dataverse contact by matching the `email` claim against `emailaddress1`.** Default `false` (a new contact is always created). **⚠ Multi-tenant Entra External ID: the server forcibly disables this** - email claims can't be trusted across tenants. If you want contact linking, use single-tenant Authority. **⚠ Security**: When `true`, anyone who can sign into this provider with a victim's email gains access to the victim's contact. Enable only when the provider is trusted to verify emails. | `false` |
| `AllowCreateNameIdPolicy` | Include AllowCreate in NameIdPolicy | `true` |
| `DefaultSignatureAlgorithm` | Signature algorithm for SAML requests | Provider default |
| `SigningCertificateFindType` | X509 certificate find type for signing requests | None |
| `SigningCertificateFindValue` | Certificate find value (e.g., thumbprint) | None |
| `ExternalLogoutCertThumbprint` | Certificate thumbprint for SLO response signing | None |
| `SingleLogoutServiceRequestPath` | Custom path for SLO request | Default |
| `SingleLogoutServiceResponsePath` | Custom path for SLO response | Default |
| `Comparison` | AuthnContextComparison type (`exact`, `minimum`, `maximum`, `better`) | None |
| `BackchannelTimeout` | Timeout for metadata retrieval | `00:01:00` |
| `UseTokenLifetime` | Use IdP token lifetime for session | Not set |
| `EmailClaimIdentifier` | Custom claim type for user's email | Standard email claim |
| `IssuerFilter` | Wildcard pattern for multi-tenant issuer matching | None |

### SAML2 Provider Settings

Pattern: `Authentication/SAML2/{ProviderName}/{SettingName}`

| Setting | Description |
|---------|-------------|
| `MetadataAddress` | URL of the SAML IdP metadata XML |
| `AuthenticationType` | Unique identifier for this provider |
| `ServiceProviderRealm` | The SP entity ID (typically the site URL) |
| `AssertionConsumerServiceUrl` | The ACS URL (typically `{site-url}/signin-{ProviderName-lowercased}`) |
| `Caption` | Display name shown on the login button |
| `SignAuthenticationRequests` | `true` to sign SAML authn requests |
| `ExternalLogoutEnabled` | `true` to enable SAML Single Logout (SLO) |
| `NameIdPolicy` | Format of the NameID claim (e.g., `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`) |
| `AuthnContextClassRef` | Authentication context class (e.g., `urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport`) |
| `ForceAuthn` | `true` to force re-authentication even if session exists at IdP |
