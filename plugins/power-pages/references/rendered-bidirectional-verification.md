# Rendered Bidirectional Verification

Use the rendered audit after the static bidirectional-readiness audit and a
successful build. Static source checks find deterministic implementation
patterns; this audit verifies computed browser behavior for the actual
component, state, viewport, direction, portal, and locale-switch surfaces.

## Evidence, not project configuration

Build the run specification from the reconciled component scope and actual
implementation. Pass it inline, or write it to a temporary file and delete the
file after the run. Do not commit it as a second component manifest.

The JSON report and failure/review screenshots are run evidence. They may be
kept under `docs/bidirectional-evidence/<run-id>/`, but they do not replace the
source, localization manifest, or approved implementation plan as project
configuration.

## Command

The project must have `playwright` or `playwright-core` available. Create-site
already installs Playwright for the axe audit. For add-localization, reuse an
existing install or add `playwright` as a development dependency when absent.

For newly added pending locales, begin the verification transaction while they
are fail-closed, then expose only those targets through the normal application
availability path. Run the transaction-aware localization validator and start
a loopback-only development server:

```bash
node "${PLUGIN_ROOT}/scripts/manage-localization-verification.js" \
  --begin --projectRoot "<PROJECT_ROOT>" --locales "ar-SA"

node "${PLUGIN_ROOT}/skills/add-localization/scripts/validate-localization.js" \
  --projectRoot "<PROJECT_ROOT>" --verification
```

```bash
node "${PLUGIN_ROOT}/scripts/audit-rendered-bidirectional-readiness.js" \
  --url "<DEV_SERVER_URL>" \
  --projectRoot "<PROJECT_ROOT>" \
  --spec "<TEMP_SPEC_PATH>" \
  --evidence-dir "<PROJECT_ROOT>/docs/bidirectional-evidence/<RUN_ID>" \
  --output "<PROJECT_ROOT>/docs/bidirectional-evidence/<RUN_ID>/report.json"
```

The command always prints the report JSON to stdout. Exit code `1` means the
report contains blocking rendered errors. Exit code `2` means the run could not
start or the specification is invalid. Parse stdout on exit code `1`; stderr
describes setup/specification failures on exit code `2`.

## Run specification

Use schema version 1:

```json
{
  "version": 1,
  "runtimeSwitching": true,
  "defaultLocaleId": "en",
  "viewports": [
    { "name": "desktop", "width": 1280, "height": 720 },
    { "name": "narrow", "width": 390, "height": 844 }
  ],
  "locales": [
    {
      "id": "en",
      "locale": "en-US",
      "direction": "ltr",
      "activate": [
        { "type": "click", "selector": "[data-locale='en-US']" }
      ],
      "expect": [
        { "selector": "h1", "text": "Contact us" }
      ]
    },
    {
      "id": "ar",
      "locale": "ar-SA",
      "direction": "rtl",
      "activate": [
        {
          "type": "activate-locale",
          "method": "click",
          "locale": "ar-SA",
          "selector": "[data-locale='ar-SA']"
        }
      ],
      "expect": [
        { "selector": "h1", "text": "اتصل بنا" }
      ]
    }
  ],
  "components": [
    {
      "id": "contact-email",
      "name": "Contact email field",
      "classification": "direction-fixed",
      "reason": "Email addresses preserve LTR character order",
      "route": "/contact",
      "selector": "[data-bidi-id='contact-email']",
      "viewports": ["desktop", "narrow"],
      "states": [
        {
          "name": "invalid",
          "setup": [
            {
              "type": "fill",
              "selector": "[data-bidi-id='contact-email'] input",
              "value": "invalid"
            },
            {
              "type": "press",
              "selector": "[data-bidi-id='contact-email'] input",
              "key": "Tab"
            }
          ],
          "targets": [
            {
              "selector": "[data-bidi-id='contact-email']",
              "expectedDirection": "inherit"
            },
            {
              "selector": "[data-bidi-id='contact-email'] input",
              "expectedDirection": "ltr"
            },
            {
              "selector": "[data-bidi-id='contact-email-error']",
              "expectedDirection": "inherit"
            }
          ],
          "focusOrder": [
            "[data-bidi-id='contact-email'] input",
            "[data-bidi-id='contact-submit']"
          ]
        }
      ]
    }
  ],
  "transitions": [
    {
      "name": "ltr-rtl-ltr",
      "route": "/contact",
      "sequence": ["en", "ar", "en"],
      "setup": [
        {
          "type": "fill",
          "selector": "[data-bidi-id='contact-name']",
          "value": "Ada"
        },
        {
          "type": "focus",
          "selector": "[data-bidi-id='contact-name']"
        }
      ],
      "preserve": [
        "[data-bidi-id='contact-name']",
        {
          "selector": "[data-bidi-id='details-panel']",
          "kind": "attribute",
          "name": "aria-expanded"
        }
      ],
      "preserveFocus": "[data-bidi-id='contact-name']",
      "preserveRoute": true,
      "viewport": "desktop"
    },
    {
      "name": "rtl-ltr-rtl",
      "route": "/contact",
      "sequence": ["ar", "en", "ar"],
      "preserve": [],
      "preserveRoute": true,
      "viewport": "desktop"
    }
  ]
}
```

When `runtimeSwitching` is `true`, `defaultLocaleId` identifies the real
default locale. For every real non-default locale, provide both default ->
locale -> default and locale -> default -> locale sequences. This verifies
each locale independently without requiring every possible locale pair.
Pseudo locales do not participate in runtime transition pairs. Static
localization modes set `runtimeSwitching` to `false` and use locale-specific
navigation actions. Runtime switching requires
`.powerpages-localization.json`; the CLI requires the real run-spec locales and
default locale to exactly match the manifest so an existing configured locale
cannot be silently omitted. The expected direction for every real locale is
derived from its writing script rather than trusted from the run specification.
Every locale in a runtime transition, including the default, needs a reusable
application activation action because each round trip must be able to restore
it. `use-current` is therefore rejected for real runtime locales.

Each `preserve` entry may be a selector for an input, select, or textarea; the
runner automatically compares its value or checked state. For non-form
application state, use an object with `selector`, `kind`, and when needed
`name`. Supported kinds are `value`, `checked`, `text`, `attribute`, and
`property`. For example, preserve an expanded panel with
`{"selector":"#details","kind":"attribute","name":"aria-expanded"}`. A bare
selector that resolves to a non-form element is a blocking specification
error rather than an empty comparison that can pass without evidence.
Explicit value, checked, attribute, and property evidence must also exist on
the selected element; a misspelled or inapplicable field is blocking.

## Locale activation and pseudo directions

`activate` is a sequence of supported browser actions. Prefer the site's real
selector or route behavior. A real locale must not use `set-document`: it must
activate through the application and provide at least one `expect` assertion
for localized text or a localized attribute. This prevents changing only
`html[lang]`/`html[dir]` from being mistaken for working localization.

Every transaction target is temporarily available through the normal
application path and must use its real selector or locale-navigation action:

```json
{
  "activate": [
    {
      "type": "activate-locale",
      "method": "click",
      "locale": "ar-SA",
      "selector": "[data-locale='ar-SA']"
    }
  ]
}
```

`activate-locale` binds the expected locale to one normal application control.
Use `method: "click"` for a button or menu item. For a `<select>`, use
`method: "select"` and provide its locale option as `value`. Transaction-target
activation may contain only this action and optional waits, preventing an
unrelated click or direct DOM mutation from being accepted as locale evidence.
The runner verifies that the action itself produces the expected
`document.documentElement.lang`.

Real locale entries must exactly match the currently available manifest
locales. A pre-existing pending locale that is not a target remains excluded
from activation. List every such locale and its normal selector surfaces in
the top-level `unavailableLocaleChecks` array:

```json
{
  "unavailableLocaleChecks": [
    {
      "locale": "fa-IR",
      "selectors": ["[data-locale='fa-IR']"]
    }
  ]
}
```

Before every component and transition case, the runner checks every matching
element for visibility. This supplies negative browser evidence that
pre-existing unavailable locales remain hidden while another locale is being
verified. For a `<select>` language control, target the locale's `<option>`
such as `option[value='fa-IR']`; the runner treats an enabled option in a
visible enabled parent `<select>` as exposed even though browsers do not render
the option as an independently visible box.

The project-root `.powerpages-localization-verification.json` transaction is
the safety boundary. It records target locales and their prior fail-closed
availability, permits only those pending targets to be temporarily omitted
from `unavailableLocales`, and blocks completion or deployment. While the
browser run is active, `.powerpages-localization-verification.json.audit`
holds an exclusive lease for that transaction. Finalization remains blocked
until the run records its result and releases the lease. If the process is
interrupted, `--fail` records `remediation-required` and clears the abandoned
lease; do not delete either file to bypass recovery.

The audit URL must use `localhost`, `127.0.0.1`, or `[::1]`, and every
navigation, control action, wait, and redirect must remain on that exact
origin. A browser, setup, or rendered error changes the transaction to
`remediation-required`; restore its targets to pending unavailable state
before another attempt.

After the maker decision, reconcile the manifest and managed availability
module, then run `manage-localization-verification.js --finalize`. Successful
targets are `ready` or `approved-with-limitations` and remain available.
Failed or deferred targets are `pending-remediation` and unavailable.
Finalization validates the normal schema-version-1 invariant before removing
the transaction. Before retrying after either a failed run or maker-requested
revision, mark the old transaction failed, restore its targets to pending
unavailable state, finalize it, and begin a new transaction.

For a single-language site, add a pseudo-opposite locale using:

```json
{
  "id": "pseudo-rtl",
  "locale": "ar-XB",
  "direction": "rtl",
  "pseudo": true,
  "activate": [
    {
      "type": "set-document",
      "locale": "ar-XB",
      "direction": "rtl"
    }
  ]
}
```

Pseudo mode changes the root language/direction and expands visible text and
text-bearing attributes in the browser only. It does not modify project files.
Use pseudo-RTL for an LTR site and pseudo-LTR for an RTL site.

Supported actions are:

- `activate-locale` for the normal click/select control that activates a
  transaction target and proves the resulting document locale
- `click`, `fill`, `focus`, `hover`, `press`, `select`, `check`, `uncheck`
- `use-current` only when no runtime round trip needs to reactivate the locale
- `navigate` with a root-relative or absolute locale-specific URL
- `wait` with `ms` from 0 through 10000
- `set-document` with `locale` and `direction`
- `set-attribute` with `selector`, `name`, and string `value`

The action list deliberately excludes arbitrary JavaScript. Verification input
must not become a general code-execution channel.

## Component cases

Give stable `data-bidi-id` attributes to important rendered surfaces when
semantic selectors are not stable enough. These attributes are verification
anchors, not styling hooks.

Every component entry must preserve the approved classification and list only
its applicable states and viewports. The runner expands every
component/state/viewport across every verification locale, so each rendered
combination produces an independent result.

Each state may define:

- `setup` — actions required to reach the state.
- `targets` — the component root, compound form parts, portals, open menus,
  dialogs, tooltips, validation messages, or other separately rendered nodes.
- `computed` — exact computed-style expectations by direction.
- `focusOrder` — expected keyboard Tab sequence.
- `nonOverlapping` — selector pairs that must not geometrically overlap.

A target normally uses `"expectedDirection": "inherit"`. A specific
direction-fixed value uses `"ltr"` or `"rtl"`. Set `expectVisible: false` for
an intentionally restricted surface. Use `allowClipping` or
`allowOutsideViewport` only for a reviewed behavior where that geometry is the
component's intended function.

Open Shadow DOM is addressable through Playwright locators. Body-mounted
portals and overlay containers must be listed as separate targets even when
they are outside the component root.

For a visible cross-origin iframe or other opaque external surface, set
`externalOpaque: true`. The runner reports a blocking
`unverifiable-third-party-surface`. Hiding or restricting the nonessential
surface for the affected locale can be verified with `expectVisible: false`.
Do not mark a visible opaque critical surface ready without evidence.

## Automated findings

Blocking findings include:

- missing or unexpectedly visible/hidden targets;
- root or component computed-direction mismatches;
- page horizontal overflow;
- clipped text/content or targets outside the viewport;
- explicitly forbidden overlap;
- computed-style expectation failures;
- keyboard focus-order failures;
- browser console/page errors;
- visible opaque third-party surfaces;
- runtime switches that reload, change route, lose declared form/application
  state, lose focus, or leave stale `lang`/`dir`.

Use `manualChecks` for semantic behavior that requires a screenshot and maker
or agent judgment, such as whether a directional icon mirrors correctly,
whether a map/chart intentionally stays physical, or whether brand imagery
must be replaced. Manual checks produce review findings, not automatic passes.

The runner captures screenshots for failed and review cases when
`--evidence-dir` is supplied. A screenshot is supporting evidence; it does not
override a deterministic failure.

## Disposition

- Any rendered `error` keeps every locale in the finding's `affectedLocales`
  unavailable and sets those locale readiness entries to
  `pending-remediation`. Other locales remain available unless regression
  evidence shows they are also affected.
- A `review` finding must receive explicit evidence and disposition. A usable,
  noncritical limitation may become `approved-with-limitations`.
- A direction-aware, direction-fixed, or unknown/third-party case without
  evidence is incomplete, not implicitly passed.
- Record rendered blockers in
  `bidirectionalReadiness.renderedFindings`; keep static scanner findings in
  `bidirectionalReadiness.findings`.
