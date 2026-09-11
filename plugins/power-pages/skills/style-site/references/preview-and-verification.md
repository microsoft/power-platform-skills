# Interactive preview and verification

Contents: [Preview contract](#review-artifact-contract) · [Request schema](#request-schema) · [Allowed CSS](#allowed-parts-and-declarations) · [CLI](#cli-contract) · [Iteration](#iterate-then-approve-the-exact-revision) · [Verification](#local-verification-checklist) · [Hook discovery](#hook-discovery-is-only-a-backstop) · [Handoff](#evidence-levels-and-later-handoff)

## Review artifact contract

Render the **requested components**, not a generic design gallery. Keep an unchanged **Before** view beside a **Proposed** view and show the target file, selector/hook, locale, scope, and affected pages.

- Use safe, resolvable static project markup when available. For Liquid, Dataverse forms/lists, unavailable templates, or other server output, show version-aware representative markup marked **Simulation** beside the component.
- Load local baseline styles in discovered order. Missing referenced baseline CSS, unknown ordering, or unknown/conflicting Bootstrap blocks preparation. Report resources omitted by the preview's safety rules, unavailable fonts, and simulated content as reduced fidelity; do not substitute Bootstrap or fetch a CDN.
- Sort applicable CSS Web File layers across the ancestor chain primarily by **global numeric display order**, with ancestry and path only breaking ties; append the selected page's CSS sidecar afterward. Do not append section styles after all root styles: a valid section custom file must remain between `theme.css` and `portalbasictheme.css` when its order permits. Unknown stylesheet orders stop preparation, not merely lower fidelity.
- Label ownership separately: **Studio-managed** values are a proposal for Studio, **Custom CSS** values map to local edits. A simulated Studio value must never leak into the applied CSS.
- Provide functional before/after comparison, desktop/mobile widths, reset, and relevant color, typography, spacing, radius, and shadow controls. Only expose controls with a defined, validated request mapping.
- Keep the preview shell isolated from site styles. Use inert/sanitized markup, sandboxed script-disabled component frames, context-safe encoding, and restrictive CSP. Never execute site scripts, Liquid, form submissions, external embeds, remote fonts, or external CSS URL requests.
- Keep controls and embedded/local assets usable offline. Do not require a package install, project build, or authenticated browser session for the preview.

Display prominently: **Local visual preview — not the Power Pages runtime. Liquid and Dataverse examples are simulations.**

## Request schema

The request is the editable input to `prepare-style-plan.js`, not the compiled plan. The authoritative validator and exports (`KINDS`, `PARTS`, `VALUES`) are in `${PLUGIN_ROOT}/scripts/lib/style-site-plan.js`; site relationships and paths come from `inspect-style-context.js`, backed by `${PLUGIN_ROOT}/scripts/lib/classic-site-style-context.js`. Unknown fields and unsupported CSS are rejected.

Optionally use an approved runtime URL to discover IDs/classes and reconcile them with local source as described in [runtime-dom-discovery.md](runtime-dom-discovery.md). Runtime evidence is separate discovery input, not a new request field or permission to use generated DOM IDs. The offline preview still uses local source and labeled samples; it never embeds captured runtime HTML or values.

| Field | Contract |
|---|---|
| `title` | Required nonempty text, maximum 240 characters |
| `pageId` | Required ID of the inspected preview page; select its intended localized content record, not a root with translated children |
| `components` | Required array of 1–30 component objects |
| `styles` | Required array of 1–100 style-group objects |
| `classEdits` | Optional array of at most 60 guarded class additions; omit or use `[]` when existing hooks suffice |

### Component objects

| Field | Contract |
|---|---|
| `id` | Unique identifier matching `^[a-z][a-z0-9-]{0,63}$` |
| `label` | Required nonempty display text, maximum 240 characters |
| `kind` | `section`, `text`, `button`, `image`, `navigation`, `form`, `list`, or `card` |
| `className` | Distinct namespaced hook matching `^pp-[a-z][a-z0-9-]{0,60}$`; not an arbitrary selector |
| `sourcePath` | Optional only for Studio-only samples; otherwise the existing site-relative page-copy or web-template source file |

**Every custom style requires a real `sourcePath` and actual class hook**, either already present or added through `classEdits`. A page source must belong to the selected localized `pageId`. A web-template source must be statically reachable through the chosen Page Copy's literal `include`/`extends`, its localized/root page-template-to-web-template relationship, or the website's configured header/footer template IDs; literal nested includes/extends are followed. An arbitrary unused template is not a valid target. Resolve dynamic or missing relationships explicitly before proceeding; there is no bypass flag.

A sample without source is allowed for a Studio-only proposal but cannot authorize custom CSS. **Every web-template target is a simulation, even if its source looks static**: local reachability does not prove Power Pages server rendering.

This supports **newly added components already present in the local export** and existing components. It does not create component markup, native form/list metadata, or Liquid manifests. If the component or hook cannot be resolved safely, complete that separate supported authoring task first. Native forms/lists and Liquid remain labeled simulations even when their real source is supplied.

### Style objects

| Field | Contract |
|---|---|
| `id` | Unique style-group identifier with the same identifier pattern as component `id`; also identifies its managed CSS block |
| `componentId` | Must reference one of the requested components |
| `owner` | `custom` for local CSS, or `studio` for a preview-only guided handoff |
| `scope` | `page`, `site`, or `section` |
| `targetId` | Optional; for `page`, the selected `pageId` (defaults to it); for shared CSS, an existing custom CSS Web File ID |
| `fileName` | For a **new** shared CSS Web File instead of `targetId`: lowercase, non-default name matching `^[a-z][a-z0-9-]{0,60}\.css$` |
| `parentPageId` | Required to place a new section stylesheet; choose its non-localized, non-site-root parent. With an existing section Web File, if supplied it must match that file's parent |
| `part` | Optional selector suffix from the exact allowlist below; omitted means the component wrapper itself |
| `declarations` | Required nonempty object of allowed CSS properties and **string** values below; no arbitrary CSS text |
| `rationale` | Required ownership/placement explanation, maximum 2,000 characters |
| `studioAction` | Required for `owner: "studio"`: exact Studio property/value instructions, maximum 2,000 characters |

A page-scoped style cannot target a different page/locale in the same request: create separate proposals. Shared styles must include the preview page in the Web File's inherited scope. Site scope requires a root-parented Web File; section scope requires the chosen non-root parent and includes its descendants.

Prefer an existing `targetId`, but **both existing and new custom Web Files** must have detected integer orders satisfying `theme.css < custom < portalbasictheme.css`. An existing file outside this band is rejected: ask the user to choose/configure an appropriate custom file without moving defaults, then reinspect and reapprove the changed proposal.

New shared CSS uses verified parent/publication/attachment metadata and a supported slot within that band. Unknown schema/relationships, collisions, or no safe slot **hard-stop**; never invent YAML, move defaults, or bypass preparation. New files for different site/section destinations must use **distinct CSS filenames** when they would resolve to the same physical path, even if their parent-page URLs differ. Multiple style groups can intentionally reuse one verified stylesheet; they cannot create competing records/assets at that path. Studio styles produce handoff placements, not local CSS writes or class additions.

### Guarded class additions

Each `classEdits` entry has exactly:

- `path`: the requested component's existing `sourcePath`, relative to the site.
- `match`: the **exact static opening tag**, on one line, which must resolve unambiguously in the source. No Liquid, comments, whole elements, or broad text replacement.
- `className`: that component's requested `pp-*` hook.

Supported tag names are `div`, `section`, `article`, `p`, `h1`–`h6`, `a`, `button`, `img`, `nav`, `ul`, `table`, and `span`. Existing class attributes must be quoted and unique; their tokens are preserved. Hook detection and edits parse static tags with quote-aware attribute boundaries: text resembling `class=` inside another quoted attribute is not a class hook. Do not replace this guard with regex/string matching against comments, scripts, or unrelated text. The edit only adds the class, never the component. A native form may use an existing supported wrapper; do not replace its `<form>` or generated controls to fit this list.

All source/edit paths must remain inside the inspected site; traversal, absolute paths, symlinks, generated CSS, ambiguous matches, and unrelated source targets are rejected. Keep request/proposal/export/preview/receipt paths outside the uploadable tree.

Preparation refuses source-owned output when the target has a sibling with the same basename and `.scss`, `.sass`, or `.less` extension, or its existing CSS contains `sourceMappingURL`, `generated file`, or `do not edit` markers. Hand off to a separately reviewed source-pipeline change using the site's existing compiler. Do not remove ownership markers, overwrite the output, or route around this refusal.

### Example request

Replace the placeholder page ID, path, and exact opening tag with inspection results. This example assumes native list header padding is not supported by that component's Studio controls; otherwise use a Studio-owned handoff instead.

```json
{
  "title": "Contact list header spacing",
  "pageId": "<resolved-localized-page-id>",
  "components": [
    {
      "id": "contact-list",
      "label": "Contact list",
      "kind": "list",
      "className": "pp-contact-list",
      "sourcePath": "web-pages\\contact\\content-pages\\Contact.en-US.webpage.copy.html"
    }
  ],
  "styles": [
    {
      "id": "contact-list-header",
      "componentId": "contact-list",
      "owner": "custom",
      "scope": "page",
      "part": " th",
      "declarations": { "padding": "0.75rem 1rem" },
      "rationale": "Adjust this native list's header spacing on the selected locale only, using its existing wrapper."
    }
  ],
  "classEdits": [
    {
      "path": "web-pages\\contact\\content-pages\\Contact.en-US.webpage.copy.html",
      "match": "<div class=\"contact-list\">",
      "className": "pp-contact-list"
    }
  ]
}
```

For a Studio-only sample, omit `sourcePath` and `classEdits`, set `owner` to `studio`, and supply `studioAction`; the declaration values still use the same allowlist. The preview exports `style-site-draft-request.json` in this **request shape**, not a plan or approval. Retain each exported revision under a distinct filename in the selected outside-site work directory before preparing it again.

## Allowed parts and declarations

`part` is appended to `.<className>`. These are the only accepted suffixes; preserve the leading space for descendant selectors:

| Target | Exact `part` strings |
|---|---|
| Component wrapper/states | `""`, `":hover"`, `":focus"`, `":focus-visible"`, `":active"`, `":disabled"` |
| Nested native buttons | `" .btn"`, `" .btn:hover"`, `" .btn:focus-visible"`, `" .btn:disabled"` |
| Nested native controls | `" .form-control"`, `" .form-control:focus"` |
| Table/content hooks | `" .table"`, `" th"`, `" td"`, `" label"`, `" img"` |

An allowed suffix is not proof that the actual component exposes that hook; inspect its variant and preserve native behavior. Arbitrary selectors, media queries, custom-property definitions, `@import`, URL values, `!important`, and injected declarations are not supported by this schema.

For the table below, a **length** is `0` or a nonnegative number with 1–3 integer digits and up to 3 fractional digits followed by `px`, `rem`, `em`, or `%`. **Spacing** is 1–4 such lengths separated by single spaces. There are no negative values, `calc()`, or arbitrary token expressions.

| CSS properties | Accepted string values |
|---|---|
| `color`, `background-color`, `border-color`, `outline-color` | 3/6-digit hex; `transparent`, `currentColor`, `inherit`; or `var(--token)` where the token starts with a letter and continues with letters, digits, `_`, or `-` |
| `border-radius`, `border-width`, `padding`, `margin` | Spacing |
| `gap`, `min-height`, `font-size`, `letter-spacing`, `outline-width`, `outline-offset` | Length |
| `width` | Length or `auto` |
| `max-width` | Length or `none` |
| `font-family` | `inherit`, `serif`, `sans-serif`, `monospace`, or `Georgia, serif` |
| `font-weight` | `normal`, `bold`, or `100` through `900` in steps of 100 |
| `line-height` | `normal`, or unitless `[1-3](\.[0-9]{1,3})?` |
| `text-align` | `start`, `end`, `left`, `right`, `center` |
| `border-style` | `none`, `solid`, `dashed`, `dotted` |
| `outline-style` | `solid`, `dashed`, `dotted` |
| `object-fit` | `cover`, `contain` |
| `opacity` | `0`–`1` with up to 3 fractional digits |
| `box-shadow` | `none`, `0 2px 8px #0000001a`, `0 8px 24px #00000026`, or `0 12px 32px #00000033` |

These are safety/compatibility bounds, not an unrestricted styling API. Unsupported properties, values, parts, source edits, metadata changes, or Sass compilation require a **separate manually reviewed workflow**. Explain the limitation; never loosen a validator, hand-edit the plan, or bypass the scripts. Responsive width controls test rendering at different widths; they do not export arbitrary breakpoint CSS.

## CLI contract

Use unique paths in the selected work directory outside the uploadable site tree. The caller chooses plan/preview filenames with `--out`; these artifacts use **exclusive create**, not overwrite. Each revised plan/preview needs a new filename, such as `plan-r2.json` and `preview-r2.html`. Preserve previous artifacts rather than deleting them to reuse a path.

The inspector writes JSON to stdout; preserve it with the host's file tools if needed. Inspect/prepare require `--siteRoot`; render can additionally confirm it. Apply/validate take the site identity from the hash-bound plan and **do not accept `--siteRoot`**.

```bash
node "${PLUGIN_ROOT}/skills/style-site/scripts/inspect-style-context.js" --siteRoot "<siteRoot>"
node "${PLUGIN_ROOT}/skills/style-site/scripts/prepare-style-plan.js" --siteRoot "<siteRoot>" --request "<workDir>/request.json" --out "<workDir>/plan.json"
node "${PLUGIN_ROOT}/skills/style-site/scripts/render-style-preview.js" --siteRoot "<siteRoot>" --plan "<workDir>/plan.json" --out "<workDir>/preview.html"
node "${PLUGIN_ROOT}/skills/style-site/scripts/validate-style-site.js" --plan "<workDir>/plan.json"
node "${PLUGIN_ROOT}/skills/style-site/scripts/apply-style-plan.js" --plan "<workDir>/plan.json"
```

The last command is a **dry-run**. After host approval of the exact `planHash`, apply and verify:

```bash
node "${PLUGIN_ROOT}/skills/style-site/scripts/apply-style-plan.js" --plan "<workDir>/plan.json" --apply --approvedHash "<approved-planHash>" --receipt "<workDir>/receipt.json"
node "${PLUGIN_ROOT}/skills/style-site/scripts/validate-style-site.js" --plan "<workDir>/plan.json" --receipt "<workDir>/receipt.json"
```

Preparation reports `planHash`; do not compute an alternative hash or edit the compiled plan. **`--receipt` is mandatory with `--apply`**, including an empty change set. Choose a new receipt path for each application attempt; an existing receipt is not overwritten. When there are no local changes (for example, a Studio-only proposal), explicit apply reports `no-local-changes` and creates only its external receipt, not site edits. Normally, entirely Studio-owned requests stop at proposal verification and handoff without needing that write command.

## Iterate, then approve the exact revision

1. Select a local work directory outside the uploadable site tree. Keep inspection output, draft selections, proposals, preview HTML, and receipts there; do not put them under a site's `web-files`, `web-pages`, or upload root. Preserve prior revisions.
2. Prepare a validated proposal with the supplied script and render that same proposal. The renderer and local apply must consume the same compiled change set; never maintain a separate hand-written approximation.
3. Open the generated HTML with the available local browser tooling. If automation is unavailable, give the user the file path to open manually and report which checks were not automated. If the user cannot review it, stop before approval/apply.
4. Let the user adjust controls and export draft selections. Import them as **untrusted input**, validate again, and regenerate the plan/preview. Exporting, clicking a preview button, or setting an imported “approved” field grants **no approval**.
5. Show the final rendered revision, complete local patch, proposal hash, Studio-only instructions, affected pages/locales, and fidelity warnings through the host conversation. Only the host's explicit Approval Gate can authorize application.
6. Any change to selections, source files, targets, ownership, scope, or compiled CSS invalidates approval. Surface the delta, regenerate, and request approval of the new hash. Repeat per revision, not once for an entire iteration loop.

Use the request/CLI contract above. The preview's export is a draft **request**: run prepare, validate, and render again before requesting consent to the resulting plan. Do not invent fields or flags, hand-edit a compiled plan, or bypass a validator to accept a browser export.

## Local verification checklist

Run dry-run and the independent validator **before application** with `validate-style-site.js --plan "<plan.json>"`. **After application**, run it again with `--plan "<plan.json>" --receipt "<receipt.json>"` and re-read the changed files through a separate read path. These explicit commands are mandatory and authoritative regardless of the chosen artifact directory or whether a hook runs.

| Check | Required evidence |
|---|---|
| Target identity | Explicit site, page/record relationships, locales, namespace, and scope match the reviewed proposal |
| Input integrity | Current file inventory and hashes match the reviewed snapshot (or receipt's expected post-apply state); added/deleted files and changed bytes stop validation, not just changes to old hash entries |
| Tracking isolation | Only known `site-settings/Site-AI-Skills-*.sitesetting.yml` and `Site-AI-Tools-*.sitesetting.yml` tracking files are excluded from style hashes/inventory; normal completion tracking does not invalidate the receipt, while other styling inputs remain checked |
| File integrity | Only approved files/managed blocks changed; unrelated edits, comments, line endings, IDs, Liquid, and Studio markers remain intact |
| Placement | Exact-page CSS uses the intended localized sidecar; Web File parents and descendant effects match approval |
| Ownership | Studio-only properties did not become custom declarations; default CSS files/order and framework assets did not change |
| Repeatability | Reapplication does not duplicate CSS, classes, metadata, or partial URLs |
| Preview consistency | Rendered proposal and compiled/applied CSS agree; controls, reset, export/re-import, and before/after views work |
| Responsive rendering | Check desktop and mobile widths, intermediate wrapping, long/localized content, overflow, and zoom/reflow |
| Accessibility | Preserve accessible names, keyboard order, visible focus, text/control contrast, reduced-motion behavior, and native semantics |
| Relevant states | Inspect hover/focus/disabled and representative error/empty/loading states; label any simulated state |
| Preview isolation | No project scripts, external requests, actual submissions, or third-party embeds execute |
| Recovery | Receipt identifies before/after hashes and original content; a failure reports exact partial local state without rolling back concurrent edits |

Use browser navigation, snapshot, resize, interaction, and screenshot tools where available. Report unsupported controls or missing state coverage instead of claiming success. Generated-source compilation is a separate reviewed authoring task, not an operation this request schema can apply; do not add tools merely to run these checks.

## Hook discovery is only a backstop

With no arguments, `validate-style-site.js` uses the plugin's shared `runValidation` wrapper. It only looks for:

- `<host cwd>/.powerpages-style/style-site.plan.json`
- Optional matching `<host cwd>/.powerpages-style/style-site.receipt.json`

This conventional directory **must be outside the uploadable `siteRoot`**. For example, the host can run in a workspace parent containing both the site download and its sibling `.powerpages-style` review directory. If the host cwd is the upload root, do not create this conventional directory there; select an outside work directory instead.

When the conventional plan does not exist, the hook approves without checking artifacts. When it exists, malformed/inconsistent plans, receipts, or local files block. A no-artifact approval is not proof of completion.

Hooks cannot infer an arbitrary `--out` location or revision filename. `plan-r2.json` does not become discoverable merely because an earlier `style-site.plan.json` was checked. Preserve prior artifacts and use the explicit validation commands for **the exact current plan and receipt** before/after apply; do not overwrite conventional files or bypass a blocking error to manufacture hook success.

## Evidence levels and later handoff

| Level | What can be claimed |
|---|---|
| Local static validation | Paths, metadata, hashes, selectors, scope, and patch consistency were checked |
| Local visual preview | Sanitized static content and labeled representative states rendered at the checked widths |
| Optional runtime DOM observation | The approved deployed page exposed the recorded IDs/classes and computed values at capture time; no submission, permission, future local-change or Studio-editability claim |
| Design Studio round-trip | **Only after separately performed checks:** native properties remain editable, component handles/markers work, and save/reopen preserves custom styling |
| Deployed runtime | **Only after separately authorized deployment/testing:** real Liquid, permissions, authentication, form submit, list filtering/paging, and dynamic loading work |

Leave post-change Studio/runtime checks explicitly **pending** at this skill's end. Report any earlier read-only runtime observation separately; it does not verify an unuploaded local patch. Provide exact Studio property/value instructions and a later checklist: compare a refreshed download safely; check component editability and locale; verify native behaviors at mobile/desktop widths; check actual computed-style winners. Do not claim a simulation proved any of these.

Do not invoke deployment, the Desktop site's Preview command, Studio Sync, or cache clearing. Cache differences can explain later discrepancies ([caching context](https://www.engineeredcode.com/blog/power-pages-many-layers-of-caching)), but are not permission to change remote state.
