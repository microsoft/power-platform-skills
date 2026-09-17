---
name: author-web-file
description: >-
  Creates or modifies web files in a PAC CLI-downloaded declarative Power Pages
  site, including images, CSS, JavaScript, fonts, documents, and other
  site-served assets with their adjacent YAML and Dataverse note metadata. Use
  whenever the user asks to add, upload, import, author, replace, edit, rename,
  move, configure, schedule, reorder, or delete a Power Pages web file or static
  asset. This skill owns the asset/YAML pair and required URL dependency
  migrations. Use author-webpage or author-web-template when the primary request
  is broader page or template authoring. Do not use for React, Angular, Vue, or
  Astro code sites.
user-invocable: true
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Skill, TaskCreate, TaskUpdate, TaskList
model: sonnet
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it
> outputs a message, show it to the user before proceeding.

# Author Web File

Create or modify Design Studio-compatible web files in a declarative Power Pages
site downloaded by PAC CLI.

**Initial request:** $ARGUMENTS

## Authoritative references

Always read and follow:

- `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`
- `${PLUGIN_ROOT}/skills/classic-site-skills/author-web-file/references/design-studio-web-file-authoring.md`

Read when applicable:

- `${PLUGIN_ROOT}/skills/classic-site-skills/author-webpage/references/design-studio-webpage-authoring.md` when a localized
  webpage references or must stop referencing the asset
- `${PLUGIN_ROOT}/skills/classic-site-skills/author-web-template/references/design-studio-web-template-authoring.md` when a web
  template references or must stop referencing the asset
- the applicable component reference when the request includes placing an image,
  button, video, or other supported component on a page

The references own PAC structure, attachment metadata, identity, URL hierarchy,
MIME types, visibility, CSS ordering, file security, dependency handling,
modification rules, and verification. Do not duplicate or replace those
contracts in this skill.

## Autonomy policy

Complete routine web-file authoring without asking the user to approve
mechanical details. Infer safe choices from `$ARGUMENTS`, the authoritative
reference, the source asset, structural Home page, existing web-file
conventions, callers, and the nearest comparable records.

Choose independently when safe:

- the site root when exactly one valid declarative site is present;
- the structural Home root page as the parent for a new ordinary site-wide
  asset when no other parent is requested;
- normalized filenames and partial URLs for new assets;
- MIME type when the extension, signature, and existing convention agree;
- inline delivery for browser-rendered assets and attachment delivery when the
  request clearly describes a download;
- search, sitemap, publishing-state, and display-order values from the requested
  behavior and comparable records;
- the smallest files required for a content or metadata modification;
- accessibility and safe loading details in explicitly requested callers.

Creating a web file does not automatically place it on a page or load it from a
template. Do not change CSS precedence, page permissions, callers, or navigation
unless the request requires that change.

Stop before writing only when a high-impact ambiguity cannot be resolved from
the request or workspace, such as:

- multiple declarative sites or target web files with no supported winner;
- no identifiable source for a requested binary asset;
- conflicting filename, file signature, extension, or MIME type;
- an absent or ambiguous parent page when Home is not the intended parent;
- a rename, move, type migration, or deletion with unresolved callers;
- an unsupported or blocked extension, secret-bearing content, or active content
  whose safety cannot be established;
- an ambiguous CSS ordering change or visibility window.

When stopped, report the candidates and evidence. Do not guess through an
identity, security, permissions, or public-URL boundary.

## Workflow

1. Locate and validate the declarative site.
2. Classify the web-file operation and resolve the source or target.
3. Resolve the parent, URL, MIME type, metadata, and every affected caller.
4. Execute the matching web-file reference workflow.
5. Verify bytes, metadata, identity, permissions, dependencies, and the final
   diff.

Do not upload, deploy, or modify Dataverse directly. This skill changes only the
downloaded local site.

## Phase 1: Locate the site

Follow `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`, requiring
`web-files/` and `web-pages/`.

Apply the autonomy policy if several candidates remain: use request and
workspace evidence, but stop rather than selecting a site arbitrarily.

## Phase 2: Classify and inspect

Classify `$ARGUMENTS` as one or more of:

- import an existing binary or text asset;
- author a new CSS, JavaScript, JSON, text, SVG, or other text-based asset;
- replace an existing asset's bytes;
- edit an existing text asset;
- rename the asset or change its extension;
- move it under another parent page;
- change publishing, search, sitemap, delivery, scheduling, or display-order
  metadata;
- add, remove, or migrate an explicitly requested caller;
- delete the web file.

Read the complete web-file reference, then inspect:

- the source file or complete existing asset;
- the matching `.webfile.yml`;
- root webpage records and the intended parent hierarchy;
- sibling page and web-file partial URLs;
- comparable web files of the same purpose or MIME type;
- exact URL, filename, and ID references across webpages, web templates,
  content snippets, CSS, JavaScript, site settings, and other text assets;
- target-environment extension and attachment-size constraints when available.

Resolve an existing web file by its asset filename, metadata identity, parent,
and public URL. Do not select it by a similar basename or extension alone.

## Phase 3: Resolve ownership and caller boundaries

This skill owns:

- the asset and adjacent `.webfile.yml` pair;
- note-attachment identity and web-file metadata;
- exact URL migrations required to keep an approved rename, move, extension
  change, or deletion coherent.

For an imported binary asset, use a binary-safe copy operation and preserve the
bytes exactly. Do not read and rewrite binary content through text-editing
tools. Text editing is appropriate only after the file is established as a
supported text asset.

Add or change a caller only when the request explicitly includes that rendering
or loading change. For a small, exact reference update, follow the applicable
webpage, web-template, content-snippet, or component reference and change only
the required URL. If the request requires broader page layout or template
composition, invoke `author-webpage` or `author-web-template` with the resolved
web-file URL and accessibility/loading requirements, then re-read the caller
before verification.

Do not use this skill to redesign unrelated page or template content.

## Phase 4: Execute through the reference

Use the web-file reference section that owns the operation:

| Operation | Authoritative sections |
|---|---|
| Create or import | **Web file creation workflow** through **Web file and attachment YAML** |
| Resolve parent and URL | **Parent page, URL, and permissions** |
| Resolve content type | **MIME type** and **File validation and security** |
| Configure visibility or delivery | **Visibility and delivery fields** |
| Add or reorder CSS | **CSS web files** |
| Add or migrate callers | **Referencing web files** and **Rename and move safety** |
| Modify or replace | **Modifying an existing web file** |
| Delete | **Deletion rules** |

Execute every required step in the selected sections, including source
validation, collision checks, separate web-file and annotation UUID generation,
binary-safe copying, parent and publishing-state resolution, MIME verification,
identity preservation, and dependency migration.

Apply the smallest coherent local change. Preserve unknown PAC fields, existing
IDs, asset bytes, filename casing, omitted optional fields, and unrelated
callers unless the requested operation requires changing them.

## Phase 5: Verify and report

Run the full **Verification checklist** and enforce **Prohibited shortcuts** from
the web-file reference. Also apply the relevant verification rules from every
webpage, web-template, content-snippet, or component reference used for caller
changes.

Review the final diff and confirm it matches the classified operation. For
binary changes, verify the expected file exists and avoid interpreting binary
diff output as text.

Report:

- created, imported, modified, replaced, renamed, moved, scheduled, reordered,
  or deleted files;
- the public URL, parent page, MIME type, and delivery behavior;
- the stable web-file and annotation IDs;
- updated callers and URL migrations;
- CSS precedence or visibility changes;
- intentionally preserved optional fields or legacy behavior.

State that the changes are local and were not uploaded or deployed.

### Record skill usage

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill tracking instructions in the reference using
`--skillName "AuthorWebFile"`.
