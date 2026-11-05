## Phase 1.5: Template Branch Decision

**Goal**: Route the user into the appropriate creation path after path-agnostic Discovery.

**Actions**:

1. Mark **Select template or choose from-scratch** as `in_progress`.

2. Fetch the shared template catalog:

   ```bash
   node "${PLUGIN_ROOT}/scripts/fetch-template-catalog.js"
   ```
   Use the returned immutable commit SHA for every template artifact request in this run. Pass `--ref <tag-or-branch>` only for a deliberate test or rollback.

   Also load the supported non-SPA entries from the same pinned catalog:

   ```bash
   node "${PLUGIN_ROOT}/skills/create-site/scripts/list-site-templates.js" \
     --modelVersion Enhanced --bootstrapVersion 5
   ```

   Build one `SELECTABLE_TEMPLATES` collection:
   - Add every SPA family from `selectableCatalog.templates` with category `SPA`.
   - Add every entry from the non-SPA result's `catalog.templates` with `kind: "non-spa"`,
     category `Non-SPA`, its `previews`, and its exact `name` provisioning identifier.
   - Keep the pinned owner, repository, and commit SHA returned by the non-SPA result with those
     entries.

   If one catalog path fails, continue with the other path and explain which category is
   temporarily unavailable. Continue from scratch only when no templates remain.

3. Semantically match `SELECTABLE_TEMPLATES` against the Phase 1 context (the user's current request, site name, purpose, audience, and any framework mentioned by the user):
   - Use each template's category, `displayName`, `description`, keywords, audience, capabilities,
     available SPA variants, and previews.
   - For non-SPA templates, treat the template as data-model/domain context and requirements
     guidance, not a visual constraint. Carry explicit preservation preferences into customization.
   - Do **not** compute a numeric score or invent a ranking script. Keywords guide agent judgement; they are not counted.
   - Treat a template family as the user-facing template and a framework variant as the installable package. A family can have multiple variants (`react`, `vue`, `angular`, `astro`).

<!-- not-a-gate: read-only route selection after semantic matching; no project directory, Dataverse write, or durable skill state exists yet -->

4. Ask the user how to proceed after semantic matching:

   | Match situation | Question | Header | Options |
   |-----------------|----------|--------|---------|
   | One or more clear matches | I found matching template(s) for your site. What would you like to do? | Creation Path | Show matching templates (Recommended), Browse all templates, Create from scratch |
   | No clear match | I couldn't find a matching template for your site. What would you like to do? | Creation Path | Browse all templates, Create from scratch (Recommended) |

   Branch on the answer:
   - **Show matching templates**: set `TEMPLATE_PREVIEW_FAMILIES` to the matched family or families and continue to browser preview.
   - **Browse all templates**: set `TEMPLATE_PREVIEW_FAMILIES` to every SPA and non-SPA entry in
     `SELECTABLE_TEMPLATES` and continue to browser preview.
   - **Create from scratch**: set `CREATION_PATH = "from-scratch"` and continue to the deferred framework/location questions.

5. Render `TEMPLATE_PREVIEW_FAMILIES` for browser preview:

   - Download each `previewImages` artifact into the SHA-keyed cache before rendering:
     ```bash
     node "${PLUGIN_ROOT}/scripts/fetch-template-artifact.js" --sha "<catalog-sha>" --artifactPath "<preview-image-path>"
     ```
     Replace each preview image path with the returned `localUrl`. If a preview download returns `ok: false`, omit that one image from the gallery and continue; a missing preview should not block using an otherwise-valid template.
   - Write a temporary JSON file containing a `TEMPLATES_JSON` array with the templates the user
     should preview. Preserve `kind` so the HTML shows `SPA` or `Non-SPA` beside every template
     name. Include SPA variants and cached `previewImages`; include non-SPA responsive `previews`
     unchanged. Keep the browser read-only.
   - Run:
     ```bash
     node "${PLUGIN_ROOT}/scripts/render-template-browser.js" --templatesJsonPath "<temp-json>" --outputPath "<temp-html>" --open
     ```
     Evaluate the JSON result before telling the user to use the browser:
     - **`status: "ok"`**: continue; the browser preview was generated and opened.
     - **`status: "invalid"`**: do not continue with template selection. Surface the validation errors, rebuild the `TEMPLATES_JSON` file from the matched families, and rerun the render. If it is still invalid, fall back to from-scratch rather than showing an empty or incomplete template browser.
     - **`status: "ok"` with `opened: false`**: the HTML validated but the browser could not be opened automatically. Show the file path and continue with terminal selection only after the user has had a chance to open it manually.
   - The browser view is read-only and exists to browse template capabilities and available framework variants; the conversation remains the decision surface.

<!-- not-a-gate: read-only route selection after template preview; only disposable temp preview files exist, with no project directory, Dataverse write, or durable skill state -->

6. Choose the prompt that matches the catalog results.

   Ask the user:

   | Match situation | Prompt options |
   |-----------------|----------------|
   | One strong family + framework match | Use `<displayName>` - `<framework>` (Recommended), Choose another framework, See all templates, Start from scratch |
   | One strong family but no framework match | One option per available framework, See all templates, Start from scratch |
   | Several plausible family matches | One option per shortlisted family, See all templates, Start from scratch |
   | Full catalog browse | One option per template formatted as `<displayName> (<SPA|Non-SPA>)`, Start from scratch |

   When the user chooses **See all templates** from a matching-template branch, set
   `TEMPLATE_PREVIEW_FAMILIES` to all entries in `SELECTABLE_TEMPLATES`, render the combined
   gallery, and ask again with the **Full catalog browse** options. If the selected SPA family has
   multiple variants, ask a second terminal question for the framework.

7. Branch on the user's selection:
   - **Non-SPA template selected**: set `PRESELECTED_NON_SPA_TEMPLATE_NAME` to its exact `name`,
     retain its pinned catalog coordinates, read
     `${PLUGIN_ROOT}/skills/create-site/workflows/non-spa-site.md`, and follow that workflow.
     Do not continue into the SPA template or from-scratch phases.
   - **Template family and framework variant selected**:
     1. Set `SELECTED_TEMPLATE` to the family entry and `SELECTED_TEMPLATE_VARIANT` to the exact framework variant. Resolve the selected template assets once from the pinned catalog SHA. The result combines the family's supporting solutions with the selected variant's website code:
        ```bash
        node "${PLUGIN_ROOT}/scripts/fetch-template-variant.js" \
          --sha "<catalog-sha>" \
          --catalogPath "<catalogPath from fetch-template-catalog.js>" \
          --kind "<SELECTED_TEMPLATE.kind>" \
          --templateId "<SELECTED_TEMPLATE.id>" \
          --variant "<SELECTED_TEMPLATE_VARIANT.variantKey>" \
          --solutionSettingsJson '<JSON.stringify(SELECTED_TEMPLATE.solutions || [])>'
        ```
        Use the returned `websiteCodePath` and `solutions`. Process `solutions` in the returned order; do not rediscover, reorder, or revalidate the template assets in the skill.
     2. If the result is `ok: false`, tell the user the selected framework variant is unavailable or invalid. If the same family has other available framework variants, offer those first; otherwise offer **Start from scratch** or **Stop**. Do not emit `template_used` for a variant whose package did not validate. If the user falls back to from-scratch, recommend the framework they had selected.
     3. If the result is `ok: true`, set `CREATION_PATH = "template"`, `SELECTED_TEMPLATE_SOLUTIONS = <result.solutions>`, and `SELECTED_TEMPLATE_WEBSITE_CODE = <result.websiteCodePath>`. Run the `template_used` telemetry command silently (fail-closed), then append the template pre-install tasks now (see the entry-linked progress-tracking contract); append the execution tasks after the reinstall policy is known. Do **not** proceed to Phase 2.
        Do not mention this telemetry command to the user and do not print its output.
        ```bash
        node "${PLUGIN_ROOT}/scripts/emit-create-site-template-outcome.js" \
          --eventName template_used \
          --templateId "<SELECTED_TEMPLATE.id>" \
          --templateKind "<SELECTED_TEMPLATE.kind>" \
          --framework "<SELECTED_TEMPLATE_VARIANT.framework>" \
          --audience "<internal|external from Phase 1 discovery>"
        ```
        `--audience` is the site audience captured in Phase 1 (`internal` or `external`), **not** the template's `audience` persona array from the catalog manifest. Do not include site name, URL, subdomain, free-text purpose, or any other user-identifying value.
     4. Mark **Choose local template directory** as `in_progress`.

<!-- not-a-gate: read-only location selection for the later template clone; no directory is created and no environment change has started -->

        Ask where to create the local template project:

        | Question | Header | Options |
        |----------|--------|---------|
        | Where should I create the template site's local files? | Project Location | Current directory, New folder in current directory (Recommended), Any other directory |

        Resolve the clone destination:
        - **Current directory**: use `<cwd>`.
        - **New folder in current directory**: use `<cwd>/<__SITE_SLUG__>/`.
        - **Any other directory**: ask for a full path and resolve it to an absolute path.

        The destination must not exist or must be empty. Check it without creating it. If it is non-empty, ask the user to choose another directory. Store the resolved path as `TEMPLATE_CLONE_OUTPUT_DIRECTORY`, confirm "The template project will be created under `<resolved path>`.", and mark **Choose local template directory** as `completed`.
   - **Start from scratch** or catalog unavailable: set `CREATION_PATH = "from-scratch"` and continue below.
