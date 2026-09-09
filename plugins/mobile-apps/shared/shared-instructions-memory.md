# Memory bank and sub-skill context

The per-project notebook is `<working_dir>/memory-bank.md`.

1. Read it at entry: Project facts, Power Platform context, Data model, Connectors, Screens,
   Build history, policies and blocks. Summarize findings unless the caller just did.
2. Ask whether to resume/redo completed work. Resume from the first incomplete step, not a
   guessed state derived from `package.json` or installed dependencies.
3. After each successful step, append a short ISO-dated entry in its relevant section.
   Never delete history; mark superseded entries. Never record success before verification.
4. On failure, retain exact unfinished step/artifact paths and non-secret diagnostics.
   Respect the foreground workflow's planning-only write restriction until bank creation.

Maintain the existing Project facts fields, not another state sidecar:
- `Current phase`: last validated phase and next phase reference.
- `Pending decision`: exact unanswered foreground question, or none after an explicit answer.
- `Approved preview`: accepted intent-preview path and represented plan/design revision;
  never evidence that native/data runtime behavior passed.
If the plan/design changes, mark the old preview record superseded until reviewed again.
Before bank creation keep these facts in foreground context; flush them when Step 6.7 seeds it.

`/create-mobile-app` seeds from [memory-bank.md](${PLUGIN_ROOT}/shared/memory-bank.md) at Step 6.7,
after init and the scaffold gate. Preserve an existing bank during confirmed resume.
Queue early concerns/discovery notes and flush them immediately after seeding.

## Sub-skill invocation

- Use caller arguments and `working_dir`; never silently default to another process cwd.
- Reuse supplied plan, environment and answers; no redundant questions.
- `--skip-planning` means an approved plan is supplied, not permission to invent approval.
- Read the bank but skip repeated summary. Keep project-local scratch files under `.tmp/`.
- Reread a file before a second edit, especially after generators or another worker changed it.
  Use a single structural rename/sweep rather than stale line-by-line replacements.
- Use the host's available progress/todo tool when useful; do not invent a required tool name.
