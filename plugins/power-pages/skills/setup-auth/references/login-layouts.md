# Login and registration layouts

These snippets show alternative layouts, not one complete file.
Adapt imports and state to enabled features; omit local/terms/invitation helpers and controls when those branches are disabled.

### Login Page - Layout Patterns

The Login page renders providers from `EXTERNAL_PROVIDERS` and (optionally) the local form. The structural skeleton is shared across all 4 layouts; only the provider section differs.

**Shared skeleton (all layouts):**

```tsx
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  loginWithProvider,
  AUTH_PROVIDERS,
  LOCAL_PROVIDER,
  EXTERNAL_PROVIDERS,
  getAuthError,
  getSessionExpiredMessage,
  TermsRequiredError,
} from '../services/authService'

export default function Login() {
  const navigate = useNavigate()
  // ... state: errors, touched, serverError, successMessage, infoMessage,
  //     isSubmitting, externalSubmittingId, plus invitationCode parsing ...

  function handleExternalSignIn(providerId: string) {
    const provider = AUTH_PROVIDERS.find(p => p.id === providerId)
    if (!provider) return
    setExternalSubmittingId(providerId)
    loginWithProvider(provider, { returnUrl: '/', invitationCode })
      .catch(err => { setServerError(err.message); setExternalSubmittingId(undefined) })
  }

  function handleLocalSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!LOCAL_PROVIDER) return
    // validate, then:
    loginWithProvider(LOCAL_PROVIDER, {
      returnUrl: '/',
      invitationCode,
      credentials: { credential: email, password, rememberMe: false },
    }).catch(err => {
      if (err instanceof TermsRequiredError) return navigate('/terms')
      setServerError(err.message)
    })
  }

  // ...render based on LOGIN_LAYOUT (see patterns below)...
}
```

#### Layout 1: Horizontal row (default)

External provider buttons in a wrapping flex row at the top. Local form below an "OR SIGN IN WITH EMAIL" divider.

**Text handling**: long display names wrap to two lines inside the button (buttons grow vertically to fit). This is preferred over single-line truncation with ellipsis - when text is center-aligned, ellipsis truncates from BOTH sides leaving the unreadable middle of the string visible (e.g., `WITH MICROSOFT ENTRA EXTER`). Allowing wrap gives a clean two-line button instead. The full label is also exposed via `title={p.displayName}` for hover tooltip and screen-reader accessibility.

```tsx
{EXTERNAL_PROVIDERS.length > 0 && (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 24 }}>
    {EXTERNAL_PROVIDERS.map(p => (
      <button key={p.id} type="button"
        title={p.displayName}
        style={{
          flex: '1 1 0',
          minWidth: 0,
          padding: '12px 16px',
          lineHeight: 1.3,
          textAlign: 'center',
          // No whiteSpace:nowrap - allow text to wrap to two lines for long labels
        }}
        disabled={!!externalSubmittingId || isSubmitting}
        onClick={() => handleExternalSignIn(p.id)}>
        {externalSubmittingId === p.id ? 'Redirecting...' : p.displayName}
      </button>
    ))}
  </div>
)}
{EXTERNAL_PROVIDERS.length > 0 && LOCAL_PROVIDER && <Divider label="OR SIGN IN WITH EMAIL" />}
{LOCAL_PROVIDER && <LocalForm onSubmit={handleLocalSubmit} loginByEmail={LOCAL_PROVIDER.loginByEmail} />}
```

> **Why allow wrapping instead of truncating**: with center-aligned text in a flex button, `text-overflow: ellipsis` doesn't behave as expected - the overflow clips both sides of the string, showing the middle of the label without any ellipsis marker. Allowing wrap (removing `whiteSpace: 'nowrap'`) keeps the label fully readable on two lines. The button height auto-adjusts. If you need uniform button heights, set `minHeight: 56` (or similar) on the button style; rows with short labels still look fine, and rows with long labels match the wrapped height.

#### Layout 2: Vertical stack

External provider buttons stacked full-width vertically. Same divider + local form below.

```tsx
{EXTERNAL_PROVIDERS.length > 0 && (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
    {EXTERNAL_PROVIDERS.map(p => (
      <button key={p.id} type="button"
        style={{ width: '100%', padding: '12px 16px' }}
        disabled={!!externalSubmittingId || isSubmitting}
        onClick={() => handleExternalSignIn(p.id)}>
        {externalSubmittingId === p.id ? 'Redirecting...' : p.displayName}
      </button>
    ))}
  </div>
)}
{/* divider + LocalForm - same as horizontal layout */}
```

#### Layout 3: Primary spotlight

One featured provider (matching `PRIMARY_PROVIDER_ID`) shown as a large primary CTA. Other external providers tucked under a `<details>` disclosure. Local form below.

```tsx
const primary = EXTERNAL_PROVIDERS.find(p => p.id === PRIMARY_PROVIDER_ID) ?? EXTERNAL_PROVIDERS[0]
const others = EXTERNAL_PROVIDERS.filter(p => p.id !== primary?.id)

{primary && (
  <button type="button" className="btn-primary"
    style={{ width: '100%', padding: '14px 20px', fontSize: '1rem', marginBottom: 12 }}
    disabled={!!externalSubmittingId || isSubmitting}
    onClick={() => handleExternalSignIn(primary.id)}>
    {externalSubmittingId === primary.id ? 'Redirecting...' : primary.displayName}
  </button>
)}
{others.length > 0 && (
  <details style={{ marginBottom: 24 }}>
    <summary style={{ cursor: 'pointer', fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
      More sign-in options
    </summary>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
      {others.map(p => (
        <button key={p.id} type="button"
          style={{ width: '100%', padding: '10px 16px' }}
          onClick={() => handleExternalSignIn(p.id)}>
          {p.displayName}
        </button>
      ))}
    </div>
  </details>
)}
{/* divider + LocalForm - same as horizontal layout */}
```

#### Layout 4: Tabbed

Tabs across the top - one tab per external provider, plus a "Email & password" tab when local exists. The selected tab's UI renders below.

```tsx
const [activeTab, setActiveTab] = useState<string>(
  EXTERNAL_PROVIDERS[0]?.id ?? LOCAL_PROVIDER?.id ?? ''
)

const allTabs: { id: string; label: string }[] = [
  ...EXTERNAL_PROVIDERS.map(p => ({ id: p.id, label: p.displayName })),
  ...(LOCAL_PROVIDER ? [{ id: LOCAL_PROVIDER.id, label: 'Email & password' }] : []),
]

return (
  <>
    <div role="tablist" style={{
      display: 'flex',
      gap: 4,
      borderBottom: '1px solid var(--color-border)',
      marginBottom: 24,
      overflowX: 'auto',  // long tab labels can scroll horizontally if they exceed the card width
    }}>
      {allTabs.map(tab => (
        <button key={tab.id} role="tab" aria-selected={activeTab === tab.id}
          title={tab.label}
          style={{
            padding: '10px 16px', border: 'none', background: 'none',
            borderBottom: activeTab === tab.id ? '2px solid var(--color-primary)' : '2px solid transparent',
            cursor: 'pointer', fontWeight: activeTab === tab.id ? 600 : 400,
            whiteSpace: 'nowrap',  // tab labels stay single-line; container scrolls if needed
            flexShrink: 0,
          }}
          onClick={() => setActiveTab(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>

    {/* Render the active tab's UI */}
    {(() => {
      const external = EXTERNAL_PROVIDERS.find(p => p.id === activeTab)
      if (external) {
        return (
          <button type="button" className="btn-primary"
            style={{ width: '100%' }}
            disabled={!!externalSubmittingId}
            onClick={() => handleExternalSignIn(external.id)}>
            {externalSubmittingId === external.id ? 'Redirecting...' : external.displayName}
          </button>
        )
      }
      if (LOCAL_PROVIDER && activeTab === LOCAL_PROVIDER.id) {
        return <LocalForm onSubmit={handleLocalSubmit} loginByEmail={LOCAL_PROVIDER.loginByEmail} />
      }
      return null
    })()}
  </>
)
```

#### Single-provider sites

When `AUTH_PROVIDERS.length === 1`, all layouts collapse to a single button (external) or a single form (local). The layout choice doesn't visually matter - pick `horizontal-row` as the no-op default.

---
