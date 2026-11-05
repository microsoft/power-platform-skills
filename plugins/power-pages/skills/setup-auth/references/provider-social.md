# Social identity providers

**For "Microsoft Account"**:

| Question | Options |
|----------|---------|
| What is the Client ID from your Microsoft app registration? (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890`) | *(free text)* |

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/openid-settings

**For "Facebook"**:

| Question | Options |
|----------|---------|
| What is the App ID from the Facebook Developer Console? (e.g., `1234567890123456`) | *(free text)* |

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/facebook-settings

**For "Google"**:

| Question | Options |
|----------|---------|
| What is the Client ID from the Google Cloud Console? (e.g., `123456789-abc.apps.googleusercontent.com`) | *(free text)* |

> Docs: https://learn.microsoft.com/en-us/power-pages/security/authentication/oauth2-google

**Facebook** - uses `AppId` (not `ClientId`). The App ID was collected in Phase 2.1:

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenAuth/Facebook/AppId" \
  --value "<app-id-from-user>" \
  --description "Facebook App ID"
```

**Google** - the Client ID was collected in Phase 2.1:

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenAuth/Google/ClientId" \
  --value "<client-id-from-user>" \
  --description "Google Client ID"
```

**Microsoft Account** - the Client ID was collected in Phase 2.1:

```bash
node "${PLUGIN_ROOT}/scripts/create-site-setting.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --name "Authentication/OpenAuth/MicrosoftAccount/ClientId" \
  --value "<client-id-from-user>" \
  --description "Microsoft Account Client ID"
```

**Social OAuth optional settings** (Microsoft Account, Facebook, Google):

| Setting | Description | Default |
|---------|-------------|---------|
| `Scope` | OAuth scopes to request (space-separated) | Provider defaults |
| `RegistrationClaimsMapping` | **Comma-separated `contactfield=claimtype` pairs**. Social provider claim types vary - Facebook uses `name`/`email`, Google uses `given_name`/`family_name`/`email`. Example: `firstname=given_name,emailaddress1=email`. Applied once at first sign-in. | None |
| `LoginClaimsMapping` | Same format. Applied every login (overwrites contact fields). | None |
| `ExternalLogoutEnabled` | Sign out of social provider on logout | `true` |
| `RegistrationEnabled` | Allow new users to register via this provider | `true` |
| `AllowContactMappingWithEmail` | **Auto-link an external sign-in to an existing Dataverse contact by matching the `email` claim against `emailaddress1`.** Default `false` (a new contact is always created). **⚠ Multi-tenant Entra External ID: the server forcibly disables this** - email claims can't be trusted across tenants. If you want contact linking, use single-tenant Authority. **⚠ Security**: When `true`, anyone who can sign into this provider with a victim's email gains access to the victim's contact. Enable only when the provider is trusted to verify emails. | `false` |
| `BackchannelTimeout` | Timeout for OAuth token exchange | `00:01:00` |

### Social OAuth Provider Settings

Social providers use the `Authentication/OpenAuth/{ProviderName}/` site setting path:

| Setting Pattern | Description |
|-----------------|-------------|
| `Authentication/OpenAuth/{SocialProvider}/ClientId` | App ID from the social provider (generic) |
| `Authentication/OpenAuth/{SocialProvider}/ClientSecret` | App secret from the social provider (generic) |
| `Authentication/OpenAuth/{SocialProvider}/Caption` | Button label (e.g., "Sign in with Facebook") |

**Facebook-specific settings** -- Facebook uses `AppId` and `AppSecret` (not `ClientId`/`ClientSecret`). The server falls back to `ClientId`/`ClientSecret` if `AppId`/`AppSecret` are not set, but the canonical setting names are:

| Setting | Description |
|---------|-------------|
| `Authentication/OpenAuth/Facebook/AppId` | Facebook App ID from the Facebook Developer Console |
| `Authentication/OpenAuth/Facebook/AppSecret` | Facebook App Secret from the Facebook Developer Console |

**Google-specific settings:**

| Setting | Description |
|---------|-------------|
| `Authentication/OpenAuth/Google/ClientId` | Google Client ID from the Google Cloud Console |
| `Authentication/OpenAuth/Google/ClientSecret` | Google Client Secret from the Google Cloud Console |

Never put `ClientSecret` or `AppSecret` values in source, conversation or reports.
Use the entry-linked secrets workflow: the user stores the value in Key Vault and shares only its URI.
Create a secret-typed Dataverse environment variable and link it with `create-site-setting.js --envVarSchema`.
Do not substitute a plain-string environment variable or ask for the actual value in the maker portal.
