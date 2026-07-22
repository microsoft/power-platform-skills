# Migration Engine Reference — `pac pages bootstrap-migrate` and the auto flag-flip

This reference documents the CLI engine the `/bootstrap-migrate-v3-to-v5` skill orchestrates: what
`pac pages bootstrap-migrate` does, what it produces, and how `pac pages upload`
automatically flips the server-side Bootstrap 5 runtime flag.

## Site type: classic only

This engine operates on **classic / native** Power Pages sites — the downloaded site
folder containing Liquid web templates and config:

- `website.yml` (has `adx_websiteid`)
- `sitesetting.yml`
- `*.webtemplate.source.html`, `*.html`, `*.aspx`, `*.ascx`, `*.css`, `*.js`

It does **not** apply to code sites (React/Vue/Angular/Astro), which have
`powerpages.config.json` + a framework `package.json` and are never Bootstrap-3-based.

## `pac pages bootstrap-migrate`

```bash
pac pages bootstrap-migrate --path "<SITE_FOLDER>"
```

| Argument | Alias | Required | Notes |
|----------|-------|----------|-------|
| `--path` | `-p` | Yes | Path to the downloaded classic site folder |

### Behavior (non-destructive)

The engine never edits the source in place. It:

1. Copies the entire `<SITE_FOLDER>` tree to a **new sibling folder `<SITE_FOLDER>V5`**.
2. Rewrites Bootstrap-3 classes → Bootstrap-5 across `*.html`, `*.js`, `*.aspx`, `*.ascx` (markup)
   and `*.css` (stylesheets), via ~20 component-specific mappers
   (Navbar, Panel→Card, Grid, Glyphicon→FontAwesome, Tooltip, Dropdown, Form, Table, Pagination,
   Badge, ProgressBar, Carousel, Button, InputGroup, Image, ListGroup, Utility classes, Breadcrumb,
   plus generic `data-*` → `data-bs-*`).
3. Replaces the embedded `bootstrap.min.css` (v3) with the Bootstrap 5 stylesheet.
4. Appends a `Site/BootstrapV5Enabled` record (value `true`) to `sitesetting.yml`
   (skipped if already present).
5. Writes a human-readable **`logs.txt`** change report at the root of `<SITE_FOLDER>V5`.
6. Writes a per-file **`<file>-diff.json`** capturing the exact replacements applied to each file.

### Representative auto-applied renames

| Bootstrap 3 | Bootstrap 5 |
|-------------|-------------|
| `panel-heading / -body / -footer / -title` | `card-header / card-body / card-footer / card-title` |
| `navbar-toggle` | `navbar-toggler` |
| `navbar-right / navbar-left` | `ms-auto / me-auto` |
| `img-responsive / img-circle` | `img-fluid / rounded-circle` |
| `pull-left / pull-right` | `float-start / float-end` |
| `text-left / text-right` | `text-start / text-end` |
| `data-toggle / data-dismiss / data-target` | `data-bs-toggle / data-bs-dismiss / data-bs-target` |
| `label-*` | `bg-*` |
| `col-xs-* → col-sm-* → col-md-* → col-lg-* → col-xl-* → col-xxl-*` | grid tiers shifted up one |
| `sr-only` | `visually-hidden` |
| `table-condensed` | `table-sm` |

Some classes are **dropped** (e.g. `panel-default`, `panel-group`, `text-hide`) and some are
**replaced with inline styles** (panel contextual classes) — see the manual-fixes reference for the
ones that need follow-up.

## `logs.txt` format

The report opens with three file lists (the engine's categorization):

1. **HTML files with No change**
2. **HTML files with Replacement/Addition/Deletion changes** (auto-applied)
3. **HTML files with Hierarchy changes** (auto-detected but **logged only — manual work required**)

Then, per changed file, a block separated by a line of dashes:

```
<path/to/file>
Total Number of Changes: <n>
1 Replacing <old> with <new> at line:<L> col:<C>
2 Adding <class> at line:<L> col:<C>
3 Deleting <class> at line:<L> col:<C>
4 Need hierarchy change for <class> at line:<L> col:<C>
...
```

Message verbs map to `ModificationType`:

| Log verb | ModificationType | Auto-applied? |
|----------|------------------|---------------|
| `Replacing … with …` | Replacement | Yes |
| `Adding …` | Addition | Yes |
| `Deleting …` | Deletion | Yes |
| `Need hierarchy change for …` | HierarchyChange | **No — manual** |

A file lands in category (3) if it contains any `HierarchyChange`; otherwise category (2) if it has
any changes, else category (1).

## `pac pages upload` — content upload + automatic runtime flag flip

```bash
pac pages upload --path "<SITE_FOLDER>V5"
```

`--modelVersion` defaults to `Standard` (correct for a classic site). Use `pac pages upload` —
**not** `upload-code-site`.

After uploading content, the upload verb runs an internal **Bootstrap V5 post-processor**
automatically. Its logic:

1. If the uploaded `sitesetting.yml` does **not** contain `Site/BootstrapV5Enabled = true` → **no-op**.
2. Read `adx_websiteid` from `website.yml`. If missing/invalid → skip (logged warning).
3. Resolve the portal id(s) for that website via the Power Pages API.
4. For each portal, PATCH `SetPortalBootstrapV5Enabled` (the server-side runtime flag).

> **Step 3 is the common failure.** `adx_website` is a Dataverse **content record**; the "portal" is
> the **provisioned, running site** registered with the Power Pages management layer. A website can
> exist (and be listed/downloaded) with **no active portal**. When step 3 finds none, the post-processor
> logs `Skipping SetPortalBootstrapV5Enabled: no portal found for website <id> via Power Pages API`
> (level `WRN`) and the flag is **never set**. The fix is to **activate the site first**, then re-upload.

### Critical caveat: flag-flip outcomes are swallowed — read `pac-log.txt`

The post-processor catches skip/HTTP/auth conditions and logs them (`WRN`/`Error`) — it does **not**
raise. So **a successful `pac pages upload` exit code does not prove the runtime flag flipped.** There
is **no per-folder upload log**; the only record is the rolling PAC diagnostic log:

```bash
pac telemetry status   # prints: The diagnostic logs can be found at: <…>\logs\pac-log.txt
grep -i "BootstrapV5UploadPostProcessor\|SetPortalBootstrapV5Enabled" "<pac-log.txt>"
```

Three outcomes: **applied** (`INF`) → on; **`Skipping … no portal found`** (`WRN`) → site not
activated; **`ERR`/exception** → flip attempted but failed (auth/HTTP). The skill must read this in
Phase 7.3 *before* trusting the live site — an unactivated site returns a 500 (Dataverse-connection
null-ref) that is unrelated to Bootstrap and must not be mistaken for a transient post-upload restart.

### Pre-flight the flag-flip gate

Because the flip is gated on file contents, before uploading confirm in `<SITE_FOLDER>V5`:

- `website.yml` has a valid `adx_websiteid`, and
- `sitesetting.yml` contains `Site/BootstrapV5Enabled` = `true` (the engine adds this; verify it
  survived any Phase 6 edits).

If either is absent, the flip silently no-ops even though the content uploads fine.

## Required commands / feature availability

The skill depends on these verbs being present in the CLI build / tenant:

- `pac pages download` — fetch a classic site locally.
- `pac pages bootstrap-migrate` — the migration engine.
- `pac pages upload` — upload + auto flag-flip.

Probe with `pac pages help` in Phase 1 and stop with guidance if any are missing.
