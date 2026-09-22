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
<project-root>/docs/customize-declarative-site/current-execution.json
<project-root>/docs/customize-declarative-site/power-pages-icon.png
<project-root>/docs/customize-declarative-site/history/<UTC-timestamp>/
├── plan.json
├── plan.html
├── execution.json
└── power-pages-icon.png
```

`current-plan.json` is the immutable latest approved plan. `current-plan.html` is rendered from
that exact validated JSON during publication. `current-execution.json` records resumable
operation status and actual outputs without mutating the approved plan. Before replacing current
state, archive the complete previous approved run in one timestamped history directory. Never
treat an unapproved review draft as current.

The JSON and HTML serve different audiences without becoming separate sources of truth:

- `current-plan.json` is the complete technical execution contract. It retains operation IDs,
  owning skills, dependencies, typed output bindings, exact targets, and expected outputs.
- `current-plan.html` is the user approval experience derived from that same validated JSON. Its
  default sections describe visible site outcomes: pages and navigation, content and page
  compositions, assets and reusable components, styling, preservation, verification, and the
  local/live boundary.
- The HTML may include a collapsed maintainer-only implementation trace, but it must not make
  operation mechanics the primary plan narrative or introduce data absent from the canonical JSON.

Render each proposed plan in a fresh external review directory outside the declarative site root.
After approval, publish the JSON with
`scripts/promote-customize-declarative-site-plan.js`; the publisher validates it and renders the
canonical HTML itself. It does not accept an independently supplied HTML file. For the normal
`.powerpages-site/` layout,
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
  "assets": [],
  "operations": [],
  "warnings": [],
  "verification": [],
  "deployment": []
}
```

Schema version 1 plans must include `assets`, including an empty array when no visual assets are
needed.

Use `null` for an unavailable template name or styling selection. Do not infer a Microsoft
template from visual similarity.

The customization plan is data-model-neutral. Do not require or infer Standard versus Enhanced
from the downloaded files. `/deploy-site` establishes the authoritative model from the exact
website record in the selected environment immediately before upload.

## New-site design brief

For an explicit `creationIntent: "new-site"` handoff, include `newSiteDesign` in the same
schema-version-1 plan. Omit it for ordinary existing-site edits; old plans remain valid.
Read `${PLUGIN_ROOT}/references/site-design-quality.md` and choose actual design decisions,
not placeholders or a fixed theme copied into every site.

```json
{
  "newSiteDesign": {
    "bootstrapMajor": 5,
    "imageDelivery": "external-url",
    "typography": "Existing approved serif headings paired with a readable sans-serif body; strong display-to-body scale.",
    "palette": "Warm ivory surfaces, deep navy text, restrained teal actions; check every foreground/surface pair.",
    "spacing": "Consistent 8px rhythm with generous section separation and tighter related content.",
    "composition": "Asymmetric image-and-copy hero, service overview, editorial supporting image, clear final action.",
    "responsive": "Stack native columns on narrow screens; preserve image focal points and readable line lengths.",
    "imagery": "required"
  }
}
```

The validator requires:

- numeric `bootstrapMajor` of 5, or 3 with a non-empty `compatibilityReason` recording the user's
  explicit legacy choice. This is verified asset evidence, not a data-model inference;
- non-empty `typography`, `palette`, `spacing`, `composition`, and `responsive` decisions,
  plus the existing top-level `aesthetic` and `mood`;
- `imageDelivery: "external-url"` on every new creation handoff. When present, the validator
  rejects added image assets using Web File delivery; reuse of existing site assets and font
  imports remain supported. Previously approved schema-1 plans without this policy still validate
  and resume unchanged. Never remove the policy or rewrite old approval to change delivery;
- `imagery: "required"` and at least one non-decorative `photograph`, `illustration`, or
  `other-image` with an `informative` or `editorial` role in the validated asset manifest.
  Logo/favicon/icon-only plans do not satisfy the new-site imagery requirement;
- alternatively, `imagery: "user-declined"` with non-empty `imageryReason` recording the user's
  explicit choice. Do not use this exception merely because sourcing is unfinished;
- at least one `style-site` operation, with every styling operation depending directly or
  transitively on all structural operations. This makes styling a final stage in resumable execution.

The HTML approval document displays this brief, including any imagery opt-out. `--action resolve`
returns it with `aesthetic` and `mood` as `designContext`, separate from owner-specific
`resolvedInputs`, so every child receives the same approved direction without duplicating it in
each operation. The brief is covered by the plan hash. It does not authorize CSS before
`style-site`'s separate exact-diff approval, nor prove beauty, contrast, or Studio/runtime rendering.
Verify approved image URLs, placement, any reused local assets, and every brief decision in the
combined local result. The hash binds external URLs, not mutable remote image bytes.

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

## Visual asset records

Assets explain the approved visual decision while operations retain execution mechanics.
New-site image additions use external URLs, as illustrated below; replace example placeholders
with the actual discovered image and provenance:

```json
{
  "id": "home-hero",
  "name": "Home advisory hero",
  "kind": "photograph",
  "role": "editorial",
  "purpose": "Establish a calm, credible first impression for prospective clients.",
  "source": {
    "type": "unsplash",
    "sourcePage": "https://unsplash.com/photos/<photo>",
    "photographer": "<photographer>",
    "license": "Unsplash License"
  },
  "delivery": "external-url",
  "externalUrl": "https://images.unsplash.com/photo-<id>?w=1600&fit=crop&fm=jpg",
  "placements": [
    {
      "page": "Home",
      "section": "Hero",
      "usage": "Wide supporting photograph behind the introduction",
      "scope": "page"
    }
  ],
  "visual": {
    "rationale": "The restrained architectural subject supports the premium visual direction.",
    "aspectRatio": "16:9",
    "crop": "Keep the open left side available for text"
  },
  "accessibility": {
    "decorative": false,
    "altByLocale": {
      "en-US": "Modern advisory office with natural light"
    }
  },
  "preparation": {
    "status": "remote"
  }
}
```

Rules:

- `kind` is `photograph`, `logo`, `favicon`, `icon`, `illustration`, `pattern`, `font`, or
  `other-image`.
- `role` is `brand`, `informative`, `editorial`, `structural`, `functional`, or `decorative`.
- `source.type` is `existing-site`, `user-provided`, `agent-authored`, or `unsplash`.
- `delivery` is `external-url` or `web-file`. External delivery is for images, not fonts.
- External images use `source.type: "user-provided"` (approved hosted/CDN image) or `"unsplash"`,
  a non-empty license/ownership basis, an absolute HTTPS `externalUrl`, and
  `preparation: { "status": "remote" }` only. Reject credentials, whitespace/backslashes and
  non-HTTPS schemes; do not add cache paths, hashes, local URLs or `webFileOperationId`.
- At least one non-`author-web-file` consumer must carry the exact external URL in its static
  `inputs`, including nested component sources. No staging/import operation or output binding
  is needed. Availability, actual image content, hotlink permission, privacy and CSP are reviewed
  separately; schema validation neither fetches nor certifies the remote resource.
- Unsplash external delivery uses `externalUrl` on `images.unsplash.com` plus its Unsplash photo
  page, photographer and license. Legacy `source.downloadUrl`, if supplied too, must match
  `externalUrl` exactly. Web File imports retain the required `source.downloadUrl`.
- For `web-file` delivery, `existing-site` sources use `preparation.status: "existing"` and new
  sources use `staged`.
- Agent-authored assets are safe original SVGs, not raster images.
- New files on the explicit Web File path are staged outside the declarative root with
  `cachePath`, lowercase SHA-256, MIME type, filename and available dimensions. This is not the
  new-site image URL path.
- A staged asset references one `author-web-file` operation whose inputs contain the exact
  `cachePath` and whose outputs include `publicUrl`.
- Existing assets use `preparation.status: "existing"` plus a site-root-relative
  `existingPublicUrl` (never a protocol-relative URL); they do not require a new Web File operation.
- Every placement states page, section, usage, and `page` or `sitewide` scope.
- Every configured site locale has an alternative-text entry. Informative images require
  non-empty text; decorative assets use an empty value.
- Do not include binary bytes, data URIs, tokens, private URLs, or unresolved source choices.
- Unsplash assets retain their photo page, direct image URL, photographer, and license basis.
- Logos and favicons with site-wide placements must identify their exact approved caller in the
  corresponding operation.

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
  "outputBindings": {},
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
- `outputBindings` maps consumer input names to typed outputs of operations in `dependsOn`.
- `preserve` accounts for existing content or behavior that must survive.
- `expectedOutputs` names stable output keys without inventing their values.

Example dependency binding:

```json
{
  "dependsOn": ["add-faq-image"],
  "outputBindings": {
    "heroImageUrl": {
      "sourceOperation": "add-faq-image",
      "output": "publicUrl"
    }
  }
}
```

Every `sourceOperation` must appear earlier and be listed in `dependsOn`. The execution receipt
stores the actual `publicUrl`; the approved plan remains unchanged. The named output must also
appear in the source operation's `expectedOutputs`, and a consumer input cannot be both static in
`inputs` and dynamic in `outputBindings`.

Do not put authentication tokens, environment secrets, or binary file contents in the plan.

## Webpage-content operation

Use the canonical nested section structure expected by `author-webpage-content`:

```json
{
  "id": "compose-contact-page",
  "skill": "author-webpage-content",
  "action": "create",
  "target": {
    "targetFile": "web-pages/contact/content-pages/Contact.en-US.webpage.copy.html"
  },
  "locales": ["en-US"],
  "inputs": {
    "mode": "create",
    "heroImageUrl": "https://cdn.example.com/images/contact-team.jpg",
    "sections": [
      {
        "layout": "two-equal-columns",
        "attributes": {},
        "columns": [
          {
            "elements": [
              {
                "type": "text",
                "content": "Contact our team"
              }
            ]
          },
          {
            "elements": [
              {
                "type": "image",
                "sourceInput": "heroImageUrl",
                "alt": "Customer support team"
              }
            ]
          }
        ]
      }
    ]
  },
  "dependsOn": [],
  "outputBindings": {},
  "preserve": [],
  "expectedOutputs": ["localizedTargetFile"]
}
```

Use the exact existing target path and casing. The target file must already exist before content
composition. Preserve explicit empty columns by retaining them in `columns`; do not flatten
elements into numeric column indexes.

Reject free-form unresolved tokens such as `heroImage`, `primaryCtaUrl`, `TBD`, or `appropriate
snippet`. A dependency that will only exist during execution must use an `outputBindings` entry,
not a guessed value.

## Dependency execution

For new-site image URLs, no asset dependency is needed: pass the approved static URL to the
native content owner. Never create a fake Web File operation to obtain a URL that already exists.
For explicit Web File delivery elsewhere, the approved plan records logical dependencies and
the orchestrator passes actual verified outputs:

```text
author-web-file creates /speaker-hero.jpg
  -> verify metadata and public URL
  -> pass /speaker-hero.jpg to author-webpage-content
```

Never predict UUIDs for new records. The owning skill generates them, and the orchestrator
re-reads the result before invoking a dependent operation.

## Execution receipt

Publication creates `current-execution.json` with the plan hash, run ID, site identity, and one
`pending` entry per operation. Before invoking an operation, resolve its bindings and mark it
`running`. After independent verification, record stable outputs and mark it `completed`.

Use:

```bash
node "${PLUGIN_ROOT}/scripts/update-customize-declarative-site-execution.js" \
  --projectRoot "<PROJECT_ROOT>" --action resolve --operationId "<OPERATION_ID>"
```

The `resolve` result includes effective `resolvedInputs`, combining the approved static inputs
with verified dependency outputs. Then use `start`, followed by
`complete --outputs "<OUTPUTS_JSON>"`, or `fail --error "<MESSAGE>"`.
Completion requires every key named in the approved operation's `expectedOutputs`. After every
operation is complete, use `--action finish`. A later session reads this receipt, verifies its
plan hash and site identity, and resumes at the first ready pending operation. For an interrupted
`running` or `failed` operation, inspect partial files before retrying it; `start` may restart a
failed operation and increments its attempt count.

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
