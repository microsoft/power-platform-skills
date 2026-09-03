## CLI Invocation (OS-aware)

Use direct `npx power-apps`, `node`, and `az` commands for the mobile-app plugin flow.

Typical commands:

```bash
npx power-apps init -t MobileApp --display-name '<name>' --environment-id <id> --non-interactive
npx power-apps add-data-source --api-id <api> --connection-id <connection-id>
npx power-apps create-connection --api-id <api> --json
npx power-apps list-connection-references --solution-id <solution-id> --json
node scripts/resolve-environment.js [environment-id-or-url]
```

**Power Apps CLI required-argument rule:** when a skill invokes `npx power-apps`, pass every value the skill already knows and run app-root verbs from the directory that contains `power.config.json`. In practice:

- `init` and pre-project discovery commands can use `--environment-id` because there is no `power.config.json` yet.
- After `power.config.json` exists, do **not** pass `--environment-id` to app-root verbs (`add-data-source`, `push`, `list-datasets`, `list-tables`, `list-connection-references`, `add-flow`, `remove-flow`, etc.). The CLI reads the environment and region from `power.config.json`; extra unregistered flags can fail command parsing.
- Use `--non-interactive` only on commands whose required values are completely supplied and whose implementation supports non-interactive execution (`init`, `push`, `add-flow --flow-id`, `remove-flow --flow-id`, `create-connection --api-id` for SSO-eligible connectors, `delete-data-source --api-id --data-source-name`). For `add-data-source`, prefer passing the connector-specific required flags and let the action layer request only the options it needs.
- Prefer `--json` on list/discovery commands so downstream parsing is stable.
- For Dataverse table generation, pass `--api-id dataverse`, `--resource-name <table-logical-name>`, and `--org-url <environment-url>`.
- For non-Dataverse connectors, pass `--api-id`, plus either `--connection-id` from `create-connection` or `--connection-ref` from `list-connection-references`; table-based connectors also need `--dataset` and `--resource-name`.
- For existing raw connection IDs, use a caller-provided value or create a new connection with `create-connection`. Dataverse actions/functions can be discovered with `find-dataverse-api`; this plugin only adds Dataverse table CRUD through `/add-dataverse`.

**Standalone `npx power-apps` auth:** the CLI uses its own MSAL cache at `~/.powerapps-cli/cache/auth/msal_cache.json`; `az login` / `az account set` will not switch the account used by `npx power-apps`. Auth commands do **not** require `--environment-id`. Use this triage order when auth fails or the wrong user is active:

| Step | Command | When to use |
|---|---|---|
| 1. Check state | `npx power-apps auth-status` or `npx power-apps auth-status --json` | Always — see which accounts are cached and which is active (marked `*`) |
| 2. Switch account | `npx power-apps auth-switch --account <email-or-homeAccountId>` | Right user is already cached — no browser re-auth needed |
| 3. Add account | `npx power-apps login` or `npx power-apps login --account <email>` | Right user is NOT in cache — opens browser (`--account` pre-fills the email field, does not validate against cache) |
| 4. Clear cache | `npx power-apps logout` | Last resort — removes every cached account; next command forces a fresh browser sign-in |

In non-interactive mode (`--non-interactive` or CI), `auth-switch` requires `--account <email>` when more than one account is cached; it will fail with an error listing the cached accounts if omitted.

**Failure refresh policy (global):** if any `npx power-apps *` command exits non-zero, run `npx power-apps auth-status --json` to confirm the active account is correct. If the account needs to change, use `auth-switch`; if no account is cached, use `login`. Only run `npx power-apps logout` when the cache itself is corrupt or you want to remove all accounts. After correcting auth state, retry the same command once before further triage.

`az` calls work in bash on macOS/Linux directly. On Windows, wrap with `pwsh -NoProfile -Command "az …"` for consistency.

---


## Inline Shell — Reserved Variable Names (zsh)

When writing inline `bash`/`zsh` snippets in a skill (loops, response-status checks, retry helpers), **never use these names as variables** — zsh treats them as read-only shell parameters and any assignment crashes with `read-only variable: <name>` (exit 1):

| Reserved | Reason | Use instead |
|---|---|---|
| `status` | `$status` is the exit code of the last command (zsh equivalent of `$?`) | `http_status`, `resp_status`, `code` |
| `path` | `$path` is the array form of `$PATH` | `file_path`, `target_path` |
| `argv` | `$argv` mirrors positional args | `args` (but check it's not array-shaped first) |
| `signals` | `$signals` is the trap signals list | `sig_list` |

This bites the hardest in retry helpers like `post_col() { local status=$(curl …) }` — fails on macOS (default shell is zsh) but works on a Linux CI box (default bash). Always pick a non-reserved name even when prototyping.

If you can use a dedicated bundled script (e.g. `scripts/dataverse-request.js`), prefer it — it sidesteps shell-variable footguns entirely.
