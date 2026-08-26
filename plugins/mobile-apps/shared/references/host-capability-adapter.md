# Host Capability Adapter

Mobile workflows run in hosts with different tool names and nesting support.
The foreground orchestrator owns this adaptation. A missing chat-host feature
is never evidence that the app directory is unreadable or unwritable.

## Capability Matrix

| Need | Preferred host capability | Portable fallback |
|---|---|---|
| Focused question | Structured question tool | Ask one plain-text question and wait for the answer |
| Plan approval | Plan-mode enter/exit tools | Present the same review in ordinary chat and require an explicit `approve` response |
| Specialist delegation | Background or nested task tool | Foreground reads the specialist instructions and completes one work order at a time |
| File mutation | Foreground write/edit tool | A read-only specialist returns a proposal; foreground writes and validates it |
| Shell execution | Bash/terminal tool | Specialist returns the exact command; foreground executes it |
| Skill directory | Host-provided skill directory variable | Foreground resolves the current plugin root once and passes its absolute path |
| Progress | Shell echo or task progress | Foreground emits the same milestone as an ordinary chat update |

## Dispatch Protocol

1. Inspect the capabilities advertised by the current host. Do not invoke a
   nonexistent tool merely to test whether it exists.
2. If a nested planner lacks a capability required to finish its artifact,
   return this literal first line:

   ```text
   NEEDS_CONTEXT: host-capability-handoff:<comma-separated-capabilities>
   ```

   This is an orchestration handoff, not an app-project failure. Do not report
   `cannot write project`, `filesystem failure`, or `BLOCKED` unless an actual
   foreground file operation failed.
3. The foreground continues from the same brief and existing artifacts. It
   must not restart discovery, change product decisions, or create a second
   planner contract.
4. Foreground fallback consumes the same immutable screen-build-pack entry and
   runs the same validators as delegated execution. Sequential execution is a
   scheduling fallback, not a quality fallback.
5. Textual approval records the same approval artifact as plan-mode approval.
   Prototype approval remains local and cannot authorize external mutation.

## Blocking Boundary

Host limitations block only when the foreground itself has no way to read the
required inputs, write inside the project root, or execute a mandatory local
validator. A specialist lacking those tools returns a proposal or handoff.
Actual permission errors, unsafe paths, and failed foreground writes remain
project failures and must be reported with their real command or path.