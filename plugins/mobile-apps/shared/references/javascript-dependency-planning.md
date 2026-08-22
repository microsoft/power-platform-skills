# JavaScript Dependency Planning

Canonical policy for selecting and adding app-scoped JavaScript libraries. Used by `screen-planner`, `/create-mobile-app`, `/edit-app`, and `/debug-app`.

## Boundary

The prebuilt mobile runtime limits packages that ship native code or native configuration. It does not limit pure-JavaScript packages.

A package is native-bound when it or a runtime dependency ships any of these:

- `ios/`, `android/`, `windows/`, or `macos/` platform projects
- `*.podspec`
- `codegenConfig`
- `expo-module.config.json`
- `app.plugin.js`, `app.plugin.ts`, or equivalent Expo config plugin
- `react-native.config.js`

Those packages must already be supported by the template/runtime. A package name is not evidence: a `react-native-*` package may still be pure JavaScript.

## When To Select A Library

Run this workflow when either condition is true:

1. The user explicitly asks to add or use a JavaScript package.
2. An approved feature has an established library that materially reduces parsing, rules, state, rendering, or accessibility risk compared with hand-written code.

First check the app's existing `dependencies` and platform APIs. Reuse a suitable installed dependency. Do not add a package for a trivial helper or a UI that existing React Native, Expo, Tamagui, or standard JavaScript APIs can implement clearly.

## Candidate Selection

For an explicit package request, evaluate that package first. For a use-case-driven request, shortlist at most three packages and choose one. Do not present a package picker unless two candidates have materially different product behavior that the user must decide.

Use read-only metadata and package-file checks; never install during planning:

```bash
npm view "<package>" version deprecated license time.modified engines peerDependencies dependencies scripts repository --json
npm pack "<package>@<exact-version>" --dry-run --ignore-scripts --json
```

Evaluate candidates in this order:

1. **Compatibility** - supports the project's React, React Native, Expo, and Node versions; does not require an absent peer dependency.
2. **JavaScript-only** - published files and runtime dependencies have no native markers from the Boundary section.
3. **Safety** - not deprecated; no `preinstall`, `install`, or `postinstall` lifecycle script for an automatically selected runtime package; identifiable license and repository.
4. **Maintenance** - maintained stable release, bundled TypeScript declarations or trustworthy types, and no abandoned replacement warning.
5. **Fit** - smallest focused API that handles the approved use case without duplicating an installed package.

If no candidate passes, use existing primitives when that still meets the requirement. Otherwise return `NEEDS_CONTEXT` or `BLOCKED` with the failed compatibility/native criterion; never install first and hope it works.

## Plan Contract

In `## Screens`, emit `### JavaScript Dependencies` before per-screen specs. Use `None.` when no library is needed. Every selected runtime package uses this table:

| Package | Exact version | Used by | Why selected | JS-only evidence | Native rebuild |
|---|---|---|---|---|---|
| `<package>` | `<x.y.z>` | `<screens/use case>` | `<fit over existing APIs and alternatives>` | `<metadata/file-list evidence>` | `No - pure JavaScript` |

The exact version and rationale are part of the screen-plan approval. Approval authorizes the orchestrator to add that package; it does not authorize different packages or version ranges.

### Calendar example

A full month/week/agenda scheduling surface triggers candidate selection. Evaluate `react-native-calendars` first because it supplies established calendar and agenda primitives and is pure JavaScript; `1.1314.0` is the known-good version for the current template baseline. Confirm current metadata and compatibility before writing the row. A lightweight horizontal date strip plus `FlatList` does not require a new package.

### Chart example

For an approved `sparkline` or `series-chart`, use `d3-scale@4.0.2` with
`@types/d3-scale@4.0.9`. `d3-scale` supplies maintained numeric/time/band scales
while React Native Views render the geometry; this deliberately avoids chart
packages that transitively require absent native `react-native-svg`, Skia,
Canvas, WebView, or platform projects.

Verified package evidence:

- `d3-scale@4.0.2`: ISC, Node >=12, no peers, no install lifecycle hook, and
	published files are JS source/dist only; dependencies are the JS-only D3
	array/format/interpolate/time modules.
- `@types/d3-scale@4.0.9`: MIT declaration-only package, no native artifacts or
	lifecycle hooks; supplies `index.d.ts` for strict generated TypeScript.

Emit both exact rows in `### JavaScript Dependencies`. Do not substitute a
full chart library without rerunning the native-boundary and compatibility
checks.

## Installation Contract

Only `/create-mobile-app` or `/edit-app` installs approved rows, before screen builders run:

```bash
npm install --save-exact <package>@<exact-version>
```

Then verify:

- `package.json` records the exact version in `dependencies`
- the lockfile is updated when the project uses one
- `require.resolve('<package>', { paths: [process.cwd()] })` succeeds
- the changed-file dependency validator passes with one exact approval argument for every row currently in `### JavaScript Dependencies`:

	```bash
	node "${PLUGIN_ROOT}/scripts/validate-mobile-files.js" \
		--project-root "<working_dir>" \
		--file package.json \
		--approved-js-dependency "<package>@<exact-version>" \
		[--approved-js-dependency "<another-package>@<exact-version>" ...]
	```

	The approval arguments are deterministic exceptions for package names that the baseline conservatively classifies as native-like. They do not classify package contents and cannot override packages known to require native runtime support.
- `npx tsc --noEmit` passes after the consuming code is built

If installed contents reveal native code/config or an incompatible runtime dependency, remove only the newly added package, report the block, and do not let builders import it. Pure-JavaScript additions do not need `/add-native`, `app.config.js`, CocoaPods, Gradle, a native rebuild, or a rewrap-base update.

## Builder Contract

Builders may directly import only packages listed in the approved table and present at the exact version in `package.json`. Builders never select packages, edit manifests, or run installs. A missing approved package is an orchestrator block; an unplanned package is a planning-context error.
