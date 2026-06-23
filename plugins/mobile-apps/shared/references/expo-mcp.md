# Expo MCP — when and how to use it

The plugin's [`.mcp.json`](../../.mcp.json) registers the **Expo MCP server** (`expo-mcp` on npm, MIT, free). The host (Claude Code, Copilot Chat) launches it on demand when a skill asks for an `expo.*` tool. No install step required by the user.

The plugin starts `expo-mcp` with `--dev-server-url http://localhost:8081`, the default Metro port. This means:

- **Metro NOT running** → static introspection only (the 5 tools below still work — they read `package.json`, `app.json`, etc.).
- **Metro running** (`npm run dev`) → dev loop unlocked: `expo.runDoctor()` and `expo.runScript("build")` surface live runtime errors, the agent fixes the code, Metro hot-reloads, and the next call sees the post-fix state.

## The dev loop

This is the pattern the upstream template ([`pa-wrap-tools/templates/expo-app-standalone`](https://microsoft.ghe.com/bic/pa-wrap-tools/tree/main/templates/expo-app-standalone), materialized by the user with `degit` before `/create-mobile-app` runs) is built around:

```
1. User runs `npm run dev`                   ← Metro starts on :8081
2. App boots in browser / native dev client
3. User: "the inbox screen is throwing"
4. Agent: expo.runDoctor()                    ← reads live error from Metro
5. Agent: edits app/(tabs)/inbox.tsx          ← Metro hot-reloads automatically
6. Agent: expo.runDoctor()                    ← confirms fix
7. Repeat
```

No manual rebuild between iterations. The user owns the Metro process; the agent never starts or stops it.

## The five MCP tools this plugin uses

The plugin uses **only** the five tools below. Each is opt-in and has a mandatory shell fallback so the plugin works on hosts without MCP support.

| MCP tool | Used by | Replaces (fallback) |
|---|---|---|
| `expo.getProjectInfo()` — returns `{ sdkVersion, plugins, nativeModules, ... }` as JSON | [`shared/version-check.md`](../version-check.md) standard prereq snippet | `node -e "console.log(JSON.stringify(require('./app.json').expo, null, 2))"` + manual SDK parse |
| `expo.installPackage("<name>")` — installs the SDK-matched version | [`/add-native`](../../skills/add-native/SKILL.md) Step 4 | `npx expo install <name>` |
| `expo.getConfigPluginEffects("<name>")` — shows which `Info.plist` / `AndroidManifest.xml` keys a plugin will inject on prebuild | [`/add-native`](../../skills/add-native/SKILL.md) Step 5 | Read the module's published docs (link printed by `npx expo install`) |
| `expo.runScript("build")` — returns `{ success, errors, warnings }` with parsed Metro / TS errors. **If Metro is running, errors include live bundler / TypeScript diagnostics from the dev server.** | [`/deploy`](../../skills/deploy/SKILL.md) Step 2 | `npm run build` (raw stderr) |
| `expo.runDoctor()` — categorized SDK / dep / plugin issues as JSON. **If Metro is running, also surfaces live runtime errors from the connected app.** | [`/report-issue`](../../skills/report-issue/SKILL.md) Step 3 + the dev loop | `npx expo doctor` (text output) |
| `mcp__expo__collect_app_logs` — streams live console output + uncaught exceptions from the running app. Returns structured log entries with level, message, and stack. | [`/create-mobile-app`](../../skills/create-mobile-app/SKILL.md) Step 11.5 dev smoke test | `npx expo doctor` (less detailed; no per-screen scoping) |
| `mcp__expo__automation_take_screenshot` — captures the current screen state as an image. Used to detect red error overlays, blank screens, and layout issues visually. | [`/create-mobile-app`](../../skills/create-mobile-app/SKILL.md) Step 11.5 dev smoke test | None — tell user to check the screen manually |
| `mcp__expo__automation_tap` — taps a UI element by label or selector. Used to navigate between screens during the smoke test without user interaction. | [`/create-mobile-app`](../../skills/create-mobile-app/SKILL.md) Step 11.5 dev smoke test | None — tell user to navigate manually |

**Note on `collect_app_logs`, `take_screenshot`, and `tap`:** these three tools require Metro to be running and a device/browser connected. They are only used in Step 11.5 of `/create-mobile-app`. The skill always checks for Metro first and falls back to manual instructions if these tools are unavailable.

## The dev loop is user-driven

The plugin **never** runs `npm run dev` itself. The user starts Metro when they want to iterate, and stops it when they're done. The agent simply takes advantage of the live connection if it exists.

This keeps responsibilities clean:

| Responsibility | Owner |
|---|---|
| Start / stop Metro | User (`npm run dev` / Ctrl-C) |
| Detect that Metro is running | Host (when MCP tool returns dev-server-aware data) |
| Read runtime errors | Agent via `expo.runDoctor()` |
| Edit code to fix | Agent (with user consent for mutations) |
| Hot-reload | Metro (automatic) |
| Decide when to deploy | User (runs `/deploy`) |

## Mandatory fallback rule

Every skill that uses an `expo.*` tool MUST have a shell-out fallback. The plugin is opt-in for MCP — users on hosts that don't surface MCP tools (or who haven't started the server) still get a working flow.

In skill markdown, write this as a two-block pattern:

> **Prefer MCP if available** — call `expo.<tool>()`. See `shared/references/expo-mcp.md`.
>
> **Shell fallback** — if `expo.*` tools are not available: `<shell command>`

Never block on MCP. Never require it. The user-consent contract for mutations is unchanged — even when `expo.installPackage()` is called via MCP, the skill still prints "About to install `<name>`@<version>; ok?" per `shared-instructions.md`.

## How to know if it's available

The host advertises registered MCP tools to the agent. If `expo.*` tools appear in the available tool list for the current turn, use them. If not, shell-out.

There is no need to "start" or "ping" the server from a skill — the host handles lifecycle.

## What expo-mcp does NOT provide (and the plugin does not use)

- Cloud builds (EAS Build) — out of scope for this plugin entirely
- Submit-to-store (EAS Submit) — out of scope
- OTA updates (EAS Update) — out of scope
- Hosted analytics / crash reporting
- Push notification delivery service

`expo-mcp` is strictly a local-development MCP layer. Free utility, no account required, no usage caps, no network calls beyond docs lookup.

## Reference

- npm: <https://www.npmjs.com/package/expo-mcp>
- repo: <https://github.com/expo/expo-mcp> (MIT)
- spec: <https://modelcontextprotocol.io>


## Mandatory fallback rule

Every skill that uses an `expo.*` tool MUST have a shell-out fallback. The plugin is opt-in for MCP — users on hosts that don't surface MCP tools (or who haven't started the server) still get a working flow.

In skill markdown, write this as a two-block pattern:

> **Prefer MCP if available** — call `expo.<tool>()`. See `shared/references/expo-mcp.md`.
>
> **Shell fallback** — if `expo.*` tools are not available: `<shell command>`

Never block on MCP. Never require it. The user-consent contract for mutations is unchanged — even when `expo.installPackage()` is called via MCP, the skill still prints "About to install `<name>`@<version>; ok?" per `shared-instructions.md`.

## How to know if it's available

The host advertises registered MCP tools to the agent. If `expo.*` tools appear in the available tool list for the current turn, use them. If not, shell-out.

There is no need to "start" or "ping" the server from a skill — the host handles lifecycle.

## What expo-mcp does NOT provide (and the plugin does not use)

- Cloud builds (EAS Build) — out of scope for this plugin entirely
- Submit-to-store (EAS Submit) — out of scope
- OTA updates (EAS Update) — out of scope
- Hosted analytics / crash reporting
- Push notification delivery service

`expo-mcp` is strictly a local-development MCP layer. Free utility, no account required, no usage caps, no network calls beyond docs lookup.

## Reference

- npm: <https://www.npmjs.com/package/expo-mcp>
- repo: <https://github.com/expo/expo-mcp> (MIT)
- spec: <https://modelcontextprotocol.io>
