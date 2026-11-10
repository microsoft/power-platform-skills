# Remote sites

Read this for each site the user gave as a website URL or a website record ID.

## Verify the website

- Check `pac --version` and `pac auth list`.
  Reuse an authenticated profile for the environment; otherwise run the interactive `pac auth create --environment "<ENVIRONMENT_URL>"`.
  `pac auth create` makes the new profile active, so before the first one, note the active profile's index (the row marked `*` in `pac auth list`).
  After the last download, or when the comparison stops early, run `pac auth select --index <NOTED_INDEX>` to make it active again.
  Keep credentials and tokens out of files and chat.
- Resolve the Dataverse environment URL from the user's answer or an unambiguous authenticated context (`pac env who`, `pac env list`).
  A public website URL is not a Dataverse environment URL.
  When the environment stays unknown, ask for that site's Dataverse environment URL.
- Read the environment's **Environment ID** (a GUID) from its `pac env list` row, or from `pac env who`; the JSON export records it.
- Run `pac pages list --environment "<ENVIRONMENT_URL>" --verbose`.
  Match the website record ID against **Website Id**, or the exact website hostname against **Portal Url**.
  Use **Website Id**: a **Portal Id**, tenant ID or environment ID names something else.
  An inactive site can still be selected by its website record ID.
- From the matched row, read **Single Page Application** (`Yes` or `No`) and **Data Model Version** (`Standard` or `Enhanced`).
  When the row or either column is missing, ask the user rather than guess, and take GUIDs and environments only from PAC output or the user.
- Unrelated websites, or sites on different data models, differ in almost every record ID.
  Compare the files as they are, without remapping IDs, and tell the user to expect that noise.

**Verified** means: the website record ID, environment URL, environment ID and site type (SPA or non-SPA) are all known.

## Download

Download into `<RUN_DIR>/source` for the first site or `<RUN_DIR>/target` for the second.

Non-SPA site (**Single Page Application** is `No`), passing its **Data Model Version**:

```bash
pac pages download --path "<RUN_DIR>/<source-or-target>" --webSiteId "<WEBSITE_RECORD_ID>" --environment "<ENVIRONMENT_URL>" --modelVersion "<Standard-or-Enhanced>"
```

SPA site (`Yes`); this command takes no model version:

```bash
pac pages download-code-site --path "<RUN_DIR>/<source-or-target>" --webSiteId "<WEBSITE_RECORD_ID>" --environment "<ENVIRONMENT_URL>"
```

Pass `--environment` on every PAC command rather than switching the active environment.
Download the whole site, without `--includeEntities`, `--excludeEntities` or `--overwrite`.

PAC creates one site-named folder under `--path`.
A non-SPA download has `website.yml` directly in that folder; an SPA download has it in the folder's `.powerpages-site/` and has no `powerpages.config.json`.
Use that one site folder, and stop if `--path` holds more than one.

Reference: [PAC pages commands](https://learn.microsoft.com/power-platform/developer/cli/reference/pages)
