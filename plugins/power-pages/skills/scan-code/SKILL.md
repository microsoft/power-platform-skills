---
name: scan-code
description: >-
  Scans a Power Pages code-site project for dependency vulnerabilities
  (`npm audit`) and JavaScript/TypeScript code issues (ESLint), installs
  the matching ESLint plugins for the detected framework (React, Vue,
  Angular, Astro), and produces a single HTML report with package and
  code findings shown in separate sections. Severities are kept verbatim
  from the underlying tools. Use when the user wants to scan local
  source code, check dependencies, lint the project, audit packages,
  find code vulnerabilities, or run a pre-publish code check — even if
  they say "check my code" or "find security issues in my source"
  without naming `npm audit` or ESLint.
user-invocable: true
argument-hint: "[optional: --review <out-dir>]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Scan Code

Scan the local Power Pages code-site project for two classes of issues:

- **Package vulnerabilities** — `npm audit` against `package.json` / `package-lock.json`.
- **Code issues** — ESLint against project source, with framework-aware plugins.

The skill writes both result sets and renders one HTML report with the two scans as separate sections. Findings carry the **verbatim severity** emitted by each tool (npm audit: `critical`/`high`/`moderate`/`low`/`info`; ESLint: `error`/`warning`).

This skill scans local source code only. It does not call the live site.

**Initial request:** $ARGUMENTS

## Gotchas

- **`npm audit` needs a lockfile.** Without `package-lock.json` it cannot resolve transitive versions — the audit section is reported as `skipped` and the user is asked to run `npm install` first.
- **ESLint workspace is bootstrapped in `<projectRoot>/.scan-code/`.** Plugins are installed there (not in the user's `package.json`) to keep the project clean. The folder ships a `.gitignore` of `*` so it stays untracked. Deleting it forces a fresh install on the next run.
- **Severities are not remapped.** The HTML template understands every native severity these tools emit. Do not rewrite severity strings — pass them through.
- **Server-rendered frameworks are not supported.** Power Pages code sites only support React, Vue, Angular, and Astro. Other projects produce a `skipped` lint section.

## Workflow

1. **Prerequisites** — locate project, detect review mode
2. **Run package audit** — `npm audit` → `scan-code-packages.json`
3. **Run code lint** — detect framework, install ESLint plugins, lint → `scan-code-eslint.json`
4. **Render or hand off** — review mode: stop; interactive mode: render HTML
5. **Walk through follow-ups** — only if findings exist and not in review mode

## Task tracking

Create tasks in three groups. Mark each `in_progress` when starting, `completed` when done.

| Group | When | Tasks |
|-------|------|-------|
| 1 | At start | Check prerequisites |
| 2 | After prerequisites pass | Run package audit · Run code lint |
| 3 | After both scans complete (interactive only) | Render report · Walk through follow-ups |

In review mode, skip Group 3 — the orchestrator owns rendering.

---

## 1. Prerequisites

### 1.1 Locate the project, detect review mode

Use `Glob` to find `**/powerpages.config.json`. If none is found, tell the user the site needs to be created first with `/create-site`, then stop.

If `$ARGUMENTS` contains `--review <out-dir>`, remember the output directory. Step 4 becomes "write JSON only" and Step 5 is skipped.

### 1.2 Verify the project has a `package.json`

Confirm `<PROJECT_ROOT>/package.json` exists. If not, this is not a code-site project — tell the user, then stop.

### 1.3 Pick the output paths

| Mode | Package output | Lint output |
|------|----------------|-------------|
| Review | `<REVIEW_DIR>/scan-code-packages.json` | `<REVIEW_DIR>/scan-code-eslint.json` |
| Interactive | `<SYSTEM_TEMP>/scan-code/scan-code-packages.json` | `<SYSTEM_TEMP>/scan-code/scan-code-eslint.json` |

Create the directory if it does not exist. In interactive mode, delete any prior contents of `<SYSTEM_TEMP>/scan-code/` first.

---

## 2. Run the package audit

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/scan-code/scripts/audit.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --output "<PACKAGE_OUTPUT_PATH>"
```

The script:

- Runs `npm audit --json` in `<PROJECT_ROOT>`.
- Transforms each `vulnerabilities` entry into a finding (one per advisory cluster).
- Severities are kept verbatim from npm (`critical`, `high`, `moderate`, `low`, `info`).
- Returns `{ "status": "skipped", "reason": "..." }` if `package-lock.json` is missing or npm itself errors.

Tell the user, in one sentence, that the package audit completed (and how many issues if any).

---

## 3. Run the code lint

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/scan-code/scripts/lint.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --output "<LINT_OUTPUT_PATH>"
```

What the script does on first run:

1. Reads `<PROJECT_ROOT>/package.json` to detect the framework — React, Vue, Angular, or Astro.
2. Writes `<PROJECT_ROOT>/.scan-code/package.json` with the matching ESLint + plugin set.
3. Runs `npm install --prefix <PROJECT_ROOT>/.scan-code/` to install them.
4. Writes `<PROJECT_ROOT>/.scan-code/eslint.config.mjs` with framework-aware rules **and an embedded ignore list** for `node_modules`, `.powerpages-site`, `dist`, `build`, `docs`, `coverage`, `public`, `.scan-code`, and minified bundles.
5. Runs ESLint over `src/**/*` (with framework extensions) plus root-level config files only.
6. Emits findings with severities kept verbatim (`error`, `warning`).

Subsequent runs reuse the workspace. Pass `--reinstall` to force re-provisioning.

If no supported framework is detected, the script returns `{ "status": "skipped", ... }` — surface that as a single info finding in the report.

---

## 4. Render or hand off

### 4.1 Review mode — hand off and stop

If invoked with `--review <out-dir>`, the two JSON files are already in place. Stop — the orchestrator (`/security-review`) consolidates them into the master report.

### 4.2 Interactive mode — render the HTML report

Compose a 1–2 sentence plain-language summary covering totals across both sections, then render:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/build-review-data.js" \
  --reportName "Code Scan" \
  --inputDir "<SYSTEM_TEMP>/scan-code/" \
  --siteName "<SITE_NAME>" \
  --goalLabel "Source code & packages" \
  --scopeLabel "<PROJECT_ROOT>" \
  --summary "<SUMMARY_TEXT>" \
  --output "<SYSTEM_TEMP>/scan-code/data.json"

node "${CLAUDE_PLUGIN_ROOT}/scripts/render-review.js" \
  --output "<PROJECT_ROOT>/docs/scan-code-<YYYY-MM-DD-HHMMSS>.html" \
  --data "<SYSTEM_TEMP>/scan-code/data.json"
```

The filename **must** include the local timestamp (e.g. `scan-code-2026-05-22-141530.html`). Open the rendered HTML in the user's default browser.

Delete `<SYSTEM_TEMP>/scan-code/` after rendering succeeds.

### 4.3 Record skill usage

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`
>
> Use `--skillName "ScanCode"`.

---

## 5. Walk through follow-ups

Skip in **review mode**. Skip when both sections have zero issues.

Group findings by remedy:

- **Package vulnerabilities with auto-fix** → tell the user the exact `npm audit fix` invocation reported in each finding's `fix` field.
- **Package vulnerabilities without auto-fix** → recommend reviewing the advisory link and updating manually.
- **ESLint errors / warnings** → suggest running `eslint --fix` in the project for auto-fixable issues, then reviewing the rest by file.

If nothing meaningful applies, end the skill — do not ask just to ask.

---

## Constraints

- **Severities are verbatim.** Do not rewrite, bucket, or rename severity strings. The shared HTML template knows every value these tools emit.
- **Source code only.** Never lint `node_modules`, `.powerpages-site`, `docs`, `dist`, `build`, `coverage`, `public`, or `.scan-code/` itself. The generated ESLint config carries these ignores.
- **Do not modify the user's `package.json`.** ESLint and its plugins live in the side workspace at `<projectRoot>/.scan-code/`.
- **No new HTML template.** Render via the shared template under `scripts/lib/templates/`. Package and code findings are routed through separate JSON files so they appear as two sidebar sections.
