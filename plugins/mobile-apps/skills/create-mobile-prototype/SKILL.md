---
name: create-mobile-prototype
description: Create a working local-data Power Apps mobile prototype without selecting an environment, signing in, provisioning Dataverse, or generating fake services. Uses the shared create-mobile-app workflow.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Task, EnterPlanMode, ExitPlanMode
model: opus
---

# Create a local mobile prototype

Read [shared core](${PLUGIN_ROOT}/shared/shared-instructions-core.md).
Read and execute
[the shared creation skill](${PLUGIN_ROOT}/skills/create-mobile-app/SKILL.md)
with the original arguments plus `--prototype --gated`. Forward the selected
working directory and any authoring-context descriptor unchanged.

This is a thin entry wrapper: do not duplicate planning, introduce a new agent,
resolve an environment, query app-name collisions, run `power-apps init`,
configure auth, create services, or start an independent preview before handing
off. The shared profile is selected before Phase 0. Its real local
repositories, canonical fixtures, approval gates, and validated candidate
publication are required; a static mock screen is not a completed prototype.
