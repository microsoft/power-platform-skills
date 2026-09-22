---
name: customize-declarative-site
description: >-
  Plans and coordinates broad customization of a newly created or existing PAC CLI-downloaded declarative
  Power Pages site, including Enhanced data model sites created from Microsoft templates and
  sites created manually in Design Studio. Use for multi-part requests that combine pages,
  localized content, navigation, assets, snippets, Liquid/web templates, page layouts, or
  styling. Produces an approved browser-viewable plan, invokes the specialized declarative
  authoring skills in dependency order, verifies the combined local result, and optionally
  hands off to deployment. For one narrow component change, use the owning authoring skill
  directly. Not for React, Angular, Vue, or Astro code sites.
user-invocable: true
allowed-tools: Read, Write, Grep, Glob, Bash, WebSearch, AskUserQuestion, Skill, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Customize a Declarative Power Pages Site

Coordinate a coherent local customization across the specialized declarative authoring skills.
Do not duplicate their PAC metadata, identity, serialization, or validation rules.

**Initial request:** $ARGUMENTS

Read:

- `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`
- `${PLUGIN_ROOT}/references/site-design-quality.md`
- `${PLUGIN_ROOT}/skills/customize-declarative-site/references/customization-plan-contract.md`
- `${PLUGIN_ROOT}/skills/customize-declarative-site/references/content-and-page-compositions.md`
- `${PLUGIN_ROOT}/skills/customize-declarative-site/references/visual-asset-planning.md`

For new-site design or requested styling, also read:

- `${PLUGIN_ROOT}/skills/style-site/references/design-quality.md`

## Ownership

This skill owns:

- selecting one downloaded declarative site;
- understanding the complete customization intent;
- resolving cross-skill dependencies;
- generating and obtaining approval for one customization plan;
- invoking the owning skills in dependency order;
- independently checking the combined local result;
- committing coherent customization units;
- offering deployment after local verification.

It does not directly author webpage, snippet, web-file, web-template, page-template, or styling
records when an owning skill exists. It does not upload, activate, or modify Dataverse directly.
No dev server, live preview, or generated styling mockup is required. The HTML below is an
approval document, not a rendering of the site; local checks cannot prove Studio/runtime appearance.

## Progress tracking

Create these tasks before starting:

| Task subject | Active form | Description |
|---|---|---|
| Discover declarative site | Discovering declarative site | Select and validate one PAC-downloaded declarative site |
| Gather customization intent | Gathering customization intent | Resolve pages, content, assets, languages, preservation, and visual direction |
| Prepare customization plan | Preparing customization plan | Build persistent JSON and browser-viewable HTML plan artifacts |
| Approve customization plan | Reviewing customization plan | Review and approve the complete coordinated local plan |
| Execute customization | Customizing declarative site | Invoke owning authoring skills in dependency order |
| Verify customization | Verifying customization | Validate component results, combined references, diff, and Git state |
| Complete customization | Completing customization | Commit coherent changes, report local/live state, and offer deployment |

## Phase 1: Discover and validate the site

1. Follow the shared declarative discovery contract. Accept a site root that is the current
   directory or a nested directory such as `.powerpages-site/`.
2. Require `.portalconfig/`, non-empty `website.yml`, and at least one declarative component
   directory. Reject `powerpages.config.json`-only code sites.
3. If several valid sites remain and request/workspace evidence does not identify one, ask the
   user to choose. Never select the first filesystem result.
4. Read the site identity, configured languages, existing pages, navigation,
   snippets, web files, web templates, page templates, CSS sources, Bootstrap evidence, logos,
   favicons, existing page imagery, and the exact callers of site-wide brand assets.
   For a `creationIntent: "new-site"` handoff, revalidate `verifiedBootstrapMajor` against actual
   downloaded asset evidence with the create-site validator's `--bootstrapVersion` option.
   Never infer Bootstrap from a template name or silently migrate an existing site.
5. Treat missing component directories as readiness findings. Do not create directories merely
   to make a planned operation appear supported.
6. Establish the local comparison baseline before creating plan artifacts:
   - when no Git repository exists, initialize one at the narrowest project root containing the
     selected site and commit only the verified downloaded baseline as
     `Initial declarative site baseline`;
   - when Git exists, record the starting commit and pre-existing dirty paths;
   - never absorb unrelated or pre-existing dirty files into customization commits.
7. Define `<PROJECT_ROOT>` as the repository root that owns the selected site. For the normal
   nested layout it is the parent of `.powerpages-site/`; for a direct-root download it is that
   site root itself.
8. If `docs/customize-declarative-site/current-plan.json` or
   `docs/customize-declarative-site/current-execution.json` exists, validate the pair against the
   selected website identity. Offer to resume the first ready pending operation when its request
   still matches the user's intent; otherwise prepare a new plan.

## Request routing

Use the smallest route that fully satisfies the request:

- one narrow component change: invoke the owning authoring skill directly;
- one straightforward page: use the lightweight path, normally `author-webpage` with one resolved
  page-content composition;
- multiple pages or cross-component dependencies: use the complete orchestration below;
- explicit new-site design handoff: use the complete orchestration, even for a one-page site,
  so visual direction, image delivery, structure, and final styling remain coordinated;
- SPA/code site: stop and explain that this skill is declarative-only.

Do not generate a broad plan or invoke every owner merely because they are available.

## Phase 2: Gather customization intent

Use the initial request and existing template before asking questions. Do not ask again for
information already established.

For a broad or underspecified request, collect:

- existing pages to preserve or modify;
- new pages, routes, parent relationships, and requested navigation;
- visitor-facing content and languages;
- assets, reusable snippets, Liquid templates, and custom layouts;
- template preservation level: preserve layout and update content/branding, retain structure but
  add pages/sections, or substantially redesign;
- aesthetic and mood for new-site design or requested visual customization.

For `creationIntent: "new-site"`, design the complete visitor experience rather than just
preserving the Microsoft baseline's appearance. Reuse the shared quality reference to choose a
coherent typography system, role-based palette, spacing rhythm, responsive composition, and
meaningful hero/supporting imagery. Make context-specific design decisions without asking for
every font or color. Preserve platform behavior, native editable wrappers, navigation and
authentication; preserving those contracts does not require preserving generic template styling.
Existing-site and narrow edits remain preservation-first unless redesign is requested.
Set `newSiteDesign.imageDelivery: "external-url"` for every new-site creation handoff. Add images
using approved direct HTTPS URLs in native image components; do not download them, create image
Web Files, or schedule image-import operations. Suitable existing template images may remain.

Apply the content reasoning and example page-compositions reference. Inspect similar pages first,
derive a content outline and supported `section -> columns -> elements` structure, draft safe
explanatory copy, and identify only organization-specific facts that require confirmation.

Apply the visual-asset reference whenever imagery, branding, icons, illustrations, patterns, or
fonts could materially improve the requested design. Resolve delivery first: new-site image
additions use user-approved hosted image URLs or curated Unsplash direct URLs. Existing-site file
imports can still use user-provided files, original safe SVGs, and staged photography. Do not add an
asset merely to fill space. Do not generate raster images or use another stock provider.
For a new-site design, include at least one relevant content photograph or original illustration
with an actual page placement; a logo, favicon, icon, or decorative divider alone is insufficient.
An explicit user choice to omit imagery is the only exception, recorded in `newSiteDesign`.

<!-- not-a-gate: compact clarification gathers missing content and layout inputs; Phase 4 approves the plan -->

When material inputs remain, ask once with the unresolved business facts plus compact choices for
content source, navigation placement, locales, layout reuse versus proposal, whether styling
changes are in scope, and only the unresolved asset decisions: approved brand files, permission
to use Unsplash photography, and preserve/supply/propose/no-change logo direction. Prefer
site-derived defaults and do not repeat known information.

Generate context-aware feature choices from the selected template and current site. Do not offer
a capability whose required local structure is absent without presenting the missing prerequisite
and remediation. Do not promise declarative form/list or data-model authoring unless a verified
owning skill supports the requested operation.

## Phase 3: Resolve and prepare the plan

1. Resolve stable existing identities before planning: exact paths, IDs, routes, locale records,
   template bindings, image URLs, applicable asset hashes/provenance, and caller relationships.
   For `delivery: "external-url"`, record the final HTTPS `externalUrl`, license basis, placements,
   alt text and `preparation: { "status": "remote" }`. Put the exact URL in the consumer's static
   inputs, with no Web File output binding. Review hosting/hotlink permission, privacy and known
   CSP `img-src` restrictions; report unknown runtime behavior honestly, and never change CSP
   implicitly. Do not call the staging helper for these images.
   Only assets intentionally delivered as new Web Files are prepared through
   `scripts/prepare-declarative-asset.js`. Keep approved bytes in the project-local ignored asset
   cache and record the returned hash, MIME type, dimensions, filename, and cache path. Do not
   write staged bytes directly into the declarative site.
2. Divide the request into the smallest coherent operations owned by:
   `author-web-file`, `author-content-snippet`, `author-web-template`,
   `author-page-template`, `author-webpage`, `author-webpage-content`, and `style-site`.
3. Order operations by actual dependencies, not by skill name. Assets/snippets/templates normally
   precede their consumers; webpage metadata must create an exact localized copy file before
   `author-webpage-content` fills it; styling runs after structural authoring.
4. Follow the plan contract and write a schema-version-1 JSON plan, including the complete
   `assets` manifest and, for a new-site handoff, the complete `newSiteDesign` brief, into a fresh external review directory
   outside the selected site root. Do not replace the canonical approved plan during review.

   ```text
   <REVIEW_DIR>/plan.json
   ```

   Use the `<PROJECT_ROOT>` resolved in Phase 1. Use a new review directory for every revision so
   the renderer never overwrites reviewed bytes.
   New-site styling operations must depend on all structural operations, directly or transitively.
   Plan page/section/site placement through `style-site`; do not replace Bootstrap, `theme.css`,
   or `portalbasictheme.css`, flatten native markup, or install a second CSS framework to achieve
   code-site visual quality.
5. Never write free-form unresolved values such as `TBD`, `heroImage`, `appropriate page`, or
   `choose a snippet`. Use typed `outputBindings` for values produced by earlier operations;
   otherwise resolve the value or stop with the exact missing input.
6. Render the browser plan:

   ```bash
   node "${PLUGIN_ROOT}/scripts/render-customize-declarative-site-plan.js" \
     --output "<REVIEW_DIR>/plan.html" \
     --data "<REVIEW_DIR>/plan.json"
   ```

   If either review filename exists, create a fresh review directory instead of overwriting it.
7. Open the rendered HTML with the OS-native default-browser launcher. A launch failure does not
   invalidate the plan; print the exact path as a fallback.

## Phase 4: Approve the plan

Present a short terminal summary and direct the user to the HTML for the complete user-facing
proposal: pages and navigation, content and page compositions, assets and reusable components,
styling, preservation decisions, warnings, verification, and the local/live boundary. The default
HTML view describes visible outcomes rather than authoring-skill mechanics. A collapsed technical
implementation trace may expose operation IDs, owning skills, dependencies, bindings, and exact
targets for maintainers; the validated JSON remains the execution source of truth.

<!-- gate: customize-declarative-site:4.approve | category=plan | cancel-leaves=plan-artifacts -->

> 🚦 **Gate (plan · customize-declarative-site:4.approve):** Approve the coordinated
> customization plan before invoking any authoring skill.
>
> **Trigger:** JSON and HTML plan artifacts are complete.
> **Why:** The next phase can create or modify several related declarative records.
> **Cancel leaves:** External review artifacts only; the downloaded site and current approved plan
> remain unchanged.

Use `AskUserQuestion`:

| Question | Header | Options |
|---|---|---|
| Does this declarative-site customization plan look good? | Customization plan | Approve and customize, Revise plan, Cancel |

On revision, create a fresh review directory, render and open it, and repeat approval. Never edit
the rendered HTML as the source of truth.

After approval, publish the approved JSON:

```bash
node "${PLUGIN_ROOT}/scripts/promote-customize-declarative-site-plan.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --data "<APPROVED_REVIEW_DIR>/plan.json"
```

The publisher validates the approved JSON, renders canonical HTML from that exact data, creates
`current-execution.json`, and records hashes plus a run ID. When a current approved run exists, it
archives the plan, HTML, execution receipt, and icon together before replacement. Use only the
published current plan and execution receipt for child-skill coordination.

## Phase 5: Execute through owning skills

For each ready operation:

1. Run the execution helper with `--action resolve`; it blocks until dependencies are complete and
   returns the operation plus effective `resolvedInputs` combining approved static inputs with
   actual bound outputs.
2. Mark the operation `start`, then pass that resolved operation and, when returned, its approved
   `designContext` to its owning skill. The shared brief supplies Bootstrap and visual direction,
   not permission to change unrelated records or bypass the owner's approval.
3. Include the exact selected site root, action, target identity, locales, final values, callers,
   and preservation requirements. The operation may be expressed as structured YAML/JSON or
   unambiguous natural language; it must resolve the same decisions as the plan contract.
4. Tell the child skill to revalidate every supplied path and existing ID before writing.
5. After completion, re-read the changed files, write actual stable outputs to a temporary JSON
   object, and mark the operation `complete --outputs <path>`. Remove that temporary file after the
   receipt is updated.
6. On failure, mark the operation `fail` with the concise error and stop. Do not silently adapt
   dependent operations to an unapproved structural change. On a later session, inspect any
   partial files before restarting that failed operation; never blindly replay it.
7. After all operations complete, run the execution helper with `--action finish`.

Use `author-webpage` for page records, routes, parents, template assignment, localized shells, and
requested navigation. Let it invoke `author-webpage-content` when it owns the resolved page
handoff. Invoke `author-webpage-content` directly only when one exact existing localized target
file and its composition are already resolved.
Carry the verified Bootstrap major through the page-owner handoff into section/element authoring.
Use Bootstrap 5 serialization for the verified new-site default and the inspected site-local
Bootstrap 3 patterns only for the explicit compatibility path.

For every staged visual asset, invoke `author-web-file` before its consumers and record the
verified `publicUrl`. Dependent page, snippet, template, or styling operations must consume that
URL through an approved `outputBindings` entry; never predict a Web File URL. For a global logo or
favicon, update only the exact verified snippet, template, or setting caller. Do not replace the
whole header merely to change a logo, and preserve navigation, search, language selection,
sign-in behavior, and authenticated/anonymous branches.

For external images, pass the exact approved HTTPS URL directly to the native content owner.
Follow **External image** in the image-component reference; keep responsive sizing and localized
alt text, and do not invent local filenames or Web File `name` attributes. External CSS image
URLs also belong in `style-site`'s exact `externalResources` review. `style-site` does not fetch
them or replace the image component.

For styling, invoke `style-site` last. Its exact-diff/hash approval is a separate binding between
the user-reviewed CSS proposal and the bytes applied; the customization-plan approval does not
replace that safety gate.

Do not invoke a child skill for an empty operation, and do not invoke deployment from this phase.

## Phase 6: Verify the combined result

1. Require every child skill's own verification to succeed.
2. Re-run declarative site discovery and confirm the selected root and website identity are
   unchanged.
3. Verify planned files and records exist, generated identities are unique, locale scope matches
   the plan, dependencies resolve, and unrequested callers/content remain unchanged. For Web File assets,
   verify the approved SHA-256, file/YAML pair, MIME type, dimensions, public URL, localized alt
   text, caller placement, and absence of unapproved SVG active content or Design Studio
   placeholders.
   For external images, verify the caller's decoded URL equals the approved `externalUrl`, alt
   text and layout/crop intent are present, and no image cache, binary, YAML or import operation
   was introduced. The plan hashes the URL, not mutable remote bytes; availability and CSP remain
   pending runtime checks unless separately performed.
4. Review the complete Git diff against the approved plan. Unexpected component categories or
   unrelated changes block completion. Classify `docs/customize-declarative-site/**` separately as
   orchestration evidence; it is not a PAC component category and is not uploaded.
5. Run the create-site declarative validator when a website record ID is available:

   ```bash
   node "${PLUGIN_ROOT}/skills/create-site/scripts/validate-site.js" \
     --projectRoot "<PROJECT_ROOT>" \
     --websiteRecordId "<WEBSITE_RECORD_ID>"
   ```

   For `newSiteDesign`, append `--bootstrapVersion "<newSiteDesign.bootstrapMajor>"`.
6. For a new-site design, compare the result with every approved brief decision and image
   placement: approved image URLs and callers (or reused existing assets), meaningful localized alternative text, responsive
   sizing/crops, readable text on every intended surface, and consistent hierarchy/spacing.
   Reuse `style-site`'s local contrast checks and resolve known failures. Report desktop/mobile
   rendering, Studio save/reopen, and unknown image-overlay contrast as pending separate live
   checks; do not start a server or claim local validation proves visual fidelity.

## Phase 7: Commit, report, and offer deployment

Commit coherent customization units rather than combining the untouched template baseline with
new work. Do not commit unrelated pre-existing changes.

Report:

- site identity and local root;
- current approved plan, HTML, and execution paths, plus any archived predecessor;
- created and modified components grouped by owning skill;
- languages and routes affected;
- validation and commit results;
- warnings and pending runtime checks;
- explicit state: local customization is not live until deployment succeeds.

<!-- gate: customize-declarative-site:7.deploy | category=plan | cancel-leaves=local-customization -->

> 🚦 **Gate (plan · customize-declarative-site:7.deploy):** Choose whether to dispatch the
> verified local declarative project to `/deploy-site`.
>
> **Trigger:** Local customization and combined verification succeeded.
> **Why:** Deployment has its own environment and final-upload consent gates.
> **Cancel leaves:** Verified local customization and commits.

Ask: **Deploy these declarative-site changes now?** Options: **Deploy now**, **Keep changes
local**. On deploy, invoke `/deploy-site` with the exact project root. Otherwise finish with the
local/live distinction.

Record normal successful usage as `CustomizeDeclarativeSite` through
`${PLUGIN_ROOT}/references/skill-tracking-reference.md`.
