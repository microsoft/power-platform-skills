# CLI invocation and authentication

Load when the active phase runs CLI commands. Use direct `npx power-apps`, `node` and `az`.
Use shell-safe argument quoting so user text stays data, not executable shell syntax.

## Power Apps CLI required arguments

- Run app-root verbs from the directory containing `power.config.json`; inherit `working_dir`.
- `init` and pre-project discovery can accept `--environment-id`. Once config exists, app-root
  verbs (`add-data-source`, `push`, list datasets/tables/connection references, add/remove flow)
  read it themselves; do not add unsupported environment flags.
- Supply every known required value. Use `--non-interactive` only where supported and complete:
  `init`, `push`, `add-flow --flow-id`, `remove-flow --flow-id`, SSO-eligible
  `create-connection --api-id`, `delete-data-source --api-id --data-source-name`.
- Prefer `--json` for discovery. Dataverse generation requires `--api-id dataverse`,
  `--resource-name <table-logical-name>` and `--org-url <environment-url>`.
- Non-Dataverse generation needs `--api-id` plus a caller-provided/new `--connection-id`
  or solution `--connection-ref`; table connectors also need `--dataset` and `--resource-name`.
  Let the add-data-source action request only unresolved connector options.
- `find-dataverse-api` discovers actions/functions; this plugin's `/add-dataverse` adds table CRUD.

```bash
npx power-apps init -t MobileApp --display-name '<name>' --environment-id <id> --non-interactive
npx power-apps add-data-source --api-id <api> --connection-id <connection-id>
npx power-apps create-connection --api-id <api> --json
npx power-apps list-connection-references --solution-id <solution-id> --json
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" <environment-id-or-url>
```

## Standalone Power Apps authentication

The CLI's MSAL cache (`~/.powerapps-cli/cache/auth/msal_cache.json`) is separate from Azure CLI
and npm feed auth. `az login`/`az account set` cannot switch its account. Never edit cache bytes.

| Order | Command | Condition |
|---|---|---|
| 1 | `npx power-apps auth-status --json` | Inspect active/cached accounts |
| 2 | `npx power-apps auth-switch --account <email-or-homeAccountId>` | Intended account already cached |
| 3 | `npx power-apps login [--account <email>]` | Intended account missing |
| 4 | `npx power-apps logout` | Last resort for corrupt cache/removing all accounts |

In non-interactive mode, supply `auth-switch --account` when several accounts are cached.
On a failed Power Apps command, follow [failure handling](${PLUGIN_ROOT}/shared/shared-instructions-failure.md).

## POSIX / Windows / inline-shell constraints

Use bash/zsh, Git Bash or WSL. Stop on a non-POSIX shell rather than attempting partial work.
On Windows where `az` is a `.cmd` shim outside bash PATH, use
`pwsh -NoProfile -Command "az …"`.
Never assign zsh reserved variables `status`, `path`, `argv`, or `signals`; use
`http_status`, `file_path`, `args`, and `sig_list`. Prefer bundled Node helpers over shell recipes.
