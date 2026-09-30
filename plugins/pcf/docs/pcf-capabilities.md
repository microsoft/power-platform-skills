# pcf — capabilities

What the `/pcf:pcf` skill can do today, and how far each capability has been proven. The skill workflow is [`../skills/pcf/SKILL.md`](../skills/pcf/SKILL.md); the public design record is [`pcf-design.md`](pcf-design.md); host policy is in [`../references/pcf-hosts.md`](../references/pcf-hosts.md).

This file records **shipped** behaviour only. Planned and unbuilt work is tracked in GitHub issues — the pcf backlog is [#656](https://github.com/microsoft/power-platform-skills/issues/656). A roadmap committed alongside the code goes stale silently and states intent the code does not yet support, so the two are kept apart deliberately.

**Evidence legend**
- ✅ **verified live** — exercised end to end on a real Dataverse environment, then cleaned up.
- 🧪 **tested** — automated coverage (unit, real-bundle, generated-project CI or evals), not exercised live.
- 📋 **guided** — the skill guides the user through it, and the plugin neither automates nor verifies it.

### Toolchain doctor and compatibility matrix — 🧪 tested
- `pcf-doctor.js` checks Node.js, npm, PAC CLI, .NET, project layout, dependency drift and host compatibility from `compatibility-matrix.json`.
- The compatibility matrix is covered by unit tests and the weekly matrix drift workflow.

### Templates — 🧪 tested
- Four scaffold templates ship: `field-standard`, `dataset-standard`, `field-virtual`, and `dataset-virtual`.
- Generated-project CI builds the templates on Ubuntu and Windows and runs a managed-package smoke.

### Recipes — 🧪 tested, with partial live evidence
- Six available recipes ship with generated-project CI coverage:
  - `star-rating` — designed for model-driven apps and Power Pages; registered, bound on a form, verified draft and published, with where-used evidence. ✅
  - `lookup-dropdown` — designed for model-driven apps; registered, bound, verified, and where-used evidence collected. ✅
  - `hierarchy-tree` — designed for model-driven apps; registered. ✅
  - `contextual-grid` — designed for model-driven apps. 🧪
  - `grid-customizer` — designed for model-driven apps. 🧪
  - `attachment-uploader` — designed for model-driven apps. 🧪
- No recipe is runtime-certified in this release.

### Intent, plan and scaffold — 🧪 tested
- `pcf-intent.json` validation, `pcf-plan.md` rendering and scaffolding are covered by unit tests and offline evals.
- Scaffolds are matrix-pinned and include the package scripts that PAC expects during `pac pcf push`.

### Quality gates — 🧪 tested
- `pcf-gates.js` runs manifest and host lint, breaking-change diff checks, source gates, ESLint, unit tests, production build, bundle-size checks and unexpected-output checks.
- Host-specific policy covers model-driven apps and Power Pages guidance.

### Doctor and upgrade — 🧪 tested
- Doctor reports local toolchain and project-health findings.
- Upgrade plans bounded repairs for dependency alignment, production build-mode placement and platform-library declaration alignment.

### Deploy — ✅ verified live
- `pcf-push.js` wraps `pac pcf push --environment` after the skill records consent.
- The production bundle registered in Dataverse matched the local build hash, and the SQL 1205 publish-deadlock hint exists.
- Deploy publishes all customizations as part of the PAC operation.

### Binding verification — mixed evidence
- Field bindings are ✅ verified live for cell placement, control id, web/phone/tablet form factors, parameters, draft FormXML and published FormXML.
- Dataset/sub-grid and grid-customizer binding are 📋 guided and reported as `configuration-not-verified`.

### Inventory and where-used — ✅ verified live
- `pcf-inventory.js` lists registered controls and registered where-used dependencies.
- Where-used covers registered solution dependencies only. It is not proof of Liquid references, arbitrary text references or safe deletion.

### Power Pages — 🧪 tested and 📋 guided
- The pre-deploy compatibility gate is 🧪 tested.
- Site configuration is 📋 guided.
- No live Power Pages run has been completed in this release.

### Unattended mode — 🧪 tested
- `resolve-interaction-mode.js` supports unattended runs by suppressing prompts only where a safe default exists.
- Suppressing a prompt never authorizes an environment write.

### Not covered in this release
- **Canvas apps** — a pushed control is registered for the whole environment, but the skill's host checks accept only `model` and `pages`, so it neither checks canvas limits nor guides canvas setup.
- **Mobile and offline** — not checked, guided or verified.
- **Registration without PAC** — registration uses `pac pcf push` in this release.

### Known limitations
- Deploy publishes all customizations.
- A push takes minutes.
- Binding is done in the Maker form designer.
- Where-used is registered dependencies only.
- No recipe is runtime-certified.
