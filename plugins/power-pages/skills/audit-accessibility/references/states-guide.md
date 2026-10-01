# Interaction states guide

Hidden UI — menus, dialogs, tabs, accordions, and validation messages — isn't in the page when it first loads, so a page-load audit never sees it. A **state** tells `a11y-audit.js` how to reveal that UI before it runs axe-core and the keyboard check.

## States file format

```json
{
  "states": [
    {
      "route": "/",
      "label": "Mobile navigation open",
      "viewport": "mobile",
      "steps": [{ "action": "click", "role": "button", "name": "Toggle navigation" }]
    },
    {
      "route": "/contact",
      "label": "Email field validation",
      "steps": [
        { "action": "focus", "role": "textbox", "name": "Email" },
        { "action": "press", "key": "Tab" }
      ]
    }
  ]
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `route` | Yes | Path that starts with `/`. |
| `label` | Yes | Short, human-readable name shown in the report. |
| `viewport` | No | `desktop` or `mobile`. Use the candidate's `viewport` from discovery. Defaults to `desktop` when it's in the audit, otherwise the first audit viewport. |
| `allowFormSubmit` | No | `true` only for a state the user consented to submit. Takes effect only when the run also passes `--allow-form-submit`. Defaults to `false`. |
| `steps` | Yes | 1–20 steps, run in order. |

Step actions:

| `action` | Fields | Use for |
|----------|--------|---------|
| `click` | `role`, `name` | Open a menu, dialog, disclosure, or tab |
| `hover` | `role`, `name` | Hover-only menus and tooltips |
| `focus` / `blur` | `role`, `name` | Focus styles, focus-triggered help, blur validation |
| `press` | `key`, optional `role` + `name` | `Escape`, `Tab`, `ArrowDown`; without a target it presses on the focused element |
| `wait` | `ms` (0–10000) | Let an animation finish |

Elements are found by ARIA role and accessible name, the same way assistive technology finds them. Set `"exact": false` on a step to match a partial name.

Limits: 100 states per file, 20 steps per state, 200 characters per text field.

## Choosing states from discovery

Discovery returns `stateCandidates` for each page and layout. Each one is a click step for a control that reveals content (`popup`, `disclosure`, or `tab`), plus the `viewport` it was found on. Choose from them like this:

- **Include each control once.** A header menu found on every page is audited once, on the first route where it appears.
- **Add the mobile navigation.** Collapsed navigation usually exists only at the mobile width. Pick its toggle button from the `mobile` candidates and keep `"viewport": "mobile"` on the state.
- **Open dialogs.** Include buttons whose `aria-haspopup` is `dialog`, or whose name suggests a dialog ("Sign up", "Filter", "Share").
- **Include each tab set.** One state per tab panel is enough when the panels share a template; otherwise include each panel.
- **Add form validation only with focus and Tab.** Focus a required field, press `Tab`, and audit the message. Never click a submit button.
- **Exclude side effects.** Leave out sign-out, delete, remove, cancel subscription, payment, "Add to cart", and anything that saves data.
- **Note unnamed controls.** A control with an empty accessible name can't be replayed. Report it as a finding (button-name or link-name) instead of a state.

## Form submission safety

`a11y-audit.js` protects the site in two layers while it replays a state:

- **Step guard.** It refuses any step that would submit a form: clicking a submit button, pressing `Space` on a submit button, or pressing `Enter` inside a form.
- **Network guard.** Steps can still trigger writes from script, such as a plain button that calls the Web API. During a state, the audit browser blocks every `POST`, `PUT`, `PATCH`, and `DELETE` request before it leaves the browser, except the read-only list-grid data request to the audited site itself. Each state reports how many requests were blocked in `states[].blockedRequests` (method and path only), and the total appears in `summary.blockedRequests`. A blocked request isn't a failure. It does mean the state may look different on the live site, for example a missing "Saved" message.

On a Power Pages site, a form submission can create or update a Dataverse record and send email. Both guards turn off for a state only when two things are true: the state sets `"allowFormSubmit": true`, and the run passes `--allow-form-submit`. Set the field only on the states the user consented to, and only on a test or development site. Every other state in the same run stays guarded, and `states[].formSubmitAllowed` in the report shows which states ran unguarded.

## Checks run on each state

Each state runs axe-core and, when selected, the keyboard check. Reflow, 200% text, and reduced motion resize or restyle the page, which closes most menus and dialogs, so they run on page loads only. `--states` needs `--checks` to include `axe` or `keyboard`.

## Reusing states

Approved states are saved to `docs/accessibility/a11y-states.json` in the project. On a later run, start from that file, drop states whose route no longer exists, and add candidates for new pages. Ask the user to approve the updated list before running it.
