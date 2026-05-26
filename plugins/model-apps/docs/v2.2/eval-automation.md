# Eval Automation Design (v2.2)

A standalone design doc for automating the genpage eval suite. Companion to
`PLAN.md` in this folder. **Status: design exploration, no implementation
yet.**

---

## Current state

`evals/model-apps/genpage/evals.json` defines 16 evals (4 smoke + 9 full + 3
stress) plus 15 `common_workflow_assertions` and 18 `common_code_assertions`.
`eval-runbook.md` describes the manual grading process:

1. **Layer 1** — workflow assertions. Grade against `workflow-log.md` and
   files in the working dir. Today: a human reads the log and ticks each
   assertion.
2. **Layer 2** — code assertions. Grep the generated `.tsx` against patterns.
   Today: a human runs each grep manually (most are scriptable).
3. **Layer 3** — UX rubric. Open the page in a browser, judge layout,
   accessibility, interactions. Today: human-only.

A full eval run takes **5-10 min per eval × 16 evals ≈ 1-2 hours** of human
time. This is the main reason evals run pre-release rather than per PR.

---

## Goals

- **Layer 1 + Layer 2 fully automated.** Pass/fail determined without a human.
- **CI-friendly.** Run on every PR in <15 min total. Fail-loud on regressions.
- **Each failure points to the specific assertion that broke.** No "the eval
  failed" — instead "eval 7, assertion 12 (Phase 2b: scripts/create-table.js
  is used) — agent invoked Python instead. See workflow-log.md line 84."
- **Layer 3 stays manual for now.** Visual / UX judgment is genuinely hard to
  automate and the cost-benefit doesn't work yet.

## Non-goals

- Replacing human grading entirely. Some assertions are inherently subjective
  ("realistic mock data, not Lorem ipsum") and need a sampling human pass.
- Achieving 100% deterministic results. Claude responses have variance;
  automation should tolerate ~10% variance without flagging.

---

## Design options

### Option A — Headless Claude Code replay

Run the actual `/genpage` skill in a headless Claude Code session per eval,
capture the workflow log, grade against assertions.

**Pros:**
- Tests the real skill end-to-end.
- Catches regressions in agent dispatch, prompt drift, tool selection.

**Cons:**
- Slow. Each eval needs a real model call. 16 evals × ~3 min per response
  = ~50 min. Expensive (~$10 per full run at current Opus rates).
- Non-deterministic. Same prompt produces different outputs run-to-run.
- Requires Anthropic API auth in CI.
- Hard to seed mock state (entity detection, app list, env auth) without
  hitting a real Dataverse env per run.

**Verdict:** Best fidelity but cost + flakiness make it impractical for
per-PR runs.

### Option B — Mock subagent dispatch + replay transcript

Build a harness that:
1. Spawns the orchestrator (`SKILL.md`) in a sandbox.
2. Intercepts `Task` tool calls — instead of dispatching to a real subagent,
   replays a canned subagent transcript per eval.
3. Captures the orchestrator's tool calls (`Bash`, `Edit`, `Write`,
   `AskUserQuestion`) and grades them against assertions.
4. For `AskUserQuestion`, the harness auto-answers from
   `eval.data.question_answers`.

**Pros:**
- Faster than (A) — only the orchestrator hits the model.
- More deterministic — subagent transcripts are canned.
- Still tests real prompt → real tool call behavior.

**Cons:**
- Maintaining canned subagent transcripts is its own work — the planner
  agent has 423 lines of logic that we'd need to mock.
- When agents evolve, transcripts must be regenerated.
- The Task tool's exact contract isn't a stable public interface.

**Verdict:** Plausible but transcript maintenance overhead is real.

### Option C — Standalone unit harness (no Claude Code)

Skip the agent loop entirely. Build a test runner that:
1. For each eval, constructs a fake "post-orchestration" state — a fully
   formed `genpage-plan.md`, a populated working dir, a synthetic
   `workflow-log.md`.
2. The harness focuses on **the artifacts the agent SHOULD produce**, not
   the agent's path to produce them.
3. Code-assertions: grep the generated `.tsx` files in the working dir.
4. Workflow-assertions: parse `workflow-log.md` for the expected sequence.

To produce the artifacts: either (a) run them once manually and commit them
as fixtures, or (b) build a "golden output" mode that captures the agent's
output on a known-good run and replays it.

**Pros:**
- Fast. Just file I/O and grep. ~1 sec per eval.
- Deterministic.
- No API costs.
- Cleanly separates "did the agent produce the right output?" (this) from
  "is the agent reliable?" (which is the A or B problem).

**Cons:**
- Doesn't catch agent drift. If the agent stops invoking the planner, this
  harness won't notice — because it's grading the artifacts that a
  hypothetical agent would have produced.
- Fixtures go stale when the rules change.

**Verdict:** Best for Layer 2 (code assertions), weakest for Layer 1
(workflow assertions). Could ship as a starting point.

---

## Recommended phasing

### Phase 1 — Layer 2 automation (Option C subset)

Build a small `evals/model-apps/genpage/run-layer-2.js` script that:

1. Takes a directory containing generated `.tsx` files.
2. Runs each entry in `common_code_assertions` as a grep pattern.
3. Plus per-eval `expectations` that match `^Phase 5 \(Page Builder\):`
   (these are code-quality assertions, gateable by grep).
4. Outputs a pass/fail per file with the assertion that failed.

The "fixtures" are: human runs `/genpage` once for each eval and commits the
resulting `.tsx` to `evals/model-apps/genpage/fixtures/<eval-id>/`. CI runs
Layer 2 against these fixtures.

**Catches:** rule violations introduced when generation logic changes.
**Doesn't catch:** orchestrator changes that don't affect code output.

**Cost:** ~1 day. ~200 LOC of test runner + ~16 fixture .tsx files.

### Phase 2 — Layer 1 automation (Option B-lite)

A separate `evals/model-apps/genpage/run-layer-1.js` that:

1. Reads `workflow-log.md` from each eval fixture.
2. For each entry in `common_workflow_assertions` + the eval's own
   `expectations` filtered to `^Phase` references, checks that the
   workflow-log contains the expected line.
3. The agent's job (from v2.1) is to write to `workflow-log.md`; this
   harness grades that log.

**Catches:** missed agent dispatches (e.g., orchestrator inlined a
question instead of invoking the planner), wrong tool selection.

**Cost:** ~1 day. Depends on Phase 1 fixtures.

### Phase 3 — CI wiring

GitHub Actions workflow that runs Phase 1 + Phase 2 on every PR touching
`plugins/model-apps/` or `evals/model-apps/`. Posts a comment on the PR
listing failed assertions.

**Cost:** ~half day.

### Phase 4 (future) — Headless Claude Code (Option A)

Once Phases 1-3 are stable, add a nightly job that does the real Option A
flow against a test env. Catches drift in the real agent that fixture-based
grading misses.

**Cost:** ~2 days.

---

## Open questions

1. **Fixture refresh cadence.** When the agent improves and produces better
   `.tsx`, fixtures need updating. Automate or manual?
2. **Tolerance for variance.** If 1 of 16 evals fails on a borderline
   assertion, is that a fail or a warning? Suggest: 1 borderline assertion
   = warning; 2+ = fail.
3. **Where does the harness live?** Inside `evals/model-apps/genpage/` next
   to the data, or a separate `tools/` folder? Currently leaning toward
   the former.
4. **Fixture format.** Just the `.tsx` files, or also the `workflow-log.md`,
   `genpage-plan.md`, and `entity-creation-log.md`? Probably all — Layer 1
   needs the log.
5. **Snapshot tests for plan documents.** Should the `genpage-plan.md` for
   each eval be a fixture we diff against? Catches planner drift but
   sensitive to minor wording changes.

---

## Out of scope for v2.2

- Replacing the eval suite with a different framework (e.g., promptfoo,
  evalplus). Current `evals.json` format is fine; we just need a runner.
- UX automation (Layer 3). Visual regression is a separate, expensive
  problem.
- Cross-model evals (running the same eval against Sonnet vs Opus to
  compare quality). Interesting but not blocking.

---

## Estimated total effort

| Phase | What | Cost |
|--|--|--|
| 1 | Layer 2 runner + fixtures | ~1 day |
| 2 | Layer 1 runner | ~1 day |
| 3 | CI wiring | ~0.5 day |
| **Sub-total (must-haves)** | | **~2.5 days** |
| 4 | Headless real-agent | ~2 days |
| **Total (with real-agent runs)** | | **~4.5 days** |

Phases 1-3 are independent of each other once fixtures exist. Phase 4 can
land later as a separate enhancement.

---

## Decision log (for the v2.2 implementation session)

These are pre-committed choices to save deliberation when work starts:

- **Start with Option C / Layer 2.** Fastest win, builds the fixture
  infrastructure others need.
- **Fixtures live in `evals/model-apps/genpage/fixtures/<eval-id>/`.** Each
  fixture is a folder mirroring a real working-dir output.
- **Layer 3 (UX rubric) stays manual.** Don't try to automate it in v2.2.
- **One harness, two entry points.** `run-layer-1.js` + `run-layer-2.js`
  share library code under `evals/model-apps/genpage/lib/`.
- **Output format:** TAP (Test Anything Protocol) for CI compatibility.
  Familiar to most test runners.
