# Version Check

**Run this check at the start of every skill execution, but at most once per day.**

## Instructions

### Step 1: Check if a version check is needed

Look for the file `~/.claude/.power-apps-last-version-check`. Use Bash to read it if it exists:

```bash
cat ~/.claude/.power-apps-last-version-check 2>/dev/null
```

- If the file exists and contains today's date (YYYY-MM-DD format), **skip the entire check** and continue with the skill silently.
- If the file does not exist, or the date is older than today, proceed to Step 2.

### Step 2: Read the local version

Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` and extract the `version` field.

### Step 3: Fetch the latest version from the marketplace

Fetch the remote marketplace manifest using Bash:

```bash
curl -fsSL https://raw.githubusercontent.com/microsoft/power-platform-skills/main/.claude-plugin/marketplace.json 2>/dev/null
```

Parse the `version` field from the first plugin in the `plugins` array.

### Step 4: Compare versions

Compare the local version against the remote version using semver rules — split on `.`, compare major, then minor, then patch as integers.

### Step 5: Display result

**If a newer version is available**, print this banner **before any other output**:

```
╔══════════════════════════════════════════════════════════════╗
║  UPDATE AVAILABLE: v{local} → v{remote}                    ║
║  Run: claude plugin update power-apps                       ║
╚══════════════════════════════════════════════════════════════╝
```

**If versions match or the local version is newer**, print nothing.

### Step 6: Update the timestamp

Write today's date (YYYY-MM-DD) to `~/.claude/.power-apps-last-version-check` using Bash:

```bash
mkdir -p ~/.claude && echo "YYYY-MM-DD" > ~/.claude/.power-apps-last-version-check
```

> **Note:** Writing to `~/.claude/` is a pre-approved exception to the "confirm before writing outside project root" guardrail. This file is a shared cache and does not affect the user's project.

## Error Handling

If anything in Steps 2-4 fails (network error, file not found, malformed JSON), skip the check silently and continue with the skill. **Never block skill execution over a version check failure.**
