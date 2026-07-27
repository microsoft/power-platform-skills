---
name: setup-prerequisites
description: >-
  Gets a machine ready to use the power-pages plugin by checking the tools the
  skills depend on — Node.js, the .NET SDK, the Power Platform CLI (pac), and
  the Azure CLI (az) — installing whatever is missing, and signing both CLIs in.
  Use when the user installed the plugin from the marketplace and wants to set
  it up, asks how to get started, says a skill failed because "pac is not
  recognized" or "az is not installed", asks "do I have everything I need?",
  "check my setup", "install the prerequisites", or needs to sign in to the
  Power Platform or Azure CLI.
user-invocable: true
argument-hint: "[optional: check | install]"
allowed-tools: Read, Bash, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Setup Prerequisites

Check every tool the power-pages skills depend on, install what is missing, and sign the Power Platform CLI and Azure CLI in.

**Initial request:** $ARGUMENTS

Installing the plugin from the marketplace copies skill files and nothing else, so a marketplace user can arrive here with none of the command-line tools the skills call. This skill closes that gap.

## Gotchas

- **A newly installed CLI does not resolve until the terminal restarts.** `pac` and `az` land in a PATH entry the current shell resolved at startup. After an install, tell the user to restart the terminal rather than reporting a false failure.
- **PAC CLI is a .NET global tool.** Installing it needs the .NET SDK already on PATH. Installing the SDK in this session is not enough — see Phase 2.
- **Linux has no automated path** for the .NET SDK and Azure CLI. Detection still works; the install step hands back commands.
- **`--allow-no-subscriptions` is only valid on `az login`.** Never add it to `az account show` or any other `az` subcommand — they reject it as an unrecognized argument.
- **A failed install is not the end of the run.** Report it, keep going with the remaining tools, and collect every failure into the final summary.
- **Environment selection is out of scope.** This skill stops once the CLIs are installed and signed in. Choosing a Dataverse environment belongs to the skill that needs one.

## Workflow

1. **Detect** — Run the status check, present what is present and what is missing
2. **Install** — Ask per missing tool, install it
3. **Sign in** — Sign the Power Platform CLI and Azure CLI in
4. **Summarize** — Re-check, report, point at the next step

## Task Tracking

Create all four tasks at the start of Phase 1. Mark each `in_progress` when starting, `completed` when done.

| Task subject | activeForm | Description |
|---|---|---|
| Detect prerequisites | Detecting prerequisites | Run detect-prerequisites.js and present the status |
| Install missing tools | Installing missing tools | Install each approved tool, one at a time |
| Sign in to the CLIs | Signing in | Run pac auth create and az login where needed |
| Summarize setup | Summarizing setup | Re-check status and report what is left |

---

## 1. Detect

```bash
node "${PLUGIN_ROOT}/skills/setup-prerequisites/scripts/detect-prerequisites.js"
```

The script exits `1` when anything needs attention — that is a report, not a failure. Read the JSON on stdout:

| Field | Meaning |
|---|---|
| `node`, `dotnet`, `pac`, `az` | `available` plus the detected `version` |
| `pac.updateAvailable` | A newer PAC CLI is published on NuGet (`pac.latestVersion`) |
| `pacAuth`, `azAuth` | `signedIn`, plus `tenantId` and `user` when signed in |
| `tenantMismatch` | Non-null when the two CLIs are signed into different tenants |
| `actions` | What needs doing, as `{ tool, kind }` where `kind` is `install`, `update`, or `signin` |
| `ready` | True when `actions` is empty |

Add `--no-update-check` to skip the NuGet lookup when the machine is offline or behind a proxy that blocks it.

Present the status as a short plain-language table — tool, version, and whether it is ready. If `ready` is true and there is no `tenantMismatch`, tell the user they are set up and skip to Phase 4.

**Node.js** is always reported as available, because this script runs under Node. If the user reached this skill with no Node at all, no script here can run — point them at <https://nodejs.org/> and stop.

---

## 2. Install

Work through `actions` in order, one tool per `AskUserQuestion`. Combining them into a single prompt hides which install the user is approving.

<!-- gate: setup-prerequisites:2.install-consent | category=consent | cancel-leaves=nothing -->

> 🚦 **Gate (consent · setup-prerequisites:2.install-consent):** Ask before installing each tool. One prompt per tool, naming the tool and the exact command.
>
> **Trigger:** Phase 2, once per entry in `actions` with `kind` of `install` or `update`.
> **Why we ask:** An install writes to the machine outside the project, can need elevation, and can take several minutes. The user may also prefer their own package manager or a company-managed build.
> **Cancel leaves:** Nothing — the tool stays as it was, and the run continues with the next tool.

For each prompt, show the command that will run. Get it from the script rather than writing it out from memory, passing the same flags the real run will use — for a `kind` of `update`, that means `--update` on both calls, because the resolved command differs (`dotnet tool update` rather than `dotnet tool install`):

```bash
node "${PLUGIN_ROOT}/skills/setup-prerequisites/scripts/install-prerequisite.js" --tool <dotnet|pac|az> [--update] --dry-run
```

On approval, run the same command without `--dry-run`:

```bash
node "${PLUGIN_ROOT}/skills/setup-prerequisites/scripts/install-prerequisite.js" --tool <dotnet|pac|az> [--update]
```

The script streams installer output to the terminal and ends with a JSON line:

| `status` | What it means | What to do |
|---|---|---|
| `installed` | The install succeeded | Note that a terminal restart may be needed, move to the next tool |
| `unsupported` | No automated path on this platform | Show the `manual` commands, record it for the summary, move on |
| `failed` | The installer ran and failed | Show the exit code and the `manual` commands, record it, move on |

**Order matters, and a fresh .NET SDK does not help until the terminal restarts.** `pac` installs as a .NET global tool, so a PAC install with no SDK on PATH resolves to `unsupported`. Installing the SDK in this session does not change that: the installer writes PATH for future processes, while every script here runs under a shell that started earlier. So when both `dotnet` and `pac` are in `actions`:

1. Offer the .NET SDK install first.
2. Expect the PAC install to come back `unsupported` — that is the stale-PATH case, not a platform limitation.
3. Tell the user to restart the terminal and re-run `/setup-prerequisites`, which will then find the SDK and install PAC.

Do not present that `unsupported` result as a failure of their machine or their platform.

**Never stop the run on a failure.** Every failed or unsupported install is carried into Phase 4.

---

## 3. Sign in

Sign-in is interactive: it opens a browser and waits for the user. Run each command in the foreground, one at a time.

<!-- gate: setup-prerequisites:3.signin-consent | category=consent | cancel-leaves=nothing -->

> 🚦 **Gate (consent · setup-prerequisites:3.signin-consent):** Ask before starting each CLI sign-in.
>
> **Trigger:** Phase 3, once per entry in `actions` with `kind` of `signin`, and again after any install that added a CLI.
> **Why we ask:** Sign-in opens a browser, hands credentials to a CLI, and stores a profile on the machine. The user may want to pick a different account or tenant than the one they are signed into elsewhere.
> **Cancel leaves:** Nothing — no profile is created, and the summary lists the sign-in as still outstanding.

**Power Platform CLI:**

```bash
pac auth create
```

**Azure CLI:**

```bash
az login
```

If `az login` fails because the account has no Azure subscription, retry with `az login --allow-no-subscriptions`. That variant lets subscription-less accounts sign in and still mint the tokens the plugin's scripts need. It is valid on `az login` only.

### Tenant mismatch

When `tenantMismatch` is non-null, tell the user which tenant each CLI is signed into and that the plugin's skills use both against the same environment, so mismatched tenants surface later as permission errors. Offer to re-run the sign-in for whichever CLI is on the wrong tenant. This is a warning, not a blocker — the user may have a reason.

---

## 4. Summarize

### 4.1 Re-check

```bash
node "${PLUGIN_ROOT}/skills/setup-prerequisites/scripts/detect-prerequisites.js" --no-update-check
```

Skip the update check here — it was already done in Phase 1, and the second call is about confirming the installs landed.

If a tool the user just installed still reports missing, that is the PATH-refresh case, not a failed install. Say so and ask them to restart the terminal and re-run this skill.

### 4.2 Report

Present a final table of every prerequisite with its state, then:

- **Everything ready** — say so and move to 4.3.
- **Anything outstanding** — list each gap with the exact command to run by hand, taken from the `manual` array of the failing install. Include failures the user declined, so nothing is silently dropped.

### 4.3 Record skill usage

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`
>
> Use `--skillName "SetupPrerequisites"`. This skill often runs outside a project; the tracking script exits silently when there is no site directory, so call it unconditionally with the current directory as `--projectRoot`.

### 4.4 Next step

Point at what the user came here to do:

- No project yet → `/create-site`
- An existing project → the skill they were blocked on
- Not sure → `/create-site` to scaffold a site

---

## Constraints

- **Plain language** — Say "the Power Platform command-line tool" before "pac", "the Azure command-line tool" before "az". Do not assume the user knows what a .NET global tool, a package manager, or PATH is; explain in a sentence when it matters.
- **One install per approval** — Every install runs against its own `AskUserQuestion`. Never batch approvals or infer consent for a second tool from the first.
- **Report, do not abandon** — A failed install, an unsupported platform, or a declined prompt moves to the next item and lands in the final summary.
- **Never print a token** — `pac auth create` and `az login` handle their own credentials. Do not run token commands, and never echo a token, secret, or password.
- **Stop at sign-in** — Do not select a Dataverse environment, create a profile against a specific org, or run any project-changing command.
