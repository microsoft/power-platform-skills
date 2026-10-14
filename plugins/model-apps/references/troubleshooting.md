# Troubleshooting

Deployment, runtime, and environment issues. For generation-time anti-patterns
(things the page-builder must not emit), see `references/rules.md` →
"Common Errors".

---

## User Wants to Create a New Model-Driven App

Both skills can create one:

- `/genpage` creates an app to host its pages when the plan chooses a new app: it deploys the first page, then creates the app from it with `scripts/apps.js create` (Phase 6), and adds the other pages to it.
- `/app-builder` builds a whole app from a description: tables, forms, views, the app and its sitemap.
- An app created in the [Power Apps maker portal](https://make.powerapps.com) (**New App → Start with Design → Blank page with Navigation**) works too; `/genpage` can then add pages to it.

---

## PAC CLI Not Found or Outdated

- Install: `dotnet tool install --global Microsoft.PowerApps.CLI.Tool`
- Update: `dotnet tool update --global Microsoft.PowerApps.CLI.Tool`
- Or download from the [Microsoft Power Platform CLI](https://learn.microsoft.com/en-us/power-platform/developer/cli/introduction) page
- Verify: `pac help` (version must be > 2.10.0)

---

## Authentication Fails

- Run `pac auth create --environment <url>` and complete browser sign-in
- Verify with `pac auth list` — look for `*` on the active profile
- Check network connectivity to the Dataverse environment
- If token expired, run `pac auth create` again to refresh

---

## Schema Generation Fails

`node "${PLUGIN_ROOT}/scripts/genpage.js" types …` prints `{ "ok": false, "error", "code" }` and exits 1 when it cannot write the schema — read `error` first.

- Verify entity names are logical names (singular, lowercase: `"account"` not `"Account"`)
- A table the environment does not have is the SDK's own 404 — ensure the entities exist in your environment and check for typos in entity logical names
- The type generator signs in with the Azure CLI, like every page operation: `az` missing, signed out, too slow, or signed in to another tenant than the `pac` profile fails with a connection error — run `node "${PLUGIN_ROOT}/scripts/check-auth.js" --require-pac` to see which
- Try one entity at a time to isolate the issue
- The output file's name is checked before the environment is asked: a link, or a folder, at that name is refused

---

## Page Upload Fails

- Verify app-id: run `node "${PLUGIN_ROOT}/scripts/apps.js" list --env '<envUrl>'` and take the app's `id`
- Ensure the page's display name is provided for new pages — written to a file and passed with `--name-file`, so a shell never reads it
- A page display name is stored exactly as written, a straight double quote (`"`) included: nothing is refused or escaped. (A page an earlier release created through `pac` holds each `"` as `\"` until its name is rewritten.)
- An update that names no `--name-file`, `--model` or `--data-sources` keeps the page's own name, model and data sources; it never resets one to empty
- A failed upload exits 1 and prints what it knows: `error`, the page's `pageId` once the write got as far as the send, `outcome` and the SDK's `code`. `"outcome": "nothing"` means nothing was written — fix what the message names and run it again. `"outcome": "unknown"` means the answer was lost and the write may have landed: do not send it again blindly — an update is compared with the file first (`genpage-base.js check`), a create is looked for by its `pageId` first
- Every page operation signs in with the Azure CLI. `az` missing, signed out, too slow, or signed in to another tenant than the `pac` profile fails the upload with a connection error — run `node "${PLUGIN_ROOT}/scripts/check-auth.js" --require-pac` to see which
- `--prompt-file …/prompt.txt is a symbolic link or junction, not a file written in place` (or `is a hard link`,
  for any input file): something other than the skill left a link at that name, and writing it may have changed
  the file it points to. Check that file, delete the link, and re-run; the skill then writes a plain file there
- Check `.tsx` file exists and has no syntax errors (a page that does not compile is refused before anything is written)
- Verify `--data-sources` matches entities used in code
- Ensure schema was generated for entity-based pages
- If updating, ensure `--page-id` is correct (get it from `node "${PLUGIN_ROOT}/scripts/genpage.js" list --env '<envUrl>' --app-id '<app-id>'`)

---

## Page Not Appearing in App

- Verify the page was placed: `--add-to-sitemap` on its upload into an existing app, or its id in `--page-id` of `apps.js create` for a new app
- Check `apps.js list`: an app with `published: false` was never published, and `unpublishedChanges: true` means saved edits are waiting for a publish — users see the published layer
- Refresh the browser / clear cache
- Check user permissions in Power Apps
- Verify the app-id is correct for the target app

---

## Generative Page Fails to Render

Dialog: **"Failed to load generative page"**, carrying a Dataverse OData error such as:

> A binary operator with incompatible types was detected. Found operand types 'Edm.Guid' and 'Edm.String' for operator kind 'Equal'.

The page itself deployed correctly — this is a **runtime data** failure, so `genpage.js list` and the sitemap both still look right. Diagnose from the failing request, never from the dialog:

- **Capture the query first**: F12 → Network → filter `api/data` → find the 4xx response. Copy its `$filter` (or the request body for an `Execute`/action call). That one string decides which cause below applies; the dialog alone cannot distinguish them.

**Cause 1 — a GUID compared as a string.** Dataverse types record ids as `Edm.Guid`, and OData v4 GUID literals are **unquoted**. `accountid eq '<guid>'` raises the error above; `accountid eq <guid>` succeeds.

- Prefer `dataApi.retrieveRecord({ id })` over a hand-built `$filter` — it types the id for you (see `samples/10-detail-with-pageinput.tsx`)
- The same applies to lookup columns (`_ownerid_value`), which are also `Edm.Guid`

**Cause 2 — a Custom API parameter whose declared kind is missing or wrong.** The host stamps the OData type from the *declared* kind, so an undeclared or mistyped parameter is serialized untyped and fails the same way.

- Declare every parameter in `parameterKinds` (see `references/custom-api.md`)
- Pass a plain GUID-formatted string for a `Guid` kind — the platform wraps it into its typed form; do **not** wrap it yourself

**Cause 3 — a GUID carrying braces.** Some Dataverse surfaces return `{xxxxxxxx-xxxx-…}`. Strip the braces before using the value in a filter or as a parameter.

If the failing request comes from the page-**load** path rather than from code in the `.tsx`, this is a platform issue: capture the request and report it rather than editing the page.

See: <https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query-data-web-api>

---

## RuntimeTypes Issues

- Generate schema BEFORE uploading: `node "${PLUGIN_ROOT}/scripts/genpage.js" types --env '<envUrl>' --data-sources 'entity1' --output-file '<working-dir>/RuntimeTypes.ts'`
- Keep `RuntimeTypes.ts` in the same directory as the `.tsx` file
- Regenerate schema if Dataverse metadata has changed
- If column names don't match, re-run `genpage.js types` — never guess column names

---

## Modal Dialog Covers the Designer / Blocks the Coding Agent

**Symptom:** a generated page opens a dialog that overlays the whole designer — the
backdrop covers the coding-agent panel on the left, and the user can't dismiss it or
interact with the agent. Often reported as "a modal keeps appearing regardless of my
actions."

**Cause:** a Fluent `<Dialog>` with the default `modalType="modal"` and **no
`mountNode`**. The preview shares the DOM with the designer (it is not a sandboxed
iframe), so the dialog's portal + `position: fixed` backdrop mount to the designer's
`document.body` and cover the entire tool.

**Fix:** regenerate per `rules.md` → **Special Patterns > Dialogs and Overlays** (thread
`mountNode` to every overlay, make the root a `contain: layout` containing block, default
dialogs to `modalType="non-modal"`, no `100vh`/`100vw`, never nest `<Dialog>`s).

---

## Playwright Browser Verification Issues

- "Target page, context or browser has been closed" → retry the navigation; Playwright sessions can expire
- "Ref not found" → take a fresh `browser_snapshot` before clicking any element; stale refs are invalid
- Sign-in page appears → Playwright uses the system browser session; user must sign in manually first
- Page renders blank → wait longer with `browser_wait_for`; genux pages can take several seconds to render
- Browser not found → `launch-playwright-mcp.js` detects Edge/Chrome automatically; ensure one is installed
