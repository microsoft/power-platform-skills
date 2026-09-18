# App-local agent guidance (template)

This is an Expo / React Native / TypeScript **Power Apps mobile app** using
`@microsoft/power-apps-native-host`, not a generic Expo Go project.
These instructions apply inside an app copied from this template. In the
marketplace repository, this file is template content, not repository or plugin
development policy.

## Choose the smallest appropriate workflow

Use the host's **advertised skill inventory** to check availability and invoke the
exact advertised name (including its namespace, if present). Do not discover
plugins through private installation paths or assume a skill is loaded.
Prefer the matching `mobile-app` skill when available:

| Request | Skill |
| --- | --- |
| Create a new app in a fresh, installed template | `create-mobile-app` - fresh only; never rerun over an existing app |
| Approved integration across an existing app's plan, data, native features, or screens | `edit-app` |
| Camera, files, location, or another device capability | `add-native` |
| Connect a data source | `add-datasource` (routes to the appropriate connector) |
| "npm run dev fails", "app won't start", "QR won't open", or runtime failures | `debug-app` |

Answer ordinary questions directly. Keep tiny app-owned edits small and validate
only the affected behavior; a question or small edit does not require full
integration, a deep scan, or regeneration. Read the relevant app files and any
app-local plan or memory only as needed. Ask before starting costly integration;
approval of one small change does not approve a full `edit-app` pass.

## When the plugin is unavailable

If missing, disabled, or not loaded, explain that limitation and offer the
[public manual installation instructions](https://github.com/microsoft/power-platform-skills#manual-installation).
The user can run exactly these commands **inside a Claude Code or GitHub Copilot
CLI session**, not a shell:

```text
/plugin marketplace add microsoft/power-platform-skills
/plugin install mobile-app@power-platform-skills
```

If already installed, enable/load it using the host's controls and recheck the
advertised inventory. Never install automatically or recommend the all-plugins
installer. If the user declines, continue with safe, scoped help and do not nag
or repeat the offer unless asked.

## Startup and runtime diagnosis

For app problems (including dependency installation, startup, runtime, or QR
opening), recommend trying the available `debug-app` skill before reporting an
issue. This is a recommendation, not a prerequisite: honor explicit direct report
requests. Plugin installation/loading failures can make app diagnosis unavailable;
do not block reporting in those cases.

`debug-app` supports bounded startup diagnosis **before the app has loaded**,
including failed install/predev/Metro startup and QR opening; loaded-app runtime
monitoring is a separate mode requiring live logs.
An agent already running creation that observes a startup failure should offer
to reuse `debug-app` startup diagnosis, not create another repair loop.
Running `npm run dev` alone cannot wake an agent, invoke a skill, or install a
monitor. Do not add automatic hooks, watchers, or background repair.

Start with read-only evidence relevant to the symptom. Ask before dependency
installation or same-lock restoration, starting/restarting Metro, or deployment.
Keep dependency and native-host **upgrades in the separate upgrade workflow**,
not `debug-app`; see [README.md](README.md#upgrade-the-native-host).
Do not delete a lockfile or change versions to repair startup. Same-lock
restoration requires approval; explain its changes and verify the original
symptom afterward.

## App boundaries

- `power.config.json` and `src/generated/` are CLI-owned. Use the supported
  Power Apps CLI workflows; do not hand-edit generated configuration or services.
- Use connectors and generated services for Power Platform data.
- Native capabilities are limited to modules shipped with the template and
  supported by the host binary; installing another native package cannot add it
  to that binary. `expo-haptics` remains unsupported at runtime.
- Do not patch native-host or MSAL source, `node_modules/`, or generated native
  projects; do not substitute forks, aliases, vendored code, or postinstall
  rewrites. Report confirmed package defects with sanitized reproduction steps.
- Keep raw diagnostics, credentials, tokens, and sensitive configuration out of
  plans, memory, documentation, and summaries. Record only sanitized findings.
- Preserve customer guidance and app changes. Existing-app guidance adoption is
  opt-in; do not run fresh-template preparation over an existing app.
