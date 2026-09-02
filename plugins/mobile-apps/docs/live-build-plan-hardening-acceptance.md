# Live Build Plan Hardening Acceptance

Run the deterministic regression matrix from the repository root:

```bash
node plugins/mobile-apps/scripts/run-live-build-plan-acceptance.js
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
- the same IT Dataverse contract with and without explicit offline selection.

These runs exercise four distinct briefs, every persistence mode, and an
offline invariance pair. They do not impose universal screen or table counts.

## Evidence

The output directory contains:

- `acceptance-summary.json`: checks, run matrix, warnings, and execution boundary;
- `persistence-contract-examples.json`: Dataverse, connector-only,
  local-prototype, and mixed examples;
- `navigation-manifest-example.json` and `route-layout-evidence.json`;
- `data-model-usage-example.json`;
- `offline-invariance.json`;
- `commerce-storyboard.html` and `operational-storyboard.html`;
- `timings.json`: local Node.js contract/synthetic-layout timing only.

Contract examples and storyboards are deterministic for identical sources.
Timing values are observations and are intentionally excluded from byte-level
determinism checks. The before value measures the comparable experience/scope/
journey/pack core; the after stages include the hardened contract pipeline.
These workloads differ, so the report does not claim model-time, Dataverse-time,
native startup, or pixel-rendering performance.

## Host Boundary

The committed template proves Dataverse offline package integration. Connector
offline, the connector side of mixed mode, local repository offline behavior,
and generic media-cache adapter entry points remain execution-time capability
checks. The workflow must stop when the installed package version does not
document an approved adapter; it must not invent an API, add another sync
dependency, mirror connector data into Dataverse, or hand-roll a sync engine.