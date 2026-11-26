## Phase 7: Review & User Testing

**Goal**: Ensure the site meets user expectations and all pages work correctly

<!-- gate: create-site:7.review | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:7.review):** Live-site review — last chance to request changes before the deploy prompt. Cancel branch lets the user keep iterating. Fires at step 5 of the action list below.
>
> **Trigger:** Phase 7 has verified all pages render via Playwright.
> **Why we ask:** User loses the chance to spot UI issues before deploy; broken pages get pushed.
> **Cancel leaves:** Nothing — site files stay as-is on disk.

**Actions**:

1. Confirm every route still loads cleanly with one call - the capture request from 5.7 with every route and `"checksOnly": true` - and fix any route listed under `summary.pageErrors`, `summary.overflow`, or `summary.captureErrors`. The visual review already happened in Phase 5.7
2. Present a summary of what was built, with the design scorecard from Phase 5.7:

   ```
   | Component Type      | Count | Details |
   |---------------------|-------|---------|
   | Pages               | 4     | Home (/), About (/about), Services (/services), Contact (/contact) |
   | Shared Components   | 3     | Navbar, Footer, ContactForm |
   | Design Elements     | 5     | Schibsted Grotesk + Public Sans, 15 color tokens, product-moment hero, status-timeline signature moment, paper-grain backgrounds |
   | Git Commits         | 9     | scaffold + 8 feature and critique commits |
   ```

   Follow it with the design thesis in one sentence and the scorecard
   (category, score, one-line evidence), including any category recorded below
   3 and why. Include `SITE_LANGUAGE`, `SITE_LOCALE`, and `SITE_DIRECTION`.

   Present the reconciled bidirectional review scope with each component's
   classification and the applicable states/viewports exercised. Report
   direction-aware, direction-fixed, and unknown/third-party evidence
   separately; do not treat the pre-implementation plan as proof that the
   implemented component was verified.

   Link each scope entry to its rendered report cases and any captured
   screenshots. Show case totals for passed, review, and failed. Do not expose
   temporary specification internals as project configuration.

   Then report the `REVIEW_DATA.agentChecks` criteria separately with the
   evidence gathered in Phases 5–6. Every criterion must be reported as
   **Passed** or **Blocked**, never as maker verification. Fix blocked
   technical criteria before requesting approval.

   Present `REVIEW_DATA.makerReview` as the maker's live-preview checklist.
   Ask the maker to assess linguistic correctness, terminology, tone, regional
   wording, regulated content, visual hierarchy and reading flow, brand
   typography, directional imagery/icons, and text expansion. Automated checks
   cannot approve these judgment-based criteria.

   Finally, list the sample content still in the site - search `src` for
   `SAMPLE CONTENT` markers and give each marker's file and what it stands in
   for - so the user can supply real content in this review.

3. Share the dev server URL with the user and list all available routes
4. Classify bidirectional readiness as:
   - **Ready** when no unresolved static or rendered findings remain.
   - **Ready with proposed limitations** only when all remaining findings are
     review-severity, the site remains functional/readable/accessible, and
     each finding has exact impact plus evidence.
   - **Blocked** when a deterministic error affects an available locale or the
     available site experience. Return to Phases 5–6; do not ask the maker to
     accept the defect.
   - **Ready for available locales; localization pending** when every remaining
     error belongs only to an add-localization locale that is excluded from all
     activation boundaries. Show the unavailable locale and blocker, and do
     not offer that locale for approval or enablement.
5. Request maker review.

   Ask the user:
   > "The site is ready for review at `<dev server URL>`. Please check it out in your browser. Would you like any changes?"
   For **Ready**, offer **Accept changes** and **Request revisions**. For
   proposed usable limitations, offer **Fix before handoff**, **Accept with
   documented limitations**, and **Request revisions**. Acceptance applies
   only to review-severity limitations; record the approval timestamp, impact,
   and evidence path in the final summary. If localization is configured,
   finalize the same disposition in `.powerpages-localization.json`, update
   every selector, detection, metadata, and static-output availability
   boundary, then rerun the localization validator, project build, and affected
   real-locale activation cases before proceeding.
6. If the user requests changes, apply them and repeat the applicable static,
   rendered, accessibility, and browser checks before returning to this gate.
   Re-run the axe-core audit (6.2) on every affected route because a new
   control, form field, or restructured section can add violations without any
   visual change. When a change affects appearance, also run another design
   review round on the affected routes.

### 7.1 Final site-integrity gate

After the user-approved source changes and all normal validation are complete, run:

```bash
node "${PLUGIN_ROOT}/scripts/validate-site-integrity.js" --projectRoot "<PROJECT_ROOT>"
```

Fix every blocking error before proceeding. Inspect and report review findings in the relevant
directions and with expanded content. If review causes further source changes, rerun this gate.
Do not enter the deployment phase until it exits successfully.

**Output**: User-approved site ready for deployment

---
