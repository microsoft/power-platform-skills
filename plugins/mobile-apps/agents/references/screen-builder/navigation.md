# Navigation and route safety

Read own/destination rows of `### Navigation Contracts` before using params or
navigation. Declare the full contract union in `useLocalSearchParams`, with required
path params and optional query params, all string values. This preserves caller/
receiver typing; TypeScript annotations themselves do not filter runtime params.

Locked conventions: `editId` for create-or-edit forms, `[id]` for primary entity,
`[<entity>Id]` for nested entities. Never invent `?recordId=` or `?id=`. A missing
destination contract is `NEEDS_CONTEXT`, not a guessed route.

Runtime params can be arrays despite declared types. Normalize the value before all
Dataverse get/update/delete/upload/download calls:

```tsx
const params = useLocalSearchParams<{ id: string }>();
const rawId = Array.isArray(params.id) ? params.id[0] : params.id;
const id = normalizeDataverseGuid(rawId);
```

Use the shared helper, not an inline RFC UUID regex: Dataverse sequential GUIDs need
not have RFC version bits. Reject missing IDs and literal `'null'`/`'undefined'`
before services; `enabled: !!rawId` is not validation.

## Intent and repeat taps

- Singleton destination (including planned singleton forms/login): `router.navigate`.
- Entity-detail drill-down: `router.push`.
- Auth/guard redirect and explicit post-create continuation: `router.replace`.
- Ordinary successful save: `router.back()` if possible, otherwise the declared parent
  with `router.navigate`. Never push another form after Save by default.
- Navigation handlers need a synchronous ref plus disabled feedback when relevant.
  Keep the guard until transition/focus reset, not an immediate `finally` around a
  synchronous router call (that would permit the next tap). Release on navigation
  failure; one-shot successful replace may remain locked.

Read-only back can use navigator behavior. Dirty or in-flight writes must use the
approved leave/cancel contract rather than silently losing work.

## Profile

Profile is `/(app)/profile`, with planned app-specific content above visible `Sign out`.
Use confirmed `useAuth().signOut()` then `router.replace('/login')`; failures stay
recoverable. Do not clear storage manually, invoke CLI logout, create another auth
service, or add sign-out to unrelated screens. Role-conditioned UI follows the approved
role contract but is not a substitute for backend authorization.

Never declare routes or modify `_layout.tsx`; the foreground owns navigator changes.
