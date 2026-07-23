# Plan (v2) — migrate `/app-builder` to cds-maker-sdk `hardening-2` (no regressions)

> **v2 supersedes v1.** Rewritten after an adversarial architectural review by GPT‑5.6 Sol (max
> effort) against the SDK's mandatory tenets (`specs/architecture-spec.md`, T1–T7). The v1 design was
> **NEEDS REWORK**: its plugin‑side `sdk-forms.js` façade re‑created — one layer up — the exact
> per‑artifact imperative API the SDK deliberately deleted (T2/T7), it violated T4 by pre‑computing
> control `classId`/`label`, and its form‑spike diagnosis was wrong. Three load‑bearing review claims
> were **independently verified** in the SDK source before this rewrite (citations inline).

**Goal:** Swap the vendored SDK to `hardening-2` with **zero user‑visible regression**, re‑expressing
the build engine around the SDK's **canonical desired‑state intent** model so the skill is extensible,
performant, and maintainable — no resurrection of the removed per‑artifact API.

---

## Decisions that stand from v1
- **Update the existing `/app-builder` skill in place — do NOT fork a new skill.** The public contract
  (App Spec JSON + CLI flags + authoring flow) is unchanged; the SDK is plumbing behind a seam.
  `genpage` shares the same seam (`entity-provision.js`), so one migration covers both. Bump plugin
  **2.2.0 → 2.3.0**; App Spec schema unchanged (no user migration).
- **Atomic at release level**, but per the review, *not* one unreviewable source+tests+bundle commit —
  land as a reviewable series that is merged/released together and never leaves `main` half‑swapped.

## The architectural correction (why v1 was wrong)
The SDK's tenets are mandatory (`specs/architecture-spec.md:3-8`):
- **T2/T7** — one canonical, type‑agnostic mutation surface (`findElements/queryTree/diffArtifact/
  updateElement/addElement/moveElement/removeElement`); **no artifact‑specific mutation methods**
  (`addField`, `addDashboardTile`, `setViewColumns`, `setAppDefinition` were deliberately deleted;
  `specs/architecture-spec.md:29-44,154-176`).
- **T4** — mutations express **intent**; the **adapter** applies defaults (resolves `label` from the
  column's display name, derives `classId` from attribute type, mints layout ids). The caller passes
  `{ control: { fieldName } }` (`specs/architecture-spec.md:71-91`).
- **T1/T3** — one canonical hybrid (typed + bag) JSON is the only local state; **no `$meta` raw‑wire
  side‑channel** (`specs/architecture-spec.md:12-25`).
- **T6** — push rebuilds from the model (no baseline GET / id‑matching / scalar overlay).

**v1's façade** (`sdk-forms.js` with `addField`/`addSubGrid`/`setViewColumns`/`setAppSiteMap`) is the
same shape T2 forbids, just moved into the plugin: one method per artifact/control, pointer knowledge
hidden behind imperative ops, duplicated control‑shaping, and a new method per new control. `setViewColumns`
would wrap a single `updateElement('view', id, '/columns', cols)` — no abstraction earned. **Rejected.**

## The v2 seam — a *pure intent compiler* (no SDK calls)
Introduce **`scripts/lib/artifact-intent.js`**: pure functions that translate an App Spec into the SDK's
**canonical desired‑state JSON** and return it. They **do not touch the SDK** (no `createArtifact`/
`addElement`). The build engine then calls the **generic** lifecycle + mutation surface directly.

```
artifact-intent.js (pure; App Spec -> canonical JSON; unit-tested with zero SDK):
  compileFormIntent(specForm, refs) -> FormArtifact-shaped intent (tabs[].columns[].sections[].rows[].cells[])
  fieldCellIntent(logical, { isRequired?, label? })      // { control: { fieldName } } + optional intent
  subgridCellIntent({ relationshipName, targetEntity, viewId, label })
  quickViewCellIntent({ lookupFieldName, targetEntity, quickViewFormId, ... })
  notesSectionIntent()
  formEventsIntent(events[])                              // root bag <events> region intent
  dashboardTileIntent(spec, tile, refs)                  // component intent for /components
  viewColumnsIntent(cols)                                // plain columns array for updateElement('/columns')
  appSiteMapIntent(spec, refs)                            // siteMap + components (already works via appDef)
  // pure JsonPointer + query helpers (no SDK):
  firstSectionRowsPointer(formJson), cellPointerForField(formJson, logical), etc.
```

Engine call sites become generic surface calls, e.g.:
- create a form: `createArtifact('form', minimalFormDef)` then `addElement('form', id, '/tabs/0/columns/0/sections', wholeSectionIntent)` (coarse subtree — see Form Construction), one `pushArtifact`.
- reconcile a view: `updateElement('view', id, '/columns', viewColumnsIntent(mergedCols))`.
- app sitemap edit: `updateElement('app', id, '/siteMap', appSiteMapIntent(...).siteMap)` (+ components).
A single generic engine helper `applyArtifactIntent(sdk, type, id, ops)` is acceptable; per‑artifact
`addField`/`setViewColumns`/`setAppSiteMap` are **not**.

## T4 — do NOT precompute `classId`/`label` (verified)
The adapter derives them: it dedupes controls by entity, does **≤1 metadata fetch per uncached entity**,
and resolves from cache (`MakerSdk.ts:881-891,940-973`); the authoritative test passes only `{ fieldName }`
and asserts the adapter‑derived label + lookup `classId` (`MakerSdk.consolidation.test.ts:324-412`).
**Verified drift risk:** the adapter maps *Dataverse* attribute types (`Lookup/Customer/Owner/Picklist/
State/Status/Boolean/DateTime/Money/Integer/Memo/String…`, `FormAdapter.ts:1299-1327`), which do **not**
match App Spec types (`Choice/MultiChoice/Text/…`). Re‑implementing the map in the plugin would drift and
mis‑render. **Required:** emit `{ control: { fieldName, isRequired? } }`; supply `label` only for an
intentional form‑specific override. Let the adapter default `classId`, `label`, cell/control ids.

## Form construction — corrected diagnosis + the right pattern
**v1's spike diagnosis was wrong.** The `createArtifact('form', def)` failure was **not** missing bags.
`createArtifact` → `createDefault`, which serializes authored `definition.tabs` through `tabToXml`
**before** normalize; that path dereferences `stripBraces(tab.id)`, `stripBraces(section.id)`,
`stripBraces(cell.id)`, `stripBraces(control.classId)` (`FormAdapter.ts:1153-1198`). The engine's
`fieldCell` supplies a cell with **no `id`** (`sdk-build.js:353-356`), so `stripBraces(undefined).replace`
throws — the exact spike error. Bags are minted by projection and are **not** required on input
(`columnToXml` defaults `width` with no bag, `FormAdapter.ts:1163-1166`).

**Preferred target (no shortcut): fix `FormAdapter.createDefault` UPSTREAM** to accept a full deep‑partial
canonical form intent — structurally normalize it (mint tab/column/section/cell/control ids and bags,
defer metadata defaults to push) *before* serializing. This is squarely T4 (adapter defaults opaque
identity). Then the plugin compiles the whole `tabs→columns→sections→rows→cells` tree and does **one
create + one push** — the most performant and most SDK‑aligned path. The SDK is actively being hardened by
us, so this upstream change is in‑scope and preferable to working around it.

**Fallback if the upstream fix is deferred:** create the form minimal, then add the **largest safe
subtree** — a whole tab or section — in **one** `addElement` (it recursively assigns missing ids,
`MakerSdk.ts:669-689`), **not** N per‑field calls, and **not** `updateElement('/tabs', …)` (update does
**not** mint ids, `MakerSdk.ts:652-665`). This matches the SDK's own workflow tests
(`form.workflow.test.ts:44-66,99-128,162-249`).

**Model note (verified):** `FormTab.columns` are vertical containers; `FormSection.columns` is the 1–4
grid‑cells‑per‑row count (`types/form.ts`; `FormAdapter.ts:819-849`). The App Spec exposes the *section*
grid count, so each tab normally compiles to **one** `FormColumn`.

**Performance:** every `addElement` does readRaw → JsonPointer resolve → validate → writeArtifact‑to‑disk →
re‑read (`MakerSdk.ts:676-689`, `WorkspaceManager.ts:182-190`); N per‑field calls trend toward quadratic
traversal + repeated disk I/O as a form grows. One‑tree‑create (preferred) or coarse‑subtree (fallback)
avoids it.

## One canonical form topology (kill the second model)
`formDef` today emits `tabs[].sections[]` (old shape); `form-preview.js` and `formFieldLogicals` read that
shape (`sdk-build.js:427-448`, `form-preview.js:78-105`). Keeping it alongside the SDK's
`tabs[].columns[].sections[]` is a **drift risk** (two form models) and the v1 plan even contradicted
itself (Phase 3 "teach `formDef` the columns layer" vs. final scope "`formDef` unchanged"). **Required:**
refactor `formDef` into the pure **`compileFormIntent`** (emitting the SDK's columns‑layer canonical JSON)
and update `form-preview.js` + `formFieldLogicals` to consume that single tree. Preview stays
SDK‑runtime‑independent (it reads plain JSON), and there is exactly one form topology.

## Reconcile / edit under T1/T6 + idempotency (verified gaps)
Fetch → canonical mutation → push is correct and `$meta` must not return (`MakerSdk.ts:215-224,881-895`).
But two verified gaps:

1. **`addElement` is a blind splice and `removeElement` is intentionally non‑idempotent**
   (`MakerSdk.ts:676-687`, `MakerSdk.consolidation.test.ts:415-428`). Every reconciler therefore needs a
   **declared semantic identity** to avoid duplicating on rebuild:
   - field → bound `fieldName`; subgrid → relationship + target/view; quick view → lookup + quick‑view form;
     event → event + attribute + library + function; tile → stable component identity.
   Existing `<events>` / `<formLibraries>` regions must be **merged**, not appended as duplicate roots.
   For multiple removals, **re‑query after each** removal or remove pointers in **descending index order**
   (array indices shift).
2. **Events pointer:** events live in the **root bag** (`/bag/c`), not `/events`
   (`types/form.ts:29-35`, `form.workflow.test.ts:197-248`). v1's `/events` was wrong.

## Push conflict handling — a real bug to fix (verified)
A 412 does **not** throw; `pushArtifact` returns `{ success:false, error:VersionConflictError }`
(`MakerSdk.ts:927-934`, `form.workflow.test.ts:271-283`). The engine ignores push results on existing
forms/views/apps/events/quick‑views (`sdk-build.js:678-700` and peers), so the runner reports success
because no exception fired (`entity-provision.js:108-120`). **Required (fixes a latent current bug too):**
add a shared **`requireSuccessfulPush(result)`** and route every push through it; on a conflict, **halt and
require a fresh download** (never auto refetch‑and‑overlay — that violates T6).

## `seedRecordGraph` — `matchOn`, with a real uniqueness policy (verified)
`SeedEntityGroup` now exposes only **`matchOn`** (options stay `entitySetFor` + `createdIds`);
runtime dedup happens **only** when `matchOn` is supplied (`types/recordGraph.ts:39-75`,
`RecordGraphApi.ts:40-137`). `buildSeedGroup` (`entity-provision.js:305-358`) is the only production
constructor, but the tests reference the old key too: `entity-provision.test.js:239-245` and
`vendor-sdk-smoke.test.js:294-326` assert/pass `primaryAttribute` — both must change.
**Not a blind rename:** Dataverse **primary names are not guaranteed unique**, so defaulting `matchOn` to
the primary column can wrongly collapse distinct rows. **Required policy:** prefer an explicit sample‑data
key or a declared alternate‑key column; validate every sample record has a non‑empty value for the chosen
key; document any backward‑compatible primary‑name fallback and its risk.

## Test + guard changes
- **Extend the surface scanner** — `sdk-surface-contract.test.js` scans only 3 files
  (`sdk-surface-contract.test.js:113-129`), so SDK calls in a new module would be invisible. Scan all of
  `scripts/lib/*.js` (or the explicit engine set incl. `artifact-intent.js`). Update `SKILL_SDK_SURFACE`
  to the new instance surface (drop the 8 retired names; add `addElement`/`updateElement`/`removeElement`/
  `findElements`/`moveElement` as used).
- **New real‑bundle tests** (against the re‑vendored hardening‑2 bundle): multi‑tab/multi‑section create;
  metadata‑derived control types (pass only `fieldName`, assert adapter classId/label); repeated‑build
  **dedup** (no duplicate fields/subgrids/events on re‑run); event/`formLibraries` **region merge**; field
  **removal**; **412** conflict → `requireSuccessfulPush` halts before publish.
- Update `mockSdk` in `sdk-build.test.js` / `sdk-teardown.test.js` to the new surface; keep the intent
  compiler **fully unit‑tested with zero SDK** (pure functions → fast, deterministic).

## Phased execution (TDD; parity oracle before the swap)
- **P0 — DONE** (committed `c8167f27`): surface‑contract guard + `seedRecordGraph {createdIds}` CONTRACT + AGENTS.md.
- **P1 — Parity oracle on the CURRENT bundle**: lock observable wire output the engine produces today
  (formxml field add/remove, subgrid target/relationship, view `layoutxml` columns, dashboard tile, app
  sitemap subareas/icons, **sample‑data dedup by key**). Runs through the real bundle.
- **P2 — `artifact-intent.js` (pure) + unit tests** (no SDK); compile‑only assertions on canonical JSON.
- **P3 — (preferred) upstream `FormAdapter.createDefault` full‑intent fix + SDK tests**, re‑vendor; else
  adopt the coarse‑subtree fallback.
- **P4 — Rewire the engine** to the generic surface via the intent compiler; `requireSuccessfulPush`;
  `formDef→compileFormIntent`; preview onto the one tree; `buildSeedGroup→matchOn` policy.
- **P5 — Update mocks/surface list/tests**; full suite green; **P1 parity assertions pass unchanged**.
- **P6 — Live e2e**: build → edit (add/remove field, add subgrid, enrich view) → rebuild (no dup rows /
  controls) → teardown to **0 leftovers** on the scratch env (AuroraBAPEnv03468;
  `az account set --subscription 648275e0-…`).
- **P7 — Docs/release**: CHANGELOG, AGENTS.md SDK‑method map, `docs/app-builder-roadmap.md`, 2.3.0.

## Required changes (from the review) — prioritized
**Blocking**
1. Replace the method‑per‑control façade with a **pure App‑Spec→canonical‑intent compiler** + pure
   pointer/query helpers; engine calls the generic surface directly.
2. **Fix `FormAdapter.createDefault` upstream** for full deep‑partial form intent (preferred), or use
   **coarse whole‑tab/section `addElement`** — not N per‑field calls.
3. **Omit `classId`/`label`**; rely on adapter metadata defaulting (pass `{ fieldName, isRequired? }`).
4. **One canonical form tree** serves build, reconcile, field extraction, and preview.
5. **Semantic idempotency + merge** for fields, subgrids, quick views, events, `formLibraries`, tiles.
6. **Events at `/bag/c`**; test region merge + repeated rebuilds.
7. **Check every `PushResult.success`** (`requireSuccessfulPush`); abort before publish on conflict.
8. **`matchOn` policy** (explicit key / alternate key; validate non‑empty; document fallback) + update
   production + `entity-provision.test.js` + `vendor-sdk-smoke.test.js`.
9. **Extend the surface scanner** to all engine files (incl. `artifact-intent.js`).
10. **Real‑bundle tests**: multi‑tab/section create, metadata‑derived control types, repeated‑build dedup,
    event/library merge, field removal, 412 handling.

**Nice‑to‑have**
- Promote notes/subgrid/quick‑view/events to **semantic SDK typed properties** (upstream) so the plugin
  stops constructing wire‑shaped parameter maps.
- **Topologically build quick‑view forms before hosts** so each form is reconciled + pushed once.

## Rollback
The swap lands as a reviewable series merged together; if P6 surfaces a blocker, revert the series. The P0
surface guard + P1 parity oracle remain as the pre‑built net for the retry.

---
*Review artifact: adversarial architectural review by GPT‑5.6 Sol (max effort), 2026‑07‑22. Three
load‑bearing claims (createDefault id‑deref, 412 non‑throw, App‑Spec‑vs‑adapter classId map) independently
verified in SDK source before this rewrite.*
