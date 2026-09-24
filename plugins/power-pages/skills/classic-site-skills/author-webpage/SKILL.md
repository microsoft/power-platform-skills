---
name: author-webpage
description: >-
  Creates or modifies webpages in a PAC CLI-downloaded declarative Power Pages
  site, including root and localized records, empty localized content shells,
  metadata, routes, parent or page-template changes, and requested navigation
  links. Use whenever the user asks to author, create, add, edit, modify, rename, move, or
  configure a Power Pages webpage, including changing an existing webpage to use
  an existing page template. For complete localized page-body HTML, layout, or
  component composition, use author-webpage-content after the webpage records
  exist. Use author-page-template when the primary task creates or modifies the
  page-template record itself. Do not use for React, Angular, Vue, or Astro code
  sites.
user-invocable: true
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Skill, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it
> outputs a message, show it to the user before proceeding.

# Author Webpage

Create or modify all Design Studio-compatible webpage metadata and companion
files in a declarative Power Pages site downloaded by PAC CLI. Delegate only the
generation and filling of localized body HTML.

**Initial request:** $ARGUMENTS

## Authoritative references

Always read and follow:

- `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`
- `${PLUGIN_ROOT}/skills/classic-site-skills/author-webpage/references/design-studio-webpage-authoring.md`

Read when applicable:

- `${PLUGIN_ROOT}/skills/classic-site-skills/author-page-template/references/design-studio-page-template-authoring.md` when
  resolving or changing a page template
- `${PLUGIN_ROOT}/skills/classic-site-skills/author-webpage-content/references/webpage-content-composition.md` when
  initial or modified localized body HTML is requested

The references own PAC structure, identity, language mapping, metadata fields,
defaults, content ownership, navigation records, modification rules, and
verification. Do not restate or replace those contracts in this skill.

## Autonomy policy

Complete routine authoring without asking the user to approve mechanical
details. Infer safe choices from `$ARGUMENTS`, the reference defaults, the
website's default language, existing sibling pages, and established site
conventions.

Choose independently when the request leaves a low-risk detail open, including:

- normalized directory and file stems;
- default visibility and behavioral fields;
- publishing state and display-order conventions derived from sibling records;
- blank localized copy when no initial content was requested;
- the narrowest files required for a modification;
- formatting, escaping, and accessibility details.

Do not add navigation merely because a page is created. Do not expand a
localized content request to every language.

Stop before writing only when a high-impact ambiguity cannot be resolved from
the request or workspace, such as:

- multiple sites or target webpages with no supported winner;
- an absent or ambiguous parent page or page template;
- conflicting root/localized metadata with no safe authoritative value;
- a route, move, or rename whose unresolved callers could break;
- initial content whose required layout or behavior is materially unspecified.

When stopped, report the candidates and evidence. Do not guess through a
structural or user-visible ambiguity.

## Workflow

1. Locate the declarative site.
2. Classify the page-level operation and locale scope.
3. Resolve page-template and localized-content dependencies.
4. Execute the matching webpage-reference workflow.
5. Verify relationships, content ownership, dependencies, and the final diff.

Do not upload, deploy, or modify Dataverse directly.

## Phase 1: Locate the site

Follow `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`, requiring
`web-pages/`. Apply the autonomy policy if several candidates remain and stop
rather than selecting a site arbitrarily.

## Phase 2: Classify and inspect

Classify `$ARGUMENTS` as one or more of:

- create a webpage;
- modify shared webpage metadata;
- modify localized name, title, summary, body, CSS, or JavaScript;
- rename the page or change its route;
- move it under another parent;
- change its page template;
- add or modify requested navigation links.

Read the complete webpage reference, then inspect the records, companion files,
and dependencies required by the matching sections.

For an existing page, resolve the root record first and establish the selected
localized records through the reference's identity rules. Determine content
ownership before choosing a root or localized companion file.

## Phase 3: Resolve dependencies and scope

### Page template

Use an existing compatible page template when the request identifies one or the
site has one that clearly matches the requested page.

If an end-to-end request requires a new custom layout, invoke
`author-page-template` first. Re-read its resulting metadata before continuing
webpage creation or assignment.

Do not create a new page-template record or alter an existing page template's
rendering source for an ordinary webpage request when a compatible template
already exists. Changing which existing template the webpage references remains
in scope.

### Languages and content

For page creation, follow the reference's configured-language requirements. For
content modification, change only the locale or locales included by the request;
when none is stated, use the uniquely established current/default language.

If initial or modified body content is requested, resolve the locale, target
copy file, sections, elements, and dependencies needed by
`author-webpage-content`. Carry the inspected Bootstrap major and any approved `designContext`
into that handoff, especially for a new or blank page; the content owner must not infer the
framework from missing markup. Do not invent additional sections, business copy,
images, links, scripts, or navigation.

### Navigation

Treat navigation as a separate operation. Create or modify web links only when
the request includes menu or navigation placement.

## Phase 4: Execute through the reference

Use the webpage reference section that owns the operation:

| Operation | Authoritative sections |
|---|---|
| Create | **Webpage creation workflow** through **Navigation links**, using only sections applicable to the request |
| Edit localized content | **Initial page content** and **Modifying an existing webpage** |
| Edit metadata, route, parent, or page template | **Modifying an existing webpage**, including its identity and synchronization subsections |
| Add or edit navigation | **Navigation links** |

Execute all required metadata steps in the selected sections, including UUID
generation, relationship validation, language mapping, and dependency updates.
Create every required directory, metadata record, and companion file, including
empty localized copy files for new records. When body content is part of the
request, invoke `author-webpage-content` once per resolved locale only after
supplying the exact existing target file, locale, operation, final rendered
values, version evidence for new sections, and preservation requirements.

For an existing page request limited to localized body HTML, route directly to
`author-webpage-content` after resolving the target root/localized identity. Do
not edit the HTML independently in this skill.

## Phase 5: Verify and report

Run the full **Verification checklist** and enforce **Prohibited shortcuts** from
the webpage reference. When `author-webpage-content` was invoked, include its
reported content verification in the final dependency review.

Review the final diff and confirm it matches the classified operation and locale
scope.

Report:

- created or modified webpage files;
- page name, route, parent, and page-template binding;
- affected languages;
- content and navigation changes;
- any dependency migrated as part of a route, move, or rename.

State that the changes are local and were not uploaded or deployed.
