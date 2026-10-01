---
name: audit-accessibility
description: >-
  Audits a running or deployed Power Pages site for accessibility issues. Crawls the
  site, runs axe-core WCAG 2.2 A/AA rules on desktop and mobile layouts, checks keyboard
  focus, 320 px reflow, 200% text, reduced motion, and page titles, audits hidden UI such
  as menus, dialogs, and tabs, and can audit signed-in pages. Produces a prioritized
  report with WCAG mapping and optional source fixes. Use when the user wants to check,
  audit, or improve the accessibility (a11y, WCAG) of their site.
user-invocable: true
argument-hint: "[site-url] [--routes /,/about] [--signed-in]"
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Audit Power Pages Site Accessibility

Find the accessibility barriers on a Power Pages site before your users do. This skill opens the site in a real browser, visits every page it can reach, and checks each one with automated rules and interaction tests. You get a prioritized report that maps each issue to WCAG, explains who it affects, and points to the fix.

> **Works on its own.** Run it any time — on a local dev server (`http://localhost:5173`) or a deployed site (`https://contoso.powerappsportals.com`). It doesn't depend on `/create-site` or `/test-site`, and it doesn't change how they work.

## Core Principles

- **Read-only by default**: The audit never changes site data or source code. Source edits happen only in Phase 7, after you approve a fix plan.
- **No data submission**: The audit never submits forms. Interaction states that would submit a form run only after explicit consent (Phase 4).
- **User-controlled sign-in**: The skill never types credentials. You sign in yourself in a browser window, and the saved session is deleted when the audit ends.
- **Deterministic browser work**: All browser automation runs through `${PLUGIN_ROOT}/scripts/a11y-audit.js`. Don't drive the browser any other way, and don't load axe-core from a CDN.
- **Honest coverage**: A page that didn't load wasn't audited. Report it as a gap, never as a pass. Automated checks find only part of WCAG, so every report includes the manual checks that remain.
- **Private raw data**: Raw reports and ARIA snapshots can contain page content, including personal data on signed-in pages. Keep them in the private run folder, and never copy raw HTML from signed-in pages into the project report.

**Initial request:** $ARGUMENTS

---

## Phase 1: Resolve the target

**Goal:** Find the site URL to audit and, when available, the local project that holds its source.

### Actions

#### 1.1 Create the task list

Create the full task list with all 8 phases before starting any work (see [Progress tracking](#progress-tracking)).

#### 1.2 Find the project root

Search for `**/powerpages.config.json` (code sites) or a `.powerpages-site/` folder (declarative sites). If found, store the folder as `PROJECT_ROOT`. A project root is optional — you can audit any site by URL — but Phase 7 fixes and the saved report need one.

#### 1.3 Resolve the site URL

1. If `$ARGUMENTS` contains an `http://` or `https://` URL, store it as `SITE_URL`.
2. Otherwise, if `PROJECT_ROOT` is set, run:

   ```bash
   node "${PLUGIN_ROOT}/scripts/check-activation-status.js" --projectRoot "<PROJECT_ROOT>"
   ```

   If `activated` is `true` and `websiteUrl` is present, use it as `SITE_URL` and tell the user: "Detected your site URL: **<websiteUrl>**".
3. Also note whether `$ARGUMENTS` mentions routes (`--routes`) or signed-in pages (`--signed-in`, "after sign-in", "authenticated"). Store them as `REQUESTED_ROUTES` and `WANTS_SIGNED_IN`.

#### 1.4 Ask for the URL when it can't be detected

<!-- not-a-gate: site-URL fallback prompt — data-gathering when no URL is provided or detected; no state change -->

If `SITE_URL` is still unknown, use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Which site do you want to audit? Paste a deployed URL (for example, https://contoso.powerappsportals.com) or a local dev server URL (for example, http://localhost:5173). | Site URL | I'll paste the URL (description: Select "Other" and paste the URL), Start my dev server first (description: Run `npm run dev` in your project, then re-run this skill with the local URL) |

#### 1.5 Create a private run folder

Create a private temp folder for raw output and store it as `RUN_DIR`:

```bash
node -e "process.stdout.write(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'pp-a11y-run-')))"
```

### Output

- `SITE_URL` (required), `PROJECT_ROOT` (optional), `RUN_DIR`

---

## Phase 2: Prepare audit tools

**Goal:** Make sure the pinned browser automation and axe-core packages are available.

### Actions

#### 2.1 Check for the audit packages

The audit uses pinned versions of `playwright-core` and `axe-core`, installed once into a private per-user cache — never into the site project. It uses the Microsoft Edge or Google Chrome browser already on the machine.

Check that everything loads by auditing just the home page once:

```bash
node "${PLUGIN_ROOT}/scripts/a11y-audit.js" --url "<SITE_URL>" --viewports desktop --checks axe --output "<RUN_DIR>/probe.json"
```

- **Exit 0, 1, or 3**: Tools are ready. Continue to Phase 3. (Exit 1 or 3 only describes the home page; Phases 4 and 5 report it properly.)
- **Exit 4 and the message mentions `playwright-core` or `axe-core`**: Go to step 2.2.
- **Exit 4 and the message mentions the browser**: Tell the user to install Microsoft Edge or Google Chrome, then stop.
- **Exit 2**: Fix the arguments (usually a malformed URL) and retry.

#### 2.2 Install the audit packages

<!-- gate: audit-accessibility:2.install-deps | category=consent | cancel-leaves=nothing -->

> 🚦 **Gate (consent · audit-accessibility:2.install-deps):** Download the pinned audit packages from the npm registry into a per-user cache.
>
> **Trigger:** The check in step 2.1 exited 4 because `playwright-core` or `axe-core` is missing.
> **Why we ask:** It downloads packages from the internet and writes outside the project folder.
> **Cancel leaves:** nothing — no files are downloaded; the skill stops.

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| The accessibility audit needs two pinned packages, `playwright-core` and `axe-core`. They install once into a private per-user cache, not into your project, and every later audit reuses them. Install them now? | Install tools | Install and continue (Recommended), Cancel |

If approved, run:

```bash
node "${PLUGIN_ROOT}/scripts/install-a11y-deps.js"
```

Exit 0 means installed. On exit 1, show the error (usually a proxy or registry problem) and stop. Re-run the check from step 2.1 to confirm.

### Output

- Audit tools ready

---

## Phase 3: Plan the audit scope

**Goal:** Agree on what to audit before any long-running work starts.

### Actions

#### 3.1 Build the proposed scope

Propose defaults, adjusted by anything in `$ARGUMENTS`:

| Setting | Default | Flag |
|---------|---------|------|
| Pages | Start at `/` (plus `REQUESTED_ROUTES`) and follow same-origin links | `--routes`, `--crawl` |
| Page limit | 25 pages | `--max-pages` (max 200) |
| Layouts | Desktop (1280 px) and mobile (375 px) | `--viewports desktop,mobile` |
| Checks | axe-core WCAG A/AA, keyboard, reflow, 200% text, motion, titles | `--checks` |
| Best-practice rules | Included, reported as non-blocking | `--no-best-practice` |
| Hidden UI | Menus, dialogs, and tabs found in Phase 4 | `--states` |
| Signed-in pages | Only if `WANTS_SIGNED_IN` | `--auth-state` |

If `<PROJECT_ROOT>/docs/accessibility/a11y-states.json` exists from an earlier run, mention that its approved states can be reused in Phase 4.

#### 3.2 Confirm the scope

<!-- gate: audit-accessibility:3.scope | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · audit-accessibility:3.scope):** Approve the audit scope before the crawl starts.
>
> **Trigger:** Tools are ready and the proposed scope is shown.
> **Why we ask:** A crawl can take several minutes and load many pages on a live site; the user should choose its size and whether to sign in.
> **Cancel leaves:** nothing — only the home page has been loaded.

Show the scope table, then use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Here's the proposed accessibility audit. How do you want to run it? | Audit scope | Full audit (Recommended) (description: Crawl up to 25 pages, both layouts, all checks, and hidden menus and dialogs), Quick audit (description: Only the listed pages, both layouts, no hidden UI), Include signed-in pages (description: Full audit, and you sign in first so pages behind sign-in are audited too), Change scope (description: Adjust pages, layouts, checks, or limits) |

- **Full audit**: `CRAWL=true`, `AUDIT_STATES=true`.
- **Quick audit**: `CRAWL=false`, `AUDIT_STATES=false`. Skip Phase 4 and go to Phase 5.
- **Include signed-in pages**: Full audit plus step 3.3.
- **Change scope**: Ask what to change in plain text, update the table, and repeat this gate.

#### 3.3 Capture a signed-in session (optional)

Only when the user chose to include signed-in pages.

1. Start the capture as a background command. It opens a visible browser window at the site:

   ```bash
   node "${PLUGIN_ROOT}/scripts/a11y-capture-auth.js" --url "<SITE_URL>" --done-file "<RUN_DIR>/auth-done" --timeout-sec 900
   ```

<!-- gate: audit-accessibility:3.sign-in | category=pause | cancel-leaves=nothing -->

> 🚦 **Gate (pause · audit-accessibility:3.sign-in):** Wait while the user signs in through the browser window.
>
> **Trigger:** The sign-in capture window is open.
> **Why we ask:** Only the user can sign in; the skill never handles credentials.
> **Cancel leaves:** nothing — the skill ends the capture and deletes any saved session.

2. Use `AskUserQuestion`:

   | Question | Header | Options |
   |----------|--------|---------|
   | A browser window opened at your site. Sign in there with an account that can see the pages you want audited. When you can see the signed-in site, select "I've signed in". Don't sign out — that ends the session. | Sign in | I've signed in (Recommended), Skip signed-in pages |

3. Create the done file so the capture saves the session and exits:

   ```bash
   node -e "require('fs').writeFileSync(process.argv[1], '')" "<RUN_DIR>/auth-done"
   ```

4. Wait for the capture to finish and read its JSON output: `{ authState, cookies, domains, originsWithStorage }`. It never prints cookie values.
   - **I've signed in** and `cookies` is greater than 0: store `authState` as `AUTH_STATE`.
   - **I've signed in** but the capture exited 1 or `cookies` is 0: say the sign-in wasn't captured, delete the done file, and repeat this step from step 1.
   - **Skip signed-in pages**: If `authState` was returned, delete it now (see [Session cleanup](#session-cleanup)). Continue without `AUTH_STATE`.

### Output

- Approved scope: `CRAWL`, `AUDIT_STATES`, viewports, checks, page limit, optional `AUTH_STATE`

---

## Phase 4: Discover pages and hidden UI

**Goal:** Map the site and choose which hidden UI (menus, dialogs, tabs) to audit. Skip this phase for a quick audit.

### Actions

#### 4.1 Run discovery

Build the shared flags once and reuse them in Phase 5 so both phases cover the same site:

- `--url "<SITE_URL>"`
- `--routes "<comma-separated REQUESTED_ROUTES>"` when set
- `--crawl --max-pages <n>` when `CRAWL=true`
- `--auth-state "<AUTH_STATE>"` when set

```bash
node "${PLUGIN_ROOT}/scripts/a11y-audit.js" <shared flags> --mode discover --snapshot-dir "<RUN_DIR>/snapshots" --output "<RUN_DIR>/discover.json"
```

- **Exit 0**: All pages loaded on every layout.
- **Exit 3**: First check that `<RUN_DIR>/discover.json` exists and parses as JSON. If it doesn't, the script stopped on an unexpected error before writing results: show its stderr, and offer to re-run discovery or continue with a quick audit (skip to Phase 5 with `AUDIT_STATES=false`). If it does, some pages failed: read `pages[].error`. A redirect to sign-in means the page needs a signed-in session; note it as a coverage gap.
- **Exit 2 or 4**: Fix the arguments or tools, as in Phase 2.

Discovery explores every layout in scope, so `pages[]` has one entry per page and layout (`viewport`). Pages listed with `--routes` skip the crawl filters and page limit, but sign-out links, platform endpoints such as `/_api/`, and file downloads are never visited; they're listed in `crawl.excluded`.

#### 4.2 Review the inventory and propose states

Read `<RUN_DIR>/discover.json`. Each page entry has `viewport`, `controls` (role, accessible name, kind), and `stateCandidates` (proposed click steps for popups, disclosures, and tabs). Each candidate also has a `viewport`: use it as the state's `viewport`, because controls such as a mobile menu button exist only on that layout. Read the ARIA snapshots in `<RUN_DIR>/snapshots/` (named `<page>.<viewport>.aria.yml`) when a candidate's purpose isn't clear.

Choose the states worth auditing by following [`references/states-guide.md`](references/states-guide.md). Start from the saved `a11y-states.json` when the user chose to reuse it. Write the proposed states to `<RUN_DIR>/states.json`.

#### 4.3 Approve the states

<!-- gate: audit-accessibility:4.states | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · audit-accessibility:4.states):** Approve the interaction states the audit will replay.
>
> **Trigger:** Discovery finished and states were proposed.
> **Why we ask:** Each state clicks controls on the site; the user should confirm none of them has side effects.
> **Cancel leaves:** nothing — the states file exists only in the private run folder.

Show a table of the proposed states (page, label, layout, steps), then use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| I found <N> pages and propose auditing <M> hidden UI states (menus, dialogs, tabs). Each one is opened with a click, without submitting anything. Use these states? | UI states | Use these states (Recommended), Change the list, Skip hidden UI (description: Audit page loads only) |

- **Change the list**: Ask which to add or remove in plain text, update `states.json`, and repeat this gate.
- **Skip hidden UI**: Set `AUDIT_STATES=false`.

#### 4.4 Consent to form submission (only if needed)

Skip this step unless the user asked for a state that can only be reached by submitting a form, such as server-side validation messages. These states are left out by default.

<!-- gate: audit-accessibility:4.form-submit | category=consent | cancel-leaves=nothing -->

> 🚦 **Gate (consent · audit-accessibility:4.form-submit):** Allow states that submit a form on the site.
>
> **Trigger:** The user asked to audit a state that requires submitting a form.
> **Why we ask:** On a Power Pages site, a form submission can create or update a Dataverse record and send email.
> **Cancel leaves:** nothing — the form-submitting states are removed and the audit continues without them.

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| <K> of the states submit a form on <SITE_URL>. Submitting can create records or send email, so only allow it on a test or development site. Allow form submission for these states? | Form submit | Remove these states (Recommended), Allow on this test site |

If allowed, set `ALLOW_FORM_SUBMIT=true`. Otherwise remove those states from `states.json`.

### Output

- `<RUN_DIR>/discover.json`, approved `<RUN_DIR>/states.json` (if any), and a list of coverage gaps

---

## Phase 5: Run the audit

**Goal:** Run every approved check on every page, layout, and state.

### Actions

#### 5.1 Run the audit script

```bash
node "${PLUGIN_ROOT}/scripts/a11y-audit.js" <shared flags> --mode audit --output "<RUN_DIR>/audit.json"
```

Add these flags when they apply:

- `--states "<RUN_DIR>/states.json"` when `AUDIT_STATES=true`. Each state runs axe-core and the keyboard check. While a state replays, the audit blocks requests that would write data (see [`references/states-guide.md`](references/states-guide.md#form-submission-safety)).
- `--allow-form-submit` only when `ALLOW_FORM_SUBMIT=true`. It turns off both the submit-step guard and the request blocking.
- `--viewports`, `--checks`, or `--no-best-practice` when the user changed them in Phase 3

The audit takes roughly 5–15 seconds per page and layout. Keyboard, reflow, 200% text, and motion checks run on every layout, so a mobile-only problem is caught; page titles are checked once per page. Tell the user it's running and how many pages are in scope.

#### 5.2 Interpret the exit code

| Exit | Meaning | Next step |
|------|---------|-----------|
| 0 | No blocking violations | Continue to Phase 6 |
| 1 | Blocking violations found (critical or serious WCAG issues) | Continue to Phase 6 |
| 2 | Usage error (bad flag or states file) | Fix the input and re-run |
| 3 | Audit incomplete: a page or state failed to load, a check errored, or the script stopped on an unexpected error | Check that `<RUN_DIR>/audit.json` exists and parses as JSON. If it doesn't, no results were written: show the script's stderr and offer to re-run; don't write a report or a `Completed` marker. If it does, continue to Phase 6 and report the gaps from `pages[].error`, `states[].error`, and `checkErrors`; the rest of the report is valid |
| 4 | Tools or browser missing | Return to Phase 2 |

Exit 3 takes priority over exit 1, so always check `summary.blocking` in the report too. If `summary.blockedRequests` is above 0, mention in the report that some state interactions were stopped before they could write data, so those states may differ on the live site.

### Output

- `<RUN_DIR>/audit.json`

---

## Phase 6: Review findings and write the report

**Goal:** Turn raw results into a prioritized report that a site maker can act on.

### Actions

#### 6.1 Read the report

From `<RUN_DIR>/audit.json`, read `summary`, `violations`, `needsReview`, `pages`, `states`, and `crawl`. Each finding has `id`, `source`, `impact`, `wcag`, `bestPractice`, `heuristic`, `description`, `helpUrl`, and `nodes[]`. Each node has the affected element (`target`, `summary`) and every `{route, viewport, state}` where it occurs.

#### 6.2 Triage

Sort findings into these groups:

1. **Must fix**: Blocking findings — `critical` or `serious` WCAG violations that aren't best-practice or heuristic.
2. **Should fix**: `moderate` and `minor` WCAG violations.
3. **Verify**: `heuristic: true` findings from the extended checks (`pp-keyboard-trap`, `pp-focus-not-visible`, `pp-focus-offscreen`, `pp-reflow-horizontal-scroll`, `pp-text-clipped-at-200`, `pp-motion-ignores-reduced-motion`) and every `needsReview` item, including a `pp-autoplay-video-no-controls` video that has the autoplay attribute but didn't play during the audit. Check the evidence and the ARIA snapshot. Keep the finding when the evidence holds; otherwise list it as a manual check. A `pp-autoplay-video-no-controls` violation was observed playing, so it belongs in **Must fix**.
4. **Best practice**: `bestPractice: true` findings. Recommended, but not WCAG failures.

Group repeated issues. When the same rule and element appear on many pages (for example, a shared header), report it once as a shared component issue with its page count. Page title findings (`pp-page-title-missing`, `pp-page-title-duplicate`) belong in **Should fix**.

If `PROJECT_ROOT` is set, find the likely source file for each must-fix and should-fix finding. Search for the element's id, class names, visible text, or component name from `target`. For declarative sites, search web templates, page copy, and content snippets under `.powerpages-site/`. Record the file and line only when you're confident.

#### 6.3 Write the report

Write the report from [`references/report-template.md`](references/report-template.md), replacing every `{{placeholder}}`.

- With `PROJECT_ROOT`: write `<PROJECT_ROOT>/docs/accessibility/accessibility-audit.md`. If states were approved, also save them as `<PROJECT_ROOT>/docs/accessibility/a11y-states.json` so the next audit can reuse them.
- Without `PROJECT_ROOT`: write `<RUN_DIR>/accessibility-audit.md` and show the path.

Privacy rules for the report:

- Use CSS selectors and short summaries. Don't paste raw HTML from signed-in pages.
- Never include the session file path, cookies, or tokens.

#### 6.4 Write the result marker

With `PROJECT_ROOT`, write `<PROJECT_ROOT>/docs/accessibility/last-audit.json`:

```json
{
  "schemaVersion": 1,
  "skill": "audit-accessibility",
  "status": "Completed",
  "outcome": "failed",
  "baseUrl": "https://contoso.powerappsportals.com/",
  "finishedAt": "2025-01-01T00:00:00.000Z",
  "signedIn": false,
  "sessionRemoved": true,
  "reportFile": "docs/accessibility/accessibility-audit.md",
  "summary": { "pagesAudited": 12, "pageLayoutsAudited": 24, "pageErrors": 0, "statesAudited": 6, "stateErrors": 0, "checkErrors": 0, "blockedRequests": 0, "violations": 9, "blocking": 3, "needsReview": 4 }
}
```

- `status`: `Completed` when the audit ran; `Incomplete` when it stopped early.
- `outcome`: `failed` when `blocking` is greater than 0; `passed-with-warnings` when there are other violations, review items, load gaps, or check errors; otherwise `passed`.
- `summary`: copy the counts from the audit report's `summary`.
- `signedIn` and `sessionRemoved`: when a session was captured, write `sessionRemoved: false` now and set it to `true` after [Session cleanup](#session-cleanup).

#### 6.5 Present the summary

Show a short summary: pages and states audited, coverage gaps, counts by group, the top must-fix issues with the people they affect, and the report path.

### Output

- Accessibility report and result marker

---

## Phase 7: Offer fixes

**Goal:** Fix the issues the user chooses, in source, and confirm the fixes.

### Actions

#### 7.1 Decide whether fixes are possible

Skip to Phase 8 when there's no `PROJECT_ROOT`, when there are no must-fix or should-fix findings, or when none could be mapped to source.

#### 7.2 Propose a fix plan

For each mapped finding, propose the smallest change that fixes it by following [`references/fix-patterns.md`](references/fix-patterns.md): the file, the change, and the WCAG criterion it resolves. List shared-component fixes first, because one change fixes every page that uses the component.

<!-- gate: audit-accessibility:7.fix-offer | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · audit-accessibility:7.fix-offer):** Approve source changes before any file is edited.
>
> **Trigger:** The report is written and at least one finding maps to a source file.
> **Why we ask:** Fixes change the site's source code, and some changes (color, wording) are design decisions.
> **Cancel leaves:** nothing — the report stays as written and no source file changes.

Show the fix plan, then use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| I can fix <N> issues in your source code (<M> must-fix). Which fixes should I apply? | Apply fixes | Fix must-fix issues (Recommended), Fix all mapped issues, Let me choose, Don't change anything |

- **Let me choose**: Ask which findings in plain text, then apply only those.
- **Don't change anything**: Go to Phase 8.

#### 7.3 Apply and verify

1. Apply the approved changes with minimal edits. Don't reformat unrelated code. For color contrast, prefer existing theme tokens or variables.
2. If `SITE_URL` is a local dev server, re-run Phase 5 for the affected routes with `--output "<RUN_DIR>/audit-after.json"` and compare. Report which findings were fixed, which remain, and any new ones.
3. If `SITE_URL` is a deployed site, the fixes aren't live yet. Recommend `/deploy-site`, then re-running `/audit-accessibility`.
4. Add a "Fixes applied" section to the report listing each change.

### Output

- Approved fixes applied, and verified where possible

---

## Phase 8: Clean up and wrap up

**Goal:** Remove sensitive files, record usage, and suggest next steps.

### Actions

#### Session cleanup

If `AUTH_STATE` is set, delete it — it holds live session tokens:

```bash
node "${PLUGIN_ROOT}/scripts/a11y-capture-auth.js" --remove "<AUTH_STATE>"
```

Then set `sessionRemoved: true` in the result marker. Do this on every exit path, including when the user cancels a later gate or a step fails.

#### 8.1 Record skill usage

If `PROJECT_ROOT` is set:

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "AuditAccessibility"`.

#### 8.2 Suggest next steps

- Must-fix issues remain: fix them (Phase 7) or share the report with the site's developers.
- Fixes were applied for a deployed site: `/deploy-site`, then `/audit-accessibility` again.
- Pages were skipped because they need sign-in: re-run and choose **Include signed-in pages**.
- Always: complete the manual checks listed in the report (screen reader, captions, and content checks that automation can't cover).

The raw files in `RUN_DIR` stay in the system temp folder. Share the path so the user can inspect or delete them.

### Output

- Session removed, usage recorded, and next steps shared

---

## Important notes

### Throughout all phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase.
- **Never sign in for the user**, and never read, print, or copy the session file's contents.
- **Never submit forms** without the Phase 4.4 consent.
- **Report coverage honestly**: list every page or state that failed to load.
- **Leave other skills alone**: this skill uses its own scripts (`a11y-audit.js`, `a11y-capture-auth.js`, `install-a11y-deps.js`) and doesn't change `/create-site` or `/test-site`.

### Key decision points

1. **Phase 2.2**: Installing the audit packages needs consent.
2. **Phase 3.2**: The user chooses the audit size and whether to sign in.
3. **Phase 3.3**: Only the user signs in; the skill waits.
4. **Phase 4.3**: The user approves every interaction state before it runs.
5. **Phase 4.4**: Form submission stays off unless the user allows it on a test site.
6. **Phase 7.2**: Source files change only after the user approves the fix plan.

### Progress tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Resolve the target | Resolving the site URL | Find the site URL and project root, and create the run folder |
| Prepare audit tools | Preparing audit tools | Check for and install the pinned audit packages |
| Plan the audit scope | Planning the audit | Agree on pages, layouts, checks, and sign-in |
| Discover pages and hidden UI | Discovering pages | Crawl the site and approve interaction states |
| Run the audit | Running the accessibility audit | Run axe-core and extended checks on every page and state |
| Review findings and write the report | Writing the report | Triage findings, map them to source, and write the report and marker |
| Offer fixes | Applying fixes | Propose, apply, and verify approved source fixes |
| Clean up and wrap up | Wrapping up | Delete the session, record usage, and suggest next steps |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`.
