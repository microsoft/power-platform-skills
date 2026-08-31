---
name: run-functional-eval
description: >
  Run native AppGen functional evals from the current branch of power-platform-evals,
  and save a timestamped artifact folder with canonical evidence and Product reports.
user-invocable: true
argument-hint: "<URL containing appId and envId> <Q prompt ID> [user UPN]"
allowed-tools: Read, Bash, AskUserQuestion
model: sonnet
---

**Workflow: [run-functional-eval-workflow.md](${PLUGIN_ROOT}/skills/run-functional-eval/run-functional-eval-workflow.md)** - Read and follow all phases defined in that bundled file.
