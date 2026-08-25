# Mobile Prototype PR1 Planner Contraction

Status: Implemented design record
Workflow: `/create-mobile-prototype`
Scope: Planner contraction and deterministic final-plan compilation only

## Goal

The prototype planner returns one compact, semantically complete JSON object.
It does not emit the final version-3 bundle, repeated Markdown, copied
foreground contracts, hashes, foundation boilerplate, final routes/files, or a
final Navigation Contract.

Product judgment remains model-owned. Mechanical shape, revisions, route/file
materialization, final Navigation, Markdown, validation, and persistence are
foreground-owned and deterministic.

## Mandatory Execution Order

After the planner returns, the workflow uses one order:

```text
validate semantic response
-> compile draft bundle
-> resolve Navigation
-> render Markdown
-> validate semantic preservation against the final bundle
-> validate complete bundle
-> atomically write all artifacts
```

The executable owner is `scripts/finalize-prototype-plan.js`.

1. `stage-prototype-planner-response.js` validates and stages the semantic
   response.
2. `compile-prototype-plan-bundle.js` compiles a draft version-3 bundle with
   `navigationContract: null` and no plan Markdown.
3. `resolve-navigation-contract.js` compiles final Navigation from
   `navigationIntent` plus the preliminary Screen Graph.
4. `render-native-prototype-plan.js` renders deterministic Markdown and the four
   compatibility section objects.
5. `validate-prototype-semantic-preservation.js` compares protected semantic
   paths with their final destinations.
6. `validate-plan-artifact-bundle.js` validates the complete final bundle.
7. `write-plan-artifact-bundle.js` writes the existing artifacts and PR1
   preservation evidence through one rollback-safe transaction.

## Planner Contract

`agents/native-app-planner.md` is the prototype semantic planner.

- `tools: []`
- One normal planner call
- All required inputs supplied inline
- Raw JSON response only
- Hard response ceiling: 256 KiB
- At most one schema-focused repair
- No conversational reconstruction

The existing real/connector planner behavior is preserved under
`agents/real-app-planner.md`; `/create-mobile-app` invokes that compatibility
agent.

The request contains:

- confirmed brief;
- validated Experience Contract;
- validated Context Enrichment Contract;
- validated Workflow Journey Contract;
- execution preflight and template capability facts;
- compiler-owned exact revisions and projections;
- the complete semantic response schema;
- explicit prohibition on final Navigation and external mutation.

The response validates against
`scripts/schema-prototype-semantic-plan.json` and contains exactly:

```json
{
  "schemaVersion": 1,
  "kind": "prototype-semantic-plan",
  "domain": {},
  "screens": {},
  "requirementBindings": [],
  "capabilitySelections": [],
  "connectorIntentBindings": [],
  "designIntent": {},
  "navigationIntent": {},
  "assumptions": [],
  "warnings": []
}
```

## Semantic Ownership

Compact does not mean summary-only. The semantic plan remains sufficient to
compile existing validator-compatible artifacts without inventing UX or domain
behavior.

The planner owns:

- typed entities, fields, constraints, relationships, cardinality, delete
  behavior, and choices;
- domain operations, repository/method/hook boundaries, reads, writes, and
  failure states;
- actors, UX permissions, offline requirements, pending-sync behavior, and
  resume behavior;
- realistic connected fixtures and populated/loading/empty/error/offline/edge
  scenarios;
- screen purpose and outcome;
- presentation pattern, density, hierarchy, regions, first-viewport focal point,
  and region budget;
- primary action ID, label, placement, operation/navigation binding, and
  double-tap policy;
- runtime states and recovery;
- signature components and test IDs;
- media role, aspect ratio, coverage, fallback, prominence, and alt-text
  binding;
- screen operations, filters, sorting, pagination, route bindings, and
  relationship bindings;
- semantic route segments and immediate parent-screen intent;
- capability/connector selections and requirement ownership;
- design and Navigation intent.

The deterministic compiler owns only:

- exact hashes and revisions;
- final route and file strings from semantic path segments;
- copied foreground Context and Journey authorities;
- foreground-derived Foundation identities;
- preflight support metadata and execution wrappers;
- final Navigation;
- Markdown and compatibility sections;
- source-to-target preservation mappings;
- atomic persistence.

The compiler must not invent generic dashboards, CRUD trios, primary actions,
media substitutions, signature components, operations, joins, fixture content,
or visual defaults.

## Design Intent

`designIntent` preserves:

- `visualCharacter`;
- `informationHierarchy`;
- `density`;
- `typographyIntent`;
- `colorBehavior`;
- `shapeAndElevation`;
- `mediaStrategy`;
- `signatureComponents`;
- `motionIntent`;
- `accessibilityIntent`;
- rationale and content tone.

Primary Context and primary signature values already owned by foreground
contracts use explicit source references instead of planner repetition.

## Navigation Intent

The planner never emits final Navigation. `navigationIntent` contains:

- primary destination screen;
- durable destinations with labels, icon intent, and optional badge binding;
- revisit frequency, preserved state, cross-session value, and evidence;
- linear, independent, or mixed job structure with evidence;
- tabs-stack recommendation and rationale;
- nested-screen tab visibility;
- stack-only evidence when tabs-stack is not recommended.

The Navigation resolver deterministically compiles Stack, Tabs + Stack, or
Drawer from this intent and the preliminary Screen Graph. It owns final
destination IDs, routes, flow ownership, adaptive presentation, global route
policy, and accessibility metadata.

## Transport and Repair

`prepare-prototype-planner-request.js` creates the normal inline request.
`stage-prototype-planner-response.js` rejects:

- responses over 256 KiB;
- invalid UTF-8 or JSON;
- prose or Markdown wrappers;
- unknown root keys;
- copied final contracts and bundle boilerplate;
- hashes/revisions owned by the foreground;
- final Navigation;
- output paths, commands, approval state, or mutation instructions;
- Dataverse/environment identity;
- invalid semantic references.

Transport evidence records request/response SHA-256, byte sizes, attempt count,
repair count, and error category.

After one failed normal attempt,
`prepare-prototype-planner-repair.js` builds the only repair request from:

- the exact original inline request;
- the exact invalid response;
- the concise recorded errors;
- restrictions to correct only those errors and return raw JSON.

A second invalid response is terminal.

## Preservation Gate

The preservation report is written to:

```text
.tmp/prototype-semantic-preservation.json
```

The deterministic source-to-target map is written to:

```text
.tmp/prototype-semantic-map.json
```

The gate emits source and target paths for missing or changed protected values.
It covers:

- hierarchy and first-viewport decisions;
- actions and double-tap behavior;
- runtime states and recovery;
- signatures and test IDs;
- media behavior and alt-text binding;
- operations and route bindings;
- relationships and delete behavior;
- fixture content and scenarios;
- design rationale and visual character;
- immediate route parentage;
- durable destinations, revisit evidence, tabs recommendation, nested tab
  visibility, and stack-only evidence.

The gate also rerenders Markdown and requires byte-identical output.

## Golden Fixtures

Two independent fixtures live under:

```text
scripts/tests/fixtures/prototype-semantic/
```

### ICRC Receiving

`icrc-receiving.json` has seven screens and exercises:

- five ordered Journey stages;
- neutral receiving entities and connected fixtures;
- relationship cardinality and delete behavior;
- offline draft/resume and pending-sync semantics;
- reads, updates, confirmation, completion, and failure states;
- barcode-scanner and one-shot location capability selection;
- durable Receiving, Drafts, and History destinations;
- nested stage screens and modal confirmation.

Its semantic response is independently below 256 KiB.

### Flight Shop

`flight-shop.json` exercises:

- media-rich onboard discovery;
- cached CDN media with bundled fallbacks and domain alt text;
- editorial visual hierarchy and product inspection;
- categories, bag continuity, and local order review;
- realistic products, prices, availability, inventory, gallery media, and cart
  content;
- expanded design intent and signature components;
- durable Shop, Categories, and Bag destinations with nested product/review
  flows.

Its semantic response is independently below 256 KiB.

Both fixtures compile through the complete required order, resolve to
Tabs + Stack, pass path-level semantic preservation, pass the existing complete
bundle validator, and produce byte-stable Markdown.

## Compatibility

Final filenames remain unchanged:

```text
native-app-plan.md
.tmp/context-enrichment-contract.json
.tmp/workflow-journey-contract.json
.tmp/navigation-contract.json
.tmp/prototype-domain-model.json
.tmp/experience-screen-contract.json
.tmp/experience-foundation-contract.json
.tmp/mobile-plan-execution-contract.json
```

Prototype mode keeps `.tmp/dataverse-schema-contract.json` absent. The
foreground remains the sole writer. Prototype approval remains local and cannot
authorize external mutation.

Lifecycle validation binds the semantic plan and preservation report hashes
when present.

## Explicitly Out of Scope

This PR does not change:

- screen-builder transport or lanes;
- Metro ownership, process reuse, or retry behavior;
- phase controllers;
- validation fingerprint manifests;
- host adapters;
- design-system dispatch or HTML galleries;
- editable plan HTML or plan servers;
- generic auth/client-ID architecture;
- prototype-to-real behavior;
- real-app planning behavior beyond the compatibility agent name.
