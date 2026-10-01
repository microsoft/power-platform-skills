# Plugin assets

## `power-apps-icon.svg`

The Power Apps product mark. The build plan (`assets/run-plan.html`, rendered into the app's
`docs/` by `scripts/app-docs.js`) shows it inside the phone frame while an app is being
generated, mirroring the Power Pages `/create-site` scaffold loader.

Sourced from the official Power Platform scalable icon set (`PowerApps_scalable.svg`),
96x96 viewBox, 4.4 KB.

### How it is used

`copyBrandIcon` copies this file next to the rendered page on every save, and the page
references it as `./power-apps-icon.svg` in an `<img>`. It is a sibling file rather than an
inlined `data:` URI because the plan is rewritten at every phase boundary, and re-encoding the
mark into each rewrite costs more than copying it once.

The copy is best-effort: a missing or unreadable source is swallowed, and the page then renders
with a broken image rather than failing. There is no PNG fallback and no lettermark.

**A consequence worth knowing:** the plan is only self-contained as a folder. Mailing
`create-app-plan.html` on its own loses the mark. To share a single file, inline the SVG as a
base64 `data:` URI in a copy of the page.

### Replacing it

Keep the replacement an SVG at this exact filename — the page's `<img src>` and
`copyBrandIcon`'s hard-coded source both name it, and neither consults the file type.

Prefer a mark that reads at 62x62 CSS pixels, which is the size the phone frame draws it at.

`template/assets/adaptive-icon.png` is **not** a substitute — it is a solid colour square used
as the Android adaptive-icon foreground, not a logo.
