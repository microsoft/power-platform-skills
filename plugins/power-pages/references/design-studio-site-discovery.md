# Design Studio Site Discovery

Shared site-location contract for workflows that create or modify components in a PAC
CLI-downloaded declarative Power Pages site.

Use this reference before reading or writing webpages, web templates, page templates,
web files, content snippets, or other Design Studio metadata. Component-specific
references define which additional directories and files must exist after the site root
is found.

## Supported site type

A declarative site is identified by a `.portalconfig` directory and PAC-downloaded
metadata such as `website.yml`.

Do not treat `powerpages.config.json` by itself as a declarative-site marker. That file
identifies a Power Pages code site built with React, Angular, Vue, or Astro, which uses a
different authoring model.

The declarative site root is always the parent of `.portalconfig`:

```text
<site-root>/
├── .portalconfig/
├── website.yml
├── web-pages/
├── web-templates/
└── ...
```

The site root can be the current directory or a nested downloaded directory such as
`.powerpages-site/`.

## Discovery procedure

1. Search the current directory and its immediate child directories for
   `.portalconfig`.
2. Exclude dependency, build-output, generated-output, temporary, and version-control
   directories.
3. For every match, treat the parent directory as a candidate `<SITE_ROOT>`.
4. Require `<SITE_ROOT>/website.yml`.
5. Require every component-specific path named by the calling workflow.
6. Reject candidates that have only code-site markers or are missing required
   declarative metadata.
7. Resolve exactly one site before reading or writing component records.

Use file-search tools rather than shell-specific directory parsing so the workflow works
consistently across supported hosts.

## Component-specific requirements

Pass the paths required by the operation into the discovery check:

| Component | Required paths after `website.yml` |
|---|---|
| Webpage | `web-pages/` |
| Web template | `web-templates/` |
| Page template | `page-templates/`; also `web-templates/` when creating, inspecting, or binding a Web Template-type record |
| Web file | `web-files/`, `web-pages/` |
| Content snippet | `content-snippets/`, `websitelanguage.yml` |
| Localized webpage component | `web-pages/` |

Additional metadata can be required later by the component workflow. For example,
multilingual webpage and snippet creation also needs valid portal-language and
website-language records.

Do not create a missing component directory merely to make an unrelated candidate pass
site discovery. Report the missing prerequisite or follow the component workflow's
explicit initialization behavior.

## Selecting among candidates

When exactly one candidate satisfies all required paths, select it automatically.

When several candidates remain, use available evidence in this order:

1. an explicit path in the user's request;
2. a component file or site directory already named in the request;
3. the current working directory being one candidate's root;
4. a uniquely matching component name, ID, route, or file in one candidate;
5. the calling skill's documented selection policy.

Do not select the first filesystem result arbitrarily.

If the evidence does not distinguish the candidates, stop before writing. A calling
skill can ask the user to choose when its interaction policy permits; an autonomous
skill should report the candidate roots and the unresolved evidence.

## Canonical variables

After discovery, use:

- `<SITE_ROOT>` for the parent of `.portalconfig`;
- component paths resolved relative to `<SITE_ROOT>`;
- absolute paths only for tool operations and user-facing diagnostics;
- repository-relative or site-relative paths in committed documentation and generated
  metadata.

Do not derive plugin-owned script or reference paths from `<SITE_ROOT>`. Resolve those
from `${PLUGIN_ROOT}`.

## Verification

Before component authoring begins, confirm:

1. exactly one `<SITE_ROOT>` is selected;
2. `<SITE_ROOT>/.portalconfig` is a directory;
3. `<SITE_ROOT>/website.yml` is a file;
4. every calling workflow requirement exists with the expected file/directory type;
5. the selected root is not inside a dependency, build, generated, temporary, or
   version-control directory;
6. no path used for component writes escapes `<SITE_ROOT>`;
7. the selected project is a declarative site, not a code site.

## Prohibited shortcuts

- Do not use the process working directory as the site root without checking
  `.portalconfig`.
- Do not identify a declarative site from `website.yml` alone.
- Do not treat `powerpages.config.json` as a declarative-site marker.
- Do not select the first of multiple valid candidates without supporting evidence.
- Do not search broadly outside the current workspace to find a convenient site.
- Do not create missing metadata directories during discovery unless the component
  workflow explicitly owns that initialization.
- Do not resolve `${PLUGIN_ROOT}` resources relative to the downloaded site.
