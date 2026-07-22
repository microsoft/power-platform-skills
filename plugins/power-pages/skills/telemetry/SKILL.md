---
name: telemetry
description: >
  Use this skill when the user wants to enable, disable, turn on or off, opt out
  of, opt in to, or check the status of power-pages telemetry / anonymous usage
  data. Triggers: "disable telemetry", "turn off telemetry", "opt out of
  telemetry", "stop collecting usage data", "enable telemetry", "telemetry status".
user-invocable: true
argument-hint: "on | off | status"
allowed-tools: Bash
model: haiku
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

**Workflow: [telemetry-workflow.md](${PLUGIN_ROOT}/skills/telemetry/telemetry-workflow.md)** — Read and follow all steps defined in that bundled file.
