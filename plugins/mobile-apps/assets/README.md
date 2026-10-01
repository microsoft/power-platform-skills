# Plugin assets

## `power-apps-icon.svg`

The Power Apps product mark. The build plan (`assets/run-plan.html`, rendered into the app's
`docs/` by `scripts/app-docs.js`) shows it in the topbar and inside the phone frame while an app
is being generated, mirroring the Power Pages `/create-site` scaffold loader.

Sourced from the official Power Platform scalable icon set (`PowerApps_scalable.svg`),
96x96 viewBox, 4.4 KB.

### How it is used

`brandIconDataUri()` reads this file at render time and inlines it as a base64 `data:` URI, which
the page carries in a single `<img id="brandLogo">`. The phone frame reads the same value back
from that element rather than fetching anything.

Inlined rather than copied beside the page for two reasons:

- The plan ships a strict CSP whose `img-src` allows `data:` only. The page is opened over
  `file://`, where the origin is opaque, so `img-src 'self'` would not reliably match a sibling
  file — and loosening `img-src` to make one work would weaken the policy that keeps injected
  mockup markup from fetching anything.
- It makes the plan a single shareable file. A sibling asset is lost the moment someone mails the
  HTML on its own.

Reading the file is best-effort: a missing or unreadable source yields an empty `src` and the page
renders without the mark rather than failing. There is no PNG fallback and no lettermark.

### Replacing it

Keep the replacement an SVG at this exact path — `brandIconDataUri()` hard-codes both the filename
and the `image/svg+xml` media type, and neither is derived from the file.

Size matters more than it would for a sibling file: the mark is inlined into the plan on **every**
rewrite, and the plan is rewritten at each phase boundary. Base64 adds about a third. At 4.4 KB
this is negligible; something in the hundreds of kilobytes would not be.

Prefer a mark that reads at 62x62 CSS pixels, the size the phone frame draws it at.

`template/assets/adaptive-icon.png` is **not** a substitute — it is a solid colour square used as
the Android adaptive-icon foreground, not a logo.
