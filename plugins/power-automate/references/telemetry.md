# Power Automate telemetry

The plugin records usage metadata through two separate paths: skill hooks and
the bundled MCP/CLI engine. Transmission is default-on when that path can
establish an eligible destination. A local diagnostic mirror is retained even
when transmission is opted out.

## Collection and identifiers

Skill hooks record `skill_started`, plugin and agent versions, OS and Node
metadata, and random session/correlation IDs. When PAC exposes them, these
events include the Dataverse organization GUID (`orgId`), Entra tenant GUID
(`tenantId`), and signed-in user's Entra object ID (`eventInfo.aadObjectId`).
Hosts firing both skill hooks can record duplicate starts.

The MCP/CLI engine records tool/command starts and completions and flow
creation. These include names of tools/commands, outcome, duration, error
class/code, random session/correlation IDs, system and agent versions, and
environment GUID/location/region when available. Core events can include a
tenant GUID from `FLOWAGENT_TENANT_ID`; they do not include organization or
Entra user object IDs.

These identifiers are pseudonymous, not anonymous. Events never contain
prompts, skill arguments, tool inputs, request/response bodies, credentials,
usernames, email addresses, flow display names, paths, or error messages.
Top-level event fields are allowlisted; hook `eventInfo` is restricted to the
documented object ID.

## Routing

Hook events are eligible for transmission only when PAC positively identifies
public cloud. Unknown or sovereign clouds remain local. Organization-based
routing selects a configured US or EU collector; without an organization ID,
the configured US default is used, but only after the public-cloud gate passes.

Core MCP/CLI events require an environment ID, recognized environment location,
and positively identified commercial cloud. The location selects the matching
Power Automate collector and ingestion key; unknown locations never fall back
to a US route. Cloud is re-resolved for each eligible event from `PA_CLOUD`,
the CLI configuration, then Azure CLI, so a prior commercial resolution does
not authorize transmission after a cloud switch. Detection failures stay local.
Each detached core collector request has a five-second deadline.

## Opt out

Use `/power-automate:telemetry off` or set
`POWER_PLATFORM_SKILLS_TELEMETRY_POWER_AUTOMATE_OPTOUT=1` (also accepts `true`,
case-insensitive). The environment variable takes precedence over the saved
choice. Both paths stop remote transmission and keep their local mirrors.

The saved choice is `telemetry["power-automate"]` in
`~/.power-platform-skills/config.json`; `POWER_PLATFORM_SKILLS_CONFIG_DIR`
changes that directory. `/power-automate:telemetry on` restores the saved
opt-in but cannot override the environment opt-out.

The engine also honors legacy `FLOWAGENT_TELEMETRY=0` or
`POWER_PLATFORM_SKILLS_TELEMETRY=0` (`false` and `off` also accepted). These
disable core capture, including its local file; they are not the hook
transmission setting. The hook's committed `disabled` configuration is a
separate hard-off switch.

## Local logs

- Hooks: `~/.power-platform-skills/telemetry/power-automate/sessions/`, following
  `POWER_PLATFORM_SKILLS_CONFIG_DIR`. Session directories are pruned after
  14 days and large logs rotated after 10 MB.
- MCP/CLI: `~/.flowagent/telemetry.jsonl`, overridable with
  `FLOWAGENT_TELEMETRY_LOG`. This log has no automatic retention policy.

`telemetry status` reports the hook choice and log location, not the eligibility
of a particular core event. The [telemetry skill](../skills/telemetry/SKILL.md)
also reports the core log path and existence. Users can inspect or delete
either local log.
