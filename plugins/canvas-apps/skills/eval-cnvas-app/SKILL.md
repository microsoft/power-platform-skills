---
name: eval-cnvas-app
description: Run a functional evaluation for a Power Apps URL containing appId and envId, optionally using a specified Power Apps user, publish report.html, and send eval metrics to Kusto using its authored Q prompt scenarios. USE WHEN "EvalCnvasApp", "eval canvas app URL", "evaluate this canvas app", "run eval for app URL", "test published canvas app".
user-invocable: true
argument-hint: "<URL containing appId and envId> [prompt ID, for example Q15] [user UPN]"
allowed-tools: Read, Bash, AskUserQuestion
model: sonnet
---

# EvalCnvasApp

**Workflow: [eval-cnvas-app-workflow.md](${PLUGIN_ROOT}/skills/eval-cnvas-app/eval-cnvas-app-workflow.md)** - Read and follow all phases defined in that bundled file.
