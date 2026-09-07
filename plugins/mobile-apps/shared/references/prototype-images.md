# Canonical sample images for local prototypes

Use meaningful, fictional records and suitable **actual licensed public HTTPS
images** when the approved scenario benefits from imagery (for example
destinations, products or equipment). Camera capture alone is not sample imagery.
Do not add images to every screen or misrepresent stock imagery as actual
inspection evidence, a real person's identity, or customer data.

## One fixture authority

Author records and `mediaAssets` together through the scenario input, then run
`validate-fixture-scenarios.js`. Its compiled `.tmp/scenario-facts.json` remains
the **only fixture authority**. `src/data/fixtures.ts` is a deterministic
projection, not a second place to author rows, URLs, or credits. There is no
automatic image catalogue selection, second seed loader, or live-data fallback.

For a local photo field, use exactly `{ "mediaAssetKey": "<canonical-key>" }`
inside `records[].fields`. The containing record supplies the exact `id` and
`conceptId`; the field key must match a domain field with `type: "photo"`, and
the domain entity must have the approved concept binding. Never duplicate a
sample URL in a ready-photo object or an image-URL string in that photo field.
The same asset may be explicitly referenced by multiple canonical records.

CDN assets require `source: { kind: "cdn", value: "<fixed-https-image-url>" }`,
`alt`, `fallback`, and all the `provenance` fields below. Preview
`mediaAssetKey`/`mediaAssetKeys` must match the referenced record and its screen
binding, not an unrelated record's image. Existing `local`/`generated`
presentation media remain supported but are not licensed remote photo-field
fixtures.
Presentation-only licensed CDN assets (for example a hero or brand image) keep
the existing explicit screen/preview asset bindings; they do not require an
invented domain entity or photo field. Exact record ownership applies when an
asset is actually referenced by a canonical record photo field.
Legacy presentation-only contracts remain compatible. New record photo fields
always require the complete licensed sample metadata; presentation assets that
include provenance must also pass that contract.

The final HTML preview's derived media contract carries the canonical image
source, alt and provenance. Within its `data-media-asset-key` surface, render
that exact image source and alt. Keep a visible `data-media-credit-key` block
for the asset in the storyboard or all-screens review, including attribution,
creator, changes, the named license and actual source/license links. The
existing preview validator checks these declarations; it does not fetch images
or certify rights. The structural preview also preserves credits and exposes
loading/error states rather than substituting another image on failure.

## Public licensed example

This is a **fragment**, not a standalone scenario or an automatic seed set.
Adapt the records, journey, screen bindings, and photo field to the approved app.
Use this landscape only where its subject is appropriate.

```json
{
  "records": [{
    "id": "fronalpstock",
    "conceptId": "destination",
    "fields": {
      "name": "Fronalpstock panorama trail",
      "photo": { "mediaAssetKey": "fronalpstock-panorama" }
    }
  }],
  "mediaAssets": [{
    "key": "fronalpstock-panorama",
    "source": {
      "kind": "cdn",
      "value": "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3f/Fronalpstock_big.jpg/960px-Fronalpstock_big.jpg"
    },
    "alt": "Panoramic view from Fronalpstock in Switzerland",
    "fallback": "Mountain panorama unavailable",
    "aspectRatio": 2.23,
    "fit": "contain",
    "focalPoint": "center",
    "provenance": {
      "sourcePage": "https://commons.wikimedia.org/wiki/File:Fronalpstock_big.jpg",
      "license": "CC BY-SA 3.0",
      "licenseUrl": "https://creativecommons.org/licenses/by-sa/3.0/",
      "creator": "Hannes Röst",
      "attribution": "Fronalpstock panorama",
      "attributionRequired": true,
      "changes": "Wikimedia thumbnail resized from the original; no other edits."
    }
  }]
}
```

**Observed checks, 2026-09-07:** an HTTPS HEAD of this exact thumbnail returned
`200` and `image/jpeg`; its public Commons page identified Hannes Röst as creator
and offered CC BY-SA 3.0. The linked Creative Commons page was also fetched.
Image bytes were not downloaded or bundled. This is a point-in-time observation,
not a permanent availability guarantee or a claim about other URLs.

CC BY-SA requires credit, a license link, indication of changes, and share-alike
for adaptations. Preserve these facts and comply with any additional terms
when selecting or adapting media. A source website being public does **not**
by itself establish permission to reuse an image.

## Source selection and deterministic checks

- Use public, nonconfidential subject queries only. Do not send user records,
  prompts, tenant/environment details or private URLs to image/search services.
- Select an exact image URL from an actual source/license page. Do not guess
  filenames, construct search/source URLs, or use random-image endpoints.
- Record the creator, credit, selected license and its URL, source-page URL,
  accurate `attributionRequired` boolean, and changes (including “none” when
  applicable). Do not invent attribution, verification timestamps, or rights.
- A supplied HTTPS URI need not be eagerly fetched during offline compilation.
  The compiler validates syntax, bounded metadata and references, **not** live
  availability, DNS reachability or the truth of license declarations. Resolve
  missing license evidence in planning, not by silently treating it as licensed.
- URLs are limited to 2,048 characters and must use public HTTPS hostnames,
  without credentials, signed/access-token parameters, fragments or explicit
  ports. Known private/local and random-source endpoints are rejected.
- Each asset key is a stable ID up to 160 characters. `alt` and `fallback` are
  nonempty plain text up to 300 characters. Provenance limits are 120 for
  `license`, 200 for `creator`, 600 for `attribution`, and 400 for `changes`.
  Provenance rejects undeclared fields; compilation never emits “URL verified”.
  A scenario can contain at most 200 media assets.
- Optional `aspectRatio` is 0.1–10, `fit` is `contain` or `cover` (default), and
  `focalPoint`, if supplied, is `center`. Record any adaptations accurately.

## App-owned rendering API

Generation projects the photo into a ready `PhotoReference`. Its `sample`
contains the exact record/concept/field binding and a copy of the canonical
asset, including source, fallback and complete provenance. Local persistence
and candidate copies retain that metadata. Business screens choose where to
render the image using **the current repository row**, not a global fixture
lookup that could bypass candidate/captured-photo changes:

```tsx
import { Text } from 'react-native';
import { PrototypeImage, useEntity } from '@/data';

export function DestinationPhoto({ id }: { id: string }) {
  const query = useEntity('Destination', id);
  if (query.isPending) return <Text>Loading destination…</Text>;
  if (query.isError) return <Text accessibilityRole="alert">Destination unavailable</Text>;
  if (!query.data) return <Text>Destination not found</Text>;
  return (
    <PrototypeImage
      photo={query.data.photo}
      alt={`Photo of ${query.data.name}`}
      fallback="No photo selected"
      style={{ width: '100%' }}
    />
  );
}
```

`PrototypeImage` and `PrototypeImageProps` are exported from `@/data` and
`@/data/PrototypeImage`. The data-access registry exposes
`media.imageModule` plus
`PrototypeImage(props: PrototypeImageProps): React.JSX.Element`.
Props are `photo?`, required `alt` (for captured/missing photos), `fallback?`,
`style?` (container `ViewStyle`) and `testID?`.

The component uses installed React Native `Image`, `ActivityIndicator`,
`Linking`, and Tamagui theme tokens; it needs no new native dependency.
Canonical alt/fallback take precedence for samples. Loading stays visible until
`onLoad`; `onError` shows an accessible fallback, never a success state or a
different remote image. New sources reset load state, and stale callbacks cannot
mark a replacement photo loaded. Credits, creator, changes and accessible source
and license links remain visible, including on load failure. Credits are shown
even when attribution is optional; link-opening failures are visible too.
The surrounding screen must still render its own record loading/error/empty UI.

## Persistence and isolation

- Public samples remain HTTPS references; local compilation and repository
  reads/writes never download them through FileSystem or `importPhoto`.
  Rendering may use the platform image loader's ordinary HTTP cache.
- Existing captured `file://`/`content://` photos and persisted signature images
  keep their local-file lifecycle and caller-provided accessibility labels.
  Missing files use the image error fallback, not a remote substitution.
- Candidates keep their copy-on-write namespace and original credits.
  Regeneration does not silently reseed persisted rows when facts change.
  Candidate discard deletes only candidate-owned files, never active captures.
- New sample assignments must match the exact canonical record/field;
  unchanged historical sample references retain their provenance. Missing or
  corrupt stored provenance fails visibly rather than silently reseeding.
- Nothing here imports records or media into Dataverse. A connected app's
  migration/import remains a separately approved operation, never a default.
