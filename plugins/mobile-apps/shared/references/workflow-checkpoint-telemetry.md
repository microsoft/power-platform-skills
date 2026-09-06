# Workflow Checkpoint Telemetry

A foreground workflow opts a boundary into telemetry with this marker directly
below its heading:

```markdown
**Telemetry checkpoint: `<static_snake_case_name>`**
```

At a marked boundary, run the direct fail-open command with the current
top-level skill name:

```bash
node "${PLUGIN_ROOT}/scripts/emit-telemetry-checkpoint.js" \
  "<skill-name>|<checkpoint-name>|<state>|<optional-info>"
```

Use `started` immediately before the work, then `completed` after success or
`failed` before stopping on failure. A valid branch that bypasses the work
emits only `skipped`. Omit the final `|<optional-info>` when no extra
classification is needed.

Checkpoint names and optional information must be fixed, author-written
`snake_case` values of at most 64 characters. Optional information is only for
low-cardinality classifications such as `dependency_missing`; never
interpolate prompts, errors, paths, names, identifiers, URLs, command output,
or other runtime data.

Ignore telemetry output and never retry, block, or alter workflow behavior when
emission fails.
