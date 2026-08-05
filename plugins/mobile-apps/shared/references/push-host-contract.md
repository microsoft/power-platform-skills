# Upstream push host contract

The mobile plugin repository can ship the template dependencies and skill
workflows, but two capabilities must exist in the upstream prebuilt runtime.

## Native modules

The Power Apps Developer/rewrap binary must be built from a template containing:

- `expo-notifications` `~55.0.23`
- `@react-native-firebase/app` `25.1.0`
- `@react-native-firebase/messaging` `25.1.0`
- `expo-build-properties` `~55.0.14`

React Native Firebase v25 is intentional: it still supports the Legacy
Architecture used when `@microsoft/power-apps-native-offline` activates.
Upgrading to v26 requires resolving that architecture conflict first.

## Auth identity

`useAuth()` must expose a non-secret current-user identity:

```ts
interface AuthUser {
  oid: string;
  username?: string;
  tenantId?: string;
}

interface AuthState {
  // existing fields
  user: AuthUser | null;
}
```

The host validates and lowercases `account.claims.oid` from the decoded ID-token
claims already provided by `@microsoft/power-apps-native-auth`. Generated apps must not acquire
a token solely to decode it, persist an ID/access token, use the MSAL home
account identifier as an OID, or import an internal JWT parser.

Required behavior:

- `user` is null while auth is unresolved, signed out, or in no-auth mode.
- `user.oid` changes atomically on account switch.
- sign-out clears `user` before downstream lifecycle hooks run.
- malformed/missing OID is surfaced as an auth error, not an empty string.

The bundled template applies `template/scripts/patch-native-host-auth.js` after
installation while host 0.2.25 lacks this public field. The patch is
version-shape-guarded, fail-closed, and idempotent; remove it when the upstream
package publishes the same contract.
