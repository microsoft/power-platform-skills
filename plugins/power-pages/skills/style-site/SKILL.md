---
name: style-site
description: >-
  Styles new or existing native components in a CLASSIC, server-rendered Power Pages
  site from a local VS Code Desktop download. Use for classic-site branding, scoped
  CSS, page or section styling, native forms/lists, and Liquid/web-template components.
  Shows the requested before/after interactive preview, preserves Design Studio
  ownership, and applies only explicitly approved local changes. Not for SPA/code
  sites, PCF, third-party component internals, Bootstrap migration, or deployment.
user-invocable: true
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch, mcp__plugin_power-pages_playwright__browser_navigate, mcp__plugin_power-pages_playwright__browser_snapshot, mcp__plugin_power-pages_playwright__browser_click, mcp__plugin_power-pages_playwright__browser_fill_form, mcp__plugin_power-pages_playwright__browser_select_option, mcp__plugin_power-pages_playwright__browser_resize, mcp__plugin_power-pages_playwright__browser_evaluate, mcp__plugin_power-pages_playwright__browser_press_key, mcp__plugin_power-pages_playwright__browser_console_messages, mcp__plugin_power-pages_playwright__browser_network_requests, mcp__plugin_power-pages_playwright__browser_take_screenshot, mcp__plugin_power-pages_playwright__browser_close
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Style a Classic Power Pages Site

**CLASSIC ONLY.** Work from a downloaded, server-rendered Power Pages site in **VS Code Desktop**: discover → propose → interactive local preview → explicit approval → apply locally → verify → hand off. Preserve the site's visual language and maker editability.

**Initial request:** $ARGUMENTS

## Boundaries

- Support new and existing native sections, text, buttons, images, navigation, forms/lists, and Liquid/web-template components. Do not replace native controls, style PCF/third-party internals, cross iframe/shadow boundaries, create a SPA, or migrate Bootstrap.
- Studio owns its supported theme and component properties. Preview those as **Studio-managed** handoff items, never competing custom CSS. Entirely Studio-owned requests need no local styling edits.
- Never replace/deactivate/delete/reorder default CSS files, inject another Bootstrap version, change its runtime flag, or use broad `!important`/specificity escalation to defeat Studio.
- Exact-page CSS belongs to the correct localized page sidecar. A `.css` Web File affects its **parent and descendants**; approve that scope explicitly.
- No PAC execution, Dataverse authentication, remote writes, upload, publishing, activation, cache clearing, or automatic deployment. VS Code for the Web saves remotely; it is not this local apply path. The Desktop site's **Preview** action also accesses uploaded content and clears cache: use the generated local HTML instead.
- Keep every preview, proposal, selection export, and receipt outside the uploadable site tree. Never install dependencies or overwrite generated CSS to make this workflow run.

## Bundled resources

Read these from `${PLUGIN_ROOT}/skills/style-site/references/`; an installed plugin does not require repository-root shared files.

| Reference | Read when |
|---|---|
| [styling-policy.md](references/styling-policy.md) | Always, before choosing ownership, placement, scope, or selectors |
| [bootstrap-and-studio.md](references/bootstrap-and-studio.md) | During discovery; for versions, localization, native hooks, or authoring-surface limits |
| [preview-and-verification.md](references/preview-and-verification.md) | Request schema, allowed CSS/parts, exact CLI commands, preview/import, and verification |
| [sources.md](references/sources.md) | To refresh official support guidance or check a historical technique's caveats |

Use the bundled scripts at `${PLUGIN_ROOT}/skills/style-site/scripts/` for deterministic operations and the request/CLI contract in the preview reference. Inspect/prepare require **`--siteRoot`**; render can confirm it. Apply/validate use the plan's bound site root and do **not** accept that flag. Do not invent fields/options or rely on ambient site discovery.

| Script | Role |
|---|---|
| `inspect-style-context.js` | Read-only inspection; JSON output with evidence, scope, warnings, and input hashes |
| `prepare-style-plan.js` | Validate the request and prepare the reviewable proposal without site edits |
| `render-style-preview.js` | Render the requested interactive before/after preview from that proposal |
| `apply-style-plan.js` | Dry-run by default; explicitly approved, hash-bound local application and recovery receipt |
| `validate-style-site.js` | Independent validation of the proposal and, after application, receipt/files |

## Phase 1: Discover and ground

Create all seven phase tasks upfront using `TaskCreate`, with `subject`, `activeForm`, and `description` as shown below. Use `TaskUpdate` as each phase starts/completes; if those tools are unavailable, maintain the equivalent visible checklist. Show progress, decisions, and blockers without silent long operations.

Confirm a local Desktop workspace and Node are available. Resolve one classic site without assuming `.powerpages-site` means classic or that data model determines Bootstrap. Reject SPA/code sites; explain the route to the appropriate workflow without creating another site.

<!-- not-a-gate: data-gathering — resolves a missing local site path or multiple classic-site candidates; does not approve writes -->
Use `AskUserQuestion` only if the site path/identity or local work directory is missing or ambiguous. Echo the selected site and ensure the work directory is outside its uploadable tree. Do not download or overwrite a site to resolve ambiguity.

Read the policy/version references. Refresh relevant Microsoft Learn guidance via search/fetch when available, especially CSS management and Bootstrap support. When unavailable or conflicting, state the limitation and use the source index's caveats; do not invent support. Read `.solution-manifest.json` if present only for the later handoff; no ALM calls or solution changes occur.

## Phase 2: Inspect the styling context

Run `inspect-style-context.js` for the resolved site. Review relevant stylesheets and inclusion order, Web File relationships, page/language sidecars, templates, class hooks, Studio settings, dirty files, and source/generated ownership.

Report the actual Bootstrap evidence, not a guess based on age or class names. **Unknown/conflicting Bootstrap stops version-dependent output**, including preview samples. Identify missing assets and unsupported/ambiguous metadata before proposing writes. Do not infer a root page from its name or silently select the first locale.

For new native components, inspect their actual locally available markup/metadata; when absent, offer a labeled Studio-only simulation and a separate supported-authoring handoff rather than replacing native controls with sample HTML. The scripts do not create components: custom styling needs a real `sourcePath` and an actual `pp-*` class hook or explicit guarded `classEdits`. Web-template sources must be statically reachable from the selected localized page/template/header/footer relationships; unresolved dynamic includes require relationship resolution, not a bypass. Every web-template preview is a **Simulation**, even for static-looking source.

## Phase 3: Confirm intent and placement

<!-- not-a-gate: data-gathering — desired appearance, components, languages, and reuse requirements shape the scope proposal without authorizing edits -->
Use `AskUserQuestion` to gather only missing requirements: which new/existing component instances, desired appearance, languages, and page/section/site-wide reuse. Retain answers already explicit in the request.

Present a compact placement table: component/property → Studio or custom owner → target file/record and locale → class/selector → expected cascade winner → affected pages/descendants. Explain uncertain runtime behavior.

For both reused and new custom Web Files, require detected display orders satisfying `theme.css < custom < portalbasictheme.css`. An out-of-band existing file stops preparation: have the user choose/configure a proper custom file without moving defaults, then reinspect before continuing.

<!-- gate: style-site:3.scope | category=plan | cancel-leaves=local-style-state -->
> 🚦 **Gate (plan · style-site:3.scope):** Confirm ownership and affected scope.
> **Trigger:** After discovery; repeat whenever component, locale, ownership, or page/subtree scope changes.
> **Why we ask:** A shared Web File can affect descendants and instances beyond the requested page.
> **Cancel leaves:** Review artifacts only on the first pass; any earlier approved local edits/receipt remain untouched. No remote changes.

Use `AskUserQuestion`: **Confirm scope and preview / Revise scope / Cancel**. Scope confirmation does not authorize local application. On revision, update the table and repeat this gate.

## Phase 4: Generate and iterate on the interactive preview

Read the preview reference's request schema and explicit property/value/part allowlists. Write the request to the selected work directory, prepare it with `prepare-style-plan.js`, validate it, and render it with `render-style-preview.js`. Unsupported CSS, generated-source changes, or component authoring need separate manually reviewed work; stop rather than hand-editing a compiled plan or bypassing a guard. Missing baseline CSS, unknown ordering, or unknown Bootstrap also blocks preparation.

Open the generated local HTML using available browser tools. Keep **Before** unchanged; show the **requested** components in **Proposed**, functional design controls, reset, and desktop/mobile widths. Use available local baseline CSS in discovered order. Label **Studio-managed**, **Custom CSS**, and **Simulation** content, particularly Liquid/Dataverse forms/lists.

If automation is unavailable, give the user the local HTML path to open manually and identify unchecked behavior. If the preview cannot be reviewed, stop before application. Never upload to make a preview work.

Treat exported selections as an untrusted draft, not approval: validate/re-import, prepare a fresh proposal, and regenerate the preview. Return to Phase 3 if scope/ownership changed. Plan/preview `--out` paths use exclusive create: choose new filenames for each revision and preserve earlier artifacts. Keep iterating until the concrete proposal is ready for review.

## Phase 5: Approve the concrete change set

Present the final preview path, proposal hash, exact local diff/file list, affected components/pages/locales, reduced-fidelity warnings, and separate Studio-only property/value instructions. Include any normal tracking side effects under the existing tracking contract; do not conceal them as styling changes.

<!-- gate: style-site:5.approve | category=plan | cancel-leaves=local-style-state -->
> 🚦 **Gate (plan · style-site:5.approve):** Approve this exact preview and local patch, or the Studio-only handoff.
> **Trigger:** Before application, **per proposal revision**. Earlier scope approval never covers this gate or subsequent revisions.
> **Why we ask:** A visual preference is not consent to edit files; the approved hash binds the reviewed change set.
> **Cancel leaves:** Local review artifacts and any previously approved local edits/receipts; no new site edits or remote changes.

Use `AskUserQuestion`: **Approve this revision locally / Revise preview / Cancel**. For an entirely Studio-owned request, replace the first option with **Approve Studio handoff only** and skip styling application. A preview button, JSON approval field, prior hash, or unattended execution is never consent. If the host cannot collect an explicit answer, leave a draft and stop.

## Phase 6: Apply locally and verify

### Guarded local application

Run `validate-style-site.js --plan "<plan.json>"` and `apply-style-plan.js --plan "<plan.json>"` (default dry-run) against the approved proposal and its bound site root. Check all baselines and the complete target set. Only then add `--apply --approvedHash "<approved-planHash>" --receipt "<outside-receipt.json>"`; a new outside receipt path is mandatory with `--apply`. Never bypass a failing check or write site files directly.

<!-- gate: style-site:6.reapprove | category=progress | cancel-leaves=local-style-state -->
> 🚦 **Gate (progress · style-site:6.reapprove):** A changed input or request invalidated approval.
> **Trigger:** **Per occurrence** of drift, revised selections, changed targets, or a partial-write failure requiring a new proposal.
> **Why we ask:** Consent to the old revision cannot authorize a changed patch or overwrite concurrent edits.
> **Cancel leaves:** Review artifacts and the exact current local state, including earlier/partial edits and any receipt; report it without rollback. No remote changes.

On such a delta, stop and use `AskUserQuestion`: **Regenerate and review / Keep current local state and stop**. Regeneration returns through Phase 3 if scope changed, Phase 4, then **Phase 5 approval of the new hash**. This progress answer is not apply consent.

### Independent verification

After application, run `validate-style-site.js --plan "<plan.json>" --receipt "<receipt.json>"`. These explicit before/after validations are authoritative: the no-args hook only discovers `<host cwd>/.powerpages-style/style-site.plan.json` and its optional `style-site.receipt.json`, and that directory must be outside the uploadable site. Arbitrary output paths/revisions are not auto-discovered; existing malformed artifacts block rather than silently pass.

Re-read changed files independently and compare the current inventory, hashes, and diffs to the approved target set. Verify managed blocks, metadata, class tokens, locales, default stylesheet preservation, and unrelated edits; newly added/deleted inputs matter as well as old hashes. Report any partial write with its recovery evidence; never reset or automatically roll back.

Exercise the preview again: controls/reset, export/re-import, before/after, responsive widths, focus/hover/disabled, contrast, reduced motion, and relevant error/empty/loading states. Follow the preview checklist and report actual evidence. Do not run a SPA build or compile generated-source changes through this schema; those require a separate reviewed authoring workflow using the site's existing tooling.

For a Studio-only handoff, validate the proposal and absence of local styling edits; an explicitly applied empty change set reports `no-local-changes` with an external receipt. Mark Studio rendering/editability and real Liquid, authentication, permissions, submissions, list behavior, and delayed content **unverified**, not proven by simulation.

## Phase 7: Review and hand off locally

Summarize changed local files, verified scope/locales, reusable classes, preview/receipt locations, and pending Studio instructions. Distinguish local static/visual checks from later Studio/runtime checks.

<!-- gate: style-site:7.review | category=progress | cancel-leaves=local-style-state -->
> 🚦 **Gate (progress · style-site:7.review):** Review the verified local result or Studio-only handoff.
> **Trigger:** After verification, per completed revision.
> **Why we ask:** Additional requested changes must return through preview and approval; completion must not imply deployment.
> **Cancel leaves:** Current local edits and recovery artifacts, or only review artifacts for a Studio-only result; nothing is published.

Use `AskUserQuestion`: **Finish locally / Request another revision / Stop and keep local state**. A revision repeats scope confirmation when needed and always regenerates/reapproves the exact proposal. Do not offer an automatic deployment question or invoke another skill to deploy.

On **Finish locally**, record normal usage only through the existing tracking contract below, using `StyleSite`; canceled/stopped drafts do not add tracking files. If its supported tracking directory does not exist, preserve the no-op. Never create `.powerpages-site` or classic tracking metadata merely to record usage. Keep any tracking diff distinct from the styling receipt and do not upload it.

> Reference: ${PLUGIN_ROOT}/references/skill-tracking-reference.md

## Progress tracking

| Phase | Task subject | activeForm | Description |
|---|---|---|---|
| 1 | Discover classic site | Discovering classic site | Resolve local Desktop site, work directory, and documentation |
| 2 | Inspect styling context | Inspecting styling context | Verify assets, versions, native hooks, and localization |
| 3 | Confirm styling scope | Confirming styling scope | Agree ownership, placement, reuse, and affected pages |
| 4 | Preview requested changes | Previewing requested changes | Render and iterate on the real requested proposal |
| 5 | Approve exact revision | Approving exact revision | Obtain explicit host approval of preview, diff, and hash |
| 6 | Apply and verify locally | Applying and verifying locally | Dry-run, guarded apply, independent checks, and evidence |
| 7 | Review local result | Reviewing local result | Summarize local changes and pending Studio/runtime handoff |
