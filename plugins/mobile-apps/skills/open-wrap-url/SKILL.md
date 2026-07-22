---
name: open-wrap-url
description: Use when the user wants to open the Power Apps Wrap page for an app ID in the active environment.
user-invocable: true
allowed-tools: Bash
model: haiku
---

**📋 Shared instructions: [shared-instructions.md](../../shared/shared-instructions.md)** — read first.

# Open Wrap URL

Builds and opens the Wrap URL for a code app:

`https://make.powerapps.com/environments/<envID>/wrap?appID=<appID>` for `--env Prod`

`https://make.test.powerapps.com/environments/<envID>/wrap?appID=<appID>` for `--env Test`

This skill delegates URL construction and browser open behavior to `scripts/open-wrap-url.js`.

## Workflow

1. Resolve app ID + env ID → 2. Open Wrap URL

---

### Step 1 — Resolve app ID + env ID

Both arguments are required:

- `--app-id <app-id>`
- `--env-id <environment-id>`

Optional host selector:

- `--env <Prod|Test>` (default: `Prod`)

If either value is missing in `$ARGUMENTS`, ask once for the missing value(s). If still missing, STOP.

### Step 2 — Open Wrap URL

Run from the plugin root (or any app root):

```bash
node scripts/open-wrap-url.js --app-id "<app-id>" --env-id "<environment-id>" [--env "Prod|Test"]
```

Return the generated URL in the response. If the browser auto-open fails, still print the URL and tell the user to open it manually.

## Notes

- This skill is read-only with respect to project source files.
- Works on macOS (`open`), Linux (`xdg-open`), and Windows (`start`).
