# Conversation beats

Rationale and example phrasing for phases 2–5 of the `security-review` skill. SKILL.md owns the executable workflow; this file explains *why* each user-facing beat looks the way it does so future edits stay consistent.

Phases 1 (prerequisites) and 6 (cleanup) are silent — no conversation beat.

## Phase 2 — Ask the goal

One question, three answers. The three goals match the most common reasons a user opens a Power Pages security review:

| Goal | When to use it |
|------|-----------------|
| Code & config | Frequent checks during development — pre-commit / pre-PR safety check. Covers source code and dependency scanning plus Access & Data Security Validation (authentication, roles, table permissions) on local files. |
| Release readiness | Last comprehensive check before pushing to production. Adds live site scan, browser headers, and firewall on top of access checks. |
| Deployed site | Detect runtime issues from real user traffic on a deployed site. |

Authentication and authorization checks (**Access & Data Security Validation**) are the focus of Code & config and are also bundled into Release readiness rather than being a separate goal. Splitting them into their own option created confusion about when to use them versus the other goals.

Why not start by asking the user which skills to run? Because most users — including engineers — do not know the skill names yet, and listing them upfront reads as menu-driven interrogation. Ask the *outcome* the user wants and let the skill pick the right skills.

Why no follow-up "are you sure?" prompt? Because the user just answered that question by picking a goal — asking again is friction without information. Surface any duration caveats inside the in-progress status line in phase 3 instead.

## Phase 3 — Scan in progress

Skills run as **parallel subagents launched in one batch** (see SKILL.md § 3.1). Open with a single line that names the slow check up front, then post a short progress line as each subagent completes. Examples:

- "Starting checks — the live site scan can take several minutes. You can keep working while it runs."
- "Permissions check finished — 1 important issue, 2 smaller ones."
- "Live site scan finished — no critical issues found."
- "All checks are complete."

Do not narrate per-rule progress. Do not list every file scanned. The user wants reassurance, not telemetry.

## Phase 4 — Results summary and findings

After all subagents complete, the skill builds the consolidated HTML and shows, in chat:

- A one-line headline ("All clear", or "1 important item to address", or "3 critical and 5 warning findings").
- A two-line context sentence ("We checked X, Y, Z. We found N important and M smaller issues.").
- A pointer to the saved HTML report.

Put detail in the report, not in the chat. The HTML carries the per-section findings cards (title, severity, location, why this matters, suggested fix); the chat just orients the user.

## Phase 5 — Next steps and guidance

After the user has had a moment with the report, offer the next action with one `AskUserQuestion`: walk through the criticals now, re-run after changes, or stop here. Pick the option list to match the current state — if there are zero criticals, the offer to "walk through criticals" is not the first option.

Always end with concrete, actionable next steps. Examples:

- "Fix the three critical items in **Browser headers** (`/manage-headers`)."
- "Run the full live-site scan once the headers are deployed (`/scan-site`)."
- "Add a rate-limit rule to your sign-in pages (`/manage-firewall`)."

The next steps are also stored in the consolidated HTML so the user can refer back to them after the chat session is over.
