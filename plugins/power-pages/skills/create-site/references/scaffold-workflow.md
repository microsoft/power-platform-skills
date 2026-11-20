## Phase 2: Scaffold & Launch Dev Server

**Goal**: Get a running site immediately so the user has something to preview while features and design are planned

> **The scaffold is a temporary branded loading screen** — it shows a Power Pages animated "Building your site" experience with orbiting elements, status messages, and feature cards. Its only purpose is to get the dev server running quickly so the user has something to look at while you plan and build. **During Phase 5 (Implementation), the entire scaffold — including theme.css, Layout, Home page, and all placeholder components — is completely replaced** with the user's actual site: their chosen typography, color palette, pages, components, and navigation. Do NOT try to build on top of the loading screen; replace it entirely.

> See `${PLUGIN_ROOT}/references/framework-conventions.md` for the full framework → build tool → router → output path mapping.

**Actions**:

### 2.1 Copy Template

> `${PLUGIN_ROOT}` is already resolved to the plugin's absolute path at runtime. Use it directly in file-discovery and file-reading paths — do NOT search for the plugin directory.

Read and copy all files from the matching asset template to the project directory:

| Framework | Asset Directory |
|-----------|----------------|
| React | `${PLUGIN_ROOT}/skills/create-site/assets/react/` |
| Vue | `${PLUGIN_ROOT}/skills/create-site/assets/vue/` |
| Angular | `${PLUGIN_ROOT}/skills/create-site/assets/angular/` |
| Astro | `${PLUGIN_ROOT}/skills/create-site/assets/astro/` |

Discover and copy all files from the asset directory, preserving relative paths and binary content.

**Also copy the shared loader icon** that the scaffold references from its CSS (`url('/power-pages-icon.png')`):

Copy the binary file `${PLUGIN_ROOT}/skills/create-site/assets/shared/power-pages-icon.png` to `<PROJECT_ROOT>/public/power-pages-icon.png` without decoding it as text. (All four supported frameworks serve `public/` at the web root, so the same `/power-pages-icon.png` URL works for every framework.)

**Seed the live status file** so the loader shows a real message when it mounts. Write `<PROJECT_ROOT>/public/scaffold-status.json`:

```json
{ "message": "Planning your site", "awaitingInput": false }
```

Follow the entry-linked live-preview status contract: update this file before every user question and each Phase 5 implementation step.

### 2.2 Replace Placeholders

After copying, replace every occurrence of each `__PLACEHOLDER__` token in every text file.

- **Name/slug/description placeholders**: Use the actual values from Phase 1 (`__SITE_NAME__`, `__SITE_SLUG__`, `__SITE_DESCRIPTION__`).
- **Document-language placeholders**: Replace `__SITE_LOCALE__` with
  `SITE_LOCALE` and `__SITE_DIRECTION__` with `SITE_DIRECTION`.

> **Note:** The scaffold loading screen uses hardcoded Power Pages branding colors — there are no color placeholders (`__PRIMARY_COLOR__`, etc.) to replace. The user's chosen color palette is applied fresh during Phase 5 when the scaffold is completely replaced.

### 2.3 Rename gitignore

Rename `gitignore` → `.gitignore` in the project root (stored without dot prefix to avoid git interference in the plugin repo).

### 2.4 Install Dependencies

Run `npm install` **before** initializing git so that `package-lock.json` is included in the initial commit:

```bash
cd "<PROJECT_ROOT>"
npm install
```

> **Astro requires Node 22.12 or newer.**
> Astro 7 exits with `Node.js vX is not supported by Astro!` on anything older, so when the chosen framework is Astro, run `node --version` first and ask the user to upgrade before continuing.

### 2.5 Initialize Git Repository

Initialize a git repo and make the first commit. This captures all template files AND `package-lock.json` in one clean baseline:

```bash
cd "<PROJECT_ROOT>"
git init
git add -A
git commit -m "Initial scaffold: __SITE_NAME__ (__FRAMEWORK__)"
```

From this point, **commit after every significant milestone** so any breaking change can be reverted.

### 2.6 Start Dev Server

**This MUST happen now — before any planning or customization begins.** The dev server gives the user a live preview while features and design are being planned:

```bash
cd "<PROJECT_ROOT>"
npm run dev
```

Run `npm run dev` in the background as a background process using the available shell capability. Note the local URL (typically `http://localhost:5173` for Vite or `http://localhost:4200` for Angular or `http://localhost:4321` for Astro).

### 2.7 Verify in Playwright & Share URL

Immediately after the dev server starts, verify the scaffold is working:

1. Use the available browser navigation capability to open the dev server URL
2. Use the available browser inspection capability to verify the page loaded correctly (accessibility snapshots only - screenshots are reserved for the Phase 5 design checks)
3. **Share the dev server URL with the user** so they can preview the site in their own browser (e.g., "Your site is running at `http://localhost:5173` — open it in your browser to follow along as I build.")

> **GATE: Do NOT proceed to Phase 3 until ALL of the following are true:**
>
> 1. Template files copied and placeholders replaced
> 2. Git repo initialized with initial scaffold commit
> 3. `npm install` completed successfully
> 4. Dev server is running in the background (`npm run dev`)
> 5. Playwright has opened the site and verified it loads via `browser structure inspection`
> 6. The dev server URL has been shared with the user
>
> If any of these are not done, complete them now before moving on.

**Output**: Running dev server with verified scaffold, URL shared with user

---
