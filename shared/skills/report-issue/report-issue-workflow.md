# Report Issue

File a bug report on the [power-platform-skills](https://github.com/microsoft/power-platform-skills) GitHub repository. This workflow gathers the required information, presents a full preview, and creates the issue on the user's behalf.

**Initial request:** $ARGUMENTS

> **WARNING:** Before proceeding, inform the user: "This will create an issue on the **public** GitHub repository [microsoft/power-platform-skills](https://github.com/microsoft/power-platform-skills). **Do not include any sensitive information** such as credentials, internal URLs, tenant IDs, customer data, or proprietary code in the bug report."

---

## Phase 1: Identify Plugin & Version

**Goal**: Determine which plugin the bug is for and its version.

**Actions**:

1. Create a task list with all 5 phases (see [Progress Tracking](#progress-tracking) table).
2. **Auto-detect the plugin name** from the current plugin context by reading `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`. Extract the `name` field.
3. **Auto-detect the plugin version** from the same `plugin.json` — extract the `version` field.
4. If the plugin name or version cannot be determined, use `AskUserQuestion` to ask the user.

**Output**: Plugin name and version confirmed.

---

## Phase 2: Gather Bug Details

**Goal**: Collect all required and optional fields for the bug report.

**Actions**:

### 2.1 Check Arguments

If `$ARGUMENTS` contains a description of the bug, extract as much information as possible from it to pre-fill the fields below. Still confirm with the user.

### 2.2 Ask for Bug Details

Use `AskUserQuestion` to gather bug details. `AskUserQuestion` supports 1-4 questions per call, but each question requires 2-4 predefined options. Since bug report fields are free-text, use options as prompt hints and let the user type their actual response via "Other". Skip any field the user already provided in `$ARGUMENTS`.

**Call 1** — Skill and bug description (2 questions):

1. **"Which skill or command were you using?"** (header: "Skill") — Provide the plugin's known skills as options (e.g., `deploy-site`, `create-site`). This is optional — the user can skip it.
2. **"Please describe the bug clearly and concisely."** (header: "Bug") — Provide short prompt-hint options like "Skill failed with error", "Unexpected behavior", "Skill hangs or times out". The user will typically select "Other" to type their description.

**Call 2** — Repro steps and expected vs actual (3 questions):

1. **"What steps reproduce the bug?"** (header: "Repro steps") — Provide prompt-hint options like "Ran the skill with default settings", "Ran the skill with custom arguments". The user will typically select "Other" to type their steps.
2. **"What did you expect to happen?"** (header: "Expected") — Provide prompt-hint options like "Skill should have succeeded", "Different output expected". The user will typically select "Other" to type their answer.
3. **"What actually happened?"** (header: "Actual") — Provide prompt-hint options like "Got an error message", "Wrong output produced", "Skill hung or timed out". The user will typically select "Other" to type their answer.

**Call 3** — Environment details:

Use `AskUserQuestion` with a single question: **"We recommend including environment details (OS, Claude Code version, PAC CLI version) to help maintainers reproduce and debug the issue faster. Include them?"** (header: "Environment") — Options: "Yes, auto-collect them" (recommended), "No, skip".

- If **yes**: Auto-collect the following by running shell commands:
  - **OS**: Detect the user's OS name and version using an appropriate command for their platform.
  - **Claude Code version**: Run `claude --version`
  - **PAC CLI version**: Run `pac help` and extract the version from the output
  - Present the collected details to the user.
- If **no**: Skip environment fields.

**Call 4** — Logs:

Use `AskUserQuestion` with a single question: **"Do you want to include any relevant logs or error messages?"** (header: "Logs") — Options: "Yes, I'll paste them", "No, skip".

- If **yes**: Use `AskUserQuestion` to ask: **"Please paste any relevant logs or error messages."** (header: "Paste logs") — Provide prompt-hint options like "Error message from terminal", "Skill output log". The user will typically select "Other" to paste their content.
- If **no**: Skip this field.

**Output**: All bug report fields gathered.

---

## Phase 3: Preview Issue

**Goal**: Present the complete issue to the user for review before creating it.

**Actions**:

Remind the user: **"This issue will be created on the public GitHub repository. Please review and make sure it does not contain any sensitive information (credentials, internal URLs, tenant IDs, customer data, or proprietary code)."**

Format and display the full issue exactly as it will be filed:

```
===== ISSUE PREVIEW =====

Title: [Bug] <short summary>

Plugin: <plugin-name>
Plugin Version: <version>
Skill / Command: <skill or "N/A">

Bug Description:
<description>

Steps to Reproduce:
<steps>

Expected Behavior:
<expected>

Actual Behavior:
<actual>

Relevant Logs / Screenshots:
<logs or "None">

Environment:
<environment details or "None">

Labels: bug, <plugin-name>

---
🤖 This issue was created using the /report-issue skill.

===== END PREVIEW =====
```

Use `AskUserQuestion` to confirm:

> "Here's the issue that will be created. Would you like to proceed, or would you like to make any changes?"

- If the user wants changes, go back and update the relevant fields, then preview again.
- If the user approves, proceed to Phase 4.

**Output**: User-approved issue ready for creation.

---

## Phase 4: Create Issue

**Goal**: Create the GitHub issue using the `gh` CLI.

**Actions**:

1. Build the issue body from the gathered fields, matching the bug report template structure:

   ```
   ### Plugin

   <plugin-name>

   ### Plugin Version

   <version>

   ### Skill / Command

   <skill or empty>

   ### Bug Description

   <description>

   ### Steps to Reproduce

   <steps>

   ### Expected Behavior

   <expected>

   ### Actual Behavior

   <actual>

   ### Relevant Logs / Screenshots

   <logs or "None">

   ### Environment

   <environment details or "None">

   ---
   🤖 *This issue was created using the `/report-issue` skill.*
   ```

2. Create the issue via `gh`:

   ```bash
   gh issue create --repo microsoft/power-platform-skills --title "[Bug] <short summary>" --label "bug" --label "<plugin-name>" --body "<body>"
   ```

   Use a HEREDOC for the body to preserve formatting.

3. Capture and display the issue URL to the user.

**Output**: Issue created, URL shared with user.

---

## Phase 5: Summarize

**Goal**: Confirm success and suggest next steps.

**Actions**:

1. Display the created issue URL.
2. Let the user know they can track the issue on GitHub.

**Output**: Issue URL and next steps presented.

---

## Important Notes

### Throughout All Phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase.
- **Always use AskUserQuestion** before collecting any environment information — never run commands to gather system details without explicit user consent.
- **Always preview the full issue** before creating it — the user must approve the content.
- **Use the `gh` CLI** to create the issue — confirm it is authenticated before attempting.

### Progress Tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Identify plugin and version | Identifying plugin | Auto-detect plugin name and version from plugin.json |
| Gather bug details | Gathering details | Collect bug description, repro steps, expected/actual behavior |
| Preview issue | Previewing issue | Show complete issue for user review and approval |
| Create issue | Creating issue | File the bug report on GitHub via gh CLI |
| Summarize | Summarizing | Confirm success and share issue URL |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`.

---

**Begin with Phase 1: Identify Plugin & Version**
