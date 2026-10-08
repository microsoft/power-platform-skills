# Routing Eval — model-apps skill selection

Grades the decision an agent makes **before** any skill runs: given a user prompt and the plugin's
skill descriptions, does it pick the right model-apps skill — or correctly pick none?

The offline harnesses next door grade the *artifacts* a run produced (`../genpage/` grades
workflow logs, plans and `.tsx`; `../app-builder/` grades App Spec stage facts). Neither can see a
mis-route, and the two skill descriptions point at each other (`/genpage` → "use /app-builder
instead" and back), so a wording change to one can silently start stealing the other's prompts.

## What a case looks like

`evals.json`:

```json
{
  "id": 4,
  "tier": "smoke",
  "prompt": "I need a Dataverse app for inventory with products, warehouses and stock levels, plus a dashboard overview page.",
  "expect": "app-builder",
  "trap": "the word \"page\" pulling a whole-app request into /genpage"
}
```

| Field | Meaning |
|-------|---------|
| `expect` | The model-apps skill the agent must invoke **first** — `genpage`, `app-builder`, `report-issue`, `telemetry` — or `null` for "none of them" (a negative / bleed case) |
| `accept` | Optional other outcomes that are also correct, for a genuinely ambiguous prompt. `null` is never implied: "ambiguous" does not mean "anything goes" |
| `trap` | Optional. The mis-route the case exists to catch; printed when the case fails |
| `tier` | `smoke` / `full` / `stress`, as in the other suites |

The 20 committed cases cover: positives for every skill; the `/genpage` ↔ `/app-builder` boundary
from both sides ("add a page to my existing app" vs "an app … plus a dashboard page", "add a
**table** to my existing app"); and negatives that share vocabulary with the plugin — Power Pages,
canvas/Power Fx, Power Automate, a generic React dashboard, and a pure knowledge question.

## How a trial runs

`run-routing.js` launches a real agent CLI headlessly, once per trial:

- **Isolated.** cwd is a fresh empty temp dir (no repo `AGENTS.md` can steer the model); only this
  plugin is loaded via `--plugin-dir`; the user's own plugins/skills are excluded (Claude:
  `--restricted`, which also confines the file tools to that empty cwd; Copilot: a throwaway
  `COPILOT_HOME`); MCP servers are off. One residual gap: a user-level `~/.claude/CLAUDE.md` still
  loads for Claude — `--safe-mode` would skip it but also drops the plugin's own skills — and CI
  runners have none.
- **Read-only.** The tool set is cut to "invoke a skill + read files". The trade-off is that a real
  session offers more tools, so the model sees a slightly smaller menu.
- **Stopped at the decision.** The JSONL transcript is parsed as it streams, and the agent is killed
  the moment it invokes a model-apps skill, so a positive trial costs about one model turn.
- **Guarded.** Every trial proves the plugin's skills were loaded before its outcome counts; if they
  were not, the trial is a harness **error**, not a passing "none". Claude reports its loaded
  skills in the transcript's init event. Copilot's transcript does not, so each Copilot trial first
  runs `copilot --plugin-dir <dir> skill list --json` with the trial's own isolated `COPILOT_HOME`.
  That fails the trial, before any model call, if a plugin skill is missing or any non-builtin skill
  from outside the plugin is present (an isolation leak). A CLI that exits non-zero or reports a
  failed result before deciding (not signed in, not installed, crashed), or a run cut off by
  `--timeout` before choosing a skill, is also an error. Only a run that **finishes successfully**
  without invoking a model-apps skill counts as "none".

Every flag is in `lib/agents.js`; every transcript shape the parser understands is documented in
`lib/transcript.js`.

## Grading

Routing is not deterministic, so each case runs `--runs` trials (default 3) and passes when its
successes over the **non-error** trials reach `--threshold`, compared strictly (default `2/3`, i.e.
2 of 3; pass a decimal such as `0.8` or a fraction such as `3/4`). Prefer a fraction to a rounded
decimal: `0.67` is stricter than `2/3`, so 2 of 3 fails it. A case whose every trial errored is a
harness error.

Exit codes: `0` every case met the threshold · `1` a case failed · `2` harness error.

```
TAP version 13
# agent claude · model sonnet · runs 2 · threshold 2/3
1..20
ok 1 - #1 [smoke] expect genpage — 2/2 (genpage×2)
not ok 4 - #4 [smoke] expect app-builder — 1/2 (app-builder×1, genpage×1)
  ---
  prompt: "I need a Dataverse app for inventory ..."
  trap: "the word \"page\" pulling a whole-app request into /genpage"
  ...
# cases 20 (pass 19, fail 1, error 0)
# trials 40 (errors 0)
# cost >= $0.48 (killed trials do not report cost)
```

## Running it

From the repo root. You must be signed in to the agent CLI you choose.

```bash
# See exactly what would be launched; launches nothing
node evals/model-apps/routing/run-routing.js --dry-run

# Smoke tier, one trial each (quick local check after editing a SKILL.md description)
node evals/model-apps/routing/run-routing.js --tier smoke --runs 1

# Full suite on Copilot CLI with a specific model, saving results for later comparison
node evals/model-apps/routing/run-routing.js --agent copilot --model claude-sonnet-5.5 --out before.json

# ...edit a description, then compare: prints `# delta #<id>: <old> → <new>` for every case that moved
node evals/model-apps/routing/run-routing.js --agent copilot --model claude-sonnet-5.5 --out after.json --compare before.json
```

`--out` records each skill's description fingerprint, so two result files show whether the
descriptions changed between them. `--transcripts <dir>` saves raw JSONL per trial for debugging —
keep those local; they can contain local paths and model output.

Measured when the suite was added: all 20 cases passed 2/2 on both Claude Code (`--model sonnet`)
and Copilot CLI (`--model claude-sonnet-5.5`), ~5–15 s per trial. The suite is therefore a
**regression guard** for the descriptions, not a known-failing backlog — and since every case is
currently easy for these models, harder boundary prompts are the most useful additions.

## Cadence

Not part of the per-PR gate: it costs model usage and is non-deterministic.
`.github/workflows/model-apps-agent-evals.yml` runs it on a same-repo PR labelled
**`run-agent-evals`** (use the label on any PR that edits a skill `description:`; re-apply it to
re-run after new commits), **weekly**, and **on demand**. It is report-only, not a required check.

**No secret to provision.** The default agent is Copilot CLI, which authenticates with the
workflow's built-in `GITHUB_TOKEN` because the job holds `copilot-requests: write`; usage is billed
to the organization (the *Allow use of Copilot CLI billed to the organization* Copilot policy must
be on — it is by default when Copilot CLI is enabled). See [Using Copilot CLI in GitHub Actions with
GITHUB_TOKEN](https://docs.github.com/copilot/how-tos/copilot-cli/use-copilot-cli-in-actions).
`agent=claude` (dispatch only) needs an `ANTHROPIC_API_KEY` secret and clean-skips without it. The
job uploads only the results JSON, never transcripts.

The runner's own logic (parsing, grading, process handling against a fake agent) **is** unit-tested
on every PR: `node --test evals/model-apps/routing/tests/*.test.js`.

## Adding a case

1. Append to `evals.json` with the next id. Prefer prompts a real user would type, and give every
   negative or boundary case a `trap`.
2. `node evals/model-apps/routing/run-routing.js --eval <id> --runs 3` — a new case should pass at
   least 2/3 on the current descriptions, or it documents a routing bug worth fixing first.
3. `node --test evals/model-apps/routing/tests/*.test.js` validates the file's shape.
