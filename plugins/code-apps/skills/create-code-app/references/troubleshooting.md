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
| Build fails             | Check Node.js LTS version, run `npm install`                       |
| Build fails with TS6133 | Unused imports cause errors in strict mode. Remove unused imports. |
| Auth error              | Run `pwsh -NoProfile -Command "pac auth clear" && pwsh -NoProfile -Command "pac auth create"`        |
| No data                 | Verify user has read access to table, check browser console        |
| Local testing           | Use same browser profile as Power Platform auth                    |

## Deploy Errors

| Error                               | Fix                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "environment config does not match" | Ask the user: **retarget the app** (update `environmentId` in `power.config.json` to match active env) or **switch auth** (run `pwsh -NoProfile -Command "pac auth create"` to match the app's environment). Then retry. |
| DNS/network error                   | Try different environment or contact admin.                                                                                                                                                             |
| Auth error                          | Run `pwsh -NoProfile -Command "pac auth create"` and retry.                                                                                                                                                              |
| Auth error on macOS (pac bug)       | `pac` has known auth bugs on Mac. Use the npx CLI instead: run `npm install -g @microsoft/power-apps-cli` (skip if already installed), then `npx power-apps push`. |

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
