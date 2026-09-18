---
name: author-content-snippet
description: >-
  Creates or modifies content snippets in a PAC CLI-downloaded declarative Power
  Pages site, including localized and language-neutral records, Text or HTML
  values, translations, Liquid, renames, type changes, and safe deletion. Use
  whenever the user asks to create, add, author, edit, translate, rename,
  localize, convert, or remove a Power Pages content snippet, reusable
  maker-managed string, shared label, message, logo value, or snippet-backed
  header/footer content. This skill owns snippet records and required
  name-based dependency migrations. Use author-webpage or author-web-template
  when the primary request is broader page or template authoring. Do not use for
  React, Angular, Vue, or Astro code sites.
user-invocable: true
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Skill, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it
> outputs a message, show it to the user before proceeding.

# Author Content Snippet

Create or modify Design Studio-compatible content snippets in a declarative
Power Pages site downloaded by PAC CLI.

**Initial request:** $ARGUMENTS

## Authoritative references

Always read and follow:

- `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`
- `${PLUGIN_ROOT}/skills/classic-site-skills/author-content-snippet/references/design-studio-content-snippet-authoring.md`

Read when applicable:

- `${PLUGIN_ROOT}/skills/classic-site-skills/author-webpage/references/design-studio-webpage-authoring.md` when a localized
  webpage renders or must stop rendering the snippet
- `${PLUGIN_ROOT}/skills/classic-site-skills/author-web-template/references/design-studio-web-template-authoring.md` when a web
  template renders or must stop rendering the snippet

The references own PAC structure, language mapping, metadata fields, file naming,
Text and HTML behavior, Liquid patterns, output safety, dependency handling,
modification rules, and verification. Do not duplicate or replace those
contracts in this skill.

## Autonomy policy

Complete routine snippet authoring without asking the user to approve mechanical
details. Infer safe choices from `$ARGUMENTS`, the authoritative reference, the
enabled website languages, existing snippet conventions, callers, and the
nearest comparable records.

Choose independently when safe:

- the site root when exactly one valid declarative site is present;
- directory and file stems;
- Text or HTML when the requested value and rendering context clearly establish
  the narrower appropriate type;
- localized scope for translatable visitor-facing content;
- language-neutral scope only when the request and existing site convention
  clearly establish one shared value;
- the smallest set of files needed for a value, display-name, type, translation,
  or dependency change;
- escaping, accessibility, and safe Liquid rendering details.

Do not create caller markup merely because a snippet record is created. Do not
expand a one-language edit to every language. Do not invent translations.

Stop before writing only when a high-impact ambiguity cannot be resolved from
the request or workspace, such as:

- multiple declarative sites or target records with no supported winner;
- duplicate logical names whose active record cannot be established;
- missing translated values for requested languages;
- an ambiguous choice between localized and language-neutral scope;
- an unsafe type conversion, deletion, or rename with unresolved callers;
- a requested dynamic or data-reading value whose permissions, trust boundary,
  or output context cannot be established.

When stopped, report the candidates and evidence. Do not guess through a
localization, identity, or security boundary.

## Workflow

1. Locate and validate the declarative site.
2. Classify the snippet operation and language scope.
3. Resolve the target records, values, and every affected caller.
4. Execute the matching content-snippet reference workflow.
5. Verify localization, identity, rendering safety, dependencies, and the final
   diff.

Do not upload, deploy, or modify Dataverse directly. This skill changes only the
downloaded local site.

## Phase 1: Locate the site

Follow `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`, requiring
`content-snippets/`, `websitelanguage.yml`, and
`.portalconfig/portallanguage.yml`.

Apply the autonomy policy if several candidates remain: use request and
workspace evidence, but stop rather than selecting a site arbitrarily.

## Phase 2: Classify and inspect

Classify `$ARGUMENTS` as one or more of:

- create a localized or language-neutral snippet;
- change one or more localized values;
- add or remove a translation;
- change a language-neutral value or migrate its scope;
- rename the logical name or display name;
- convert Text to HTML or HTML to Text;
- change Liquid or nested snippet behavior;
- delete one language variant or the complete logical snippet;
- add, remove, or migrate an explicitly requested caller.

Read the complete content-snippet reference, then inspect:

- `websitelanguage.yml` and `.portalconfig/portallanguage.yml`;
- all metadata and value files for the target `adx_name`;
- normalized-path collisions and duplicate logical names;
- exact snippet lookups in web-template source, localized webpage copy, and
  other snippet values;
- the final rendering context, including cached header or footer usage.

Resolve existing records by logical name, language scope, and
`adx_contentsnippetid`. Do not select a record by directory name alone.

## Phase 3: Resolve ownership and scope

This skill owns:

- content-snippet metadata and value files;
- translation variants and language-neutral scope;
- exact caller migrations required to keep a snippet rename, type conversion,
  or approved deletion coherent.

Creating a snippet does not automatically make it visible. Add or change a
caller only when the request explicitly includes that rendering change.

For a small, exact caller change, follow the applicable webpage or web-template
reference and edit only the required Liquid lookup. If the request requires
broader page layout, component placement, or template composition, invoke
`author-webpage` or `author-web-template` with the resolved snippet contract,
then re-read the resulting caller before verification.

Do not use this skill to redesign unrelated page or template content.

## Phase 4: Execute through the reference

Use the content-snippet reference section that owns the operation:

| Operation | Authoritative sections |
|---|---|
| Create | **Content snippet creation workflow** through **Value file** |
| Choose Text or HTML | **Choosing Text or HTML** and **Output-context safety** |
| Render or evaluate Liquid | **Rendering snippets with Liquid**, **Liquid and data access**, and **Header and footer caching** |
| Modify, rename, or convert type | **Modifying an existing content snippet** and its applicable safety subsection |
| Add a translation | **Adding a translation** |
| Delete | **Deletion rules** |

Execute every required step in the selected sections, including enabled-language
mapping, UUID generation, identity preservation, scope preservation, dependency
migration, and context-appropriate encoding.

For a new translatable snippet, create a record for every enabled website
language unless the request explicitly limits the scope. Require a real value
for each requested translation when non-empty content is expected. For a new
language-neutral record, require clear evidence that one shared value is
intentional.

Apply the smallest coherent local change. Preserve unknown PAC fields, existing
IDs, unrelated translations, and established path shapes.

## Phase 5: Verify and report

Run the full **Verification checklist** and enforce **Prohibited shortcuts** from
the content-snippet reference. Also apply the relevant verification rules from
the webpage or web-template reference for every caller changed.

Review the final diff and confirm it matches the classified operation and
language scope.

Report:

- created, modified, renamed, localized, converted, or deleted files;
- the logical name, type, stable IDs, and localized or language-neutral scope;
- affected languages and whether each value is Text, HTML, or trusted Liquid;
- updated callers and dependency migrations;
- intentionally preserved missing translations, neutral records, or legacy
  behavior.

State that the changes are local and were not uploaded or deployed.

### Record skill usage

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference using
`--skillName "AuthorContentSnippet"`.
