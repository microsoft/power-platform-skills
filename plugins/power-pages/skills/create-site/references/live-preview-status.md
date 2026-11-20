## Live Preview Status Protocol

<!-- not-a-gate: prose-only section — mentions of a user question here describe the live-status protocol that wraps every real prompt in Phases 3/4/8; the actual gates are catalogued in §6.13 of references/approval-gates.md and marked at their call sites below -->

While the scaffold loading screen is visible (from Phase 2.6 until the Home page itself is replaced in Phase 5), the loader polls `GET /scaffold-status.json` every 1.5 seconds. The `message` you write into `<PROJECT_ROOT>/public/scaffold-status.json` appears as the label under the progress bar, and `awaitingInput` controls the "waiting for your input" banner. The decorative spinner above the progress bar continues its built-in phrase cycle; keep the progress-bar label current so the loader still reflects what is actually happening.

**Why this matters**: When the browser with the loader takes over the user's screen, a prompt in the terminal can sit unanswered for a long time because the user doesn't realize anything is waiting. The banner makes it obvious.

**File shape** (all fields optional — omit any field you don't want to change):

```json
{
  "message": "Creating Contact page",
  "awaitingInput": false,
  "inputPrompt": "Please check your terminal to respond."
}
```

- `message` — one short present-participle phrase shown as the status line under the progress bar in the loader (replacing the default "Getting started…" / "Setting up infrastructure…" cycle). Include the grouping context inline when it helps (e.g., `"Creating Footer component (shared components)"`).
- `awaitingInput` - when `true`, a prominent pulsing banner appears at the top of the loader and stays visible until cleared. Set it before every user question and clear it (`false`) immediately after the answer.
- `inputPrompt` — short context for the banner (e.g., `"Choose a framework"`). Optional.

**When to update the file**:

1. **After scaffold launches (end of Phase 2)**: write an initial status like `{ "message": "Planning your site", "awaitingInput": false }`.
2. **Before any user question while the scaffold is visible** (Phases 3, 4, and any in-scaffold prompt in Phase 5): set `awaitingInput: true` with a short `inputPrompt`. After the user answers, write again with `awaitingInput: false`.
3. **Before each implementation step in Phase 5** — applying design tokens, creating each shared component, creating each page, updating the router, updating navigation — update `message` to the specific action. Examples: `"Applying design tokens"`, `"Creating Navbar component"`, `"Creating Contact page"`.
4. **At the end of Phase 5, after the Home page has been replaced**: delete `public/scaffold-status.json` so it isn't deployed with the site.

Overwrite the file atomically; no preliminary read is needed.

---
