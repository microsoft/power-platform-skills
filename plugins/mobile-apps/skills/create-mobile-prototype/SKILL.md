---
name: create-mobile-prototype
description: Build a working Power Apps mobile app from the connected Player, starting with 2-3 useful screens and persistent local data. Uses the main-based creation workflow; real data connections and further screens are explicit follow-ups.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Task, EnterPlanMode, ExitPlanMode
model: opus
---

Read [shared instructions](${PLUGIN_ROOT}/shared/shared-instructions.md).

# Build an app from your phone

## Run the shared app workflow

**Telemetry checkpoint: `build_phone_app`**

Read and execute
[the shared creation skill](${PLUGIN_ROOT}/skills/create-mobile-app/SKILL.md)
with the original arguments plus `--prototype --gated`. Forward the selected
working directory and any authoring-context descriptor unchanged.

This is a thin entry wrapper: do not duplicate planning, introduce a new agent,
resolve an environment, query app-name collisions, run `power-apps init`,
configure auth, create services, or start an independent preview before handing
off. The shared profile is selected before Phase 0. Its real local
repositories, canonical fixtures, approval gates, and validated candidate
publication are required; a static mock screen is not a completed app.
`prototype` is an internal compatibility name, never the user-facing product label.
