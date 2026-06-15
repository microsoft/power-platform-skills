# Manifest Contract — `.git-integration-manifest.json`

The `docs/inner-loop/.git-integration-manifest.json` file is the single local record of an environment's Git binding. Every inner-loop skill reads it in Phase 1 through the manifest path helper. The folder is auto-gitignored fail-closed, so the manifest is local-only state and must not have a project-root or env-root duplicate. Because it is local, it can drift from server truth — this document defines the contract and the reconciliation every skill must perform.

## Fields

| Field | Meaning |
|---|---|
| `bound` | `true` when the env (or solution) is bound to ADO Git. |
| `bindingType` | `"environment"` or `"solution"`. |
| `organization` / `project` / `repository` | ADO coordinates. |
| `branch` | Bound branch name. |
| `gitFolder` / `rootFolder` | Folder inside the repo that Dataverse writes to. |
| `solutionUniqueName` | Bound solution (solution binding only). |
| `gitIntegrationId` | Server-side binding id; the strongest identity signal. |
| `artifactRoot` *(optional)* | Where inner-loop artifacts are written (added by `git-configure` U5 when the selected artifact root differs from the default). |
| `lastCommitSha` *(optional)* | Last commit pushed by `commit-to-git`. |
| `lastVerifiedAt` | Timestamp of the last successful round-trip verify. |

Unknown keys MUST be tolerated — older skills ignore keys they don't recognise. New keys are additive only; never break the schema.

## Reconciliation (required in Phase 1 of every inner-loop skill)

A stale manifest is a silent-drift footgun: the local file can say `bound:true` after the ADO branch was deleted or the binding was torn down in the maker portal, while the server says `bound:false`. Acting on stale local state causes confusing failures later.

Every inner-loop skill MUST, in Phase 1:

1. Read the local manifest from `docs/inner-loop/.git-integration-manifest.json` (tolerate missing/!malformed → treat as `{}`).
2. Call `detect-git-binding.js` for server truth.
3. Call `reconcileManifest({ manifest, serverBinding })` from `scripts/lib/reconcile-manifest.js`.
4. If `aligned === false`, surface the divergence and let the user choose a remediation from `options`:
   - `overwrite-from-server` — trust the server, rewrite the local manifest (always offered).
   - `rebind-old-coords` — the local manifest names coordinates the server lost; offer to re-bind using them (offered when local bound, server unbound).
   - `clear-local` — wipe the local manifest and start fresh.

The helper is a pure function (no I/O); the skill performs the chosen remediation.

## Canonical Phase 1 snippet

```bash
# 1) server truth
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/detect-git-binding.js" --envUrl "<envUrl>" > server-binding.json
# 2) reconcile against the local manifest (pure JS; call via a tiny node -e or the skill's own logic)
#    reconcileManifest({ manifest, serverBinding }) → { aligned, divergences[], options[], summary }
```

> 🚦 **Gate (intent · `<skill>:1.manifest-stale`):** Fires when `reconcileManifest` returns `aligned:false`. Surface `AskUserQuestion` with the `options` list as choices plus Cancel. Cancellation leaves the manifest untouched.

## Why server truth wins

`detect-git-binding.js` queries `sourcecontrolconfigurations` / `sourcecontrolbranchconfigurations` live (see `inner-loop-empirical-findings.md` §8, §15, §26). The server is authoritative; the manifest is a cache. When they disagree, never silently trust the cache.
