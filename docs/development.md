# Developing Power Platform Skills

This page is for people who work on the plugins in this repository.
To install and use the plugins, start with the [README](../README.md).
To load a plugin from a local checkout, see [Local Development](../README.md#local-development).

## Repository Structure

```text
power-platform-skills/
├── marketplace.json          # Open Plugins marketplace manifest (lists all plugins)
├── .claude-plugin/           # Legacy marketplace shim for existing subscriptions
│   └── marketplace.json
├── .claude/
│   └── settings.json         # Auto-allowed tools (pac, node, dotnet, etc.)
├── plugins/
│   ├── power-pages/          # Power Pages plugin
│   │   ├── .plugin/
│   │   │   └── plugin.json
│   │   ├── .claude-plugin/   # Legacy manifest mirror
│   │   │   └── plugin.json
│   │   ├── commands/
│   │   ├── shared/
│   │   └── skills/
│   ├── model-apps/           # Model Apps plugin
│   |   ├── .plugin/
│   │   └── plugin.json
│   |   ├── commands/
│   |   ├── skills/
│   |   ├── shared/           # Shared references + samples
│   |   └── github/           # GitHub Copilot instructions
│   ├── mcp-apps/             # MCP codeful tool + widget generator plugin
│   │   ├── .plugin/
│   │   │   └── plugin.json
│   │   ├── references/
│   │   ├── samples/
│   │   └── skills/
│   ├── code-apps/            # Code Apps plugin
│   │   ├── .plugin/
│   │   │   └── plugin.json
│   │   ├── agents/
│   │   ├── skills/
│   │   └── shared/           # Shared instructions + references
│   ├── mobile-apps/          # Mobile Apps plugin
│   │   ├── .plugin/
│   │   │   └── plugin.json
│   │   ├── .claude-plugin/   # Legacy manifest mirror
│   │   │   └── plugin.json
│   │   ├── agents/
│   │   ├── skills/
│   │   ├── shared/           # Shared instructions + references
│   │   └── template/         # Bundled Expo app template
│   ├── power-apps-mobile-extension/ # Native controls for wrapped Canvas apps
│   │   ├── .plugin/
│   │   │   └── plugin.json
│   │   ├── .claude-plugin/   # Legacy manifest mirror
│   │   │   └── plugin.json
│   │   ├── shared/
│   │   └── skills/
│   ├── canvas-apps/          # Canvas Apps plugin
│   │   ├── .plugin/
│   │   │   └── plugin.json
│   │   ├── references/       # Technical + design guides
│   │   └── skills/
│   └── process-intelligence/ # Process Mining analytics plugin
│       ├── .plugin/
│       │   └── plugin.json
│       ├── server/           # Self-contained MCP bundle
│       ├── references/
│       └── skills/
├── AGENTS.md                 # Development guidelines
└── README.md
```

The `.claude-plugin` files are compatibility mirrors for users who subscribed
before the Open Plugins migration. The root legacy marketplace mirrors
`marketplace.json`, and per-plugin legacy manifests mirror `.plugin/plugin.json`.
The shared marketplace keeps marketplace-level `owner` and `metadata`, while each
plugin entry is intentionally just `name` plus repository-root-relative `source`.
Plugin descriptions, versions, licenses, and keywords are controlled from each
plugin's `.plugin/plugin.json`. This keeps existing subscriptions updating without
duplicating display/update metadata.

Plugins maintained in other repositories, such as `dataverse`, use a remote `source` object instead of a path.
Copilot CLI reads `marketplace.json` and Claude Code reads `.claude-plugin/marketplace.json`, and they spell a plugin in a repository subdirectory differently.
So `marketplace.json` uses `"source": "github"` with `repo` and `path`, and the legacy file uses `"source": "git-subdir"` with `url` and `path`.
`scripts/validate-legacy-compatibility.js` enforces that pairing.

## Installer name validation

The installer validates plugin names in local and downloaded marketplace manifests before
installation. Names must follow the Open Plugins format: 1–64 lowercase ASCII letters or
digits, with single dots or hyphens allowed between alphanumeric endpoints. CLI arguments
are passed directly to executables; Windows batch launchers accept only shell-inert arguments.
