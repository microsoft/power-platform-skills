# Data Architecture

The mock app and Dataverse app must implement the same domain contracts.

## Required Layers

```text
screens and feature hooks
        |
domain models + repository interfaces
        |
composition root / repository provider
       / \
mock adapters   Dataverse adapters
                    |
             generated services
```

Recommended project shape:

```text
src/
  domain/
    models/
    repositories/
  data/
    mock/
      fixtures/
      repositories/
    dataverse/
      mappers/
      repositories/
    createRepositories.ts
  features/
  components/
  generated/
```

Follow an equivalent existing local convention when one is already established.

## Repository Contracts

Design operations around user intent, not storage CRUD. Prefer methods such as `listAssignedInspections`, `submitInspection`, and `approveRequest` over a generic untyped repository. Use stable domain IDs, explicit filters, typed create/update inputs, and domain errors.

Screens and feature hooks may import domain contracts and composition hooks. They must not import mock fixtures or generated services directly.

Authorization is backend-enforced for the signed-in account. Do not model personas, duplicate role matrices in the client, or infer permissions from account names. Repository operations expose actionable permission-denied domain errors; screens render the denied outcome while the backend remains authoritative.

## Generated Power Apps Boundary

- Add connection and Dataverse table data sources with supported Power Apps CLI commands approved for the live template.
- Generate interfaces/services through Power Apps CLI and `npm run generate-schemas`; never handwrite or patch generated output.
- Record each command, data-source identity, generated file/type, and adapter consumer in the plan and stage handoff.
- Adapters map generated connection/table interfaces to stable domain repositories. Screens never import generated interfaces directly.

## Mock Data Quality

Mock data must demonstrate the real workflow:

- 8-20 records for primary list entities unless the domain needs another scale;
- coherent relationships and stable deterministic IDs;
- varied statuses, dates, ownership, urgency, and optional fields;
- at least one empty/filter-zero scenario;
- at least one validation or recoverable failure scenario;
- realistic names and concise operational copy, not lorem ipsum;
- simulated latency that is deterministic and short enough for iteration.

Keep fixtures immutable. Repositories maintain session mutations in memory, or in Async Storage only when persistence is an approved requirement.

## Logical To Dataverse Mapping

For each entity, record:

- display, plural, logical, and schema names;
- ownership type;
- primary name column;
- columns with type, required level, maximum length, and default;
- choice values with stable numeric mappings;
- lookups and relationship cardinality;
- alternate keys or uniqueness rules;
- file/image columns and size expectations;
- reuse, extend, or create decision;
- dependency tier.

Discover existing schema before mutation. Prefer reuse when semantics, ownership, lifecycle, and permissions match. Do not reuse a similarly named table with a different business meaning.

## Mapping Boundary

Dataverse adapters convert generated records into domain models. Keep these details out of screens:

- logical and entity-set names;
- lookup navigation properties and bind syntax;
- generated choice representations;
- nullable generated fields;
- paging/filter option shapes;
- create/update payload differences;
- connector error shapes.

Translate connector failures into actionable domain errors such as unavailable, unauthorized, conflict, validation, or retryable failure.

## Promotion Parity

Use the same acceptance scenarios in both modes. Compare:

- list ordering and filters;
- detail field display;
- required and optional form behavior;
- choice and lookup values;
- create/update outcomes;
- empty and error states;
- permission-denied behavior;
- attachment/image behavior when applicable.

Promotion is complete only when the workflow outcome matches, not merely when TypeScript compiles.