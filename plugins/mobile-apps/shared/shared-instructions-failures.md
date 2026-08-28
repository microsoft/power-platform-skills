## Command Failure Handling

Apply these rules whenever an `az`, `npm`, `npx`, or `expo` command exits non-zero. Do NOT retry silently or proceed past a failure.

### `npx power-apps *` failures (all commands)

1. Run `npx power-apps auth-status --json` to verify the active account.
2. If the wrong account is active and the right one is cached, run `npx power-apps auth-switch --account <email>`.
3. If no account is cached or the right account is missing, run `npx power-apps login [--account <email>]`.
4. Re-run the same `npx power-apps *` command once with the same arguments.
5. If it still fails, apply the command-specific handling below and report exact stderr.

### `npx tsc --noEmit` failures

| Error | Action |
| --- | --- |
| `TS6133` (unused import) | Remove the unused import and retry once. |
| `TS2305` / `TS2307` (missing export / module not found) | If the missing package ships native code/config, STOP unless it already exists in the template `package.json`. If an approved plan names a pure-JavaScript dependency, run `npm install --save-exact <package>@<approved-version>` and retry. Do not install an unplanned package merely to silence an import error. |
| Other TS error | Surface the file, line, and full message. STOP. Do not run platform builds. |

### `npx power-apps add-data-source` failures

| Condition | Action |
| --- | --- |
| Wrong Power Apps CLI user, `Multiple accounts found`, or standalone CLI auth loop | Run `npx power-apps auth-status --json` to see cached accounts. If the right account is cached, run `npx power-apps auth-switch --account <email>`. If not cached, run `npx power-apps login [--account <email>]`. Do not use `az account set` to switch this CLI. |
| `connectionId not found` or empty `-c` | Create a connection with `npx power-apps create-connection --api-id <api-id> --json`, use a caller-provided existing connection ID, or use `list-connection-references --solution-id <solution-id> --json` and retry with `--connection-ref`. |
| Missing `orgUrl`, `resourceName`, `apiId`, or `environmentId` | Re-run with the full long-form command for that connector shape; do not fall back to interactive prompts. |
| `environment not set` | Confirm `power.config.json` has `environmentId`; if missing, rerun `npx power-apps init -t MobileApp --display-name '<name>' --environment-id <id> --non-interactive`. |
| Non-zero exit for any other reason | Report exact stderr. STOP. |

### `npm install` / `npx expo install` failures

| Condition | Action |
| --- | --- |
| `404` for `@microsoft/power-apps-native-host` or `@microsoft/power-apps` | Likely an internal-feed-only package. Check npm registry/auth configuration for the correct Azure Artifacts feed. STOP. |
| Peer-dep mismatch from Expo SDK | Run `npx expo install --fix` once. If still failing, surface the message and STOP. |
| Reanimated install but build fails immediately after | `react-native-reanimated/plugin` is missing or wrongly ordered in `babel.config.js`. Add it as the **last** plugin entry. |

### Native run or web run failures

Native build errors (Gradle, Xcode, Metro) require human eyes. Surface the full stderr and STOP — do NOT attempt to auto-fix native build issues.

---

