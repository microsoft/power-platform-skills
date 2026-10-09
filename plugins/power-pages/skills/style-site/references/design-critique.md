# Classic design critique adapter

Read for the final coordinated classic design review or a separately requested classic visual critique, not for every small styling operation. Read and apply [shared site design quality](../../../references/site-design-quality.md) and the [classic styling adapter](design-quality.md). This file governs classic interpretation only; it does not change the SPA design references, scoring, fonts, or build loop.

## Reuse the rubric, not the SPA execution contract

Use only the two tables in the shared [Rubric section](../../../references/design-critique.md#rubric): the 0-4 scale and ten design categories. Do not copy those tables here or load the SPA Capture, Scorecard, or Loop sections for ordinary local edits. The rules below adapt the categories to native source and available evidence; they are not a second score-to-pass gate.

- Reuse the approved experience brief and `designContext`. Review first-screen hierarchy, narrative, proof, visual coherence and responsive intent once after coordinated native authoring; do not repeat discovery or critique at every component.
- Judge new-site design against that brief, not resemblance to the selected creation template. The template supplies data/domain and requirements context; a different supported composition, layout or brand treatment is not a defect. Check required capabilities/content, native integrity and explicit preservation preferences separately. Do not turn an existing-site narrow edit into an unsolicited redesign.
- For a new-site custom-layout brief, compare Home and the primary journey's actual section/shell composition with the approved plan and baseline. Content/image substitutions and recoloring on an unchanged starter composition are incomplete layout work, not a completed custom design. Cite the missing source-level changes and return them through the existing owner/revision process. Reusing a required form/list/snippet or native grid primitive is valid; preserving one named region does not exempt the rest. Do not infer success from a larger diff, or failure from missing screenshots.
- Native forms, lists and task pages need a clear heading, context and next useful task, not an oversized hero or 3x-body display type. A submit control stays after its required fields; its position below the fold is not itself a failure.
- Preserve approved brand/system/self-hosted fonts and supported language coverage. The capture's `fonts` list contains downloaded `FontFace` families, not an inventory of system fonts. An empty list or single-family design is not a failure; investigate a missing expected web font or an evidenced unintended synthesized weight.
- Judge the native cascade: approved inline declarations, existing tokens and scoped custom styles are valid, and protected defaults stay unchanged. Do not impose SPA token names, theme replacement, Google Fonts rules, or a `src`-only inspection path.
- Apply the shared exact contrast thresholds to actual foregrounds, surfaces, children and states. Existing required-before-approval checks remain mandatory; provisional visual scoring does not excuse a known contrast failure.
- Review applicable native interaction states and reduced-motion alternatives where animation exists. A motion-free page needs no empty animation block. Do not invent unsupported controls, live data, endorsements, testimonials or service levels to satisfy a blueprint.
- Interchangeable composition is a design concern; retaining an approved font, native control or successful existing layout is not inherently a template-look defect.

## Evidence and reporting

- **Rendered:** identify the actual page, locale, viewport and element. A deployed URL is not evidence that unpublished local changes render correctly.
- **Source-only:** cite the native file and mark conclusions provisional. Plan/status HTML and structural wireframes are not site previews.
- **Not observed:** font loading, crop, wrapping, overflow, keyboard behavior, or a Studio round trip was not established. Missing evidence is neither a pass nor a failure.
- Use **not applicable** only for a genuinely irrelevant criterion, with a reason. Automated accessibility results are bounded evidence, not a complete WCAG certification.

Score only evidenced categories when scoring is useful. With source-only or missing category evidence, report a **Provisional/partial review**, not a verified total out of 40 or a rescaled rating. Only for a fully evidenced total, also read the shared rubric's total-to-level bands. Report evidenced critical failures (unclear primary flow, competing first-screen focal points, inaccessible flow, misleading proof/UI, broken mobile layout, unintended font failure, or incoherent identity); an evidenced critical failure caps that rating at Intentional. Unavailable checks remain not observed. Say **No evidenced failures**, not "All passed", when observations are missing.

## Keep the local contract

No browser, local server, deployment, or extra gate is required. Reuse child verification and any approved image-check receipt without repeating unchanged probes; unchecked images remain unverified, not a reason to add mandatory network checks. Preserve exact-diff/hash approval, native ownership, Bootstrap/Studio structures, authentication, navigation and locales.

The SPA automatic capture/fix/commit loop does not apply to classic creation, customization, styling, or read-only critique. Missing rendering cannot block an otherwise independently verified local edit or authorize deploying it for screenshots. Known local failures still follow the existing owner and approval rules.

A separately requested classic `/exceptional-web-design` review follows [its native workflow](../../exceptional-web-design/workflows/classic-site.md). Its broader screenshot capture is not authorized by `style-site:2.runtime`, which remains bounded structural/computed-style discovery. Recommendations require fresh owner/scope/diff/hash approval; no automatic fix loop or deployment follows.
