---
name: deploy
description: Builds and deploys a Power Apps code app to Power Platform. Use when deploying changes, redeploying an existing app, or pushing updates.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash
model: sonnet
---

**📋 Shared Instructions: [shared-instructions.md](${CLAUDE_PLUGIN_ROOT}/shared/shared-instructions.md)** - Cross-cutting concerns.

# Deploy

Builds and deploys the app in the current directory to Power Platform.

## Workflow

1. Check Memory Bank → 2. Build → 3. Deploy → 4. Update Memory Bank

---

### Step 1: Check Memory Bank

Check for `memory-bank.md` in the project root. If found, read it for the project name, environment, and current version. If not found, proceed — the project may have been created without the plugin.

### Step 2: Build

```powershell
npm run build
```

If the build fails:

- **TS6133 (unused import)**: Remove the unused import and retry.
- **Other TypeScript errors**: Report the error with the file and line number and stop. Do not deploy a broken build.

Verify `dist/` exists with `index.html` before continuing.

### Step 3: Deploy

Ask the user: _"Ready to deploy to [environment name]? This will update the live app."_ Wait for explicit confirmation before proceeding.

```bash
pwsh -NoProfile -Command "pac code push"
```

Capture the app URL from the output if present.

If deploy fails, report the error and stop — do not retry silently. Common fixes are in the troubleshooting guide:

- Auth error → `pwsh -NoProfile -Command "pac auth create"`
- Environment mismatch → `pwsh -NoProfile -Command "pac env select --environment <id>"`

**Mac fallback — if `pac code push` fails with an auth error on macOS:**
`pac` has known authentication bugs on Mac that can block the push. Use the npx CLI instead:
```bash
npm install -g @microsoft/power-apps-cli   # skip if already installed
npx power-apps push
```
This is functionally equivalent to `pac code push` and bypasses the Mac auth issue.

### Step 4: Update Memory Bank

If `memory-bank.md` exists, increment the version (e.g., `v1.0.0` → `v1.1.0`) and update:

- Current version
- Last deployed timestamp
- App URL (if captured)
