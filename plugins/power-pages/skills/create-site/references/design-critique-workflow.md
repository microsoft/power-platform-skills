### 5.7 Design Critique Pass

Judge screenshots against `${PLUGIN_ROOT}/references/design-critique.md`, reading it once at the first review.
Use one script call to capture every route at both widths and run automated checks, then inspect the screenshots together rather than navigating, resizing and capturing each page separately.

**Running a review** (used for the first-impression review in 5.2 step 4 and for each critique round):

1. Capture by sending the request on stdin, as design-critique.md's Capture section shows - the dev server URL and the routes never go on the command line. Nothing needs installing: the script uses the plugin's pinned Playwright.

   ```bash
   node "${PLUGIN_ROOT}/scripts/capture-design-review.js" --input - <<'REQUEST'
   {"url": "<DEV_SERVER_URL>", "routes": ["/", "/about"]}
   REQUEST
   ```
2. Open every path in `summary.images` in one turn, and read the automated checks from the JSON.
3. Judge as design-critique.md describes and write the compact scorecard and fix list it defines.
4. Apply every fix from the scorecard, highest impact first, and commit. Capture again only at the start of the next round - one capture per round, after all of its fixes - rather than after each individual fix.

**The critique pass**: review every route, then fix and review again, capturing only the routes that changed plus `/`, until one of these holds:

- No critical gate fails and every category scores 3 or more - the pass is complete.
- Three rounds have run and no critical gate fails - the pass is complete, with each category still below 3 recorded in the scorecard with its reason, so the Phase 7 summary shows it to the user.
- Three rounds have run and a critical gate still fails - go to the gate below; a critical gate never passes silently. Keep the final scorecard for the Phase 7 summary, then remove each round's screenshots by sending `{"cleanup": "<outputDir>"}` to the same script the same way.

<!-- gate: create-site:5.7.critique-blocked | category=progress | cancel-leaves=nothing -->

> 🚦 **Gate (progress · create-site:5.7.critique-blocked):** A critical design gate still fails after three critique rounds.
>
> **Trigger:** Phase 5.7 round three ends with at least one critical gate from `design-critique.md` failing.
> **Why we ask:** A critical gate means a broken first screen, mobile layout, accessible flow, or honest-proof problem; moving on silently would carry it into the audit and the deployed site.
> **Cancel leaves:** Nothing - site files and commits stay on disk.

Name each failing critical gate and its evidence in the question.

Ask the user:

| Question | Header | Options |
|----------|--------|---------|
| *(failing gate and evidence)* - how should I proceed? | Design gate | Keep fixing (Recommended), Continue and record it as a known issue, Stop here |

- **Keep fixing**: run up to three more rounds on the failing gate, then return to this gate if it still fails.
- **Continue and record it as a known issue**: add it to the scorecard as a known issue and proceed to 5.7's completion; the Phase 7 summary lists it.
- **Stop here**: stop the skill; the project and its commits remain on disk.

> **GATE: Do NOT proceed to Phase 6 until ALL customization is complete and the 5.7 critique pass is complete.** All requested pages and features exist, the design tokens live in the theme file, the chosen Google Fonts pass the font check, no critical gate fails unless the user chose to continue past it, and the scorecard is recorded.

**Output**: All pages, components, and design elements implemented, critiqued, and verified
