# Preferred Environment

When selecting an environment for any Power Apps mobile app skill, use the following priority order:

## Priority Order

1. **Cached resolved details** — if `.resolved-environment.json` or `auth.config.json.environment` matches the active `power.config.json` `environmentId`, use it for `environmentUrl` and `tenantId`.
2. **`power.config.json`** — if the project has a `power.config.json`, read its `environmentId` and pass that ID to `scripts/resolve-environment.js`. The resolver calls the BAP admin environments endpoint to map the environment ID to the Dataverse URL.
3. **`memory-bank.md`** — if the bank records an active environment from a prior step in this project, use that.
4. **User-specified environment URL or ID** — if no project context exists, ask the user explicitly and resolve it with `scripts/resolve-environment.js`.

Never silently switch environments. Always confirm a switch with the user.

## Environment Selection Flow

```
┌─ test -f power.config.json ─┐
│                              │
│   yes ──► read environmentId │
│           confirm with user  │
│           done.              │
│                              │
│   no ──► next ───────────────┘
│
├─ test -f memory-bank.md ─────┐
│                              │
│   yes & has env ──► confirm  │
│                              │
│   no ──► next ───────────────┘
│
└─ Ask user for environment URL or ID.
   Resolve with scripts/resolve-environment.js.
```

## Concrete commands

```bash
# 1. Resolve the initialized app root from power.config.json
ENV_ID=$(node -e "try { console.log(require('./power.config.json').environmentId || '') } catch { console.log('') }")
node scripts/resolve-environment.js "$ENV_ID"

# 2. Read memory-bank.md
grep -E "^\| Active environment ID \|" memory-bank.md | sed 's/.*| //; s/ |//'

# 3. Resolve explicit URL or ID if no project context exists
node scripts/resolve-environment.js <environment-id-or-url>
```

## When the active env doesn't match

If `power.config.json` says env A and the user says they intended env B, the project metadata wins for this working directory. Re-run `npx power-apps init -t MobileApp --display-name '<name>' --environment-id <env-b-id> --non-interactive` in a separate copy if they want a different environment; do not silently edit `power.config.json`.

If `memory-bank.md` says env A and `power.config.json` says env B, `power.config.json` wins (it's the source of truth that drives `npx power-apps` Code Apps commands). Update the memory bank to match.

## Multi-environment workflows

A single working directory belongs to exactly one environment. If the user wants to deploy the same app to a different env (e.g., dev → prod):

1. `cp -r <working_dir> <new_dir>` to clone the project.
2. In the new dir: `npx power-apps init -t MobileApp --display-name '<same name>' --environment-id <new-env-id> --non-interactive` will overwrite `power.config.json`.
3. Re-run `/list-connections` to verify connection IDs match the new env (they likely won't).
4. Re-run `/add-connector` for any connector whose connection ID is missing or wrong.

This is intentional friction — silent multi-env confusion is worse than copy-paste effort.
