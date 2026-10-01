# Accessibility audit report template

Copy this template into `docs/accessibility/accessibility-audit.md` and replace every `{{placeholder}}`. Delete optional sections that don't apply. Keep the report free of raw HTML from signed-in pages, session file paths, cookies, and tokens.

---

```markdown
# Accessibility audit: {{site name}}

**Site:** {{base URL}}
**Audited:** {{finished date and time, UTC}}
**Scope:** {{pages audited}} pages and {{states audited}} interaction states on {{viewports}} layouts{{", signed in" when a session was used}}
**Standard:** WCAG 2.2 Level A and AA (axe-core {{axe version}}){{", plus best-practice rules" when included}}

## Summary

{{One or two sentences on the overall result and the most important issue to fix first.}}

| Group | Issues | Elements affected |
|-------|--------|-------------------|
| Must fix | {{n}} | {{n}} |
| Should fix | {{n}} | {{n}} |
| Verify | {{n}} | {{n}} |
| Best practice | {{n}} | {{n}} |

## Must fix

<!-- One section per finding, most widespread first. -->

### {{short title}} ({{rule id}})

- **Impact:** {{critical | serious}}, affects {{who — for example, screen reader users, keyboard-only users, people with low vision}}
- **WCAG:** {{criterion number and name, for example 1.1.1 Non-text Content}}
- **Where:** {{n}} elements on {{n}} pages{{" — shared component" when grouped}}
  - `{{selector}}` on {{routes, viewport, state}}
- **Source:** {{file:line, or "Not mapped"}}
- **How to fix:** {{one or two sentences}}
- **Learn more:** {{helpUrl}}

## Should fix

<!-- Same format as Must fix. -->

## Verify

<!-- Heuristic findings and axe "needs review" items. State what to check and why automation couldn't decide. -->

## Best practice

<!-- Optional. Same format, shorter. -->

## Coverage gaps

<!-- Optional. Pages or states that failed to load or whose checks errored, and why (for example, redirected to sign-in). Also note states where summary.blockedRequests shows that a write was stopped. -->

| Page or state | Reason |
|---------------|--------|
| {{route or state label}} | {{error}} |

## Manual checks

Automated testing finds only part of WCAG. Before you sign off, check these by hand:

- [ ] Navigate every page with only the keyboard. Focus order follows the visual order, and every action is reachable.
- [ ] Use a screen reader (Narrator, NVDA, or VoiceOver) on the main tasks. Headings, landmarks, form labels, and status messages are announced.
- [ ] Images convey the right meaning in their alternative text, and decorative images are hidden.
- [ ] Videos have captions, and audio has a transcript.
- [ ] Error messages explain how to fix the problem, and forms don't time out without warning.
- [ ] Link and button text makes sense out of context.
- [ ] Content still works at 400% zoom and in Windows high-contrast (forced colors) mode.

## Fixes applied

<!-- Optional. Only when Phase 7 changed source files. -->

| Finding | File | Change |
|---------|------|--------|
| {{rule id}} | {{file}} | {{what changed}} |
```
