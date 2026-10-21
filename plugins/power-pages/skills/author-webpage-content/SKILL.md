---
name: author-webpage-content
description: >-
  Generates and fills the localized HTML body of an existing webpage in a PAC
  CLI-downloaded non-SPA Power Pages site from a resolved page-content
  specification. Use whenever a caller has resolved the existing webpage metadata
  and asks to compose, replace, append, or modify
  the exact localized `.webpage.copy.html` file with Design Studio-compatible
  sections, columns, flex containers, text, images, buttons, videos, iframes,
  Generative AI Search components, basic forms, lists, multistep forms, or
  spacers. This skill owns
  only HTML generation and the supplied target file; the coordinator's webpage
  reference workflow owns discovery, records, metadata, languages, routes, templates,
  navigation, and companion-file creation. Do not use for React, Angular, Vue,
  or Astro SPA sites.
user-invocable: false
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Author Webpage Content

Generate and fill one supplied localized Design Studio-compatible webpage body.

**Initial request:** $ARGUMENTS

## Preview disclosure

Read `${PLUGIN_ROOT}/references/non-spa-preview.md` and apply its **Entry and handoff
protocol**. Unless the initial request contains the explicit marker from an actual covered-skill
handoff, present the **Customization notice** before project inspection or task creation.

## Authoritative references

Always read and follow:

- `${PLUGIN_ROOT}/skills/author-webpage-content/references/webpage-content-composition.md`
- `${PLUGIN_ROOT}/skills/author-webpage-content/references/design-studio-component-authoring.md`

Read only the page-element references used by the requested composition:

- `design-studio-section-layouts.md`
- `design-studio-flex-container-component.md`
- `design-studio-text-component.md`
- `design-studio-image-component.md`
- `design-studio-button-component.md`
- `design-studio-video-component.md`
- `design-studio-iframe-component.md`
- `design-studio-generative-ai-search-component.md`
- `design-studio-basic-form-component.md`
- `design-studio-list-component.md`
- `design-studio-multistep-form-component.md`
- `design-studio-spacer-component.md`

All page-element references are under:

```text
${PLUGIN_ROOT}/skills/author-webpage-content/references/
```

These references own serialized section and component markup, editing
boundaries, preservation, accessibility, and verification rules. Do not invent
competing markup contracts.

For an add or edit Generative AI Search component request, target only
`{% codecomponent name:Pages.SearchSummary ... %}`. Do not substitute
`{% include 'Search' %}`, a Search web template, Search content snippets, the
Search Results page record, site markers, or search indexing/settings.

For an add or edit Basic Form, List, or Multistep form request, target only
`{% entityform name:'...' %}`, `{% include 'entity_list' key:'...' ... %}`, or
`{% webform name:'...' %}` respectively, pointing at a record already present in
the downloaded site. This skill does not create the backing basic form, list,
multistep form, Dataverse table form/view, or table permissions — see each
component reference's **Scope** section. If the named (or implied) record is
not found in the downloaded site, do not assist with constructing it: do not
query Dataverse (API, SDK, Web API, or CLI) and do not ask the user for IDs,
GUIDs, or permissions to assemble it locally. When asking the user how to
proceed, the only valid options are (a) embed an existing record, or (b) stop.

## Ownership boundary

This skill receives and edits exactly one existing localized file per
invocation:

```text
web-pages/<page-directory>/content-pages/<Page>.<locale>.webpage.copy.html
```

It may compose multiple sections and page elements in that file as one coherent
operation.

This skill does not create or modify:

- root or localized webpage YAML;
- page routes, parents, page-template assignments, or navigation;
- page-template or web-template records;
- content-snippet records;
- web files or their metadata;
- basic form, list, multistep form (advanced form/step), Dataverse table
  form/view, or table-permission records;
- localized summary, custom CSS, or custom JavaScript companion files;
- another locale unless the request supplies a separately resolved composition
  for that locale.

The calling orchestrator must create or confirm the file and resolve its webpage and locale
identity before invoking this skill. `edit-site` uses
`${PLUGIN_ROOT}/skills/edit-site/references/webpage-authoring.md`
for that metadata workflow.
This skill does not search for or select a webpage record.

If the target file or any required content, URL, snippet name, or other rendered
value is unresolved, stop before writing and return the exact missing input.
Do not manufacture a placeholder or expand this skill into metadata or
dependency authoring.

## Autonomy policy

Complete routine composition without asking the user to approve mechanical
details. Infer safe formatting, escaping, indentation, and accessibility
details from the resolved specification, authoritative references, existing
page markup, and site-local conventions.

Choose independently when safe:

- exact indentation and line endings;
- the documented section serialization matching a named layout;
- component markup matching a resolved element type and source;
- safe link attributes and output encoding;
- preservation of empty columns required by the selected layout;
- the smallest coherent edit for a modification.

Stop before writing when a material choice remains unresolved, including:

- multiple target files, target sections, or components;
- an unresolved section geometry or ambiguous component-to-column mapping, not merely
  a layout name missing from the recipe examples;
- missing Flex Container child mapping, visitor-facing text, image source, destination,
  alternative text, video title, iframe title, or search behavior/text required by the
  selected component;
- an unresolved web-file URL, snippet name, or page destination;
- a requested basic form, list, or multistep form record not found in the
  downloaded site — never query Dataverse or assist with constructing it
  locally, and never present "create a new one" as a selectable option in a
  clarification question;
- a replacement that does not state what existing content must be preserved;
- custom HTML whose safety or intended rendering boundary cannot be established.

## Expected resolved handoff

Prefer a structured specification containing:

- the exact existing target file and its already-resolved locale;
- the verified Bootstrap major and any approved `designContext`; require version evidence for
  new sections, especially when the target page is blank;
- operation mode: `create`, `replace`, `append`, or `modify`;
- ordered sections;
- each section's supported layout and ordered elements by column;
- optional explicit `columns[].span` values and intended wrapping/unused space; otherwise
  resolve CSS-driven widths with the styling owner instead of guessing a preset;
- resolved content, URLs, snippet names, and accessibility values;
- explicit preservation requirements for an existing page.

The specification may be Markdown, YAML, JSON, or an unambiguous natural
language plan. Normalize it internally according to the composition reference;
do not require the user to rewrite a complete plan merely to match an example
format.

An approved new-site handoff requires custom composition using supported native sections,
columns and elements, not just text/image substitutions. Follow its resolved composition and
`designContext`, not the creation template's arrangement. Retain/place required existing components through the
resolved-source rules in **Whole-page composition**, without inventing new native element types.
Remove unneeded starter sections or component placements when the approved handoff accounts for
their removal and dependencies. Do not retain them solely because they came with the template,
hide them with CSS, or delete their backing records.
Preserve required content/capabilities and native serialization as described in **Whole-page
composition**; an unrelated existing-site `append` or `modify` remains a narrow edit.

## Workflow

1. Validate the supplied target file and resolved composition.
2. Read the complete target HTML and only the required page-element references.
3. Generate or modify the complete section/column/element tree in document
   order.
4. Fill the target file once as one coherent page-content change.
5. Verify structure, preservation, rendered values, safety, and the final diff.

Do not upload, deploy, or modify Dataverse directly.

## Phase 1: Validate the supplied target

Require one exact existing file path under:

```text
web-pages/<page-directory>/content-pages/<Page>.<locale>.webpage.copy.html
```

The caller owns proving that the path belongs to the intended localized webpage.
Reject a missing file, directory path, root-level copy file, wildcard, or
multiple targets. Do not create directories, companion files, or webpage
metadata.

## Phase 2: Normalize and validate the plan

Follow **Resolved composition contract** in the composition reference. Preserve
the supplied section order, column assignment, element order, content,
destinations, sources, and accessibility requirements.

Require final rendered URLs, snippet names, Liquid expressions, text, and
accessibility values. The caller owns creating and resolving their underlying
records. Do not continue with symbolic asset names or design-tool placeholders.

## Phase 3: Load only required markup contracts

Read the section-layout reference whenever the operation creates a section or
changes a section's column structure. Then read one component-specific reference
for each element type present in the normalized plan.
Use its Bootstrap 5 examples only with verified Bootstrap 5 evidence. Preserve inspected
Bootstrap 3/native and RTL patterns for existing sites; return missing evidence to the caller
rather than assuming the creation default or changing the framework.

Do not invoke one skill per page element. This skill is the single writer for
the target HTML and assembles all approved element markup in memory before
editing the file.

## Phase 4: Compose or modify

For `create` or `replace`, follow **Whole-page composition** in the composition
reference. Build sections in plan order, columns in layout order, and elements
in their specified order within each column.

For `append` or `modify`, follow **Existing-page operations**. Resolve exact
structural boundaries before changing the file, preserve unrelated markup, and
do not reserialize the entire page for a narrow edit.

Use the section-layout reference's recipes as defaults, not exhaustive geometry constraints.
Broader safe local layouts may proceed with **Studio editing compatibility unverified**
disclosed in the existing review and final report. Other page-element serialization contracts
remain unchanged; do not invent Studio controls, preview components, or an additional gate.
Replace every sample
value and marker with resolved plan values. Do not leave placeholder text,
placeholder URLs, `<!-- COMPONENT_HTML -->`, TODOs, or unexplained empty
components.

## Phase 5: Verify and report

Run the complete verification checklist from the composition reference and each
page-element reference used. Review the final diff and confirm that only the
selected localized HTML file changed.

Report:

- target file and supplied locale;
- created, replaced, appended, or modified sections;
- element types and final rendered references used;
- material preservation decisions.

State that the change is local and was not uploaded or deployed.

### Record skill usage

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference using
`--skillName "AuthorWebpageContent"`.
