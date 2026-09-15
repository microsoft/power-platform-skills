# mobile-apps hooks

What `hooks.json` wires up, and why.

Telemetry-only start hooks. They never validate, mutate, or block tool calls. File validation stays
owned by each workflow through `scripts/validate-mobile-files.js`.

This prose lived in a `_comment` key inside `hooks.json` itself. Claude Code validates that file
against a closed schema and prints `mobile-apps: hooks.json: unknown key "_comment" ignored` at
**every session start**, which reads as a plugin misconfiguration to the user (#555, #558). The
documentation belongs here instead; `scripts/validate-hooks-manifests.js` keeps it from drifting
back.

Telemetry is fail-closed and honours the `POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT`
environment variable, which disables transmission for automation and CI.
