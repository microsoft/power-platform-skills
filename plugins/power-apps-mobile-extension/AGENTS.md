# Power Apps Mobile Plugin Guidelines

## Scope

This directory is the complete, self-contained `power-apps-mobile-extension` plugin. In the public
`microsoft/power-platform-skills` repository, copy it to `plugins/power-apps-mobile-extension/`.

The plugin builds third-party Power Apps Mobile controls into native-only `.ppmplugin` bundles and
generates the companion dispatcher PCF. It must use only files in the control's working tree and
publicly available tools and package registries.

## Authoritative references

- `shared/shared-instructions.md` owns cross-skill behavior, constants, safety rules, and status
  semantics.
- `shared/prereq-check.md` owns prerequisite versions, per-skill checks, and auto-fix policy.
- `shared/ppmplugin-format.md` owns the bundle schema, runtime dispatch contract, validation rules,
  and platform build requirements.
- `shared/repo-layout.md` owns the generated control repository structure.
- `shared/naming-conventions.md` owns identifier derivation and reserved-name guidance.
- `shared/error-codes.md` owns stable native and transport error codes.
- `shared/telemetry.md` owns skill-usage telemetry behavior, controls, fields and release gates.
- `shared/framework-recommendations.md` owns native implementation recommendations.
- `shared/self-critique-protocol.md` owns quality gates used by code-writing skills.

Reference these files instead of duplicating their rules in skills or README sections. When a
summary is necessary, keep it synchronized with the owning reference.

## Public repository requirements

- Do not add internal hosts, repository names, source paths, documents, environment identifiers,
  tenant identifiers, or organization-specific authentication instructions.
- Keep `.plugin/plugin.json` and `.claude-plugin/plugin.json` byte-for-byte equivalent.
- Keep all skill links inside this plugin directory so marketplace installs remain portable.
- Use placeholders such as `<env-url>`, `<publisher-prefix>`, and `contoso` in examples.
- Keep skill frontmatter descriptions below the GitHub Copilot 1,024-character limit.

When adding the plugin to the public repository, also register
`./plugins/power-apps-mobile-extension` in both root marketplace manifests and add it to the root README. Those
repository-level registrations intentionally remain outside this self-contained plugin payload.

## Telemetry implementation

- Telemetry is enabled in `scripts/lib/telemetry/ikey.json` by explicit maintainer
  approval. Change the release switch only with explicit approval; preserve its
  hard-off behavior. Tests must use isolated fixtures, not alter the release switch
  or send live telemetry. The `telemetry on` command changes only a user preference.
- Use the strict PAM schema before both local logging and network serialization.
  Do not add fields or relax the `eventInfo.aadObjectId`-only rule implicitly.
- Only hook-derived starts are recorded. Do not instrument generated controls or
  add telemetry commands to individual authoring skills. Telemetry is non-blocking.
- Run `node --test plugins/power-apps-mobile-extension/scripts/tests/telemetry.test.js`
  from the repository root and the metadata checks listed in `shared/telemetry.md`.
  Set `POWER_PLATFORM_SKILLS_TELEMETRY_POWER_APPS_MOBILE_EXTENSION_OPTOUT=1`
  for automation. Keep the bundled library identical to `shared/telemetry/lib/`.
- Preserve the fixed wire `clientType` and `pluginName` in `customDimensions` for
  shared-stream attribution. Instrumentation keys must remain unique across plugins.
- Live collector tests and backend routing updates are separate actions. Do not
  run live probes as routine validation.
