# Declarative Site Customization Plan Contract

The customization plan is the durable coordination artifact for
`customize-declarative-site`. It describes user intent and cross-skill dependencies without
replacing the authoring references that own PAC metadata and serialization.

## Location

Keep one canonical approved plan and its browser rendering under the project documentation
directory:

```text
<project-root>/docs/customize-declarative-site/current-plan.json
<project-root>/docs/customize-declarative-site/current-plan.html
<project-root>/docs/customize-declarative-site/power-pages-icon.png
<project-root>/docs/customize-declarative-site/history/<UTC-timestamp>/
├── plan.json
├── plan.html
└── power-pages-icon.png
```

`current-plan.json` is the authoritative latest approved plan. `current-plan.html` is its
browser-viewable rendering. Before replacing them, archive the complete previous approved plan in
one timestamped history directory. Never treat an unapproved review draft as current.

Render each proposed plan in a fresh external review directory outside the declarative site root.
After approval, promote it with
`scripts/promote-customize-declarative-site-plan.js`. For the normal `.powerpages-site/` layout,
`docs/` is its sibling under the project root. When a manually downloaded site root is also the
project root, `docs/` remains outside the known PAC component directories; `pac pages upload` must
still receive the exact declarative root rather than the documentation directory.

## Top-level shape

```json
{
  "schemaVersion": 1,
  "site": {
    "name": "Contoso Event Portal",
    "websiteRecordId": "00000000-0000-0000-0000-000000000000",
    "templateName": "EventPortal",
    "siteRoot": ".powerpages-site",
    "languages": ["en-US"]
  },
  "summary": "Adapt the downloaded Event Portal for a developer conference.",
  "preservation": "Retain the template structure while adding pages and sections.",
  "aesthetic": "Bold & Vibrant",
  "mood": "Technical & Precise",
  "capabilities": [],
  "operations": [],
  "warnings": [],
  "verification": [],
  "deployment": []
}
```

Use `null` for an unavailable template name or styling selection. Do not infer a Microsoft
template from visual similarity.

The customization plan is data-model-neutral. Do not require or infer Standard versus Enhanced
from the downloaded files. `/deploy-site` establishes the authoritative model from the exact
website record in the selected environment immediately before upload.

## Capability records

Capabilities describe readiness observed in the downloaded files:

```json
{
  "name": "Webpage authoring",
  "status": "ready",
  "evidence": ["web-pages/", "website.yml"],
  "ownerSkill": "author-webpage",
  "note": "Root and localized page records can be created or modified."
}
```

`status` is `ready`, `blocked`, or `not-requested`. A blocked capability must name the missing
prerequisite and a local remediation; it is not a permanent template limitation.

## Operation envelope

```json
{
  "id": "create-speakers-page",
  "skill": "author-webpage",
  "action": "create",
  "target": {},
  "locales": ["en-US"],
  "inputs": {},
  "dependsOn": [],
  "resolvedDependencies": {},
  "preserve": [],
  "expectedOutputs": []
}
```

Rules:

- `id` is unique kebab-case.
- `skill` is one owning declarative authoring skill.
- `action` uses the owning skill's terminology.
- Existing targets include stable IDs and exact paths when available.
- New targets use names/routes and let the owning skill generate record IDs.
- `locales` lists only affected languages.
- `inputs` contains final visitor-facing values, files, URLs, and behavior.
- `dependsOn` references operation IDs.
- `resolvedDependencies` is empty at approval time unless the dependency already exists.
- `preserve` accounts for existing content or behavior that must survive.
- `expectedOutputs` names component kinds and paths without inventing generated IDs.

Do not put authentication tokens, environment secrets, or binary file contents in the plan.

## Webpage-content operation

Use the canonical nested section structure expected by `author-webpage-content`:

```yaml
targetFile: web-pages/contact/content-pages/Contact.en-US.webpage.copy.html
locale: en-US
mode: create
sections:
  - layout: two-equal-columns
    attributes: {}
    columns:
      - elements:
          - type: text
            content: Contact our team
      - elements:
          - type: image
            source: /contact-hero.jpg
            alt: Customer support team
resolvedDependencies:
  webFiles:
    contact-hero.jpg: /contact-hero.jpg
  snippets: {}
preserve: []
```

Use the exact existing target path and casing. The target file must already exist before content
composition. Preserve explicit empty columns by retaining them in `columns`; do not flatten
elements into numeric column indexes.

Reject unresolved design tokens such as `heroImage`, `primaryCtaUrl`, `TBD`, or `appropriate
snippet`. Upstream operations must return final public URLs, routes, snippet names, and template
identities before a dependent operation runs.

## Dependency execution

The approved plan records logical dependencies. At execution time, the orchestrator passes actual
verified outputs:

```text
author-web-file creates /speaker-hero.jpg
  -> verify metadata and public URL
  -> pass /speaker-hero.jpg to author-webpage-content
```

Never predict UUIDs for new records. The owning skill generates them, and the orchestrator
re-reads the result before invoking a dependent operation.

## Styling

The customization plan records visual intent, affected pages/components, and scope. It does not
contain an executable CSS patch. `style-site` prepares the exact CSS/source diff and retains its
own per-revision approval and drift checks.

## Verification records

List concrete checks:

```json
{
  "label": "Speaker page relationships",
  "description": "Verify the root/localized page records, parent, page template, and navigation link."
}
```

## Deployment records

Deployment choices describe the local/live boundary:

```json
{
  "title": "Deploy after verification",
  "description": "Invoke deploy-site, confirm the environment and authoritative data model, then upload.",
  "recommended": true
}
```

Plan approval authorizes local orchestration only. It never authorizes upload or other cloud
mutation.
