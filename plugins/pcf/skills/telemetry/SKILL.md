---
name: telemetry
description: >
  Use this skill when the user wants to enable, disable, turn on or off, opt out
  of, opt in to, or check the status of pcf telemetry or its usage data.
  Triggers: "disable telemetry", "turn off telemetry", "opt out of telemetry",
  "stop collecting usage data", "enable telemetry", "telemetry status".
user-invocable: true
argument-hint: "on | off | status"
allowed-tools: Bash, execute
---
<!-- No plugin update check here: it runs `git fetch`, and turning telemetry on or off must stay a local action. -->

**Workflow: [telemetry-workflow.md](${PLUGIN_ROOT}/skills/telemetry/telemetry-workflow.md)** — Read and follow all steps defined in that bundled file.
