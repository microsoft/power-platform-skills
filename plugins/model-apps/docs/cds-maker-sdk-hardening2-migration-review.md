# Architectural review — cds-maker-sdk `hardening-2` migration plan

> Reviewer: GPT-5.6 Sol (max reasoning effort), adversarial architectural review against the SDK's
> MANDATORY tenets (`cds-maker-sdk/specs/architecture-spec.md`, T1–T7). Every material claim below was
> independently re-verified against the SDK/plugin source before the plan was rewritten to v2. This
> file is the durable record of *why* the v2 plan looks the way it does.

**Verdict: NEEDS REWORK** (of the implementation design — the migration strategy itself is sound:
update `/app-builder` in place, keep the App Spec backward-compatible, bump 2.3.0, validate against the
real bundle).

## The core problem — the façade re-creates the deleted per-artifact API (T2/T7)

The v1 plan proposed a plugin-side `sdk-forms.js` façade exposing `addField` / `removeField` /
`addSubGrid` / `addQuickView` / `wireFormEvents` / `addDashboardTile` / `setViewColumns` /
`setAppSiteMap`. Those are the **exact** artifact-specific mutators hardening-2 deliberately removed
(T2 forbids them by name; T7 enforces a closed public surface). A plugin-private module doesn't enlarge
`MakerSdk`, but it resurrects the same anti-pattern one layer up: one method per artifact/control,
pointer knowledge hidden behind imperative ops, duplicated control-shaping/defaulting, and a new method
required for every new control. `setViewColumns` (a one-line wrap of `updateElement('view',id,'/columns')`)
is the clearest tell. The comparison to `enrichDefaultViews` is false — that method is a multi-op
*orchestration* (discover → fetch/update/push each → one publish) that still uses `updateElement` as its
structural primitive.

**Correct seam:** a *pure* App-Spec → canonical-intent **compiler** (returns desired-state JSON, does
NOT call the SDK) + small pure pointer/query helpers. The engine then calls the generic
`createArtifact` / `addElement` / `updateElement` / `removeElement` / `findElements` directly.

## Verified findings (file:line evidence)

1. **T2/T7 — helpers retired + enforced.** `architecture-spec.md:29-44,154-176`; the SDK's closed-surface
   allowlist test asserts the removals (`MakerSdk.surface.test.ts`).

2. **My form-spike diagnosis was WRONG (this changes the fix).** The `createArtifact('form', richDef)`
   failure was **not** missing bags — it's missing **layout IDs**. `createArtifact → createDefault`
   serializes authored tabs via `tabToXml` **before** `assignMissingIds`, and `tabToXml→sectionToXml→
   cellToXml→controlToXml` all call `stripBraces(id/classId)` on values `formDef` never supplies
   (`FormAdapter.ts:1152-1198`; `formDef` at `sdk-build.js:353-424` supplies no cell/section ids). The
   `.replace` crash is `stripBraces(undefined)`. Bags are minted by projection — never hand-authored.
   **Contrast:** `addElement` calls `assignMissingIds(type, cloneJson(element))` **first**
   (`MakerSdk.ts:684`), so a coarse subtree (whole tab/section, cells omitting ids) succeeds — the ids
   get minted. That's the adapter-blessed authoring path.

3. **T4 — do NOT precompute classId/label in the plugin.** The adapter derives them from **Dataverse
   attribute types** (`Picklist/State/Lookup/Customer/Owner/Memo/String/…`, `FormAdapter.ts:1298-1327`,
   `classIdForAttributeType`), which are NOT App Spec types (`Choice/Text/…`). Reimplementing the map in
   the plugin will drift and mis-render controls. The authoritative test passes only `{ fieldName }` and
   asserts adapter-derived label + lookup classId (`MakerSdk.consolidation.test.ts` "binding a field via
   the canonical surface"). The "perf win" is also overstated: the adapter already dedups metadata to
   ≤1 fetch per uncached entity (`MakerSdk.ts:881-891,940-973`). **Emit `{ control: { fieldName,
   isRequired? } }`;** supply `label` only for an intentional form-specific override.

4. **412 conflicts do NOT throw (latent bug, present today).** `pushArtifact` returns
   `{ success:false, error:VersionConflictError }` on 412 (`MakerSdk.ts:927-934`;
   `form.workflow.test.ts:271-283`). The engine ignores push results on existing forms/views/apps/events
   (e.g. `sdk-build.js:678-700`), and the runner reports success because nothing threw
   (`entity-provision.js:108-120`). **Add a shared `requireSuccessfulPush` and route every push through
   it**; on conflict, halt and require a fresh download (no auto refetch-overlay — that violates T6).

5. **Events author at `/bag/c`, not `/events`.** Root-bag child `{ i, node:{ n:'events', a:[], c:[…] } }`
   (`types/form.ts:29-35`; `form.workflow.test.ts:197-248`); the adapter mints `handlerUniqueId` at
   serialize. Existing `<events>`/`<formLibraries>` regions must be **merged**, not appended as duplicate
   roots.

6. **Non-idempotent mutators → reconcile needs declared semantic identity.** `addElement` is a blind
   splice; `removeElement` is intentionally non-idempotent (`MakerSdk.ts:676-687`;
   `MakerSdk.consolidation.test.ts` removal test). Every reconciled control needs a semantic key (field:
   bound name; subgrid: relationship+view/target; quick-view: lookup+form; event: event+attr+lib+fn;
   tile: stable component id) or rebuilds duplicate controls. For multiple removals, re-query after each
   or remove in **descending index order** (array indices shift).

7. **`seedRecordGraph`: `primaryAttribute`→`matchOn`, + uniqueness policy.** `SeedEntityGroup` exposes
   only `matchOn`; dedup runs only when supplied (`types/recordGraph.ts:39-75`;
   `RecordGraphApi.ts:40-137`). `buildSeedGroup` is the only production constructor
   (`entity-provision.js:305-358`), **but** `entity-provision.test.js:239-245` and
   `vendor-sdk-smoke.test.js:294-326` also pass `primaryAttribute` and must change. **Policy concern:**
   Dataverse primary names aren't guaranteed unique — define the dedup key explicitly (prefer an explicit
   sample-data key / declared alternate-key column; validate non-empty; document any primary-name
   fallback).

8. **`formDef` should not remain a second form topology.** Engine uses `tabs[].sections[]`; SDK uses
   `tabs[].columns[].sections[]`; preview + field-extraction know the old shape
   (`form-preview.js:78-105`, `sdk-build.js:427-448`). Keeping both is drift risk. Refactor `formDef`
   into the pure canonical-intent compiler and point preview + `formFieldLogicals` at that one tree. (The
   v1 plan was also internally contradictory: Phase 3 "teach formDef the columns layer" vs. final scope
   "formDef unchanged".)

9. **Surface scanner blind spot.** `sdk-surface-contract.test.js` scans only 3 files
   (`sdk-build.js`/`sdk-teardown.js`/`entity-provision.js`), so SDK calls in a new module (e.g. the
   compiler/port) are invisible to the guard. Extend the scanned set.

10. **Reconcile flow itself is correct under T1/T6.** fetch writes one canonical projection + etag
    snapshot (`MakerSdk.ts:215-224`); push rebuilds from the model, no baseline GET
    (`MakerSdk.ts:881-895`). `$meta.formxml` must NOT return. `findElements` + generic add/remove is the
    right replacement. App sitemap PATCH already keys on the sitemap row's etag
    (`app.workflow.test.ts:220-245`).

## Blocking changes (must land)
1. Replace the method-per-control façade with a **pure App-Spec→canonical-intent compiler** + pure
   pointer/query helpers; engine calls generic mutation methods. A single generic `applyArtifactIntent`
   port is acceptable; `addField`/`setViewColumns`/`setAppSiteMap` are not.
2. Build forms via `createArtifact('form', minimal)` then **coarse `addElement` of whole tabs/sections**
   (ids minted) + one `push` — not N per-field calls. (Stretch/upstream: fix `FormAdapter.createDefault`
   to accept a full deep-partial form intent so it's one create+push; see nice-to-haves.)
3. Omit `classId`/`label`; rely on adapter metadata defaulting (T4).
4. One canonical form tree serves build, reconcile, field-extraction, and preview.
5. Define semantic idempotency + merge behavior for fields, subgrids, quick-views, events, libraries,
   tiles.
6. Events → `/bag/c`; test existing-region merge + repeated rebuilds.
7. Check every `PushResult.success`; abort before publish on conflict (`requireSuccessfulPush`).
8. Define a valid `matchOn` policy; update production + unit + real-bundle fixtures.
9. Extend the surface scanner to the new module(s).
10. Add real-bundle tests: multi-tab/section creation, metadata-derived control types, repeated-build
    dedup, event/library merge, field removal, 412 handling.

## Nice-to-have (not blocking)
- Promote notes/subgrid/quick-view/events into semantic **SDK typed properties** so the plugin stops
  hand-building wire-shaped parameter maps (a cross-repo SDK change — the cleanest long-term home).
- Fix `FormAdapter.createDefault` upstream to accept full deep-partial form intent (one create+push).
- Topologically build quick-view forms before hosts (each form reconciled+pushed once).
- Keep the migration atomic at **merge/release** level, but it need not be one unreviewable
  source+tests+bundle commit — a reviewable series that only *enables* the swap at the end is fine.

**Bottom line:** keep the in-place migration; redesign the implementation around **canonical
desired-state intent** rather than resurrecting the deleted per-artifact API.
