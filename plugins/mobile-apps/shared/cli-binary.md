# CLI Binary Resolution (`pa` preferred, `power-apps` fallback)

<!-- Shares the command/flag mapping with plugins/code-apps/shared/cli-binary.md. Mobile deltas: current binary availability, app-scoped locked installation recovery, `connection list-*` rows, flag "Used by" cells, the `--force` row, and `--app-type`/`-t` on `init`. -->

**This file is the single source of truth for which CLI binary to run and how to translate commands.** Every skill that runs a Power Apps CLI command MUST resolve the binary using the algorithm below **before** running any command, and MUST author commands in the canonical grouped **`pa`** form (see the mapping table).

---

## Why two binaries

Depending on its version, `@microsoft/power-apps-cli` exposes the grouped `pa`
binary, the historical flat `power-apps` binary, or both:

| Binary       | Syntax  | Example                                    |
| ------------ | ------- | ------------------------------------------ |
| `pa`         | grouped | `pa app add data-source --connector ...`   |
| `power-apps` | flat    | `power-apps add-data-source -a ...`        |

For example, version **1.4.1** exposes only `pa`; do not expect a second binary
to exist. Probe the actual project's installed shims: **prefer `pa`** and
**fall back to `power-apps`** only when that legacy executable is present.
These examples do not authorize changing the app's CLI version.

**Two things differ between the binaries — the verb structure AND some flags:**

1. **Verb structure** — grouped noun-verb (`pa app push`) vs flat (`power-apps push`). See the command mapping table.
2. **Flag renames** — the grouped `pa` surface renames several customer-facing selector flags and **drops their short aliases** (the "Phase 2" `grouped_flag_renames` mechanism, now live). The flat `power-apps` surface keeps the original flags byte-identical. See the flag mapping table.

When translating a canonical `pa` command to flat `power-apps`, you must convert **both** the verb path and any renamed flags.

---

## Resolution algorithm (app-scoped)

Resolve from the **project root** (the directory containing `package.json` / `power.config.json`):

```bash
# Prefer the grouped `pa` binary; fall back to flat `power-apps`.
# --no-install is REQUIRED: it stops npx from silently fetching a remote
# package named `pa`/`power-apps` from the registry if no local shim exists.
# Probe both the extensionless shim (bash/sh) and the `.cmd` shim that
# package managers create on Windows, so a valid install is never missed.
if [ -e node_modules/.bin/pa ] || [ -e node_modules/.bin/pa.cmd ]; then
  PA="npx --no-install pa"          # grouped syntax  → use the "pa" column below
  PA_KIND="pa"
elif [ -e node_modules/.bin/power-apps ] || [ -e node_modules/.bin/power-apps.cmd ]; then
  PA="npx --no-install power-apps"  # flat syntax     → translate via the mapping table
  PA_KIND="power-apps"
else
  # Neither shim present → the CLI is not installed yet.
  # Follow the owning workflow's approved locked installation, then re-probe.
  PA=""
  PA_KIND="none"
fi
```

Rules:

1. **Probe by file presence only** — do not pin or parse a version. A shim (`.bin/pa` or, on Windows, `.bin/pa.cmd`) existing == the grouped binary is available. This is deterministic and cheaper than spawning `--version`. Always check the `.cmd` variant too: npm/pnpm/yarn/bun create `pa.cmd`/`power-apps.cmd` on Windows and an extensionless-only probe would misclassify a valid install as `none`.
2. **Always use `npx --no-install`.** Never run a bare `npx pa ...`: if the local shim is missing, npx would try to download and execute an unrelated remote package named `pa`. `--no-install` fails closed instead.
3. **Keep the result app-scoped.** A project memory-bank `CLI Binary` row is a hint, not proof that a shim still exists. Re-probe after dependency restoration or when changing app roots. Re-supply `$PA` and `PA_KIND` in every fresh shell as required by [app-working-directory.md](references/app-working-directory.md).
4. **`none` → approved installation recovery.** Do not run a floating `npm install` or fetch an unrelated CLI. Creation may install the acquired template's shipped lock after approval; an existing app follows its owning workflow's approved same-lock restoration, normally `npm ci` in the explicitly bound app directory. Preserve registry routing and package declarations, then re-probe. A missing lock or undeclared CLI requires review, not an automatic new dependency.

---

## Authoring rule for skills

- **Author every command in the canonical grouped `pa` form** (the left/`pa` column below), using the **renamed `pa` flags** from the flag mapping table, e.g. `pa app push`, `pa app add data-source --connector shared_office365 -c <conn-id>`.
- Substitute the resolved `$PA` prefix (which already contains `npx --no-install`) for the binary at run time. When `PA_KIND=pa`, run the canonical command as-is: `$PA app push` → `npx --no-install pa app push`. When `PA_KIND=power-apps`, translate the verb path (and renamed flags) per the next rule before running: `$PA push` → `npx --no-install power-apps push`.
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
| List datasets            | `pa connection list-datasets`     | `power-apps list-datasets`        |
| List tables              | `pa connection list-tables`       | `power-apps list-tables`          |
| List stored procedures   | `pa connection list-procedures`   | `power-apps list-sqlStoredProcedures` |
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
| Connector / API         | `--connector`        | `--api-id` (alias `-a`)            | `add`/`remove data-source`, `connection create`, `connection list-datasets`/`list-tables` |
| Table / resource        | `--table`            | `--resource-name` (alias `-t`)     | `add data-source`                                   |
| Data source name        | `--name`             | `--data-source-name` (alias `-n`)  | `remove data-source`, `refresh data-source`         |
| SQL stored procedure     | `--procedure`        | `--sql-stored-procedure` (alias `-sp`) | `add`/`remove data-source`                       |
| Connection reference    | `--connection-ref`   | `--connection-ref` (alias `-cr`)   | `add data-source` — **alias `-cr` dropped on `pa`, long flag unchanged** |
| Destructive confirmation | `--force` (required with `--non-interactive`) | omit — flat proceeds without confirming, and older flat `remove-flow` has no `--force` | `remove data-source`, `remove flow` |

**Unchanged on both binaries** (do NOT rewrite these): `--connection-id`/`-c`, `--dataset`/`-d`, `--environment-id`/`-e`, `--display-name`/`-n` (on `init` and `connection create`), `--app-type`/`-t` (on `init`), `--org-url`, `--flow-id`, `--account`, `--solution-id`, `--search`, `--cloud`.

> ⚠️ **`-n` and `-t` are context-dependent.** On `remove data-source`/`refresh data-source`, `-n` is the (renamed) `data-source-name` → `--name`; on `add data-source`, `-t` is the (renamed) `resource-name` → `--table`. On `init` and `connection create`, `-n` is `display-name`, and on `init`, `-t` is `app-type` — **neither is renamed**, so `pa app init -t MobileApp` is valid on both binaries. Translate based on the verb, not the letter.

---

## `npx` prefix note

Skill examples elsewhere in the plugin are written in the **canonical grouped `pa` form** (e.g. `pa app push`). These are authoring shorthand — read them as the **canonical operation**, resolve `$PA`, and run the resolved form with the required `npx --no-install` prefix:

- resolved `pa`  → `npx --no-install pa <noun> <verb> ...`
- resolved `power-apps` → translate via the mapping table, then `npx --no-install power-apps <verb> ...`
