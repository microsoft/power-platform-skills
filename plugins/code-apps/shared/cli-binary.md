# CLI Binary Resolution (`pa` preferred, `power-apps` fallback)

**This file is the single source of truth for which CLI binary to run and how to translate commands.** Every skill that runs a Power Apps CLI command MUST resolve the binary using the algorithm below **before** running any command, and MUST author commands in the canonical grouped **`pa`** form (see the mapping table).

---

## Why two binaries

`@microsoft/power-apps-cli` ships two executables from the **same package**:

| Binary       | Syntax  | Example                                    |
| ------------ | ------- | ------------------------------------------ |
| `pa`         | grouped | `pa app add data-source --connector ...`   |
| `power-apps` | flat    | `power-apps add-data-source -a ...`        |

Both are installed together, so a project's `node_modules/.bin/pa` shim exists **only if** the installed CLI version is new enough to include the grouped `pa` binary. Older projects have only `power-apps`. We therefore **prefer `pa`** and **fall back to `power-apps`**.

**Two things differ between the binaries — the verb structure AND some flags:**

1. **Verb structure** — grouped noun-verb (`pa app push`) vs flat (`power-apps push`). See the command mapping table.
2. **Flag renames** — the grouped `pa` surface renames several customer-facing selector flags and **drops their short aliases** (the "Phase 2" `grouped_flag_renames` mechanism, now live). The flat `power-apps` surface keeps the original flags byte-identical. See the flag mapping table.

When translating a canonical `pa` command to flat `power-apps`, you must convert **both** the verb path and any renamed flags.

---

## Resolution algorithm (run once per session, then cache)

Resolve from the **project root** (the directory containing `package.json` / `power.config.json`):

```bash
# Prefer the grouped `pa` binary; fall back to flat `power-apps`.
# --no-install is REQUIRED: it stops npx from silently fetching a remote
# package named `pa`/`power-apps` from the registry if no local shim exists.
if [ -e node_modules/.bin/pa ]; then
  PA="npx --no-install pa"          # grouped syntax  → use the "pa" column below
  PA_KIND="pa"
elif [ -e node_modules/.bin/power-apps ]; then
  PA="npx --no-install power-apps"  # flat syntax     → translate via the mapping table
  PA_KIND="power-apps"
else
  # Neither shim present → the CLI is not installed yet.
  # Run `npm install` in the project root (per the normal scaffold flow), then re-probe.
  PA=""
  PA_KIND="none"
fi
```

Rules:

1. **Probe by file presence only** — do not pin or parse a version. `.bin/pa` existing == the grouped binary is available. This is deterministic and cheaper than spawning `--version`.
2. **Always use `npx --no-install`.** Never run a bare `npx pa ...`: if the local shim is missing, npx would try to download and execute an unrelated remote package named `pa`. `--no-install` fails closed instead.
3. **Cache the result** in the project memory bank (`CLI Binary` row — see `memory-bank.md`) so subsequent skills/commands in the session don't re-probe. Re-probe only after an `npm install` that could have changed the installed CLI.
4. **`none` → install first.** If neither shim exists, the CLI isn't installed; run the project's `npm install` (already part of the scaffold flow) and re-probe before running any command.

---

## Authoring rule for skills

- **Author every command in the canonical grouped `pa` form** (the left/`pa` column below), using the **renamed `pa` flags** from the flag mapping table, e.g. `pa app push`, `pa app add data-source --connector shared_office365 -c <conn-id>`.
- Substitute the resolved `$PA` prefix for the binary name at run time: canonical `pa app push` → run `${PA#npx --no-install } ...`, i.e. `npx --no-install pa app push` or `npx --no-install power-apps push`.
- **If `PA_KIND` is `power-apps`, translate each grouped command to its flat equivalent before running it — convert BOTH the verb path AND any renamed flags.** The flat binary does **not** understand the grouped noun-verb form (`power-apps app push` is invalid — it must become `power-apps push`), and it does **not** accept the renamed long flags (`--connector` must become `--api-id`/`-a`, `--table` must become `--resource-name`/`-t`, etc.).
- **Most flags are unchanged** — only the selector flags in the flag mapping table are renamed on `pa`. Connection ID (`-c`), dataset (`-d`), environment (`-e`), and display name (`-n` on `init`/`connection create`) are identical on both binaries.

---

## Command mapping table (grouped `pa` ↔ flat `power-apps`)

| Operation                | Canonical (`pa`)                  | Flat (`power-apps`)               |
| ------------------------ | --------------------------------- | --------------------------------- |
| Initialize project       | `pa app init`                     | `power-apps init`                 |
| Deploy / push            | `pa app push`                     | `power-apps push`                 |
| Local dev server         | `pa app run`                      | `power-apps run`                  |
| List code apps           | `pa app list`                     | `power-apps list-codeapps`        |
| Add data source          | `pa app add data-source`          | `power-apps add-data-source`      |
| Add Dataverse API        | `pa app add dataverse-api`        | `power-apps add-dataverse-api`    |
| Add flow                 | `pa app add flow`                 | `power-apps add-flow`             |
| Remove data source       | `pa app remove data-source`       | `power-apps delete-data-source`   |
| Remove flow              | `pa app remove flow`              | `power-apps remove-flow`          |
| Refresh data source      | `pa app refresh data-source`      | `power-apps refresh-data-source`  |
| Find Dataverse API       | `pa app find-dataverse-api`       | `power-apps find-dataverse-api`   |
| List environment vars    | `pa app list-environment-variables` | `power-apps list-environment-variables` |
| List flows               | `pa app list-flows`               | `power-apps list-flows`           |
| List connections         | `pa connection list`              | `power-apps list-connections`     |
| List connection refs     | `pa connection list-references`   | `power-apps list-connection-references` |
| Create connection        | `pa connection create`            | `power-apps create-connection`    |
| List connectors          | `pa connector list`               | `power-apps list-connectors`      |
| List datasets            | `pa connector list-datasets`      | `power-apps list-datasets`        |
| List tables              | `pa connector list-tables`        | `power-apps list-tables`          |
| List stored procedures   | `pa connector list-procedures`    | `power-apps list-sqlStoredProcedures` |
| Sign in                  | `pa auth login`                   | `power-apps login`                |
| Sign out                 | `pa auth logout`                  | `power-apps logout`               |
| Auth status              | `pa auth status`                  | `power-apps auth-status`          |
| Switch account           | `pa auth switch`                  | `power-apps auth-switch`          |
| Telemetry enable         | `pa telemetry enable`             | `power-apps telemetry --enable`   |
| Telemetry disable        | `pa telemetry disable`            | `power-apps telemetry --disable`  |
| Telemetry status         | `pa telemetry status`             | `power-apps telemetry --show-settings` |

> **Note:** the operations above differ only in verb structure. Renamed **flags** (which apply to several of these operations) are listed separately in the flag mapping table below.

---

## Flag mapping table (grouped `pa` ↔ flat `power-apps`)

The grouped `pa` surface renames these customer-facing selector flags and **drops their short aliases**. The flat `power-apps` surface keeps the original flag names and aliases. All other flags are identical on both binaries.

| Selector                | Canonical (`pa`)     | Flat (`power-apps`)                | Used by                                             |
| ----------------------- | -------------------- | ---------------------------------- | --------------------------------------------------- |
| Connector / API         | `--connector`        | `--api-id` (alias `-a`)            | `add data-source`, `connector list-*`, `connection create` |
| Table / resource        | `--table`            | `--resource-name` (alias `-t`)     | `add data-source`                                   |
| Data source name        | `--name`             | `--data-source-name` (alias `-n`)  | `add data-source`, `refresh data-source`            |
| SQL stored procedure     | `--procedure`        | `--sql-stored-procedure` (alias `-sp`) | `connector list-procedures`                      |
| Connection reference    | `--connection-ref`   | `--connection-ref` (alias `-cr`)   | `add data-source` (Dataverse) — **alias `-cr` dropped on `pa`, long flag unchanged** |

**Unchanged on both binaries** (do NOT rewrite these): `--connection-id`/`-c`, `--dataset`/`-d`, `--environment-id`/`-e`, `--display-name`/`-n` (on `init` and `connection create`), `--solution-id`, `--search`, `--cloud`.

> ⚠️ **`-n` is context-dependent.** On `add data-source`/`refresh data-source`, `-n` is the (renamed) `data-source-name` → `--name`. On `init` and `connection create`, `-n` is `display-name`, which is **not** renamed. Translate based on the verb, not the letter.

---

## `npx` prefix note

Skill examples elsewhere in the plugin are written in the **canonical grouped `pa` form** (e.g. `pa app push`). These are authoring shorthand — read them as the **canonical operation**, resolve `$PA`, and run the resolved form with the required `npx --no-install` prefix:

- resolved `pa`  → `npx --no-install pa <noun> <verb> ...`
- resolved `power-apps` → translate via the mapping table, then `npx --no-install power-apps <verb> ...`
