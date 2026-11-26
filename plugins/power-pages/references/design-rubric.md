# Design Rubric

How a generated or existing Power Pages code site's design is graded: what is checked, how issues are found and labelled, and how scores and the verdict are computed. It is used by the evaluation runtime's design grade (`evals/README.md`, Design grade).

The checklist is [`design-rubric-catalog.json`](design-rubric-catalog.json), readable as [`design-rubric-checks.md`](design-rubric-checks.md). This grade is separate from the review rubric that `create-site` and `exceptional-web-design` use ([`design-critique.md`](design-critique.md)), which it does not change.

## The principle: the judge finds issues, a formula scores

Language models answer "is this specific problem visible here?" far more consistently than they produce numeric ratings. So:

1. **A judge finds issues** using a closed checklist. Each item has a trigger, a PASS example, a FAIL example, and a fixed severity.
2. **Measured checks help the judge see more.** A browser measures what can be measured (contrast, overflow, font sizes, image ratios, focus, motion, and more) and proposes those issues as *candidates*. The judge confirms or dismisses each one with a reason.
3. **Scores are computed from the confirmed issues** by a fixed formula. The judge never picks a number or a severity.

## What is judged: 3 categories, 10 sub-dimensions

| Category | The visitor's question | Sub-dimensions |
|---|---|---|
| **Message & Persuasion** | Do I understand it, believe it, and want to act? | First impression & clarity · Attention & hierarchy · Narrative & page flow · Copy & value communication · Trust & proof |
| **Usability & Accessibility** | Can I use it easily, on my device, whatever my abilities? | Cognitive fluency & usability · Responsive & accessible design · Interaction & motion craft |
| **Visual Craft & Brand** | Does it look deliberate, polished, and like *this* organization? | Brand & visual coherence · Detail & memorable finish |

Every checklist item belongs to exactly one sub-dimension, and every sub-dimension has items.

## Severity and critical gates

- **major** - a clear defect a visitor would notice, or one that blocks some visitors; fix before shipping.
- **minor** - a polish or consistency problem that does not stop anyone using the site.

Severity is fixed per item; a few items have a documented escalation applied by code from measured facts. Seven **critical gates** mark the problems that most damage a first visit. An item tagged with a gate fails it when it triggers (some only under a stated condition, such as "at the mobile width"); gate issues are always major.

| Gate | Fails when |
|---|---|
| G1 Unclear offering or primary call to action | A first screen does not say what is offered or what to do next |
| G2 Competing focal points | Two or more elements compete to be seen first |
| G3 Inaccessible primary flow | Keyboard focus is invisible, form fields are unlabeled, or text contrast is severely low |
| G4 Invented proof or misrepresentation | Proof is fabricated, or controls promise what the site does not do |
| G5 Broken mobile layout | Sideways scroll, overlapping or clipped text on phones, or the primary action pushed off the mobile first screen |
| G6 Failed font check | A chosen font did not load, or headings are drawn in a faked weight |
| G7 Generic or assembled look | The site could belong to any organization, or looks assembled from unrelated templates |

## Finding issues consistently

1. **One checklist item, one issue.** The same item on several pages or elements is a single issue, with every page and element listed as evidence.
2. **Closed checklist.** Issues come from catalog items; the judge cannot invent severities or new categories.
3. **Evidence required.** Every fail names the page, viewport, and screenshot; every dismissal of a candidate gives a reason of at least 20 characters.
4. **When in doubt, pass.** A judgment item fails only when its condition is clearly visible in a named screenshot.
5. **Complete answers.** An answer that misses a candidate or an item for some page is rejected and returned for correction.

## Scores and verdict

Per category, from its confirmed issues:

```
load  = majors + 0.25 * minors          # a major counts four times as much as a minor
score = 5 - 4 * tanh(0.2 * load)        # 1 to 5, rounded to 2 decimals
```

No issues scores 5.00; one minor 4.80; one major (or four minors) 4.21; two majors 3.48; three majors 2.85. There is no overall score.

| Condition | Verdict |
|---|---|
| any gate fails | **Not ready** |
| evidence missing for some page, width, or check | **Incomplete** |
| any major issue | **Needs revision** |
| otherwise | **Ready** |

Issues are ranked by gate, severity, pages affected, above the fold, effort, sub-dimension, and ID.

## Changing the rubric

Change items, thresholds, severities, and gates only in `design-rubric-catalog.json` and `scripts/lib/design-grade/checks.js`, bump the catalog `version`, and regenerate the readable table with `node scripts/lib/design-grade/render-rubric.js`. Grades record the catalog version; compare scores only within one version.
