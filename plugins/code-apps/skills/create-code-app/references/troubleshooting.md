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
| Auth error              | Run `npx power-apps logout`, then retry — the CLI will re-prompt browser login. |
| No data                 | Verify user has read access to table, check browser console        |
| Local testing           | Use same browser profile as Power Platform auth                    |

## Deploy Errors

| Error                               | Fix                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| "environment config does not match" | Update `environmentId` in `power.config.json` to match the target environment, then retry.                      |
| DNS/network error                   | Try different environment or contact admin.                                                                      |
| Auth error / token expired          | Run `npx power-apps logout`, then retry `npx power-apps push` — CLI will prompt re-authentication via browser.  |

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
