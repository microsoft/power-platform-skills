# Connector Reference

Applies to all connector skills (`/add-azuredevops`, `/add-teams`, `/add-excel`, `/add-onedrive`, `/add-sharepoint`, `/add-office365`, `/add-mcscopilot`, `/add-workiq`, `/add-connector`). Does NOT apply to Dataverse (`/add-dataverse`).

## Connections

Every non-Dataverse data source is bound to a **connection**: the saved sign-in the connector uses to call its service. How a skill gets one depends on the installed CLI. Resolve `$PA` and `PA_INLINE_CONNECTIONS` first (see [cli-binary.md](./cli-binary.md)), then follow the matching flow:

| `PA_INLINE_CONNECTIONS` | CLI                              | Flow |
| ----------------------- | -------------------------------- | ---- |
| `yes`                   | `pa` 1.3.0 or later              | [Inline connections](#inline-connections-cli-130-and-later): the CLI finds or creates the connection |
| `no`                    | Older `pa`, or flat `power-apps` | [Explicit connection ID](#explicit-connection-id-older-clis): find the ID first and pass `-c` |

In both flows:

- **A known connection ID wins.** If the caller or the user already supplied a connection ID, pass it with `-c <connection-id>`; the CLI then skips connection lookup.
- **Never choose between connections yourself.** When a connector has several connections, ask the user which one to use.
- **Don't record connections.** Never write connection names or IDs to the memory bank (see [memory-bank.md](./memory-bank.md)).
- **Choose table or actions up front.** For connectors that support both (SharePoint, SQL Server, Excel Online), pass `--table` (or `--procedure` for SQL) to add a table, or `--as action` to add the connector's actions. From CLI 1.2.0, a non-interactive add that does neither fails. Older CLIs have no `--as`; add tables with `-d` and `--table`. To check whether a connector supports tables, read `isTabular` from `pa connector list --search '<connector name>' --json`.

### Inline connections (CLI 1.3.0 and later)

1. **Tell the user first.** In one line, say that adding the connector may create a connection with their Microsoft account if they don't have one yet.
2. **Run the add without `-c`**, always with `--non-interactive`. The agent's shell can't answer the CLI's interactive connection picker, and `--non-interactive` guarantees the CLI never shows it:

   ```bash
   # Non-tabular connectors
   pa app add data-source --connector <connector-id> --non-interactive

   # Tables (SharePoint, SQL Server): also pass the dataset and table
   pa app add data-source --connector <connector-id> -d '<dataset>' --table '<table>' --non-interactive
   ```

   Listing datasets and tables (`pa connection list-datasets` / `list-tables`) needs a connection ID (these commands don't find or create connections, and fail without `-c` in non-interactive mode), so tabular skills such as `/add-sharepoint` look the connection up before the add.

3. **Act on the result:**

   | CLI output | Exit | What to do |
   | --- | --- | --- |
   | `Using existing connection '<Name>' (<id>).` | 0 | Continue. Tell the user which connection was used. |
   | `Created a new connection '<Name>' (<id>).` | 0 | Continue. Tell the user a connection was created with their account. The CLI does this only for connectors whose only sign-in option is the user's Microsoft account (single sign-on), or that need no sign-in. |
   | `Multiple connections exist for '<Connector>', so one cannot be selected automatically.` (the candidates are listed with it) | 2 | Show the candidates and ask the user to pick one. Re-run with `-c <id>`. |
   | `'<Connector>' requires a connection that cannot be created automatically in non-interactive mode.` | 2 | If the output also says `Tip: '<Connector>' supports single sign-on`, ask the user whether to create a single sign-on connection with their account; if they agree, re-run with `--use-sso`. Otherwise [create the connection with the user](#create-a-connection-with-the-user). |
   | `No connection exists for '<Connector>' and automatic connection creation failed.` (or `No SSO connection exists …` with `--use-sso`) | 2, 3, or 5 | Exit 3 is a sign-in problem: run `pa auth login`, then retry once. Exit 5 is a network problem: retry once. Exit 2, or a second failure: [create the connection with the user](#create-a-connection-with-the-user). |
   | `You are not signed in` or `Your sign-in session has expired …` (`Run 'pa auth login' to sign in, then retry.`) | 3 | Run `pa auth login`; it opens the browser so the user can sign in. If it can't open a browser from your shell, ask the user to run `pa auth login` in their own terminal (or `npx --no-install pa auth login` from the project folder if `pa` isn't recognized). Then retry once. |
   | `--use-sso was set but '<Connector>' does not support single sign-on (SSO) authentication.` | 2 | Re-run without `--use-sso` and handle the result with this table. |
   | An error that ends with `Note: connection '<Name>' (<id>) was created for this command and has been kept.` | non-zero | Fix the reported problem, then re-run with `-c <id>`. |

   For any other failure, report the exact output and stop (see Command Failure Handling in [shared-instructions.md](./shared-instructions.md)).

#### `--use-sso`

`--use-sso` makes the CLI use a single sign-on connection even when the connector also offers other sign-in types (for example SharePoint or SQL Server). It reuses the first existing single sign-on connection, or silently creates one. **Ask the user before passing it**, because it can create a connection with their account. To check in advance whether a connector supports single sign-on, read `supportsSso` from:

```bash
pa connector list --search '<connector name>' --json
```

#### Create a connection with the user

Creating a connection that needs a browser sign-in only works from an interactive terminal, which the agent's shell usually isn't. Hand this step to the user:

1. Ask them to run this in their own terminal, from the project folder, and finish signing in in the browser:

   ```bash
   pa connection create --connector <connector-id>
   ```

   If `pa` isn't recognized (the CLI is installed only in the project, not globally), they can run `npx --no-install pa connection create --connector <connector-id>` instead; on `power-apps`-only projects it's `npx --no-install power-apps create-connection -a <connector-id>`. Or they can create it in the maker portal: `https://make.powerapps.com/environments/<environment-id>/connections` → **+ New connection** (use the environment ID from `power.config.json`).
2. When they confirm it's done, re-run the same add. With exactly one connection for the connector, the CLI uses it automatically.

Create connections only when the connector has none: every extra connection makes later adds ambiguous. Before running `pa connection create` yourself (for example with `--use-sso`), check `pa connection list --search <connector-id> --json` and ask the user first.

### Explicit connection ID (older CLIs)

Before CLI 1.3.0, every non-Dataverse connector requires a **connection ID** (`-c`) when added via `pa app add data-source`. Without it, the command fails with: `CONNECTION_ID argument is required for connector data sources`.

#### Step 1: List Existing Connections

Run the `/list-connections` skill. It runs `pa connection list` and returns a table of connection IDs and connector names.

Look for the connector in the output. Note the **ConnectionId** column value. If there are several, ask the user which one to use.

#### Step 2: If No Connection Exists

Create it with the CLI:

1. Ask the user to confirm, then run `pa connection create --connector <connector-id>` (`power-apps create-connection -a <connector-id>` on `power-apps`-only projects). Connectors whose only sign-in option is the user's Microsoft account are created silently, and the command prints the new connection ID.
2. If the CLI says the connection needs a browser sign-in it can't do in non-interactive mode, follow [Create a connection with the user](#create-a-connection-with-the-user): the user runs the same command in their own terminal, with the maker portal as a fallback.
3. Re-run `/list-connections` to get the new connection ID.

#### Step 3: Use Connection ID

Always pass `-c <connection-id>` when adding a connector:

```bash
# Commands shown in canonical `pa` form — resolve the binary via shared/cli-binary.md
# and translate to flat `power-apps add-data-source ...` when only `power-apps` is installed.

# Non-tabular connectors
pa app add data-source --connector <api-name> -c <connection-id>

# Tabular connectors (also need -d and --table)
pa app add data-source --connector <api-name> -c <connection-id> -d '<dataset>' --table '<table>'
```


## Inspecting Large Generated Files

Generated service files (e.g., `Office365OutlookService.ts`) can be thousands of lines. **Do NOT read the entire file.** Instead:

1. **List available methods** with Grep:
   ```
   Grep pattern="async \w+" path="src/generated/services/<Connector>Service.ts"
   ```

2. **Find a specific method** and read just that section:
   ```
   Grep pattern="async GetEventsCalendarViewV2" path="src/generated/services/Office365OutlookService.ts" -A 20
   ```

3. **Find parameter types** in the models file:
   ```
   Grep pattern="interface CalendarEventHtmlClient" path="src/generated/models/Office365OutlookModel.ts" -A 30
   ```

This avoids context window bloat and is much faster than reading entire generated files.

## Sub-Skill Invocation

When a connector skill is invoked from another skill (e.g., `/create-code-app` calls `/add-office365`):

- **Check `$ARGUMENTS`** -- if provided, use it as the connector name or configuration
- **Use a connection ID the caller passes** -- pass it with `-c` and skip connection lookup
- **Skip redundant questions** -- don't re-ask things the caller already provided (connector name, project path, etc.)
- **Memory bank is still read** -- but skip the summary if the caller just updated it
