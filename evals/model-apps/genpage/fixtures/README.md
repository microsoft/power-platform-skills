# Layer 2 fixtures

Each subdirectory is a fixture for one eval in `../evals.json`. The Layer 2
runner (`../run-layer-2.js`) grades every `.tsx` in a fixture against the
`common_code_assertions` and the eval's `Phase 5 (Page Builder):` /
`Phase 5b:` expectations.

## Layout

```
fixtures/
  2-mock-dashboard/            ← fixture for eval id 2
    dashboard.tsx              ← generated page output
  7-jobs-list/                 ← fixture for eval id 7
    candidates.tsx
    job-requisitions.tsx
  11-recruitment-app/          ← multi-page fixture for eval id 11
    candidate-list.tsx
    interview-schedule.tsx
    hiring-metrics.tsx
```

**Folder name format:** `<eval-id>` or `<eval-id>-<kebab-slug>`. The leading
digits are parsed as the eval id; the slug is purely cosmetic.

**Included files:**
- All `.tsx` files in the fixture root are checked.
- A file literally named `RuntimeTypes.ts` (or `.tsx`) is excluded — it's
  schema, not generated output.
- `workflow-log.md`, `genpage-plan.md`, `entity-creation-log.md` are ignored
  by Layer 2 (Layer 1 will read them).

## How to capture a real fixture from /genpage

The plugin ships a capture helper that copies the right files (excluding
local-dev scaffolding) and runs both layers immediately:

```bash
node plugins/model-apps/scripts/capture-fixture.js \
  --working-dir /path/to/genpage/working-dir \
  --eval <id> \
  --slug <kebab-slug>
```

The script:
- Copies `*.tsx`, `*.md` files, and `RuntimeTypes.ts` into
  `fixtures/<eval-id>-<slug>/`
- **Skips** `package.json` and `genpage.d.ts` (Phase 0.5 scaffolding that
  the agent didn't produce), `node_modules/`, `dist/`, `*.log`, OS noise
- Runs Layer 1 and Layer 2 against the new fixture
- Prints a JSON summary with copied files + pass/fail counts + the specific
  failing assertions for triage

Flags:
- `--force` — overwrite an existing fixture (use when re-capturing after
  agent changes)
- `--skip-verify` — capture only, skip the runner sweep (rare)

Manual fallback if the helper doesn't fit your scenario:

1. `mkdir evals/model-apps/genpage/fixtures/<eval-id>-<slug>/`
2. Copy in `*.tsx`, `*.md`, `RuntimeTypes.ts` from the working dir
3. Skip `package.json`, `genpage.d.ts`, `node_modules/`, `*.log`
4. Run `node ../run-layer-1.js --eval <id>` and `../run-layer-2.js --eval <id>`

## How to regenerate fixtures

When the page-builder rules change, expected outputs change too. Bulk
regeneration:

1. Run all evals against the new agent.
2. Replace fixture contents wholesale (no incremental diffs — the agent
   may legitimately restructure the file).
3. Run `node run-layer-2.js` and confirm all fixtures pass.
4. Commit the regeneration as a single PR titled
   `Regenerate Layer 2 fixtures for <rule version>`.

## Current state

This directory ships with 10 fixtures — 6 synthetic (hand-built, v2.2-compliant)
and 4 real captures (3 from claude-sonnet-4-6 sessions under the v2.2 plugin):

| Fixture | Eval | Source | State | Shape covered |
|---------|-----:|--------|-------|---------------|
| `1-account-card-gallery/` | 1 | Synthetic | green | Dataverse single page, click-to-open Xrm.Navigation, window cache |
| `2-mock-dashboard/` | 2 | Synthetic (from sample 8) | green | Mock data, D3 charts, no entity work |
| `2-mock-dashboard-real/` | 2 | Real capture (2026-05-20, pre-v2.2-spec) | red | Mock data — pre-spec-tightening capture; known workflow-log compactness gaps |
| `4-case-wizard/` | 4 | Synthetic | green | Multi-step wizard, two Dataverse entities, dataApi.createRow with @odata.bind |
| `5-kanban-task-board/` | 5 | Real capture (2026-05-21, pre-v2.2-spec) | mostly green | Native HTML5 DnD on `task` entity — Layer 2 fully green; Layer 1 pre-spec workflow-log gaps |
| `7-job-candidates-new-entities/` | 7 | Synthetic | green | New entities + lookup + choice column + sample data + solution selection |
| `11-recruitment-multi-page/` | 11 | Synthetic | green | Multi-page (3 pages), parallel page-builder dispatch, PAGEREF cross-nav, Phase 6.5 resolution |
| `11-recruitment-pages-real/` | 11 | Real capture (2026-05-21, v2.2-spec) | **green** | Same shape as synthetic — first real capture validated under tightened spec |
| `13-contact-localization/` | 13 | Synthetic | green | Localization (en-US / ar-SA / fr-FR), RTL, logical CSS properties |
| `15-support-tickets-real/` | 15 | Real capture (2026-05-26, v2.2-spec) | **green** | New entity + choice columns + sample data + check-auth retry flow |

**Synthetic fixtures** are hand-built to be v2.2-compliant — they exercise
the relevant code paths and serve as green-path regression tests for the
runners. All Layer 1 + Layer 2 assertions pass or skip.

**Real captures** validate the runners against actual `/genpage` output:

- The two **green real captures** (eval 11, eval 15) were captured after the
  v2.2 planner-spec tightening landed. Both layers exit 0 against them.
- The two **red real captures** (eval 2, eval 5) were captured before the
  spec tightening propagated to the agent's session. They have known
  workflow-log compactness gaps documented in their fixture READMEs; they
  go green when re-captured under the tightened spec.

The mix gives a green-path regression test (synthetic) + a drift-detection
example (red real captures) + proof-of-life that the v2.2 spec produces
green output (green real captures).
