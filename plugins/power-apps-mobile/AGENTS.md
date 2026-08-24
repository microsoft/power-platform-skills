# Power Apps Mobile Plugin Guidelines

## Scope

This directory is the complete, self-contained `power-apps-mobile` plugin. In the public
`microsoft/power-platform-skills` repository, copy it to `plugins/power-apps-mobile/`.

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
`./plugins/power-apps-mobile` in both root marketplace manifests and add it to the root README. Those
repository-level registrations intentionally remain outside this self-contained plugin payload.
