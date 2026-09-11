# Styling placement and ownership

Use this policy before preparing any local change. Microsoft Learn defines platform support; the [source index](sources.md) separates current support guidance from historical techniques.

## Choose the owner before writing CSS

| Intent | Owner and placement | Required scope evidence |
|---|---|---|
| Theme colors, typography, buttons, or spacing supported by Studio | **Styling workspace**; record exact values as a Studio-only handoff | Identify the theme property and pages/components that inherit it. Do not compile its simulated value into local CSS. |
| A supported individual component property | **Pages workspace**, component paintbrush/native controls | Identify the actual component and supported property. Preserve existing inline/native settings. |
| Reusable custom component styling not provided by Studio | Existing appropriate custom CSS Web File; create one only when necessary | Use a unique, reusable component class; identify all instances and inherited pages. |
| An exact-page adjustment | Resolved Web Page Custom CSS sidecar for the intended localized content record | Confirm page identity, locale, and physical sidecar. CSS applies to that page, not automatically to every translation. |
| A section-wide adjustment | CSS Web File parented to that section's page | Disclose **the parent and all descendants**, including translated pages, before approval. |
| A site-wide custom component style | Appropriate custom CSS Web File parented to the verified site root | Derive the root from relationships and URL metadata, never the name “Home.” Site-wide inclusion does not justify global selectors. |
| A native form, list, or form control | Stable wrapper or documented metadata CSS Class hook, with CSS in the applicable location above | Inspect the actual variant and hook. Do not invent a form/list Custom CSS field or depend on generated IDs. |
| A repeated Liquid component | Shared class and custom stylesheet; explicit modifiers for instance variations | Preserve manifest, parameters, includes, editable regions, and existing class tokens. |

Sources: [Manage CSS](https://learn.microsoft.com/power-pages/configure/manage-css), [Advanced CSS](https://learn.microsoft.com/training/modules/power-pages-extend/css), [component editing](https://learn.microsoft.com/power-pages/getting-started/customize-pages).

**Studio-only is a complete outcome.** If all requested properties are supported in Studio, deliver the requested interactive preview and precise Studio instructions with no custom CSS patch. For mixed requests, keep the Studio and local edit lists separate. After the user makes Studio changes, compare a newly acquired local baseline without overwriting dirty files, then regenerate any dependent proposal.

## Preserve the cascade rather than overpowering it

- Never replace, deactivate, delete, or reorder `bootstrap.min.css`, `theme.css`, or `portalbasictheme.css`; do not create a second default file under a different name.
- Microsoft's ordinary custom-CSS arrangement places it above `theme.css` and below `portalbasictheme.css`. Inspect the actual custom file ordering and template includes. Do not assign a magic display order such as `200`, or move default files to make space.
- This band applies to **existing custom Web Files as well as new ones**: require detected integer orders satisfying `theme.css < custom < portalbasictheme.css`. If a reused file is outside the band, stop and ask the user to choose/configure an appropriate custom file without moving defaults; do not reuse it anyway.
- For preview CSS Web File layers, numeric display order takes priority across the ancestor chain; ancestry only breaks ties. A section stylesheet must not be placed after `portalbasictheme.css` merely because it belongs to a descendant. Unknown orders block preparation.
- File order alone does not determine the winner. Explain relevant selector specificity, inline declarations, inheritance, importance, and existing cascade layers for each proposed rule.
- Studio component styling generally takes precedence over theme/inherited/custom styles. Do not defeat it with broad `!important`, escalating selectors, or inline overrides. Preserve existing declarations and route the conflicting property to its owner.
- Do not introduce `@layer` to try to outrank unlayered platform CSS. Keep existing layering semantics intact.
- Reuse project tokens and class conventions; do not assume Studio exposes a particular CSS-variable scheme. The request schema permits references to existing tokens in color values, not new custom-property definitions. Introducing tokens requires separate reviewed source authoring.
- A CSS field contains CSS, not a `<style>` element. A CSS Web File requires a partial URL ending in `.css` to participate in parent/descendant styling.

## Reuse without restructuring

Style both newly added and existing native components: sections, text, buttons, images, navigation, forms/lists, and Liquid/web-template components. For a new native component that does not yet exist locally, guide its creation through supported authoring controls and inspect the resulting local markup before proposing guarded class edits. A representative preview is not permission to substitute its sample markup for a native component.

The deterministic request schema is bounded: use only its listed component parts and safe CSS properties/values. It does not create components or native metadata hooks. Custom styling requires real component source and an existing namespaced class or a supported guarded class addition; unsupported changes need separate manually reviewed work, never a script bypass.

Prefer an existing stable wrapper or metadata hook over new markup. Repeated components share one namespaced class; variations use modifiers rather than copied CSS or duplicate IDs. Preserve Bootstrap containers, accessibility semantics, Studio editing attributes, Liquid expressions, template parameters, and unrelated content.

Do not rewrite native forms/lists with custom HTML or presentation-only JavaScript. Preserve labels, required markers, validation, permissions, submit behavior, list actions, and delayed rendering. Hiding with CSS is **not authorization**. PCF internals, third-party widgets, iframe contents, and shadow-root internals are outside this skill.

## Local editing safeguards

1. Record each change's owner, scope, target record/file, locale, selector/hook, baseline hash, proposed content, rationale, and affected pages/components.
2. Prefer an existing custom stylesheet. For a new Web File, establish the export schema, website/parent/publication relationships, attachment metadata, unique partial URL, and supported custom ordering from verified context. Different site/section destinations that collide on a physical path require distinct CSS filenames; different parent URLs do not make that collision safe. Preserve existing IDs; use the plugin UUID helper for new IDs.
3. If metadata, generated-source ownership, a locale, or an edit anchor is ambiguous, stop and give a specific Desktop/Studio setup step. Do not guess YAML or silently broaden scope.
4. Use the deterministic preparation/apply scripts. Preserve unrelated bytes, comments, line endings, and existing class tokens. Never reserialize a whole HTML/YAML document for a styling edit.
5. If an existing source pipeline owns a stylesheet, stop this automated apply path. Preparation detects same-basename `.scss`/`.sass`/`.less` siblings and generated/source-map markers in CSS. Source changes and compilation require a separate reviewed authoring task using the existing compiler; the styling request schema does not represent them. Do not remove ownership markers, overwrite generated output, or install a new toolchain.
6. Stage and validate the complete change set before writes. Refuse traversal, symlink escapes, duplicate ownership markers, changed inputs, and ambiguous matches. Reapplication must not duplicate rules, classes, or metadata.
7. Keep review artifacts and the recovery receipt **outside the uploadable site tree**. Report write failures and partial state explicitly; never use broad Git reset, automatic rollback, or overwrite a concurrent edit.

This skill does not run PAC, authenticate to Dataverse, change remote metadata, upload, publish, activate, or clear caches. An independent, later deployment remains the user's decision.
