---
name: open-pr
description: >-
  Opens an Azure DevOps pull request from the bound branch to a target branch
  (usually main). Auto-generates a Power-Pages-friendly PR description from the
  recent commits ("Updated Web Template 'Header'", "Added Web Page 'Pricing'",
  etc.) via ado-render-pr-description.js, gathers title + target + reviewers,
  creates the PR via ado-create-pr.js, and surfaces the PR URL.
  Writes docs/inner-loop/last-pr.json.
  Use when asked: "open a pr", "create pull request", "open ado pr", "submit my
  changes for review", "open a pr from my feature branch to main", "raise a pr",
  "create the pr", "run open-pr".
user-invocable: true
argument-hint: "Optional: PR title in quotes"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate, TaskUpdate, TaskList, AskUserQuestion
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Open PR

Opens an Azure DevOps pull request from the bound branch to a target branch (default `main`) with an auto-generated, Power-Pages-friendly description. Uses `ado-render-pr-description.js` to translate raw commit messages into maker-friendly bullets, then calls `ado-create-pr.js` to submit the PR.

## Overview

The `git-sync` commit flow already pushed your work to the bound branch; this skill is the next step — surfacing those commits for review. The auto-generated description summarises *what* the commits did in Power Pages terms (web templates, web pages, site settings, etc.) rather than dumping raw commit messages, so reviewers don't need to read solution XML.

This skill is the typical exit point of the inner-loop daily cycle. After the PR merges (manually in ADO — v1 does not include a `merge-pr` skill), teammates run `/power-pages:git-sync --pull` to pick up the merged content.

> 🛈 **PR file diff is often `<<` maker-portal Changes count (HAR-confirmed 2026-06).** A 44-Change → 1-commit → 1-file-diff PR is normal, not a partial commit. Environment-side dedupe means many "Changes" re-serialize to bit-identical YAML and produce no file-level diff. Phase 1's nothing-to-PR gate uses commit count (not file count) — a 1-commit / 0-file PR is still valid. See [`references/inner-loop-empirical-findings.md`](../../references/inner-loop-empirical-findings.md) §19.

> 🛈 **ADO Complete dialog offers 4 merge types (HAR-confirmed 2026-06).** The maker chooses at completion time — this skill must not hardcode one. Default recommendation for solo Power Pages inner-loop PRs is **Squash commit** (keeps `main` linear and one-commit-per-PR for easy revert); for multi-maker PRs prefer **Merge (no fast forward)** to preserve per-commit attribution. **Rebase and fast-forward** / **Semi-linear merge** are rare for solution-shaped diffs. See [`references/inner-loop-empirical-findings.md`](../../references/inner-loop-empirical-findings.md) §16.

> 🛈 **Bound-branch-deletion advisory (HAR-confirmed 2026-06).** ADO's *"Delete `<sourceBranch>` after merging"* checkbox is ticked by default. When the maker accepts that AND the env is bound to the source branch, the maker portal Source control page surfaces a sticky red banner: *"connected … branch does not exist or you do not have access to it."* Phase 9 final gate must surface this advisory BEFORE the user clicks Complete in ADO, and route them to `/power-pages:git-configure --mode=switch-branch` for recovery. See [`references/inner-loop-empirical-findings.md`](../../references/inner-loop-empirical-findings.md) §15.

**References:**
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-flow.md` §3 (Clean state — `open-pr` is one of the suggested follow-ups)
- `${CLAUDE_PLUGIN_ROOT}/references/git-integration-prerequisites.md` (ADO PAT scopes — needs `Pull request contributor` on the target repo)
- `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-empirical-findings.md` §15 (deleted-branch banner) + §16 (4 merge types) + §19 (Changes-vs-files mismatch)

## Prerequisites

- PAC CLI installed and authenticated
- Azure CLI installed and logged in
- A Git binding already established (run `/power-pages:git-configure` first if needed)
- An ADO PAT with `Code (read & write)` AND `Pull request contributor` on the bound repo
- At least one commit on the bound branch that is NOT yet on the target branch (otherwise the PR has no content)

**Initial request:** $ARGUMENTS

**User-facing voice:** speak plainly. See `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-user-language.md` for the authoring rules — no raw API names, raw JSON, or GUIDs in user chat (except on failure); show progress as sequential `Phase {N} — {plainTitle}` (internal phase numbers stay internal).

---

## Phase 1 — Binding Check + Nothing-to-PR Short Circuit

**Goal:** Confirm a binding exists and that there is actually something to PR — a branch that's already even with its target has no content for a pull request.

**Do NOT create tasks yet.** Use natural-language progress reporting only during this phase.

Steps:

1. Verify PAC CLI auth and acquire an env-scoped token:

   ```bash
   pac env who --json
   az account get-access-token --resource <envUrl> --query expiresOn -o tsv
   ```

2. Check the Git binding state:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/detect-git-binding.js" --envUrl "<envUrl>"
   ```

   **Manifest reconcile (B3).** Compare the local `.git-integration-manifest.json` against this server truth using `reconcileManifest({ manifest, serverBinding })` from `${CLAUDE_PLUGIN_ROOT}/scripts/lib/reconcile-manifest.js`; see `${CLAUDE_PLUGIN_ROOT}/references/manifest-contract.md` for the full contract.
   <!-- gate: open-pr:1.manifest-stale | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · open-pr:1.manifest-stale):** When `aligned:false`, surface the divergence and let the user choose from the helper's returned `options` (`overwrite-from-server`, `rebind-old-coords`, `clear-local`) before proceeding; cancellation leaves the manifest untouched.

   If `bound === false`:

   <!-- gate: open-pr:1.no-binding | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · open-pr:1.no-binding):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | No Git binding found for this environment. Set one up first? | Not bound to Git | Run /power-pages:git-configure, Cancel |

3. Capture binding fields: `organization`, `project`, `repository`, `branch` (the bound branch = `sourceBranch`).

4. Compute the commit delta between `sourceBranch` and the candidate target (default `main`):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-list-commits.js" \
       --organization "<org>" \
       --project      "<proj>" \
       --repository   "<repo>" \
       --branch       "<sourceBranch>" \
       --token        "<adoToken>" \
       --top          20
   ```

   Also list the target branch's recent commits. Identify how many `sourceBranch` commits are NOT already in `mainBranch`. If `0`, there is nothing to PR:

   <!-- gate: open-pr:1.nothing-to-pr | category=intent | cancel-leaves=nothing -->
   > 🚦 **Gate (intent · open-pr:1.nothing-to-pr):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Branch `{sourceBranch}` has no commits ahead of `{targetBranch}` — there's nothing to put in a PR. | Nothing to PR | Run /power-pages:git-sync --commit first (push pending changes), Pick a different target branch, Exit |

   *(Note: if the source/target detection is unreliable on the chosen helper, default `targetBranch` to `main` and surface the count as best-effort; do not block PR creation when the count cannot be computed.)*

**Output:** Confirmed binding + N > 0 commits ahead of target branch.

---

## Phase 2 — Read Recent Commits on Bound Branch

**Goal:** Pull the commit list that will drive the auto-generated PR description.

Tasks to create (`TaskCreate`):

1. Read recent commits on bound branch
2. Translate commits to PP-friendly description
3. Gather PR title + target branch + reviewers
4. Render PR plan
5. Final consent before PR creation
6. Execute `ado-create-pr.js`
7. Verify PR exists; capture URL
8. Write `last-pr.json` marker
9. Final gate

Steps:

1. Re-use the Phase 1 commit list (`ado-list-commits.js` output) — those commits are the ones the PR will surface.

2. For each commit, record `{ sha, author, messageFirstLine }`. Hold this list for Phase 3.

**Output:** A list of commit objects ready for the description renderer.

---

## Phase 3 — Translate Commits to Power-Pages-Friendly Description

**Goal:** Run the commit list through the description renderer so the PR body speaks in Power Pages component terms (Web Template / Web Page / Site Setting / etc.) instead of raw commit subjects.

Steps:

1. Write the commit array (or `list-pending-changes`-style items if available from a prior cached run) to a temp JSON file and call:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-render-pr-description.js" \
       --items-file "<tempPath>"
   ```

   Expected output: `{ markdown: "<full PR description>", summary: "<one-line summary>" }`.

2. Capture:
   - `description` (the `markdown` field — used as the PR body)
   - `suggestedTitle` (the `summary` field — used to pre-populate the title prompt)

**Output:** A markdown PR description + a one-line suggested title.

---

## Phase 4 — Gather PR Title, Target Branch, Reviewers

**Goal:** Collect the remaining free-text fields needed to create the PR.

Steps:

1. `open-pr:4.pr-title` (not-a-gate — data-gathering): prompt for PR title. Pre-populate with `suggestedTitle` from Phase 3 (or the user's invocation argument if they passed one). Validate: non-empty, ≤ 250 characters.

2. Confirm target branch. Default to `main`; if the user wants a different target, collect it as free text and validate it exists in the ADO repo via `ado-list-commits.js --branch <candidate> --top 1`.

3. `open-pr:4.reviewers` (not-a-gate — data-gathering): optionally prompt for reviewers. Accept a comma-separated list of AAD object IDs OR team display names. Skip cleanly if the user has none — reviewers can always be added in the ADO PR UI later.

**Output:** `{ title, targetBranch, reviewers[] }`.

---

## Phase 5 — Render PR Plan

**Goal:** Show the full PR plan (title + source / target + description + reviewers) and gate on plan approval. The user can choose to use the auto-generated description as-is or edit it before consent.

Steps:

1. Compose and display:

   ```
   PR plan
     Source:      <sourceBranch>
     Target:      <targetBranch>
     Title:       <title>
     Reviewers:   <comma-list or "none">

   Description (auto-generated)
   ─────────────────────────────────
   <markdown>
   ─────────────────────────────────
   ```

2. <!-- gate: open-pr:5.plan | category=plan | cancel-leaves=nothing -->
   > 🚦 **Gate (plan · open-pr:5.plan):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Use this auto-generated PR description? | PR description review | Yes — use as-is (Recommended), Let me edit the description first, Cancel |

   - **Edit** → collect a replacement markdown body via `AskUserQuestion` (free text). Replace `description` and re-display the plan. Loop until the user accepts or cancels.
   - **Cancel** → exit; no PR created.

**Output:** Final approved PR plan including the description.

---

## Phase 6 — Final Consent + Execute

**Goal:** Final consent before any ADO mutation, then call `ado-create-pr.js`.

Steps:

1. <!-- gate: open-pr:6.consent | category=consent | cancel-leaves=nothing -->
   > 🚦 **Gate (consent · open-pr:6.consent):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | Final consent — create PR `{title}` from `{sourceBranch}` to `{targetBranch}` in `{org}/{project}/{repository}` now? | Final consent | Create PR now, Cancel |

2. On **Create PR now**:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ado-create-pr.js" \
       --organization  "<org>" \
       --project       "<proj>" \
       --repository    "<repo>" \
       --sourceBranch  "<sourceBranch>" \
       --targetBranch  "<targetBranch>" \
       --title         "<title>" \
       --description   "<description>" \
       [--reviewers    "<id1>,<id2>"] \
       [--pat          "<adoPAT>"]
   ```

3. Error handling:
   - **400 with "active pull request already exists"** → the helper should return the existing PR's URL; surface it as success and route to Phase 8.
   - **403** → PAT lacks `Pull request contributor` scope. Surface remediation.
   - **5xx** → transient; retry once.

**Output:** `{ pullRequestId, url, title, sourceBranch, targetBranch, status: "active" }`.

---

## Phase 7 — Verify PR Exists; Capture URL

**Goal:** Confirm the PR landed by re-reading it and capture the canonical URL (the helper may have normalised it).

Steps:

1. Use the `pullRequestId` from Phase 6 to re-query via `ado-get-pr.js` (or trust the helper response if it returned a verified URL). Record the canonical PR URL.

**Output:** Canonical PR URL captured.

---

## Phase 8 — Write `last-pr.json` Marker

**Goal:** Persist the audit marker.

Steps:

1. Write `docs/inner-loop/last-pr.json`:

   ```json
   {
     "skill":         "open-pr",
     "createdAt":     "<ISO>",
     "envUrl":        "<envUrl>",
     "organization":  "<org>",
     "project":       "<proj>",
     "repository":    "<repo>",
     "sourceBranch":  "<sourceBranch>",
     "targetBranch":  "<targetBranch>",
     "pullRequestId": <int>,
     "title":         "<title>",
     "url":           "<canonical URL>",
     "reviewers":     ["<id>", ...],
     "commitCount":   N,
     "status":        "active"
   }
   ```

   The path is registered in `scripts/lib/inner-loop-paths.js` under the key `lastPr`.

**Output:** `docs/inner-loop/last-pr.json` written.

---

## Phase 9 — Final Gate

**Goal:** Show the PR URL and route the user to open it in the browser.

Steps:

1. <!-- gate: open-pr:9.final | category=final | cancel-leaves=nothing -->
   > 🚦 **Gate (final · open-pr:9.final):** Surface `AskUserQuestion`:

   | Question | Header | Options |
   |---|---|---|
   | PR #{pullRequestId} created: `{url}` — open it in the browser? | PR ready | Open in browser, Done — exit |

### Record Skill Usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "OpenPr"`.

**Output:** User routed to PR URL or exits.

---

## Artifacts Written

| File | Location | Purpose |
|---|---|---|
| `last-pr.json` | `docs/inner-loop/` | Skill-run marker; validated by `validate-open-pr.js`. |

---

## Progress Tracking Table

| Task subject | activeForm | Description |
|---|---|---|
| Read recent commits on bound branch | Reading recent commits | Call `ado-list-commits.js`; capture commits ahead of target |
| Translate commits to PP-friendly description | Rendering PR description | Call `ado-render-pr-description.js` to translate commits into Power-Pages-friendly markdown |
| Gather PR title + target branch + reviewers | Gathering PR fields | Collect title (pre-populated with suggestedTitle), target branch (default main), reviewers (optional) |
| Render PR plan | Rendering PR plan | Display source / target / title / description / reviewers; allow user to edit description |
| Final consent before PR creation | Awaiting PR consent | Surface explicit consent gate before any ADO mutation |
| Execute `ado-create-pr.js` | Creating PR | Call helper; handle 400 (existing PR), 403 (PAT scope), 5xx (retry once) |
| Verify PR exists; capture URL | Verifying PR | Re-query / trust helper response; capture canonical URL |
| Write `last-pr.json` marker | Writing PR marker | Persist `docs/inner-loop/last-pr.json` with PR ID, URL, branches, reviewers |
| Final gate | Finalising PR | Offer open-in-browser; exit |

---

## Key Decision Points (Wait for User)

1. **Phase 1**: If no Git binding exists → run `git-configure` or cancel (gate `open-pr:1.no-binding`).
2. **Phase 1**: If nothing-to-PR (0 commits ahead) → commit first, pick a different target, or exit (gate `open-pr:1.nothing-to-pr`).
3. **Phase 4**: PR title (data-gathering, not a gate).
4. **Phase 4**: Target branch (default `main`; conversational if different).
5. **Phase 4**: Reviewers (data-gathering, not a gate; optional).
6. **Phase 5**: Use auto-description, edit, or cancel (gate `open-pr:5.plan`).
7. **Phase 6**: Final consent before `ado-create-pr.js` (gate `open-pr:6.consent`).
8. **Phase 9**: Open PR in browser, or exit (gate `open-pr:9.final`).

---

## Error Handling

- **Target branch does not exist**: surface the gap; offer to pick a different existing target. Do NOT auto-create the branch.
- **`ado-create-pr.js` returns 400 "active pull request already exists"**: surface the existing PR's URL as success — re-opening a PR is idempotent for the user's intent.
- **`ado-create-pr.js` returns 403**: ADO PAT lacks `Pull request contributor` (or `Code (write)`) scope. Surface the remediation from `${CLAUDE_PLUGIN_ROOT}/references/git-integration-prerequisites.md`; do NOT auto-bypass.
- **`ado-create-pr.js` returns 5xx**: transient; retry once. If second attempt fails, surface verbatim. The marker is NOT written on failure.
- **Phase 3 renderer fails**: degrade gracefully — assemble a minimal description from raw commit messages (one bullet per commit). The PR is still useful even without the maker-friendly translation.
- **Reviewer ID resolution fails** (unknown AAD object): drop the unresolved reviewer from the list, surface a one-line warning, continue creating the PR with the resolved subset.

---

**Begin with Phase 1: Binding Check + Nothing-to-PR Short Circuit**
