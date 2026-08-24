---
name: publish-pcf-companion
description: Deploy the dispatcher PCF for a third-party `.ppmplugin` control to a Power Platform environment via `pac pcf push`. The dispatcher PCF is the Studio-side control that dispatches the composite key `<name>/<receiver>` over the wrap shell's `SendMessagePlugin` bridge to the control's native module. Verifies deploy prereqs (.NET SDK + active `pac auth`), then three confirmation gates — publisher prefix (2–8 chars; defaults to `pamext` or the last-used value from `.extension-state.md`), version bump (patch / minor / major / no-bump), target environment URL (from `pac org who`). Builds the PCF if needed, then pushes. Decoupled from /generate-pcf-companion so the engineer can scaffold and customize locally, then deploy when ready. Updates `.extension-state.md` with deployment history (timestamp, env URL, version, prefix used).
---

# /publish-pcf-companion

On-demand deployment of the **dispatcher PCF** for a third-party `.ppmplugin` control to a Power Platform environment. The dispatcher PCF is the Studio-side control that dispatches the composite key `<name>/<receiver>` over the wrap shell's `SendMessagePlugin` bridge to the control's native module. Runs `pac pcf push` against the user's active `pac auth` profile. Decoupled from `/generate-pcf-companion` — the engineer scaffolds locally, customizes / iterates, then deploys when ready.

---

## Step 1 — Read shared docs and verify prereqs

1. Read [`shared/shared-instructions.md`](../../shared/shared-instructions.md), [`shared/naming-conventions.md`](../../shared/naming-conventions.md).
2. Apply the **per-skill minimal prereq policy** ([`shared-instructions.md §1.5`](../../shared/shared-instructions.md)). This skill needs `pac` CLI + .NET SDK + active `pac auth` profile — and nothing else. It does NOT need Node or pnpm.

   **Print the prereq status as a visible block per `shared-instructions.md §9.2`** before continuing:

   ```
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    Prereq check — /publish-pcf-companion
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    🟢 ✓ pac CLI installed                   (for pac pcf push)
    🟢 ✓ .NET SDK installed                  (solution build runs inside pac pcf push)
    🟢 ✓ pac auth profile active             (target env: <env URL from pac org who>)

    🟢 3 checks passed. Ready to proceed.
   ```

   Fix table for failures:

   | Missing | `→ Fix:` line in the failure block |
   |---|---|
   | `pac` CLI | `dotnet tool install -g Microsoft.PowerApps.CLI.Tool` (chains on .NET SDK first if also missing) |
   | .NET SDK | `brew install dotnet` (mac) / `winget install Microsoft.DotNet.SDK.10` (win) / package manager (linux) |
   | No active `pac auth` | `pac auth create --environment <your-env-url>` (interactive browser flow; use an identity with access to the target Power Platform environment). **Do not reach for `--deviceCode` first** — it's a headless-shell fallback that commonly fails under Conditional Access. |

   Run the `/publish-pcf-companion` check from [`prereq-check.md`](../../shared/prereq-check.md). Per the auto-fix policy (shared-instructions §1.5): a missing `pac` CLI is auto-fixable when .NET is present — **offer `dotnet tool install -g Microsoft.PowerApps.CLI.Tool` and continue on `yes`**; no active `pac auth` → **initiate `pac auth create --environment <url>`** (browser) and verify after. If an auth attempt *fails*, walk the variant ladder in [`prereq-check.md`](../../shared/prereq-check.md) (browser → device code only if headless → back to browser with `--environment` → `pac auth clear`) — change a variable each step and never re-run a variant that already failed. A missing **.NET SDK** hard-stops (system-wide install — print the command).
3. Read `./PRD.md`. Required — the skill derives the PCF folder name (`pcf/<Pascal>PCF/`) and publisher prefix from PRD §2. If PRD is missing, STOP with `BLOCKED: PRD.md missing — cannot determine PCF folder name`.
4. Read `./.extension-state.md` if present. The state file is informational; this skill works without it but uses Phase info to surface "scaffold-pcf hasn't happened yet" early.

---

## Step 2 — Detect current state

Build a status dashboard so the user sees what was detected before any action.

**Discover the PCF folder robustly** — don't assume the exact nesting depth. `pac pcf init` produces `pcf/<Pascal>PCF/<Pascal>PCF/ControlManifest.Input.xml`, but variations (case, custom layouts, manual restructuring) shouldn't trip the skill. Use `find`:

```bash
# Find ANY ControlManifest.Input.xml under pcf/. Stop at the first hit.
MANIFEST=$(find pcf -type f -name "ControlManifest.Input.xml" 2>/dev/null | head -1)
```

Then derive the PCF project root from the manifest's path — it's `dirname $(dirname $MANIFEST)` (the manifest is two levels deep inside the project root).

```bash
if [ -z "$MANIFEST" ]; then
  # Distinguish "no pcf/ at all" from "pcf/ exists but no manifest"
  if [ ! -d pcf ]; then
    echo "BLOCKED: no pcf/ directory — PCF has not been scaffolded. Run /generate-pcf-companion first."
    exit 1
  else
    echo "BLOCKED: pcf/ exists but no ControlManifest.Input.xml found anywhere under it."
    echo "Contents of pcf/:"
    find pcf -maxdepth 3 -type f 2>/dev/null | head -20
    echo "Either the scaffold was incomplete, or the folder layout is unexpected. Re-run /generate-pcf-companion."
    exit 1
  fi
fi

PCF_PROJECT_ROOT=$(dirname $(dirname "$MANIFEST"))   # e.g. pcf/<Pascal>PCF
echo "Found PCF project root: $PCF_PROJECT_ROOT"
echo "Manifest: $MANIFEST"
```

Other detection:

```bash
# Built?
[ -d "$PCF_PROJECT_ROOT/out" ] && BUILT="yes" || BUILT="no — will build before push"

# Current PCF version (from <control version="X.Y.Z"> in the manifest)
CURRENT_VERSION=$(grep -oE 'version="[0-9]+\.[0-9]+\.[0-9]+"' "$MANIFEST" | head -1 | sed 's/version=//; s/"//g')

# Last deployed version from .extension-state.md (if any prior deploys)
LAST_DEPLOYED=$(grep -oE 'Version: [0-9]+\.[0-9]+\.[0-9]+' .extension-state.md 2>/dev/null | tail -1 | awk '{print $2}')

# Active environment
pac org who 2>&1   # shows env URL + user
```

Print:

```
PCF deploy status
─────────────────
Repo: <cwd>
PCF project root: <PCF_PROJECT_ROOT from find>
Manifest: <MANIFEST path>
Built (out/): <yes | no — will build now>
Current manifest version: <CURRENT_VERSION>
Last deployed version: <LAST_DEPLOYED or "none — first deploy">
Publisher prefix: <LAST_PREFIX from .extension-state.md, else `pamext` default — confirmed in Step 3.0>
Active pac auth env: <env URL from `pac org who`>
Active pac auth user: <user from `pac org who`>

Plan: pick publisher prefix → bump version if chosen → build if needed → pac pcf push --publisher-prefix <chosen prefix>
```

**Why the version matters:** Power Platform caches PCF controls by version in deployed apps. If you re-push the same version, apps that already loaded the previous bundle may not see your changes until their cache invalidates (timing varies — sometimes minutes, sometimes hours, sometimes never until the maker re-publishes the app). **Best practice is to bump the patch version on every meaningful push.**

If `pac org who` returns "No active connection": STOP — this means `pac auth list` showed a profile but it's not currently selected. Run `pac auth select --index <n>` and re-run this skill. (Step 1 catches missing auth; this catches the rarer "auth exists but not active" case.)

> **Why `find` instead of an exact path:** the standard `pac pcf init` layout is `pcf/<Pascal>PCF/<Pascal>PCF/ControlManifest.Input.xml` (the project root is named after the class, and the control source lives one level deeper, also named after the class). But variations happen: case differences from the original `pac pcf init` invocation, manual restructuring by the engineer, or non-standard scaffolders. The skill cares about *whether a manifest exists* and *where its containing project is*, not the exact nesting. `find` answers both robustly.

---

## Step 3 — Confirm with the user

This step has THREE gates: publisher prefix → version-bump → deploy confirmation. Each is its own `AskUserQuestion`.

### 3.0 — Publisher prefix gate

The publisher prefix becomes part of the solution name in Power Platform (e.g. `pamext_<Pascal>PCF`). It must be **2–8 characters** — `pac pcf push` rejects anything outside that range with `Argument --publisher-prefix has incorrect length`.

Detect the last-used prefix from `.extension-state.md`:

```bash
LAST_PREFIX=$(grep -oE 'Publisher prefix: [a-z0-9]+' .extension-state.md 2>/dev/null | tail -1 | awk '{print $3}')
```

Then ask via `AskUserQuestion`:

> Publisher prefix for this deployment? (must be 2–8 lowercase chars)
> - **<LAST_PREFIX>** (use the prefix from the previous deployment) — only shown if `LAST_PREFIX` was found
> - **pamext** (recommended) — 6 chars; "PAM Extension"; the default we suggest for first-party native-extension PCFs
> - **mspa** — 4 chars; "Microsoft PowerApps"
> - **Custom** — supply your own 2–8-char prefix (free-text input, validate length before continuing)

Validate the chosen value:

```bash
PREFIX="<from user choice>"
PREFIX_LEN=${#PREFIX}
if [ "$PREFIX_LEN" -lt 2 ] || [ "$PREFIX_LEN" -gt 8 ]; then
  echo "❌ Publisher prefix '$PREFIX' is $PREFIX_LEN chars; must be 2–8. Try again."
  # Re-prompt
fi
if ! [[ "$PREFIX" =~ ^[a-z][a-z0-9]*$ ]]; then
  echo "❌ Publisher prefix must start with a lowercase letter and contain only lowercase letters and digits."
  # Re-prompt
fi
```

**Why the prefix matters:** it groups your PCF with other solutions under the same publisher identity in Power Platform's solution explorer. Use the same prefix across all first-party native-extension PCFs so they appear together. The recommended `pamext` is a project convention — your team may have its own; ask before picking custom on a shared environment.

**Why we don't hardcode it:** the team / environment may have an existing publisher prefix established. Hardcoding "powerapps" was wrong on two counts — it's 9 chars (over the limit) AND it doesn't respect environment conventions.

### 3.1 — Version-bump gate

Use `AskUserQuestion`. Compute the bump-target options from `CURRENT_VERSION` (the version currently in the manifest):

> Current PCF version: **<CURRENT_VERSION>** (last deployed: <LAST_DEPLOYED or "never">)
>
> Power Platform caches PCFs by version. Re-pushing the same version may not invalidate caches in apps that already use this control. Bump the version?
>
> - **Patch bump → <CURRENT major.minor.(patch+1)>** (recommended for bug fixes, internal improvements) — typical default
> - **Minor bump → <CURRENT major.(minor+1).0>** (for new features or new outputs/configurable inputs the maker can opt into)
> - **Major bump → <(CURRENT major+1).0.0>** (for breaking changes to the bound input, output names, or trigger semantics)
> - **No bump — push as-is at <CURRENT_VERSION>** (only if you're iterating during initial dev and accept the cache risk; the skill will print a warning)

Apply the chosen bump by editing the `<control version="...">` attribute in the manifest:

```bash
NEW_VERSION="<X.Y.Z from user choice>"
cp "$MANIFEST" "$MANIFEST.bak.$(date +%s)"
sed -i.tmpedit -E "s/(<control[^>]*\bversion=)\"[^\"]*\"/\1\"$NEW_VERSION\"/" "$MANIFEST"
rm -f "$MANIFEST.tmpedit"
echo "Updated manifest version: $CURRENT_VERSION → $NEW_VERSION"
```

After bumping, **re-build** is required (the manifest changed, so `out/` is stale). The build runs as part of Step 4 regardless of the user's choice in 3.2 below, so this is fine.

If user picked "No bump": skip the manifest edit. Print a warning:
> ⚠️  Pushing at <CURRENT_VERSION> again. Apps that previously loaded this control may not see your changes until their PCF cache invalidates. Use a version bump for the next push if this matters.

### 3.2 — Deploy confirmation gate — lead with the ENVIRONMENT

**Wrong-env deploys are a confirmed failure mode** (a publish once went to `wrap-bug-bash-env` instead of `wrap-player-test-env` because the env URL was buried in a long question). So make the **target environment the headline** of this gate, and **explicitly offer to change it** — never silently reuse whatever `pac auth` happens to be active. **Show the FULL current-env details** (not just the URL) so the user can tell *which* env it is: read `pac org who` (and `pac auth list` for the friendly profile name) and print:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 ►► CURRENT DEPLOY TARGET ◄◄
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Environment:   <friendly org name from `pac org who` — e.g. "Contoso Test (default)">
 URL:           <env-url>
 Environment ID:<org/environment id from `pac org who`, if shown>
 Signed-in as:  <user from `pac org who`>
 Auth profile:  <active profile name from `pac auth list` (the ★ row)>
 Last deployed: <from .extension-state.md PCF deployments — env + timestamp, or "first deploy">
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Then a third `AskUserQuestion` whose **question text names the env again, verbatim**, and leads with the keep-or-change decision:

> Deploy `<Pascal>PCF@<resolved version>` (prefix `<PREFIX>`) to **<friendly org name> — <env-url>**. Keep this environment, or switch?
> - **Yes, keep this env — build + push** (recommended): runs `npm run build`, then `pac pcf push --publisher-prefix <PREFIX>`.
> - **Switch environment** — change the target before deploying. Run `pac auth list` and offer the existing profiles (`pac auth select --index <n>`), or create a new one (`pac auth create --environment <url>`), **in-flow** — then re-print this headline and re-ask. Don't make the user leave and re-run the skill.
> - **Push without rebuild** (only if you didn't bump version AND you trust the current `out/`): skips `npm run build`. **Disabled if 3.1 bumped the version** — a bumped manifest requires a rebuild.
> - **Cancel**

The env (friendly name + URL) and prefix appear **twice, verbatim** (the headline block + the question) — typos in env config or the wrong active auth are the most common causes of "the wrong tenant got the deploy." **Always surface the current env and the switch option even when an auth profile already exists** — never assume the active profile is the one the user wants.

---

## Step 4 — Execute

### 4.1 — Build if needed (or always, for "Yes — build + push")

Use the `$PCF_PROJECT_ROOT` discovered in Step 2 — don't hardcode `pcf/<Pascal>PCF`:

```bash
cd "$PCF_PROJECT_ROOT"
[ -d node_modules ] || npm install --no-audit --no-fund
npm run build --silent
```

If build fails: STOP with `BLOCKED: pcf-scripts build failed — fix the source and re-run /publish-pcf-companion`. Direct user to `/test-native-extension` Layer 4 for diagnostics.

### 4.2 — Push to Power Platform

```bash
cd "$PCF_PROJECT_ROOT"
pac pcf push --publisher-prefix "$PREFIX"   # $PREFIX from Step 3.0
```

The prefix `$PREFIX` was chosen by the user in Step 3.0 and length-validated (2–8 chars). If `pac pcf push` still rejects with `Argument --publisher-prefix has incorrect length`, something downstream (env config, prefix regex change in newer `pac` versions) is unexpected — surface the raw error and re-run Step 3.0 to pick a different value.

If the prefix doesn't exist as a publisher in the target environment, the push errors with `Publisher prefix '$PREFIX' not found`. Surface this and direct the user to either:

- Ask the env admin to add the prefix: `pac solution publisher-add --prefix "$PREFIX" --name "<publisher name>"`, OR
- Re-run this skill and pick a prefix that already exists in the env (the env admin can list them via the Power Platform admin center).

### 4.3 — Pass

Print:
```
🟢 ✓ Deployed <Pascal>PCF to <env-url> at <ISO timestamp>
  Solution: <PREFIX>_<Pascal>PCF (verify in https://make.powerapps.com → Solutions)
```

### 4.4 — Fail

`pac pcf push` can fail for several reasons. Common ones:

| Error | Likely fix |
|---|---|
| `Publisher prefix '<PREFIX>' not found` | Env admin needs to add the prefix, or re-run Step 3.0 and pick one that exists in the env |
| `Authentication failed` / `401` | `pac auth` token expired or the profile is bound to the wrong identity/env. Try `pac auth select`, then re-create with `pac auth create --environment <url>` (browser). If that fails, walk the variant ladder in [`prereq-check.md`](../../shared/prereq-check.md) — do not retry the same variant, and do not default to `--deviceCode`. |
| `Solution import failed: missing dependency` | Env is missing a required Power Platform feature (rare for native-extension PCFs; surface the dep name) |
| `Build of <Pascal>PCF.csproj failed` | The PCF tooling tried `dotnet build` and it failed. Often a stale `out/` — run `rm -rf out/ && npm run build` then retry. |

Update `.extension-state.md`: under a new "PCF deployments" section, add `Deploy: fail — <ISO> — <env-url> — <one-line reason>`. STOP with `BLOCKED: pac pcf push failed — <reason>`.

---

## Step 5 — Update state and summarize

After a successful push, update `./.extension-state.md`:

- Add (or update) a **PCF deployments** section:
  ```markdown
  ## PCF deployments
  - <ISO timestamp> — <env-url> — Version: <X.Y.Z> — Publisher prefix: <PREFIX> — Result: success
  ```
  Append a new line on each subsequent successful deploy. Most recent at the bottom. The `Version:` field is the value from `<control version="..."/>` at push time (post-bump if 3.1 bumped it). The `Publisher prefix:` field is what the user chose in Step 3.0 — subsequent runs default to this value via the LAST_PREFIX detection.
- DO NOT change the **Phase** field — deploy is orthogonal to the phase ladder.

Print final summary:

```
Deploy complete
───────────────
PCF: <Pascal>PCF
Version: <X.Y.Z>     ← post-bump if 3.1 bumped; else same as before
Bump: <patch | minor | major | none — re-pushed at same version>
Environment: <env-url>
Publisher prefix: <PREFIX>
Build: <skipped — current out/ used | rebuilt at <time>>
Deployed at: <ISO timestamp>

Where to look next (informational — these are makers-portal steps, not skills):
  • Open https://make.powerapps.com → switch to <env> → Solutions → find `<PREFIX>_<Pascal>PCF`.
  • In a Canvas app: Insert → Custom → search for `<Pascal>PCF` under the `PowerApps` namespace.
  • If a previously-deployed app doesn't show your changes: re-publish that app (File → Save → Publish) to bust the PCF cache.
```

### 5.1 Next-step gate

Per `shared/shared-instructions.md §9.1`: surface real next-step choices via `AskUserQuestion` with **context-aware options** based on repo state. **Execute, don't describe** — when the user picks a `Run /…` option, immediately invoke that skill via the `Skill` tool in the same turn (shared-instructions §9.1). The only option that ends the run without invoking anything is the escape hatch.

Detect state to filter options:

| Detector | Implies |
|---|---|
| No `.ppmplugin` bundle built yet (`ppmplugin/<name>.ppmplugin` absent) | `/generate-ppmplugin` is the natural next step — the dispatcher PCF is deployed but the binary bundle it dispatches to still needs to be built. |
| A `.ppmplugin` bundle already exists (`ppmplugin/<name>.ppmplugin` present) | `/audit-ppmplugin` re-verifies the built bundle; `/debug-extension` debugs/refines the control. |

Then `AskUserQuestion`. Typical post-deploy options:

```
Question: "Dispatcher PCF deployed. What would you like to do next?"
Header:   "Next step"

Options:
  1. "Run /generate-ppmplugin"   description: "Build (or rebuild) the verified .ppmplugin binary bundle end-to-end (manifest → build → assemble → audit) — the bundle this dispatcher PCF routes to over the wrap bridge."
  2. "Run /debug-extension"       description: "Debug/refine the control (PRD or native/PCF code), then re-deploy with another version bump."
  3. "Run /audit-ppmplugin"      description: "Re-verify an already-built .ppmplugin bundle against the format spec and the manifest's receiver/method contract."
  4. "Stay — I'll verify in Studio"   description: "Skill exits. Open make.powerapps.com → your env → find the new PCF in Solutions / insert it in a Canvas app to verify."
```

> **Informational (not a skill option):** uploading the built `.ppmplugin` via the wrap wizard and wiring this dispatcher PCF into a canvas app is **Stage 3 — not yet a skill**. Once the bundle is built and the PCF is deployed, that final hosting step is a manual makers-portal / wrap-wizard flow.

When the user picks a `Run /…` option, invoke it via the `Skill` tool. When they pick "Stay", print one line confirming the deploy is done and proceed to the return-status block.

---

## Return-status protocol

| Code | Meaning |
|---|---|
| `DONE` | `pac pcf push` succeeded; state file updated with deployment row. |
| `DONE_WITH_CONCERNS: <list>` | Push succeeded but with caveats (publisher prefix mismatch and user accepted the alternate; or `npm run build` produced warnings the user accepted). |
| `NEEDS_CONTEXT: <missing>` | PRD missing, PCF not yet scaffolded, or required user input incomplete in a scenario question. |
| `BLOCKED: <reason>` | Prereq failed (`pac`, dotnet, or auth missing), `pac pcf push` rejected for a non-collision reason (perms, network), `npm run build` failed, user cancelled, or `pac org who` shows no active connection. |

After the first line, blank line, then the human-readable summary.

---

## Hard rules

- **Never push without explicit confirmation of the env URL.** The env URL appears verbatim in the Step 3 question; the user typed `yes` to that URL. If env changes between Step 3 and Step 4 (e.g. `pac auth select` was run by a parallel session), STOP and re-prompt.
- **Never use `--force`-style flags to bypass auth or solution conflicts.** If `pac pcf push` errors, surface and stop — don't try alternative prefixes or solution targets without user confirmation.
- **Publisher prefix is user-chosen at deploy time, not hardcoded.** Length must be 2–8 lowercase chars + digits (validated in Step 3.0). Default the gate to the last-used prefix from `.extension-state.md` if present, otherwise to `pamext`. Never push without an explicit prefix confirmation — environments often have established prefixes and the wrong one creates an orphan solution.
- **Never deploy to an env the user didn't explicitly authorize.** This skill reads the active `pac auth` profile; if the user wants a different env, they switch it BEFORE running the skill.
- **Don't auto-bump without confirmation.** PCF version (`<control version="X.Y.Z">` in the manifest) drives Power Platform's cache invalidation. The skill MUST present the bump options at Step 3.1 with `AskUserQuestion`, default-highlighting patch bump, and apply the chosen bump verbatim. Never bump silently and never skip the prompt — the engineer needs to see "we're changing your manifest version" before it happens.
- **A bumped manifest requires a rebuild.** If Step 3.1 changed the manifest, the "Push without rebuild" option in Step 3.2 must be disabled or unavailable — pushing a stale `out/` with a new manifest version is a real bug (the deployed bundle wouldn't match the version declared in the solution).
- **Don't run inside a directory without a PRD.md.** This skill needs PRD §2 to derive the PCF folder name; without it, it'd have to guess.
