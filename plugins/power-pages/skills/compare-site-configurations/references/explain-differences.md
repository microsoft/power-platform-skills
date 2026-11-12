# Explain differences

People compare sites to learn why the two behave differently, so turn the file list into a functional explanation.

## Inputs

The verified receipt's `files` lists every changed configuration file with `relativePath`, `status`, `localPath` and `remotePath`.
`added` exists only in the first site, `deleted` only in the second, and `modified` in both with different contents.
`skipped` groups differences in files outside site configuration by top-level folder, such as `docs/`.
These lists are the source of truth: explain them, without recounting or re-diffing the sites.

## Rank

Rank each change by how directly it alters site behavior, using its component folder, file type and record names (SPA paths start with `.powerpages-site/`):

1. **Access and security:** table permissions, column permission profiles, web roles, page access control rules, and site settings named `Authentication/*`, `Webapi/*` or `HTTP/*`.
2. **Behavior:** other site settings, basic and advanced forms, lists, web templates, page templates, server logic, cloud flows, and JavaScript or CSS web files.
3. **Content and navigation:** web pages, content snippets, web link sets, site markers and images.

Promote a web page or content snippet to behavior when it holds custom JavaScript, CSS or Liquid, or when it changes a page's publishing state, page template or access setting.
Rank each record inside an aggregate file such as `sitesetting.yml` or `webrole.yml` by its own name, so an `Authentication/*` record ranks as access and security.

## Read

Open both versions of every changed file in the first two groups and compare the actual values; base each finding on what the files contain, not on their names.
In aggregate files, name the records that changed.
When a group has more than 25 changed files, read the most specific ones and report how many remain unread.

## Separate noise

- When the two website IDs differ, record IDs differ almost everywhere.
  Count an ID or lookup change as noise only after confirming that the lookup names the same record, such as the same web role or page template, on both sides.
- Indentation, blank lines and reordered YAML records are noise.
- Whitespace inside a setting value, string or Liquid output, and reordered JavaScript, CSS or Liquid, are real changes, because they change the value used or the order of execution and the CSS cascade.

## Reply

Reply in chat with:

- the overall drift in one line: counts, and whether the sites look like copies of one site;
- each access, security or behavior difference, with its file, the first site's value, the second site's value and the effect a site visitor would notice;
- a short summary of content-only differences;
- one line naming the `skipped` folders, when there are any.

When a changed value is a credential, such as a client secret, app secret, password, key or connection string, report only that it changed and keep both values out of chat.

## What the comparison covers

- **Compared:** the component folders PAC writes and the `.yml` files at the site root; for an SPA site, only its `.powerpages-site` folder.
- **Skipped:** dot-prefixed files and folders inside a site, such as `.portalconfig`, SPA application source, and any other file in the site folder, listed in `skipped`.
- **Display limits:** the report omits binary content and text over 5 MiB, and shows a summary above 20,000 lines; those files still count as changed.

With zero differences, say that the compared configuration matches and name what was skipped.
A behavior difference would then come from those exclusions or from outside site configuration, such as Dataverse records, environment settings, authentication provider configuration or browser cache.
