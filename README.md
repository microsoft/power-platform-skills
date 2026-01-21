# Power Pages Site Builder Plugin

A Claude Code plugin for creating and deploying Power Pages code sites using modern frontend frameworks.

## Features

- Create Power Pages code sites with React, Angular, Vue, or Astro
- Automated build and deployment workflow
- Site activation via Power Pages REST API

## Installation

1. Clone this repository:
   ```powershell
   git clone https://github.com/microsoft/power-pages-claude-plugin.git
   ```

2. Add the plugin to your Claude Code settings. Open or create `~/.claude/settings.json` and add:
   ```json
   {
     "projects": {
       "path/to/your/project": {
         "skills": [
           "path/to/power-pages-claude-plugin/skills"
         ]
       }
     }
   }
   ```

   Or add globally for all projects:
   ```json
   {
     "skills": [
       "path/to/power-pages-claude-plugin/skills"
     ]
   }
   ```

3. Restart Claude Code to load the plugin.

## Prerequisites

- **PAC CLI** (v1.44+) installed and authenticated
- **Azure CLI** for API authentication
- **Node.js** (v18+) for building frontend projects
- Power Pages environment with admin privileges

## Usage

Run the skill in Claude Code:
```
/create-code-site
```

The skill guides you through framework selection, site design, build, and deployment.

## Documentation

- [Power Pages Code Sites](https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites)
- [Power Pages REST API](https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites)
- [PAC CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages)

## Contributing

This project welcomes contributions and suggestions.  Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit [Contributor License Agreements](https://cla.opensource.microsoft.com).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
