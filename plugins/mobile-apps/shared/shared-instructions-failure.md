# Command failure handling

Load when `az`, `npm`, `npx` or Expo exits nonzero. Capture exact stderr; never continue past
a failed gate or retry silently. Workflow-specific phase/retry gates take precedence.

## Power Apps commands

Run `npx power-apps auth-status --json`. Correct the active account via `auth-switch --account`
if cached, or `login [--account]` if missing; logout is last resort for corrupt cache.
Retry the original command with the same arguments **once after correction**, then apply:

| Failure | Action |
|---|---|
| `connectionId not found` / empty connection | Resolve with `create-connection --api-id --json`, caller's existing ID, or `list-connection-references --solution-id --json`; use the corresponding full flag |
| Missing connector arguments | Supply the known long-form `apiId`, `orgUrl`, `resourceName` etc.; don't hide it in an interactive CLI loop |
| `environment not set` | Verify config and approved environment; missing config needs approved `init -t MobileApp --display-name --environment-id --non-interactive` |
| Other / repeated nonzero | Report exact stderr and STOP |

`az account set` does not switch the standalone Power Apps CLI user.

## TypeScript

Capture all errors once; batch repair by root cause and rerun the same gate.
`TS6133`: remove unused imports. `TS2305`/`TS2307`: verify generated exports and installed
packages; never install unplanned packages. Native packages must already be in the template.
An approved exact-version JS dependency can be installed using `npm install --save-exact`.
Unresolved errors block progression and native builds; do not replace real capabilities with mocks.

## Dependency installation

| Failure | Action |
|---|---|
| 404 for Microsoft packages | Verify the configured feed/auth; STOP rather than rewriting registry or provisioning tokens |
| Expo peer mismatch | `npx expo install --fix` once, only in a workflow authorized to repair dependencies; otherwise STOP |
| Reanimated build failure | Verify `react-native-reanimated/plugin` is the final Babel plugin |
| Other / repeated failure | Surface stderr and STOP |

Fresh-template create does not provision feeds or install baseline dependencies.
Native build errors (Gradle/Xcode) need human review: surface stderr and stop.
For requested runtime diagnosis, use `/debug-app` with the captured Metro terminal, never HTTP probes.
