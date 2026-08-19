---
name: dataverse-adapters
description: "Use to run Stage 8 of the mobile app journey: implement Dataverse repository adapters over generated services, switch data mode through one composition point, and verify parity with the approved mock business workflows."
argument-hint: "Connect generated Dataverse services to the approved app workflows"
user-invocable: true
---

# Mobile App Dataverse Adapters

Own generated-service mapping, Dataverse repository adapters, composition selection, and mock-versus-Dataverse parity.

Read [stage-contract.md](../create-mobile-app/references/stage-contract.md), [data-architecture.md](../create-mobile-app/references/data-architecture.md), and [ux-quality.md](../create-mobile-app/references/ux-quality.md).

## Procedure

1. Require Dataverse Schema `complete` with generated table interfaces/services. This required production-backend stage cannot be `not-required`; return `BLOCKED` if generation is incomplete.
2. Implement one related repository group per wave using generated Dataverse services.
3. Map generated records, choices, lookups, nullability, paging, and payloads to stable domain contracts at the adapter boundary.
4. Translate connector failures into domain errors and preserve input on recoverable mutation failures.
5. Before changing the active mode from `mock` to `dataverse`, remove every `MOCK_PREVIEW_AUTH_BYPASS` change recorded by App Builder and restore normal root redirect and protected-layout `useAuth` behavior. If Stage 4 replaced template-empty auth values with all-zero UUID placeholders, restore those fields to their pre-preview empty state; if it preserved configured values, leave them unchanged. Keep `PowerAppsProvider`, `/login`, and `/oauth-callback` intact. Parse `auth.config.json`, run type-check, and exercise auth loading, unauthenticated login redirect, and authenticated home routing before Dataverse acceptance. Missing or ambiguous Stage 4 auth-state evidence blocks the mode switch rather than permitting a guessed restoration.
6. Select `mock` or `dataverse` through one composition/configuration point. Never scatter mode checks through screens.
7. Keep mock adapters available for demos, tests, and fallback; do not silently fall back during a Dataverse acceptance test. Removing mock data from the active app means switching this composition point, not deleting the validated fallback adapters.
8. Exercise the same acceptance scenarios in both modes and compare ordering, filters, details, choices/lookups, mutations, permissions, and files/images.
9. Run schema generation, type-check, relevant bundle/test, and the working app gate in Dataverse mode. Provide the exact review route and test records.
10. Mark complete only when parity passes or explicitly document approved differences.

Deployment is outside this stage and always requires separate confirmation.