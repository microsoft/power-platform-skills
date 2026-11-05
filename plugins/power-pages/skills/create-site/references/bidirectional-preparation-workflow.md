### 5.5 Live Verification

After each significant change (new page or component), browse the site via Playwright to confirm structure and content:

1. Use the available browser navigation capability to reload or navigate to the updated page
2. Use the available browser inspection capability to verify the page structure and content are correct
3. If something looks wrong in the snapshot, fix it before proceeding

Visual judgement - screenshots at desktop and mobile widths - happens only in the first-impression review (step 4 of 5.2) and the critique pass (5.7). Screenshots stay in the conversation and are re-sent with every later call, so per-page checks during the build use `browser structure inspection`, not the capture script. The user is previewing in their own browser via the dev server URL shared in Phase 2.7.

Run the deterministic readiness audit after all pages and components exist:

```bash
node "${PLUGIN_ROOT}/scripts/audit-bidirectional-readiness.js" --projectRoot "<PROJECT_ROOT>"
```

The command prints structured JSON and exits nonzero when deterministic errors
exist; parse the JSON even on that expected failure path. Fix every `error`
finding. Review every geometry, scrolling, visual-order, and content-expansion
finding in the live site. For an intentionally physical product requirement,
keep the declaration, add the validated adjacent `bidi-physical` directive,
and verify that component in both LTR and RTL. For intentionally fixed
machine-oriented text, add the adjacent `bidi-fixed` directive and verify the
surrounding UI in both directions. Use pseudo-opposite-direction content to
check wrapping, navigation, forms, mixed names/identifiers, icons, calendars,
and narrow/mobile layout even when no second real locale exists yet. For every
free-form native input or textarea, verify empty, RTL-valued, LTR-valued,
clear-after-RTL, and clear-after-LTR states under both UI directions. Each
clear state must enter the corresponding value before clearing it; empty and
cleared states follow the UI locale, while populated states follow the entered
value.

Reconcile `BIDIRECTIONAL_REVIEW_DATA` against the completed source and rendered
routes. Add every implemented visible or interactive component that was not
known during planning, and add every applicable state or viewport discovered
during implementation. Verify the selected direction and pseudo-opposite
direction for every site: LTR sites receive pseudo-RTL coverage, and RTL sites
receive pseudo-LTR coverage. Direction-neutral components need an inheritance
check; direction-aware components need all applicable states in both
directions; direction-fixed components need a semantic reason plus surrounding
UI checks; unknown/third-party components need rendered checks including
dialogs, menus, autocomplete panels, tooltips, teleports, portals, overlays,
Shadow DOM, or iframes they open.

Build the ephemeral rendered-verification specification described in
`${PLUGIN_ROOT}/references/rendered-bidirectional-verification.md`. Derive it
from the reconciled component scope and actual selectors; do not commit it as a
component manifest. Give unstable but important verification surfaces a
`data-bidi-id` attribute. Include every applicable state and viewport, compound
form parts, body-mounted overlays, explicit focus sequences, non-overlap pairs,
and direction-specific computed-style expectations. Use the real configured
LTR and RTL locales when both exist; otherwise add a browser-only
pseudo-opposite locale. Real locales must be activated through the application
and prove representative localized content; only pseudo locales may use the
browser-only `set-document` action. If runtime localization was added, include both
default -> locale -> default and locale -> default -> locale transition
sequences for every real non-default locale, with route, form-state,
application-state, and focus preservation checks. Pseudo locales do not
participate in application-switch transitions. Every real locale, including
the default, needs a reusable application activation action; `use-current`
cannot restore a locale during a round trip. For a newly added runtime locale,
use the localization verification transaction defined by add-localization:
temporarily expose only the recorded target through the normal selector, run
Playwright against a loopback dev server, keep it available on success, and
restore fail-closed availability on failure. Exclude pre-existing unavailable
locales from activation and declare them in `unavailableLocaleChecks`. Do not
complete creation or offer deployment while the verification transaction
exists. Bare `preserve` selectors are only for form controls; use explicit
text, attribute, or property preservation entries for tabs, panels, counters,
and other application state.

Retain evidence for every applicable `REVIEW_DATA.agentChecks` item: audit
result, routes/viewports exercised, direction used, mixed-content fixtures,
font/text-expansion observations, component/asset classifications, console
result, and any remediations. Do not mark an agent-owned criterion complete
based only on visual inspection by the maker.

### 5.6 Clean Up the Live Status File

Once the scaffold loader is gone, `public/scaffold-status.json` is just dead weight that would ship with the deployed site. Delete the file from `<PROJECT_ROOT>/public/` and commit the removal alongside the final implementation.
