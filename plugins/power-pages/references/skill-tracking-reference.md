# Skill Usage Tracking

This document describes how to record skill usage in Power Pages code sites. Each skill invocation creates or updates site setting YAML files that track which AI skills were used, how many times, and which authoring tool invoked them.

Tracking only runs when `.powerpages-site/site-settings/` exists (site has been deployed at least once). The tracking settings get uploaded to Power Pages on the next deploy.

## How to Record Skill Usage

### Run the Tracking Script

Run the shared tracking script:

```powershell
node "${CLAUDE_PLUGIN_ROOT}/scripts/update-skill-tracking.js" --projectRoot "<PROJECT_ROOT>" --skillName "<PascalCaseName>" --authoringTool "<YourAgentName>"
```

- `--projectRoot`: The project root directory (containing `powerpages.config.json`)
- `--skillName`: The PascalCase skill name from the table below
- `--authoringTool`: Your agent name (e.g., `ClaudeCode`, `GitHubCopilot`). The script normalizes this value — any name containing "claude" becomes `ClaudeCode`, any name containing "github" or "copilot" becomes `GitHubCopilot`.

The script exits silently if `.powerpages-site/site-settings/` does not exist, so it is safe to call unconditionally.

If the tracking script creates or updates site setting YAML files, include those tracking changes in the next git commit for the current phase or final summary commit.

## Skill Name Mapping

| Skill | PascalCase (`--skillName`) | Setting Name |
|-------|---------------------------|--------------|
| create-site | CreateSite | Site/AI/Skills/CreateSite |
| deploy-site | DeploySite | Site/AI/Skills/DeploySite |
| setup-datamodel | SetupDatamodel | Site/AI/Skills/SetupDatamodel |
| add-sample-data | AddSampleData | Site/AI/Skills/AddSampleData |
| activate-site | ActivateSite | Site/AI/Skills/ActivateSite |
| add-seo | AddSeo | Site/AI/Skills/AddSeo |
| create-webroles | CreateWebroles | Site/AI/Skills/CreateWebroles |
| integrate-webapi | IntegrateWebApi | Site/AI/Skills/IntegrateWebApi |
| setup-auth | SetupAuth | Site/AI/Skills/SetupAuth |
| test-site | TestSite | Site/AI/Skills/TestSite |
| audit-permissions | AuditPermissions | Site/AI/Skills/AuditPermissions |
| plan-alm | PlanAlm | Site/AI/Skills/PlanAlm |
| add-server-logic | AddServerLogic | Site/AI/Skills/AddServerLogic |
| add-cloud-flow | AddCloudFlow | Site/AI/Skills/AddCloudFlow |
| integrate-backend | IntegrateBackend | Site/AI/Skills/IntegrateBackend |

## YAML Format

The tracking script produces site setting files in code site git format (alphabetically sorted, unquoted values):

```yaml
description: Tracks usage count of the CreateSite skill
id: 778fa3d0-a2ef-4d2b-98b8-e6c7d8ce1444
name: Site/AI/Skills/CreateSite
value: 1
```

- **Skill counter** (`Site-AI-Skills-<SkillName>.sitesetting.yml`): Incremented each time the skill runs. The `id` is preserved across increments.
- **Authoring tool** (`Site-AI-Tools-AuthoringTool.sitesetting.yml`): Created once on first skill invocation. Subsequent runs preserve the original value.
