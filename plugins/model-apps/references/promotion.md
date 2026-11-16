# Promoting generative pages to another environment

Read this only when the user asks to promote, move, ship or deploy generative pages from one
environment to another (development to test, test to production, or to another development
environment). It is guidance for a repeatable promotion. The skill does not export a solution for
you; it packages the pages (Phase 6.7), writes the deployment settings file and can import a package
you exported (`solution-settings.js`). Every platform rule below links the Microsoft Learn page that
states it.

## 1. Package the pages first

Promotion moves a **solution**, so the pages must be in one. Run Phase 6.7 (`provision-solution.js`,
then `add-page-to-solution.js`), or add the pages to the solution in Power Apps. Add every page
explicitly by its page id: adding the app brings its site map, and a page joins the solution reliably
only when it is added itself. Adding a page brings its file rows (`page.tsx`, `config.json`).

- Generative pages are solution-aware and move between environments in a solution.
  [Adding generative pages to solutions](https://learn.microsoft.com/power-apps/maker/model-driven-apps/generative-pages#adding-generative-pages-to-solutions)
- Publish before you export. An unmanaged export holds only published components, so a page or a
  navigation change saved as a draft (`--draft`) and not published does not travel.
  [Export solutions](https://learn.microsoft.com/power-apps/maker/data-platform/export-solutions)

## 2. Managed or unmanaged

| Target | Export as | Why |
| --- | --- | --- |
| Test, UAT, production | **Managed** | Managed solutions are deployed; unmanaged ones are developed. A managed solution is a build artifact you import: it cannot be edited in the target directly. A component it brings can still be customized there when its managed properties allow it, which adds an unmanaged layer on top. |
| Another development environment | **Unmanaged** | The receiving maker keeps editing the pages. |
| Source control | **Unmanaged** | Unmanaged exports are the source to keep in source control. |

- You cannot import a managed solution into the environment that holds the unmanaged solution it
  came from: test a managed solution in a separate environment.
- An unmanaged import overwrites the existing customizations of every component it holds, and you
  cannot undo it. Deleting an unmanaged solution removes only its container, not its components.
  [Solution concepts](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm#managed-and-unmanaged-solutions),
  [Import solutions](https://learn.microsoft.com/power-apps/maker/data-platform/import-update-export-solutions)

## 3. Full solution or patch

Promote the **full solution** with a higher version number by default. Use a patch only when the
team already ships patches for this solution.

| | Full solution (update or upgrade) | Patch |
| --- | --- | --- |
| Holds | Every component of the solution | Only what changed since the parent |
| Can remove a component | Yes (an **upgrade** deletes components the new version no longer has) | No: a patch adds and updates only |
| Needs in the target | Nothing (first import) or an earlier version | The parent solution, same managed or unmanaged type |
| Version | Higher than the installed one in any position | Same major and minor as the parent, higher build or revision, and higher than every earlier patch |
| Side effect in development | None | The parent is locked: it cannot be changed or exported while it has patches |

A patch is created from an unmanaged parent with **Clone a patch**; it cannot be a patch of a patch.
Do not import unmanaged patches into production. Learn does not recommend **Clone a patch** and
**Clone solution** for updating a solution: they limit team development and make source control harder.
[Create patches](https://learn.microsoft.com/power-platform/alm/create-patches-simplify-solution-updates),
[Create and update solutions](https://learn.microsoft.com/power-platform/alm/update-solutions-alm)

## 4. Version number

A version is `major.minor.build.revision`. Each promotion of the same solution needs a higher
version than the one installed in the target (for example `1.0.3.0` after `1.0.2.0`). The Power Apps
export dialog proposes the next version and lets you type another. Record the version in
`workflow-log.md` and in your release notes, so a later rollback can name it.
[Update a solution: version numbers](https://learn.microsoft.com/power-apps/maker/data-platform/update-solutions#understanding-version-numbers-for-updates),
[Export solutions](https://learn.microsoft.com/power-apps/maker/data-platform/export-solutions)

## 5. Dependency check

The platform fails an import when the solution needs a component that it does not hold and the
target does not have, and warns at export about missing required components.
[Dependency tracking](https://learn.microsoft.com/power-platform/alm/dependency-tracking-solution-components)
A page names its tables in its code and its `config.json`, so check these yourself before you
export. Do not rely on the export warning alone. Read only; run each check against the **target**
environment:

| A page needs | Where the page names it | Check in the target |
| --- | --- | --- |
| Tables | `config.json` `dataSources` | `node "${PLUGIN_ROOT}/scripts/list-tables.js" --env '<target-envUrl>' --search '<table1,table2>' --exact`: `missing` must be empty, or the tables must be in the solution (or in a solution imported first). |
| Columns and choices | `RuntimeTypes.ts` | `node "${PLUGIN_ROOT}/scripts/genpage.js" types --env '<target-envUrl>' --data-sources '<table1,table2>' --output-file '<working-dir>/RuntimeTypes.target.ts'`, then compare it with the page's `RuntimeTypes.ts`. A column the page uses and the target lacks must travel in the solution. |
| Connector bindings | `config.json` `connectorBindings` | Each connection reference is in the solution (Phase 6.7 `--connection-refs`), and the deployer has a connection for it in the target (step 7). |
| Custom APIs | `config.json` `actionBindings` | `node "${PLUGIN_ROOT}/scripts/list-custom-apis.js" '<target-envUrl>' --entities '<table1,table2>'` lists them. A Custom API is deployed on its own, before the pages; it is not added by Phase 6.7. |
| Built-in operations (`WhoAmI`, `RetrieveVersion`) | `config.json` | Nothing: the platform defines them. |

Report each gap to the user with the page and the component, and stop the promotion until the gap is
closed. Log the commands and their results in `workflow-log.md`.

## 6. Import order

1. Solutions the pages depend on (tables, Custom APIs, other base solutions), oldest first.
2. The solution that holds the app and the pages.
3. Its patches, if any, in version order. A patch needs its parent installed.

An import that needs a solution that is not there yet fails with a missing dependency: install the
dependency, then import again.
[Import solutions](https://learn.microsoft.com/power-apps/maker/data-platform/import-update-export-solutions),
[Create patches](https://learn.microsoft.com/power-platform/alm/create-patches-simplify-solution-updates)

## 7. Connections and the import

A connection reference needs a connection in the target. Supply the connection ids in a deployment
settings file so the import does not stop to ask:
[Connection references and environment variables in pipelines](https://learn.microsoft.com/power-platform/alm/conn-ref-env-variables-build-tools)

```powershell
node "${PLUGIN_ROOT}/scripts/solution-settings.js" template --env '<source-envUrl>' --solution '<solutionUniqueName>' --out '<settings.json>'
node "${PLUGIN_ROOT}/scripts/solution-settings.js" import --env '<target-envUrl>' --package '<solution.zip>' --settings '<settings.json>'
```

The deployer fills in each `ConnectionId` between the two commands. Phase 6.7's cross-environment
note describes both commands and how the import treats a refusal. A managed import arrives
published; an unmanaged import arrives as a draft and must be published.
[Import solutions](https://learn.microsoft.com/power-apps/maker/data-platform/import-update-export-solutions)

For an update of a managed solution, Power Apps offers three actions: **Upgrade** (the default:
deletes components the new version no longer holds), **Stage for upgrade** (installs the new version
beside the old one until you apply the upgrade) and **Update** (replaces the solution and deletes
nothing).
[Update a solution](https://learn.microsoft.com/power-apps/maker/data-platform/update-solutions)

## 8. Rollback

Plan the rollback before the import:

- **Keep the previous release.** Keep each exported package and its version, and keep the pages in
  source control (see "Pulling existing pages into the project" in the skill). The target holds only
  the version you imported.
- **Roll forward.** To go back, rebuild the earlier release in development (put the earlier
  `page.tsx` back and upload it), export it with a **higher** version number, and import it as an
  update. This restores the code without removing what the solution installed; it does not bring back
  data an earlier upgrade or migration deleted (an upgrade deletes the components the new version no
  longer holds, with their data).
- **Stage for upgrade** keeps the old version installed until you apply the upgrade, so you can check
  the new version first.
  [Update a solution](https://learn.microsoft.com/power-apps/maker/data-platform/update-solutions)
- **Deleting a managed solution** removes everything it installed, including the data in the custom
  tables and custom columns it brought. Do not delete one as a rollback unless the user accepts that
  data loss.
  [Solution concepts](https://learn.microsoft.com/power-platform/alm/solution-concepts-alm#managed-and-unmanaged-solutions)
- **Back up the target before an import that cannot be undone:** any unmanaged import, and any
  upgrade that removes components (and so their data). Restoring a backup is the only way to get
  deleted data back.
  [Import solutions](https://learn.microsoft.com/power-apps/maker/data-platform/import-update-export-solutions)

## 9. What travels with a page, and what does not

| Travels with the page | Does not travel |
| --- | --- |
| The published page code (`page.tsx`) and `config.json`: model, data sources, connector bindings, Custom API bindings | The full authoring conversation: in the target, the designer shows only the first prompt and the published code |
| The page's id, so a later import updates the same page | Earlier versions of the page: the page holds its current code only. Keep earlier versions in source control |
| The app's navigation entry, when the app and its site map are in the solution | A draft that was saved and not published |
| | The tables, columns and Custom APIs the page uses, unless they are in the solution (step 5) |
| | Connections: the target supplies its own through the connection references (step 7) |
| | The data in the tables |

The conversation rule is stated in
[Adding generative pages to solutions](https://learn.microsoft.com/power-apps/maker/model-driven-apps/generative-pages#adding-generative-pages-to-solutions).
For a review, compare the page code in source control, not the authoring conversation.

## 10. Record the promotion

Append a `## Promotion` section to `workflow-log.md`: the source and target environments as
`<source-envUrl>` and `<target-envUrl>` placeholders when the log is shared, the solution, the
version, managed or unmanaged, full or patch, every dependency check command and its result, the
import result, and the rollback plan.
