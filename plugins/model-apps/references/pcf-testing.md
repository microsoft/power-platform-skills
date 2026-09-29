# PCF testing

PCF work is done only when the evidence matches the claim. Build-green is useful; it is not proof that the control imports, binds or renders in the target host.

Sources: [debugging custom controls](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/debugging-custom-controls), [best practices](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/code-components-best-practices), [paging](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/paging), [refresh](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/dataset/refresh), [solution checker](https://learn.microsoft.com/en-us/power-apps/maker/data-platform/use-powerapps-checker).

## Evidence levels

| Level | Meaning | Typical proof |
| --- | --- | --- |
| `built` | Production build completed locally. | `pcf-build.js` or equivalent production build output. |
| `gated` | Manifest, host, source, lint and unit gates passed. | `pcf-gates.js` JSON or test output. |
| `registered` | Dataverse has the expected custom control and manifest version. | Registration read-back after push/import. |
| `bound(draft)` | Draft form or grid metadata contains the expected binding. | `verify-pcf.js` draft read. |
| `bound(published)` | Published metadata contains the expected binding. | Published layer read after publish. |
| `runtime-verified` | The target host loaded the control and the required user journey worked. | Browser/Playwright/manual smoke with outcome recorded. |

If a run stops at metadata, report `runtime-not-checked`. Do not round it up.

## Test pyramid

### Unit tests

Unit tests cover pure rendering, parsing, adapters and state transitions without depending on the PCF host.

- Test missing parameter objects, `security.readable=false`, `security.editable=false`, null values and permission failures.
- Test two instances on one page: no shared singleton state or duplicate ids.
- Test current-record recipes with missing `entityId` as an unsaved-record disabled state.
- For lookup outputs, assert the `LookupValue[]` shape or `undefined` clear value expected by the recipe contract.
- For grid customizers, assert renderers return elements or `null`/`undefined`, and never mutate grid data.

### Harness tests

The browser harness is fast for visual and input iteration. Learn documents important limitations: WebAPI, paging, sorting, filtering, complex datatypes, model-driven field security, selection and navigation can be missing or throw in the harness: [debugging](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/debugging-custom-controls#common-limitations-when-using-the-test-harness).

Use harness tests for:

- Initial rendering and null-first states.
- Basic input/output flow.
- CSS containment and resizing smoke.
- Keyboard and accessible names.

Do not delete deployed-only code merely to satisfy harness limitations.

### Deployed smoke

Run deployed smoke when behavior depends on Dataverse, model-driven forms, published metadata, Pages, Web API, security or dataset paging.

Recommended smoke assertions:

- Control loads without console errors.
- Existing record renders the current value.
- New unsaved record shows an intentional disabled or empty state.
- Save → reload round-trips bound output.
- A user without field/table permission sees the expected safe state.
- Two instances on the same form do not interfere.
- For Pages, permitted and denied web roles behave differently as expected.

## Dataset-specific tests

Dataset controls need additional coverage because paging and refresh mistakes are common.

| Case | Expected behavior |
| --- | --- |
| Loading | Shows a loading state while dataset data is unavailable. |
| Empty | Shows an empty state without throwing. |
| Error | Shows a recoverable error state; no refresh loop. |
| Next/previous page | Calls one paging method at a time. Learn says paging calls do not support parallel execution. |
| Sort/search/filter change | Resets intentionally and tells the user when the current page changes. |
| Refresh | Uses `refresh()` only on explicit changes; remembers that refresh resets to page 1. |

## Accessibility checks

- Keyboard path reaches every interactive element.
- Focus is visible and trapped only when a modal pattern requires it.
- Inputs have accessible names.
- Color is not the only status signal.
- High contrast and reduced motion are considered for custom visuals.
- RTL layout is tested when the control renders text, icons or directional layouts.

## Performance checks

- Production bundle size is under the policy threshold.
- `updateView` does not issue repeated network calls for unchanged inputs.
- Web API calls use `$select` and page/cap results rather than reading whole tables.
- Dataset refresh is serialized and explicit.
- The control disposes external handlers in `destroy`.

## Captured-agent corpus for skill evals

The first `/pcf` eval corpus should include captured projects from:

1. Fresh control creation.
2. Repair of a seeded broken project.
3. Version migration.
4. A Power Pages incompatibility request.

Each capture should preserve the prompt, intent, plan, gates, produced project and final evidence level. Scrub environment names, tenant ids, user names and internal paths before committing fixtures.

## Reporting template

When finishing a PCF run, report:

- Host(s) and control identity.
- Version and dependency baseline.
- Evidence level reached.
- Gates run and result.
- Deploy target only as a placeholder or user-confirmed public-safe label.
- Runtime checks performed or explicitly `runtime-not-checked`.
- Inventory warning: where-used output is registered solution dependencies only — not proof of Liquid or text references; an empty result is not "safe to delete".
