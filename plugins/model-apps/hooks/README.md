# model-apps hooks

What `hooks.json` wires up, and why.

This prose lived in a `_comment` key inside `hooks.json` itself. Claude Code validates that file
against a closed schema and prints `model-apps: hooks.json: unknown key "_comment" ignored` at
**every session start**, which reads as a plugin misconfiguration to the user (#555, #558). The
documentation belongs here instead; `scripts/validate-hooks-manifests.js` keeps it from drifting
back.

## PreToolUse

| Matcher | Hook | Behaviour |
| --- | --- | --- |
| `Write\|Edit\|MultiEdit` | `validate-write-safety.js` | **Flags** (non-blocking, exit 1) a write outside the cwd, and only during an active model-apps authoring session — that is, when a `genpage-plan.md`, `app-spec.json`, or `model-app-plan.md` marker exists at or under the cwd, which covers both `/genpage` and `/app-builder`. |
| `Skill\|skill` | `run-skill-pretool-telemetry.js` | Emits the `skill_started` usage event. Ships disabled until an instrumentation key is provisioned. |

## PostToolUse

| Matcher | Hook | Behaviour |
| --- | --- | --- |
| `Skill\|skill` | `run-skill-posttool-validation.js` | Runs the invoked skill's own `scripts/validate*.js`, if it has one. |
| `Write\|Edit\|MultiEdit` | `validate-icon-imports.js` | On every code write, validates `@fluentui/react-icons` imports against `references/verified-icons.txt`. |

## UserPromptSubmit

`run-user-prompt-telemetry.js` emits `skill_started` for `/model-apps:<skill>` slash commands.
Tracked skills are derived from `skills/*/SKILL.md`, so a new skill is picked up automatically.

## Notes

- All telemetry is fail-closed and default-off in `ikey.json`; a missing executable, a timeout, or an
  unparseable response resolves to "no event" rather than throwing into the hook it runs inside.
- Run the host from the target project folder, or pass that folder as the cwd — the write-safety
  session markers are resolved relative to it.
