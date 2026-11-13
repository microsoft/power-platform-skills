# Add connectors

A step both build orders of `/create-mobile-app` run: [`make-it-real.md`](make-it-real.md) (screens first) and
[`data-model-first.md`](data-model-first.md) (data model first) each read it under their own numbered heading.
Fix it here and both orders get the fix.

Steps it names, by build order:

| Named here | Screens first | Data model first |
|---|---|---|
| this step | Step 13.1 | Step 10 |
| `Step <n>/<total>` in progress lines | 13.1/17 | 10/13 |
| the Apply data model step | Step 12 | Step 8 |
| the screen-building steps | Steps 5-6 | Steps 10.8-11 |
| the architecture gate | architecture gate | Gate 1 |

<!-- The step starts here; everything above is about the file. -->

**Print before starting:**
> "→ [Step <n>/<total>] Adding <N> connectors: <list>. Each runs sequentially (parallel writes would race)."

Read the `## Connectors` section from `native-app-plan.md`. If it says "None", skip this step entirely.

For each row in the table, route to the correct skill based on the API name:

Pass `MOBILE_APP_ORCHESTRATING=1`, `orchestrator: create-mobile-app`,
`phase: implementation`, `working_dir`, and `approved_scope` containing the
connector row and supplied operation/dataset/table/connection choices to each
invocation. A dedicated skill inherits this context when the generic skill routes.

| API name | Invoke |
|---|---|
| `sharepointonline` | `/add-sharepoint --working-dir <working_dir>` |
| anything else | `/add-connector --working-dir <working_dir> --connector <api-name>` |

Run sequentially — each generates files under `src/generated/`. Parallel writes would race.

**Mutation-heavy steps stay sequential.** Dataverse table creation (the Apply data model step), connector adds (this step), and generated-service writes are all sequential by design. The fast path in this skill is **parallel screen generation** (the screen-building steps) plus **fewer prompts** (token cache, auto-proceed) — NOT parallelizing the data-source/service mutations. Do not attempt to parallel-batch `pa app add data-source` or `/add-connector` invocations; they share `src/generated/` and `power.config.json` and will race or corrupt state.

Device capabilities and connectors are both wired, so close the phase:

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' step --id capabilities --status done
```

**Finalise the trust report.** The architecture gate wrote a first pass from the approved plan; everything it
claimed is now decided — which capabilities were actually wired, which connectors were added, and
what the offline profile syncs. Rewrite it in full and mark it `approved`, so it describes what the
app *does* rather than what was intended. `set` merges, so restate every key you want to change.

```bash
node "${PLUGIN_ROOT}/scripts/app-docs.js" --working-dir '<working_dir>' set --section trust --json-file <tmp>/trust.json --state approved
```

`trust.json` has four keys:

- **`permissions[]`** — one entry per OS permission the app could plausibly touch, **including the
  ones it never asks for**. `{ "name", "status", "detail", "activation" }`. A report that lists only
  what was granted answers the easy question; "Microphone — NOT REQUESTED — no audio workflow exists
  anywhere in the app" is the one a reviewer actually needs.

  `status` names **how the permission is acquired**, not merely whether it is. Two apps can end up
  with the same grant and be nothing alike — asking at first launch and asking when the user taps
  Scan are different postures. Use one of:

  | `status` | When the prompt happens | Typical example |
  |---|---|---|
  | `on-demand` | Explicitly requested when the user invokes the feature | Camera, after tapping Scan |
  | `on-startup` | Explicitly requested during launch or onboarding | Notifications at first launch. Technically fine, usually discouraged — prefer `on-demand` |
  | `on-first-access` | The OS prompts automatically the first time the app touches the API | Core Bluetooth initialization on Apple platforms |
  | `per-operation` | Authorized every time, with no lasting grant | Face ID / Touch ID |
  | `incremental` | Narrow access first, broader only when justified | Foreground location now, background later |
  | `system-settings` | No normal dialog exists, so the app sends the user to Settings | Android overlay or all-files access |
  | `system-mediated` | The OS hands over just the selected data, granting nothing broader | The iOS/Android photo picker |
  | `not-requested` | Never asked for at all | Microphone in an app with no audio workflow |

  Anything unrecognised renders as `not-requested`, so a wrong value understates rather than
  overstates access. Prefer the **narrowest accurate** pattern: if the OS picker gives you the one
  file you need, that is `system-mediated` and not a library permission.

  `detail` must say **when** the request happens and **why** — "Requested when the technician starts
  photo capture on a work order", not "Used for photos". `activation` is optional and records the
  separate question of **when the hardware actually runs**: holding a camera grant is not the same
  as the lens being on, and a reviewer needs both.

  **Do not claim the permission is absent from the build.** The binary is produced from a signed
  pre-built base and `/add-native` may not edit `app.config.js`, so the declared permission set is
  the wrapper's and is the same for every generated app. Least privilege here is a **runtime**
  property — which permissions this app ever requests and which hardware it ever activates — not a
  manifest one. Say "no screen requests it", never "the OS cannot prompt for it".
- **`handles[]`** — the record types and identity data the app actually reads or writes.
- **`notCollected[]`** — what it deliberately does not touch. Be specific: name the field classes a
  reader would otherwise have to assume about.
- **`battery[]`** — `{ "name", "detail" }` for each background-cost decision: polling, sensor
  subscriptions, sync intervals, and anything that runs off-screen.

Derive every entry from the approved `native-app-plan.md`, `offline-profile.json`, and the
capabilities you just wired. **Do not claim a boundary you have not checked** — an unverified "no
location access" is worse than omitting the line, because the plan is the artifact a reviewer
trusts. Capabilities the user declined at the architecture gate belong here as `not-requested`.
