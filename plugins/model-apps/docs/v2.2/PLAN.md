# Model Apps v2.2 — Planning

Forward-looking work for the `/genpage` skill after v2.1 ships. This branch
isolates the planning from the active v2.1 PR; we'll start execution once
v2.1 is merged.

**Baseline:** v2.1.0 (Node.js Web API scripts, solution selection + prefix
discipline, check-auth pre-flight, ~27K-token perf trim, 10 samples, scope
headers, slim CHANGELOG). All counts and references in this doc assume v2.1
is in place.

---

## P0 — Local-dev ergonomics (the "Three Asks")

Currently, each `/genpage` run produces a working directory with the `.tsx`,
`RuntimeTypes.ts`, the plan, and log files — but no `package.json`, no
declarations for runtime globals (`window.Xrm`, window caches), and no
authoritative version list for the dependencies the generated code relies on.
Opening the page in VSCode means red squiggles everywhere. These three asks
fix that.

### Ask 1 — Documented dependency list with versions

**Problem:** Rules say "use React 17, Fluent UI V9, etc." but doesn't name
versions. The genux runtime ships specific versions; using an API from a newer
version that the runtime doesn't have breaks the page at runtime.

**Deliverable:** `references/supported-dependencies.md` (or YAML/JSON) listing
every package the genux runtime supports with exact versions. Page-builder
reads this and uses it to constrain API choices.

**Blocker — needs upstream work:**
- The version list isn't documented publicly.
- Options to discover:
  - **A.** Ask the genux runtime team for the authoritative list (best).
  - **B.** Sniff a deployed page's runtime bundle to extract package versions
    from sourcemap/headers/UMD globals.
  - **C.** Inspect what PAC CLI's `generate-types` embeds (may include hints).
- Until (A) lands, any version numbers we ship are educated guesses.

**Cost:** 1 hour doc writing + ongoing maintenance once versions are known.

### Ask 2 — Auto-generate `package.json`

**Problem:** Working dir has no manifest, so VSCode treats every import as
unresolved. Developer can't `npm install`, can't `tsc`, can't test locally.

**Deliverable:** Orchestrator (or page-builder) writes a `package.json` to the
working dir with the dependencies from Ask 1. Developer runs `npm install`
once; editor lights up with IntelliSense, "go to definition", type checking.

**Shape:**

```json
{
  "name": "<page-slug>",
  "private": true,
  "type": "module",
  "dependencies": {
    "react": "17.0.2",
    "@fluentui/react-components": "<runtime-version>",
    "@fluentui/react-datepicker-compat": "<runtime-version>",
    "@fluentui/react-timepicker-compat": "<runtime-version>",
    "@fluentui/react-icons": "2.0.326",
    "d3": "<runtime-version>"
  },
  "devDependencies": {
    "typescript": "5.x.x",
    "@types/react": "17.x.x",
    "@types/d3": "7.x.x"
  }
}
```

**Cost:** ~30 min orchestrator change once Ask 1 has the version numbers.

**Open question:** Should `package.json` be regenerated on every run (potential
churn) or only when missing / when versions change? Probably: write once per
working-dir; subsequent runs only update if versions drift.

### Ask 3 — `genpage.d.ts` alongside `RuntimeTypes.ts`

**Problem:** Generated code uses `(window as any).Xrm` and `(window as any).__pp<X>Cache`
because TypeScript has no types for these runtime injections.

**Deliverable:** A `genpage.d.ts` file emitted next to `RuntimeTypes.ts` with:

- `declare global { interface Window { Xrm: XrmShape; ... } }`
- Type for the window-cache key pattern (`__pp<EntityName>Cache`)
- Any genux-specific globals (e.g., custom `Telemetry` or `Logger` if exposed)
- Re-exports tying `GeneratedComponentProps` to the actual injected props

After this lands, `(window as any).Xrm.Navigation.navigateTo(...)` becomes
`window.Xrm.Navigation.navigateTo(...)` with full IntelliSense.

**Cost:** ~2 hours. The Xrm shape is the bulk of the work — there's no
single public Xrm v9 type package that fits the genux subset we use, so we
have to define the slice ourselves.

**Depends on:** Ask 2 (without `package.json`, `@types/react` etc. aren't
available, so even the partial typings don't fully work).

---

## P1 — Hot-path perf trims (deferred from v2.1)

### Extract `## Charts and Visualization` from `rules.md` → `references/d3-charts.md`

~30 lines moved out of the hot path. Page-builder loads it conditionally only
when the plan's Per-Page Specification calls for charts (e.g., when the
`Needs caching: false` page is a dashboard/analytics type).

**Cost:** ~30 min. Same pattern as `data-caching.md` extraction in v2.1.

### Extract `## File Upload` from `rules.md` → `references/file-upload.md`

~30 lines, conditional load when the plan calls for file upload.

**Cost:** ~30 min.

### Trim `genpage-edit-planner.md` (~233 lines today)

Loaded only on edit flow, but could be tighter. Specific candidates:
- Step 2's question list is verbose; could be a 5-line bullet list.
- Step 3's plan-mode preview duplicates structure documented in `plan-schema.md`.

**Cost:** ~30 min.

---

## P1 — Sample coverage gaps

### `11-kanban-with-dnd.tsx`

Eval 5 ("task management board with columns for To Do, In Progress, Done.
Allow dragging tasks between columns") has no working sample. Page-builder
synthesizes the drag-and-drop pattern from scratch every time.

**Pattern:** Native HTML5 DnD (`onDragStart` / `onDragOver` / `onDrop`),
column-grouped DataGrid, `dataApi.updateRow` on drop to write the new status.

**Cost:** ~150 LOC, ~30 min.

### `12-localization-multilingual.tsx`

Eval 13 (Arabic + English + French + RTL) has no working sample.
`references/localization.md` has the full pattern in prose, but a working
reference is much higher-fidelity.

**Cost:** ~200 LOC, ~45 min.

---

## P1 — Script robustness

### Parse `logicalName` from response, don't synthesize

Currently `create-table.js` and `add-column.js` return
`logicalName: schemaName.toLowerCase()`. Works in 100% of smoke tests but
fails the edge case where Dataverse truncates names > 50 chars or normalizes
prefixes unexpectedly.

**Fix:** Add `Prefer: return=representation` to the POST, parse the actual
`LogicalName` from the response body. Fall back to `.toLowerCase()` if the
header isn't honored (older Dataverse versions).

**Cost:** ~20 LOC + test updates. ~20 min.

### N:N intersect name length validation

`create-relationship.js` defaults the N:N intersect to
`${prefix}_${entity1}_${prefix}_${entity2}` (e.g.,
`crb2b_player_crb2b_team`), which can exceed Dataverse's 50-char logical-name
limit for long entity names. Today the create fails with a confusing message.

**Fix:** Validate intersect name length before POST. If >50, suggest a
truncated default and require the user to confirm or override with `--intersect`.

**Cost:** ~30 LOC. ~30 min.

---

## P2 — Testing & automation

### Eval automation

Currently the eval suite is manual (~5-10 min per eval × 16 evals = 1-2 hours
per full run). Doesn't scale — can't run on every PR.

**Goal:** Layer 1 (workflow assertions) + Layer 2 (code assertions) automated;
Layer 3 (UX rubric) stays manual for now.

See `eval-automation.md` in this folder for the detailed design.

**Cost:** ~2 days (sizeable; needs its own subproject).

### Integration tests against a live Dataverse env

The current `node --test` suite covers arg parsing and payload shape but never
hits a real Dataverse env. A nightly job that:

1. Creates a temp solution
2. Runs the full entity-builder flow (table, columns, relationships, records)
3. Verifies everything via Web API GET
4. Cleans up

Would catch the kinds of bugs we hit during v2.1 smoke tests
(`CreateOneToManyRelationship` 404, `IntersectEntitySchemaName` typo).

**Cost:** ~1 day. Needs a dedicated test Dataverse env + CI secrets.

---

## P2 — Documentation

### Architecture diagram

A single-page visual showing: orchestrator → planner → entity-builder /
page-builder / edit-planner, plus the Web API script layer and the plan
document as the contract. Useful for onboarding contributors.

**Cost:** ~1 hour.

### Contributor guide

`plugins/model-apps/CONTRIBUTING.md` covering: how to add a sample, how to add
a rule, how to add an eval, how to add a Web API script. Cross-links to the
existing `AGENTS.md`.

**Cost:** ~1 hour.

---

## Out of scope for v2.2

These were considered and explicitly deferred to v2.3+:

- **Agent file renames** (drop `genpage-` prefix). Cross-plugin namespacing
  convention, big blast radius (every Task invocation, evals, marketplace),
  marginal benefit.
- **Migration tooling** for env-prefix changes (e.g., "rename all new_X to
  crb2b_X"). Real Dataverse limitation — schema names can't be renamed once
  created. Tooling would have to recreate and migrate data. Out of scope.
- **Plan-mode preview restructure** (the `### Solution` cosmetic flag from
  PR review). Cosmetic, low payoff.

---

## Dependencies between items

```
Ask 1 (versions known)
    └─→ Ask 2 (package.json)
            └─→ Ask 3 (genpage.d.ts) — partial fallout from Ask 2

Eval automation (P2)
    └─→ depends on stable v2.1 evals.json structure (which we have)

Integration tests (P2)
    └─→ depends on a dedicated test env (separate setup work)
```

## Estimated total effort

| Tier | Items | Combined effort |
|--|--|--|
| P0 (Three Asks) | Ask 1, 2, 3 | 1 hr + 30 min + 2 hr = **~3.5 hr** (blocked on Ask 1 upstream) |
| P1 (Perf + samples + scripts) | 5 items | **~3 hr** |
| P2 (Testing + docs) | 4 items | **~4 days** |

If the P0 upstream block clears, P0 + P1 is achievable in one focused week.
P2 items are individually sizable; pick one or two per release.

## Open questions

1. **Genux runtime version list** — who owns this on the platform side, and
   what's the cadence of updates? (Blocker for Ask 1.)
2. **Eval automation infrastructure** — host on GitHub Actions or move to an
   Azure DevOps pipeline? Plugin currently has no CI of its own.
3. **Live env tests** — provision a permanent test env or stand up
   ephemeral ones per PR run? Cost and isolation tradeoffs.
4. **Should v2.2 also bump `claude-code` minimum version?** Some of the
   things we'd like to use (e.g., richer hooks) require newer Claude Code.
