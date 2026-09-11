# Styling sources

This index contains original summaries and links, not copied articles or examples. Research context: **September 2026**. Microsoft Learn defines platform support; MVP techniques are supplementary and must be checked against the selected site's actual version and markup. Refresh relevant Learn pages when available; if unavailable, disclose the limitation and use the bundled guidance without inventing newer support.

## Official Microsoft guidance

| Source | Apply it to | Caveat |
|---|---|---|
| [Manage CSS files](https://learn.microsoft.com/power-pages/configure/manage-css) | Studio-first ownership, custom stylesheet precedence, and preservation of default CSS records/order | Its older 3.3.x-only note conflicts with the dedicated Bootstrap overview; do not infer every site uses v3 |
| [Style your Power Pages site](https://learn.microsoft.com/power-pages/getting-started/style-site) | Theme palette, typography, buttons, and spacing through the Styling workspace | Check the selected site's available controls; do not assume undocumented token names |
| [Customize webpages with the page editor](https://learn.microsoft.com/power-pages/getting-started/customize-pages) | Native component controls, paintbrush precedence, and editing constraints | The `!important` exception describes behavior, not a recommendation to defeat Studio |
| [Advanced CSS](https://learn.microsoft.com/training/modules/power-pages-extend/css) | Exact-page CSS versus reusable CSS Web Files; a `.css` Web File affects its parent and descendants | Historical replacement/customizer examples are not this skill's policy; preserve all default files |
| [Bootstrap overview](https://learn.microsoft.com/power-pages/configure/bootstrap-overview) | Supported versions 3.3.6 and 5 | Inspect referenced local assets; support for v5 does not mean this site uses it |
| [Bootstrap version 5](https://learn.microsoft.com/power-pages/configure/bootstrap-version-5) | Version-specific platform setup and migration context | Setup, migration, framework replacement, and runtime-flag changes are separate tasks |
| [VS Code extension](https://learn.microsoft.com/power-pages/configure/vs-code-extension) | Desktop local authoring, Web File creation, and local/remote comparison concepts | Site Preview uses uploaded content and clears cache; use the separate local HTML preview instead |
| [VS Code for the Web](https://learn.microsoft.com/power-pages/configure/visual-studio-code-editor) | Online content fields and authoring limitations | Remote saves are not local application; the browser editor lacks the Desktop PAC/Node path |
| [Power Platform CLI tutorial](https://learn.microsoft.com/power-pages/configure/power-platform-cli-tutorial) | Standard/enhanced model selection and download/upload separation | Acquisition/deployment are separate workflows; do not execute PAC for normal styling |
| [Create and manage Web Files](https://learn.microsoft.com/power-pages/configure/web-files) | Website/parent relationships, attachments, partial URLs, and visibility | Derive the downloaded schema from verified local records, not a guessed YAML shape |
| [Create a web-template component](https://learn.microsoft.com/power-pages/configure/web-templates-as-components-how-to) | Liquid manifests, includes, and configurable parameters that support maker editing | Preserve existing parameters and editable structure; arbitrary replacement HTML is not equivalent |
| [Custom page layout tutorial](https://learn.microsoft.com/power-pages/getting-started/tutorial-add-custom-page-layout) | Page Copy, template relationships, and localized content | Preserve editable regions and resolve the intended language record |
| [Basic form metadata](https://learn.microsoft.com/power-pages/configure/configure-basic-form-metadata) | Documented CSS Class hooks for control styling | Do not invent a form-wide Custom CSS field or assume all form variants share this metadata |
| [List configuration](https://learn.microsoft.com/power-pages/configure/list-configuration) | CSS Class and Grid CSS Class extension points | Confirm the actual native list and runtime DOM; historical selectors are not cross-version contracts |

## Microsoft MVP perspectives

Attribution context: [Ulrikke Akerbaek's biography](https://ulrikke.akerbak.com/about-me/) and [Engineered Code's About Us](https://www.engineeredcode.com/about-us) identify the authors and MVP background.

| Author and article | Publication context | Useful principle and boundary |
|---|---|---|
| Ulrikke Akerbaek — [How to Style Power Pages](https://ulrikke.akerbak.com/2023/10/04/mppc23-how-to-style-power-pages-my-session-as-a-blog-post/) | 2023; updated September 2024 | Start with the site's native branding and extend deliberately. Do not adopt its numeric display-order workaround or historical font instructions as platform rules. |
| Ulrikke Akerbaek — [Power Pages branding — VS Code, CLI, CSS and SCSS](https://ulrikke.akerbak.com/2022/05/11/power-pages-branding/) | 2022 | Organize shared variables and component styles. SCSS is optional existing-project tooling, not a prerequisite; CLI instructions are historical context. |
| Nicholas Hayduk — [Dynamics 365 Portal Developers — Don't Forget About CSS!](https://www.engineeredcode.com/blog/dynamics-365-portal-developers-dont-forget-about-css) | 2018 | Prefer scoped CSS for presentation-only changes and distinguish hidden content from secured content. Inspect current markup rather than copying legacy selectors. |
| Nicholas Hayduk — [PowerApps Portals: Another UI Change Using Only CSS](https://www.engineeredcode.com/blog/powerapps-portals-another-ui-change-using-only-css) | 2019 | Inspect native list markup before changing presentation and consider mobile behavior. The example uses Bootstrap 3; it is not a reusable Bootstrap 5 patch. |
| Nicholas Hayduk — [Power Pages: Many Layers of Caching](https://www.engineeredcode.com/blog/power-pages-many-layers-of-caching) | 2025 | Distinguish Studio, runtime, browser, and CDN caches when explaining later discrepancies. This does not authorize uploads or cache clearing. |

## Public format evidence

- [Microsoft government app templates, classic portal source](https://github.com/microsoft/gov-apptemplates/tree/64dabc2652a13a2423ee3fb1d6f4bfe8f33fe1d9/portals/core-portal/site): examples of `adx_` metadata and locale-in-filename sidecars.
- [Microsoft Nonprofits, enhanced-model portal source](https://github.com/microsoft/Nonprofits/tree/b3dae27b62620caabf89be3bb91b127177749e80/VolunteerEngagement/Portal-EDM/.powerpages-site): examples of prefixless metadata, nested Web Files, and localization folders.

These pinned snapshots show serialization possibilities, not a one-to-one mapping between data model and filesystem shape. Use original minimal fixtures with placeholder names/identifiers when testing adapters; do not copy real environments, IDs, or entire source pages into examples.
