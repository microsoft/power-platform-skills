# Design — `/app-builder` flow refinement

> **Status: PROPOSAL awaiting review.** This is the brainstorming output for refining the
> `/app-builder` flow. R0 (objective doc-drift fixes) is already applied. R1–R3 are proposed
> refinements — **not yet implemented**; they change the skill's interactive flow and need approval
> before implementation (per the brainstorming design gate). Authored async (user unavailable for the
> normal one-question-at-a-time brainstorm), so it is written to be decision-ready: approve/reject each
> item and I'll turn the approved set into an implementation plan.

## The flow today (baseline)

All in the **main conversation loop** (never a subagent — so `AskUserQuestion` / plan mode reach the user):

- **Phase 0 — Working dir:** slug → `mkdir` → holds `app-spec.json`, `model-app-plan.md`, `workflow-log.md`.
- **Phase 1 — Author (interactive):** prereqs → env (`pac auth`/`org who`) → detect existing →
  **two-level authoring** [(a) data model → *confirm*; (b) forms/views/charts/pages/sample data → *confirm*]
  → **spec-lint** (hard gate) → **plan-mode** approval → write `model-app-plan.md`.
- **Phase 2 — Build (narrated):** **dry-run** (show plan) → *go-ahead* → `--apply` (idempotent, 13 phases,
  `[n/total]` live status, `BuildHalt` gate, journal-resumable).
- **Phase 3 — Verify & iterate:** `verify-model-app.js` (manual) → open in browser → refine → re-run.
- **Edit** = same path (`download → edit spec → rebuild`). **Cleanup** = `teardown`.

The architecture is sound (spec-driven, idempotent, create==edit). The friction is **gate density /
redundancy** and **late/optional error detection** — not the phase model itself.

---

## R0 — Objective doc-drift fixes (DONE, no approval needed)

Found while mapping the flow; both are drift from the just-completed hardening-2 SDK migration:

1. **SKILL.md "What the builder does (in order)"** said forms are built with `addSubGrid` per sub-grid
   and `addFormEventHandler` per `events[]` — **both retired** in the migration. Corrected to the generic
   `addElement` surface (canonical control cells / `/bag/c` events region).
2. **SKILL.md teardown order** listed `web-resources` **before** `tables`; the actual order (AGENTS.md,
   `planTeardown`, and the live teardown log) deletes web resources **after** tables (a table's icon web
   resource is referenced by the table). Corrected to `… relationships → AI row summaries → tables →
   web-resources → global choices → solution`.

*(No behavior change — documentation now matches the code.)*

---

## Friction points + proposed refinements

### R1 — Lint after the data-model level, not only at the end

**Friction (evidence):** `spec-lint.js` catches **data-model-specific** errors — e.g. the
relationship-name-vs-lookup-name collision Dataverse rejects — but it runs only at **Step 5**, *after*
both Level (a) *and* Level (b) are authored and confirmed (`references/authoring-flow.md` Step 4 → Step 5).
So a broken data model is discovered only after the user has also authored and confirmed forms/views/charts
on top of it — the most expensive point to unwind.

**Options:**
- **(A, recommended)** Run the lint at the **end of Level (a)** as an early gate (data-model findings
  only), and keep the full lint at Step 5 as the final gate. Cheapest fix; catches model errors before
  they cascade.
- (B) Move all linting to Step 5 but make Level (b)'s confirmation cheaper to redo. Doesn't fix the
  root cause (late detection).
- (C) No change. Rejected — the collision error is exactly the kind that should gate early.

**Recommendation:** A. **Implementation note:** `lintAppSpec` currently expects a whole spec; on a
data-model-only spec it may warn about not-yet-authored `app`/`forms`. Add a `scope: 'data-model'` (or
`level`) option that restricts findings to entities/columns/relationships/global-choices, so the early
gate doesn't emit spurious "no app / no forms" noise. Pure function, unit-testable.

### R2 — Collapse the redundant double "plan-and-approve"

**Friction (evidence):** the user approves the plan **twice**. Phase 1 **Step 6** presents the plan via
`EnterPlanMode` and gets go-ahead on `ExitPlanMode`. Then Phase 2 says *"Dry-run first … Show it. On the
user's go-ahead, apply."* — i.e. the build's dry-run output is shown and a **second** go-ahead is taken
before `--apply`. Two presentations of essentially the same plan, two approvals, before anything writes.

**Options:**
- **(A, recommended)** Make the **build dry-run the content of the plan-mode gate**: run
  `build-model-app.js` (no `--apply`) to produce the phase-grouped plan, present *that* in plan mode, and
  on approval go straight to `--apply`. One presentation, one approval — and the plan shown is the
  *engine's real* idempotent plan (reflects detect-existing), which is strictly more accurate than a
  hand-written summary.
- (B) Keep both but make Step 6 a lightweight prose summary and the dry-run the real gate. Still two
  stops.
- (C) No change. Rejected — redundant confirmation is the top flow complaint surface.

**Recommendation:** A. `model-app-plan.md` is still written (record of intent); the dry-run output becomes
the approval artifact. Net: **one fewer gate** and a more accurate plan.

### R3 — Auto-verify after a successful `--apply`

**Friction (evidence):** Phase 3 verify is a **separate manual command** (*"Then open the app"*), easy to
skip. A silent **partial** build (some artifacts failed while the run still reports mostly-success) isn't
caught until the user manually verifies or opens the app. We already ship a read-only reconciler
(`verify-model-app.js`) purpose-built to catch this.

**Options:**
- **(A, recommended)** After `--apply` completes, **automatically run the verifier** and fold its
  reconcile result into the build's closing summary (`✓ build complete … — verify: 11/11 present` or a
  listed-missing block). Skill-instruction change, or a `--verify` flag on `build-model-app.js` that runs
  the reconcile after the build.
- (B) Leave verify manual but make the closing summary louder about `Z failed`. Weaker — doesn't catch a
  *silent* partial (artifact created but not wired).
- (C) No change. Rejected — verification-before-completion is a core value; making it automatic enforces it.

**Recommendation:** A, as a `--verify` flag on the build (so a plain CLI run self-checks too), surfaced in
the narration.

---

## Considered and rejected (YAGNI)

- **Merge the two authoring levels for "simple" apps.** Tempting for a 1-table app, but the two-level
  split exists precisely because data-model errors cascade — and R1 makes the split *more* valuable, not
  less. Adds branching to the playbook for marginal gain. **Rejected.**
- **Cache env/detect-existing across an edit session.** Minor; the flow already auto-confirms a single
  active profile. **Deferred** (revisit only if edit sessions feel heavy).

## Recommended sequencing (if approved)

1. **R1** (early data-model lint) — highest safety payoff, smallest change; needs the `spec-lint` scope option.
2. **R2** (single plan-and-approve) — biggest UX win; pure flow/doc change.
3. **R3** (auto-verify) — closes the silent-partial gap; small engine flag + narration.

Each is independent — approve any subset. On approval I'll take the approved set into `writing-plans`
for an implementation plan (TDD, with `spec-lint`/build/verify unit coverage and a doc-sync pass across
SKILL.md, authoring-flow.md, and architecture.md).
