---
name: create-site
description: >-
  Creates a new Power Pages code site (SPA) from a curated template or from scratch using React,
  Angular, Vue, or Astro. Guides through the full process from initial concept to deployed site:
  requirements discovery, template selection or scaffolding, component planning, design,
  implementation, validation, and deployment. Use when the user wants to create, build, use a
  template for, or scaffold a new Power Pages website or portal.
user-invocable: true
argument-hint: Optional site description
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, WebSearch, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, mcp__plugin_power-pages_playwright__browser_navigate, mcp__plugin_power-pages_playwright__browser_snapshot, mcp__plugin_power-pages_playwright__browser_click
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Create Power Pages Code Site

Guide the user through creating a complete, production-quality Power Pages code site from initial concept to deployed site. Follow a systematic approach: discover requirements, scaffold and launch immediately, plan components and design, implement with design applied, validate, review, and deploy.

## Core Principles

- **Use best judgement for design details**: Once the user picks an aesthetic direction and mood, make confident decisions about specific fonts, colors, page layouts, and component behavior. Do not ask the user to specify every detail — use the design reference and your own taste to make creative, distinctive choices.
- **Use TaskCreate/TaskUpdate**: Track all progress throughout all phases — create the path-agnostic upfront tasks first, then append branch-specific tasks after the creation path is selected.
- **Scaffold early, design with intention**: Get the dev server running immediately after discovery so the user has something to look at. Then plan the design and features while the scaffold is live — apply the chosen aesthetic during implementation.
- **Live preview feedback loop**: The dev server MUST be running before any customization begins. Browse the site via Playwright (`browser_navigate` + `browser_snapshot`) to verify every significant change. Do NOT take screenshots — only use accessibility snapshots to check page structure and content.
- **Keep the scaffold loader in sync with reality**: The scaffold loader polls `public/scaffold-status.json`. Update this file before every `AskUserQuestion` (to raise the "waiting for your input" banner so the user doesn't miss a terminal prompt) and before each implementation step in Phase 5 (so the progress-bar label matches what you're actually doing while the decorative spinner continues its default cycle). See [Live Preview Status Protocol](#live-preview-status-protocol).
- **Use real images**: Source high-quality photos from Unsplash wherever pages need visual content — hero sections, feature cards, about pages, backgrounds, etc. Use `https://images.unsplash.com/photo-{id}?w={width}&h={height}&fit=crop` URLs with specific photo IDs found via `WebSearch`. Never leave image placeholders or broken `<img>` tags pointing to nonexistent files.
- **Git checkpoints**: Commit after every individual page and component — each gets its own commit so breaking changes can be reverted.

**Constraint**: Only static SPA frameworks are supported (React, Vue, Angular, Astro). NOT supported: Next.js, Nuxt.js, Remix, SvelteKit, Liquid.

**Initial request:** $ARGUMENTS

---

## Live Preview Status Protocol

<!-- not-a-gate: prose-only section — mentions of `AskUserQuestion` here describe the live-status protocol that wraps every real prompt in Phases 3/4/8; the actual gates are catalogued in §6.13 of references/approval-gates.md and marked at their call sites below -->

While the scaffold loading screen is visible (from Phase 2.6 until the Home page itself is replaced in Phase 5), the loader polls `GET /scaffold-status.json` every 1.5 seconds. The `message` you write into `<PROJECT_ROOT>/public/scaffold-status.json` appears as the label under the progress bar, and `awaitingInput` controls the "waiting for your input" banner. The decorative spinner above the progress bar continues its built-in phrase cycle; keep the progress-bar label current so the loader still reflects what is actually happening.

**Why this matters**: When the browser with the loader takes over the user's screen, a prompt in the terminal can sit unanswered for a long time because the user doesn't realize anything is waiting. The banner makes it obvious.

**File shape** (all fields optional — omit any field you don't want to change):

```json
{
  "message": "Creating Contact page",
  "awaitingInput": false,
  "inputPrompt": "Please check your terminal to respond."
}
```

- `message` — one short present-participle phrase shown as the status line under the progress bar in the loader (replacing the default "Getting started…" / "Setting up infrastructure…" cycle). Include the grouping context inline when it helps (e.g., `"Creating Footer component (shared components)"`).
- `awaitingInput` — when `true`, a prominent pulsing banner appears at the top of the loader and stays visible until this field is cleared. Set this **before** every `AskUserQuestion` call and clear it (`false`) **immediately after** the user answers.
- `inputPrompt` — short context for the banner (e.g., `"Choose a framework"`). Optional.

**When to update the file**:

1. **After scaffold launches (end of Phase 2)**: write an initial status like `{ "message": "Planning your site", "awaitingInput": false }`.
2. **Before any `AskUserQuestion` that runs while the scaffold is visible** (Phases 3, 4, and any in-scaffold prompt in Phase 5): set `awaitingInput: true` with a short `inputPrompt`. After the user answers, write again with `awaitingInput: false`.
3. **Before each implementation step in Phase 5** — applying design tokens, creating each shared component, creating each page, updating the router, updating navigation — update `message` to the specific action. Examples: `"Applying design tokens"`, `"Creating Navbar component"`, `"Creating Contact page"`.
4. **At the end of Phase 5, after the Home page has been replaced**: delete `public/scaffold-status.json` so it isn't deployed with the site.

Write the file with the `Write` tool (atomic overwrite). You do not need to read it first.

---

## Phase 1: Discovery

**Goal**: Understand what site needs to be built and what problem it solves

**Actions**:

<!-- gate: create-site:1.purpose | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:1.purpose):** Path-agnostic discovery prompt collecting site name, purpose, and audience. Determines what kind of site the user needs before the skill decides between a template-backed path and the from-scratch scaffold path. Fires only on the "site purpose unclear" branch (step 3 below).
>
> **Trigger:** Phase 1 when site name, purpose, or audience was not provided in `$ARGUMENTS`.
> **Why we ask:** Wrong purpose/audience context → wrong branch decision and wrong generated site plan; cleanup is annoying.
> **Cancel leaves:** Nothing — no scaffolding has started yet.

1. Create the minimal upfront todo list (see [Progress Tracking](#progress-tracking)):
   - Discover site requirements
   - Select template or choose from-scratch
2. If site name, purpose, and audience are clear from arguments:
   - Summarize understanding
   - Identify site type (portal, dashboard, landing page, blog, etc.)
3. If site name, purpose, or audience is unclear, use `AskUserQuestion`:

   | Question | Header | Options |
   |----------|--------|---------|
   | What should the site be called? (e.g., "Contoso Portal", "HR Dashboard") | Site Name | *(free text — use a single generic option so the user types a custom name via "Other")* |
   | What is the site's purpose? | Purpose | Company Portal, Blog/Content, Dashboard, Landing Page |
   | Who is the target audience? | Audience | Internal (employees, partners), External (public-facing customers) |

4. From the user's answers, derive:
   - `__SITE_NAME__` (Title Case, e.g., `Contoso Portal`)
   - `__SITE_SLUG__` (kebab-case derived from site name, e.g., `contoso-portal`)
   - `__SITE_DESCRIPTION__` (one-line description based on name + purpose)
5. Summarize the path-agnostic understanding and confirm with user before proceeding:
   - Site name
   - Site purpose/type
   - Target audience

   Do **not** ask for framework or project location in Phase 1. Those questions only apply to the from-scratch branch and are asked after Phase 1.5 when that branch is selected.

**Audience influences site generation:**

- **Internal**: Prioritize data tables, dashboards, authentication, navigation depth, functional over flashy design
- **External**: Prioritize landing page appeal, SEO-friendly structure, contact forms, clean marketing-oriented layout

**Output**: Clear statement of site purpose, audience, and derived naming values.

---

## Phase 1.5: Template Branch Decision

**Goal**: Route the user into the appropriate creation path after path-agnostic Discovery.

> **Current implementation state:** Template discovery, selection, unmanaged solution import, inactive-site identification, activation, and live-site preview are implemented here. Seed data and robustness/re-install handling are implemented by later slices. The user can always choose **Start from scratch** to continue into the existing scaffold flow.

**Actions**:

1. Mark **Select template or choose from-scratch** as `in_progress`.
2. Fetch the template catalog:

   ```bash
   node "${PLUGIN_ROOT}/scripts/fetch-template-catalog.js"
   ```

   Evaluate the JSON result:
   - **If `ok: false`**: tell the user templates are temporarily unavailable and continue with the from-scratch path. This is additive; a catalog failure must never block `create-site`.
   - **If `ok: true` but `catalog.templates` is empty or malformed**: tell the user no templates are currently available and continue with the from-scratch path.
   - **If templates are available**: proceed to semantic matching.

3. Semantically match the templates against the Phase 1 context (`$ARGUMENTS`, site name, purpose, and audience):
   - Use each template's `displayName`, `description`, `keywords`, `audience`, and `framework`.
   - Do **not** compute a numeric score or invent a ranking script. Keywords guide agent judgement; they are not counted.

4. Render the relevant templates for browser preview:

   - Download each `previewImages` artifact into the SHA-keyed cache before rendering:
     ```bash
     node "${PLUGIN_ROOT}/scripts/fetch-template-artifact.js" --sha "<catalog-sha>" --artifactPath "<preview-image-path>"
     ```
     Replace each preview image path with the returned `localUrl`. If a preview download returns `ok: false`, omit that one image from the gallery and continue; a missing preview should not block using an otherwise-valid template.
   - Write a temporary JSON file containing a `TEMPLATES_JSON` array with the templates the user should preview and the cached preview image URLs.
   - Run:
     ```bash
     node "${PLUGIN_ROOT}/scripts/render-template-picker.js" --templatesJsonPath "<temp-json>" --outputPath "<temp-html>" --open
     ```
   - The browser view is read-only; the terminal `AskUserQuestion` remains the decision surface.

<!-- not-a-gate: read-only route selection after template preview; only disposable temp preview files exist, with no project directory, Dataverse write, or durable skill state -->

5. Ask one of the following `AskUserQuestion` prompts:

   | Match situation | Prompt options |
   |-----------------|----------------|
   | One strong match | Use `<displayName>` (Recommended), See all templates, Start from scratch |
   | Several plausible matches | One option per shortlisted template, See all templates, Start from scratch |
   | No clear match | See all templates, Start from scratch (Recommended) |

   When the user chooses **See all templates**, render the full catalog gallery and ask again with one option per template plus **Start from scratch**.

6. Branch on the user's selection:
   - **Template selected**:
     1. Download and validate the selected template's solution zip before committing to the template path:
        ```bash
        node "${PLUGIN_ROOT}/scripts/fetch-template-solution.js" --sha "<catalog-sha>" --solutionPath "<selected.solutionPath>"
        ```
     2. If the result is `ok: false`, tell the user the selected template package is unavailable or corrupt, then set `CREATION_PATH = "from-scratch"` and continue to the from-scratch questions below. Do not leave partial cache files behind. The from-scratch branch emits the single terminal telemetry event for this run.
     3. If the result is `ok: true`, set `CREATION_PATH = "template"`, `SELECTED_TEMPLATE = <manifest entry>`, and `SELECTED_TEMPLATE_SOLUTION_ZIP = <localPath>`. Append only **Verify prerequisites and confirm template import** now (see [Progress Tracking](#progress-tracking)); the import-vs-clone tasks are appended after the reinstall policy is known. Continue to the template import sequence below. Do **not** ask framework/location and do **not** proceed to Phase 2.
   - **Start from scratch** or catalog unavailable: set `CREATION_PATH = "from-scratch"` and continue below.

7. For the template path only:

   1. Mark **Verify prerequisites and confirm template import** as `in_progress`.
   2. Resolve the target environment and token via the shared auth helpers:
      ```bash
      node "${PLUGIN_ROOT}/scripts/resolve-template-import-context.js"
      ```
      Use the returned `environmentUrl` and `token` for the import request and poller. If `ok: false`, surface the error, emit the template-outcome event with `mode=template`, selected template id/framework/audience, `importOutcome=failure`, `activationOutcome=skipped`, and `seedApplied=false`, then stop before import.

<!-- gate: create-site:1.5.template-import | category=consent | cancel-leaves=template-cache -->

> 🚦 **Gate (consent · create-site:1.5.template-import):** Confirm importing the selected template solution into the current Power Platform environment.
>
> **Trigger:** Phase 1.5 after the selected template solution zip is downloaded and the target environment is resolved.
> **Why we ask:** The next step imports an unmanaged Dataverse solution into the user's org. Wrong environment or wrong template is disruptive and cannot be cleanly undone.
> **Cancel leaves:** `template-cache` — the selected solution zip and preview images may remain in the SHA-keyed temp cache; no org mutation has occurred.

   3. Present the template and environment, then ask:

      | Question | Header | Options |
      |----------|--------|---------|
      | Install **`<SELECTED_TEMPLATE.displayName>`** into **`<environmentUrl>`**? This imports an unmanaged solution into your org. If the template includes seed data, it will be applied after import and before activation. | Install Template | Yes, import this template (Recommended), No, start from scratch, Cancel |

      - **No, start from scratch**: set `CREATION_PATH = "from-scratch"` and continue to step 8.
      - **Cancel**: emit the template-outcome event with `mode=template`, selected template id/framework/audience, `importOutcome=failure`, `activationOutcome=skipped`, and `seedApplied=false`, then stop; no org mutation has happened.
   4. Inspect the selected solution zip and check whether that solution is already installed:
      ```bash
      node "${PLUGIN_ROOT}/scripts/inspect-template-solution.js" --zipPath "<SELECTED_TEMPLATE_SOLUTION_ZIP>"
      node "${PLUGIN_ROOT}/scripts/check-solution-installed.js" --solutionName "<uniqueName>" --envUrl "<environmentUrl>"
      node "${PLUGIN_ROOT}/scripts/inspect-template-solution.js" --zipPath "<SELECTED_TEMPLATE_SOLUTION_ZIP>" --installed "<true|false>" --installedVersion "<version-or-empty>"
      ```
      If `inspect-template-solution.js` returns `ok: false`, treat detection as unknown (`decision: "ask"`). The solution can still be imported if the user explicitly chooses to continue, but the safer defaults are **Start from scratch** or **Stop**.
      If `check-solution-installed.js` exits 1, treat detection as unknown (`decision: "ask"`) and do not assume the solution is absent.
      - **`decision: "import"`**: append the import-path tasks (**Import template solution**, **Show imported inactive site**, optional **Apply template seed data**, **Activate imported site**, **Show live template site**) and continue.
      - **`decision: "confirm-update"`**: tell the user a newer template version is available and confirm before importing in place.

        <!-- gate: create-site:1.5.update-installed | category=consent | cancel-leaves=template-cache -->

        > 🚦 **Gate (consent · create-site:1.5.update-installed):** Confirm updating an already-installed unmanaged template solution.
        >
        > **Trigger:** Phase 1.5 when the selected template solution is already installed and the downloaded zip has a newer version.
        > **Why we ask:** Updating an unmanaged solution merges changes into the environment and cannot be cleanly rolled back.
        > **Cancel leaves:** `template-cache` — downloaded template artifacts remain in the SHA-keyed temp cache; no org mutation happens if cancelled.

        Use `AskUserQuestion`:

        | Question | Header | Options |
        |----------|--------|---------|
        | Template `<displayName>` is already installed at version `<installedVersion>`. The selected template zip is newer (`<zipVersion>`). Update the unmanaged solution in this environment? | Update Template | Yes, update the template (Recommended), No, cancel |

        If the user declines or cancels, emit the template-outcome event with `mode=template`, selected template id/framework/audience, `importOutcome=failure`, `activationOutcome=skipped`, and `seedApplied=false`, then stop before import; no org mutation has happened. If the user confirms, append the import-path tasks and continue.

      - **`decision: "offer-clone"`**: do not re-import. Append **Clone existing template site**, then offer to clone the existing site instead:

        <!-- gate: create-site:1.5.clone-existing | category=consent | cancel-leaves=template-cache -->

        > 🚦 **Gate (consent · create-site:1.5.clone-existing):** Confirm cloning an existing website instead of re-importing the same or older unmanaged template solution.
        >
        > **Trigger:** Phase 1.5 when the selected template solution is already installed at the same or newer version.
        > **Why we ask:** Cloning creates/upload site content for a new site; wrong source site creates the wrong clone.
        > **Cancel leaves:** `template-cache` — downloaded template artifacts remain in the SHA-keyed temp cache; no clone/upload happens if cancelled.

        Use `AskUserQuestion`:

        | Question | Header | Options |
        |----------|--------|---------|
        | Template `<displayName>` is already installed at the same or newer version. Re-importing is not recommended. Clone an existing website from this template instead? | Clone Existing Site | Yes, clone an existing site (Recommended), No, cancel |

        First run `pac pages list -v` and identify the existing website to clone.

        <!-- not-a-gate: clone source-site disambiguation after the user has already approved the clone path; data-gathering only, no clone/download/upload runs until a source is selected -->

        If more than one candidate could be the template site, ask the user to pick the source site name/Website Record ID before running clone commands.
        ```bash
        pac pages download-code-site --webSiteId "<existing website id>" --path "<temp path>"
        pac pages clone --path "<downloaded path>"
        pac pages upload-code-site --rootPath "<cloned path>"
        ```
        If any clone command fails, surface the failed command and error output, then fire this gate:

        <!-- gate: create-site:1.5.clone-failed | category=progress | cancel-leaves=partial-template-clone -->

        > 🚦 **Gate (progress · create-site:1.5.clone-failed):** Choose how to proceed after cloning an existing template site fails.
        >
        > **Trigger:** Phase 1.5 when `download-code-site`, `clone`, or `upload-code-site` fails.
        > **Why we ask:** The environment or local temp folder may contain partial clone state; retrying or switching paths should be explicit.
        > **Cancel leaves:** `partial-template-clone` — downloaded template artifacts remain in the SHA-keyed temp cache, and local downloaded/cloned files or a partial code-site upload may remain; the error summary names the failed command.

        Use `AskUserQuestion`:

        | Question | Header | Options |
        |----------|--------|---------|
        | Cloning the existing template site failed. How would you like to proceed? | Clone Failed | Retry clone (Recommended), Fall back to from-scratch, Stop |

        Do not retry automatically; offer **Retry clone**, **Fall back to from-scratch**, or **Stop**. Verify a successful upload by running `pac pages list -v` again and diffing the output with `diff-pages-list.js`. If the cloned site identity is found, invoke `/activate-site` with that cloned site name and Website Record ID, then open the live URL, emit the template-outcome event with `mode=template`, selected template id/framework/audience, `importOutcome=success`, the actual activation outcome, and `seedApplied=false`, and present the same template-path summary used below. If the cloned site identity cannot be resolved, emit the template-outcome event with `mode=template`, selected template id/framework/audience, `importOutcome=success`, `activationOutcome=skipped`, and `seedApplied=false`, then stop and tell the user the clone/upload completed but activation needs a manual `/activate-site` run with the cloned Website Record ID from `pac pages list -v`. If the user declines cloning, emit the template-outcome event with `mode=template`, selected template id/framework/audience, `importOutcome=failure`, `activationOutcome=skipped`, and `seedApplied=false`, then stop. **Do not continue into the normal template import flow after a clone path succeeds or stops.**
      - **`decision: "ask"`** or detection failure: ask whether to import anyway, start from scratch, or stop.

        <!-- gate: create-site:1.5.reinstall-unknown | category=consent | cancel-leaves=template-cache -->

        > 🚦 **Gate (consent · create-site:1.5.reinstall-unknown):** Confirm whether to import when installed-solution detection failed.
        >
        > **Trigger:** Phase 1.5 when `check-solution-installed.js` cannot determine whether the selected template solution already exists.
        > **Why we ask:** Importing an unmanaged solution that may already exist can merge components or create duplicate site state.
        > **Cancel leaves:** `template-cache` — downloaded template artifacts remain in the SHA-keyed temp cache; no org mutation happens if cancelled.

        Use `AskUserQuestion`:

        | Question | Header | Options |
        |----------|--------|---------|
        | I couldn't determine whether this template solution is already installed. Importing anyway may merge unmanaged components or create duplicate site state. How would you like to proceed? | Template Install Unknown | Import anyway (advanced), Start from scratch (Recommended), Stop |

        Branch on the answer:
        - **Import anyway**: append the import-path tasks and continue to the pre-import snapshot and import flow below.
        - **Start from scratch**: set `CREATION_PATH = "from-scratch"` and continue to the deferred framework/location questions.
        - **Stop**: emit the template-outcome event with `mode=template`, selected template id/framework/audience, `importOutcome=failure`, `activationOutcome=skipped`, and `seedApplied=false`, then stop before import; no org mutation has happened.

   5. Capture a pre-import site list snapshot:
      ```bash
      node "${PLUGIN_ROOT}/scripts/capture-pages-list.js" --output "<temp-before-pages-list.txt>"
      ```
      If the result is `ok: false`, surface the error, emit the template-outcome event with `mode=template`, selected template id/framework/audience, `importOutcome=failure`, `activationOutcome=skipped`, and `seedApplied=false`, then stop before import.
   6. Mark **Verify prerequisites and confirm template import** as `completed` and **Import template solution** as `in_progress`.
   7. Import the unmanaged solution inline, without invoking `/import-solution` and without writing ALM artifacts:
      ```bash
      node "${PLUGIN_ROOT}/scripts/encode-solution-file.js" --zipPath "<SELECTED_TEMPLATE_SOLUTION_ZIP>"
      node "${PLUGIN_ROOT}/scripts/dataverse-request.js" "<environmentUrl>" POST "ImportSolutionAsync" \
        --body '{"CustomizationFile":"<encoded>","OverwriteUnmanagedCustomizations":true,"PublishWorkflows":true,"ConvertToManaged":false}' \
        --include-headers
      node "${PLUGIN_ROOT}/scripts/poll-async-operation.js" \
        --asyncJobId "<AsyncOperationId from ImportSolutionAsync>" \
        --envUrl "<environmentUrl>" \
        --token "<token>" \
        --intervalMs 8000 \
        --maxAttempts 75
      ```
      If the poll result is not `Succeeded`, query the import job (using the `ImportJobKey` returned by `ImportSolutionAsync`) and parse its component-level error XML, following `/import-solution`'s Phase 6 pattern. Do **not** auto-clean up the unmanaged partial import.

      <!-- gate: create-site:1.5.import-failed | category=progress | cancel-leaves=partial-unmanaged-template-import -->

      > 🚦 **Gate (progress · create-site:1.5.import-failed):** Choose how to proceed after template solution import fails.
      >
      > **Trigger:** Phase 1.5 when `ImportSolutionAsync` fails, times out, or reports component-level failures.
      > **Why we ask:** The environment may contain a partial unmanaged import; retrying or switching paths should be an explicit choice.
      > **Cancel leaves:** `partial-unmanaged-template-import` — downloaded template artifacts remain in the SHA-keyed temp cache; any unmanaged partial import remains in Dataverse and is explained in the error summary.

      Use `AskUserQuestion`:

      | Question | Header | Options |
      |----------|--------|---------|
      | Template import failed or partially completed. How would you like to proceed? | Template Import Failed | Retry import, Fall back to from-scratch (Recommended), Stop |

      Branch on the answer:
      - **Retry import**: return to the import command sequence above and poll again.
      - **Fall back to from-scratch**: set `CREATION_PATH = "from-scratch"` and continue to the deferred framework/location questions. Tell the user the unmanaged partial import may remain in Dataverse. The eventual from-scratch branch emits the single terminal telemetry event.
      - **Stop**: emit the template-outcome event with `mode=template`, selected template id/framework/audience, `importOutcome=failure`, `activationOutcome=skipped`, and `seedApplied=false`, then stop after showing the error summary. Do not mark **Import template solution** as completed and do not continue to post-import site detection.

      If the error is `AttachmentBlocked`, point to `/import-solution` Phase 5b remediation.
      Only continue to the next step when the import poll result is `Succeeded`.
   8. Mark **Import template solution** as `completed` and **Show imported inactive site** as `in_progress`.
   9. Capture a post-import site list snapshot and identify the newly-imported site:
      ```bash
      node "${PLUGIN_ROOT}/scripts/capture-pages-list.js" --output "<temp-after-pages-list.txt>"
      node "${PLUGIN_ROOT}/scripts/diff-pages-list.js" --before "<temp-before-pages-list.txt>" --after "<temp-after-pages-list.txt>"
      ```
      - **`status: "found"` and `inactive: true`**: set `IMPORTED_SITE_NAME`, `IMPORTED_WEBSITE_RECORD_ID`, and `IMPORTED_SITE_STATE`, then tell the user: "Template `<displayName>` was imported as `<IMPORTED_SITE_NAME>` (`<IMPORTED_WEBSITE_RECORD_ID>`). Current state from `pac pages list -v`: `<IMPORTED_SITE_STATE>`. The site exists in your environment but is not live yet; activation is the next step."
      - **`status: "found"` but `inactive: false`**: show the diff result, emit the template-outcome event with `mode=template`, selected template id/framework/audience, `importOutcome=success`, `activationOutcome=skipped`, and `seedApplied=false`, then explain that the import succeeded but the inactive state could not be verified automatically. Stop before activation; the next slice will handle recovery.
      - **`status: "none"` or `"multiple"`**: show the diff result, emit the template-outcome event with `mode=template`, selected template id/framework/audience, `importOutcome=success`, `activationOutcome=skipped`, and `seedApplied=false`, then explain that the import succeeded but the newly-imported site could not be identified automatically. Stop before activation; the next slice will handle recovery.
   10. Mark **Show imported inactive site** as `completed`.
   11. If `SELECTED_TEMPLATE.seedDataPath` is present, mark **Apply template seed data** as `in_progress` and run:
       ```bash
       node "${PLUGIN_ROOT}/scripts/fetch-template-seed-data.js" --sha "<catalog-sha>" --seedDataPath "<SELECTED_TEMPLATE.seedDataPath>"
       ```
       If the result is `ok: true`, use `localDir` as the seed directory. If the result is `ok: false`, surface the error and continue to activation; seed-data fetch is best-effort.
       ```bash
       node "${PLUGIN_ROOT}/scripts/apply-seed-data.js" --seedDir "<localDir>" --envUrl "<environmentUrl>"
       ```
       Surface the JSON summary (`inserted`, `failed`, `skipped`, `errors`). For a lightweight read-only verification path, query each seeded `entitySetName` with `dataverse-request.js` using `GET "<entitySetName>?$top=1"` and report whether the seeded table is reachable. Seeding is best-effort: even if `failed > 0`, `ok: false`, or read-only verification cannot run, continue to activation.
       If `seedDataPath` is absent, skip this task.
   12. Mark **Apply template seed data** as `completed` or skipped, then mark **Activate imported site** as `in_progress`.
   13. Invoke `/activate-site`, passing the resolved identity in the request so it skips local-project discovery:
       ```text
       Activate imported template site:
       - siteName: <IMPORTED_SITE_NAME>
       - websiteRecordId: <IMPORTED_WEBSITE_RECORD_ID>
       - environmentUrl: <environmentUrl>
       - source: create-site template path
       ```
       The activate-site skill owns subdomain selection, final activation confirmation, provisioning, polling, and recovery.
       If activation ultimately fails, tell the user the site is imported but not live yet and can be activated later by rerunning `/activate-site` with the imported site identity. Emit the template-outcome event with `mode=template`, selected template id/framework/audience, `importOutcome=success`, `activationOutcome=failure`, and the actual `seedApplied` boolean, then stop. Do **not** treat this as a failed import.
   14. When `/activate-site` returns a `siteUrl`, mark **Activate imported site** as `completed` and **Show live template site** as `in_progress`.
   15. Open the live site URL in the user's default browser:
       ```bash
       node "${PLUGIN_ROOT}/scripts/open-url.js" --url "<siteUrl>"
       ```
       Evaluate the JSON result:
       - **`ok: true`**: tell the user the site was opened in their default browser.
       - **`ok: false`**: tell the user the browser could not be opened automatically and show the `siteUrl` for manual opening.

       Always surface the activate-site DNS propagation caveat: the site may take a few minutes to load even after activation succeeds.
   16. Emit the template-outcome telemetry event (fail-closed):
       ```bash
       node "${PLUGIN_ROOT}/scripts/emit-create-site-template-outcome.js" \
         --mode template \
         --templateId "<SELECTED_TEMPLATE.id>" \
         --framework "<SELECTED_TEMPLATE.framework>" \
         --audience "<SELECTED_TEMPLATE.audience>" \
         --importOutcome "success" \
         --activationOutcome "success" \
         --seedApplied "<true|false>"
       ```
       Do not include site name, URL, subdomain, free-text purpose, or any other user-identifying value.
   17. Mark **Show live template site** and **Select template or choose from-scratch** as `completed`, then present the template-path summary:
       - Template name and framework
       - Imported site name and Website Record ID
       - Live site URL
       - DNS propagation note: the site may take a few minutes to load everywhere
       - "Your site is live. Want to keep customizing it from here?"
       Do **not** continue to Phase 2.

8. For the from-scratch path only, tell the user: "I'll scaffold this site from scratch."

<!-- not-a-gate: deferred data-gathering prompt for framework and directory before any scaffold files are written -->

9. Ask the from-scratch-only questions that were deferred from Phase 1:

   | Question | Header | Options |
   |----------|--------|---------|
   | Which frontend framework? | Framework | React (Recommended), Vue, Angular, Astro |
   | Where should the project be created? | Location | Current directory, New folder in current directory (Recommended), Any other directory |

10. Resolve the project location:
   - **If "Current directory"**: Project root = `<cwd>`.
   - **If "New folder in current directory"**: Create a folder named `__SITE_NAME__` inside the cwd. Project root = `<cwd>/__SITE_NAME__/`.
   - **If "Any other directory"**: Ask for the full path. Verify/create it. Project root = provided path.

   After resolving, confirm: "The site will be created at `<resolved path>`."

   Store this as `PROJECT_ROOT`.
11. Append the from-scratch task list (Phases 2-8) to the todo list (see [Progress Tracking](#progress-tracking)), then mark **Select template or choose from-scratch** as `completed`.

**Output**: either imported template site identity (`IMPORTED_SITE_NAME`, `IMPORTED_WEBSITE_RECORD_ID`) in an inactive/not-live state, or `CREATION_PATH = "from-scratch"` with selected framework and resolved project location.

---

## Phase 2: Scaffold & Launch Dev Server

**Goal**: Get a running site immediately so the user has something to preview while features and design are planned

> **The scaffold is a temporary branded loading screen** — it shows a Power Pages animated "Building your site" experience with orbiting elements, status messages, and feature cards. Its only purpose is to get the dev server running quickly so the user has something to look at while you plan and build. **During Phase 5 (Implementation), the entire scaffold — including theme.css, Layout, Home page, and all placeholder components — is completely replaced** with the user's actual site: their chosen typography, color palette, pages, components, and navigation. Do NOT try to build on top of the loading screen; replace it entirely.

> See `${PLUGIN_ROOT}/references/framework-conventions.md` for the full framework → build tool → router → output path mapping.

**Actions**:

### 2.1 Copy Template

> `${PLUGIN_ROOT}` is already resolved to the plugin's absolute path at runtime. Use it directly in Glob/Read paths — do NOT search for the plugin directory.

Read and copy all files from the matching asset template to the project directory:

| Framework | Asset Directory |
|-----------|----------------|
| React | `${PLUGIN_ROOT}/skills/create-site/assets/react/` |
| Vue | `${PLUGIN_ROOT}/skills/create-site/assets/vue/` |
| Angular | `${PLUGIN_ROOT}/skills/create-site/assets/angular/` |
| Astro | `${PLUGIN_ROOT}/skills/create-site/assets/astro/` |

Use `Glob` to discover all files in the asset directory, `Read` each file, then `Write` to the project directory preserving the relative path structure.

**Also copy the shared loader icon** that the scaffold references from its CSS (`url('/power-pages-icon.png')`):

`Read` the binary file `${PLUGIN_ROOT}/skills/create-site/assets/shared/power-pages-icon.png` and `Write` it to `<PROJECT_ROOT>/public/power-pages-icon.png`. (All four supported frameworks serve `public/` at the web root, so the same `/power-pages-icon.png` URL works for every framework.)

**Seed the live status file** so the loader shows a real message the moment it mounts. `Write` `<PROJECT_ROOT>/public/scaffold-status.json`:

```json
{ "message": "Planning your site", "awaitingInput": false }
```

See [Live Preview Status Protocol](#live-preview-status-protocol) for the full contract — from here on, update this file before every `AskUserQuestion` and before each Phase 5 implementation step.

### 2.2 Replace Placeholders

After copying, replace all `__PLACEHOLDER__` tokens in every file. Use `Edit` with `replace_all: true` on each file.

- **Name/slug/description placeholders**: Use the actual values from Phase 1 (`__SITE_NAME__`, `__SITE_SLUG__`, `__SITE_DESCRIPTION__`).

> **Note:** The scaffold loading screen uses hardcoded Power Pages branding colors — there are no color placeholders (`__PRIMARY_COLOR__`, etc.) to replace. The user's chosen color palette is applied fresh during Phase 5 when the scaffold is completely replaced.

### 2.3 Rename gitignore

Rename `gitignore` → `.gitignore` in the project root (stored without dot prefix to avoid git interference in the plugin repo).

### 2.4 Install Dependencies

Run `npm install` **before** initializing git so that `package-lock.json` is included in the initial commit:

```bash
cd "<PROJECT_ROOT>"
npm install
```

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

Run `npm run dev` in the background using `Bash` with `run_in_background: true`. Note the local URL (typically `http://localhost:5173` for Vite or `http://localhost:4200` for Angular or `http://localhost:4321` for Astro).

### 2.7 Verify in Playwright & Share URL

Immediately after the dev server starts, verify the scaffold is working:

1. Use `mcp__plugin_power-pages_playwright__browser_navigate` to open the dev server URL
2. Use `mcp__plugin_power-pages_playwright__browser_snapshot` to verify the page loaded correctly (do NOT take screenshots — only use accessibility snapshots)
3. **Share the dev server URL with the user** so they can preview the site in their own browser (e.g., "Your site is running at `http://localhost:5173` — open it in your browser to follow along as I build.")

> **GATE: Do NOT proceed to Phase 3 until ALL of the following are true:**
>
> 1. Template files copied and placeholders replaced
> 2. Git repo initialized with initial scaffold commit
> 3. `npm install` completed successfully
> 4. Dev server is running in the background (`npm run dev`)
> 5. Playwright has opened the site and verified it loads via `browser_snapshot`
> 6. The dev server URL has been shared with the user
>
> If any of these are not done, complete them now before moving on.

**Output**: Running dev server with verified scaffold, URL shared with user

---

## Phase 3: Component Planning

**Goal**: Determine what pages, components, and design elements the site needs — while the user previews the running scaffold

<!-- gate: create-site:3.requirements | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:3.requirements):** Three sub-prompts (features multi-select, aesthetic, mood) — shape the Phase 4 plan and the Phase 5 implementation. Fires at step 2 of the action list below.
>
> **Trigger:** Phase 3 entry; scaffold loader is up.
> **Why we ask:** Wrong feature set / aesthetic gets baked into the rendered plan — the Phase 4.7 gate would still catch most errors, but it's wasteful to defer the catch.
> **Cancel leaves:** Nothing — scaffold loader files are throwaway artifacts replaced wholesale in Phase 5.

**Actions**:

1. **Raise the "awaiting input" banner** so the user notices the terminal prompt even while the browser loader is full-screen. `Write` `<PROJECT_ROOT>/public/scaffold-status.json`:

   ```json
   { "message": "Planning your site", "awaitingInput": true, "inputPrompt": "Features, aesthetic, and mood — please answer in the terminal." }
   ```

   Immediately after the user answers, `Write` the same file again with `"awaitingInput": false` so the banner disappears.

2. Use `AskUserQuestion` to collect feature and design requirements:

   | Question | Header | Options |
   |----------|--------|---------|
   | Which features? (multi-select) | Features | *(generate 3-4 context-aware options based on the site name, purpose, and audience from Phase 1)* |
   | What aesthetic direction do you want? | Aesthetic | Minimal & Clean (Recommended), Bold & Vibrant, Dark & Moody, Warm & Organic |
   | What's the overall mood? | Mood | Professional & Trustworthy (Recommended), Creative & Playful, Technical & Precise, Elegant & Premium |

   > **Feature options are NOT hardcoded.** Infer relevant features from Phase 1 answers. For example:
   > - "HR Dashboard" + Internal → Employee Directory, Leave Requests, Announcements, Org Chart
   > - "Contoso Portal" + External → Contact Form, Service Catalog, Knowledge Base, FAQ
   > - "Partner Hub" + Internal → Document Library, Partner Directory, Deal Tracker, Notifications
   >
   > Always generate options that make sense for the specific site — never reuse a fixed list.
   >
   > **If you include an Authentication feature option**, describe it generically as "Login/signup for tracking application status" or similar. Do NOT mention a specific identity provider (e.g., "Entra ID", "SAML", "Google") in the feature description — the `/power-pages:setup-auth` skill will ask the user which provider they want.

3. **AI Component Planning** — Based on Phase 1 answers (site name, purpose, audience) and the feature selection above, propose which of the Power Pages generative-AI summarization APIs the site might use. The site itself does not depend on them — the page ships with reserved slots and runs without AI; `/add-ai-webapi` populates the slots later when the user is ready. Use `AskUserQuestion` with multi-select to let the user opt in:

   | Question | Header | Options |
   |----------|--------|---------|
   | Which AI summarization features should the site have? (multi-select — each can be added later with `/add-ai-webapi`) | AI Summaries | *(generate 2-4 context-aware options plus "None for now")* |

   > **Options are NOT hardcoded.** Infer relevant AI summary features from Phase 1 and the features picked above. Examples:
   > - "HR Dashboard" + Leave Requests feature → "Data summarization for leave requests", "Search summary on the knowledge base"
   > - "Contoso Portal" + Knowledge Base → "Search summary on site-wide search", "Data summarization for articles"
   > - "Customer Self-Service" + Support Cases / Incidents → "Data summarization for support cases (Microsoft-shipped recipe)", "Data summarization for attached knowledge articles"
   >
   > Treat the standard `incident` table like any other Dataverse table — propose Data
   > Summarization for it when the site handles support cases, but don't force the Microsoft-shipped
   > recipe (`$select=description,title` + the portal-comments expand) unless that genuinely fits
   > the user's UX. A custom case-like table or a different facet of the standard incident is a
   > regular Data Summarization pick. Always include **None for now** so the user can defer. Do
   > NOT integrate the APIs in this skill — only record the user's picks so Phase 4's plan can
   > mention them and Phase 8 can suggest `/add-ai-webapi` as a recommended next step.
   >
   > Capture the selection in memory as `AI_SUMMARY_PICKS` — a list of one or more of: `search-summary`, `data-summarization`.

4. **Map picks to target pages.** For each entry in `AI_SUMMARY_PICKS`, decide which page will carry the AI surface and store the mapping as `AI_SUMMARY_PLACEMENTS`. This is what Phase 4 shows the user and what Phase 5 reserves slots for. Use the feature selection from step 2 — and treat this mapping as an *input* to the page list Claude proposes in step 7: if a pick has no natural target page, add one to the plan so the summary has a home:

   | Pick | Default target page | If no matching page is planned |
   |------|--------------------|-------------------------------|
   | `search-summary` | A search / search-results page (e.g., `SearchResults`, `Search`) | Add a search page to the plan so the summary has a home |
   | `data-summarization` | The detail page of the table the user called out (e.g., `ProductDetail` for products, `CaseDetail` for support cases) — ask the user if ambiguous | Propose adding a detail page; if rejected, fall back to a list/dashboard page |

   `AI_SUMMARY_PLACEMENTS` shape: one record per placement, e.g.
   `[{ pick: "data-summarization", targetPage: "CaseDetail", marker: "POWERPAGES:AI-SLOT kind=data-summarization" }]`.

   The `marker` string is the comment tag Phase 5 emits into the page source as a reserved anchor that `/add-ai-webapi` later finds. Keep the shape uniform — one marker per placement, always the same tag, so the follow-up skill's explore step can grep for them deterministically.

5. Read the design aesthetics reference: `${PLUGIN_ROOT}/skills/create-site/references/design-aesthetics.md`
6. **Map aesthetic + mood to design choices** using the Aesthetic x Mood Mapping table from the design reference. Record the chosen font direction, color direction, and motion direction.
7. Analyze requirements and determine needed components. If `AI_SUMMARY_PLACEMENTS` from step 4 implies a page that wasn't already in the plan (e.g., a `CaseDetail` page for a data-summarization pick on the support-case table), add it to the page list now. Present the component plan to the user as a table:

   ```
   | Component Type      | Count | Details |
   |---------------------|-------|---------|
   | Pages               | 4     | Home, About, Services, Contact |
   | Shared Components   | 3     | Navbar, Footer, ContactForm |
   | Design Elements     | 4     | Google Fonts (Playfair Display + Source Sans Pro), Color palette (6 CSS vars), Page transitions, Gradient backgrounds |
   | Routes              | 4     | /, /about, /services, /contact |
   ```

8. Use best judgement to determine the final color palette based on the chosen aesthetic + mood. These will be written fresh into a new `theme.css` during Implementation (Phase 5) when the scaffold loading screen is completely replaced:

   | CSS Variable | Description | Value |
   |-------------|-------------|-------|
   | `--color-primary` | Primary hex color | *(choose based on aesthetic + mood)* |
   | `--color-secondary` | Complementary hex color | *(choose based on aesthetic + mood)* |
   | `--color-bg` | Background color | *(choose based on aesthetic + mood)* |
   | `--color-surface` | Surface/card color | *(choose based on aesthetic + mood)* |
   | `--color-text` | Main text color | *(choose based on aesthetic + mood)* |
   | `--color-text-muted` | Muted text color | *(choose based on aesthetic + mood)* |

**Output**: Confirmed list of pages, components, design elements, and routes to create

---

## Phase 4: Plan Approval

**Goal**: Render the implementation plan as an HTML document, open it in the user's default browser, and get approval before starting implementation.

> **Why HTML instead of a chat message**: A structured HTML plan (like the ones produced by `/integrate-backend`, `/add-server-logic`, and `/add-cloud-flow`) lets the user skim sections, compare swatches, and preview typography — all impossible in a terminal. The scaffold loader in their browser may also be full-screen, so surfacing the plan in a new tab puts it where they can actually read it.

### 4.1 Read the Design Reference

Read the design aesthetics reference: `${PLUGIN_ROOT}/skills/create-site/references/design-aesthetics.md`. Every field you populate below should be justified by the chosen aesthetic + mood from Phase 3.

> **AI Readiness in the plan.** If `AI_SUMMARY_PLACEMENTS` from Phase 3 is non-empty, reflect each placement in the matching `PAGES_DATA` entry's `description` or `content` — e.g., *"Reserved slot for an AI summary card; populated later by `/add-ai-webapi`. The page ships without AI."* This keeps the user's expectation honest: the site does not depend on generative-AI features being enabled on the tenant, and there is no "Run /add-ai-webapi" placeholder visible to end-users. If `AI_SUMMARY_PLACEMENTS` is empty, omit any AI references from the plan.

### 4.2 Build the Plan Data

Assemble a single JSON object with the following keys. The plan template rejects any data that's missing a required key, so include all of them.

| Key | Type | Content |
|-----|------|---------|
| `SITE_NAME` | string | Title-case site name from Phase 1 |
| `PLAN_TITLE` | string | Always `"Implementation Plan"` |
| `FRAMEWORK` | string | `React` / `Vue` / `Angular` / `Astro` |
| `AESTHETIC` | string | Chosen aesthetic (e.g., `Minimal & Clean`) |
| `MOOD` | string | Chosen mood (e.g., `Professional & Trustworthy`) |
| `SUMMARY` | string | One paragraph describing what the site is and who it serves |
| `TYPOGRAPHY_DATA` | object | `{ primary: { name, sample, reason }, secondary: { name, sample, reason } }` — `name` must be a real Google Font family |
| `PALETTE_DATA` | array | `[{ var, hex, description }]` — one entry per CSS variable (primary, secondary, bg, surface, text, text-muted) |
| `MOTION_DATA` | array | `[{ label, description }]` — page transitions, hover states, etc. |
| `BACKGROUNDS_DATA` | array | `[{ label, description }]` — hero backgrounds, section treatments, patterns |
| `PAGES_DATA` | array | `[{ name, route, description, content: [...], components: [...] }]` — `content` is an outline of what's on the page, `components` is shared component names used |
| `COMPONENTS_DATA` | array | `[{ name, purpose, usedBy: [...] }]` — shared components with the page names that consume them |
| `ROUTES_DATA` | array | `[{ path, page }]` — every route the router will register |
| `REVIEW_DATA` | array of strings | Verification checklist items (e.g., "All pages load without console errors") |
| `DEPLOYMENT_DATA` | array | `[{ title, description, recommended?: boolean }]` — mark exactly one as `recommended: true` |

**Write the data for the user**, not for internal tooling — phrase `description` and `reason` fields in plain language.

### 4.3 Render the HTML Plan

Pick an output path under `<PROJECT_ROOT>/docs/`. Default is `create-site-plan.html`; if that file already exists, pick a descriptive variant like `create-site-plan-v2.html` (the render script refuses to overwrite existing files).

```bash
node "${PLUGIN_ROOT}/scripts/render-createsite-plan.js" --output "<PROJECT_ROOT>/docs/create-site-plan.html" --data-inline '<json-string>'
```

Use `--data-inline` so no temp JSON file is written. If the JSON is too large for a single shell argument, write it to a temp file and use `--data <path>` instead, then delete the temp file after the render succeeds.

The script prints `{"status":"ok","output":"<path>"}` on success. Capture and use that actual output path for the next step.

### 4.4 Open the Plan in the Default Browser

Open `<OUTPUT_PATH>` in the default browser using the platform-appropriate file opener for the current environment. For example, use `open` on macOS, `xdg-open` on Linux, or the equivalent default-browser opener available on Windows.

### 4.5 Present a Brief Summary in the Terminal

Keep the terminal message short — **the full plan lives in the HTML file now**. Include:

- One sentence confirming the plan was rendered and where (the output path).
- A 3-5 line bullet summary: framework, page count, component count, palette primary + mood.
- A pointer: "See the open browser tab for pages, color swatches, typography samples, and deployment options."

Do NOT dump the full plan contents into the terminal — that defeats the purpose of the HTML view.

### 4.6 Raise the "Awaiting Input" Banner

The user may still be looking at the full-screen scaffold loader when you ask for approval. `Write` `<PROJECT_ROOT>/public/scaffold-status.json`:

```json
{ "message": "Ready to build", "awaitingInput": true, "inputPrompt": "Plan approval needed — review the plan in your browser and answer in the terminal." }
```

Immediately after the user answers, `Write` the same file again with `"awaitingInput": false`.

### 4.7 Ask for Approval

<!-- gate: create-site:4.7.plan-approval | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:4.7.plan-approval):** Final sign-off on the rendered HTML plan before Phase 5 starts replacing the scaffold with real pages, components, and design tokens.
>
> **Trigger:** Phase 4.3 rendered `docs/create-site-plan.html`; Phase 4.4 opened it in the browser.
> **Why we ask:** Phase 5 rewrites the entire scaffold (theme.css, Layout, Home page, components, routes) — undoing that touches every commit in the implementation phase.
> **Cancel leaves:** Nothing destructive — the scaffold itself can be deleted with the project directory; no Dataverse / deploy fired.

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Does this plan look good? | Plan | Approve and start building (Recommended), I'd like to make changes |

- **If "Approve"**: Proceed to Phase 5.
- **If "I'd like to make changes"**: Ask what they want changed, update the JSON, and re-render to a new filename (the render script won't overwrite). Re-open that new file in the browser and repeat 4.5–4.7.

**Output**: Approved implementation plan, with an HTML copy committed alongside the project for the user to reference during and after implementation.

---

## Phase 5: Implementation

**Goal**: Build all pages, components, and design elements with the chosen aesthetic applied from the start

> **Prerequisite:** The dev server MUST already be running and verified via Playwright (completed in Phase 2). If it is not, go back and complete Phase 2.
>
> **Design reference:** Read `${PLUGIN_ROOT}/skills/create-site/references/design-aesthetics.md` and apply its principles throughout this phase. All pages and components should be built with the chosen typography, color palette, motion, and backgrounds from the start — do NOT build with neutral styling first and redesign later.

**Actions**:

### 5.1 Create Todos for All Work

**Before writing any code**, use `TaskCreate` to create a todo for every piece of work. This gives the user full visibility into what will be built:

- **One todo per page** — e.g., "Create Contact page (`/contact`)", "Create Dashboard page (`/dashboard`)"
- **One todo per shared component** — e.g., "Create ContactForm component", "Create DataTable component"
- **One todo for routing** — "Update router with all new routes"
- **One todo for navigation** — "Update Layout/Header with navigation links"
- **One todo for design foundations** — "Apply design tokens (fonts, colors, motion, backgrounds)"

Each todo should have a clear `subject`, `activeForm`, and `description` that includes the file path and what the page/component does. Then work through the todos in order, marking each `in_progress` → `completed`.

### 5.2 Replace the Scaffold & Build

The scaffold is a temporary loading screen — it must be **completely replaced** during this phase. Do NOT build on top of it or try to modify the loading animation into a real page. Start fresh with the user's chosen design.

> **Narrate progress in the loader**: Before each of the steps below, update `<PROJECT_ROOT>/public/scaffold-status.json` so the user — who may still be watching the Home page loader — sees what's actually happening instead of the hardcoded placeholder cycle. Use a short present-participle `message` (e.g., `"Creating Navbar component"`, `"Creating Contact page"`). Include any useful grouping context inline in the message itself. The loader picks up changes within ~1.5 seconds. Updates become no-ops once step 4 replaces the Home page.

1. **Design foundations** — **Completely rewrite** `theme.css` (or `styles.css` for Angular) from scratch with the chosen color palette as CSS custom properties, Google Fonts, motion/animation utilities, and background treatments. The scaffold's loading screen CSS is discarded entirely. Commit after this step. *Before starting, set the loader status to `{ "message": "Applying design tokens" }`.*
2. **Layout** — **Rewrite** the Layout component (and Header/Footer for Astro) with proper navigation, header, and footer that reflect the chosen design. The scaffold's passthrough Layout is replaced with a real layout structure. *Set status to `{ "message": "Rewriting Layout" }`.*
3. **Shared components** — Build reusable components (Navbar, Footer, ContactForm, etc.) that pages will use. *For each component, set status to `{ "message": "Creating <Component> component" }`.*
4. **Pages** — Create route components for each requested page, **replacing** the scaffold Home page and About placeholder entirely. Each page component must update `document.title` on mount to reflect the current page (e.g., `"Contact — Contoso Portal"`). Use the framework's idiomatic lifecycle hook: `useEffect` (React), `onMounted` (Vue), `ngOnInit` (Angular), or a `<title>` tag in the frontmatter (Astro). Format: `"<Page Name> — <Site Name>"`, with the home page using just `"<Site Name>"`. *For each page, set status to `{ "message": "Creating <Page> page" }` before writing the file. The loader disappears when the Home page itself is replaced — no further status updates are needed after that.*
5. **Router** — Register all new routes (the scaffold only has `/` and `/about` — add all requested routes)
6. **Navigation** — Add links to the new Layout/Header component
7. **Entry HTML** — Update `index.html` (or `Layout.astro` for Astro) to load the chosen Google Fonts instead of the scaffold's DM Sans + Outfit
8. **Reserve AI summary slots** — only if `AI_SUMMARY_PLACEMENTS` from Phase 3 is non-empty. For each placement, insert a single comment marker in the target page source at the intended insertion point. No visible placeholder UI, no stub components, no extra routes — just a grep-able anchor that `/add-ai-webapi` will later find and replace. Syntax depends on the framework:

   | Framework | Marker syntax |
   |-----------|--------------|
   | React (JSX) | `{/* POWERPAGES:AI-SLOT kind=<pick> */}` inside the component's return JSX |
   | Vue (SFC template) | `<!-- POWERPAGES:AI-SLOT kind=<pick> -->` inside `<template>` |
   | Angular (HTML template) | `<!-- POWERPAGES:AI-SLOT kind=<pick> -->` inside the component template |
   | Astro | `<!-- POWERPAGES:AI-SLOT kind=<pick> -->` inside the component's HTML |

   Where `<pick>` is one of `search-summary`, `data-summarization` — verbatim from the placement record.

   Placement within the page:

   - **`data-summarization`** (record detail): directly after the page heading, above the detail content — this is where a Copilot-style summary card naturally reads in the reading order.
   - **`data-summarization`** (list page): directly above the list / table, below the page heading and any filter bar.
   - **`search-summary`**: directly above the search-results list, below the search input — the summary paragraph reads before the keyword hits.

   One marker per placement, exactly as defined in the `marker` field of the `AI_SUMMARY_PLACEMENTS` record. Do NOT add stub components (`<CopilotSummaryCard />`, etc.), CSS classes, or empty `<aside>` elements — the slot is just a comment. The site must ship as if AI is not a consideration; the follow-up skill does the real work.

**Important**: Build real, functional UI with distinctive design applied — not placeholder "coming soon" pages, and not generic unstyled markup. Every page and component should reflect the chosen aesthetic from the moment it's created. The scaffold loading screen should be completely gone after this phase — no trace of the Power Pages branded animation should remain.

### 5.3 Source Real Images

Use high-quality photos from Unsplash wherever the site needs visual content. Do NOT use placeholder services (e.g., `placeholder.com`, `placehold.co`), broken `<img>` tags, or leave empty image slots.

**How to find images:**

1. Use `WebSearch` to search Unsplash for relevant photos (e.g., `site:unsplash.com modern office workspace`)
2. Pick specific photos and use their direct URL with sizing parameters: `https://images.unsplash.com/photo-{id}?w={width}&h={height}&fit=crop`
3. Choose images that match the site's aesthetic and mood

**Where to use images:**

- **Hero sections** — Striking, high-resolution photos that set the tone for the site
- **Feature/service cards** — Relevant photos that illustrate each feature or service
- **About/team sections** — Professional or contextual photos matching the site's purpose
- **Backgrounds** — Atmospheric photos used as full-bleed or overlay backgrounds
- **Content sections** — Supporting photos that break up text and add visual interest

**Guidelines:**

- Pick images that feel cohesive together — consistent style, lighting, and color tone
- Use appropriate sizing (`w=800` for cards, `w=1600` for heroes/backgrounds) to avoid slow loads
- Add descriptive `alt` text to every `<img>` for accessibility
- For icons and logos, use inline SVGs instead of photos

### 5.4 Git Commit Checkpoints

Commit after **every individual page and component** so breaking changes can be reverted. Each page and each component gets its own commit — do NOT batch multiple pages or components into a single commit.

```bash
git add -A
git commit -m "<short description of what was added/changed>"
```

**When to commit:**

- After applying design foundations (fonts, colors, motion)
- After creating each page (e.g., "Add Home page", "Add Contact page")
- After creating each shared component (e.g., "Add Navbar component", "Add Footer component")
- After updating routing and navigation
- Before attempting anything risky or experimental

**If something breaks**, revert to the last good commit:

```bash
git revert HEAD
```

### 5.5 Live Verification

After each significant change (new page or component), browse the site via Playwright to ensure everything is up to the mark:

1. Use `mcp__plugin_power-pages_playwright__browser_navigate` to reload or navigate to the updated page
2. Use `mcp__plugin_power-pages_playwright__browser_snapshot` to verify the page structure and content are correct — do NOT take screenshots
3. If something looks wrong in the snapshot, fix it before proceeding

The user is previewing in their own browser via the dev server URL shared in Phase 2.7.

### 5.6 Clean Up the Live Status File

Once the scaffold loader is gone, `public/scaffold-status.json` is just dead weight that would ship with the deployed site. Delete the file from `<PROJECT_ROOT>/public/` and commit the removal alongside the final implementation.

> **GATE: Do NOT proceed to Phase 6 until ALL customization is complete with design applied.** The site must have distinctive typography (Google Fonts — no generic Inter/Roboto/Arial), a cohesive color palette (CSS variables), motion/animations, and all requested pages/features before moving to accessibility verification.

**Output**: All pages, components, and design elements implemented and verified

---

## Phase 6: Accessibility Verification

**Goal**: Verify the site meets WCAG 2.2 AA standards using axe-core automated testing and fix any violations

> **Prerequisite:** All pages and components must be fully implemented (Phase 5 complete). The dev server MUST be running.

**Actions**:

### 6.1 Install Playwright Dependency

Install `playwright` as a dev dependency in the project so the audit script can launch a headless browser. This uses the system-installed browser (Edge/Chrome) — no browser download is needed:

```bash
cd "<PROJECT_ROOT>"
npm install --save-dev playwright
```

### 6.2 Run axe-core Audit on Every Page

Run the audit script via `Bash`, passing the dev server URL and all site routes:

```bash
node "${PLUGIN_ROOT}/skills/create-site/scripts/axe-audit.js" --url <DEV_SERVER_URL> --routes /,/about,/services,/contact --project-root "<PROJECT_ROOT>"
```

The script launches a headless browser, navigates to each route, injects axe-core from CDN, runs the analysis, and outputs a JSON array of per-route results to stdout. Each result contains `violations` (with `id`, `impact`, `description`, `helpUrl`, and affected `nodes`), `passes` count, and `incomplete` count. The script exits with code 1 if any `critical` or `serious` violations are found.

Parse the JSON output and record all violations.

### 6.3 Fix Accessibility Violations

For each violation found, identify the source file and apply the fix:

| Violation | Fix |
|-----------|-----|
| Missing `alt` text on images | Add descriptive `alt` attributes to `<img>` tags |
| Insufficient color contrast | Adjust CSS color variables to meet 4.5:1 (normal text) or 3:1 (large text) ratios |
| Missing form labels | Add `<label>` elements or `aria-label` attributes |
| Missing landmark regions | Wrap content in `<main>`, `<nav>`, `<header>`, `<footer>` |
| Skipped heading levels | Correct heading hierarchy (h1 → h2 → h3, no gaps) |
| Missing link text | Add descriptive text or `aria-label` to links |
| Missing `lang` attribute | Add `lang="en"` to the `<html>` tag |
| Inadequate focus indicators | Add visible `outline` styles to interactive elements |

After fixing each group of related violations, commit:

```bash
git add -A
git commit -m "Fix accessibility: <violation description>"
```

### 6.4 Re-verify After Fixes

After all fixes are applied, re-run the audit script (same command as 6.2) to confirm violations are resolved:

1. If new violations appear (e.g., a fix introduced a regression), repeat 6.3–6.4
2. Continue until the script exits with code 0 (zero `critical` and `serious` violations)

Present a summary table to the user:

```
| Page | Route | Violations Found | Violations Fixed | Status |
|------|-------|-----------------|-----------------|--------|
| Home | / | 3 | 3 | Pass |
| About | /about | 1 | 1 | Pass |
| Contact | /contact | 2 | 2 | Pass |
| **Total** | | **6** | **6** | **All passing** |
```

> **GATE: Do NOT proceed to Phase 7 until all pages pass axe-core with zero `critical` and `serious` violations.** Minor and moderate violations should also be fixed where possible, but are not blocking.

**Output**: Accessibility-verified site with zero critical/serious axe-core violations

---

## Phase 7: Review & User Testing

**Goal**: Ensure the site meets user expectations and all pages work correctly

<!-- gate: create-site:7.review | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:7.review):** Live-site review — last chance to request changes before the deploy prompt. Cancel branch lets the user keep iterating. Fires at step 4 of the action list below.
>
> **Trigger:** Phase 7 has verified all pages render via Playwright.
> **Why we ask:** User loses the chance to spot UI issues before deploy; broken pages get pushed.
> **Cancel leaves:** Nothing — site files stay as-is on disk.

**Actions**:

1. Browse through each page via Playwright (`browser_navigate` + `browser_snapshot`) to verify all pages load correctly — do NOT take screenshots
2. Present a summary of what was built:

   ```
   | Component Type      | Count | Details |
   |---------------------|-------|---------|
   | Pages               | 4     | Home (/), About (/about), Services (/services), Contact (/contact) |
   | Shared Components   | 3     | Navbar, Footer, ContactForm |
   | Design Elements     | 4     | Playfair Display + Source Sans Pro, 6 CSS variables, fade-in transitions, gradient backgrounds |
   | Git Commits         | 7     | scaffold + 6 feature commits |
   ```

3. Share the dev server URL with the user and list all available routes
4. Ask the user to review using `AskUserQuestion`:
   > "The site is ready for review at `<dev server URL>`. Please check it out in your browser. Would you like any changes?"
5. If the user requests changes, apply them and re-verify by browsing via `browser_snapshot`

**Output**: User-approved site ready for deployment

---

## Phase 8: Deployment & Next Steps

**Goal**: Deploy the site and suggest enhancements

> **This phase is MANDATORY. Do NOT end the session without asking about deployment.**

<!-- gate: create-site:8.deploy | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:8.deploy):** Deploy prompt — invokes `/deploy-site` on Yes. Skipping leaves the site files on disk for the user to deploy later. Fires at step 2 of the action list below.
>
> **Trigger:** Phase 8 entry; Phase 7 review approved.
> **Why we ask:** Auto-deploy picks whatever env PAC CLI happens to be pointing at — wrong-env first deploy is messy to undo.
> **Cancel leaves:** Nothing — site files stay on disk; no deploy fired.

**Actions**:

1. Record skill usage:

   > Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

   Follow the skill tracking instructions in the reference to record this skill's usage. Use `--skillName "CreateSite"`. Note: `.powerpages-site` may not exist for first-time sites — the script exits silently.

2. Use `AskUserQuestion` with options: **Deploy now (Recommended)**, **Skip for now**:
   > "Would you like to deploy your site to Power Pages now?"
3. If the user chooses to deploy, invoke the `/deploy-site` skill.
4. Mark all todos complete
5. Present a final summary:
   - Site name and purpose
   - Framework and project location
   - Components created (X pages, Y components, Z design elements)
   - Key files and their purposes
   - Total file count and git commit count
6. Suggest optional enhancement skills:
   - `/setup-datamodel` — Create Dataverse tables for dynamic content
   - `/add-seo` — Add meta tags, robots.txt, sitemap.xml, favicon
   - `/add-tests` — Add unit tests (Vitest) and E2E tests (Playwright)
   - `/add-ai-webapi` — Add generative-AI summaries (Search Summary and Data Summarization). **Recommend first when `AI_SUMMARY_PLACEMENTS` from Phase 3 is non-empty** — the pages already carry `POWERPAGES:AI-SLOT` comment markers at the intended insertion points, so the follow-up skill's explore step finds them deterministically and the user gets the AI surface they picked during discovery without any page redesign.
7. Emit the from-scratch template-outcome telemetry event (fail-closed):
   ```bash
   node "${PLUGIN_ROOT}/scripts/emit-create-site-template-outcome.js" \
    --mode scratch \
    --framework "<framework>" \
    --audience "<audience>"
   ```

**Output**: Deployed (or deployment-ready) site with clear next steps

---

## Important Notes

### Throughout All Phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase
- **Ask for user confirmation** at key decision points (see list below)
- **Use best judgement** for design details — make confident, creative choices based on the user's aesthetic + mood selection without asking for every specific font, color, or layout decision
- **Apply design from the start** — never build neutral then restyle
- **Verify via Playwright** after every significant change
- **Commit after every page and component** — each gets its own dedicated commit, never batch multiple together
- **No screenshots** — only use `browser_snapshot` (accessibility snapshots) to verify pages; never use `browser_take_screenshot` as it clutters the user's directory. Give the user the dev server URL for visual preview.

### Key Decision Points (Wait for User)

1. After Phase 1: Confirm site purpose and audience
2. During Phase 1.5: Choose framework and project location for the from-scratch path
3. After Phase 4: Approve implementation plan
4. After Phase 7: Accept site or request changes
5. At Phase 8: Deploy or skip

### Progress Tracking

Before starting Phase 1, create only the path-agnostic upfront tasks using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Discover site requirements | Discovering requirements | Collect site name, purpose, audience, and derived naming values |
| Select template or choose from-scratch | Selecting creation path | Offer matching templates, or route the user into the from-scratch path |

After Phase 1.5 selects the from-scratch path, append the existing from-scratch phase tasks:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Scaffold and launch dev server | Scaffolding project | Copy template, replace placeholders with defaults, git init, npm install, start dev server, share URL |
| Plan site components | Planning components | Determine pages, components, design direction, and routes while user previews scaffold |
| Approve implementation plan | Getting plan approval | Present implementation plan covering design and pages, get user approval |
| Implement pages and components | Building site | Apply chosen design tokens, create all pages, components, routing, navigation |
| Verify accessibility with axe-core | Verifying accessibility | Run axe-core on every page, fix all critical/serious violations, re-verify until passing |
| Review with user | Reviewing site | Navigate all pages, share URL, get user feedback, apply changes |
| Deploy and wrap up | Deploying site | Ask about deployment, present summary, suggest next steps |

After Phase 1.5 selects the template path, append only the common template confirmation task first:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Verify prerequisites and confirm template import | Confirming template import | Verify PAC/Azure auth, resolve the target environment, and ask for import consent |

After the reinstall policy chooses a normal import/update/import-anyway path, append:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Import template solution | Importing template solution | Import the selected unmanaged solution and poll the async job to completion |
| Show imported inactive site | Showing imported site | Diff `pac pages list -v` output to identify the imported site record and tell the user it is not live yet |
| Apply template seed data | Applying seed data | Insert optional template seed records using the deterministic seed-data script; failures do not block activation |
| Activate imported site | Activating imported site | Invoke activate-site with the resolved site name and Website Record ID |
| Show live template site | Showing live site | Open the activated site URL in the browser and invite the user to continue customizing |

When the selected template is already installed at the same or a newer version and the user chooses the clone path, append this branch-specific task instead of the import-path tasks:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Clone existing template site | Cloning existing site | Download, clone, upload, and identify the cloned site before activation |

Mark each task `in_progress` when starting it and `completed` when done via `TaskUpdate`. This gives the user visibility into progress and keeps the workflow deterministic while avoiding permanently skipped tasks on future non-from-scratch branches.

### Quality Standards

Every site must meet these standards before completion:

- Distinctive typography via Google Fonts (no generic Inter/Roboto/Arial)
- Cohesive color palette via CSS variables
- Motion/animations (page transitions, hover states)
- All requested pages and features implemented (not placeholders)
- All routes working and navigation complete
- Accessibility verified via axe-core — zero critical/serious violations on all pages
- Git commits at key milestones
- Verified via Playwright
- User reviewed and approved
- Deployment offered

---

## Example Workflow

### User Request

"Create a partner portal for our consultants"

### Phase 1: Discovery

- Name: Partner Portal
- Purpose: Company Portal
- Audience: Internal (partners, consultants)

### Phase 1.5: Template Branch Decision

- Creation path: From-scratch
- Framework: React
- Location: New folder `partner-portal` in current directory

### Phase 2: Scaffold & Launch

- React template copied, default placeholders replaced
- Git initialized, npm installed, dev server running at `http://localhost:5173`
- Playwright verified scaffold loads
- URL shared with user — they can preview immediately

### Phase 3: Component Planning

- Features: Consultant Directory, Project Tracker, Document Library, Announcements
- Aesthetic: Minimal & Clean
- Mood: Professional & Trustworthy
- Component table presented and approved
- Design choices made: DM Sans + Space Grotesk, `#1e3a5f` primary, blue-gray palette

### Phase 4: Plan Approval

- Plan data assembled as a single JSON object
- Rendered to `docs/create-site-plan.html` via `render-createsite-plan.js`
- Opened in the user's default browser
- Brief summary shown in terminal with a pointer to the browser tab
- User approved via AskUserQuestion

### Phase 5: Implementation

- Todos created for each page, component, routing, navigation, design foundations
- Built in order: design tokens (replace defaults with chosen palette) → shared components → pages → router → nav
- Git commits after each major piece
- Playwright verified each page

### Phase 6: Accessibility Verification

- axe-core injected and run on all 4 pages via `browser_evaluate`
- Found 5 violations: 2 missing alt text, 1 insufficient contrast, 1 missing lang attribute, 1 skipped heading level
- All violations fixed in source code and committed
- Re-run confirmed zero critical/serious violations across all pages

### Phase 7: Review

- Summary table presented
- User reviewed at `http://localhost:5173`, requested minor color adjustment
- Adjustment applied, re-verified

### Phase 8: Deploy

- User chose to deploy → invoked `/deploy-site`
- Final summary presented with next step suggestions

---

**Begin with Phase 1: Discovery**
