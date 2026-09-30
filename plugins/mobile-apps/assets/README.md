# Plugin assets

## `power-apps-icon.svg`

The Power Apps product mark. The run plan page (`assets/run-plan.html`, rendered into the
app's `docs/` by `scripts/app-docs.js`) shows it inside the phone frame while an app is being
generated, mirroring the Power Pages `/create-site` scaffold loader.

Sourced from the official Power Platform scalable icon set (`PowerApps_scalable.svg`),
96x96 viewBox, 4.4 KB.

### How it is used

Read at render time and inlined into the shell page as a base64 `data:` URI behind a CSS
`background-image`. Two reasons:

- The plan is a standalone file the user opens from disk, with no server behind it. Inlining
  keeps it a single self-contained page that still renders correctly after it is moved,
  copied, or mailed on.
- As a CSS background, an SVG renders in *secure static mode*: any script or external
  reference inside it is inert, and its internal gradient/clip ids stay scoped to the image
  rather than colliding with ids on the page.

### Replacing it

`power-apps-icon.svg` is preferred; `power-apps-icon.png` is accepted as a fallback and the
mime type follows the file extension. Keep either well under 128 KB — the file is inlined on
every page load and base64 adds about 33%. Anything missing, empty, unreadable, or oversized
degrades to a lettermark built from the app's initial, so the plan page never fails because of
the icon.

`template/assets/adaptive-icon.png` is **not** a substitute — it is a solid colour square used
as the Android adaptive-icon foreground, not a logo.
