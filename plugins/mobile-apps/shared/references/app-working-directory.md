# Bind operations to the app root

Before any project read, package gate, or command, resolve one absolute
`working_dir` for this invocation:

- **Child invocation:** require the owner's absolute `working_dir`, including
  `--working-dir` when supplied. Never fall back to the process cwd. Missing or
  relative owner context returns `NEEDS_CONTEXT` before project access.
- **Direct invocation:** use `--working-dir` when supplied; otherwise capture the
  initial cwd once. Resolve a direct relative argument against that initial cwd.
- Canonicalize the existing filesystem directory using the host's native path
  APIs (for Node, `fs.realpathSync.native`). If the argument and owner context
  identify different roots, return `NEEDS_CONTEXT`; do not choose one silently.
  A missing or inaccessible directory is `BLOCKED`, not permission to scaffold
  or use cwd. Do not use Unix-only `realpath`/`readlink` flags on Windows.

Pass this resolved root unchanged to each nested helper. A prior `cd` or exported
variable does not persist across tool calls: **every shell call** must set its cwd
explicitly to this root, or begin with the applicable fail-closed guard below.
This includes commands copied from references, inline commands, discovery,
auth/environment checks, generation, refresh/removal, type-checking, validation,
telemetry, and retries. Keep `PLUGIN_ROOT` absolute and re-supply any required
shell variables from the current invocation context on each call; a missing
value returns `NEEDS_CONTEXT`, never an empty path or a cwd fallback.

## Bash (macOS/Linux or Git Bash on Windows)

Replace the entire quoted `"<working_dir>"` placeholder with one shell-quoted
literal argument, not raw interpolation inside double quotes. Single-quote the
path and escape an embedded apostrophe as `'\''`. On Windows use a Git Bash
compatible spelling of the same root, such as `C:/Users/maker/My App`, not an
unrelated WSL filesystem path. Never execute an unresolved placeholder.

```bash
cd -- "<working_dir>" || { echo "BLOCKED: cannot enter working_dir" >&2; exit 1; }
```

## PowerShell (Windows or PowerShell 7 on macOS/Linux)

Use a single-quoted native filesystem path and double embedded apostrophes.
`-LiteralPath` preserves spaces and wildcard characters such as brackets;
`-ErrorAction Stop` prevents subsequent commands after a failed directory change.
Do not paste Bash quoting or `|| exit 1` into Windows PowerShell.
See [Set-Location](https://learn.microsoft.com/powershell/module/microsoft.powershell.management/set-location).

```powershell
Set-Location -LiteralPath '<working_dir>' -ErrorAction Stop
```

## File tools

File tools do not inherit shell cwd. Give Read/Edit/Write/Grep/Glob absolute
project paths rooted at `working_dir`, including configuration, `node_modules`,
`native-app-plan.md`, `memory-bank.md`, `.tmp/`, `.power/`, `src/native/`, and
`src/generated/`. Keep plugin reference/script paths rooted at the absolute
`PLUGIN_ROOT`. Root binding grants no additional approval and does not relax
plan-only mode.
