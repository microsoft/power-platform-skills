# Skill Usage Telemetry

## Current State

This release has skill-usage telemetry **enabled**, with transmission on by default.
Recognized skill starts produce local records containing only the fields listed
below. Transmission honors user/environment opt-outs and requires supported region
resolution. Opt-out does not stop local logging. Native controls and generated
PCFs are not instrumented.

The maintainer kill switch remains available: setting `disabled` to `true` stops
event construction, PAC reads for telemetry, local logging, region resolution,
dispatcher spawning and transmission. A user preference of `on` cannot override it.

## User Controls

```text
/power-apps-mobile-extension:telemetry status
/power-apps-mobile-extension:telemetry off
/power-apps-mobile-extension:telemetry on
```

The command uses Node.js 20+ and requires no PAC installation or sign-in. Missing
or invalid arguments mean `status`. It saves a per-user, per-plugin preference in
`~/.power-platform-skills/config.json`, leaving other plugin settings intact.
The configuration root can be overridden with `POWER_PLATFORM_SKILLS_CONFIG_DIR`.

Transmission is **default-on, with no first-run prompt**.
`off` suppresses future collector transmission and
region lookup, **not local event construction or logging**. The mirror includes
available identity fields. A saved choice is read for each event; it does not
recall requests already in flight or delete old logs/backend data.

For automation, set
`POWER_PLATFORM_SKILLS_TELEMETRY_POWER_APPS_MOBILE_EXTENSION_OPTOUT=1` or `true`
in the agent's environment. This overrides a saved `on` choice and stops only
transmission. Setting it to `0` or `false` does not override a saved `off` choice.
The plugin team's committed hard-off flag takes precedence over every user choice.

## Events and Fields

The stream is `event`; the only semantic event name is `skill_started`.
`scripts/lib/telemetry/schema.js` owns the closed schema and 12-skill allowlist.

| Field | Source / restriction |
|---|---|
| `time` | UTC timestamp set once by the dispatcher, shared by mirror and wire |
| `eventName`, `eventType`, `severity` | `skill_started`, `Trace`, `Info` |
| `pluginName`, `pluginVersion` | This plugin's identity and installed manifest version |
| `skillName` | One of the 12 recognized authoring or packaging skills |
| `sessionId` | Host session ID when usable; per-process random fallback |
| `correlationId` | New UUID per emitted start; not a workflow/completion correlation |
| `osName`, `osVersion`, `nodeVersion` | OS family/release and Node major version |
| `aiAgentName`, `aiAgentVersion` | Recognized agent family and version, when available |
| `pacCliVersion` | Existing PAC CLI version, when available |
| `orgId`, `tenantId` | GUIDs from existing `pac auth who` output, when available |
| `eventInfo.aadObjectId` | Existing signed-in user's Entra object GUID, when available |

Missing or invalid optional fields are omitted; telemetry never installs PAC or
requests authentication. GUIDs and session IDs are not anonymous data. The PAM
validator runs before dispatch and again before either disk or wire serialization.
Only `aadObjectId` is allowed inside `eventInfo`. It remains an object in the local
mirror and inside the serialized dimensions; it is not separately stringified.

Never include prompts, arguments, tool outputs, code, paths, URLs, control/project
names, usernames, hostnames, credentials, free-text errors, framework, outcomes,
duration, build targets or arbitrary nested data. Routing cloud context is used
internally and is not included in the event. The collector can separately observe
transport metadata; payload filtering is not a claim that infrastructure has no
additional metadata.

## Hooks and Counting

`hooks/hooks.json` registers `UserPromptSubmit` and `PreToolUse` matching
`Skill|skill`. There is no completion hook. The host must supply the installed `PLUGIN_ROOT` or
`CLAUDE_PLUGIN_ROOT`; never infer it from the control's working directory.
No workspace-global hooks are installed. Host hook support and payload formats
must be validated in each supported host before release; the tests cover the
known snake_case and camelCase input variants, not an end-to-end host install.

All 12 tracked workflow skills accept bare names (for example,
`/generate-native-extension` or the Skill-tool name `generate-native-extension`)
as well as PAM-qualified names. Explicit other-plugin namespaces or plugin hints
are rejected, including conflicting hints on PAM-qualified names. The telemetry
control skill is never tracked.

When a bare name arrives without plugin identity, the hook attributes it to PAM.
It cannot distinguish another installed plugin reusing that name from the payload
alone. For installations with overlapping names, use qualified invocations such
as `/power-apps-mobile-extension:generate-native-extension` where supported, or a
host that supplies the resolved plugin identity.

Only a leading recognized slash command or a structured Skill-tool invocation is
tracked; ordinary prose, unknown names and explicitly identified other plugins
are ignored.

A host can emit both a prompt and a Skill-tool hook for the same visible run.
Each emitted start has its own correlation ID;
there is no claim of cross-hook deduplication. Host fallback sessions cannot link
fresh Node processes. Report the seven main workflows and five packaging stages
separately; do not sum an orchestrator and its child stages as independent full
workflows. A start does not establish completion or success.

## Processing and Routing

```text
Hard-off / invalid config -> stop before event work
Recognized invocation -> optional existing PAC/agent metadata -> strict schema
Detached dispatcher -> strict schema -> local mirror -> user/env opt-out
Region resolution -> CS4.0 envelope -> HTTPS POST
```

Only the configured US (ROW) and EU OneCollector endpoints are accepted. The child
receives a minimal environment and sanitized event, never inherited credentials or
arbitrary hook payloads. It uses a temporary working directory so it does not hold
the user's project open on Windows. Requests have bounded deadlines; failures
never fail a skill and there are no retries or local-log replay.

Each transmitted event uses one POST to one resolved collector.

| Context | Destination |
|---|---|
| No usable PAC auth context | ROW default |
| Public cloud, valid organization, recognized EU geo | EU |
| Public cloud, valid organization, recognized other supported public geo | ROW |
| Lookup failure, unknown geo/cloud, missing organization with other identity context | Local mirror only |
| Government, DoD, China or any unsupported cloud | Local mirror only; no cross-cloud lookup or send |

An unresolved authenticated region never falls back to ROW. An authentication read
failure is indistinguishable from unavailable auth context; it yields an identity-free event
using the documented ROW default, not a guessed tenant region.

## Local Data

- Mirror: `~/.power-platform-skills/telemetry/power-apps-mobile-extension/sessions/<sessionId>/events.jsonl`.
- Local log policy: best-effort cleanup after 14 days of last-write
  inactivity, triggered by a new session; rollover above 10 MiB, not a total cap.
  Inactive installations can retain files longer. File access follows OS user
  directory permissions; review permissions/backups before sharing diagnostics.
- Routing cache: `telemetry/power-apps-mobile-extension/region-cache/<orgId>.json`
  under the same configuration root. Contains region and expiry; filenames reveal
  organization IDs. Freshness is 24 hours; expired entries are removed on access
  and stale files are swept on cache writes. Cleanup is not a wall-clock guarantee.
- Neither preference changes nor the release kill switch deletes existing data.
  Users may delete this plugin's session/cache directories separately. Never
  automatically upload diagnostic logs or treat them as a deferred event queue.

## Maintenance and Validation

The complete shared library in `scripts/lib/telemetry/lib/` is a physical copy of
the repository's canonical `shared/telemetry/lib/`. Refresh the whole directory
when the canonical source changes; the shared telemetry CI suite checks parity.
PAM directly uses its agent, PAC auth, session, user preference and local-log helpers.
PAM owns the wrappers, strict schema, routing and transport; never replace the
PAM dispatcher with the generic dispatcher without retaining nested validation.
On Windows the PAC wrapper invokes only fixed `pac auth who` / `pac --version`
commands through the command processor; no user content enters a shell command.

From the repository root:

```text
node --test plugins/power-apps-mobile-extension/scripts/tests/telemetry.test.js
node --test shared/telemetry/tests/bundled-copies.test.js
node scripts/validate-skill-descriptions.js
node scripts/validate-hooks-manifests.js
node scripts/validate-telemetry-ikeys.js
node scripts/validate-legacy-compatibility.js
```

The tests inject config, authentication, clock and transport dependencies, using
temporary directories and synthetic identities. They do not change the committed
release switch or transmit to a collector. Production command entry points have no
environment override to enable the release, change the key or redirect collectors.

The plugin's path-filtered CI workflow sets
`POWER_PLATFORM_SKILLS_TELEMETRY_POWER_APPS_MOBILE_EXTENSION_OPTOUT=1`, as does the
shared telemetry workflow. Use that opt-out for local automation too.

Automated tests cover known hook payloads, field filtering, routing decisions and
local event emission. They do not establish end-to-end delivery for every host or
region. Downstream EU ingestion and additional host integrations remain unverified.
Server-side storage and retention are not configured or verified by this plugin.