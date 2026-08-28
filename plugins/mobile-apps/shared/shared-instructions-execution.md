## Sub-Skill Invocation

When a skill is invoked from another skill (e.g., `/create-mobile-app` calls `/add-dataverse`):

- **Check `$ARGUMENTS`** — if provided, use it; don't re-prompt.
- **Skip redundant questions** — don't re-ask things the caller already provided (working dir, environment, plan section).
- **Memory bank is still read** — but skip the summary if the caller just updated it.
- **Honor `--skip-planning`** — if the caller indicates the plan is already approved, do not re-spawn the planner agent.
- **Inherit `working_dir`** — never default to `process.cwd()` when invoked from another skill.
- **Scratch files go in `<working_dir>/.tmp/`** — never write temporary files (request bodies, intermediate JSON, scratch data) to `/tmp/` or any path outside the project directory. Keeping scratch data project-local prevents cross-project writes and makes cleanup deterministic. Create the folder first: `mkdir -p <working_dir>/.tmp`.

---

## Execution Style

- Do not announce steps before executing them. Proceed directly through the workflow.
- Do not ask for permission to do read-only operations (Glob, Grep, Read, `node scripts/resolve-environment.js <environment-id-or-url>`).
- For multi-step operations, use `manage_todo_list` to give the user visibility.
- After completing each step, update the memory bank — don't batch updates at the end.

### When to use `AskUserQuestion` — and when NOT to

The user shouldn't have to read a question whose answer is mechanical. Each prompt costs a context switch. Apply this filter before calling `AskUserQuestion`:

| Situation | Action |
|---|---|
| Only one viable path (others are infeasible / would error) | **Take it. Inform, don't ask.** Print a one-line `→ <action> (<reason>)` summary so the user sees what happened. |
| Auto-recoverable failure with a deterministic fix (e.g. probe alt names, retry with backoff, fall back to default) | **Auto-recover.** Surface only if recovery itself fails. |
| Detectable state (e.g. "is Metro running?") | **Probe first.** Use the available tool (MCP, file check, command) and only ask if the probe is inconclusive. |
| Display preference repeated across runs (e.g. "open in browser?") | **Use the persisted flag** (`memory-bank.md`, project config). Don't re-ask each time. |
| One option is tagged `(Recommended)` AND alternatives are clearly worse | **Default to the recommended option** without prompting. If you must prompt (e.g. options have different costs), make the recommended option the default so an empty answer proceeds. |
| Genuinely ambiguous (multiple valid paths with real trade-offs the user must weigh) | **Ask.** This is the legitimate case. |

The "Recommended (default-yes)" pattern: when you do call `AskUserQuestion`, structure the options so an empty/cancel answer auto-proceeds with the safe default — never block on a prompt the user can ignore.

---


## Re-Read Before Edit (when iterating)

The `Edit` tool fails when its `old_string` is no longer in the file — typical cause: the file was modified earlier in the same run (by you, by another tool, or by a prior `Edit` that changed surrounding text).

**Rule:** before any second-or-later `Edit` to a file you've already touched in this run, call `Read` on the file first to refresh your view. This applies especially to:

- `native-app-plan.md` during retry-after-rename loops (e.g. service name singular → plural).
- Generated files that a tool may have rewritten (e.g. `npx power-apps add-data-source` regenerating `connectorSchemas.ts` between your edits).
- Any file you Edit more than once with different `old_string` arguments derived from a stale read.

When the rename is structural (`cr3e9_thingService` → `cr3e9_thingsService` everywhere), prefer `Edit` with `replace_all: true` over multiple targeted `Edit`s — a single sweep can't go stale.

---

## Adding New Shared Instructions
