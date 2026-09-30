# /pcf create flow

Use this flow for a new PCF control. Microsoft Learn defines PCF controls, manifests and host boundaries at https://learn.microsoft.com/en-us/power-apps/developer/component-framework/overview and https://learn.microsoft.com/en-us/power-apps/developer/component-framework/manifest-schema-reference/.

## 1. Design questions

Ask only what is missing from the request:

1. **Host**: model-driven apps, Power Pages, or both. Power Pages implies a **standard** control because Learn says platform-library React controls are not supported on Power Pages: https://learn.microsoft.com/en-us/power-apps/developer/component-framework/react-controls-platform-libraries#faq.
2. **Control shape**: field, dataset sub-grid/list, or Power Apps grid customizer.
3. **Template family**: standard vs virtual. Derive it from hosts and requirements; do not offer virtual for Pages.
4. **Properties**: name, type, usage, required/default. Check Pages property types and single-field limits against `../../references/pcf-hosts.md`.
5. **Features**: WebAPI, Utility, Device, external service usage. Declare only documented features and guard optional APIs at runtime.
6. **Recipe**: run `node "${PLUGIN_ROOT}/scripts/pcf-scaffold.js" --list`; route to a recipe only when its template and hosts fit. Recipes are designed-for unless the catalog says certified.

## 2. Write `pcf-intent.json`

Read `scripts/lib/pcf-intent.js` as the contract. Minimal valid example:

```json
{
  "schemaVersion": 1,
  "control": {
    "namespace": "Contoso.Controls",
    "name": "StarRating",
    "displayName": "Star rating",
    "description": "A compact whole-number rating field control.",
    "template": "field-standard",
    "recipe": "star-rating"
  },
  "hosts": ["model"],
  "connectivity": "online",
  "properties": [
    { "name": "value", "usage": "bound", "type": "Whole.None", "required": true }
  ],
  "deploy": { "solution": "contoso_pcf", "publisherPrefix": "contoso" },
  "bindings": [
    {
      "kind": "field",
      "table": "account",
      "form": "Main",
      "formType": "main",
      "clients": ["web"],
      "target": { "column": "new_rating" },
      "parameters": { "value": { "column": "new_rating" } }
    }
  ]
}
```

Defaults: binding `clients` means clients that must use this control; omitted means web. FormXML factors are still all three, as described in `bind-flow.md`.

`connectivity` describes the host's connection mode, not whether the control calls the network. This release accepts only `"online"`: offline (mobile offline) hosts are not supported in this release. A control that makes no network calls still uses "online".

## 3. Render and approve the plan

```powershell
node "${PLUGIN_ROOT}/scripts/write-pcf-plan.js" --intent @pcf-intent.json [--manifest ControlManifest.Input.xml] [--out pcf-plan.md]
```

Show the plan. In attended runs use plan mode; in unattended runs log the approval default only when the request supplied enough safe detail. If the intent lint reports a Pages or binding error, fix intent before scaffold.

## 4. Scaffold

```powershell
node "${PLUGIN_ROOT}/scripts/pcf-scaffold.js" --template <id> --namespace <Namespace> --name <ControlName> --out <dir> [--hosts model,pages] [--recipe <id>] [--display-name <text>] [--description <text>] [--install] [--npm-cli <path>]
```

`pcf-intent.json`, `pcf-plan.md` and `workflow-log.md` live in the session working directory. `--out` must be a new, empty subdirectory. Never write those session files into `--out` before scaffold runs — scaffold refuses a non-empty directory. `hooks/validate-write-safety.js` detects a pcf session from `pcf-intent.json` or `pcf-plan.md` at or one level under the cwd; `workflow-log.md` is not a session marker.

Continue only on JSON `ok:true`. If the result includes a `PCF_SCAFFOLD_OUT_REDIRECTED` warning, report `resolvedOutDir` to the user. Do not edit generated lockfiles to chase unrelated versions; versions come from `compatibility-matrix.json` and committed lockfiles.

## 5. Implement

Read `../../references/pcf-best-practices.md`, `../../references/pcf-testing.md`, and the selected recipe's README, if a recipe was selected. Implement through small adapters for network, file picking and navigation. Handle missing parameter objects, `security.readable=false`, `security.editable=false`, permission failures and two instances on one page. Dataset controls also cover loading, empty, error, next/previous page, sort/search/filter and refresh.

Current-record controls must use maker-configured `entityId` and `entityName` inputs. Missing id means an unsaved-record disabled state, never a crash. Do not use internal context or host DOM shortcuts.

## 6. Gates loop

```powershell
node "${PLUGIN_ROOT}/scripts/pcf-gates.js" --project <dir> [--hosts model,pages] [--skip lint,test,build]
```

Fix failures in code, manifest or tests. Never weaken a gate or delete a test to pass. If only a production bundle is needed, use `node "${PLUGIN_ROOT}/scripts/pcf-build.js" --project <dir> [--mode production|development] [--no-clean]`.
