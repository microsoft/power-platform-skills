# Live Build Plan Hardening Acceptance

Run the deterministic regression matrix from the repository root:

```bash
node plugins/mobile-apps/scripts/tests/helpers/run-live-build-plan-acceptance.js
```

By default, evidence is written to
`.tmp/mobile-hardening-acceptance/`. Use `--output-dir <path>` to select another
temporary location. The runner never starts Metro, launches Dev Player, invokes
Dataverse, or captures native screenshots.

## Matrix

The runner covers:

- in-flight commerce with connector-owned application data;
- humanitarian receiving with Dataverse and explicit offline integration;
- multi-site gym maintenance with mixed Dataverse/connector ownership;
- IT inventory with local-prototype and Dataverse ownership;
- field dispatch with an explicit connector-only system of record and no
    Dataverse planning or execution;
- the same IT Dataverse contract with and without explicit offline selection.

These runs exercise five distinct briefs, every persistence mode, and an
offline invariance pair. They do not impose universal screen or table counts.
The flight, gym, and humanitarian runner outputs prove semantic screen
selection, media binding, navigation, and canonical scenario projection. They
are deliberately neutral structural storyboards, not final design output.
`/preview-screens` validates and opens an existing model-authored final preview;
only when none exists may it run this structural renderer into a separately
named diagnostic file.

Final-preview coverage is separate. Supplied model-output fixtures exercise an
editorial flight-merchandise runway, an equipment identity/scan/maintenance
surface, and a dense receiving/quantity/inspection-handoff ledger. All three
must pass `validate-product-experience-preview.js` against their canonical
screen selection, navigation, actions, scenario values, token CSS, signature
intent, states, media keys, landmarks, and complete graph. Tests also assert
that their compositions differ materially rather than by title or palette.

## Evidence

The output directory contains:

- `acceptance-summary.json`: checks, run matrix, warnings, and execution boundary;
- `persistence-contract-examples.json`: Dataverse, connector-only,
  local-prototype, and mixed examples;
- `navigation-manifest-example.json` and `route-layout-evidence.json`;
- `data-model-usage-example.json`;
- `offline-invariance.json`;
- `commerce-structural-storyboard.html`, `gym-structural-storyboard.html`, and
    `operational-structural-storyboard.html`;
- `timings.json`: local Node.js contract/synthetic-layout timing only.

Contract examples and structural storyboards are deterministic for identical
sources.
Timing values are observations and are intentionally excluded from byte-level
determinism checks. The before value measures the comparable experience/scope/
journey/pack core; the after stages include the hardened contract pipeline.
These workloads differ, so the report does not claim model-time, Dataverse-time,
native startup, or pixel-rendering performance.

The deterministic runner proves compiler, binding, validation, and structural
projection behavior. The supplied final HTML fixtures prove validator coverage,
not model quality. A release-quality model comparison requires separate prompts
against the installed plugin and human review of requirement coverage, product
judgment, and native implementation fidelity.

For streamed Copilot CLI acceptance, audit each JSONL transcript before treating
the model output as evidence:

```bash
node plugins/mobile-apps/scripts/tests/helpers/audit-final-preview-live-log.js \
    --input <copilot-output.jsonl>
```

The audit fails for direct test/fixture/snapshot/benchmark reads and for broader
searches whose returned results expose those paths. Prompt prose alone does not
count as a read.

Classify the complete design reference library without loading it into the
automatic route:

```bash
node plugins/mobile-apps/scripts/design-reference-reachability.js
```

Only `genuinely-unreachable` entries are deletion candidates. Missing explicit
optional-mode references are warnings and never block automatic generation.

## Host Boundary

The committed template proves Dataverse offline package integration. Connector
offline, the connector side of mixed mode, local repository offline behavior,
and generic media-cache adapter entry points remain execution-time capability
checks. The workflow must stop when the installed package version does not
document an approved adapter; it must not invent an API, add another sync
dependency, mirror connector data into Dataverse, or hand-roll a sync engine.