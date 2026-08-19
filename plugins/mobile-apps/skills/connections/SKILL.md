---
name: connections
description: "Use to run Stage 6 of the mobile app journey: configure and integrate approved non-Dataverse Power Platform connector connections after native capabilities and before Dataverse, while retaining mock adapters and a working reviewable app."
argument-hint: "Connect the approved non-Dataverse services"
user-invocable: true
---

# Mobile App Connections

Own non-Dataverse Power Platform connection discovery, data-source generation, connector adapters, and screen integration. This stage always precedes Dataverse.

Read [stage-contract.md](../create-mobile-app/references/stage-contract.md), [data-architecture.md](../create-mobile-app/references/data-architecture.md), and [template-contract.md](../create-mobile-app/references/template-contract.md).

## Procedure

1. Require Native Capabilities to be `complete` or `not-required` and require a passing mock baseline.
2. If no non-Dataverse connectors are approved, run the gate, mark Connections `not-required`, and return `DONE_NOT_REQUIRED`.
3. Confirm the target Power Platform environment and active CLI identity before connection or data-source mutation.
4. Show the exact connector, connection ownership, actions/data, DLP implications, and mock fallback; get explicit mutation approval.
5. Reuse an approved connection/reference or create one through supported Power Apps CLI commands. Never collect secrets in chat.
6. Add one related connector group per wave and regenerate schemas/services through template commands. Never edit `src/generated/`.
7. Implement connector adapters behind existing domain interfaces. Translate auth, throttling, unavailable, validation, and retryable failures.
8. Keep mock mode selectable and ensure connector failure does not break unrelated workflows.
9. Run schema generation, type-check, relevant bundle/test, and the working app gate. Provide a connector-backed route and safe review action.

Never use raw `fetch`/`axios` for external systems. Do not create or alter Dataverse tables in this stage.