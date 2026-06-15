# Helper Conventions

Normative conventions for `scripts/lib/*.js` helpers in the Power Pages plugin. This is a customer-facing product; these rules keep helpers consistent, debuggable, and safe.

## 1. Naming (verb-noun)

- Files are `<verb>-<noun>.js`. Verbs include: `list`, `get`, `create`, `discover`, `verify`, `check`, `detect`, `resolve`, `poll`, `wait`, `connect`, `disconnect`, `init`, `validate`, `refresh`, `remove`, `enable`, `update`, `write`, `read`, `render`, `parse`, `run`, `reconcile`.
- No service prefix unless ambiguous. `list-solutions.js`, not `list-dataverse-solutions.js`. ADO **is** prefixed (`list-ado-orgs.js`) because the same noun can refer to either Dataverse or ADO.
- Variants live in flags, not filenames: `poll-pending-changes.js --until-stable`, not `poll-pending-changes-stable.js`.
- Default scope is documented in the file banner, not encoded in the name (`list-solutions.js` documents "default filter = unmanaged, non-system").
- Max ~2 nouns/adjectives. Three or more → split the helper or rename.
- Tests mirror the helper name + `.test.js`. SKILL.md tests are `<skill-name>.skill-md.test.js`.

## 2. Error messages (N8)

Every helper error surfaced to a user MUST be a single line carrying three things, and MUST NOT leak a raw stack trace:

> **verb** (what was attempted) + **cause** (HTTP/Dataverse code or concrete reason) + **action** (what the user can do next)

Examples:
- ✅ `No ADO token available. Run az login, pass --token <bearer>, set ADO_TOKEN, or unset POWERPAGES_NO_ADO_ACQUIRE.`
- ✅ `Solution lookup HTTP 404 — verify --solutionUniqueName 'X' exists in this env.`
- ❌ `TypeError: Cannot read properties of undefined (reading 'token')` (raw stack trace)

Helper output contract: return `{ ok: false, error, statusCode? , hint? }` (or the helper's documented shape) rather than throwing for expected failures. Throw only for programmer errors. CLI entrypoints print the `error`/`hint`, never the raw token or full stdout.

## 3. ADO token resolution (B4)

ADO helpers resolve tokens through `scripts/lib/resolve-ado-token.js`. The default path is in-process self-acquisition: when no explicit token is supplied, helpers mint an ADO-scoped Entra token via `az` and use it directly in the Authorization header. ADO tokens are never written to disk, printed, or placed on a command line.

Explicit inputs remain available for CI and controlled environments, in this priority order:

1. explicit `--token <bearer>`
2. `ADO_TOKEN` environment variable
3. `--tokenFile <path>` — legacy compatibility only; do not introduce new token-file flows

Locked-down or CI environments can set `POWERPAGES_NO_ADO_ACQUIRE=1` to disable self-acquisition and require an explicit token.

## 4. Artifact paths and `--project-root` (B2)

Helpers that write under `docs/inner-loop/` MUST resolve the project root via `requireProjectRoot()` (`scripts/lib/inner-loop-paths.js`). Pass `--project-root <path>` explicitly — it is the supported path.

**Deprecation runway:** when `--project-root` is omitted, helpers currently emit a one-line `[DEPRECATION WARN]` and fall back to a cwd-based guess. This fallback becomes a **hard error after 2026-07-13** (`RUNWAY_HARD_ERROR_DATE`). Always pass `--project-root` to avoid polluting an unintended ancestor.

## 5. ADO token persistence

ADO tokens are never written to disk. Do not create token files, cache ADO JWTs under `docs/inner-loop/`, print raw token values, or pass acquired tokens on command lines. Helpers should self-acquire in-process by default or accept explicit CI-provided tokens.

## 6. Deterministic, testable helpers

- Accept dependency-injection hooks (`_execImpl`, `_readFileImpl`, `_nowImpl`, `_sleepImpl`, `_probeImpl`) so unit tests run without touching the network, clock, or shell.
- Pure functions (no I/O) where possible — e.g. `reconcile-manifest.js`, `classifyBinding`, `collapseFindings`.
- CLI entrypoint under `if (require.main === module)`; library exports via `module.exports`.

## 7. Deprecated-flag aliases

When renaming a flag, keep the old name working as an alias and emit a one-line `[DEPRECATION WARN]` (e.g. `verify-solution-exists.js` accepts `--uniqueName` as a deprecated alias for `--solutionUniqueName`). Document the deprecation and the removal date.
