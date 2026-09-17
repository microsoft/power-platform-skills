# Bootstrap, Studio, and classic exports

## Resolve three independent axes

Treat **classic versus SPA**, **standard versus enhanced data model**, and **disk serialization** as separate facts. Bootstrap version is another independent fact.

Use the read-only inspector to resolve one explicit classic site and its relationships. Supported adapters can cover direct PAC download roots and `.powerpages-site` layouts; neither a folder name nor `website.yml` alone proves that a project is classic. Do not create a code-site configuration tree to make discovery pass.

Public exports show `adx_`-prefixed and prefixless metadata, flat and nested Web File assets, and locale-in-filename versus locale-directory content pages. These are examples, not a promise that every export uses one shape. Unrecognized or conflicting relationships must stop edits with the unresolved files/records identified. See the [serialization sources](sources.md#public-format-evidence).

## Bootstrap evidence and version-safe output

[Bootstrap overview](https://learn.microsoft.com/power-pages/configure/bootstrap-overview) documents Power Pages support for **3.3.6 and 5**. Older notes in other styling pages still mention only 3.3.x; use the version-specific documentation to resolve that conflict, not site age.

1. Inspect the Bootstrap assets actually referenced by the selected site's templates and metadata. Record paths, version banners/content evidence, and inclusion order.
2. Corroborate with relevant local configuration and markup. A runtime flag or isolated class name is not sufficient proof of what is loaded.
3. If evidence is missing or contradictory, mark the version **unknown** and stop preparation. Request the missing local assets or clarification; never silently default to 3 or 5.
4. Preserve the site's installed implementation. Do not add a Bootstrap CDN, substitute a newer asset, flip a runtime flag, install dependencies, or run a migration.

| Detected version | Safe approach | Do not introduce |
|---|---|---|
| Bootstrap 3 | Preserve the existing v3 grid, wrappers, and native component structure; use scoped custom classes where needed | v5 utilities, `data-bs-*`, or assumed `--bs-*` tokens |
| Bootstrap 5 | Preserve the actual v5 markup/assets and use only features verified in that installed version | Legacy panels, glyphicons, or a copied Bootstrap 3 list recipe |
| Unknown/conflicting | Explain missing evidence and resolve it before preparation; the current script blocks all proposals without a known version | Version-specific representative markup or a “best guess” framework baseline |

Even supported classes must not be added merely because they exist in Bootstrap: preserve native behaviors and Studio structure. [Bootstrap 5 setup/migration guidance](https://learn.microsoft.com/power-pages/configure/bootstrap-version-5) describes separate operations outside this local styling workflow.

General CSS syntax is independent of Bootstrap's version-specific utilities. Both detected Bootstrap 3 and 5 sites can use ordinary CSS properties/functions and raw responsive rules where supported by the target browsers and Power Pages. Pinned bundled css-tree parsing is not rendering proof or a Studio control inventory. Unknown/semantic-grammar-unverified values require warnings and review, not a skill-specific property or gradient allowlist.

## Page identity and localization

- Resolve website, root page, localized content page, language, and sidecar through metadata relationships. Do not select the first matching page name or assume an English home page.
- For an exact-page request, select the intended localized Page Copy for inline changes or `*.webpage.custom_css.css` (or equivalent) sidecar for stylesheet changes. Changing a root record is not evidence that all localized content records changed.
- List the locales actually affected. One-language approval never authorizes editing the other translations.
- A CSS Web File parented to a page applies to that page **and its descendants** when its partial URL ends in `.css`. Use a page CSS field for exact-page isolation; disclose subtree effects when reusing a Web File.
- Preserve page-template and web-template relationships, editable Page Copy regions, Studio markers, and Liquid. Do not replace the page structure merely to add a class.

Sources: [Advanced CSS](https://learn.microsoft.com/training/modules/power-pages-extend/css), [custom page layouts](https://learn.microsoft.com/power-pages/getting-started/tutorial-add-custom-page-layout), [Web Files](https://learn.microsoft.com/power-pages/configure/web-files).

## Native forms, lists, and Liquid

Use the [Design-panel capability map](studio-component-capabilities.md) for the actual selected native component, not exclusive authoring ownership. Form heading/instructions/section title belong to its Text family; an entire form or list does not. Both listed and unlisted properties default to guarded local inline declarations or scoped CSS. Keep unlisted/unknown/conditional warnings in review, approval and the final report; do not promise local values populate native controls. Bootstrap 3/5 does not establish whether the conditional Flex tab is enabled.

| Component | Prefer | Preserve and verify later in the runtime |
|---|---|---|
| List | Documented **CSS Class** / **Grid CSS Class**, or an existing stable wrapper | Filtering, paging, sorting, actions, empty/loading/error states, and delayed row rendering |
| Basic form/control | Documented basic form metadata **CSS Class**, or a stable form wrapper | Accessible labels, help text, validation, required state, control behavior, and submit flow |
| Other native form variant | Confirm its supported hooks in current documentation and local metadata | Do not assume basic-form metadata applies unchanged to every form variant |
| Liquid/web-template component | Existing manifest parameters, include, shared class, and instance modifier | Maker configuration, repeated instances, server rendering, and editable regions |

Do not guess generated IDs or apply broad native selectors unintentionally. Stable descendant/state/pseudo-element selectors are allowed inside a verified component subtree; intentionally global selectors require raw `global: true`, expanded review and disclosure of all matching elements within the placement scope. A wrapper/class edit must match a precise target and preserve tokens. Keep documented hooks usable for delayed rendering; do not introduce DOM-rewriting JavaScript.

The automated schema supports general CSS declarations, raw local stylesheets, guarded class additions and inline edits on exact existing static opening tags. Inline-only components may omit `className`; component-scoped stylesheets need verified `pp-*` hooks or guarded additions. Explicit global stylesheets and user-requested Studio handoffs are the only source-free cases; global themes need no fictitious hook. Missing custom hooks or repeated tags alone are not blockers: try exact adjacent local source context using the [targeting contract](proposal-and-verification.md#context-for-repeated-opening-tags). It does not create forms/lists, edit native metadata or generate Liquid components. If the actual component/source target cannot be resolved safely, report blocked local work with a source-authoring step, not a successful Studio handoff.

Real rendered source tags such as `input`, `textarea`, SVG and outer local iframe/embedded elements are eligible for exact class/style attribute edits; there is no fixed div/section/img tag list. Static tags and CSS values may span lines; preserve exact whitespace/newline matching. Do not enter embedded contents or treat server-generated runtime markup as existing local source. Runtime-discovery exclusions are unchanged. Raw stylesheets always take expanded review; ordinary declarations can remain small changes when source, Bootstrap and placement are verified.
Web-template sources must be statically reachable from the chosen localized Page Copy through literal `include`/`extends`, the localized/root page-template relationship, or configured website header/footer template IDs. Unused templates and unresolved dynamic includes are not safe styling targets; resolve relationships explicitly, never bypass the guard. Reachable shared-template inline edits require `scope: "site"` and expanded review, conservatively disclosed as potentially affecting every page. Static reachability does not verify server rendering, including templates containing only static-looking HTML.

References: [basic form metadata](https://learn.microsoft.com/power-pages/configure/configure-basic-form-metadata), [list configuration](https://learn.microsoft.com/power-pages/configure/list-configuration), [web-template components](https://learn.microsoft.com/power-pages/configure/web-templates-as-components-how-to).

## Desktop is the local-only authoring surface

| Surface | What it establishes | Boundary |
|---|---|---|
| VS Code Desktop + downloaded site + Node | Local inspection, exact-diff review, and approved local edits | Normal styling requires no PAC execution, browser review or Dataverse authentication |
| Explicitly approved portal runtime URL | Rendered DOM IDs/classes and selected computed values for source reconciliation | Read-only observation via the connected browser; no form actions, automatic sign-in or crawling. Normal page scripts/requests run; see [runtime discovery](runtime-dom-discovery.md) |
| Desktop Power Pages **Preview** action | Uploaded site's runtime, not unsaved/unuploaded local changes | It also clears the site cache; **do not invoke it** for this workflow |
| VS Code for the Web | Supported online editing of site content | Lacks the local PAC/Node execution path; saving updates remote content, so it is not a local apply alternative |
| Design Studio | Native property editing and later maker-compatibility checks | Instructions-only only when explicitly requested (`owner: "studio"`, `handoffReason: "user-requested"`, `studioAction`); native support alone is not a reason. Never perform remote saves or Sync |

Sources: [Desktop extension](https://learn.microsoft.com/power-pages/configure/vs-code-extension), [Web editor](https://learn.microsoft.com/power-pages/configure/visual-studio-code-editor).

The Desktop extension supports offline editing of downloaded content. [Manage CSS](https://learn.microsoft.com/en-us/power-pages/configure/manage-css) recommends Studio for out-of-box controls, not a prohibition on VS Code edits. [Page customization](https://learn.microsoft.com/en-us/power-pages/getting-started/customize-pages) describes paintbrush precedence: honor its actual local serialization by editing a winning static inline declaration instead of producing ineffective CSS or escalating priority.

If the local download is incomplete, explain how the user can acquire or compare the missing content separately. Do not download over dirty files, authenticate, upload, or clear caches to resolve missing local evidence. Reinspect a refreshed baseline and require renewed approval for changed proposals.
