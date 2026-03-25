# Preferred Environment

When selecting an environment for code app creation or deployment, use the following priority order:

## Priority Order

1. **`power.config.json` default** — if the project has a `power.config.json`, read the `environmentId` from it and use that environment.
2. **User-specified** — if no `power.config.json` exists or it has no `environmentId`, ask the user which environment to use.

## Environment Selection Flow

1. Check for `power.config.json` in the project root:
   - If it contains an `environmentId`, use that value — confirm with the user before proceeding.
   - If it does not exist or has no `environmentId`, proceed to step 2.
2. Run `pwsh -NoProfile -Command "pac env list"` to show available environments. Ask the user to pick one.
3. Run `pwsh -NoProfile -Command "pac auth list"` to see the active profile.
4. If the active environment matches the target — confirm and proceed.
5. If it's a different environment — switch:
   ```bash
   pwsh -NoProfile -Command "pac env select --environment <id>"
   ```
6. Only use a different environment if the user explicitly requests it.
