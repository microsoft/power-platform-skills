# Page Blueprints

What goes on each page of a Power Pages code site, and in what order.
Used by `create-site` Phase 3 (page narratives and hero concept) and Phase 5 (building pages).
The leading words - **first impression**, **focal point**, **design thesis**, **signature moment**, **point of doubt**, **template look** - are defined in [`design-aesthetics.md`](design-aesthetics.md#the-bar).

## The first screen

Every page's first impression follows the hero sequence: **headline, context, proof, action**.

- The headline names the outcome or transformation, not the mechanism. "Get your permit approved without chasing paperwork" beats "Online permit management system".
- The context line says who it is for and how it works, in one or two short sentences.
- Compact proof sits next to the CTA when trust is the visitor's first objection.
- The primary CTA is unmistakable: `--color-primary`, the largest control on screen, with the label from the experience brief. A secondary CTA, when present, is visibly quieter (outline or text link).
- The headline and the primary CTA get the most whitespace on the screen.
- The whole sequence, with the primary CTA, fits in the first viewport at both 1440x900 and 390x844.

## Hero patterns

Pick one for the Home first screen and record it as the hero concept.

| Pattern | Use when | Composition |
|---------|----------|-------------|
| Product moment | External portals and landing pages built around a task | Asymmetric 7/5 grid: text on the left along the upper-third line, a composed piece of the site's own UI on the right, overlapping the bottom edge into the next section. |
| Full-bleed photograph | The place or the people are the offer (tourism, community, events, campuses) | A specific photograph under a palette-tinted scrim, with the text block on a rule-of-thirds intersection and contrast checked over the busiest part of the image. |
| Type-led statement | Editorial, brand-led, or premium sites | An oversized display headline across 9-12 columns, a supporting visual band underneath, and generous air. |
| Task-first welcome | Internal portals, dashboards, and signed-in self-service | A greeting, the primary task front and center (search or "Start a request"), and three or four status cards with live counts. No marketing headline. |
| Interactive proof | The signature moment is itself the hero | A working search, eligibility checker, or estimator that shows the value before the visitor reads anything else. |

## Narrative blueprints

Build each page as a narrative, not a stack of components.
The core beats are:

1. **Orientation** - what it is, who it serves, the outcome.
2. **Credibility** - why to believe it.
3. **Recognition** - the visitor's problem, shown to be understood.
4. **Mechanism** - how the outcome happens.
5. **Value** - capabilities translated into benefits.
6. **Evidence** - proof placed against specific doubts.
7. **Risk reduction** - security, privacy, effort, cost, or support concerns answered.
8. **Action** - a clear next step with reassurance.

Select only the beats that advance the visitor's decision.
Write each page's `content` outline in the plan as these beats in order, one line per section with its purpose.

### Landing page (external)

Navigation with one primary action → hero → credibility strip (only real proof) → problem and stakes → three to five outcome-led capabilities → the signature moment as an interactive exploration → use cases by role → a testimonial or result beside the strongest commitment doubt → security, privacy, or support reassurance → an FAQ that answers real objections → a focused final CTA → footer with secondary navigation.

### Customer self-service portal (external company portal)

Hero (task-first welcome or product moment, with search or the primary task) → top tasks as three to six verb-led entries ("Track a case", "Pay a bill") → how it works as a three- or four-step process line → knowledge highlights → reassurance beside sign-in (what account is needed, how data is handled) → a human contact fallback → final CTA.

### Internal portal or dashboard

Task completion outranks persuasion.
Global navigation with current context → greeting with critical status and the next action → the user's most important information → secondary detail behind progressive disclosure → search and filters where volume demands them → help at the moment of difficulty.
Design the empty, loading, warning, and error states as carefully as the full state.
Here the wow comes from clarity and craft: tabular numerals (`font-variant-numeric: tabular-nums`) in data, color used only for status, crisp density, and polished micro-interactions.

### Content or blog

Editorial hero (a featured story, image-led or type-led) → topic navigation → a story grid with varied sizes (one lead, two secondary, then a list) → newsletter or next-step CTA.
Article pages hold body text to 60-75ch with generous leading, pull quotes, a reading-progress indicator, and related stories at the end.

### Supporting pages

- **About** - a story with a point of view, specific people or place imagery, and values shown as evidence rather than adjectives.
- **Contact** - a short form with reassurance beside it (the response time the user stated, how the data is used), alternative channels, and a location map when location matters.
- **Services or catalog** - a comparison-friendly layout, filters when there are more than about eight items, and a detail view with one clear CTA.
- **FAQ** - grouped accordions that answer the objections found in the brief.

## Section rhythm

- Vary composition: a dense grid, then a calm single statement, then a full-bleed visual band, then a split layout. Three consecutive sections never share a layout.
- Vary width between contained, full-bleed, and narrow-measure sections.
- Vary background between `--color-bg`, `--color-surface-strong`, and at most two inverted primary bands per page.
- Author the transitions: shared alignment lines, an element that straddles a section boundary, a curved or angled background change, a process line that continues across sections, or a section that ends on the question the next one answers.
- Use a 12-column grid on desktop, 8 on tablet, and 4 on mobile as invisible structure, and break it only with intent - a visual that bleeds off the edge, a headline that spans the gutter.
- Group with proximity and space first; add borders and boxes only when space alone does not group.
- Each section ends with a reason to keep scrolling: curiosity, relevance, or forward momentum.

## Section selection

- **Cards** - peer items that benefit from comparison.
- **Bento grid** - items of different importance; tile size follows importance.
- **Tabs** - one context with a small number of views to switch between.
- **Accordions** - secondary details, FAQs, and long mobile content; primary selling points stay visible.
- **Testimonials** - one beside the doubt it answers; no generic carousel.
- **Metrics** - only when sourced, meaningful, and understandable at a glance.
- **Navigation** - five to seven primary items; a mega menu only when the depth genuinely warrants grouped previews.

## Copy

- Progress from what it does to how it helps.
- Use concrete nouns, named steps, and the numbers the user gave.
- Give each destination one label everywhere on the site, and make CTA verbs specific: "Track my request", "Book a visit".
- Keep paragraphs to three sentences or fewer under headings that carry meaning on their own, so a scan reads as a summary.
- Let imagery and UI demonstrations carry part of the story so the text can be shorter.
- Write in the voice the design thesis names.
- Replace filler such as "revolutionize", "seamless", "cutting-edge", and "unlock" with the concrete claim it stands in for.

## Honest proof

Use only proof the user supplied or the site itself demonstrates: response times, coverage, and history the user stated; a workflow the visitor can see working; a transparent "what happens next" process; true statements about how sign-in and data handling will work.
Customer names, logos, testimonials, awards, and metrics are never invented and presented as fact.

When the design calls for proof the user has not supplied, use sample content:

- Keep it plausible and generic, with no real company or person names.
- Mark each instance with a `SAMPLE CONTENT - replace before launch` code comment so it is easy to find.
- List every instance in the Phase 8 summary as content to replace.

Place proof at the point of doubt: credibility near the hero, testimonials near commitment, security near sign-in and data entry, reassurance beside forms.

## Signature moment ideas

| Site type | Signature moment |
|-----------|------------------|
| Self-service portal | A request-status timeline that animates step by step on scroll; a live search preview over the knowledge base |
| Landing page | Tabs that swap a composed UI to show each capability; a before-and-after comparison |
| Internal portal or dashboard | Status counts that tick up once on load; a "next best action" card that responds to the user's role |
| Content or blog | A featured-story image revealed by scroll; a reading-progress bar in the accent color |
| Directory or catalog | Instant filtering with an animated reflow of results |
| Events or community | A map with pins that land in sequence; a schedule that highlights what is happening now |

Every signature moment works with the keyboard and still makes its point with motion turned off.
