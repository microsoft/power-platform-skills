---
name: author-web-template
description: >-
  Creates or modifies a web template in a PAC CLI-downloaded declarative Power
  Pages site, including its YAML metadata, Liquid/HTML source, and explicitly
  requested callers or bindings. Use whenever the user asks to create, add,
  generate, edit, rename, refactor, or replace a Power Pages web template,
  Liquid template, reusable template fragment, inherited layout, page layout
  source, or website header/footer template. For an end-to-end custom page layout
  that also needs page-template metadata, use author-page-template. Do not use
  for React, Angular, Vue, or Astro code sites.
user-invocable: true
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Skill, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it
> outputs a message, show it to the user before proceeding.

# Author Web Template

Create or modify a Design Studio-compatible web template in a declarative Power
Pages site downloaded by PAC CLI.

**Initial request:** $ARGUMENTS

## Authoritative references

Read and follow:

- `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`
- `${PLUGIN_ROOT}/skills/classic-site-skills/author-web-template/references/design-studio-web-template-authoring.md`

These references own site discovery, the metadata contract, file layout, Liquid composition rules,
dependency model, caching behavior, modification rules, and verification
checklist. Do not reproduce a conflicting local interpretation.

## Autonomy policy

Complete the request without asking the user about routine implementation
details. Infer sensible choices from `$ARGUMENTS`, existing site conventions, and
the nearest comparable templates.

Choose independently when safe:

- site root when exactly one valid declarative site is present;
- directory and file stems from the requested template name;
- reusable fragment, base layout, derived layout, or page-layout shape from the
  requested behavior;
- formatting, block names, parameter names, escaping, and accessibility details;
- whether only source or both metadata and source need changing;
- exact dependency edits that are necessary to keep an explicitly requested
  rename or refactor working.

Do not ask for approval before ordinary local file edits. Stop without writing
only when a decision would materially change the user's intent and cannot be
resolved safely, such as:

- multiple declarative sites with no evidence identifying the target;
- multiple existing templates matching the requested target;
- a requested global header/footer rebind that was not explicit;
- a destructive deletion with unresolved callers;
- a requested output whose content or required data contract is genuinely
  unspecified.

When stopped, report the unresolved choices and the evidence found. Do not guess
through a high-impact ambiguity.

## Workflow

1. Locate and validate the declarative site.
2. Classify the request as create, source edit, rename, refactor, rebind, or
   delete.
3. Read the authoritative reference and all relevant existing records.
4. Resolve the target, callers, and output contract.
5. Plan the smallest coherent file change internally.
6. Create or modify the files.
7. Verify the complete dependency graph and final diff.

Do not upload, deploy, or modify Dataverse directly. This skill changes only the
downloaded local site.

## Phase 1: Locate the site

Follow `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`, requiring
`web-templates/`. Apply this skill's autonomy policy when several valid sites
remain: use request and workspace evidence, but stop rather than selecting
arbitrarily.

## Phase 2: Understand the request

Read every relevant:

- `web-templates/*/*.webtemplate.yml`;
- matching `.webtemplate.source.html`;
- page-template YAML that references affected web-template IDs;
- `website.yml` when header or footer behavior is involved;
- web-template, webpage-copy, and content-snippet source containing name-based
  Liquid references.

Resolve:

- the intended `adx_name`;
- whether this is a new or existing record;
- the template's composition role;
- expected caller inputs and output context;
- all name-based `include` and `extends` dependencies;
- all ID-based page-template or website bindings;
- whether header/footer output caching affects dynamic regions.

For an existing template, identify it by both `adx_name` and
`adx_webtemplateid`. Do not select by directory name alone.

## Phase 3: Decide the implementation

Apply these defaults when the user has not specified a minor detail:

- Create a reusable fragment when the request describes shared markup or logic.
- Create a page-layout template when the request describes rendering webpage
  content.
- Use a base layout only when multiple derived layouts need stable overridable
  regions.
- Use a derived layout only when an existing base template clearly provides the
  required blocks.
- Preserve the current website header and footer bindings unless the request
  explicitly changes them.
- Preserve existing IDs, names, response boundaries, and callers unless the
  requested change requires modifying them.
- Use content snippets or localized page fields for maker-managed or translated
  strings rather than hardcoding them.
- Keep request-, user-, page-, language-, or time-dependent header/footer output
  inside the narrowest practical `substitution` block.

Do not implicitly create a page template. A web template used as an include,
base layout, derived layout, header/footer, or reusable source does not need one.
The `author-page-template` skill owns end-to-end custom page layouts and can
invoke this skill to create their source. If the current request explicitly
needs webpage rendering through this new source, complete the web template first
and then run the corresponding `author-page-template` workflow, which must
consider safe reuse of an existing page template before creating another.

## Phase 4: Create a web template

For a new record:

1. Confirm the logical name is unique.
2. Derive the directory and file stem according to the authoritative reference
   and existing site convention.
3. Run:

   ```bash
   node "${PLUGIN_ROOT}/scripts/generate-uuid.js"
   ```

4. Create exactly:

   ```text
   web-templates/<template-directory>/
   ├── <Template-Stem>.webtemplate.yml
   └── <Template-Stem>.webtemplate.source.html
   ```

5. Put the new UUID in `adx_webtemplateid` and the functional lookup name in
   `adx_name`.
6. Write production-ready source for the requested purpose. Do not leave sample
   business content, TODOs, or unexplained placeholders.
7. Add only the callers or metadata bindings explicitly required by the request.

## Phase 5: Modify a web template

For an existing record:

1. Resolve exactly one metadata/source pair.
2. Preserve `adx_webtemplateid`.
3. Read the complete source before editing.
4. Make the smallest coherent change without reformatting unrelated markup.
5. For a rename, update `adx_name`, rename paths only when the convention
   requires it, and migrate every exact `include` or `extends` caller.
6. For block changes, update every affected extending template.
7. For a changed caller contract, update all confirmed callers and preserve
   compatible defaults where appropriate.
8. For an explicitly requested page-template rebind, invoke
   `author-page-template` so it inventories every dependent root and localized
   webpage before changing the binding.
9. For an explicitly requested website header/footer rebind, change only the
   selected binding after validating the target source contract and global
   behavior.

Do not delete, replace, or regenerate the existing record ID.

## Phase 6: Delete safely

Delete a web template only when the request explicitly asks for deletion and all
dependencies are resolved.

1. Search Liquid source and localized webpage copy for name-based references.
2. Search page templates, `website.yml`, and all YAML for ID-based references.
3. Check inheritance, header/footer, and active page-layout dependencies.
4. Migrate or remove only the dependencies covered by the request.
5. Delete the metadata/source pair and its directory only when no dependency
   remains.

If unresolved callers remain, do not partially delete the template.

## Phase 7: Verify and report

Run the complete verification checklist from the authoritative reference. At
minimum, confirm:

- the YAML parses;
- each template has one matching metadata/source pair;
- names and IDs are unique;
- existing IDs were preserved;
- Liquid tags, inheritance, includes, blocks, and parameters are valid;
- all name-based and ID-based targets resolve;
- dynamic cached regions use `substitution` where needed;
- output encoding and accessibility match the rendering context;
- no unrelated files changed.

Report:

- created, modified, renamed, rebound, or deleted files;
- the template name and stable ID;
- its composition role;
- updated callers or bindings;
- any intentionally preserved legacy behavior.

State that the changes are local and were not uploaded or deployed.

### Record skill usage

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference using
`--skillName "AuthorWebTemplate"`.
