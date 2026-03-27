# AGENTS.md — Power Platform Pipelines Plugin

## Plugin Conventions

### DRY Principle
- Shared scripts live in `scripts/` — never duplicate logic across skills.
- Shared reference material lives in `references/` — link, don't copy.
- All Dataverse HTTP calls go through `scripts/dataverse-request.js` with built-in retry and auth.
- Scripts use `scripts/lib/pipeline-helpers.js` for constants (entity names, option-set values, API paths) and shared utilities (auth, HTTP, environment discovery).

### Script Contracts
| Concern | Convention |
|---|---|
| **Language** | Node.js (no external dependencies beyond Node built-ins) |
| **Output** | JSON to stdout |
| **Exit codes** | `0` = request completed (check status in JSON), `1` = fatal error |
| **Auth** | Azure CLI token via `az account get-access-token` |
| **Retry** | 401 (token refresh), 429, 500, 502, 503 — handled by `dataverse-request.js` |

### Phase-Wise Skill Workflow
Every skill follows this execution pattern:

1. **Prerequisites** — Verify auth (`pac auth who`, `az account show`), verify Dataverse access (`verify-dataverse-access.js`).
2. **Discover** — Gather required context (environment URLs, pipeline IDs, solution names). Ask the user when information is missing.
3. **Plan** — Present the intended operations in a table for user review. Get confirmation via `AskUserQuestion` before mutating anything.
4. **Execute** — Run scripts in the correct dependency order. Track each step with `TaskCreate` / `TaskUpdate`.
5. **Verify** — Query back the created/modified resources to confirm success.
6. **Summary** — Present results in a clear table, suggest logical next steps.

### SKILL.md Frontmatter
- `allowed-tools` must be a **comma-separated string** (not a YAML list).
- `model` should be `sonnet` unless the skill requires extended reasoning.
- `user-invocable: true` for all top-level skills.

### Task Tracking
- Create tasks upfront at the start of each phase using `TaskCreate`.
- Update tasks as each step completes using `TaskUpdate`.
- Use descriptive task names so the user can follow progress.

### Script Invocation
All scripts are invoked via:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/<script-name>.js" <args>
```

### Error Handling
- If a script exits with code 1, stop and report the error to the user.
- If a Dataverse call returns 4xx/5xx after retries, surface the error message from the API response.
- Never silently swallow errors — always show the user what went wrong and suggest remediation (see `references/troubleshooting.md`).
