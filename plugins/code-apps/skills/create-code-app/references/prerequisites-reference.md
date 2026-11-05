# Prerequisites Reference

## Required Tools

| Tool              | Minimum Version | Check Command                  | Install                                         |
| ----------------- | --------------- | ------------------------------ | ----------------------------------------------- |
| Node.js           | **v22+**        | `node --version`               | https://nodejs.org/                             |
| Git (optional)    | Any             | `git --version`                | https://git-scm.com/                            |
| Power Apps CLI    | **1.3.0+** for new projects | `npx --no-install pa --version` | Installed per project by `/create-code-app` |

The Power Apps CLI (`@microsoft/power-apps-cli`) is installed into each project as a dev dependency during scaffolding (`/create-code-app` Step 4). The Vite template doesn't include it, and no global install is required. New projects get 1.3.0 or later, which lets connector skills find or create connections without a connection ID. Existing projects on an older CLI keep working with an explicit connection ID.

## Required Account

- Power Platform account with code apps enabled
- At least one environment available
- Know your environment ID: find it in the URL at make.powerapps.com, e.g. `https://make.powerapps.com/environments/<env-id>/home`

## Required Permissions (allowedPrompts)

When using plan mode, include these in `allowedPrompts`:

```json
{
  "allowedPrompts": [
    { "tool": "Bash", "prompt": "check tool versions (node, git)" },
    { "tool": "Bash", "prompt": "scaffold power apps template (npx degit)" },
    { "tool": "Bash", "prompt": "install npm dependencies" },
    { "tool": "Bash", "prompt": "install the Power Apps CLI into the project (npm install --save-dev @microsoft/power-apps-cli)" },
    { "tool": "Bash", "prompt": "build for production (npm run build)" },
    { "tool": "Bash", "prompt": "initialize power apps project (pa app init)" },
    { "tool": "Bash", "prompt": "list connections, datasets, and tables (pa connection list, list-datasets, list-tables)" },
    { "tool": "Bash", "prompt": "add data sources (pa app add data-source)" },
    { "tool": "Bash", "prompt": "create connections (pa connection create)" },
    { "tool": "Bash", "prompt": "deploy to power platform (pa app push)" }
  ]
}
```
