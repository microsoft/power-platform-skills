# Troubleshooting

Deployment, runtime, and environment issues. For generation-time anti-patterns
(things the page-builder must not emit), see `references/rules.md` →
"Common Errors".

---

## User Wants to Create a New Model-Driven App

This plugin creates **pages within existing** model-driven apps — it cannot create a new app. If the user asks to create a new model-driven app:

- Direct them to [Power Apps maker portal](https://make.powerapps.com) to create the app: **New App → Start with Design → Blank page with Navigation**
- Once the app exists, they can use `/genpage` to add pages to it

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

- Verify entity names are logical names (singular, lowercase: `"account"` not `"Account"`)
- Check authentication: `pac auth list`
- Try one entity at a time to isolate the issue
- Ensure the entities exist in your environment
- Check for typos in entity logical names

---

## Page Upload Fails

- Verify app-id: run `pac model list` to get the correct GUID
- Ensure `--name` is provided for new pages
- Check `.tsx` file exists and has no syntax errors
- Verify `--data-sources` matches entities used in code
- Ensure schema was generated for entity-based pages
- If updating, ensure `--page-id` is correct (get from `pac model genpage list`)

---

## Page Not Appearing in App

- Verify `--add-to-sitemap` was used for new pages
- Refresh the browser / clear cache
- Check user permissions in Power Apps
- Verify the app-id is correct for the target app

---

## Generative Page Fails to Render

Dialog: **"Failed to load generative page"**, carrying a Dataverse OData error such as:

> A binary operator with incompatible types was detected. Found operand types 'Edm.Guid' and 'Edm.String' for operator kind 'Equal'.

The page itself deployed correctly — this is a **runtime data** failure, so `pac model genpage list` and the sitemap both still look right. Diagnose from the failing request, never from the dialog:

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

- Generate schema BEFORE uploading: `pac model genpage generate-types --data-sources "entity1" --output-file RuntimeTypes.ts`
- Keep `RuntimeTypes.ts` in the same directory as the `.tsx` file
- Regenerate schema if Dataverse metadata has changed
- If column names don't match, re-run `generate-types` — never guess column names

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
