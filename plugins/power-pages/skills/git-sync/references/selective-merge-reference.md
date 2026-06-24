# Selective Merge Reference — Clone-based native VS Code flow

Follow this when the `git-sync` conflict flow user picks **"Selectively merge (recommended)"**. This is the only conflict path for that option and is self-contained in `git-sync`: it stages a real Git merge in an off-tree clone so VS Code's native Source Control view, 3-way Merge Editor, and CodeLens operate on the actual `.html` / `.yaml` files.

> **User-facing voice (C):** speak plainly (see `${CLAUDE_PLUGIN_ROOT}/references/inner-loop-user-language.md`). Show progress as `Phase 1 → 2 → 3 …`; never surface GUIDs, raw API names, file SHAs, clone internals, JSON status objects, or source snippets in chat **except on failure**. Translate helper output into plain-language summaries — e.g. "✅ 8 resolved, ⚠️ 2 need one click" instead of a `needs-resolution` object or conflict array. **Auto-open** `docs/inner-loop/conflicts.html` for the maker rather than telling them to open a file. Clarify web-file routing inline: text-like bytes (any extension) go to VS Code; truly-binary or ambiguous bytes go to the keep/accept matrix.

## Concept

A conflicted component was edited in **Dataverse** (OURS) and in the bound Azure DevOps branch (THEIRS) since a common **BASE**. The resolver:

1. Reuses the flat clone recorded at `git-configure` time (`<cloneDir>/repo`, with `<cloneDir>/.pp-merge` for local run-state).
2. Creates a real Git merge: `dataverse` branch at BASE, OURS committed as **Current = Dataverse**, then the ADO tip merged as **Incoming = Azure DevOps**.
3. Opens the clone folder in VS Code so the maker resolves Git's actual unmerged paths and conflict markers.
4. Verifies the merge is clean, then pushes safely: fast-forward to the bound branch when allowed, otherwise a `pp-merge/<user>/<branch>-<timestamp>` branch plus PR with auto-complete enabled.
5. Runs the existing Dataverse reconciliation round-trip: refresh → accept incoming → pull → verify no conflicts → content-verify.

No force-push is allowed. No token, component source, or merged content is written to logs or run metadata.

> **BASE selection (A2):** the base must be a commit that **contains the conflicted files**, so the merge is a real modify/modify 3-way (the editor shows a populated base + only divergent hunks). The builder supplies **both** `branchSyncedCommitId` (the env's last inbound sync — usually the correct base) **and** `upstreamBranchSyncedCommitId`; the resolver picks the first that contains every conflicted file and **auto-discovers** one by walking the branch history when neither does. A base lacking the files would degrade to add/add (whole-file conflict, no base) — the resolver detects that and surfaces a warning rather than failing silently.

## Scope

Text-mergeable units use the clone flow: web template `source`, content snippet `value`, web page `copy` / `summary`, flat-yml site settings, and **web files type `3` whose Dataverse annotation `documentbody` bytes are detected as text by the runtime content sniff**. Web-file eligibility is based on bytes, not extension, so any extension can open in the 3-way editor when the sniff says text.

Binary/scalar units are **not** text-merged. Truly-binary or ambiguous web files type `3`, scalar site settings type `9`, and deleted-in-Git components are resolved **per file** via the numbered matrix in Phase 3a — the user picks which to **Accept Incoming**; the rest **Keep Current**. Credential/auth-classified settings stay out of selective merge.

> **Web-file sniff and safety:** the resolver reads web-file bytes from the Dataverse annotation `documentbody` (base64) and routes them with a Git-like text/binary content sniff. The sniff **fails closed to binary** on ambiguity — NUL byte, invalid UTF-8, or a high control-character ratio — so uncertain content never risks text corruption. Text-detected web files enter the normal VS Code 3-way merge; truly-binary or ambiguous web files stay in the per-file keep/accept matrix.

## Clone lifecycle (D)

The **whole repo** is cloned **once, at `git-configure` time**, to a **user-chosen flat directory** and recorded in the per-project git-integration manifest. `git-sync` does **not** derive a path and does **not** clone at conflict time when the record is present.

- **At `git-configure`** (setup / rebind / switch-branch): after the binding is established, ask the user to name the clone folder and where it should live, with a sensible suggested name (`<solutionUniqueName>`) placed under a shallow default parent (e.g. `<userHome>/PowerPages/<solutionUniqueName>`). Call `cloneOrUpdateRepo({ cloneDir, repoUrl, branch, token })`, set `core.longpaths=true`, apply owner-only ACLs, and keep tokens in-process only.
- **Flat layout:** `<cloneDir>/repo` is the working tree. `<cloneDir>/.pp-merge` is the local-only merge scratch/run-state directory. `.pp-merge` contains identifiers, positions, and phase state only; never component source.
- **Record** the location in the per-project **git-integration manifest** `clone` block (authoritative; `clone-record.js` → `writeCloneRecord`/`readCloneRecord`). The frozen coordinate set is `env`, `organization`, `project`, `repository`, `rootFolder`, `gitFolder`, `branch`, and `solutionUniqueName`.
- **`git-sync` reuses** the recorded clone (`readCloneRecord` → `cloneMatches`):
  - **Match** (coordinates + solution match) → print the path, fetch/refresh it, and use it for the staged merge.
  - **Missing record** → gracefully prompt for a clone directory, clone there, then write the manifest record before continuing.
  - **Mismatch** (repo/folder/branch/solution drifted) → stop with a clear explanation and route back through `git-configure` so the clone record is updated by the binding workflow.
- **switch-branch / rebind** updates the clone record during `git-configure`. **disconnect** offers to keep or remove the recorded clone (never deletes without consent).

## Entry point

The orchestrator CLI is the only entry point:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/clone-merge-resolver.js" --input <inputs.json> [--apply] [--resume] [--allow-push] [--allow-pull] [--allow-restart] [--binary-accept <serials>] [--binary-accept-all] [--binary-keep-mine] [--no-pause]
```

**Flat-YML site settings (type `9`) are text-merged.** A site setting serializes to a single flat `.sitesetting.yml` (metadata + one `value:` line). The resolver merges the **whole yml** as a normal text unit: it synthesizes OURS by substituting the environment's value into the yml skeleton, so OURS and the ADO side differ **only on the `value:` line** (metadata is identical → git auto-merges it). The setting therefore opens in the **3-way merge editor** like any html unit (`Dataverse.yml` / `ADO.yml` / `Base.yml`), and the reconcile compares/pulls the `value:` field. Only a site setting whose value is **multi-line** falls back to the keep/accept matrix below.

**Per-file binary/scalar resolution (matrix).** Binary units (truly-binary or ambiguity-routed web files type `3`, plus any **multi-line** site-setting value that can't be flat-yml merged) can't open in VS Code, so they are resolved **per file**, not with one blanket choice. The resolver returns a numbered `binaryMatrix` (serial, name, type); the agent presents it as a table and asks **which files to Accept Incoming** (take the ADO version). Everything the user does **not** pick **Keeps Current** (the environment's value). Pass the selection on resume:

- `--binary-accept <serials>` — comma/space-separated serials **and ranges** to **accept incoming** (e.g. `--binary-accept "9,12"` or `"9-11"`); robustly parsed (`parse-serial-selection.js`) and validated against the matrix serials — invalid/out-of-range input errors out so the agent can re-ask. The rest keep current.
- `--binary-accept-all` — accept incoming for every binary file.
- `--binary-keep-mine` (or no flag) — keep current for every binary file (the default).

`inputs.json` contains only identifiers and conflict coordinates; tokens are acquired in-process and are **not** included.

> **Never hand-build `inputs.json` (A3).** Generate it deterministically with `build-merge-inputs.js`, which composes the binding (org/project/repo, branch, rootFolder/gitFolder, and **both** synced commit IDs) from `detect-git-binding.js`, the conflict roster from the **enriched** `list-conflicts.js` (numeric `ppcType`, `mergeStrategy`, `eligibleForSelectiveMerge`), and the clone record. It writes to the clone's local-only `.pp-merge/` (outside the worktree, so the resolver's own clean step can't wipe it). Hand-built inputs caused two live failures — a missing synced-commit-id → add/add whole-file conflict, and a string component `type` → silent empty merge that dropped the env's edits.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/build-merge-inputs.js" \
  --binding <binding.json> --conflicts <enriched-conflicts.json> \
  --cloneDir <cloneDir> --envUrl <envUrl> \
  --solutionUniqueName <name> [--solutionId <guid>] [--user <alias>] \
  --out <cloneDir>/.pp-merge/merge-inputs.json
```

Component `type` may be a **name or a number** — `"webtemplate"` and `8` are equivalent (normalized via `component-type-map.js`); the builder always emits numeric types. Shape:

```json
{
  "cloneDir": "<cloneDir>",
  "envUrl": "<envUrl>",
  "solutionUniqueName": "<solutionUniqueName>",
  "solutionId": "<solutionId>",
  "binding": {
    "organization": "<adoOrg>",
    "project": "<adoProject>",
    "repository": "<repoName>",
    "repositoryId": "<repoId-optional>",
    "branch": "<branch>",
    "rootFolder": "<rootFolder>",
    "gitFolder": "<gitFolder>",
    "baseCommit": null,
    "branchSyncedCommitId": "<branchSyncedCommitId>",
    "upstreamBranchSyncedCommitId": "<upstreamBranchSyncedCommitId>"
  },
  "conflicts": [
    { "conflictId": "<conflictId>", "componentId": "<componentId>", "name": "<displayName>", "type": 8, "componentPath": "<path>", "field": "<field>" }
  ],
  "user": "<userAlias>"
}
```

> `baseCommit` is left `null` so the resolver's base picker chooses from the candidates (and can auto-discover). `type` is numeric (the builder normalizes names → numbers).

## Phased skill flow

### Phase 1 — Plan only

Run without `--apply`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/clone-merge-resolver.js" --input <inputs.json>
```

Expected status: `dry-run`. The JSON plan lists the clone path, eligible text units, binary/scalar units that must stay on keep/accept, branch-policy findings, and the next required gate.

### Phase 2 — Consent to stage the local merge

<!-- gate: git-sync:clone-merge.resolve | category=pause | cancel-leaves=no-changes -->
> 🚦 **Gate (pause · git-sync:clone-merge.resolve):** Ask whether to open the clone-based merge now.
>
> | Question | Header | Options |
> |---|---|---|
> | I'll create or update an off-tree clone, stage a real Git merge for the conflicted text files, and open VS Code. No ADO or Dataverse changes happen yet. Proceed? | Selective merge | Open VS Code merge, Cancel — no changes |
>
> Cancellation leaves ADO and Dataverse untouched.

On approval, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/clone-merge-resolver.js" --input <inputs.json> --apply
```

Expected status: `awaiting-resolution`. The helper clones/fetches, checks out `dataverse` at BASE (or an empty/orphan add-add base when BASE is null), writes OURS for only the conflicted files with EOL/BOM shaped to match repo bytes, commits `Current=Dataverse`, merges the ADO tip as `Incoming=Azure DevOps`, then **launches VS Code straight into the 3-way Merge Editor** for the first conflict via `code --merge <env> <ado> <base> <result>` (Task 1) — and also opens the folder so the Source Control "Merge Changes" list is one click away. The result carries `scmPointer` (a plain-language "Open Source Control (Ctrl/Cmd+Shift+G)…" hint to relay) and a `binaryMatrix` (when there are binary/scalar conflicts) for the matrix gate below.

> **Task 1 — never land on a blank Explorer.** The `code` CLI has no flag to focus the SCM viewlet, so the resolver opens the first conflict **directly in the merge editor** (`--merge`). Relay `scmPointer` so the maker can reach the remaining conflicts from the "Merge Changes" list.

### Phase 3a — Binary/scalar matrix (per-file Accept Incoming vs Keep Current)

Binary/scalar files (truly-binary or ambiguity-routed web files, scalar site settings) **can't open in VS Code**, so resolve them in chat from the returned `binaryMatrix`. Present a numbered table using the **same serial numbers as the overall conflict list** (e.g. 9–15), each row `S.No | component | type | note`, and point to `docs/inner-loop/conflicts.html` for the side-by-side view:

> | # | File | Type | Note |
> |---|------|------|------|
> | 9 | HTTP/X-Frame-Options | Site Setting | scalar value |
> | 10 | TermsAgreementEnabled | Site Setting | scalar value |
> | 12 | Cat-PC.png | Web File | binary image |
> | 14 | logo.dat | Web File | ambiguous bytes → binary |
>
> 🚦 **Gate (progress · git-sync:clone-merge.binary-matrix):** "Enter the serial numbers of the files to **ACCEPT INCOMING (Git wins)** — comma/space separated, ranges like `9-11` allowed. All others will **KEEP CURRENT (env wins)**. Shortcuts: `all` = all incoming, `none` = all keep."

**Parse robustly + re-ask.** Parse the answer with `parse-serial-selection.js` (commas, spaces, ranges, `all`/`none`). On any invalid or out-of-range token, show which tokens were bad and **re-ask** — never silently drop or misassign. Then **echo the per-file plan and confirm** before applying, e.g.:

> "Accept incoming: #9, #12 · Keep current: #10, #11, #13, #14, #15 — proceed?"

Carry the answer into the resume call as `--binary-accept <serials/ranges>` (e.g. `--binary-accept "9,12"` or `"9-11"`), or the shortcuts `--binary-accept-all` / `--binary-keep-mine`. Each component's resulting `decision` (`accept-incoming` | `keep-current`) flows through the single reconcile/commit (A7/A8). If there are no binary/scalar conflicts, skip this gate.

### Phase 3 — Wait for VS Code resolution (mandatory pause gate B5)

VS Code opens directly in the 3-way **Merge Editor** for the first conflict (Task 1); the "Merge Changes" list (Source Control, Ctrl/Cmd+Shift+G) holds the rest. A `.vscode/settings.json` (written into the clone, git-excluded so it never reaches ADO) keeps the base panel visible.

> **Task 3 — Env LEFT, ADO RIGHT.** The merge editor the resolver opens shows **Dataverse (your environment) in the LEFT input** and **Azure DevOps (incoming) in the RIGHT input**, base at the bottom — driven by the `code --merge <env> <ado> <base> <result>` argument order (left=env, right=ado). The three input files are named **`Dataverse.<ext>`**, **`ADO.<ext>`** and **`Base.<ext>`** (real extension kept for syntax highlighting), so each panel title reads clearly instead of the long flattened repo path. This is **presentation only**: git staging, the merged tree pushed to ADO, base correctness, and the reconcile contract (`accept-incoming = ADO`, `keep-current = env`) are unchanged. (This supersedes the earlier B4 "never swap sides" caution — sides are now explicitly Env-left/ADO-right via `--merge`, not by swapping git stages.) Files opened by clicking the SCM "Merge Changes" list use VS Code's fixed incoming-left/current-right order; resolving through the merge editor the resolver opens gives the Env-left/ADO-right layout.

You **must** surface this blocking gate after opening VS Code — a fast model must not skip it:

<!-- gate: git-sync:clone-merge.done | category=pause | cancel-leaves=local-clone-only -->
> 🚦 **Gate (pause · git-sync:clone-merge.done):** Have you finished resolving all conflicts in VS Code?
>
> | Question | Header | Options |
> |---|---|---|
> | Resolve every conflict in VS Code's Merge Editor and save each file. When all are done, I'll verify and continue. | Merge complete? | Yes — verify now, Not yet, Cancel |

- **Yes — verify now** → run `--resume` (Phase 4). If files remain unresolved, show a **plain-language** remaining list ("2 of 5 still have unresolved conflicts: Footer, Search Results") and **re-present this gate** — never advance.
- **Not yet** → wait and re-ask; do not run anything.
- **Cancel** → leave ADO and Dataverse untouched; the local clone can be reused or wiped.

Never advance to the commit/push (Phase 5+) without an explicit **Yes** that passes verification.

### Phase 4 — Verify the resolved clone and pause before shared-state changes

After the maker confirms, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/clone-merge-resolver.js" --input <inputs.json> --apply --resume
```

The helper requires:

- `0` unmerged paths from Git.
- `0` remaining conflict markers.
- The expected conflicted-file roster only.

If anything remains unresolved, return `needs-resolution` and reopen or guide the maker back to VS Code. If local state was changed in a way that cannot be safely resumed, return `manual-resolution-required` or require `--allow-restart` before rebuilding the local merge.

### Phase 5 — Push or PR consent

Before any ADO mutation, pre-check branch policy with `ado-get-branch-policies` and use a defensive fallback if policy lookup fails.

<!-- gate: git-sync:clone-merge.push | category=consent | cancel-leaves=no-changes -->
> 🚦 **Gate (consent · git-sync:clone-merge.push):** Ask before pushing any branch to Azure DevOps.
>
> | Question | Header | Options |
> |---|---|---|
> | The files are resolved locally. I can push the merge safely now. If direct update is allowed, this fast-forwards `{branch}`; otherwise it creates a `pp-merge/...` branch for a PR. Proceed? | Push merge | Push now, Cancel — keep merge local |
>
> Cancellation leaves ADO and Dataverse unchanged.

If the policy pre-check shows a PR is required, also surface the PR consent before the push phase creates or updates the PR:

<!-- gate: git-sync:clone-merge.pr | category=consent | cancel-leaves=branch+pr-created -->
> 🚦 **Gate (consent · git-sync:clone-merge.pr):** Ask before creating the PR / enabling auto-complete when direct branch update is not allowed.
>
> | Question | Header | Options |
> |---|---|---|
> | Branch policy requires a PR. I'll create `pp-merge/<user>/<branch>-<timestamp>`, open a PR to `{branch}`, and enable auto-complete. Proceed? | Create merge PR | Create PR, Cancel — leave branch and PR as-is |

On approval, resume with push allowed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/clone-merge-resolver.js" --input <inputs.json> --apply --resume --allow-push
```

If the PR cannot merge immediately because reviewers or builds are pending, the helper returns `awaiting-pr`. Stop and tell the maker to resume later after the PR merges:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/clone-merge-resolver.js" --input <inputs.json> --apply --resume --allow-push
```

### Phase 6 — Dataverse pull consent

After the ADO side is landed or the PR has merged, pause before mutating Dataverse.

<!-- gate: git-sync:clone-merge.pull | category=consent | cancel-leaves=ado-has-merge-env-not-updated -->
> 🚦 **Gate (consent · git-sync:clone-merge.pull):** Ask before accepting incoming changes and pulling into Dataverse.
>
> | Question | Header | Options |
> |---|---|---|
> | The merge is now in Azure DevOps. I can refresh Dataverse, accept the incoming merge, pull it into the environment, and verify the content. Proceed? | Pull merged content | Pull into Dataverse, Cancel — leave ADO updated only |

On approval, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/clone-merge-resolver.js" --input <inputs.json> --apply --resume --allow-push --allow-pull
```

Expected successful final status: `success`.

## Reconciliation details

The final phase reuses the existing Dataverse path:

1. `RefreshChangesFromGit`.
2. Accept incoming with `useraction=2` PATCH (`resolve-git-conflict-useraction`), which is IL-015-proof.
3. `PullChangesFromGit`.
4. Verify `Conflicts=0`.
5. Content-verify: re-read OURS, normalize EOL, byte-compare against the resolved content. For source-field text units, a mismatch returns `partial` with positional metadata only; never include raw source in diagnostics. Text-detected web files get the `documentbody` fallback below before `partial`.

For text-detected web files, the write-back still rides the same push → accept incoming (`useraction=2`) → `PullChangesFromGit` round-trip, but the bytes live in the annotation `documentbody` rather than the component `content` envelope. After pull, re-read OURS `documentbody`, base64-decode, normalize EOL, and compare to the resolved bytes. If the pull did not update the bytes, PATCH the annotation `documentbody` with the resolved base64 as a fallback, then re-read and verify again.

## Statuses

| Status | Meaning | Next action |
|---|---|---|
| `dry-run` | Plan produced; no local or shared mutation. | Ask to proceed. |
| `awaiting-resolution` | Clone merge staged and VS Code opened. | Wait for maker to resolve. |
| `needs-resolution` | Unmerged paths or markers remain. | Reopen VS Code / continue resolving. |
| `awaiting-pr` | PR exists but is waiting for reviewers/builds/auto-complete. | Resume later after merge. |
| `success` | ADO and Dataverse reconciled; content verified. | Return to dispatcher. |
| `partial` | Reconciliation ran but content verification mismatched. | Report positional metadata and hand back to dispatcher. |
| `manual-resolution-required` | The helper cannot safely automate the remaining step. | Walk the maker through manual completion. |
| `cancelled` | User cancelled at a gate. | Stop with documented state. |
| `failed` | Unexpected failure. | Report phase, safe retry/resume guidance. |

## Run-state and rollback

Run-state lives in `.pp-merge` and records phases only by identifiers/positions:

`started → staged → resolved → pushed → refreshed → accepted → pulled → verified`

Pause statuses are `awaiting-resolution` and `awaiting-pr`. Resume with `--resume`; restart a local stage only when the helper requires `--allow-restart`. Rollback is forward-only: never rewrite Git history and never force-push.

## Helpers

| Helper | Purpose |
|---|---|
| `git-exec.js` | Git CLI wrapper; passes ADO tokens via `http.extraHeader`. |
| `clone-record.js` | Read/write the per-project manifest `clone` block and validate coordinate matches. |
| `clone-or-update-repo.js` | Full clone or fetch/reset with smart reuse. |
| `eol-bom.js` | Match repo file EOL/BOM when writing OURS. |
| `detect-merge-state.js` | Detect in-progress merge, unmerged paths, markers, and roster. |
| `stage-git-merge.js` | Stage the real Git merge. |
| `open-merge-folder.js` | Run `code <path>` with fallback instructions. |
| `push-or-pr.js` | Fast-forward push or branch + PR with auto-complete. |
| `reconcile-dataverse.js` | Refresh → accept → pull → verify → content-verify. |
| `merge-run-state.js` | Resumable run-state in `.pp-merge`. |
| `clone-merge-resolver.js` | Orchestrator and CLI. |

Reused helpers: `detect-git-binding`, `list-conflicts`, `list-source-control-components`, `read-component-content`, `map-component-to-git-path`, `resolve-git-conflict-useraction`, `refresh-changes-from-git`, `pull-changes-from-git`, `resolve-conflict-keep`, `resolve-conflict-accept`, `record-merge-metrics`, `ado-create-pr`, `ado-get-branch-policies`, `create-ado-branch`, and `acquire-ado-token`.

## Security

- ADO tokens are minted in-process, passed to Git through headers, and never written to disk, command URLs, stdout, stderr, or logs.
- Clone directories and files are owner-only (`0700` / `0600`).
- `.pp-merge` stores identifiers, phase state, and positions only; never component source.
- Consent is required before every shared-state mutation: push, PR creation, and Dataverse pull. Local steps (clone/fetch/stage/open VS Code) can proceed after the resolve gate.
- Never force-push. Never store merged source in `docs/inner-loop/` markers.

## Artifacts written

| Artifact | Purpose |
|---|---|
| `<cloneDir>/repo` | Recorded full clone containing the real Git merge. |
| `<cloneDir>/.pp-merge/merge-inputs.json` | Resolver input with `cloneDir`, binding, and conflict coordinates; identifiers only. |
| `<cloneDir>/.pp-merge/run-state.json` | Resumable phase record, identifiers only. |
| `docs/inner-loop/last-conflict-resolution.json` | Final resolution marker (`strategy: "selective-merge"`), metadata only. |

## Dispatcher hand-back

After `success` or `partial`, re-detect state with `list-pending-changes.js`, `list-incoming-updates.js`, and `list-conflicts.js`, then return to the `git-sync` dispatcher. Binary/scalar conflicts that were not eligible continue through `conflict-reference.md` keep/accept handling.
