# Version Check

**Run this check at the start of every skill execution, but at most once per day.**

## Instructions

### Step 1: Check if a version check is needed

Look for the file `~/.claude/.code-apps-preview-last-version-check`. Use Bash to read it if it exists:

```bash
cat ~/.claude/.code-apps-preview-last-version-check 2>/dev/null
```

- If the file exists and contains today's date (YYYY-MM-DD format), **skip the entire check** and continue with the skill silently.
- If the file does not exist, or the date is older than today, proceed to Step 2.

### Step 2: Read the local version

Read the locally installed [plugin.json](../plugin.json) relative to this installed document.
Do not use the remote manifest or a project manifest as the local version.
Extract the `name` and `version` fields.

### Step 3: Fetch the latest version from the marketplace

Fetch the remote plugin manifest using the client's shell:

```bash
curl -fsSL https://raw.githubusercontent.com/microsoft/power-platform-skills/main/plugins/code-apps/plugin.json
```

Read the remote `name` and `version` fields. Marketplace entries do not contain versions.

### Step 4: Compare names before versions

- If the local name is exactly `code-apps-preview` and the remote name is exactly `code-apps`, select the rename result.
  Use the rename notice in Step 5.
  Do not compare versions for this case. The rename notice applies even if the remote version is equal or lower.
- If the names match, compare versions using semver rules: compare major, then minor, then patch as integers.
  Use the normal version result in Step 5.
- For any other name mismatch, skip Step 5 silently and continue to Step 6.
  Do not use an unexpected remote name in commands or migration instructions.

### Step 5: Display result

**For the exact rename in Step 4**, display this notice **before any other output**:

```text
PLUGIN RENAMED: code-apps-preview -> code-apps
The remote plugin manifest now declares the name code-apps.
Use your active client's documented marketplace refresh and plugin installation actions to migrate.
Confirm that the client lists code-apps before you remove code-apps-preview.
```

Display this notice only after the remote manifest declares `code-apps`.
Do not run migration commands or change installed plugins automatically.
Continue to Step 6 after the notice. Do not display normal update instructions for the old name.

**If names match and a newer version is available**, print this banner **before any other output**:

```
╔══════════════════════════════════════════════════════════════╗
║  UPDATE AVAILABLE: v{local} → v{remote}                    ║
║  Update code-apps in your active client.                    ║
╚══════════════════════════════════════════════════════════════╝
```

**If names match and the remote version is not newer**, print nothing.

For a newer version with the same name, use the active client's update command:

- Copilot CLI or Claude Code: `/plugin update code-apps@power-platform-skills`.
- Codex: `codex plugin marketplace upgrade power-platform-skills`.
- Other clients: use that client's documented plugin update action.

### Step 6: Update the timestamp

Write today's date (YYYY-MM-DD) to `~/.claude/.code-apps-preview-last-version-check` using Bash:

```bash
mkdir -p ~/.claude && echo "YYYY-MM-DD" > ~/.claude/.code-apps-preview-last-version-check
```

> **Note:** Writing to `~/.claude/` is a pre-approved exception to the "confirm before writing outside project root" guardrail. This file is a shared cache and does not affect the user's project.

## Error Handling

If anything in Steps 2-4 fails (network error, file not found, malformed JSON), skip the check silently and continue with the skill. **Never block skill execution over a version check failure.**
