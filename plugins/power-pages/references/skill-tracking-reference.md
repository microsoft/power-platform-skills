# Skill Usage Tracking

This document describes how to record skill usage in Power Pages code sites. Each skill invocation creates or updates site setting YAML files that track which AI skills were used, how many times, and which authoring tool invoked them.

Tracking only runs when `.powerpages-site/site-settings/` exists (site has been deployed at least once). The tracking settings get uploaded to Power Pages on the next deploy.

## How to Record Skill Usage

### Step 1: Detect the Authoring Tool

Determine which AI tool you are and the environment you're running in:

1. Identify which AI tool you are (Claude Code, GitHub Copilot, etc.)
2. Detect if running inside VS Code by checking environment variables:
   ```powershell
   $env:TERM_PROGRAM -eq 'vscode'
   # or
   $env:VSCODE_GIT_ASKPASS_NODE
   ```
3. Combine tool + environment to pick the correct `--authoringTool` value:

| AI Tool | Terminal/CLI | VS Code |
|---------|-------------|---------|
| Claude Code | `ClaudeCodeCLI` | `ClaudeCodeVSCode` |
| GitHub Copilot | `GitHubCopilotCLI` | `GitHubCopilotVSCode` |

If you cannot determine the AI tool, use `Unknown` as the value.

### Step 2: Run the Tracking Script

Run the shared tracking script with all three required arguments:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/update-skill-tracking.js" --projectRoot "<PROJECT_ROOT>" --skillName "<PascalCaseName>" --authoringTool "<value>"
```

- `--projectRoot`: The project root directory (containing `powerpages.config.json`)
- `--skillName`: The PascalCase skill name from the table below
- `--authoringTool`: The value determined in Step 1

The script exits silently if `.powerpages-site/site-settings/` does not exist, so it is safe to call unconditionally.

## Skill Name Mapping

| Skill | PascalCase (`--skillName`) | Setting Name |
|-------|---------------------------|--------------|
| create-site | CreateSite | Site/AI/CreateSite |
| deploy-site | DeploySite | Site/AI/DeploySite |
| setup-datamodel | SetupDatamodel | Site/AI/SetupDatamodel |
| add-sample-data | AddSampleData | Site/AI/AddSampleData |
| activate-site | ActivateSite | Site/AI/ActivateSite |
| add-seo | AddSeo | Site/AI/AddSeo |
| create-webroles | CreateWebroles | Site/AI/CreateWebroles |
| integrate-webapi | IntegrateWebApi | Site/AI/IntegrateWebApi |
| setup-auth | SetupAuth | Site/AI/SetupAuth |

## YAML Format

The tracking script produces site setting files in code site git format (alphabetically sorted, unquoted values):

```yaml
description: Tracks usage count of the CreateSite skill
id: 778fa3d0-a2ef-4d2b-98b8-e6c7d8ce1444
name: Site/AI/CreateSite
value: 1
```

- **Skill counter** (`Site-AI-<SkillName>.sitesetting.yml`): Incremented each time the skill runs. The `id` is preserved across increments.
- **Authoring tool** (`Site-AI-AuthoringTool.sitesetting.yml`): Created once on first skill invocation. Subsequent runs preserve the original value.
