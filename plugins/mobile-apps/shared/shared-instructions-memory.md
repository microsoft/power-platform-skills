## Memory Bank

**📋 [memory-bank.md](./memory-bank.md)**

Per-project notebook persisted at `<working_dir>/memory-bank.md`. Skills that
manage project state and link this topic file MUST:

1. **Read it at start** — locate at `<working_dir>/memory-bank.md`. If present, parse Project facts, Power Platform context, Data model, Connectors, Screens, Build history. Inform the user what was found.
2. **Skip work already done** — if a step is marked complete, ask whether to redo or move on. If invoked from another skill that already updated the bank, skip the summary.
3. **Update at end** — append to the relevant section after a successful step. Use ISO dates. One-line entries. Never delete — mark `~~superseded~~`.
4. **Resume on failure** — if a previous run died partway, the bank is the only record of where. Resume from the first incomplete step rather than re-running everything.

If the bank doesn't exist yet, `/create-mobile-app` is responsible for copying the template (`${PLUGIN_ROOT}/shared/memory-bank.md`) into the working directory at Step 6 (right after `npx power-apps init` succeeds).

---

## Preferred Environment

**📋 [preferred-environment.md](./preferred-environment.md)**

When selecting an environment, use this priority order: `power.config.json` → memory-bank → user-specified. Never silently switch environments — confirm any change with the user.

---

## Host Capability Cache

Agent-routing capability entries must include the capability name, result,
host/runtime identifier, plugin version, and `checkedAt`. Reuse an entry only
when host/runtime and plugin version still match and it is no older than 30
minutes. Treat legacy/unscoped entries as stale. A negative result never
permanently disables an agent: retry a real dispatch after expiry or whenever
the host/plugin changes. Application-level `BLOCKED` results are not routing
failures and must not be cached as unavailable.

---
