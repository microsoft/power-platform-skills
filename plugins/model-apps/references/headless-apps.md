# Headless apps (entity-only app shell)

> Load this file only when the user asks for a **headless** app (they mention "headless",
> "table + sitemap only", "data foundation without UI", or "no forms/views"). It documents the
> `headless` App Spec flag, its lint rules, and the reduced build pipeline.

Set `"headless": true` at the top level of the App Spec to build a **table + sitemap only** app:
no forms, views, charts, dashboards, pages, commands, or web resources are provisioned. The
intended use is as a **foundation** on which MCP servers, bots, code-apps, and AI skills attach
later — scenarios where classic Dataverse UI artifacts are counter-productive.

## When to author `headless: true`

- The user asks for a **data foundation** (tables + navigation) without classic model-driven UI.
- The app will be driven primarily by a **code-app or agent surface** (MCP server, bot, AI skill)
  rather than model-driven forms and views.

Author the flag at the top level alongside `solution` / `app`:

```jsonc
{
  "solution": { "uniqueName": "ContosoDataFoundation", "publisherPrefix": "new" },
  "app":      { "name": "Data Foundation" },
  "headless":  true,
  "entities":  [ /* >= 1 table */ ],
  "appShell":  { "areas": [ /* >= 1 subarea targeting an entity */ ] }
}
```

## Mutual exclusion (lint-enforced)

A headless spec must **not** declare non-empty `forms` / `views` / `charts` / `dashboards` /
`pages` / `commands` / `webResources` sections. Empty arrays are tolerated, so you can flip an
existing spec to headless without deleting those sections. Violations fail lint with a clear
mutual-exclusion message. See `plugins/model-apps/scripts/lib/spec-lint.js` → `lintAppSpec`.

## Minimum viability (lint-enforced)

A headless spec still needs `>= 1` entity **and** at least one `appShell` subarea that targets an
entity — otherwise the built app has an empty sitemap and nothing to navigate to.

## Reduced phase set (builder-enforced)

The builder intersects the requested phases with a headless allow-list — `solution`,
`data-model`, `app-shell`, plus `sample-data` when `--sample-data` and `publish` when
`--publish`. UI phases (`views` / `charts` / `forms` / `commands` / `dashboards` / `pages` /
`web-resources` / `ai-features`) are dropped even if `--only` / `--from` / `--to` would otherwise
admit them. See `plugins/model-apps/scripts/lib/sdk-build.js` → `headlessPhaseAllowlist` for the
pure rule and `build-model-app.js` → `buildModelApp` for the wiring.

## Sample fixture

[`plugins/model-apps/samples/app-spec.headless-task-tracker.json`](../samples/app-spec.headless-task-tracker.json)
— a minimal, lint-clean headless spec (tables + sitemap only).
