# The Seven-Step Conversation

This document walks through the conversation pattern the `security-review` skill uses, with the questions and the rationale behind each step. The skill's SKILL.md contains the executable workflow — this file explains *why* the conversation looks the way it does so future revisions stay consistent.

## Step 1 — Ask the goal

One question, three answers. The three goals match the most common reasons a user opens a Power Pages security review:

| Goal | When to use it |
|------|-----------------|
| Code and config | Frequent checks during development — pre-commit / pre-PR safety check. Includes Access & Data Security Validation (authentication, roles, table permissions). |
| Release readiness | Last comprehensive check before pushing to production. Includes everything in Code and config plus live site scan, browser headers, and firewall. |
| Deployed site | Detect runtime issues from real user traffic on a deployed site. |

Authentication and authorization checks (**Access & Data Security Validation**) are part of both Code and config and Release readiness rather than a separate goal. This is the most frequent security concern, and splitting it into its own option created confusion about when to use it versus the other goals.

Why not start by asking the user which skills to run? Because most users — including engineers — do not know the skill names yet, and listing them upfront reads as menu-driven interrogation. Ask the *outcome* the user wants and let the skill pick the right skills.

## Step 2 — Choose scope and depth

The follow-up question depends on the goal. The choices map to concrete skill behavior — basic vs. advanced code scan, and so on.

For code-and-config there are two depth tiers: Basic (OWASP Top Ten ruleset, good balance) and Advanced (full security audit ruleset, slower). Three tiers added complexity without clear user benefit — the difference between basic and advanced is mainly time, not token cost, since the scanning tools do the heavy lifting outside the context window.

Release readiness skips this step entirely and defaults to running every check at advanced depth.

## Step 3 — Confirm and start

Show a one-line plan in plain language and an explicit time estimate. Examples:

- "I will check your code, your packages, and your browser-side safety settings. This should take a few minutes."
- "I will scan your live site's public pages. This may take several minutes. You can keep working while it runs."

Confirmation matters because some skills are long-running. Surprising the user with an unexpectedly long wait is the fastest way to lose trust.

## Step 4 — Scan in progress

Skills run as **parallel subagents**. Long-running scans (`scan-code`, `scan-site`) launch first to get a head start, then the remaining checks launch immediately after. The user sees one progress line when each subagent completes. Examples:

- "All checks are running now…"
- "Code check finished — 2 important issues, 4 smaller ones."
- "Live site scan finished — no critical issues found."
- "All checks are complete."

Do not narrate per-rule progress. Do not list every file scanned. The user wants reassurance, not telemetry.

## Step 5 — Results summary

Show, in chat:

- A one-line headline ("All clear", or "1 important item to address", or "3 critical and 5 warning findings").
- A two-line context sentence ("We checked X, Y, Z. We found N important and M smaller issues.").
- A pointer to the saved HTML report.

Put detail in the report, not in the chat.

## Step 6 — Findings and remediation

When the user opens the report (Step 5), they see the consolidated view: totals followed by per-section sections that list **all** findings. Each finding card has the same structure (title, severity, location, why this matters, suggested fix).

After they have had a moment to look, offer the next action with one question: walk through the criticals now, re-run after changes, or stop here. Pick the option that makes sense based on the current state — if there are zero criticals, the offer to "walk through criticals" should not be the first option.

## Step 7 — Next steps and guidance

Always end with concrete, actionable next steps. Examples:

- "Fix the three critical items in **Browser headers** (`/manage-headers`)."
- "Run the full live-site scan once the headers are deployed (`/scan-site`)."
- "Add a rate-limit rule to your sign-in pages (`/manage-firewall`)."

The next steps are also stored in the consolidated HTML so the user can refer back to them after the chat session is over.
