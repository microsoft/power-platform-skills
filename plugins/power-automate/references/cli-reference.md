# Power Automate CLI Reference

> Note: Shell commands below require the [FlowAgent engine repo](https://github.com/matow_microsoft/flow-agent) cloned and built. Plugin users should use MCP tools instead.

All commands use `node dist/cli.js <command> [options]` from the project root.

## Global Flags
- `--quiet` — Suppress stderr progress messages (JSON-only output)
- `--env=<id>` — Target environment (or set `PA_DEFAULT_ENVIRONMENT`)
- `--format=json|ansi` — Output format for streaming commands

## File Arguments
Use `@path` syntax: `--definition=@flow.json`, `--body=@trigger.json`

## Environment Commands
| Command | Flags |
|---------|-------|
| `list-environments` | — |
| `resolve-environment` | `--env` |

## Cloud Flow Commands
| Command | Required | Optional |
|---------|----------|----------|
| `list-flows` | `--env` | `--top`, `--filter` |
| `get-flow` | `--env`, `--flow` | — |
| `create-flow` | `--env`, `--name`, `--definition=@f` | `--connection-refs=@f`, `--state`, `--validate` |
| `update-flow` | `--env`, `--flow` | `--name`, `--definition=@f`, `--connection-refs=@f`, `--state` |
| `delete-flow` | `--env`, `--flow` | — |
| `publish-flow` | `--env`, `--flow` | — |
| `disable-flow` | `--env`, `--flow` | — |
| `run-flow` | `--env`, `--flow` | `--body=@f`, `--no-callback` |
| `get-trigger-url` | `--env`, `--flow` | `--trigger` |
| `get-run-history` | `--env`, `--flow` | `--top`, `--filter` |
| `get-run-details` | `--env`, `--flow`, `--run` | — |
| `get-run-actions` | `--env`, `--flow`, `--run` | — |
| `set-flow-plan` | `--env`, `--flow`, `--plan` | — |
| `get-flow-sessions` | `--env`, `--flow` | `--top` |
| `set-connection-mode` | `--env`, `--flow`, `--connector`, `--mode` | — |
| `list-connection-modes` | `--env`, `--flow` | — |

## Connection Commands
| Command | Required | Optional |
|---------|----------|----------|
| `list-connections` | `--env` | `--connector` |
| `get-connections` | `--env` | `--connector` |
| `get-connection` | `--env`, `--connector`, `--connection` | — |
| `create-connection` | `--env`, `--connector` | `--no-browser` |
| `delete-connection` | `--env`, `--connector`, `--connection` | — |
| `get-connection-permissions` | `--env`, `--connector`, `--connection` | — |
| `share-connection` | `--env`, `--connector`, `--connection`, `--principal`, `--role` | `--principal-type` |
| `resolve-refs` | `--env`, `--connectors=a,b` | `--output`, `--auto-create`, `--verify` |
| `resolve-params` | `--env`, `--connector`, `--connection`, `--operation` | — |

## Connector Commands
| Command | Required | Optional |
|---------|----------|----------|
| `list-connectors` | `--env` | `--top` |
| `get-connector` | `--env`, `--connector` | — |
| `invoke-operation` | `--env`, `--connector`, `--connection`, `--operation` | `--params=@f` |
| `search-operations` | `--env` | `--query`, `--filter`, `--connector`, `--top` |
| `get-operation-schema` | `--env`, `--connector`, `--operation` | — |
| `get-dynamic-list` | `--env`, `--connector`, `--connection`, `--extension=@f` | `--params=@f` |
| `get-dynamic-tree` | `--env`, `--connector`, `--connection`, `--extension=@f` | `--params=@f`, `--selection=@f` |
| `get-dynamic-schema` | `--env`, `--connector`, `--connection`, `--extension=@f` | `--params=@f`, `--alias`, `--location` |

## Template & Testing Commands
| Command | Required | Optional |
|---------|----------|----------|
| `list-templates` | — | — |
| `scaffold-flow` | `--template` | `--output` |
| `batch-create` | `--env`, `--index=@f` | `--dry-run` |
| `validate-flow` | `--definition=@f` | `--connection-refs=@f` |
| `smoke-test` | `--env` | — |
| `run-and-wait` | `--env`, `--flow` | `--body=@f`, `--timeout`, `--poll-interval`, `--include-actions`, `--no-callback` |
| `watch-run` | `--env`, `--flow` | `--body=@f`, `--timeout`, `--poll-interval` |
| `test-suite` | `--env` | `--config=@f` |

## Desktop Flow Commands
| Command | Required | Optional |
|---------|----------|----------|
| `list-desktop-flows` | `--env` | `--top`, `--name` |
| `run-desktop-flow` | `--env`, `--flow` | `--body=@f`, `--timeout`, `--poll-interval`, `--machine-group`, `--format` |
| `get-desktop-flow-session` | `--env`, `--session` | — |
| `list-machine-groups` | `--env` | `--name` |
| `list-machines` | `--env` | `--group` |

## Other Commands
| Command | Required | Optional |
|---------|----------|----------|
| `search-users` | `--query` | `--top` |
| `help` | — | `[topic]` |
