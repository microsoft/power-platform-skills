# Design Critique

How `create-site` judges what it built: the first-impression check after the Home page (Phase 5.2) and the full critique pass (Phase 5.7).
Judge as a **skeptical art director** seeing the site for the first time - the question is whether a visitor would say "wow", not whether the code works.
The leading words and the design rules being checked live in [`design-aesthetics.md`](design-aesthetics.md) and [`page-blueprints.md`](page-blueprints.md).

## Screenshots

Use `browser_take_screenshot` and leave `filename` unset.
The plugin's Playwright launcher points screenshot output at a private temporary directory outside the user's project, and removes it when the server stops or, if the host killed the server, on a later launch.

Set the viewport with `browser_resize`:

- Desktop: 1440 x 900.
- Mobile: 390 x 844.

Before any full-page screenshot, scroll the page through once with `browser_evaluate`.
A full-page capture does not scroll, so `IntersectionObserver` reveals never fire and lazy images never load, and those sections would look blank.
Scroll with `behavior: 'instant'`: under the common `scroll-behavior: smooth`, a plain `scrollTo` is still animating when the capture starts, and the sticky header lands mid-page:

```js
async () => {
  for (let y = 0; y < document.documentElement.scrollHeight; y += window.innerHeight / 2) {
    window.scrollTo({ top: y, behavior: 'instant' });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  await new Promise((resolve) => setTimeout(resolve, 300));
}
```

Capture set for the critique pass:

| Page | Desktop | Mobile |
|------|---------|--------|
| Every page | Viewport (the first impression) and full page | Viewport, plus a viewport shot of each grid, table, or form section scrolled into view |

Judge rhythm, transitions, and section order from full-page shots, which are downscaled.
Judge type, alignment, and imagery from viewport shots.
For a detail too small to judge, scroll it into view with `browser_evaluate` (`() => document.querySelector('<selector>').scrollIntoView({ block: 'center' })`) and take a viewport shot.
When the pass is done, resize back to 1440 x 900.

## Overflow check

Run on every page at both widths with `browser_evaluate`, after navigating to the page.
Horizontal overflow is the most common mobile break and is easy to miss in a viewport shot.
The check scrolls through first because content revealed on scroll only takes its final layout once seen; measuring at load misses it:

```js
async () => {
  const root = document.documentElement;
  for (let y = 0; y < root.scrollHeight; y += window.innerHeight / 2) {
    window.scrollTo({ top: y, behavior: 'instant' });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (root.scrollWidth <= root.clientWidth) return { overflow: false };
  // Locate culprits only once the page really scrolls sideways; off-canvas fixed menus
  // and carousels clipped by an ancestor also extend past the edge but cause no scroll.
  const culprits = [...document.querySelectorAll('body *')]
    .filter((el) => el.getBoundingClientRect().right > root.clientWidth + 1)
    .slice(0, 10)
    .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${[...el.classList].map((c) => '.' + c).join('')}`);
  return { overflow: true, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, culprits };
}
```

`{ overflow: false }` passes.
An empty `culprits` list with `overflow: true` means a pseudo-element or a `100vw` width is responsible - search the CSS for `::before`/`::after` with negative offsets (e.g., a decorative frame corner at `right: -8px`) and for `100vw`.
Fix the element that overflows; setting `overflow-x: hidden` on `html` or `body` only hides the break and clips content.

## Font check

Run on the Home page with `browser_evaluate`:

```js
async () => {
  await document.fonts.ready;
  return [...new Set([...document.fonts]
    .filter((face) => face.status === 'loaded')
    .map((face) => face.family.replace(/["']/g, '')))];
}
```

Both chosen families must be in the result.
A missing family means the font `<link>` names it wrong or requests a weight range from a static family - fix the link per [design-aesthetics.md](design-aesthetics.md#4-typography).
Use this loaded-faces list rather than `document.fonts.check()`, which returns `true` for a family the page never loaded.

## First-impression check

Run after the Home page is built, before the remaining pages, so every later page inherits a proven foundation.

1. Run the font check, and fix the font link until it passes.
2. Take the Home desktop viewport and mobile viewport shots, and run the overflow check at both widths.
3. Run the five-second test from Pass 1 on both shots.
4. Fix the hero until all four answers are clear on both shots, the hero has exactly one focal point, the primary CTA is visible without scrolling, and nothing overflows. Re-shoot after each fix.

Stop after three rounds; carry anything still failing into the critique pass as a known issue to fix there.

## Pass 1 - structure and narrative

For each page, from its screenshots:

- **Five-second test** on each first-impression shot. Write down what the page is, who it is for, why to trust it, and what to do next. Any answer you cannot write from the shot alone is a failure.
- **Focal point** - exactly one per viewport.
- **Primary CTA** - unmistakable, and the same label for the same destination on every page.
- **Narrative** - sections follow the page's planned beats, and each one earns the next scroll.
- **Proof** - honest, and at the point of doubt.
- **Mobile** - the first screen is reprioritized rather than stacked, with the primary CTA visible.

## Pass 2 - craft and interaction

From the screenshots:

- Edges align to the grid, spacing follows the token scale, and body lines stay within `--measure`.
- The type ramp holds: hero at least 3x body, weights by role, headings wrapping without orphans.
- `--color-primary` appears only on priority actions and key highlights; neutrals dominate.
- One corner language, one shadow family, and one icon style across every page.
- Images are sharp, cropped to their point, and share one art direction.
- Nothing matches a row of the [template look table](design-aesthetics.md#12-template-look-and-its-replacement).

From the code, because static screenshots cannot show states:

- Every interactive component has the hover, focus, pressed, and disabled treatments, and every data-driven view has loading, empty, error, and success states (see the state table in [design-aesthetics.md](design-aesthetics.md#8-motion-and-interaction)).
- A `prefers-reduced-motion` block exists and covers every animation.
- Scroll reveals start from visible content and add the hidden state only from script.
- Raw hex values, font names, and pixel shadows appear only in the theme file.

## Rubric

Score each category from 0 to 4.

| Score | Level | Meaning |
|-------|-------|---------|
| 0 | Broken | Missing, misleading, inaccessible, or unusable |
| 1 | Functional | Works, but generic, unclear, or inconsistent |
| 2 | Intentional | Clear decisions and reasonable consistency, with visible gaps |
| 3 | Crafted | Cohesive, compelling, responsive, and polished |
| 4 | Exceptional | Every detail reinforces clarity, value, trust, and flow, without excess |

| # | Category | Key question |
|---|----------|--------------|
| 1 | First impression and clarity | Does every first screen answer the four questions through headline, context, proof, and action? |
| 2 | Attention and hierarchy | Is there one focal point per viewport and an obvious reading order? |
| 3 | Cognitive fluency and usability | Can a visitor scan and decide with little effort - simple choices, navigation, forms, and errors? |
| 4 | Narrative and page flow | Does each section earn the next, with authored transitions? |
| 5 | Copy and value communication | Is copy concrete, outcome-led, and consistent in its CTA labels? |
| 6 | Trust and proof | Is proof honest, relevant, and at the point of doubt? |
| 7 | Brand and visual coherence | Do type, color, geometry, imagery, icons, and motion form one system that feels specific to this organization? |
| 8 | Responsive and accessible design | Does hierarchy hold at every width, with keyboard, focus, contrast, labels, and reduced motion handled? |
| 9 | Interaction and motion craft | Are all states designed, and does motion explain state, relationship, or progress without delaying reading? |
| 10 | Detail and memorable finish | Are alignment, spacing, crops, and states refined, does the signature moment land, and does each page end strongly? |

Every score cites evidence: a page and viewport with the element, or a file path.
A 4 requires that you cannot name a single improvement in that category.
A total of 36-40 is exceptional, 30-35 crafted, 22-29 intentional, 12-21 functional, and 0-11 broken.

**Critical gates.**
Any of these caps the site at Intentional regardless of the total, and must be fixed:

- An unclear offering or primary CTA on any first screen.
- Two or more elements competing as the focal point of a first impression.
- An inaccessible primary flow: keyboard, focus, form labels, or contrast.
- Proof invented and presented as fact, or UI that misrepresents what the site does.
- A broken mobile layout: a failed overflow check, overlap, clipped text, or the primary CTA pushed off the first screen.
- A failed font check.
- A site that could belong to any organization, or pages that look assembled from unrelated templates.

## Loop and completion

1. Capture the screenshot set, run the font and overflow checks, run both passes, and score the rubric.
2. Fix every critical gate, then every category below 3, highest impact first. Commit each fix.
3. Re-capture the pages you changed and re-score.

The pass is complete when no critical gate fails and every category scores 3 or more.
After three rounds, stop iterating on categories below 3 and record each with its reason.
A critical gate still failing after three rounds goes to the user through the `create-site:5.7.critique-blocked` gate in `SKILL.md`; it never passes silently.
Keep the final scorecard - category, score, and evidence - for the Phase 7 summary.
