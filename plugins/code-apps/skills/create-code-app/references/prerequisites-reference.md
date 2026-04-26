# Prerequisites Reference

## Required Tools

| Tool           | Minimum Version | Check Command    | Install                |
| -------------- | --------------- | ---------------- | ---------------------- |
| Node.js        | **v22+**        | `node --version` | https://nodejs.org/    |
| Git (optional) | Any             | `git --version`  | https://git-scm.com/  |

The Power Apps CLI (`@microsoft/power-apps-cli`) is installed automatically as part of `npm install` when the project is scaffolded from the template. No separate CLI install is required.

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
    { "tool": "Bash", "prompt": "build for production (npm run build)" },
    { "tool": "Bash", "prompt": "initialize power apps project (npx power-apps init)" },
    { "tool": "Bash", "prompt": "list connections (npx power-apps list-connections)" },
    { "tool": "Bash", "prompt": "add data sources (npx power-apps add-data-source)" },
    { "tool": "Bash", "prompt": "deploy to power platform (npx power-apps push)" }
  ]
}
```
