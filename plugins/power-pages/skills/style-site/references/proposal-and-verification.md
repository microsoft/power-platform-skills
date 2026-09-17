# Proposal review and verification

Read this for general/raw CSS, global themes, external resources, justified priority, inline edits or repeated tags. Routine declarations use [quick-start.md](quick-start.md); this reference adds no mandatory browser round trips.

Contents: [Review contract](#review-artifact-contract) · [Request schema](#request-schema) · [Inline edits](#guarded-inline-declarations) · [General CSS](#general-css-authoring) · [Raw CSS examples](#raw-responsive-animation-and-token-example) · [CLI](#cli-contract) · [Iteration](#iterate-then-approve-the-exact-revision) · [Verification](#local-verification-checklist) · [Hook discovery](#hook-discovery-is-only-a-backstop) · [Handoff](#evidence-levels-and-later-handoff)

## Review artifact contract

Prepare **only the exact plan and JSON diff review**; do not generate HTML, samples, a local server or a browser audit. Show the target files, selectors/hooks, locale, scope, affected pages, ownership, warnings and hash through the conversation/editor.

- Keep complete, ordered baseline CSS evidence. Missing referenced CSS, unknown ordering, or unknown/conflicting Bootstrap still blocks preparation; never substitute Bootstrap or fetch a CDN.
- Inspect applicable Web Files by global numeric display order across the ancestor chain, with ancestry/path as tie-breakers, then the selected page's CSS sidecar. A section file does not outrank `portalbasictheme.css` merely because it belongs to a descendant.
- Default to **local authoring for both listed and unlisted Studio properties**. The capability map describes Design-panel availability, not exclusive ownership. Prefer an existing static inline declaration for a component-specific change; otherwise use effective scoped CSS or add a quoted style attribute when that is the correct component representation, not for every reusable style.
- For directly addressable component roots and root states, preparation blocks stylesheet values that would lose to existing inline properties, with guidance to edit the local inline declaration. Exact already-equal inline values are permitted. Raw CSS cannot bypass these conflicts. Descendant/generated targets still require explicit source/cascade review; this guard is not a complete cascade analysis.
- Keep **explicitly requested Studio instructions-only** property/value instructions separate from local writes. Never compile a handoff into CSS, or invent a handoff to mark blocked local work complete.
- Review every affected instance of a reusable class; exact-page scope does not imply a single element. Preserve local source, native components and Liquid instead of inventing rendered output.
- Review parser warnings separately from Studio-support warnings, plus external URLs, shared identifiers, global effects and priority reasons. **Every `style.css` request takes expanded review**, including scoped raw CSS, for selectors/conditions/global definitions. So do `global: true`, nonempty `externalResources` or `importantReason`. Global rules can affect **all matching elements** in every page within the placement scope.
- Distinguish source/diff evidence from rendering: local validation cannot establish the future effective cascade, responsive behavior, dynamic output or Studio save/reopen compatibility.

## Request schema

The request is the editable input to the coordinator's `prepare` operation (or diagnostic `prepare-style-plan.js`), not the compiled plan. The request validator is in `${PLUGIN_ROOT}/scripts/lib/style-site-plan.js`; site relationships and paths come from `inspect-style-context.js`, backed by `${PLUGIN_ROOT}/scripts/lib/classic-site-style-context.js`. Unknown request fields are rejected. CSS uses pinned bundled **css-tree** structural parsing, not a skill-specific property/value enum or selector-part allowlist. Read [General CSS](#general-css-authoring) for syntax, semantic warnings and safety boundaries.

Optionally use an approved runtime URL to discover IDs/classes and reconcile them with local source as described in [runtime-dom-discovery.md](runtime-dom-discovery.md). Runtime evidence is separate discovery input, not a new request field or permission to use generated DOM IDs. Never capture runtime HTML or values, or treat observation of the deployed page as verification of unuploaded changes.

For runtime collection, `--out` requires `--siteRoot` and writes a new external `.js` containing an `async(page)` wrapper, for `browser_run_code_unsafe.filename` only when file execution and the path are already permitted by the host. Without `--out`, stdout is the collector function for `browser_evaluate.function`; **`browser_evaluate.filename` saves results, not collector input**. File-mode stdout contains only `{path,bytes}`. Preserve exact URL/query, role, scope, and context approval; do not reuse consent after context changes. Structure-only output has `computedStyles: {}` without computing styles: absent properties are unobserved, not zero/default values. See the runtime reference for the complete invocation contract.

| Field | Contract |
|---|---|
| `title` | Required nonempty text, maximum 240 characters |
| `pageId` | Required ID of the inspected page anchoring source/locale/scope checks; select its intended localized content record, not a root with translated children |
| `components` | Required array of 1–30 component objects |
| `styles` | Required array of 1–100 style-group objects |
| `classEdits` | Optional array of at most 60 guarded class additions; omit or use `[]` when existing hooks suffice |

### Component objects

| Field | Contract |
|---|---|
| `id` | Unique identifier matching `^[a-z][a-z0-9-]{0,63}$` |
| `label` | Required nonempty display text, maximum 240 characters |
| `kind` | Required nonempty descriptive text, maximum 120 characters; for example, `image`, `video`, `carousel`, `accordion`, or `site-theme`. Metadata, not a capability/authoring allowlist. |
| `className` | Distinct namespaced hook matching `^pp-[a-z][a-z0-9-]{0,60}$`; not an arbitrary selector. Required for component-scoped stylesheets; may be omitted for inline-only, explicit global-stylesheet or user-requested Studio-only descriptors. If supplied for inline work, it must identify the actual tag, existing or added through approved `classEdits`. |
| `sourcePath` | Existing site-relative Page Copy or reachable web-template source. A source-free descriptor is allowed **only** for explicit global stylesheets or user-requested Studio handoffs. |

Never infer a Studio family from `kind`; descriptive metadata does not authorize component creation or entering internals. Existing source, scope and lifecycle guards still apply.

**Component-scoped local styles require a real `sourcePath`**. Their stylesheet groups require an actual class hook, existing or added through `classEdits`; inline groups require an exact static tag. A page source must belong to the selected localized `pageId`. A web-template source must be statically reachable through the chosen Page Copy's literal `include`/`extends`, its localized/root page-template-to-web-template relationship, or the website's configured header/footer template IDs; literal nested includes/extends are followed. An arbitrary unused template is not a valid target. Resolve dynamic or missing relationships explicitly before proceeding; there is no bypass flag.

An explicit `global: true` raw stylesheet needs no fictitious `pp-*` class/source hook, but still needs the selected page and verified placement relationships, baseline CSS and scope review. It does not authorize markup edits or invent stable native selectors. Local template reachability does not prove Power Pages server rendering, even if its source looks static.

This supports **newly added components already present in the local export** and existing components. It does not create component markup, native form/list metadata, or Liquid manifests. A missing custom hook alone is not a blocker: try a guarded class addition with [source context](#context-for-repeated-opening-tags) before declaring repeated tags ambiguous. If the actual component/source cannot be resolved safely, complete that separate supported authoring task first. Actual form/list and Liquid behavior remains pending separate runtime verification.

### Style objects

| Field | Contract |
|---|---|
| `id` | Unique style-group identifier with the same identifier pattern as component `id`; also identifies its managed CSS block |
| `componentId` | Must reference one of the requested components |
| `owner` | **Required**: `custom` for local authoring (the default guidance for listed and unlisted properties), or `studio` only for an explicitly requested instructions-only handoff |
| `location` | Optional for local styles: `stylesheet` (default) or `inline`. Omit for Studio handoffs. |
| `inlineTarget` | Required for `location: "inline"`: the exact existing static opening tag (may span lines), maximum 8,000 characters, in the component's verified `sourcePath`; omit for other groups |
| `inlineContext` | Optional for inline groups only: exact adjacent `before`/`after` source text, with the same [context contract](#context-for-repeated-opening-tags) as class additions |
| `scope` | `page`, `site`, or `section` |
| `targetId` | Stylesheet only: optional; for `page`, the selected `pageId` (defaults to it); for shared CSS, an existing custom CSS Web File ID |
| `fileName` | For a **new** shared CSS Web File instead of `targetId`: lowercase, non-default name matching `^[a-z][a-z0-9-]{0,60}\.css$` |
| `parentPageId` | Required to place a new section stylesheet; choose its non-localized, non-site-root parent. With an existing section Web File, if supplied it must match that file's parent |
| `part` | Optional selector suffix for stylesheet `declarations`; any stable descendant/state/pseudo-element part that stays inside the verified component subtree. Omission means the wrapper. Inline permits omission or `""` only; raw `css` must omit it. |
| `declarations` | Nonempty object of general CSS property names and **string** values, including `--custom` properties, kept in authored/insertion order. **Only for `location: "inline"`**, `null` explicitly removes that exact existing inline property. Removal-only inline groups are valid. Use this or `css`, never both; Studio groups require declarations and reject null. |
| `css` | Alternative full stylesheet string, only for `owner: "custom"` with stylesheet location; no `part` or `declarations`. Always expanded review for selectors, conditions and global definitions, even when component-scoped. |
| `global` | Optional `true` for raw CSS only: intentionally permits global selectors/shared names in the existing page/site/section placement scope; expanded review, never implicit. |
| `externalResources` | Optional array of exact external HTTPS URLs referenced by CSS, such as `["https://styles.example.com/brand.css"]`; nonempty arrays require expanded review. Declarations/raw CSS share this contract. URLs/warnings are hash-bound, not fetched by the compiler. |
| `importantReason` | Optional nonempty explanation permitting explicitly justified `!important` in authored CSS; requires expanded diff review. Not a bypass for inline conflicts, source safety or approval. |
| `rationale` | Required ownership/placement explanation, maximum 2,000 characters |
| `handoffReason` | Required for `owner: "studio"`; the only allowed value is `"user-requested"`. Native support or a local blocker is not a reason. Omit for local styles. |
| `studioAction` | Required for `owner: "studio"`: exact Studio property/value instructions, maximum 2,000 characters. Omit for local styles. |
| `studioComponent` | Optional actual native component name from the [Design-panel map](studio-component-capabilities.md), maximum 120 characters; applies to this group's target, including a child selected by `part`. Unknown names stay unverified; never infer from descriptor `kind`. Omit for site-theme/other-surface handoffs. |
| `studioFlex` | Optional confirmed `"available"` or `"unavailable"` Flex-tab status; requires `studioComponent`. Omit when not verified; do not infer from Bootstrap. |

Preparation derives property classifications and Studio-support warnings from the bundled map; warnings are part of the hashed plan. Review includes `studioSupport`; show its warnings at approval, and retain apply's warnings in the final report. Listed and unlisted properties are eligible for safe `owner: "custom"` edits. Unlisted properties do not justify a fictional `owner: "studio"` Design-panel handoff. Unknown/conditional support is labeled explicitly. Requests without a Design-panel identity stay unverified, not silently mapped by `kind`. Never promise that custom CSS values populate native controls.

A page-scoped style cannot target a different page/locale in the same request: create separate proposals. Shared stylesheet styles must include the selected page in the Web File's inherited scope. Stylesheet site scope requires a root-parented Web File; section scope requires the chosen non-root parent and includes its descendants. Inline scope follows source placement as defined below, not Web File metadata.

Prefer an existing `targetId`, but **both existing and new custom Web Files** must have detected integer orders satisfying `theme.css < custom < portalbasictheme.css`. An existing file outside this band is rejected: ask the user to choose/configure an appropriate custom file without moving defaults, then reinspect and reapprove the changed proposal.

New shared CSS uses verified parent/publication/attachment metadata and a supported slot within that band. Unknown schema/relationships, collisions, or no safe slot **hard-stop**; never invent YAML, move defaults, or bypass preparation. New files for different site/section destinations must use **distinct CSS filenames** when they would resolve to the same physical path, even if their parent-page URLs differ. Multiple style groups can intentionally reuse one verified stylesheet; they cannot create competing records/assets at that path. Explicitly requested Studio styles produce handoff placements, not local writes or class additions.

### Guarded inline declarations

Use `owner: "custom", location: "inline"` to update the actual static component declaration rather than emit stylesheet CSS that loses to it. `inlineTarget` must match **exactly one existing static opening tag**, maximum 8,000 characters, in the component's verified source; use `inlineContext` to disambiguate repeated tags. Static opening tags and CSS values may span lines; match whitespace and CRLF/LF exactly, including newlines inside quoted style values. No Liquid in the target tag. Adding a quoted `style` attribute is permitted when none exists and this is the right component representation. General CSS declarations are supported; the exact-tag/context/hash guard is not permission for arbitrary DOM replacement or stylesheet text inside a style attribute.

- Page Copy edits require `scope: "page"` and the **exact selected locale**. Statically reachable shared-template edits require `scope: "site"` and expanded review, conservatively disclosed as potentially affecting **every page**; never imply page isolation from reachability alone.
- Inline groups must have no nonempty `part` and must omit `targetId`, `fileName`, `parentPageId`, `handoffReason` and `studioAction`, as well as raw `css`/`global`. Use the same general CSS `declarations` syntax as stylesheet groups. `studioComponent`/`studioFlex` describe support, not permission.
- Inline-only components may omit `className`; component-scoped stylesheet groups still require verified `pp-*` hooks or guarded class additions. Explicit global stylesheets are the separate source-free exception. If supplied on an inline component, the class must identify that actual tag, already present or added through approved `classEdits`.
- Multiple property groups targeting the same tag must not overlap properties. `classEdits.match` and every `inlineTarget` can refer to the **original exact tag**: do not chain them against an imagined intermediate edit. Generated `kind: "markup"` writes combine class and inline edits and are reconstructed/validated from the approved request. Existing class-only writes retain `kind: "class"`.
- To compose class/inline edits on one tag, use the same original context on every group (`context` for class edits, `inlineContext` for inline groups). Different guards resolving to the same tag are rejected as overlapping, not applied sequentially.
- Preserve all unrelated markup, inline declarations, Liquid, IDs, accessibility attributes, classes and Studio editing markers. Do not rewrite the DOM or replace native components.
- Parse/encode quoted fonts, HTML entities, CSS comments and escapes safely rather than rejecting valid CSS solely for using them. The raw style attribute is decoded/encoded with the entities codec. **Only that attribute may normalize entity spelling**; the rest of the tag/document is preserved exactly, apart from separately approved class additions. Never manually interpolate unescaped CSS into HTML or reserialize the whole page.
- Existing inline `!important` may be preserved on the **same requested property** without a new priority justification. Authored priority changes require `importantReason` and expanded review; do not blindly escalate to avoid the actual local declaration. Ambiguous/malformed/injected styles and conflicting related `!important` shorthand/longhand rules still block with local remediation, even when a reason is supplied.
- For responsive/state styling that cannot work beneath a winning inline declaration, explicitly remove that exact existing property with `declarations: {"property": null}` in an inline group and add the scoped CSS in the **same approved plan**. Null is a removal directive, **not a CSS value**, and is rejected in stylesheet declarations and Studio handoffs. Removal-only inline groups are valid; do not substitute an empty string, `initial`, or a blanket style-attribute deletion.
- Preserve every other inline property, attribute/marker and priority. Removing a shorthand removes its **whole declaration**, not one implied longhand: preserve any needed longhands in the planned styles and review the actual diff/cascade. This is general inline-ownership resolution, not a gradient exception. Exact tag/context/source/hash guards and approval still apply.
- If a static source or safe property edit cannot be established, report **blocked local work** with the exact missing source/anchor or separate local source-repair task. Do not convert it into a successful zero-write Studio handoff.

#### Inline example: native image treatment

For a request covering `Circle-1.png`, `Circle-2.png` and `Circle-3.png`, radius, shadow and border can all be authored locally, including the Image properties listed in the Design panel. The following shows **one placeholder image**, not an inspected user page. Replace every placeholder and exact tag from local inspection; add separate verified components/groups for the other images. Do not create image markup or infer tags from filenames.

```json
{
  "title": "Circle image treatment",
  "pageId": "<resolved-localized-page-id>",
  "components": [{
    "id": "circle-image",
    "label": "Circle image",
    "kind": "image",
    "sourcePath": "web-pages\\example\\content-pages\\Example.en-US.webpage.copy.html"
  }],
  "styles": [{
    "id": "circle-treatment",
    "componentId": "circle-image",
    "owner": "custom",
    "location": "inline",
    "inlineTarget": "<img src=\"/Circle-1.png\" alt=\"Example image\" style=\"border-radius: 8px;\">",
    "scope": "page",
    "studioComponent": "Image",
    "declarations": {
      "border-radius": "50%",
      "box-shadow": "0 12px 32px #00000033",
      "border-width": "1px",
      "border-style": "solid",
      "border-color": "#ffffff"
    },
    "rationale": "Update the verified native image declaration on the selected locale; preserve its other attributes."
  }]
}
```

#### Inline removal and responsive CSS in one request

Replace this placeholder source/tag with inspected local evidence. The inline group only removes the existing fixed width; the radius and other attributes remain. The companion raw stylesheet handles responsive sizing in the same approved plan and takes expanded review. Do not remove a winning declaration first and request approval for its replacement later.

```json
{
  "title": "Responsive image sizing",
  "pageId": "<resolved-localized-page-id>",
  "components": [{
    "id": "responsive-image",
    "label": "Responsive image",
    "kind": "image",
    "className": "pp-responsive-image",
    "sourcePath": "web-pages\\example\\content-pages\\Example.en-US.webpage.copy.html"
  }],
  "styles": [{
    "id": "remove-fixed-width",
    "componentId": "responsive-image",
    "owner": "custom",
    "location": "inline",
    "inlineTarget": "<img class=\"pp-responsive-image\" src=\"/example.png\" alt=\"Example image\"\n  style=\"width: 320px;\n    border-radius: 12px;\">",
    "scope": "page",
    "studioComponent": "Image",
    "declarations": { "width": null },
    "rationale": "Remove only the verified fixed inline width so the companion responsive rules can apply; preserve the radius and all other attributes."
  }, {
    "id": "responsive-width",
    "componentId": "responsive-image",
    "owner": "custom",
    "scope": "page",
    "studioComponent": "Image",
    "css": ".pp-responsive-image { width: 100%; max-width: 32rem; }\n@media (max-width: 40rem) { .pp-responsive-image { max-width: 100%; } }",
    "rationale": "Replace fixed sizing with scoped responsive CSS on the selected locale in the same reviewed plan."
  }]
}
```

### Guarded class additions

Each `classEdits` entry has:

- `path`: the requested component's existing `sourcePath`, relative to the site.
- `match`: the **exact static opening tag**, maximum 8,000 characters, which may span lines and must resolve unambiguously in the source. Preserve exact whitespace/newlines. No Liquid, comments, whole elements, or broad text replacement.
- `className`: that component's requested `pp-*` hook.
- Optional `context`: exact adjacent source strings as defined below.

Static source editing supports real rendered tags, including `input`, `textarea` and SVG, not a fixed div/section/img list. **Only class/style attributes change; embedded contents are never entered.** Outer local iframe/embedded elements may be styled under the same source guards. The source tokenizer skips `iframe`/`noembed`/`noframes`/`xmp` contents like `textarea`/`script`/`style` contents: tag-shaped text inside them is not a local DOM target. Runtime-discovery exclusions remain unchanged. Existing class attributes must be quoted and unique; tokens are preserved. Hook detection uses quote-aware boundaries: text resembling `class=` inside another quoted attribute is not a class hook. Do not replace these guards with first-match regexes, enter iframe/PCF internals or replace native controls to fit a wrapper.

#### Context for repeated opening tags

For identical column wrappers, supply `context` on each class edit or `inlineContext` on each inline group. The object permits only optional string fields `before` and `after`; omitted fields mean `""`, and at least one must be nonempty. The combined window `before + match/inlineTarget + after` must be at most **16,000 characters** and occur **exactly once in that source file**. The middle tag must also be a real parsed opening tag. No global occurrence numbers, guessed `nth-child`, broad Bootstrap selectors, captured runtime HTML or first-match fallback.

Copy adjacent text from the **original local source**, preserving whitespace, CRLF/LF and quoting. A unique following heading or image path often suffices. If repeated content also needs an ancestor, include the exact prefix from its unique section through the target, or widen the suffix; context can include other tags/Liquid but is never edited or executed. Tag-shaped strings inside attributes, comments, script/style/textarea/title/iframe/noembed/noframes/xmp content or Liquid expressions cannot become targets. A dynamic target tag still blocks. Context in private requests/full reviews may contain source content; keep these artifacts outside uploads and telemetry.

Different contexts distinguish identical opening tags; matching contexts compose edits to the same tag. Preparation resolves all guards against the original source and changes only approved opening tags. The context is hash-bound, checked again by both preflights and retained in the full review (`classEdits` or `styles`). Source drift requires refreshed targets and a new proposal/approval, never edited plan hashes. Reapplying an already-applied plan remains idempotent; old request contexts spanning other changed tags may need refreshing before a new proposal.

**Example: three columns with a shared surface.** This illustrates general CSS and repeated-tag targeting, not a gradient-specific exception. These are placeholder local targets, not inspected user content. Replace page/path/tags/contexts with actual source. The example assumes the three suffixes are unique and no inline background blocks stylesheet CSS. It reuses one class/treatment only on those three columns; use separate components/classes for different treatments.

```json
{
  "title": "Feature column surfaces",
  "pageId": "<resolved-localized-page-id>",
  "components": [{
    "id": "feature-columns",
    "label": "Services, Resources and Support columns",
    "kind": "section",
    "className": "pp-feature-column",
    "sourcePath": "web-pages\\home\\content-pages\\Home.en-US.webpage.copy.html"
  }],
  "styles": [{
    "id": "feature-fill",
    "componentId": "feature-columns",
    "owner": "custom",
    "scope": "page",
    "studioComponent": "Section",
    "declarations": {
      "background-color": "#17324d",
      "background-image": "linear-gradient(135deg, #17324d 0%, #285b70 100%)"
    },
    "rationale": "Reuse a page-local surface treatment on only the three verified feature columns; inspect child foregrounds separately."
  }],
  "classEdits": [
    {
      "path": "web-pages\\home\\content-pages\\Home.en-US.webpage.copy.html",
      "match": "<div class=\"col-md-4 columnBlockLayout\">",
      "context": { "after": "\r\n<h3>Services</h3>" },
      "className": "pp-feature-column"
    },
    {
      "path": "web-pages\\home\\content-pages\\Home.en-US.webpage.copy.html",
      "match": "<div class=\"col-md-4 columnBlockLayout\">",
      "context": { "after": "\r\n<h3>Resources</h3>" },
      "className": "pp-feature-column"
    },
    {
      "path": "web-pages\\home\\content-pages\\Home.en-US.webpage.copy.html",
      "match": "<div class=\"col-md-4 columnBlockLayout\">",
      "context": { "after": "\r\n<h3>Support</h3>" },
      "className": "pp-feature-column"
    }
  ]
}
```

The Design-panel map does not list `background-image` for Section: show its warning and continue with safe local authoring, not a Studio handoff. Review child text/button contrast and any necessary companion foreground edits before approval; this surface-only example is not a readability pass.

All source/edit paths must remain inside the inspected site; traversal, absolute paths, symlinks, generated CSS, ambiguous matches, and unrelated source targets are rejected. Keep request/proposal/review/receipt paths outside the uploadable tree.

Preparation refuses source-owned output when the target has a sibling with the same basename and `.scss`, `.sass`, or `.less` extension, or its existing CSS contains `sourceMappingURL`, `generated file`, or `do not edit` markers. Hand off to a separately reviewed source-pipeline change using the site's existing compiler. Do not remove ownership markers, overwrite the output, or route around this refusal.

For Page Copy/templates, an explicit leading HTML comment banner containing `generated file` or `do not edit` also blocks markup updates. Make a separately reviewed local-source-pipeline change instead; do not remove the banner or convert the blocker into Studio-only success.

### Example request

Replace the placeholder page ID, path, and exact opening tag with inspection results. This local stylesheet example is appropriate only when no winning inline header-padding declaration prevents it. Design-panel support for a whole list is unverified; retain the warning rather than borrowing the Text family's controls or forcing a handoff.

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

For explicitly requested Studio instructions, a source-free descriptor may omit `sourcePath`, `className` and `classEdits`; set `owner` to `studio` and supply `handoffReason: "user-requested"` plus `studioAction`. Declaration values use the same CSS syntax parser, but verify the actual Studio control/value before writing instructions. Native support alone cannot justify this request. Explicit global raw stylesheets are the only other source-free case. Retain revised requests under distinct filenames in the outside-site work directory.

## General CSS authoring

Author any Power Pages-supported CSS using standard CSS syntax, **not a skill-specific property/value/enum allowlist**. General declarations cover custom properties, font stacks, multiple shadows, sizing/layout, negative lengths where valid, transforms, transitions, all gradient kinds and browser-standard functions such as `var()`, `calc()`, `clamp()` and color functions. Linear, radial, conic and repeating gradients, multiple background layers and color-stop forms are ordinary CSS, not individually granted exceptions.

Keep new declarations in **authored/insertion order, not alphabetical order**: shorthands can reset earlier longhands. Do not sort request keys or reorganize raw CSS rules/declarations to make a diff look tidier. Shorthand-effects protection uses pinned **mdn-data**, with logical-side safety; conflicting important shorthand/longhand effects still require local remediation, not a bypass.

The pinned bundled css-tree parser checks CSS structure without fetching resources or requiring npm installs in the plugin/site. **Parser grammar support is not proof of Power Pages, browser or Studio rendering.** Unknown properties or semantic-grammar-unverified values produce explicit warnings. Fix actual invalid values, including misspelled properties, or verify newer browser support before approving. Do not bypass parser errors or equate missing parser grammar with unsupported Power Pages CSS. Malformed/injected syntax and legacy executable CSS fail; a warning is not permission to ignore invalid CSS.

For stylesheet `declarations`, `part` is appended to `.<className>` and structurally checked for component containment. Arbitrary stable descendant/state/pseudo-element parts are allowed, not a closed `PARTS` list: for example `" h2"`, `" h3"`, `":focus-visible"` or `" .card > .badge::before"`. Preserve the leading space for descendants. Scope every selector to the component's verified `pp-*` class subtree; a selector must not escape to siblings or unrelated elements. Inspect native generated targets and their actual cascade rather than inventing hooks or treating a successful parser result as evidence of source correspondence.

### Raw stylesheets and intentional global rules

Use `style.css` instead of `declarations` for a full stylesheet. It is local stylesheet-only, must omit `part`, and always takes expanded review, even without global rules. Do not wrap it in HTML `<style>` tags. Normal CSS supports responsive `@media`, `@supports`, `@container`, selectors, keyframes with reduced-motion alternatives, `@font-face` and Web File fonts, tokens, `@property` and layers. All ordinary selectors still stay in the verified component subtree by default; keyframe step selectors are not DOM selectors.

Use `global: true` only with raw CSS for intentional page/site/section themes. It permits global rules within the **existing placement scope**, not permission to edit every file. Disclose effects on **all matching elements** in those pages, inherited locales/descendants, shared names and imported rules; use expanded review. A global descriptor may omit `sourcePath` and `className` rather than fabricate a component hook. Native generated selectors still need source/cascade inspection. Preserve default assets/order and Bootstrap context.

Namespace new keyframe/font/property/layer identifiers with `pp-`/`--pp-`, or explicitly use `global: true` and review their shared naming/collisions. Classes do not isolate named resources: a scoped animation can still conflict with another keyframe name. Use new custom-property tokens or references intentionally; do not assume native Studio exposes the same tokens. Layers are normal CSS, but their cascade order is not a shortcut around protected defaults or winning inline styles.

**Layer-priority warning:** within the same author origin, unlayered normal Power Pages default/theme CSS outranks normal `@layer` rules regardless of selector specificity or stylesheet order. Do not blindly put default overrides into new layers; honor the actual layer/unlayered architecture. `@layer` remains supported, with layer conflicts disclosed at review rather than treated as a feature prohibition. Inspect existing layer order and unlayered winners before choosing placement; neither higher specificity nor a later file reverses this normal-declaration priority. Keep protected defaults/order and inline guards intact; do not blindly add `!important`. See [CSS layer ordering](https://www.w3.org/TR/css-cascade-5/#layer-order).

### Resources and priority

Declare exact external HTTPS CSS URL references in `externalResources`; relative, root-relative and fragment Web File URLs need no external declaration. No protocol-relative URLs, JavaScript/file schemes, unreviewed external tracking/font/image URLs or embedded data payloads; use approved Web Files for data instead. Review each resource's CSP requirements, availability, licensing and privacy implications before approval. The exact external URLs and warnings are hash-bound; a URL declaration is disclosure, not approval or a promise of availability. **The compiler performs no runtime fetch**, and browser/network access is not a prerequisite.

Imported CSS requires `global: true`, declared external resource URLs when external, and valid beginning-of-stylesheet `@import` placement. Inspect existing content/order; a new custom CSS file can avoid a late import, but still requires valid metadata and the protected custom band. Do not automatically fetch imports; review the imported source and any transitive resource/scope effects from available evidence, or disclose what remains unverified. Approval never authorizes silently adding later imports or URLs.

`importantReason` is optional nonempty text permitting explicitly justified priority in authored CSS, with expanded diff review of each priority effect. Preserve existing important flags on the same requested inline property without adding a new one. Do not blindly add `!important` to work around native inline ownership; global/broad important rules are discouraged. Raw CSS and a reason cannot bypass root inline conflicts, conflicting important shorthands, source guards or approvals. Fix the local winning declaration rather than claiming success for ineffective CSS.

For visual treatments or color/typography changes, use [design-quality.md](design-quality.md) before approval. Container foreground inheritance can lose to explicit child theme colors; edit the actual local declaration. Gradients of any kind, including layered/transparent fills, require review across the surface: endpoints alone do not prove contrast. Parser success/`ready-for-review` and supplied-color math are not rendering or accessibility proof. Unknown real-surface checks stay pending without reviving previews.

### Raw responsive animation and token example

This complete request uses placeholder paths and an existing verified `pp-motion-grid` hook. Inspect actual `.card` descendants, cascade, container behavior and reduced-motion needs before adapting it. No page or rendering has been verified by this example.

```json
{
  "title": "Responsive feature cards",
  "pageId": "<resolved-localized-page-id>",
  "components": [{
    "id": "feature-grid",
    "label": "Feature card grid",
    "kind": "section",
    "className": "pp-motion-grid",
    "sourcePath": "web-pages\\example\\content-pages\\Example.en-US.webpage.copy.html"
  }],
  "styles": [{
    "id": "feature-responsive",
    "componentId": "feature-grid",
    "owner": "custom",
    "scope": "page",
    "css": ".pp-motion-grid { --pp-card-gap: clamp(1rem, 3vw, 2rem); display: grid; gap: var(--pp-card-gap); container-type: inline-size; }\n.pp-motion-grid .card { animation: pp-card-enter 250ms ease-out both; transition: transform 200ms ease, box-shadow 200ms ease; }\n@supports (display: grid) { .pp-motion-grid { grid-template-columns: 1fr; } }\n@media (min-width: 48rem) { .pp-motion-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }\n@container (min-width: 30rem) { .pp-motion-grid .card { padding: 1.5rem; } }\n@keyframes pp-card-enter { from { opacity: 0; transform: translateY(0.5rem); } to { opacity: 1; transform: none; } }\n@media (prefers-reduced-motion: reduce) { .pp-motion-grid .card { animation: none; transition: none; } }",
    "rationale": "Keep responsive layout and named motion within verified feature cards on the selected locale, with reduced-motion alternatives."
  }]
}
```

### Explicit global theme example

This complete request intentionally affects **all matching elements** on the root and its inherited pages/locales. It uses a **new** custom Web File so the import can be first, a placeholder external stylesheet and a placeholder existing Web File font. Verify relationships, the safe order slot, import content/resource effects, font availability, CSP and licensing before approval. No fake class or source hook is required, and no resource is fetched by preparation.

The `@layer pp-site-theme` wrapper illustrates supported syntax, not a default-override recipe. Use it only when the inspected layer architecture makes those declarations effective. If unlayered defaults win, keep the needed overrides unlayered at the approved custom placement and review the full cascade instead of copying this wrapper blindly.

```json
{
  "title": "Global brand theme",
  "pageId": "<resolved-localized-page-id>",
  "components": [{
    "id": "site-theme",
    "label": "Site-wide brand theme",
    "kind": "site-theme"
  }],
  "styles": [{
    "id": "brand-theme",
    "componentId": "site-theme",
    "owner": "custom",
    "scope": "site",
    "fileName": "brand-theme.css",
    "global": true,
    "externalResources": ["https://styles.example.com/brand.css"],
    "css": "@import url(\"https://styles.example.com/brand.css\");\n@font-face { font-family: \"pp-Example\"; src: url(\"/fonts/example.woff2\") format(\"woff2\"); font-display: swap; }\n@property --pp-accent { syntax: \"<color>\"; inherits: true; initial-value: #285b70; }\n@layer pp-site-theme { :root { --pp-surface: #ffffff; --pp-text: #17324d; --pp-accent: #285b70; } body { font-family: \"pp-Example\", system-ui, sans-serif; color: var(--pp-text); background-color: var(--pp-surface); } a { color: var(--pp-accent); } }",
    "rationale": "Explicitly review site-wide imported rules, shared names and all matching body/link styles without modifying protected default assets."
  }]
}
```

PCF/iframe internals, ambiguous component sources, unknown Bootstrap, generated output, metadata authoring and unsafe side effects remain genuine boundaries, not examples of unsupported CSS. Source-pipeline compilation and component creation require separate reviewed local tasks. Never loosen validators, hand-edit plans or bypass errors.

## CLI contract

Use unique paths outside the uploadable site tree. Normal preparation takes a **new external revision directory**, not a plan filename; preserve previous revisions rather than deleting them to reuse a path.

The inspector's default full JSON stdout is backward compatible. `--summary --out` returns at most 4,096 bytes and writes the full inventory with selection evidence externally. Select `--pageId` (also offline) or `--page "<name-substring>"`; an optional `--target` is a literal DOM ID/class/tag, not a complex selector. Bounded source candidates remain advisory; read full evidence and actual source when needed. Inspection/preparation require `--siteRoot`; apply/validate take identity from the hash-bound plan and **do not accept `--siteRoot`**.

```bash
node "${PLUGIN_ROOT}/skills/style-site/scripts/inspect-style-context.js" --siteRoot "<siteRoot>" --summary --out "<workDir>/context.json" --pageId "<pageId>" --target ".pp-card"
node "${PLUGIN_ROOT}/skills/style-site/scripts/style-site-workflow.js" --operation prepare --siteRoot "<siteRoot>" --request "<workDir>/request.json" --out "<workDir>/revision-1"
```

Prepare validates and writes only `style-site.plan.json` and `style-site.review.json`. The bounded result reports `status: "ready-for-review"`, `artifacts: { plan, review }`, `planHash`, `route.name` (`small-change` or `expanded`), and verification/diff evidence. **If `truncated=true`, read the full `artifacts.review` before approval.** Its exact replacement spans use `start`, `deleteCount`, `removed`, and `inserted`; offsets/counts are **UTF-16 code units** (JavaScript string indices), not byte offsets.

Plans remain **schemaVersion 2**, without copied rendering layers/components; inline support does not introduce another plan version. Schema-1 preview plans and the retired `--operation preview` fail explicitly. Old zero-write Studio requests missing `handoffReason: "user-requested"` also require regeneration: revise the saved request for local authoring unless instructions-only was explicitly requested, prepare, review the new diff and approve its new hash. Never edit a legacy plan or carry its old approval forward. Receipt schema remains unchanged; preserve earlier receipts for recovery.

The small-change route allows ordinary broad `declarations`: **inline-only, stylesheet-only or inline+CSS** on the selected localized page, at most **3 components or 10 style groups** in one section, and at most **one existing stylesheet**, with guarded same-page class additions. Known Bootstrap and resolved static source/cascade remain required. Any raw `style.css`, `global: true`, nonempty `externalResources` or `importantReason` takes expanded review, as do non-page scope, shared templates/source-free descriptors, new files/metadata, generated-source work or broader/ambiguous scope. Unresolved or unrepresentable edits still block; no route bypasses source ownership, version, relationship or generated-source guards.

After host approval of the exact `planHash`, apply and independently validate in one invocation:

```bash
node "${PLUGIN_ROOT}/skills/style-site/scripts/style-site-workflow.js" --operation apply --plan "<workDir>/revision-1/style-site.plan.json" --approvedHash "<approved-planHash>" --receipt "<workDir>/receipt-1.json"
```

The coordinator retains fresh apply preflights and calls the separate validator against the exact plan/receipt after writing. No extra routine validate/dry-run/validate commands are required. **`--receipt` is mandatory** with coordinator apply, including an empty change set, and must be a new external path. An existing receipt is not overwritten. Empty application reports `no-local-changes` and creates only the external receipt; an explicitly requested, entirely instructions-only Studio outcome normally skips apply and verifies the proposal/no styling edits instead. Empty writes do not turn blocked local work into success. Do not compute an alternative hash or edit the compiled plan.

The coordinator uses **four full scans**: preparation, two fresh preflights, and independent fresh verification. Including the initial inspector, a cold flow uses **five**, not four. Do not remove a safety check to claim fewer scans.

### Diagnostic commands

Individual commands remain supported for troubleshooting and explicit standalone use, not as additional steps in the normal coordinator flow:

```bash
node "${PLUGIN_ROOT}/skills/style-site/scripts/prepare-style-plan.js" --siteRoot "<siteRoot>" --request "<workDir>/request.json" --out "<workDir>/diagnostic-plan.json"
node "${PLUGIN_ROOT}/skills/style-site/scripts/validate-style-site.js" --plan "<workDir>/diagnostic-plan.json"
node "${PLUGIN_ROOT}/skills/style-site/scripts/apply-style-plan.js" --plan "<workDir>/diagnostic-plan.json"
```

The last command is a dry-run. Standalone application requires `--apply --approvedHash "<approved-planHash>" --receipt "<new-external-receipt.json>"`, followed by independent `validate-style-site.js --plan "<plan>" --receipt "<receipt>"`. These lower-level paths retain explicit validation duties; the coordinator already performs them. Diagnostic `--out` arguments are filenames with exclusive create, unlike the coordinator's revision directory.

## Iterate, then approve the exact revision

1. Keep inspection output, requests, proposals and receipts in a private work directory outside the uploadable site. Preserve prior revisions.
2. Run coordinator prepare with a fresh revision directory. Review its exact compiled changes, not a hand-written approximation. No browser is required.
3. Present the complete diff, proposal hash, any explicitly requested Studio-only instructions, unlisted/unknown/conditional Studio support and parser warnings, external URLs, global/shared-name/priority effects and affected pages/locales. Read the full review if stdout is truncated. No review means no application.
4. Use the host's explicit Approval Gate; runtime consent, earlier scope approval and a JSON field cannot authorize writes. An explicitly requested Studio-only request approves the handoff, not a local patch. Unattended execution never grants approval.
5. For changed selections, source files, targets, ownership, scope or CSS, revise the request, regenerate and approve the new hash. Repeat per revision, not once for an entire iteration loop.

Use the request/CLI contract above. Imported requests remain untrusted input, not approval. Return through conditional scope confirmation for expanded/ambiguous changes. Do not invent fields/flags, hand-edit a plan, or bypass a validator.

## Local verification checklist

Require the coordinator's successful independent validator result for the exact plan/receipt, then re-read changed files through a separate read path. The independent logic and fresh preflights remain mandatory internally; separate CLI round trips do not. A receipt alone or a no-op hook result cannot establish completion. Standalone diagnostic application still requires the explicit validation described above.

Verify the exact local change set. Inspect source-level accessibility/layout risks, but leave post-change rendering and real-surface behavior pending. Do not add a replacement HTML/browser workflow or deploy merely to obtain visual evidence.

| Check | Required evidence |
|---|---|
| Target identity | Explicit site, page/record relationships, locales, namespace, and scope match the reviewed proposal |
| Input integrity | Current file inventory and hashes match the reviewed snapshot (or receipt's expected post-apply state); added/deleted files and changed bytes stop validation, not just changes to old hash entries |
| Tracking isolation | Only known `site-settings/Site-AI-Skills-*.sitesetting.yml` and `Site-AI-Tools-*.sitesetting.yml` tracking files are excluded from style hashes/inventory; normal completion tracking does not invalidate the receipt, while other styling inputs remain checked |
| File integrity | Only approved files/managed blocks/opening-tag spans changed; unrelated edits, declarations, comments, line endings, IDs, Liquid, accessibility and Studio markers remain intact. Reconstructed markup combines only approved class/inline edits |
| Placement | Inline Page Copy edits and exact-page CSS use the intended locale; shared-template inline edits disclose potentially every page; Web File parents and descendant effects match approval |
| CSS scope/resources | Scoped selectors stay within verified components; explicit global rules disclose all matching elements, shared names and imports. Exact external URLs/warnings match approval; CSP, availability/licensing and semantic parser gaps are reviewed, not silently assumed |
| Authoring boundary | Listed native properties may be local; only explicitly requested Studio instructions remain write-free. Default CSS files/order and framework assets did not change; existing exact-property inline importance is preserved and authored priority changes have an approved justification |
| Repeatability | Inspect managed blocks/classes/style attributes for duplication; do not reapply simply to test. Apply regression tests cover repeated execution |
| Readability | Review paired colors, child overrides and local declaration dependencies; optional color math covers supplied pairs only, not actual rendering |
| Pending live checks | Desktop/mobile wrapping and overflow, effective CSS winners, contrast, focus/keyboard behavior, hover/disabled/error/empty/loading states and dynamic native content |
| Recovery | Receipt identifies before/after hashes and original content; a failure reports exact partial local state without rolling back concurrent edits |

Report unsupported controls and missing state coverage instead of claiming success. Generated-source compilation and live testing are separately authorized tasks, not operations this request schema can apply; do not add tools merely to run them.

## Hook discovery is only a backstop

With no arguments, `validate-style-site.js` uses the plugin's shared `runValidation` wrapper. It only looks for:

- `<host cwd>/.powerpages-style/style-site.plan.json`
- Optional matching `<host cwd>/.powerpages-style/style-site.receipt.json`

This conventional directory **must be outside the uploadable `siteRoot`**. For example, the host can run in a workspace parent containing both the site download and its sibling `.powerpages-style` review directory. If the host cwd is the upload root, do not create this conventional directory there; select an outside work directory instead.

When the conventional plan does not exist, the hook approves without checking artifacts. When it exists, malformed/inconsistent plans, receipts, or local files block. A no-artifact approval is not proof of completion.

Hooks cannot infer an arbitrary `--out` location or revision directory. A new revision does not become discoverable merely because an earlier `style-site.plan.json` was checked. Preserve prior artifacts; the coordinator's exact-plan/receipt validation is authoritative for normal runs, and explicit validation remains available for standalone diagnostics. Do not overwrite conventional files or bypass an error to manufacture hook success.

## Evidence levels and later handoff

| Level | What can be claimed |
|---|---|
| Local static validation | Paths, metadata, hashes, selectors, scope, and patch consistency were checked |
| Supplied-color contrast calculation | The supplied resolved color pair meets/fails its text threshold; not evidence of actual computed styles or full accessibility |
| Optional runtime DOM observation | The approved deployed page exposed the recorded IDs/classes and computed values at capture time; no submission, permission, future local-change or Studio-editability claim |
| Design Studio round-trip | **Only after separately performed checks:** native properties remain editable, component handles/markers work, and save/reopen preserves custom styling |
| Deployed runtime | **Only after separately authorized deployment/testing:** real Liquid, permissions, authentication, form submit, list filtering/paging, and dynamic loading work |

Leave post-change Studio/runtime checks explicitly **pending** at this skill's end. Report any earlier read-only runtime observation separately; it does not verify an unuploaded local patch. Provide Studio property/value instructions only when explicitly requested. Supply a later checklist: compare a refreshed download safely; check component editability and locale; verify native behaviors at mobile/desktop widths; check actual computed-style winners. Neither static checks nor color math proves these, nor guarantees that local values populate native Studio controls.

After successful verified local completion or an explicitly requested instructions-only handoff, report without a final-completion question and record normal `StyleSite` usage under the existing supported-directory/no-op contract. Keep tracking diffs separate; canceled drafts and blocked local work do not count as successful completion. Give each blocker a specific local next step, not a zero-write Studio success. Additional requested revisions always return through preparation, diff review and exact-hash approval.

Do not invoke deployment, the Desktop site's Preview command, Studio Sync, or cache clearing. Cache differences can explain later discrepancies ([caching context](https://www.engineeredcode.com/blog/power-pages-many-layers-of-caching)), but are not permission to change remote state.
