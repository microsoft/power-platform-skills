# Publishing the Power Pages Selective Merge extension

This companion extension is distributed through the Visual Studio Marketplace and is
version-handshaked with the Power Pages plugin via the bridge **schema version**.

## Version handshake (plugin ↔ extension)

The agent writes `schemaVersion` into every run's `manifest.json`
(`merge-workspace.js` → `SCHEMA_VERSION`). On launch the extension calls
`checkSchemaCompatibility(manifest.schemaVersion)` (`src/mergeRun.ts`):

| Situation | Verdict | What the user sees |
|---|---|---|
| `schemaVersion` within `[MIN_SUPPORTED_SCHEMA … MAX_SUPPORTED_SCHEMA]` | ✅ proceed | merge opens normally |
| `schemaVersion` **higher** than the extension supports | ❌ `update-extension` | "Update the extension" + *Open Extensions* button |
| `schemaVersion` **lower** than the extension supports | ❌ `update-plugin` | "Update the Power Pages plugin/CLI" |
| missing / non-numeric (legacy) | ✅ best-effort | merge opens (no block) |

**When you bump the bridge schema:** change `SCHEMA_VERSION` in
`scripts/lib/merge-workspace.js`, then widen `MAX_SUPPORTED_SCHEMA` (and, only on a
breaking change, `MIN_SUPPORTED_SCHEMA`) in `src/mergeRun.ts`, ship a new extension
version, and keep the two in lockstep. The handshake tests in
`src/test/mergeRun.test.ts` guard the verdicts.

## One-time setup

1. Create a **publisher** in the Marketplace management page
   (https://marketplace.visualstudio.com/manage). The `publisher` field in
   `package.json` (currently `power-pages`, a placeholder) **must** match it.
   > **Decision needed:** confirm the real publisher identity/account that owns
   > this extension before the first publish — do not publish under a guessed id.
2. Create an Azure DevOps **Personal Access Token** with the *Marketplace → Manage*
   scope, then `npx vsce login <publisher>`.

## Build, package, publish

```bash
# from plugins/power-pages/vscode-extension
npm ci
npm run compile          # esbuild → dist/extension.js
npm run package          # → powerpages-merge-<version>.vsix  (vsce package)
npm run publish          # vsce publish  (signs + uploads to the Marketplace)
```

## Signing

- **Public Marketplace:** Microsoft signs every accepted `.vsix` server-side on
  publish — there is no local certificate step. Keep the package reproducible
  (`--no-dependencies`, committed `package-lock.json`).
- **Private / enterprise (self-host or internal gallery):** distribute the `.vsix`
  via your internal feed. If your org requires Authenticode-signed VSIX packages,
  sign with your enterprise cert in the release pipeline **before** distribution.
  > **Decision needed:** which channel — public Marketplace vs. internal gallery —
  > and whether an enterprise signing cert is mandated.

## Release checklist

- [ ] `npm run typecheck` and `npm run test:unit` green.
- [ ] `version` bumped (semver); `MAX_SUPPORTED_SCHEMA` covers the current
      `SCHEMA_VERSION`.
- [ ] `CHANGELOG`/README note for the release.
- [ ] `vsce package`, smoke-test the `.vsix` in a clean VS Code, then `vsce publish`.

