# Agent interaction contract — agents are headless

Every file under `agents/` is dispatched as a `Task` subagent, and a subagent has
**no user on the other end**. `AskUserQuestion`, `EnterPlanMode` and
`ExitPlanMode` do not reach anyone from inside one: the question is never
answered and the approval is never given. An agent that declares or calls them is
specifying a flow that cannot complete.

This is not theoretical. `/genpage` Phase 1 was specified to run its entire
interactive flow — prerequisites, auth, the "create new / edit existing" question
and plan-mode approval — inside the `genpage-planner` subagent, while the same
plugin's `AGENTS.md` documented that subagents are headless and `/app-builder`
enforced the opposite rule. There was no compliant path through Phase 1, so
create flows could not complete. It survived roughly two and a half months
because nothing checked: agent frontmatter is prose to every test in the repo.
`scripts/validate-agent-interactivity.js` now fails the build on a declaration.

## The rule

**Interaction belongs to the main conversation loop.** An agent that needs a
decision returns a structured request; the orchestrator asks, records it, and
re-invokes the agent with the answer.

## The `needs_input` request

```json
{ "action": "needs_input",
  "why": "<one line: what is blocked without this>",
  "questions": [
    { "id": "<stable-id>",
      "question": "<the question, verbatim>",
      "options": [ { "label": "<short>", "description": "<what it means>" } ],
      "multiSelect": false } ] }
```

Return everything already discovered alongside the request, so the re-invocation
does not repeat the reads it has already paid for.

## Logging is unchanged

The orchestrator records the exchange in `workflow-log.md` in the documented
format — `AskUserQuestion: <question> → <answer>`, and `EnterPlanMode called`
followed by the response. The log records what was **asked**, not which loop
asked it, so the eval harness contract is unaffected by where the call is made.

## What agents keep

Read-only discovery, code generation, file writes, and shell work are all
unchanged. Only the act of *prompting a human* moves to the parent.
