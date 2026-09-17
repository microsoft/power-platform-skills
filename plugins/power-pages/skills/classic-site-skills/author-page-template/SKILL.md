---
name: author-page-template
description: >-
  Creates or modifies a page template in a PAC CLI-downloaded declarative Power
  Pages site, including Web Template or Rewrite rendering metadata and explicitly
  requested webpage assignments. Use whenever the user asks to create, add,
  generate, edit, rename, rebind, migrate, assign, or delete a Power Pages page
  template, custom page layout metadata, web-template-backed page layout, or
  supported rewrite page template. This skill owns end-to-end custom page layout
  requests and webpage assignments that accompany page-template creation,
  modification, or migration. For a task limited to changing an existing
  webpage to use an existing page template, use author-webpage. Do not use for
  React, Angular, Vue, or Astro code sites.
user-invocable: true
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Skill, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it
> outputs a message, show it to the user before proceeding.

# Author Page Template

Create or modify a Design Studio-compatible page-template record in a
declarative Power Pages site downloaded by PAC CLI.

**Initial request:** $ARGUMENTS

## Authoritative references

Read and follow:

- `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`
- `${PLUGIN_ROOT}/skills/classic-site-skills/author-page-template/references/design-studio-page-template-authoring.md`
- `${PLUGIN_ROOT}/skills/classic-site-skills/author-web-template/references/design-studio-web-template-authoring.md` when
  binding or evaluating a web template
- `${PLUGIN_ROOT}/skills/classic-site-skills/author-webpage/references/design-studio-webpage-authoring.md` when assigning
  the page template to webpages

These references own the metadata contracts, rendering types, identity rules,
dependency handling, assignment behavior, and verification checklists.

## Autonomy policy

Complete the request without asking the user about routine implementation
details. Infer safe choices from `$ARGUMENTS`, the defaults and decision rules in
the authoritative references, existing site conventions, and the nearest
comparable records.

Do not ask for approval before ordinary local file edits. Stop without writing
only when the references and workspace evidence cannot resolve a high-impact
ambiguity, such as:

- multiple declarative sites or target page templates with no supported winner;
- an absent or ambiguous rendering target;
- a proposed reuse, rebind, default change, response-boundary change, or deletion
  whose effect on existing webpages cannot be established;
- a request whose intended component scope cannot be distinguished between
  page-template metadata and an end-to-end custom page layout.

When stopped, report the unresolved choices and the evidence found. Do not
invent a binding or rewrite target.

## Workflow

1. Locate and validate the declarative site.
2. Classify the requested operation and load the relevant reference sections.
3. Resolve the rendering source and whether an existing page template can be
   reused safely.
4. Execute the operation through the authoritative reference.
5. Verify the dependency graph and final diff.

Do not upload, deploy, or modify Dataverse directly.

## Phase 1: Locate the site

Follow `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`, requiring
`page-templates/`. Also require `web-templates/` when creating, inspecting, or
binding a Web Template-type record. Apply this skill's autonomy policy when
several valid sites remain: use request and workspace evidence, but stop rather
than selecting arbitrarily.

## Phase 2: Classify and inspect

Classify `$ARGUMENTS` as one or more of:

- create page-template metadata;
- create an end-to-end custom page layout;
- modify, rename, rebind, or migrate an existing page template;
- assign, unassign, or reassign webpages;
- delete a page template.

Read the complete
`${PLUGIN_ROOT}/skills/classic-site-skills/author-page-template/references/design-studio-page-template-authoring.md`, then inspect
the records and dependencies required by the matching sections. Use the web
template and webpage references only when those component boundaries are
involved.

Do not copy field rules from the references into an improvised workflow. Resolve
the target and operation using stable identities and the dependency analysis
defined there.

## Phase 3: Resolve component boundaries

For an end-to-end custom page layout, execute **End-to-end custom page layout**
from the page-template reference. When that workflow requires new source, invoke
`author-web-template` with the resolved layout requirements, then re-read its
resulting metadata and continue the reference workflow.

For a metadata-only request, follow the reference without expanding the
operation into web-template creation or webpage assignment.

## Phase 4: Execute through the reference

Use the reference section that owns the operation:

| Operation | Authoritative sections |
|---|---|
| Create | **Page template creation workflow**, **Rendering types**, **Field contract**, and **Default and table applicability** |
| Reuse or bind | **End-to-end custom page layout** and **Web template binding** |
| Modify, rename, rebind, or migrate | **Modifying an existing page template** and its applicable safety subsection |
| Assign, unassign, or reassign webpages | **Assigning a page template to webpages**, plus the webpage-authoring reference |
| Delete | **Deletion rules** |

Execute every required step in the selected sections, including UUID generation,
identity preservation, dependency updates, and component-specific validation.
Apply the smallest coherent local change and preserve unrelated metadata.

## Phase 5: Verify and report

Run the full **Verification checklist** and enforce **Prohibited shortcuts** from
the page-template reference. Review the final diff against the classified
operation and confirm no unrelated page-template, webpage, or web-template files
changed.

Report:

- created, modified, renamed, rebound, assigned, unassigned, or deleted files;
- the page-template name and stable ID;
- rendering type and target;
- header/footer and default behavior;
- affected webpages and locales.

State that the changes are local and were not uploaded or deployed.

### Record skill usage

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference using
`--skillName "AuthorPageTemplate"`.
