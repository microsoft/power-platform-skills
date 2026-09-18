---
name: author-webpage-content
description: >-
  Generates and fills the localized HTML body of an existing webpage in a PAC
  CLI-downloaded declarative Power Pages site from a resolved page-content
  specification. Use whenever an orchestrator or author-webpage has already
  created the webpage metadata and asks to compose, replace, append, or modify
  the exact localized `.webpage.copy.html` file with Design Studio-compatible
  sections, columns, text, images, buttons, videos, or spacers. This skill owns
  only HTML generation and the supplied target file; author-webpage owns all
  webpage discovery, records, metadata, languages, routes, templates,
  navigation, and companion-file creation. Do not use for React, Angular, Vue,
  or Astro code sites.
user-invocable: true
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it
> outputs a message, show it to the user before proceeding.

# Author Webpage Content

Generate and fill one supplied localized Design Studio-compatible webpage body.

**Initial request:** $ARGUMENTS

## Authoritative references

Always read and follow:

- `${PLUGIN_ROOT}/skills/classic-site-skills/author-webpage-content/references/webpage-content-composition.md`
- `${PLUGIN_ROOT}/skills/classic-site-skills/page-elements/references/design-studio-component-authoring.md`

Read only the page-element references used by the requested composition:

- `design-studio-section-layouts.md`
- `design-studio-text-component.md`
- `design-studio-image-component.md`
- `design-studio-button-component.md`
- `design-studio-video-component.md`
- `design-studio-spacer-component.md`

All page-element references are under:

```text
${PLUGIN_ROOT}/skills/classic-site-skills/page-elements/references/
```

These references own serialized section and component markup, editing
boundaries, preservation, accessibility, and verification rules. Do not invent
competing markup contracts.

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
- localized summary, custom CSS, or custom JavaScript companion files;
- another locale unless the request supplies a separately resolved composition
  for that locale.

`author-webpage` or the calling orchestrator must create the file and resolve
its webpage and locale identity before invoking this skill. This skill does not
search for or select a webpage record.

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
- an unknown section layout or component-to-column mapping;
- missing visitor-facing text, image source, destination, alternative text, or
  video title required by the selected component;
- an unresolved web-file URL, snippet name, or page destination;
- a replacement that does not state what existing content must be preserved;
- custom HTML whose safety or intended rendering boundary cannot be established.

## Expected resolved handoff

Prefer a structured specification containing:

- the exact existing target file and its already-resolved locale;
- operation mode: `create`, `replace`, `append`, or `modify`;
- ordered sections;
- each section's supported layout and ordered elements by column;
- resolved content, URLs, snippet names, and accessibility values;
- explicit preservation requirements for an existing page.

The specification may be Markdown, YAML, JSON, or an unambiguous natural
language plan. Normalize it internally according to the composition reference;
do not require the user to rewrite a complete plan merely to match an example
format.

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

Use page-element examples only as serialization contracts. Replace every sample
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
