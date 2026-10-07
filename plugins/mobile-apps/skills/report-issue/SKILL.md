---
name: report-issue
description: Use when the user wants to report a bug, file an issue, submit a bug report, or report any problem with the mobile-app plugin.
user-invocable: true
argument-hint: "[optional: brief description of the bug]"
allowed-tools: Read, Bash, Glob, Grep, AskUserQuestion
model: haiku
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` - if it outputs a message, show it to the user before proceeding.

**📋 Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read this first.

# Report Issue — mobile-app

Generates a fully-populated GitHub issue body for the `microsoft/power-platform-skills` repo, scoped to the `mobile-app` plugin. Read-only — no project modifications.

## Workflow

1. Capture user description → 2. Detect project context → 3. Collect diagnostics → 4. Render issue body → 5. Print URL

---

### Step 1 — Capture user description

**Telemetry checkpoint: `capture_issue_description`**

If `$ARGUMENTS` contains a description, use it. Otherwise prompt:

> "What's the issue? Briefly describe what you expected vs. what happened. (You can paste error output if helpful.)"

Then ask via `AskUserQuestion`:

> "Issue category?
> (a) Bug — something broke
> (b) Unexpected behavior — wrong output but no error
> (c) Documentation — docs are wrong / missing
> (d) Feature request
> (e) Question / discussion"

> "How blocking is this?
> (a) Blocking — can't proceed at all
> (b) Workaround exists — but painful
> (c) Annoying — non-critical
> (d) Polish — nice-to-have"

### Step 2 — Detect project context

Read-only checks:

```bash
test -f power.config.json && echo "in_project=true" || echo "in_project=false"
node --version
npm --version
az --version 2>/dev/null | head -1
npx --no-install expo --version 2>/dev/null
uname -srm
```

If in a project:

```bash
test -f memory-bank.md && echo "memory_bank=present"
test -f native-app-plan.md && echo "plan=present"
node -e "const fs=require('node:fs');const p='src/generated/services';let count=0;try{count=fs.statSync(p).isDirectory()?fs.readdirSync(p).filter(f=>f.endsWith('.ts')).length:0;}catch{}console.log('generated_service_count='+count);"
```

Read [release lifecycle](../../shared/references/mobile-release-lifecycle.md).
For a mobile project, collect only the resolver's sanitized tuple:

For a previously approved `--diagnostic-artifacts` selection, retain that explicit
option and label the result `local-diagnostic-only`; report the actual selected
APK's supported counters, never an inferred player version. Do not attach the
artifact manifest, archive/binary, local paths, source profile, or private build
evidence to a public issue. iOS remains untested; reporting still works if local
inspection fails.

```bash
node "${PLUGIN_ROOT}/scripts/resolve-mobile-release.js" --project-root "<working_dir>"
```

If the affected workflow supplied actual selected base versions and fingerprints,
check them read-only using all three flags: `--platform android|ios`,
`--base-version <actual-intended-version>`, and
`--base-fingerprint <actual-intended-fingerprint>`. A version-only deployment
check blocks. Collect actual target metadata, never copy expected policy values.
Record unknown/missing evidence honestly; reporting must still work when the
policy is empty. Do not infer the runtime from the newest bundled template,
claim a published package proves player/base availability, or mutate native
dependencies to make diagnostics pass.

For controls, identify the selected `/pdf`, `/pen`, or `/geolocation` contract
and matching release/leaf version using
[native controls](../add-native/references/native-controls.md). The aggregate
root is metadata, not a runtime API. Separate package inclusion, OS declarations,
runtime grants, and app usage in the reproduction. No raw app/auth config,
credentials, private repository links, package code, customer names, tenant,
environment, app, or connection IDs belong in this public issue.

If the description names a package matching `@microsoft/power-apps-native-*`, collect its declared and lockfile-resolved versions from `package.json` and `package-lock.json`. Do not read package source or metadata from `node_modules/`.

```bash
node - <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lockfile = fs.existsSync('package-lock.json')
  ? JSON.parse(fs.readFileSync('package-lock.json', 'utf8'))
  : null;
const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
for (const [name, declared] of Object.entries(dependencies)) {
  if (!name.startsWith('@microsoft/power-apps-native-')) continue;
  const resolved = lockfile?.packages?.[`node_modules/${name}`]?.version ?? 'unknown';
  console.log(`${name}\tdeclared=${declared}\tresolved=${resolved}`);
}
NODE
```

For native runtime issues capture the platform and user-supplied player/base
version. Do not run or probe local Xcode, CocoaPods, Gradle, or JDK builds.

### Step 3 — Collect diagnostics

**Telemetry checkpoint: `collect_issue_diagnostics`**

Run read-only project diagnostics only when available; do not auto-install or
upgrade tooling. Sanitize bounded relevant output before showing or persisting
it. A doctor/type-check pass does not validate native runtime compatibility.
Use `npx --no-install` for any available project-local diagnostic tool; report
unavailable checks without downloading a replacement or blocking issue reporting.

Ask for the affected workflow's Support ID when available. Use the telemetry
helper's read-only `--report` mode from the affected project to inspect only its
allowlisted timeline. Include the Support ID and relevant step/error category in
the issue body, not environment, tenant, or organization IDs. Do not
upload the telemetry directory or raw timing/authentication files.

If the user pasted an error, extract a sanitized minimal reproduction. Otherwise look for recent failure signals:

- Last 50 lines of any Metro / Gradle / Xcode log if user mentions a build failure
- `git status --short` if in a git repo (to show modified files — sanitize for secrets first)
- Output of `npx --no-install tsc --noEmit` if relevant

**Do NOT capture:**
- Contents of `src/playerConfig.ts` (contains tenantId / clientId — sensitive)
- Contents of `.env` or any file matching `.env*`
- Connection IDs, even if a diagnostic command printed them
- Raw `app.json`, `app.config.js`, `auth.config.json`, or `power.config.json`
- Anything under `node_modules/`
- Package source excerpts, patched package contents, or proposed fork code
- Tenant/environment/organization IDs in a public issue, even though verified
  IDs can exist in access-controlled telemetry

### Step 4 — Render issue body

**Telemetry checkpoint: `render_issue_report`**

Print this block — user copies into a new issue:

```markdown
### Description

<user's description>

### Category

<Bug / Unexpected behavior / Docs / Feature / Question>

### Severity

<Blocking / Workaround / Annoying / Polish>

### Environment

| | |
|---|---|
| Plugin | mobile-app |
| Plugin version | <from .plugin/plugin.json, or legacy .claude-plugin/plugin.json fallback, or "unknown"> |
| OS | <uname output> |
| Node | <version> |
| npm | <version> |
| Power Apps CLI | <version> |
| Expo CLI | <version> |
| Release status | <verified release ID or unresolved category> |
| Runtime tuple | <sanitized template/host/Expo/React Native/native inventory versions> |
| Player / selected bases | <actual supplied versions and base fingerprints, or unknown> |

### Project context

<if in project>
- Mobile project detected: yes
- Support ID: `<affected workflow run GUID, or unavailable>`
- Failed step / error category: `<registered step and fixed category, or unknown>`
- Memory bank present: <yes/no>
- Plan present: <yes/no>
- Connector count: <count, not generated service or business-table names>
</if>

<if not in project>
Not run inside a mobile-app project.
</if>

### Affected native package

<include only when the issue concerns @microsoft/power-apps-native-*>
- Package: `<package name>`
- Declared version: `<package.json range>`
- Resolved version: `<package-lock.json version or unknown>`
- Platform: `<iOS / Android>`
- Ownership evidence: <why the documented caller contract is satisfied and the failure is package-internal>

### Reproduction steps

1.
2.
3.

### Expected

<what should have happened>

### Actual

<what happened>

### Logs / errors

```
<bounded sanitized error summary; no package source or raw configuration>
```

### Notes

<anything else>
```

### Step 5 — Print URL

**Telemetry checkpoint: `generate_issue_submission_url`**

Tell the user:

> Open this URL to file the issue:
>
> <https://github.com/microsoft/power-platform-skills/issues/new?labels=plugin%3Amobile-app>
>
> Paste the block above into the body. Review for any sensitive values before submitting.

If the user wants to open it, suggest `open <url>` (macOS) / `xdg-open <url>` (Linux) / `start <url>` (Windows). Do not auto-open without confirmation.

## Notes

- This skill never modifies any file or invokes mutating commands. Pure diagnostic.
- For connection-specific failures, use `/list-connections` locally; include only
  a sanitized category/reproduction, never raw connection output or IDs.
- For build failures, include a bounded sanitized excerpt, not full logs or
  private package source. Keep native compatibility limitations explicit.
