# Prerequisites Reference

## Required Tools

| Tool           | Minimum Version | Check Command                    | Install                     |
| -------------- | --------------- | -------------------------------- | --------------------------- |
| Node.js        | **v22+**        | `node --version`                 | https://nodejs.org/         |
| pac CLI        | **latest**        | `pwsh -NoProfile -Command "pac"` | https://aka.ms/PowerAppsCLI |
| Git (optional) | Any               | `git --version`                  | https://git-scm.com/        |

```bash
pwsh -NoProfile -Command "pac code push"
pwsh -NoProfile -Command "pac env list"
```

## Required Account

- Power Platform account with code apps enabled
- At least one environment available

## Required Permissions (allowedPrompts)

When using plan mode, include these in `allowedPrompts`:

```json
{
  "allowedPrompts": [
    { "tool": "Bash", "prompt": "check tool versions (node, git)" },
    { "tool": "Bash", "prompt": "scaffold power apps template (npx degit)" },
    { "tool": "Bash", "prompt": "install npm dependencies" },
    { "tool": "Bash", "prompt": "build for production (npm run build)" },
    { "tool": "Bash", "prompt": "authenticate and manage Power Platform (pwsh -NoProfile -Command 'pac auth/env')" },
    { "tool": "Bash", "prompt": "initialize power apps project (pwsh pac code init)" },
    { "tool": "Bash", "prompt": "list connections (/list-connections skill via Power Platform REST API)" },
    { "tool": "Bash", "prompt": "add data sources (pwsh pac code add-data-source)" },
    { "tool": "Bash", "prompt": "deploy to power platform (pac code push)" }
  ]
}
```
