# Apply native capabilities

A step both build orders of `/create-mobile-app` run: [`make-it-real.md`](make-it-real.md) (screens first) and
[`data-model-first.md`](data-model-first.md) (data model first) each read it under their own numbered heading.
Fix it here and both orders get the fix.

Steps it names, by build order:

| Named here | Screens first | Data model first |
|---|---|---|
| this step | Step 13 | Step 9 |
| `Step <n>/<total>` in progress lines | 13/17 | 9/13 |
| Add connectors, the Add connectors step | Step 13.1 | Step 10 |

<!-- The step starts here; everything above is about the file. -->

Open the capabilities phase; the Add connectors step closes it:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id capabilities --status active
```

**Print before starting:**
> "→ [Step <n>/<total>] Wiring <N> native capabilities: <list>. Each runs sequentially."

Read the `## Native Capabilities` section from `native-app-plan.md`. For each capability, invoke `/add-native` — it routes to nested helpers for camera/PDF/pen controls when needed, otherwise generates a generic wrapper:

```
Invoke skill: /add-native

Context:
  MOBILE_APP_ORCHESTRATING=1
  orchestrator: create-mobile-app
  working_dir: <working_dir>
  phase: implementation
  approved_scope: <approved capability row, storage target, and screen requirements>

Arguments:
  --working-dir <working_dir>
  --capability <name>
```

Run sequentially. Each writes a single file under `src/native/` and does not touch `package.json` or `app.config.js`, so they could in principle run in parallel — but sequential keeps the orchestration log readable.

If the plan says "None — this app uses only standard React Native components and Power Platform connectors", skip only the native-capability invocation above and continue with the next step.
In the data-model-first order that is Step 9a: do NOT skip Step 9a or Step 9b; an app can need a pure-JavaScript library without any native capability, and Tamagui aliases/brand tokens are always required.
In the screens-first order it is Add connectors.
