# Site Transfer Safety

Download and upload move Power Pages configuration between Dataverse and the
local project. Neither operation has an undo, and both can destroy
configuration that this migration never touched.

## Identity to confirm

Establish every value below and have the user confirm it. Never infer one from
a folder name, a previous session, or the active default.

| Detail | Confirm with | Needed for |
|---|---|---|
| Environment | `pac auth who`, `pac env who` | download, upload |
| Website name and `WebSiteId` | `pac pages list`, `website.yml` | download, upload |
| Site type: traditional or SPA | `powerpages.config.json` presence | download, upload |
| Data model: Standard or Enhanced | user | traditional only |
| Deployment profile | user, and profile files in the project | upload |
| Target path | user | download |

Re-confirm the whole set whenever the environment, website, or data model
changes. One approval covers one target.

## Command matrix

| Site type | Download | Upload |
|---|---|---|
| Traditional | `pac pages download` | `pac pages upload` |
| SPA | `pac pages download-code-site` | `pac pages upload-code-site` |

```bash
pac pages list --environment "<ENVIRONMENT>"

pac pages download --path "<PATH>" --webSiteId "<WEBSITE_ID>" --environment "<ENVIRONMENT>" --modelVersion "<Standard|Enhanced>"

pac pages upload --path "<PROJECT_ROOT>" --environment "<ENVIRONMENT>" --modelVersion "<Standard|Enhanced>" --deploymentProfile "<PROFILE>"

pac pages download-code-site --path "<PATH>" --webSiteId "<WEBSITE_ID>" --environment "<ENVIRONMENT>"

pac pages upload-code-site --rootPath "<PROJECT_ROOT>" --siteName "<SITE_NAME>"
```

Pass `--modelVersion` explicitly on every traditional download and upload;
`Standard` and `Enhanced` may also be written as `1` and `2`.

## Failure modes

Each of these corrupts configuration and cannot be reverted.

- **Wrong upload command.** `pac pages upload` corrupts an SPA site's
  metadata, and `pac pages upload-code-site` corrupts a traditional site. A
  project holding `powerpages.config.json` is an SPA site even when it also
  contains `.powerpages-site/` artifacts.
- **Wrong data model.** `pac pages download` uses `Standard` when
  `--modelVersion` is omitted, so an Enhanced site downloads incomplete.
  Editing that copy and uploading it overwrites live configuration.
- **Unpinned environment.** `pac pages upload-code-site` accepts no
  `--environment` and targets whatever `pac auth who` reports. Re-run
  `pac auth who` immediately before it and stop on any mismatch.
- **Wrong website.** Sites in one environment differ only by name and
  `--webSiteId`. A wrong ID downloads another site over the target path.
  Before uploading, confirm the project's `website.yml` identity still matches
  the approved site.
- **Overwritten local work.** `--overwrite` replaces existing local content.
  Never pass it while the project holds unreviewed changes.
- **Stale local copy.** Uploading configuration downloaded before another
  maker's change reverts that change. Download fresh before editing when the
  local copy's age is unknown.
- **Unintended deployment profile.** `pac pages upload` uses `default` when
  `--deploymentProfile` is omitted, which can target the wrong environment's
  values.

## Public references

- [Power Platform CLI pages commands](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/pages)
- [Tutorial: Use Power Platform CLI with Power Pages](https://learn.microsoft.com/en-us/power-pages/configure/power-platform-cli-tutorial)
- [Use deployment profiles](https://learn.microsoft.com/en-us/power-apps/maker/portals/power-apps-cli#use-deployment-profile)
