# Bootstrap, Studio, and classic exports

## Resolve three independent axes

Treat **classic versus SPA**, **standard versus enhanced data model**, and **disk serialization** as separate facts. Bootstrap version is another independent fact.

Use the read-only inspector to resolve one explicit classic site and its relationships. Supported adapters can cover direct PAC download roots and `.powerpages-site` layouts; neither a folder name nor `website.yml` alone proves that a project is classic. Do not create a code-site configuration tree to make discovery pass.

Public exports show `adx_`-prefixed and prefixless metadata, flat and nested Web File assets, and locale-in-filename versus locale-directory content pages. These are examples, not a promise that every export uses one shape. Unrecognized or conflicting relationships must stop edits with the unresolved files/records identified. See the [serialization sources](sources.md#public-format-evidence).

## Bootstrap evidence and version-safe output

[Bootstrap overview](https://learn.microsoft.com/power-pages/configure/bootstrap-overview) documents Power Pages support for **3.3.6 and 5**. Older notes in other styling pages still mention only 3.3.x; use the version-specific documentation to resolve that conflict, not site age.

1. Inspect the Bootstrap assets actually referenced by the selected site's templates and metadata. Record paths, version banners/content evidence, and inclusion order.
2. Corroborate with relevant local configuration and markup. A runtime flag or isolated class name is not sufficient proof of what is loaded.
3. If evidence is missing or contradictory, mark the version **unknown** and stop all version-dependent CSS, markup, and sample generation. Request the missing local assets or clarification; never silently default to 3 or 5.
4. Preserve the site's installed implementation. Do not add a Bootstrap CDN, substitute a newer asset, flip a runtime flag, install dependencies, or run a migration.

| Detected version | Safe approach | Do not introduce |
|---|---|---|
| Bootstrap 3 | Preserve the existing v3 grid, wrappers, and native component structure; use scoped custom classes where needed | v5 utilities, `data-bs-*`, or assumed `--bs-*` tokens |
| Bootstrap 5 | Preserve the actual v5 markup/assets and use only features verified in that installed version | Legacy panels, glyphicons, or a copied Bootstrap 3 list recipe |
| Unknown/conflicting | Explain missing evidence and resolve it before preparation; the current script blocks all proposals without a known version | Version-specific representative markup or a “best guess” framework baseline |

Even supported classes must not be added merely because they exist in Bootstrap: preserve native behaviors and Studio structure. [Bootstrap 5 setup/migration guidance](https://learn.microsoft.com/power-pages/configure/bootstrap-version-5) describes separate operations outside this local styling workflow.

## Page identity and localization

- Resolve website, root page, localized content page, language, and sidecar through metadata relationships. Do not select the first matching page name or assume an English home page.
- For an exact-page request, select the intended localized `*.webpage.custom_css.css` or equivalent sidecar in the detected format. Changing a root record is not evidence that all localized content records changed.
- List the locales actually affected. One-language approval never authorizes editing the other translations.
- A CSS Web File parented to a page applies to that page **and its descendants** when its partial URL ends in `.css`. Use a page CSS field for exact-page isolation; disclose subtree effects when reusing a Web File.
- Preserve page-template and web-template relationships, editable Page Copy regions, Studio markers, and Liquid. Do not replace the page structure merely to add a class.

Sources: [Advanced CSS](https://learn.microsoft.com/training/modules/power-pages-extend/css), [custom page layouts](https://learn.microsoft.com/power-pages/getting-started/tutorial-add-custom-page-layout), [Web Files](https://learn.microsoft.com/power-pages/configure/web-files).

## Native forms, lists, and Liquid

| Component | Prefer | Preserve and verify later in the runtime |
|---|---|---|
| List | Documented **CSS Class** / **Grid CSS Class**, or an existing stable wrapper | Filtering, paging, sorting, actions, empty/loading/error states, and delayed row rendering |
| Basic form/control | Documented basic form metadata **CSS Class**, or a stable form wrapper | Accessible labels, help text, validation, required state, control behavior, and submit flow |
| Other native form variant | Confirm its supported hooks in current documentation and local metadata | Do not assume basic-form metadata applies unchanged to every form variant |
| Liquid/web-template component | Existing manifest parameters, include, shared class, and instance modifier | Maker configuration, repeated instances, server rendering, and editable regions |

Do not guess generated IDs or broad selectors such as every `.btn`, `input`, or `table`. A wrapper/class edit must match a precise owned target and preserve existing tokens. Keep a documented hook usable when the platform renders content asynchronously; do not introduce DOM-rewriting JavaScript.

The automated schema supports only its explicit `part` suffixes and class additions to existing static opening tags. It does not create forms/lists, edit their native metadata, or generate Liquid components. If a documented native hook must first be configured, treat that as a separate authoring task and inspect its resulting local source before preparing custom CSS.

Web-template sources must be statically reachable from the chosen localized Page Copy through literal `include`/`extends`, the localized/root page-template relationship, or configured website header/footer template IDs. Unused templates and unresolved dynamic includes are not safe styling targets; resolve relationships explicitly, never bypass the guard. All web-template preview targets are labeled **Simulation**, including templates containing only static-looking HTML.

References: [basic form metadata](https://learn.microsoft.com/power-pages/configure/configure-basic-form-metadata), [list configuration](https://learn.microsoft.com/power-pages/configure/list-configuration), [web-template components](https://learn.microsoft.com/power-pages/configure/web-templates-as-components-how-to).

## Desktop is the local-only authoring surface

| Surface | What it establishes | Boundary |
|---|---|---|
| VS Code Desktop + downloaded site + Node | Local inspection, proposal generation, separate HTML preview, and approved local edits | Normal styling requires no PAC execution or Dataverse authentication |
| Explicitly approved portal runtime URL | Rendered DOM IDs/classes and selected computed values for source reconciliation | Read-only observation via the connected browser; no form actions, automatic sign-in or crawling. Normal page scripts/requests run; see [runtime discovery](runtime-dom-discovery.md) |
| Desktop Power Pages **Preview** action | Uploaded site's runtime, not unsaved/unuploaded local changes | It also clears the site cache; **do not invoke it** for this workflow |
| VS Code for the Web | Supported online editing of site content | Lacks the local PAC/Node execution path; saving updates remote content, so it is not a local apply alternative |
| Design Studio | Native property editing and later maker-compatibility checks | Guided handoff only; never perform remote saves or Sync on behalf of this local-only skill |

Sources: [Desktop extension](https://learn.microsoft.com/power-pages/configure/vs-code-extension), [Web editor](https://learn.microsoft.com/power-pages/configure/visual-studio-code-editor).

If the local download is incomplete, explain how the user can acquire or compare the missing content separately. Do not download over dirty files, authenticate, upload, or clear caches to “fix” preview fidelity. Reinspect a refreshed baseline and require renewed approval for changed proposals.
