# `--changed-only` safe partial apply — design (Sol-approved, 7 review rounds)

Status: **safe-to-implement** (adversarial design review by GPT-5.6 Sol, 7 rounds: v1 *unsafe* →
v7 *safe-to-implement*). This is the canonical spec for the multi-deliverable build; the round-by-round
history lives in the session workspace (`design-changed-only-v1..v7.md`).

## Why this is hard
`/app-builder`'s build engine is **ADDITIVE, not convergent**: existing chart/command/dashboard defs and
web-resource CONTENT are *skipped* on rebuild (`sdk-build.js:685-695,985-996,1114-1153`), and the I1 gate
(`build-model-app.js:149-158`) forbids partial `--apply` because `result.created` (the artifact-id map)
is per-invocation and phases read each other's ids from it. So a naive "run only changed phases" would
silently **bless edits that never deployed**. The whole design is therefore **fail-closed**.

## Core invariant (replaces I1)
A partial `--apply` is allowed ONLY via `--changed-only`, and ONLY when: an identity-validated snapshot
exists with `eligible:true` and **empty debt**; every consumed id re-resolves live by semantic identity;
the diff is a subset of the four PROVEN-CONVERGENT shapes; no sitemap drift; and — after the apply — an
EXACT projection verifier proves each touched artifact's deployed state equals the spec. **Every**
state-changing op (full apply, fast apply, teardown) first atomically writes `eligible:false`
(write-before-mutate) and aborts if that guard write fails. `eligible:true` is reached again ONLY via a
verified fast run or a proven-fresh/rebaseline full build with empty debt. Anything not provably safe ⇒
full build / HALT.

## The four convergent shapes (the ONLY fast-path edits in v1)
1. **page** — `.tsx` byte change to an EXISTING page, unchanged key→pageId map (re-upload only, sitemap
   write skipped).
2. **form (explicit layout)** — field-set add(first-section)/remove, placement-exact (all other tab/
   section/cell/isRequired/events/quickView/autoSubgrids/subgrid identical).
3. **view** — pure APPEND of columns (no width/order/filter/sort/removal); default-view enrichment
   suppressed.
4. **app-shell sitemap** — structural sitemap change only (app.description/icon excluded).
Additions of NEW top-level artifacts, removals, and charts/commands/dashboards/web-resource-content/AI ⇒
full build, and they incur sticky **debt**.

## Snapshot envelope (`<workspace>/apply-snapshot.json`, schema 3, atomic)
`{ schema, orgId (live WhoAmI), envUrl, appUniqueName, appId, solutionUniqueName, generation (uuid),
eligible (bool), debt:[{artifactType,identity,reason}], priorSpec (canonical, no rows), expectedSitemap
(normalized projection), artifacts:{ pages:{key:{pageId,sourceSha,deployedSha}}, forms:{entity|formType|
name:{formId,projSha}}, views:{entity|name:{viewId,projSha}}, app:{sitemapSha}, webResources, entities,
charts, commands, dashboards } }`. Written temp→fsync→rename, under one build-wide lease + generation CAS,
ONLY after effective success (apply+verify).

## Eligibility state machine (durable, fail-closed)
- **INVALIDATE (→false) before any write** of every full/unsupported/fast apply and teardown; abort if
  the invalidation write fails.
- **debt** accrues on any unsupported change/removal; `eligible:true` requires empty debt; debt clears
  ONLY by proven-fresh recreation (artifact absent before build) or an exact verifier — never by a plain
  full rebuild that re-skips a stale artifact.
- **teardown TOMBSTONE**: teardown writes `eligible:false` + `teardown-in-progress` debt BEFORE deleting
  anything, and deletes the envelope ONLY after teardown success + verified live absence; a partial/
  crashed teardown leaves the tombstone (so a surviving artifact can't be rebaselined).

## Projection/verifier framework (`scripts/lib/projection.js` — deliverable #1, DONE)
Pure, id-free, normalized projections that serve as the EXACT post-apply verifiers (static classification
alone is not trusted): `formProjection` (placement-exact), `sitemapProjection` (GUID/env-url normalized),
and page source-vs-deployed dual hashing. Adversarial tests: form-placement collision, page dual-hash,
sitemap normalization (`scripts/tests/projection.test.js`).

## Phase submodes + phase-local publish
On `--changed-only`, phases run in restricted submodes — forms `fieldReconcileOnly` (no promote/
deactivate/events/quickviews), app-shell `prerequisiteResolveOnly`/`finalizeSitemapOnly` (no icon/
sitemap-solution re-ensure), pages `selectedKeysOnly` (whole-app read-only safety checks retained, only
changed keys uploaded), views append-only. NO whole-spec publish (`PublishAllXml`) — phase-local publish
of the touched artifacts only. A pre-mutation live-projection equality check refuses to overwrite a
Maker-drifted artifact (PAC page upload has no CAS — the residual concurrent-edit race is documented as
unsupported).

**CONFIRMED landmine (validated against `sdk-build.js`) — the pages-only fast path MUST skip the sitemap
finalize.** The pages phase's finalize (`sdk-build.js:1428-1437`) rebuilds the WHOLE sitemap via
`appDef(spec, result.created)` and writes `/siteMap` + `components`. In a pages-only run `result.created`
holds only `app`+`pages`, so `appDef` (a) THROWS on any dashboard subarea (`:610-611`,
`result.dashboards` empty) and (b) rebuilds `components` from empty `result.forms/views/charts` (`:635`),
stripping the app's form/view/chart component registrations. A pure page-content re-upload leaves the
key→pageId map unchanged, so the sitemap needs no rewrite — the fast path seeds `result.created.app` from
live discovery, uploads only the changed page(s) to their existing pageIds, SKIPS the finalize, and
publishes just the page. Two sdk-build seams (flag-gated, full-build path byte-identical): seed
`result.created.app` from `opts.resolvedAppId`, and skip `:1428-1437` under the changed-only page submode.

## Sequenced deliverables
1. ✅ Projection/verifier framework + 3 adversarial tests. 2. ✅ Content hashing + fix the shipped
`phase-diff` foundation (`.tsx`/`contentPath` edits are now visible to the diff, fail-closed;
`scripts/lib/hash.js` + `content-hash.js`). 3. 🔄 Envelope
(schema 3, eligibility SM, debt, tombstone, unique keys, source/deployed hashes) + build-wide lease +
generation CAS + immutable staging + invalidate-before-write + teardown tombstone. **Parts 1–2 done**:
pure state machine (`apply-snapshot.js`) + I/O store (`apply-snapshot-store.js`, atomic/lease/CAS/
invalidate/tombstone/delete), fully unit-tested; **remaining part 3**: `indexArtifacts` + wire the store
into the full-apply persist / invalidate-before-write and teardown tombstone (behavior-touching). 4. Phase submodes +
artifact-scoped writes + pre-mutation drift + both-writer sitemap drift + phase-local publish. 5.
Classifier + closure + `--changed-only` flow + eligibility/debt transitions + CLI opts. 6. Full offline
tests + eval. 7. Sol review of the IMPLEMENTATION. 8. Live regression test (aurorabapenv03468). 9. Docs.

## Build-time notes (from the final Sol pass)
- Live-absence verification covers the UNION of prior-snapshot identities, current spec, generated
  artifacts, and all debt entries — not merely the current spec.
- Debt-clearing verifiers must match the specific debt reason (placement verify can't clear
  event/quick-view debt).
- Keep crash/failure-injection tests + a live PAC page-upload publication/concurrency test.
