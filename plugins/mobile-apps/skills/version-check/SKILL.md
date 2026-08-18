---
name: version-check
description: Use when the user wants to check the mobile-app plugin or a Power Apps mobile app for updates, upgrade its supported native host template, or determine whether the installed skill and Expo template are current.
user-invocable: true
allowed-tools: Read, Edit, Bash, Glob, AskUserQuestion
model: sonnet
---

**📋 Shared instructions: [shared-instructions.md](${CLAUDE_SKILL_DIR}/../../shared/shared-instructions.md)** — read first.

# Check and Upgrade Mobile App

Checks for a newer plugin and native host package, then previews and applies approved template migrations up to the version bundled with this plugin.

## Invariants

- `supported` is `expo.extra.powerappsNative.templateVersion` from `${CLAUDE_SKILL_DIR}/../../template/app.json`; `current` is the same field in the app's `app.json`. Both must be positive integers.
- `declaredHost` comes from the app's `package.json`; `latestHost` comes from the npm feed's `latest` dist-tag. Resolve once and pin every command in this run to that exact version.
- The `latestHost` dry-run is authoritative; local version equality does not prove the app is current.
- Never self-update the plugin, downgrade an app, manually change template/migration state or lockfiles, or touch `app/`, `src/`, `android/`, or `ios/`.
- Every mutation requires one prior approval and a clean dry-run. Preserve all pre-existing work; restore only edits made by this skill.
- Auto-merge only unambiguous conflicts. Stop on interrupted journals, failed validation, unexpected writes, invalid version movement, or unresolved semantic choices.

Use these commands from the app root:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/check-version.js"
npm view @microsoft/power-apps-native-host@latest version --json
npx --yes --package @microsoft/power-apps-native-host@<latestHost> upgrade-template --dry-run
npx --yes --package @microsoft/power-apps-native-host@<latestHost> upgrade-template
```

## Workflow

### 1. Check the plugin

Run the plugin check. If it prints an update notice, show it verbatim and STOP; never run its commands automatically. Ask the user to update the complete plugin and rerun `/version-check`. Silence is fail-open: continue even if remote discovery was unavailable.

### 2. Inspect the app

Find the nearest `package.json` + `app.json` from the requested path/current directory and parse JSON. Require `@microsoft/power-apps-native-host` in dependencies or devDependencies and save its declared range as `declaredHost`.

- Missing app template version: STOP and request the known legacy source version for `--from-version <N>`; never infer or write it.
- `current > supported`: STOP, recommend updating the plugin, and never downgrade.
- Active `.powerapps-native/upgrade-journal.json`: STOP and surface it for host recovery.
- Existing `*.rej`: record as conflict evidence; do not delete or immediately escalate.

Print `current` and `supported`, then continue even when equal.

### 3. Check the npm feed and preview

From the app root, run `npm view @microsoft/power-apps-native-host@latest version --json`. This honors the project's npm configuration and authenticated feed. Parse the JSON and require one exact semantic version string; never print npm credentials or tokens. If lookup/authentication fails or the result is invalid, STOP with the npm error and do not guess or use a cached package version.

Print `declaredHost` and `latestHost`. Use `@microsoft/power-apps-native-host@<latestHost>` for every subsequent `npx --package` command in this run; do not resolve `@latest` again after presenting the plan.

Run the pinned dry-run and show the host version, target profile, file plan, warnings, and conflicts.

| Result | Action |
|---|---|
| Non-conflict failure | STOP without changes. |
| Already matches target profile | Report current and STOP. |
| Changes with `current === supported` | STOP; an update exists beyond this plugin's verified ceiling. Recommend updating the plugin. |
| Conflict-free changes with `current < supported` | Confirm dirty work is committed/backed up, then ask once to apply the preview with host `<latestHost>` and continue sequential migrations through `supported`. Decline = STOP. |
| Patch conflicts with `current < supported` | Continue to conflict handling; use its single approval instead. |

### 4. Resolve conflicts

For previewed conflicts:

1. Capture baseline status, complete target files, and their existing diffs.
2. Ask once to use host `<latestHost>` to materialize/refresh rejects, assist the merge, and apply after a clean preview; include backup confirmation for dirty work. Explain that the first normal upgrade is expected to fail after writing `<target>.power-apps-<migration>.rej`. Decline = STOP.
3. Run the normal upgrade once. If it changes anything beyond migration reject files, STOP and surface the unexpected writes.
4. Read `CUSTOMIZATION.md`, each reject, and each complete target. Keep rejects until success.
5. Apply the smallest merge under this policy:

| Auto-merge | Escalate |
|---|---|
| Additive JSON/config, dependency/script updates, mechanical import/wrapper composition, changes outside customization markers, or nearby edits where both intents coexist. Preserve formatting, comments, identity, custom dependencies, and every `DO NOT REMOVE OR RENAME THE COMMENT` marker. | Incompatible values with no clear precedence; deletion/semantic rewrite of custom behavior; uncertain auth, signing, identity, secrets, or native ownership; coupled conflicts requiring a product decision. Leave the target at its captured content, keep rejects, explain the choices, and recommend a resolution. |

Never force success by editing template version, migration state, lockfiles, or generated native projects.

Rerun dry-run. If one clear correction remains, repair and retry once. If still conflicted, restore only this skill's edits, preserve prior work/rejects, and escalate exact choices. Otherwise show resolved conflicts, preserved customizations, and the clean preview, then continue under the existing approval.

### 5. Apply each migration

Run the normal upgrade pinned to `<latestHost>`. It installs compatible dependencies and validates Expo. After success:

1. Reparse `app.json`; require `previous < new <= supported`.
2. Require no journal. Inspect stale rejects and STOP only for unresolved changes.
3. Dry-run again and show the result.
4. If no changes remain, finish (even below `supported`; the published host is authoritative).
5. If changes remain below `supported`, apply the next migration under existing approval.
6. If changes remain at `supported`, STOP and recommend updating the plugin.

On any failed check, STOP without repairing host-managed files. If host validation fails after an assisted merge, the host rolls back its operations; restore this skill's merge edits to captured content, preserve prior work/rejects, and report the failure.

### 6. Report

Summarize declared/latest host versions, old/new template versions, migrations, files changed, auto-resolved conflicts, preserved customizations, warnings, and follow-up. Show assisted-merge diffs and run documented app tests. Ask the user to review the complete diff. Never claim support beyond `supported`.