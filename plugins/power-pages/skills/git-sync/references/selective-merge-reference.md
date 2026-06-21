# Selective Merge Reference — VS Code 3-way Merge Flow

Follow this when the `git-sync` conflict flow user picks **"Selectively merge (recommended)"** for one or more conflicted components (see `conflict-reference.md` Step 3). This is the inner-loop capability the Power Pages portal does **not** offer: keep some hunks from your environment and some from incoming Git, in a real 3-way merge.

> **User-facing voice:** speak plainly (see `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-user-language.md`). Show progress as `Phase 1 → 2 → 3 …`; never surface GUIDs, raw API names, or file SHAs in chat except on failure.

## Concept

A conflicted component was edited in **both** the environment (OURS) and the bound ADO branch (THEIRS) since the last sync (BASE). Dataverse stores the editable field inside `powerpagecomponent.content` as a JSON envelope; ADO stores it as a standalone source file. This flow:

1. Reads **OURS** live from Dataverse, **THEIRS** (branch tip) and **BASE** (`upstreamBranchSyncedCommitId`) from ADO.
2. Produces a **diff3 pre-seed** (non-overlapping hunks auto-merged; overlaps marked).
3. Opens the companion **VS Code extension** for a real 3-way selective merge (the human resolves; no AI proposes the merge).
4. Commits the clean merged file **to ADO**, then **accepts incoming** + **pulls** so Dataverse holds the merge (the product-lead round-trip).

Because the merged file already contains OURS's edits, accept-incoming loses nothing.

## Scope (v1)

Text-mergeable fields only: **web template `source`**, **content snippet `value`**, **web page `copy`/`summary`**. Web files, scalar site settings, and any credential/auth-classified setting stay on the binary **keep current / accept incoming** path (route them back to `conflict-reference.md` Step 4). Components deleted in Git (`deleted-in-git`) also route to the binary delete/keep choice.

## Operating rules

- Use the deterministic helpers under `${CLAUDE_PLUGIN_ROOT}/scripts/lib/`; never inline Dataverse/ADO REST calls.
- Artifacts live in an **owner-only OS-temp store** (`<os-temp>/pp-merge/<runId>/`), **off** the project/session tree — use the `runDir`/`launchUri` the helper prints, never a hardcoded path. They are **wiped on completion/cancel** (a TTL reaper clears orphans). `writeMergeWorkspace` runs a best-effort **secret scan** and returns `secretWarnings[]`; surface them. Secret/auth components are excluded from this flow upstream. (Pass `--insecure` to fall back to the legacy in-tree `docs/inner-loop/merge/<runId>/` location.)
- **Nothing is auto-applied.** The engine detects conflicts and stages the three sides; the human resolves in the editor. A result that still contains `<<<<<<<` markers is never committed.
- The ADO commit and the pull are **mutations** — gate them behind explicit consent.

## Step 1 — Assemble the merge inputs

**Goal:** Build BASE/OURS/THEIRS for every selectively-merged component field.

Inputs: the conflict roster (from `conflict-reference.md` Step 1, filtered to the components the user tagged "Selectively merge"), and the binding from `detect-git-binding.js` (must include `siteName` — the powerpagesite folder name).

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/build-merge-inputs.js" \
  --conflictsFile <selected-conflicts.json> \
  --bindingFile   <binding.json> \
  --siteName      <siteName> \
  --envUrl        "<envUrl>"
```

The helper reads OURS via `read-component-content.js`, resolves each component's ADO source-file path via `map-component-to-git-path.js`, and fetches THEIRS + BASE via `ado-get-file.js`. It routes non-text components to `binary-keep-accept` automatically.

**Output:** the build-merge-inputs manifest (BASE/OURS/THEIRS per field + `status` per unit).

## Step 2 — Materialize the merge workspace

**Goal:** Write the three sides + the bridge manifest for the native 3-way merge editor.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/merge-workspace.js" \
  --write --projectRoot <projectRoot> --manifestFile <build-merge-inputs-output.json>
```

`writeMergeWorkspace` writes, per unit, `units/<id>/{base.<ext>, dataverse.<ext>, ado.<ext>, merged.<ext>}` (real extensions so VS Code highlights Liquid/HTML) + `manifest.json` to the secure run store (owner-only `0o600`), and returns `runId`, `runDir`, `launchUri`, `secretWarnings[]`. **There is no `proposed.txt` and no AI/Copilot proposal** (removed 2026-06-19). `merged.<ext>` is the deterministic git-style **working file** — exactly what `git merge` writes: non-overlapping changes combined, overlaps shown as `<<<<<<< Dataverse / ======= / >>>>>>> Azure DevOps` for the human to pick. The 3-way merge itself is done by VS Code's native Merge Editor; the human resolves.

**Output:** the secure run store populated at the printed `runDir`; `launchUri` known; per-unit `hasConflicts` known; any `secretWarnings[]` surfaced to the maker.

## Step 3 — Open the VS Code merge editor

**Goal:** Actively pop the VS Code 3-way merge UI — do **not** just print the `launchUri` and wait.

**Run the launcher** (this is an executable step, not a link to hand the user). It opens VS Code's merge UI **whether or not VS Code is already running** — `code --open-url` reuses an open window or launches a new one, then the companion extension opens the native 3-way Merge Editor (Dataverse | Merged | Azure DevOps):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/launch-merge-editor.js" --runDir <runDir> --launchUri <launchUri>
```

The helper (`launchEditor`) escalates automatically and is cross-platform (it invokes the `code` CLI through a shell on Windows, where `code` is `code.cmd`): **deep link → open the run folder**. It prints `{ ok, via }`. If `ok:false`, fall back to the **built-in** 3-way editor (no extension needed) by running the per-unit commands the helper prints under `cliMerge` (`code --merge <dataverse> <ado> <base> <merged>`), or tell the maker to open the `runDir` folder and run **Power Pages Merge: Open Merge Run**.

- If VS Code shows **"Allow 'Power Pages Selective Merge' extension to open this URI?"**, that is the deep link working — choose **Open**.
- If VS Code shows **"A Power Pages merge is already in progress"**, choose **Cancel & open new** to open this run.

<!-- gate: git-sync:2.selective-merge-editor | category=pause | cancel-leaves=no-changes -->
> 🚦 **Gate (pause · git-sync:2.selective-merge-editor):** After launching, pause while the maker resolves the merge in VS Code. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | I've opened the 3-way merge editor in VS Code. Resolve the highlighted conflicts, save each file, then choose Finish in the editor. When you're done, how should I proceed? | Merge in progress | I've finished merging, Cancel — discard this merge |
>
> Cancellation leaves the environment and ADO untouched (no commit, no pull).

### Step 3-fallback — no VS Code

Tell the maker the `base.<ext>` / `dataverse.<ext>` (your environment) / `ado.<ext>` (incoming) / `merged.<ext>` files are in the `units/<id>/` folder under the run store path the helper printed (`runDir`), that `merged.<ext>` is the working file (git-style conflict markers), and to edit it to the desired final content (removing any `<<<<<<<` markers). Continue when they confirm.

## Step 4 — Read the resolved results

**Goal:** Collect the merged content, refusing anything still conflicted.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/merge-workspace.js" \
  --read --projectRoot <projectRoot> --runId <runId>
```

`readMergeCompletion` returns `resolved[]` (clean results, each `{ conflictId, componentId, name, type, adoPath, oursContent, mergedContent }`) and `unresolved[]`. Any unit whose `merged.<ext>` still contains `<<<<<<<` markers is **unresolved** and excluded from apply (D6). If `unresolved.length > 0`, list them and offer to reopen the editor or route those components to binary keep/accept.

**Also handle `deferredUnits`.** The merge workspace `manifest.json` carries a `deferredUnits[]` array — non-mergeable fields inside an otherwise selectively-merged component (a field deleted in Git, identical, or whose ADO path couldn't be resolved). These are NOT text-merged; resolve each via the binary **keep current / accept incoming** choice in `conflict-reference.md` Step 4 (for `deleted-in-git`, this is the delete-vs-keep decision). Never skip them — they are part of the same conflict and must be resolved for the cycle to reach Conflicts → 0.

**Output:** `resolved[]` (with `oursContent` for the apply snapshot) + any `deferredUnits[]` routed to keep/accept.

## Step 5 — Apply: commit to ADO, accept incoming, pull

**Goal:** Land the merged content in both ADO (versioned) and Dataverse.

Preview first (dry-run, no mutation):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/apply-merged-component.js" \
  --bindingFile <binding.json> --resolvedFile <resolved.json> \
  --envUrl "<envUrl>" --solutionUniqueName "<solutionUniqueName>" \
  --projectRoot <projectRoot> --runId <runId>
```

<!-- gate: git-sync:2.selective-merge-apply | category=consent | cancel-leaves=no-changes -->
> 🚦 **Gate (consent · git-sync:2.selective-merge-apply):** The next step commits the merged file(s) to Azure DevOps and pulls them into the environment. Surface `AskUserQuestion`:
>
> | Question | Header | Options |
> |---|---|---|
> | I'll commit your merged file(s) to the `{branch}` branch in Azure DevOps, then accept the incoming change and pull it into the environment. Proceed? | Apply selective merge | Commit & pull now, Cancel — keep merge local |
>
> Cancellation leaves the merged files in the secure run store only (no ADO commit, no pull); wipe them with `node merge-workspace.js --wipe --runId <runId>`.

On consent, re-run with `--apply`. The helper snapshots OURS, commits the merged file(s) to ADO in one push (`ado-commit-file.js`), runs `RefreshChangesFromGit`, accepts incoming per conflict (`resolve-conflict-accept.js`), runs `PullChangesFromGit`, re-lists conflicts to verify `Conflicts → 0`, then **content-verifies** (re-reads OURS and byte-compares, EOL-normalized, against the merged result). A mismatch downgrades the result to `partial` and reports `contentVerify[]` (positional metadata only — never raw content). Each phase is recorded to a resumable run-state.

**IL-015 fallback:** if `ResolveGitConflict` is unavailable on the tenant, the helper returns `status: "manual-resolution-required"` — the merged files are already committed to ADO; walk the maker through accepting the incoming change in the Maker Portal Conflicts tab, then pull.

**Recovery — resume / rollback.** If apply dies after the ADO commit (e.g. accept or pull fails), the run-state lets you continue or revert without losing work:

```bash
# Continue from the last good phase (skips commit/accept already done):
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/apply-merged-component.js" --resume --runId <runId>
# Restore the pre-merge OURS (commits the OURS snapshot back to ADO + pulls — never a history rewrite):
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/apply-merged-component.js" --rollback --runId <runId>
```

Both are consent-gated mutations (they commit + pull). Rollback is a forward-fix: it produces a new ADO commit restoring the original content, never a force-push.

**Output:** `last-conflict-resolution.json` (`strategy: "selective-merge"`, `adoCommitId`, per-component decisions, `contentVerify`) written; merged content in env + ADO.

## Step 6 — Hand back to the dispatcher

Re-detect state (`list-pending-changes.js` / `list-incoming-updates.js` / `list-conflicts.js`) and return to the `git-sync` dispatcher. Components resolved via selective merge are now committed to ADO and pulled; remaining conflicts (binary keep/accept, deleted-in-git) continue in `conflict-reference.md`.

## Scale & productization helpers (optional)

These deterministic helpers harden the flow for large solutions and production rollout. All are pure/testable and route through the same secure store; none propose a merge.

| Helper | Use when | What it does |
|---|---|---|
| `score-conflict-risk.js` (`scoreConflicts`) | before opening the editor | Scores each conflict (auth/secret/server-logic/plug-in/binary) and returns a `recommendedGate`: `binary-only` (force keep/accept — no inline merge), `elevated` (extra consent), or `standard`. `build-merge-inputs` already applies the **binary-only** override automatically. |
| `resolve-conflicts-bulk.js` (`resolveConflictsBulk`) | hundreds of conflicts / CI | Policy-driven bulk keep/accept (e.g. "accept all incoming bundle churn", "keep all mine for X") with a non-interactive mode. Selective (inline) units are never auto-decided. |
| `launch-merge-editor.js` (`buildLaunchPlan`) | opening VS Code | Robust launch: `vscode://` deep-link → `code --merge` CLI fallback → open-folder, with a graceful cancel/timeout lifecycle. |
| `record-merge-metrics.js` (`recordMergeMetrics`) | after every run | Appends privacy-safe metrics (conflict count, auto-merge ratio, per-phase durations, accept-path, risk mix) to skill-metrics — **positional metadata only, never source**. |

**Version handshake.** `merge-workspace.js` stamps `schemaVersion` (`SCHEMA_VERSION`) into `manifest.json`; the VS Code extension's `checkSchemaCompatibility()` (`MIN/MAX_SUPPORTED_SCHEMA`) shows a friendly *update-extension* / *update-plugin* prompt on drift (missing/legacy = best-effort, never blocked). Keep the two in lockstep when bumping — see `vscode-extension/PUBLISHING.md`.

## Error handling

| Condition | Handling |
|---|---|
| `build-merge-inputs` cannot map a component to an ADO path | Unit `status: path-unresolved`; route that component to binary keep/accept. |
| THEIRS 404 (deleted in Git) | Unit `status: deleted-in-git`; route to the delete/keep choice in `conflict-reference.md` §3. |
| VS Code / extension absent | Use Step 4-fallback (edit `result.txt` directly). |
| `merged.<ext>` still has markers at Step 4 | Unit is unresolved; never applied. Offer reopen or binary keep/accept. |
| ADO push conflict (branch moved) | `ado-commit-file.js` returns the conflict; re-run Step 5 (it re-resolves the branch tip). |
| `ResolveGitConflict` 404 (IL-015) | `manual-resolution-required`; merged files are in ADO — finish accept+pull via the Maker Portal. |
| Pull fails after accept | Marker `status: partial`; hand back to dispatcher with the remaining conflict. |

## Artifacts written

| Artifact | Inner-loop key | Purpose |
|---|---|---|
| `<os-temp>/pp-merge/<runId>/manifest.json` + `units/**` | — | Bridge workspace in the secure store (owner-only, ephemeral, off-tree, wiped on completion/cancel). |
| `<os-temp>/pp-merge/<runId>/completion.json` | — | Extension's completion record. |
| `<os-temp>/pp-merge/<runId>/snapshot/**` | — | Pre-apply OURS snapshot (reversibility/audit), in the secure store. |
| `<os-temp>/pp-merge/<runId>/run-state.json` | — | Resumable apply phase record (identifiers only, no source) for `--resume`/`--rollback`. |
| `docs/inner-loop/last-conflict-resolution.json` | `lastConflictResolution` | Resolution marker (`strategy: "selective-merge"`); metadata only, no component source. |

## Security

- Component source (BASE/OURS/THEIRS/result + the OURS snapshot) is kept **off** the project/session tree in an owner-only (`0o700` dir / `0o600` file) OS-temp store, **wiped** on completion/cancel with a TTL reaper for orphans — no durable plaintext leak. Override the store base with `PP_MERGE_STORE_ROOT` (e.g. an encrypted volume).
- A best-effort **secret scan** warns (`secretWarnings[]`) on inline credentials before they're materialized; secret/auth-classified site settings are excluded from selective merge entirely (binary/hard-gated only).
- ADO tokens are minted in-process and never persisted.
- Both mutating steps (ADO commit, Dataverse pull) are consent-gated.
