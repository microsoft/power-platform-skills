# Image sources and storage

Load when choosing, rendering or seeding imagery. Remote image media is not remote executable
code. Neither HTML nor React Native requires every image to be local.

## Choose by use

| Use | Suitable source and handling |
|---|---|
| HTML intent preview | Local asset or verified public HTTPS image URL, including a CDN; render with an image element, accessible alternative, reserved dimensions and loading/error fallback |
| Source-derived implementation preview | Preserve the source's media treatment; use a suitable public HTTPS URL or a disclosed illustrative/local substitute when the source is private; never call tenant APIs to obtain preview images |
| React Native image display | Local asset or public HTTPS image URL through the installed image component (`expo-image` in this template); network access is required for uncached remote media |
| Sample data in an approved image-URL/Text column | Store the verified URL string; no download/upload step is required |
| Dataverse Image/File column | Store image/file bytes, not a URL string; if the source is remote, download and validate the bytes before the supported upload |

Dataverse Image columns use the exact generated upload/base64 contract; File columns use the
supported file upload after the record exists. Read through generated services/host controls.
See [image column data](https://learn.microsoft.com/power-apps/developer/data-platform/image-column-data)
and [file column data](https://learn.microsoft.com/power-apps/developer/data-platform/file-column-data).
Do not change approved schema just to accommodate an illustrative preview image.

## Verify remote imagery

- Use a stable, public HTTPS image URL with a documented source and license/permission covering
  the intended use, attribution and remote embedding. A working URL does not prove licensing.
  No invented URLs, scraped private media, random-image endpoints or provider-wide license assumptions.
- Apply the existing [network input policy](../../skills/design-system/references/input-modes.md#network)
  to verification/download requests: validate public destinations and redirects, enforce its
  time/size limits, and verify an image response and successful decode, not merely a URL suffix
  or successful HEAD request. Use supported non-executable raster media such as PNG/JPEG/WebP;
  do not inline fetched SVG/HTML or execute imported content.
- No credentials, authorization headers, signed access tokens, personal/tenant data or tracking
  parameters in requests/embedded URLs. Do not forward auth across redirects. Use
  `referrerpolicy="no-referrer"` for HTML images. Render via image components, not app-owned
  HTTP clients or auth workarounds.
- Record source URL, license/permission evidence, attribution if required, and verification
  result in existing brand/preview provenance or the sample-media manifest. Never claim that an
  unchecked source was verified. If unavailable, show a labeled fallback and report the gap.

## Loading, fallback and portability

Keep meaningful alt/accessibility text, aspect ratio and layout dimensions stable while media
loads or fails. Exercise image loading/error recovery separately from record-data failures;
one failed image must not erase usable records or block an unrelated action. A cached render
does not prove first-load reliability. Avoid retry loops or silently substituting unrelated art.

Local downloading/caching is optional for online display. Use it when offline support,
self-contained delivery, reproducibility or an explicit user requirement needs it and the
license permits it. Binary-column seeding necessarily obtains bytes for upload, but that is not
a universal requirement to keep local copies of preview/native images. Honor network opt-out;
do not auto-load remote media in an explicitly offline or no-network preview.

## Preview network boundary

Only the declared, verified image-media requests are allowed in addition to local preview
resources. Keep preview HTML/CSS/interaction code self-contained; optional remote images do not
authorize CDN JavaScript, remote executable HTML, analytics/tracking, remote fonts, live tenant
calls, business API calls or production writes. Disclose the image-host network dependency.
Check observed requests against declared image URLs/validated redirect targets instead of
asserting that every preview must make zero network requests. Report unexpected requests.

Source-derived previews must not fabricate missing source handlers or media fallbacks: report
the source gap. Label any safety-required substitute as an approximation, not source behavior.
