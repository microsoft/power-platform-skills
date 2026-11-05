# Troubleshooting

## Common npm Scripts

| Command         | Purpose                                  |
| --------------- | ---------------------------------------- |
| `npm run dev`   | Local dev server (http://localhost:5173) |
| `npm run build` | Build for production                     |
| `npm run lint`  | Run ESLint                               |

## Common Issues

| Problem                 | Solution                                                           |
| ----------------------- | ------------------------------------------------------------------ |
| Build fails             | Check Node.js 22+ version, run `npm install`                       |
| Build fails with TS6133 | Unused imports cause errors in strict mode. Remove unused imports. |
| Auth error              | Run `pa auth logout` (or `power-apps logout` on `power-apps`-only projects), then retry — the CLI will re-prompt browser login. |
| No data                 | Verify user has read access to table, check browser console        |
| Local testing           | Use same browser profile as Power Platform auth                    |

## Deploy Errors

| Error                               | Fix                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| "environment config does not match" | Update `environmentId` in `power.config.json` to match the target environment, then retry.                      |
| DNS/network error                   | Try different environment or contact admin.                                                                      |
| Auth error / token expired          | Run `pa auth logout`, then retry `pa app push` — CLI will prompt re-authentication via browser. On `power-apps`-only projects use `power-apps logout` then `power-apps push`.  |

## Connection and Data Source Errors

| Problem | Solution |
| ------- | -------- |
| `pa app add data-source` stops with a connection message (several connections, a connection it can't create automatically, `--use-sso` not supported, or a connection kept after a failure) | Follow the outcome table in [connector-reference.md](${PLUGIN_ROOT}/shared/connector-reference.md#connections) (CLI 1.3.0+). |
| `Missing required option --connection-id` from `pa connection list-datasets` or `list-tables` | These commands always need a connection ID. Get it with `pa connection list --search <connector>`. |
| A connector call in the running app fails with status 442: `Request blocked due to data loss prevention (DLP) or advanced connector policies (ACP)` | A data policy in the environment blocks that connector or action. Adding the data source still succeeds; the block only appears when the app calls it. Ask a Power Platform admin to allow it, or use a different environment or connector. |

## Resources

**Docs:**
- [Code Apps](https://learn.microsoft.com/power-apps/developer/code-apps/)
- [CLI Reference](https://learn.microsoft.com/power-platform/developer/cli/reference/)
- [Connectors](https://learn.microsoft.com/en-us/connectors/connector-reference/)
- [Azure DevOps API](https://learn.microsoft.com/en-us/rest/api/azure/devops/?view=azure-devops-rest-7.2)
- [Dataverse API](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview)

**GitHub:**
- [Template](https://github.com/microsoft/PowerAppsCodeApps)
- [Issues](https://github.com/microsoft/PowerAppsCodeApps/issues)
