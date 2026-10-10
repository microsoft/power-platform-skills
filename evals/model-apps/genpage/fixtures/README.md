# Genpage replay fixtures

Each subdirectory is a fixture for one eval in `../evals.json`. The Layer 2
runner (`../run-layer-2.js`) grades every `.tsx` in a fixture against the
`common_code_assertions` and the eval's `Phase 5` / `5a` / `5b` / `5c` expectations.
The offline runners do not execute the skill or any logged command.

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
- Layer 1 reads the plans/logs. Layer 2 also receives fixture metadata and can
  inspect declared before/after TSX, worker/API lifecycle and refusal evidence.
- `genpage-entity-creation-log.md` is the current log name; the loader intentionally
  falls back to the historical `entity-creation-log.md` **only when the current file
  is absent**, not when it is empty. An old log must not supply transactions for a fresh run.
- A current synthetic `fixture.json` declares contract version 2, provenance,
  source skill/reference sections, ordered `tool-results.json` and artifact paths.
  Nested snapshots are evidence, not additional generated pages.

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
- `--force` — overwrite a trial fixture; use a **new slug** for a historical capture
- `--skip-verify` — capture only, skip the runner sweep (rare)

Manual fallback if the helper doesn't fit your scenario:

1. `mkdir evals/model-apps/genpage/fixtures/<eval-id>-<slug>/`
2. Copy in `*.tsx`, `*.md`, `RuntimeTypes.ts` from the working dir
3. Skip `package.json`, `genpage.d.ts`, `node_modules/`, `*.log`
4. Run `node ../run-layer-1.js --eval <id>` and `../run-layer-2.js --eval <id>`

## Updating a contract

Do not regenerate historical captures in place. Label their contract in
`contracts.json`, create a new directory under a fresh slug for new evidence,
and register its id in `evals.json`. New contract fixtures here are synthetic
and explicitly say so; they cite current public skill/reference sections.
The capture helper does not collect the new JSON/text transport snapshots,
so structured synthetic evidence is packaged explicitly rather than advertised
as a captured run.

Two rules for evidence files:

- **Byte-compared text is `.txt`.** Prompt, agent-message and page-name files
  are compared byte for byte with `fixture.json`, so `.gitattributes` checks
  every `*.txt` out verbatim; a Windows checkout would otherwise turn LF into CRLF.
- **A deliberately broken page is not a `.tsx`.** The plugin's corpus tests
  require every committed `.tsx` to be a valid page, so store a truncated or
  rejected worker output under another extension (see
  `23-worker-completeness/attempts/truncated.txt`).

## Current state

This directory has **27 fixtures, 34 top-level TSX files and 25 represented
prompt IDs**. All are green under both runners. Directories listed in
`contracts.json` are historical contract-1 evidence; every other directory is a
current contract-2 synthetic. Registered prompts with no fixture:
**none**. `evals/model-apps/tests/eval-coverage-contract.test.js`
fails when these figures, or the reasons recorded for the missing prompts, fall out
of step with the fixtures.

| Fixture | Eval | Source | State | Shape covered |
|---------|-----:|--------|-------|---------------|
| `1-account-card-gallery/` | 1 | Historical synthetic | green | Dataverse single page, click-to-open Xrm.Navigation, window cache |
| `2-mock-dashboard/` | 2 | Historical synthetic (from sample 8) | green | Mock data, D3 charts, no entity work |
| `2-mock-dashboard-real/` | 2 | Historical capture | green | Mock data; historical workflow/transport |
| `4-case-wizard/` | 4 | Historical synthetic | green | Multi-step wizard, two Dataverse entities, dataApi.createRow with @odata.bind |
| `5-kanban-task-board/` | 5 | Historical capture | green | Native HTML5 DnD on `task` |
| `7-job-candidates-new-entities/` | 7 | Historical synthetic | green | New entities + lookup + choice column + sample data + solution selection |
| `11-recruitment-multi-page/` | 11 | Historical synthetic | green | Authored legacy navigation; no current before/after fix-up proof |
| `11-recruitment-pages-real/` | 11 | Historical capture | green | Resolved navigation checked against the capture's deployment map |
| `13-contact-localization/` | 13 | Historical synthetic | green | Localization (en-US / ar-SA / fr-FR), RTL, logical CSS properties |
| `15-support-tickets-real/` | 15 | Historical capture | green | New entity/choices and auth retry |
| `17-weather-mock-data/` | 17 | Historical synthetic | green | Mock weather, no discovery |
| `18-sharepoint-connectors/` | 18 | Historical synthetic | green | Connector-backed source and discovery |
| `19-add-weather-connector/` | 19 | Historical synthetic | green | Add-from-none edit compatibility |
| `10-auth-timeout-halt/` | 10 | Current synthetic | green | Associated timeout results, one retry/advice, halt with no TSX/mutation |
| `20-upload-preservation/` | 20 | Current synthetic | green | Exact create file transport; independent edit read-backs; quote refusal |
| `21-discovery-failure/` | 21 | Current synthetic | green | Unreadable discovery is needs_input, never setup/upload; no generated TSX |
| `22-navigation-contract/` | 22 | Current synthetic | green | Actual before/after source, optional calls/overrides/escaped keys/Unicode terminators, affected-only upload |
| `23-worker-completeness/` | 23 | Current synthetic | green | Failed production gate blocks upload until fresh complete regeneration |
| `24-custom-api-lifecycle/` | 24 | Current synthetic | green | Bound Action/global Function discovery, re-probe, runtime, preserve and clear |
| `25-solution-package/` | 25 | Current synthetic | green | Every deployed page, dynamic component types, app-first writes, read-back and invalid-id refusal |
| `3-contacts-edit-search-sort/` | 3 | Current synthetic | green | Edit flow: discovered app/page, download snapshot in `before/`, inline edit adding SearchBox + header sorting, `--page-id` delta upload without `--add-to-sitemap` |
| `6-traffic-analytics-mock/` | 6 | Current synthetic | green | Clean, minimal mock-data analytics with D3 only; no entity work; upload omits `--data-sources` |
| `8-account-metrics-new-app/` | 8 | Current synthetic | green | Zero apps → create-new-app choice, solution question, `pac model create --solution`, new app-id used for upload |
| `9-project-tracker-new-entities/` | 9 | Current synthetic | green | Two new related tables, auth gate, dependency-ordered provisioning, `$parent`/match sample data, both tables as data sources |
| `12-account-plan-revision/` | 12 | Current synthetic | green | First plan rejected, revised plan re-presented and approved; page has both search box and filter toolbar |
| `14-account-list-edit-collision/` | 14 | Current synthetic | green | Colliding file names refused by the Phase 5a gate, re-plan, two parallel builders, Phase 6.5 navigation fix-up |
| `16-account-list/` | 16 | Current synthetic | green | Minimal single list page over an existing table; code-only, no solution question or auth gate |

Historical captures remain compatibility/parser evidence, not proof of today's
file transport, binding preservation or full skill compliance. Their current
plans already contain the Custom API no-bindings section. Capture-local READMEs
can contain capture-era counts/claims; the inventory above is the current roster.

Expected failures belong in discriminating scorer unit tests, or in an explicit
refusal/recovery trace that satisfies its declared outcome. The corpus is never
permanently red: both full runners must exit 0. Refusal fixtures prove a failed
gate and zero generation/mutations; recovery fixtures retain rejected snapshots
only as nested evidence. Green replay does not mean an agent, TypeScript build,
React UI, live connector/API, hosted upload or solution import was exercised.
