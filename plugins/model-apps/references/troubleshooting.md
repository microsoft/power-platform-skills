# Troubleshooting

Common issues when building and deploying generative pages.

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
- Verify: `pac help` (version must be >= 2.3.1)

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

## RuntimeTypes Issues

- Generate schema BEFORE uploading: `pac model genpage generate-types --data-sources "entity1" --output-file RuntimeTypes.ts`
- Keep `RuntimeTypes.ts` in the same directory as the `.tsx` file
- Regenerate schema if Dataverse metadata has changed
- If column names don't match, re-run `generate-types` — never guess column names

---

## Playwright Browser Verification Issues

- "Target page, context or browser has been closed" → retry the navigation; Playwright sessions can expire
- "Ref not found" → take a fresh `browser_snapshot` before clicking any element; stale refs are invalid
- Sign-in page appears → Playwright uses the system browser session; user must sign in manually first
- Page renders blank → wait longer with `browser_wait_for`; genux pages can take several seconds to render
- Browser not found → `launch-playwright-mcp.js` detects Edge/Chrome automatically; ensure one is installed
