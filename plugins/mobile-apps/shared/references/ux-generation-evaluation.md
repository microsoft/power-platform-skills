# Prompt-only UX generation evaluation

Maintainer evaluation of the experience-first workflow. This is not an app authoring
reference, an automatic create phase, a new test framework or a visual template.
Do not give expected plan fixtures, prior generated apps or this evaluation's observations
to the generator as design inputs. A passing contract test is not a model-quality result.

## Compare fresh runs

Use separate fresh installed-template projects for baseline and candidate. Keep the template,
model/settings, supplied prompt, capability availability and permitted data-source context
equivalent; record their versions. Do not mix an existing approved design into a prompt-only
run. Brand-reference runs are a separate condition.
Preserve the first-pass artifact before giving corrective feedback or a reference image.
Record reference-assisted revisions separately; they cannot replace a weak prompt-only result
or prove the same quality would have been produced without that added input.

Run the ordinary create workflow and its existing approvals/validators; do not bypass safety,
provisioning consent or required evidence to complete an evaluation. Use explicitly isolated
test data and record any unresolved setup. No production credentials or tenant data belongs
in evaluation reports. Follow the normal local/native launch boundaries.

Repeat each selected prompt in independent projects; three runs per prompt is a useful
comparison, not a screen-count target or a requirement for ordinary app generation. Report
the distribution of outcomes, not only the strongest screenshot. Record failed and interrupted
runs as well as completed ones. Do not launch bulk generations without explicit authorization.

| Prompt | Inspect without prescribing the layout |
|---|---|
| Field staff receive expected shipments, scan items, record received/damaged quantities, inspect goods, photograph damage, capture location and confirm the recipient. | One coherent reception journey; quantity units and discrepancies; supported evidence cardinality; location/confirmation readiness; no invented offline persistence |
| Help a gym team find equipment, report faults and manage maintenance work. | Recognizable equipment and work context; clear next action; useful scope and recovery; readiness/repair metrics only when supported; no mandatory KPI dashboard |
| Learners resume short lessons, answer practice questions and save their progress. | Readable content and retained position; contextual practice and continuation; no forced operational card grid or unrequested gamification |
| Staff submit expenses with receipts and managers review them with a reason for rejection. | Clear submission/review boundaries and role assumptions; evidence and decision support; honest pending/error states; no inferred signature capture |

These are test prompts, not default application requirements. Preserve explicit constraints
and classify inferred business scope rather than rewarding extra features.

## Review each stage

1. **Before data:** inspect Experience outline and Information needs. Do they translate the
   prompt into a working journey and necessary decision evidence, rather than a noun inventory?
2. **Before spec approval:** inspect Information and interaction coverage. Every required fact,
   metric, filter, write and artifact has a supporting path. A high-overlap table with missing
   requirements is not complete; no new column is required merely for an already derivable value.
3. **Intent preview:** inspect each selected populated screen at the same usable viewport,
   including text enlargement, internal scroll, bottom actions and relevant empty/error states.
   Observe hierarchy, context, density, typography, media and action reachability. A long reader
   and a compact work queue should be allowed to look different.
   Confirm the primary working surface is actually shown, not merely hidden behind a detour.
   Inspect realized grouping, action emphasis, icons and media rather than recipe names.
   Judge entry usefulness before supplying a reference: orientation, relevant work/content,
   decision-bearing facts and a next step. A filled viewport is not proof of usefulness;
   neither a reader nor a work queue should inherit another domain's Home layout.
4. **Implementation:** compare the actual component exports, screen sources and current
   source-derived full-screen preview with the accepted design. Do not improve the HTML to hide
   missing native code. Exercise selection, filters, next steps, failure/retry and reset.
5. **Native evidence:** observe the requested device journey, data persistence and native
   capabilities when the required environment/device is available. Otherwise report the
   precise unverified scope; an HTML simulation is not a substitute.

For each applicable preview, exercise two different record identities, a read-only variant,
compound filters with a no-match result, an invalid edit, and reset after state changes.
Check every offered scope's data support rather than rewarding convincing mock-only fields.
Calibrate the browser capture and inspect final-version images; a full matrix of clipped or
stale screenshots is not a completed review. Keep the initial render, the reviewed/repaired
prompt-only result, and any later reference-assisted revision distinguishable.

Use the existing source checks, `read-screen-data-audit.js`, provenance assertions and
[rendered preview review](rendered-preview-review.md), including `validate-preview-review.js`.
Record browser fallback attempts and incomplete evidence; those results establish only their documented scope. No additional framework
or score based on card count, color ratio, fixed density or pixel similarity is required.

## Report the result honestly

Record a compact row per run in the evaluation's project/session artifacts:

`Prompt/run | plugin/template/model versions | requirement/data coverage | intent observations |
implementation drift | exercised recovery | native evidence | unresolved findings`

Required information, unsupported capability claims, broken primary journeys, unreadable text,
clipped actions and unimplemented accepted treatments are failures to repair or unresolved
requirements, not aesthetic preferences. Source, rendered approximation and native results
remain separate. Missing evidence is unverified, never passed.

Palette preference, optional decoration and a different but equally useful composition are
comparative observations, not automatic failures. For a real regression, record the exact
prompt, observed stage, affected screen/state, reproduction and an available screenshot, then
add a focused regression to the existing tests or workflow. Do not claim repeatable quality
from one successful run or from tests of authored fixtures alone.
Reference examples are quality benchmarks, not app-specific generation rules. Do not require
the benchmark's brand color, domain fields, navigation or card layout in unrelated products.
