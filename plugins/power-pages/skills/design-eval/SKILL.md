---
name: design-eval
description: >-
  Evaluates the design quality of a Power Pages code site (SPA) and helps fix what it finds. Captures
  every page at desktop and mobile widths, measures accessibility, responsiveness, typography, color,
  spacing, imagery and motion, has an independent reviewer judge the screenshots against a fixed
  design checklist, and computes 1-5 scores for Message & Persuasion, Usability & Accessibility and
  Visual Craft & Brand, plus critical gates and a verdict. Writes an HTML report and opens it, shows
  the top major issues, fixes the ones the user picks, and offers to evaluate again. Use when the user
  wants to run a design evaluation, design validation, design or UI quality check, design audit, or
  grade or score their site's design, or after create-site finishes.
user-invocable: true
argument-hint: "[optional: project path or dev server URL]"
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion, Agent, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Design Evaluation

Evaluate a Power Pages code site's design, report what is wrong, and fix what the user chooses.
The method and checklist are `${PLUGIN_ROOT}/references/design-rubric.md` and `${PLUGIN_ROOT}/references/design-rubric-checks.md`: a reviewer **finds issues** against a closed checklist, and a formula turns them into scores. Never choose a score or a severity yourself.

**Initial request:** $ARGUMENTS

## Core Principles

- **Independent judgment.** The screenshots are judged by the `design-judge` agent in a fresh context, so the session that built or fixed the site does not grade its own work.
- **Values stay data.** The dev server URL, routes and project path go to the scripts only inside a JSON request on stdin in a quoted heredoc, never as command-line arguments.
- **Nothing runs from the project except its own dev server.** The scripts use the plugin's pinned Playwright and read project files only for source hints.
- **Fix only what the user picks**, at the source of the problem: design tokens and the theme file first, components second.

## Workflow

1. **Resolve the site** - project, dev server URL, routes, and brief
2. **Collect** - capture and measure every route
3. **Judge** - the `design-judge` agent answers the checklist
4. **Grade and report** - scores, gates, verdict; open the HTML report
5. **Present** - verdict, scores, and the top major issues
6. **Fix** - the issues the user picks
7. **Re-evaluate** - offer another run and show before and after

Create one task per step with `TaskCreate` at the start; mark each `in_progress` when you begin it and `completed` when it is done.

---

## 1. Resolve the site

1. **Project.** Use the path in `$ARGUMENTS`, otherwise the current directory, as `PROJECT_ROOT`; it must contain `powerpages.config.json`. Search one level down with `Glob` when it is not at the top. This skill evaluates code sites (React, Vue, Angular, Astro); for a non-SPA (classic) site, say that `/design-eval` supports code sites and suggest `/exceptional-web-design` instead, then stop.
2. **Dev server.** Use a URL in `$ARGUMENTS`, or one already running from this session (for example the dev server `create-site` started). Otherwise check the usual local URLs (`http://localhost:5173`, `:4200`, `:4321`) with `curl -s -o /dev/null -w "%{http_code}"`. When none responds, start `npm run dev` in `PROJECT_ROOT` in the background, read its local URL from the output, and wait until it responds.

   <!-- not-a-gate: data-gathering - asks for the dev server URL only when none can be found or started; nothing has been evaluated or changed yet -->

   If no server can be found or started, use `AskUserQuestion` to ask for the URL where the site runs.
3. **Routes.** Take every static route from the router (`${PLUGIN_ROOT}/references/framework-conventions.md`, Route Discovery); skip routes with parameters or wildcards. Evaluate at most 10; when there are more, keep the home page, the pages that serve the primary action, and one of each distinct page type, and list the rest as not evaluated.
4. **Brief.** When `PROJECT_ROOT/docs/create-site-plan.html` exists, read the site's purpose, audience and primary action from it. Otherwise infer them in one or two lines from the home page. The brief helps the judge with first-impression and proof items.

**Done when** `PROJECT_ROOT`, `SITE_URL`, the route list, and the brief are set.

## 2. Collect

```bash
node "${PLUGIN_ROOT}/skills/design-eval/scripts/collect.js" --input - <<'REQUEST'
{"url": "<SITE_URL>", "routes": ["/", "/about"], "project": "<PROJECT_ROOT>"}
REQUEST
```

Write each value as a JSON string (escape `"` and `\`). The script captures every route at 1440px and 390px wide, measures each page, runs the axe-core accessibility audit, and writes `evidence.json` and screenshots into a new run folder, `<PROJECT_ROOT>/docs/design-eval/<timestamp>/`. It prints `runDir`, each route's load status, and any coverage gaps.

If no route loaded, the dev server is not serving the site: fix that and collect again. Routes that failed to load are reported in step 5 and make the verdict **Incomplete**.

Then list the measured candidates for the judge:

```bash
node "${PLUGIN_ROOT}/skills/design-eval/scripts/grade.js" --input - <<'REQUEST'
{"action": "candidates", "dir": "<runDir>"}
REQUEST
```

On a re-run, the script also writes `recheck.json`: the checklist items that failed in the previous run, which the judge must re-check rather than judge afresh.

**Done when** `runDir/evidence.json` and `runDir/candidates.json` exist.

## 3. Judge

Spawn the **design-judge** agent with the `Agent` tool. Do not open the screenshots yourself. Pass a prompt like:

> Judge the design evaluation run at `<runDir>`. Brief: `<purpose>`; audience: `<audience>`; primary action: `<primary action>`. Write `<runDir>/judgments.json` as your instructions describe.

If the `Agent` tool is unavailable in this host, follow `${PLUGIN_ROOT}/agents/design-judge.md` yourself, judging only from the screenshots and the checklist, and say in step 5 that the judgment ran in this session.

**Done when** `<runDir>/judgments.json` exists.

## 4. Grade and report

```bash
node "${PLUGIN_ROOT}/skills/design-eval/scripts/grade.js" --input - <<'REQUEST'
{"action": "grade", "dir": "<runDir>"}
REQUEST
```

The script validates the judgments, computes the scores, gates and verdict, adds `file:line` source hints, writes `<runDir>/report.html` and `grade.json`, and opens the report in the default browser.

- When it exits 1 listing missing or invalid judgments, send the list back to the `design-judge` agent (or fix `judgments.json` the same way when judging in this session) and grade again.
- When `opened` is false, give the user the report path to open.

**Done when** the script prints a verdict.

## 5. Present

From the grade output, write a short summary:

1. **Verdict** (Not ready, Incomplete, Needs revision, or Ready) and its meaning, with each failing critical gate.
2. **Scores** - one line per category: `Category - score / 5 - majors and minors`. When `previous` is present, show each score as `before -> after`, then the issues in `resolvedSinceLast` (fixed) and `newSinceLast` (new, including any a fix introduced).
3. **Top issues** - the `topIssues` from the output (at most four, critical gates first). For each:
   - **Issue** - its title, page and viewport, and the gate if any.
   - **Why** - what a visitor experiences, in one sentence, from its evidence.
   - **Fix** - the first fix step made specific to this site, and the source file and line from `source`.
4. One line with the number of further major and minor issues, coverage gaps or routes not evaluated, and the report path.

When the verdict is **Ready** and there are no top issues, say so, mention the minor issues in the report, and finish with the summary in step 7's last bullet.

## 6. Fix

<!-- gate: design-eval:6.fix-select | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · design-eval:6.fix-select):** Choose which reported issues to fix. Fires once per evaluation round, after the summary.
>
> **Trigger:** Step 5 has shown at least one top issue.
> **Why we ask:** Fixing edits the site's theme and components; the user decides which design changes to make.
> **Cancel leaves:** Nothing - the report and run folder stay in `docs/design-eval/`; no site files change.

Use `AskUserQuestion` with `multiSelect: true`, question *"Which issues should I fix?"*, one option per top issue (label: its short title; description: the one-line fix), plus **None for now**.

For each selected issue, in rank order:

1. Read the source hints and the issue's fix steps in `<runDir>/grade.json`.
2. Make the change at the source of the problem: a design token or the theme file first, then the shared component, and only then a single page. Follow `${PLUGIN_ROOT}/references/design-aesthetics.md` and keep WCAG 2.2 AA.
3. Check the dev server still serves the affected routes without errors.

When the project is a git repository, commit the fixes with a message naming the fixed issues. When `PROJECT_ROOT/.powerpages-site` exists, note that the site must be redeployed (`/deploy-site`) for the fixes to reach Power Pages.

If the user picked **None for now**, go to the final summary in step 7.

## 7. Re-evaluate

<!-- gate: design-eval:7.rerun | category=plan | cancel-leaves=applied-design-fixes -->

> 🚦 **Gate (plan · design-eval:7.rerun):** Offer another evaluation round after fixes. Fires once per round in which fixes were applied.
>
> **Trigger:** Step 6 applied at least one fix.
> **Why we ask:** A new round takes a few minutes and re-captures every route; the user may prefer to review the fixes first.
> **Cancel leaves:** The applied (and committed, when git is used) fixes stay in the site; no new evaluation run is created.

Use `AskUserQuestion`: *"I've fixed the selected issues. Run the design evaluation again to confirm them?"* with **Run again (Recommended)** and **Not now**.

- **Run again** - return to step 2 with the same routes, then steps 3-5; step 5 shows the before and after scores from `previous`.
- **Not now** - finish with a summary: the latest verdict and scores, the issues fixed this session, the issues still open, and the report path.

---

## Important Notes

- **Report location.** Every run keeps its own folder under `docs/design-eval/`, so earlier reports remain for comparison. Suggest adding `docs/design-eval/` to `.gitignore` when the user does not want reports committed.
- **What is not evaluated.** Pages that need sign-in, data that only loads from a live Power Pages environment, and routes beyond the ten-route limit. Say so rather than guessing.
- **Consistency.** Scores come only from the grade script. Repeat runs on an unchanged site can differ only where the judge's checklist answers differ, which the PASS and FAIL examples keep narrow.
