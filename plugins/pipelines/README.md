# Power Platform Pipelines Plugin

Create, configure, and manage Power Platform deployment pipelines for ALM solution promotion across environments.

## What This Plugin Does

This plugin automates the end-to-end lifecycle of [Power Platform Pipelines](https://learn.microsoft.com/en-us/power-platform/alm/pipelines), enabling you to:

- **Create deployment pipelines** with source and target environments
- **Configure multi-stage deployments** (Dev → QA → Staging → Prod)
- **Deploy solutions** through pipeline stages with monitoring
- **Check deployment status** and troubleshoot failures

## Available Skills

| Skill | Description |
|---|---|
| `/create-pipeline` | Create a new deployment pipeline with environments and stages |
| `/list-pipelines` | List available deployment pipelines for an environment |
| `/deploy-solution` | Deploy a Dataverse solution through a pipeline stage |
| `/pipeline-status` | Check the status of a deployment stage run |
| `/configure-stages` | Add or modify stages in an existing pipeline |

## Prerequisites

1. **PAC CLI** — Installed and authenticated (`pac auth create`)
2. **Azure CLI** — Installed and signed in (`az login`)
3. **Dataverse Access** — System Administrator or Deployment Pipeline Administrator role on the pipeline host environment
4. **Node.js** — v18 or later

## Quick Start

1. Authenticate with PAC CLI:
   ```
   pac auth create --environment https://your-env.crm.dynamics.com
   ```

2. Create your first pipeline:
   ```
   /create-pipeline My ALM Pipeline
   ```

3. Deploy a solution:
   ```
   /deploy-solution MySolution to QA
   ```

4. Check status:
   ```
   /pipeline-status
   ```

## Architecture

```
plugins/pipelines/
├── .claude-plugin/     # Plugin metadata
├── agents/             # Advisory agents (pipeline-architect)
├── hooks/              # Lifecycle hooks
├── references/         # Entity docs, OData patterns, troubleshooting
├── scripts/            # Executable Node.js scripts
│   └── lib/            # Shared helpers and constants
└── skills/             # User-invocable skills (SKILL.md files)
```

## References

- [Power Platform Pipelines Documentation](https://learn.microsoft.com/en-us/power-platform/alm/pipelines)
- [Pipelines API Reference](https://learn.microsoft.com/en-us/power-platform/alm/devops-github-actions)
- [Dataverse Web API](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview)
