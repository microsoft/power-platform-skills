---
name: report-issue
description: >
  Use this skill when the user wants to "report a bug", "file an issue",
  "report an issue", "submit a bug report", or report any problem
  with the power-pages plugin to the GitHub repository.
user-invocable: true
argument-hint: "[optional: brief description of the bug]"
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

**Shared workflow: [report-issue-workflow.md](${CLAUDE_PLUGIN_ROOT}/../../shared/skills/report-issue/report-issue-workflow.md)** — Read and follow all phases defined in that file.
