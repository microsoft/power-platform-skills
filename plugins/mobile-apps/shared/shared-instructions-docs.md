## Microsoft Learn MCP (authoritative Microsoft docs)

The plugin's `.mcp.json` also registers the **Microsoft Learn MCP server** (`microsoft-learn`, hosted HTTP at `https://learn.microsoft.com/api/mcp`). When the host advertises it, the agent can query official Microsoft documentation directly instead of guessing or relying on stale memory.

**Use rule — query Microsoft Learn whenever a Microsoft-platform behavior is uncertain.** Do not invent Dataverse/Power Platform/Graph syntax from memory. Concretely, prefer Microsoft Learn lookups for:

- Dataverse Web API: OData query syntax, `@odata.bind` lookup writes, `$expand` navigation property naming, batch / `$batch` semantics, choice / picklist / virtual / file / image column quirks, error response shape
- Power Apps CLI: `npx power-apps` command flags and Code Apps behavior; Power Platform environment / connection commands
- Power Platform connectors: connector reference pages, action / trigger schemas, OAuth scopes, throttling limits
- Microsoft Graph: endpoint paths, permission scopes, batch limits, beta vs v1.0 differences
- Power Apps Code Apps: SDK behaviors, generated-service shape, supported authentication flows
- Azure / Entra ID: app registration, redirect URI rules, token claims, MSAL flows

**Do NOT use Microsoft Learn for:** Expo / React Native / Tamagui / npm-ecosystem questions — those have nothing to do with Microsoft and the MCP returns no useful results.

**Fallback:** if the MCP is not available, fall back to the explicit `learn.microsoft.com` doc URLs already linked from skill files (e.g., `connector-reference.md`, `dataverse-reference.md`). Never block on MCP availability.

---

## Shell Requirement (Windows users)

All skills in this plugin assume a **POSIX shell** (bash or zsh). Skills shell out to standard POSIX utilities — `cp -R`, `rm -rf`, `mkdir -p`, `grep -E`, `sed`, `find`, `ls -1`, `uname` — in ~25 places. These do not exist in **native PowerShell** or **cmd.exe**.

**Supported on Windows:**
- Git Bash (ships with [Git for Windows](https://git-scm.com/download/win), includes MSYS coreutils) — recommended
- WSL 1 / WSL 2 with Ubuntu or any Linux distro
- Any other POSIX-compatible shell on PATH

**NOT supported on Windows:** native PowerShell, cmd.exe, ConEmu running cmd profile.

If a skill detects it's running in a non-POSIX shell (e.g. `cp` errors with "command not found"), STOP and instruct the user to switch to Git Bash or WSL before retrying.

Note on `az`: on Windows where it is installed as a `.cmd` shim and not on the bash PATH, prefix with `pwsh -NoProfile -Command "<command>"`. This works identically from Git Bash and WSL.

---

## Connector Reference

**📋 [connector-reference.md](./connector-reference.md)**

All non-Dataverse connectors require a connection ID or connection reference before `npx power-apps add-data-source`. Read this before any `/add-*` connector skill. Always run `/list-connections` first to create a supported connection, reuse a caller-provided connection ID, or resolve a solution connection reference.

---

