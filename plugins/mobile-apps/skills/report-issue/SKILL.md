---
name: report-issue
description: Use when the user wants to report a bug, file an issue, submit a bug report, or report any problem with the mobile-app plugin.
user-invocable: true
argument-hint: "[optional: brief description of the bug]"
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion
model: haiku
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read this first.

# Report Issue — mobile-app

Generates a fully-populated GitHub issue body for the `microsoft/power-platform-skills` repo, scoped to the `mobile-app` plugin. Read-only — no project modifications.

## Workflow

1. Capture user description → 2. Detect project context → 3. Collect diagnostics → 4. Render issue body → 5. Print URL

---

### Step 1 — Capture user description

If `$ARGUMENTS` contains a description, use it. Otherwise prompt:

> "What's the issue? Briefly describe what you expected vs. what happened. (You can paste error output if helpful.)"

Then ask via `AskUserQuestion`:

> "Issue category?
> (a) Bug — something broke
> (b) Unexpected behavior — wrong output but no error
> (c) Documentation — docs are wrong / missing
> (d) Feature request
> (e) Question / discussion"

> "How blocking is this?
> (a) Blocking — can't proceed at all
> (b) Workaround exists — but painful
> (c) Annoying — non-critical
> (d) Polish — nice-to-have"

### Step 2 — Detect project context

Read-only checks:

```bash
test -f power.config.json && echo "in_project=true" || echo "in_project=false"
pwd
node --version
npm --version
node scripts/resolve-environment.js "$(node -e \"console.log(require('./power.config.json').environmentId)\")" 2>/dev/null || true
az --version 2>/dev/null | head -1
npx expo --version 2>/dev/null
uname -srm
```

If in a project:

```bash
node -e "console.log(require('./package.json').name, require('./package.json').version)" 2>/dev/null
node -e "console.log(JSON.stringify({env: require('./power.config.json').environmentId, name: require('./power.config.json').displayName}))"
test -f memory-bank.md && echo "memory_bank=present"
test -f native-app-plan.md && echo "plan=present"
ls src/generated/services/ 2>/dev/null | head -10
```

For native-build issues also capture:

```bash
[ "$(uname)" = "Darwin" ] && xcode-select -p
[ "$(uname)" = "Darwin" ] && pod --version 2>/dev/null
java -version 2>&1 | head -1
echo "ANDROID_HOME=$ANDROID_HOME"
```

### Step 3 — Collect diagnostics

**Prefer MCP if available** — call `expo.runDoctor()` to get categorized SDK / dep / plugin issues as JSON. See [`shared/references/expo-mcp.md`](${CLAUDE_SKILL_DIR}/../../shared/references/expo-mcp.md). Cleaner snapshot than parsing CLI text.

**Shell fallback** — if `expo.*` tools aren't available, run `npx expo doctor` and capture the text output verbatim.

If the user pasted an error, capture verbatim. Otherwise look for recent failure signals:

- Last 50 lines of any Metro / Gradle / Xcode log if user mentions a build failure
- `git status --short` if in a git repo (to show modified files — sanitize for secrets first)
- Output of `npx tsc --noEmit` if relevant

**Do NOT capture:**
- Contents of `src/playerConfig.ts` (contains tenantId / clientId — sensitive)
- Contents of `.env` or any file matching `.env*`
- Connection IDs unless the user explicitly opted in (PII / can map to tenant)
- Anything under `node_modules/`

### Step 4 — Render issue body

Print this block — user copies into a new issue:

```markdown
### Description

<user's description>

### Category

<Bug / Unexpected behavior / Docs / Feature / Question>

### Severity

<Blocking / Workaround / Annoying / Polish>

### Environment

| | |
|---|---|
| Plugin | mobile-app |
| Plugin version | <from .plugin/plugin.json, or legacy .claude-plugin/plugin.json fallback, or "unknown"> |
| OS | <uname output> |
| Node | <version> |
| npm | <version> |
| Power Apps CLI | <version> |
| Expo CLI | <version> |
| Xcode | <if macOS> |
| JDK | <if android> |
| ANDROID_HOME set | <yes/no> |

### Project context

<if in project>
- Project: `<name>` v`<version>`
- Power Platform env: `<env-id>`
- Memory bank present: <yes/no>
- Plan present: <yes/no>
- Connectors registered: <list from src/generated/services>
</if>

<if not in project>
Not run inside a mobile-app project.
</if>

### Reproduction steps

1.
2.
3.

### Expected

<what should have happened>

### Actual

<what happened>

### Logs / errors

```
<paste verbatim — sensitive values redacted>
```

### Notes

<anything else>
```

### Step 5 — Print URL

Tell the user:

> Open this URL to file the issue:
>
> <https://github.com/microsoft/power-platform-skills/issues/new?labels=plugin%3Amobile-app>
>
> Paste the block above into the body. Review for any sensitive values before submitting.

If the user wants to open it, suggest `open <url>` (macOS) / `xdg-open <url>` (Linux) / `start <url>` (Windows). Do not auto-open without confirmation.

## Notes

- This skill never modifies any file or invokes mutating commands. Pure diagnostic.
- For diagnosing connection-specific failures, suggest the user run `/list-connections` first and paste that output into the issue.
- For diagnosing build failures, suggest they include the full Metro/Gradle/Xcode log (not truncated).
