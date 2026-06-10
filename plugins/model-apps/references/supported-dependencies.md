# Supported Dependencies

The list of npm packages the genux runtime supports for generated pages.

**Scope:** Versions here are used by `scripts/generate-page-manifest.js` to
populate the `package.json` written into each working dir during Phase 0.5.
This makes the working dir installable (`npm install`) so VSCode IntelliSense,
type-checking, and "go to definition" work after generation.

**Source of truth:** This doc tracks
`scripts/lib/supported-dependencies.js`. When the upstream genux runtime team
publishes an authoritative version list, update that file — this doc and the
generator both read from there.

## Confidence levels

| Confidence | Meaning |
|------------|---------|
| `pinned` | Locked to a specific version by a definitive source (regenerate-verified-icons.js for `@fluentui/react-icons@2.0.326`, the genux runtime for React 17). |
| `compatible` | Reasonable default that works with the genux runtime today but may not be the exact patch version the runtime ships. Editor/type-check accuracy is high; runtime behavior may differ in rare cases. |

## Runtime dependencies

| Package | Version | Confidence | Notes |
|---------|---------|------------|-------|
| `react` | `17.0.2` | pinned | Genux runtime is React 17. |
| `react-dom` | `17.0.2` | pinned | Pairs with `react@17.0.2`. |
| `@fluentui/react-components` | `^9.54.0` | compatible | Fluent UI V9 — APIs used by samples stable since 9.40. |
| `@fluentui/react-icons` | `2.0.326` | pinned | Pinned by `scripts/regenerate-verified-icons.js` to keep `references/verified-icons.txt` in sync. |
| `@fluentui/react-datepicker-compat` | `^0.4.50` | compatible | V9 compat — used only when the page has a DatePicker. |
| `@fluentui/react-timepicker-compat` | `^0.2.40` | compatible | V9 compat — used only when the page has a TimePicker. |
| `d3` | `^7.8.5` | compatible | D3 v7+ required for `d3.group()`. Used only by chart-bearing pages. |

## Dev dependencies

| Package | Version | Confidence | Notes |
|---------|---------|------------|-------|
| `typescript` | `^5.4.0` | compatible | Any TS 5.x works for editor support. |
| `@types/react` | `^17.0.80` | compatible | |
| `@types/react-dom` | `^17.0.25` | compatible | |
| `@types/d3` | `^7.4.3` | compatible | Include only when the page uses D3. |

## Features

The generator includes feature-specific deps only when the page uses them.

| Feature flag | Adds (runtime) | Adds (dev) |
|--------------|----------------|------------|
| `charts`     | `d3` | `@types/d3` |
| `datepicker` | `@fluentui/react-datepicker-compat` | — |
| `timepicker` | `@fluentui/react-timepicker-compat` | — |

Pass features to the generator:

```bash
node scripts/generate-page-manifest.js <working-dir> <page-slug> --features charts,datepicker
```

The generator passes the list through `buildDependencyMap()` /
`buildDevDependencyMap()` in `scripts/lib/supported-dependencies.js`.

## Updating versions

When upstream confirms versions or a runtime upgrade lands:

1. Edit `scripts/lib/supported-dependencies.js` — change the `version` field and (if applicable) flip `confidence` from `compatible` to `pinned`.
2. Re-run `node --test plugins/model-apps/scripts/tests/generate-page-manifest.test.js` — the tests assert the generated manifest's dependency map, feature-flag handling, and `--force` behavior.
3. Update this doc to reflect the new versions (the table is hand-maintained from the JS module — a small sync script could automate it later).
4. Bump the plugin minor or patch version in `.claude-plugin/plugin.json`.
5. CHANGELOG entry under the appropriate version section.
