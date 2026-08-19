---
name: dataverse-schema
description: "Use to run Stage 7 of the mobile app journey: after native and connector stages, discover and create or reuse the approved Dataverse schema in dependency tiers, generate services, and keep the app working in mock mode for review."
argument-hint: "Promote the approved logical model to Dataverse"
user-invocable: true
---

# Mobile App Dataverse Schema

Own Dataverse discovery, schema promotion, and generated service refresh. Do not switch screens to Dataverse yet.

Read [stage-contract.md](../create-mobile-app/references/stage-contract.md), [data-architecture.md](../create-mobile-app/references/data-architecture.md), and [template-contract.md](../create-mobile-app/references/template-contract.md).

## Procedure

1. Require Native Capabilities and Connections to be `complete` or validly `not-required`.
2. Dataverse is the required production backend. Verify environment, solution, publisher prefix, active Power Apps CLI identity, and schema permissions; return `NEEDS_INPUT` or `BLOCKED` when unavailable rather than marking the stage `not-required`.
3. Discover existing tables and compare semantics, ownership, lifecycle, columns, and relationships before choosing reuse, extend, or create.
4. Show the exact promotion summary and rollback limitations; require explicit approval before mutation.
5. Process one dependency tier per wave. Record table/column/relationship IDs and logical names immediately for idempotent resume.
6. Add table data sources and generate interfaces/services using supported Power Apps CLI commands from the approved generation manifest, then run `npm run generate-schemas`. Record commands and generated types; never hand-edit output.
7. Keep repository composition in mock mode. Run type-check, relevant generation checks, and the working app gate against the approved mock workflows.

On partial failure, record the exact tier and created resources, preserve mock mode, and return `BLOCKED`. Adapter integration belongs only to the next stage.