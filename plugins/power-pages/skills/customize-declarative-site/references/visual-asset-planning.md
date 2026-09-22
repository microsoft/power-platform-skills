# Declarative Visual Asset Planning

Use this reference when a declarative-site customization may benefit from photography, logos,
favicons, icons, illustrations, patterns, fonts, or other visual Web Files.

## Design role before source

Do not add an asset merely to fill a hero, card, or empty column. Inspect the visitor journey and
classify each proposed visual by the job it performs:

| Role | Typical assets | Planning rule |
|---|---|---|
| Brand | Logo, wordmark, favicon, brand pattern | Prefer existing or user-approved brand files |
| Informative | Product image, map, diagram | Require a source that communicates the stated fact |
| Editorial | People, place, service photography | Use only when it improves credibility or context |
| Structural | Section divider, background motif | Prefer original SVG or CSS atmosphere |
| Functional | Icons, state markers, directional cues | Use a coherent original SVG set and never rely on color alone |
| Decorative | Abstract flourishes and textures | Keep restrained and use empty alternative text |

FAQ, pricing, policy, and operational pages often benefit more from typography, spacing, and
simple original SVG details than unrelated stock photography. Record `assets: []` when no visual
asset improves the requested outcome.

## Source priority

Resolve sources in this order:

1. existing site Web Files and template images;
2. user-provided approved brand assets and photography;
3. original agent-authored SVG icons, patterns, dividers, and simple illustrations;
4. curated Unsplash photography.

Do not generate raster images. Do not use another stock provider. Do not use placeholder-image
services or leave unresolved image slots.

### Existing site assets

Inspect `web-files/`, image callers, logo/favicon callers, snippets, templates, and comparable
pages. Reuse an existing asset only when its identity, public URL, permissions boundary, visual
role, and licensing/ownership are appropriate for the new placement.

### User-provided assets

Treat every supplied file as untrusted. Stage it with:

```bash
node "${PLUGIN_ROOT}/scripts/prepare-declarative-asset.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --sourcePath "<SOURCE_FILE>"
```

The helper validates supported signatures, dimensions, MIME agreement, size, and SVG safety,
writes approved bytes under `.powerpages-customization/assets/`, adds that cache to `.gitignore`,
and returns the project-relative path and SHA-256. The cache is outside the declarative site root
and must never be passed to `pac pages upload`.

### Original SVG assets

Original SVG is suitable for simple geometry, icons, patterns, and non-photographic illustration.
Author it in the fresh external review directory, then stage it through the same helper before the
plan is approved. Use a real `viewBox`; do not encode visitor-facing text into the SVG when HTML
text would be more accessible and localizable.

The helper rejects declarations/entities, external stylesheets, script or style elements, style
and event-handler attributes, embedded HTML or media, and external resource references. Use SVG
presentation attributes for simple geometry. Do not weaken those checks to accommodate a design.

### Unsplash photography

Use `WebSearch` to find a specific Unsplash photo whose subject, composition, lighting, color
temperature, orientation, and available text space fit the page. Record both:

- the human-readable `https://unsplash.com/...` photo page;
- the direct `https://images.unsplash.com/...` image URL with explicit sizing/crop parameters and
  a supported format such as `fm=jpg`.

Stage the selected image:

```bash
node "${PLUGIN_ROOT}/scripts/prepare-declarative-asset.js" \
  --projectRoot "<PROJECT_ROOT>" \
  --downloadUrl "<HTTPS_IMAGES_UNSPLASH_URL>" \
  --sourcePage "<HTTPS_UNSPLASH_PHOTO_PAGE>" \
  --fileName "<SAFE_FILENAME_WITH_EXTENSION>"
```

Unsplash's published license permits downloading, copying, modifying, distributing, and
commercial use without required attribution. The license does not grant separate rights for
recognizable people, trademarks, artwork, or protected property visible in a photograph. Avoid
those subjects when the planned use could imply endorsement or require additional rights; retain
a plan warning when the context needs human legal/brand review.

Import the staged file as a local Power Pages Web File by default. Do not hotlink the Unsplash URL
in the finished declarative page.

## Composition decisions

For each approved asset, resolve:

- role and visitor-facing purpose;
- page, section, and global-versus-page scope;
- visual rationale;
- aspect ratio, crop, and focal-point intent;
- informative versus decorative behavior;
- localized alternative text for every affected locale;
- optional safe link destination;
- existing, staged, or global-caller dependencies;
- whether `style-site` is required for presentation after placement.

Use the image component's responsive defaults unless the inspected site establishes a stronger
pattern. Do not invent unsupported image components, inline arbitrary data URIs, or copy Design
Studio placeholder SVG payloads.

## Logos and favicons

Do not silently invent an official company logo. Prefer, in order:

1. preserve the verified current logo;
2. use a supplied approved logo;
3. propose a clearly labeled typography-only wordmark or simple original geometric mark;
4. make no logo change.

A logo or favicon change is site-wide even when only one Web File is imported. Resolve the exact
existing snippet, template, site setting, or other caller. Update only that caller after approval.
Do not replace the complete website header merely to change a logo, and preserve navigation,
search, language selection, sign-in behavior, caching assumptions, and anonymous/authenticated
branches.

## Execution and verification

Create/import operations belong to `author-web-file`. Their consumers depend on the import and
bind the verified `publicUrl`; never put a guessed future URL in page content.

After execution verify:

- staged SHA-256 matches the imported bytes;
- binary and adjacent `.webfile.yml` both exist;
- extension, MIME type, filename, metadata, IDs, parent, and public URL agree;
- every planned caller uses the final root-relative URL;
- informative images have localized alternative text and decorative images use `alt=""`;
- dimensions preserve aspect ratio and fit the approved Design Studio column;
- no unapproved SVG active content or base64 placeholder remains;
- global brand callers and unrelated assets are preserved;
- target-environment attachment size and blocked-extension policy remain satisfied.

Local inspection cannot prove the final crop, visual balance, CSP behavior, or live rendering.
Keep desktop/mobile crop, readability over imagery, logo scaling, and runtime performance as
pending live checks unless they are separately authorized and performed.
