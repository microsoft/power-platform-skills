# Design Critique

How a Power Pages site is judged from screenshots.
`create-site` uses it for the first-impression review after the Home page (Phase 5.2) and the full critique (Phase 5.7).
`exceptional-web-design` uses the Capture, both passes, and the Rubric to review an existing site; the First-impression review, Scorecard, and Loop sections belong to `create-site`'s build loop.
Review as a **skeptical art director** who did not build the site and sees it for the first time - the question is whether a visitor would say "wow", not whether the code works.
The leading words and the design rules being checked live in [`design-aesthetics.md`](design-aesthetics.md) and [`page-blueprints.md`](page-blueprints.md).

## Capture

One command captures every route at desktop (1440 x 900) and mobile (390 x 844) and runs the automated checks:

```bash
node "${PLUGIN_ROOT}/scripts/capture-design-review.js" --input - <<'REQUEST'
{"url": "<SITE_URL>", "routes": ["/", "/about"], "projectRoot": "<PROJECT_ROOT>"}
REQUEST
```

Every value goes in the JSON request, never on the command line: a URL, a route, or a folder path can hold characters a shell acts on (`&`, `;`, `$`, quotes), and the quoted `'REQUEST'` delimiter keeps the shell from expanding anything inside.
Write each value as a JSON string (escape `"` and `\`) and include only the fields that apply:

| Field | Value |
|-------|-------|
| `url` | The dev server or a deployed site, `http` or `https` only, without a user name or password |
| `routes` | An array of routes to capture |
| `discover` | Instead of `routes`: the most pages to collect from the start page's navigation, then its main content, then its footer |
| `projectRoot` | A project this plugin generated, to use its own `playwright` dev dependency. Loading it runs that project's code, so leave it out for any other folder |
| `checksOnly` | `true` to run the checks without screenshots |
| `axe` | `true` to add the axe-core accessibility audit of the captured pages (`accessibility`, summarized in `summary.accessibility`) |
| `cleanup` | Alone: remove a capture's `outputDir` |

Without `projectRoot`, the script borrows the Playwright inside the plugin's pinned `@playwright/mcp` package - the one its MCP server runs, kept in npm's cache - so nothing is installed into the project. On a machine where that package is not cached yet, npm downloads it there on first use.
The script rejects any other field or an unsafe URL; fix the request rather than moving values onto the command line.

It prints JSON and writes screenshots to a private temporary directory outside the project (`outputDir`).
A request of `{"cleanup": "<outputDir>"}` removes them; it exits 1 and names the directory when it cannot, so pass that path on to the user rather than reporting the screenshots gone.
Open every path in `summary.images` - in parallel, in one turn - and read the checks from `routes[]`.
Per route:

| Image | Shows | Judge from it |
|-------|-------|---------------|
| `<page>-desktop.png` | The desktop first screen at load | The five-second test, focal point, type, alignment, imagery |
| `<page>-desktop-full.png` | The whole desktop page, after scroll reveals ran | Rhythm, section order, transitions, the ending |
| `<page>-mobile.png` | The mobile first screen at load | The mobile five-second test and whether the primary CTA is above the fold |
| `<page>-mobile-sheet.png` | The whole mobile page cut into columns two screens tall, read left to right; a dashed pink line marks the fold in the first column. A page longer than six columns continues on `<page>-mobile-sheet-2.png` and onward - read them in order | Mobile reprioritization, stacking, overlap, clipped text, tap targets |

Automated checks per route and width:

- **`fonts`** - the families that actually loaded. Both chosen families must be listed; a missing one means the font `<link>` names it wrong or requests a weight range from a static family (see [design-aesthetics.md](design-aesthetics.md#4-typography)).
- **`syntheticWeights`** - headings (`h1` to `h6`) drawn at a weight their family does not ship, so the browser fakes it (e.g., `h1: Instrument Serif 700`). Set them at a weight the family publishes.
- **`overflow`** - measured after scrolling through, so content revealed on scroll is included. `{ "overflow": true }` with an empty `culprits` list means a pseudo-element or a `100vw` width is responsible - look for `::before`/`::after` with negative offsets (e.g., a decorative frame corner at `right: -8px`). The fix belongs on the element; `overflow-x: hidden` on `html` or `body` only hides the break and clips content.
- **`pageErrors`** - uncaught exceptions, console errors, HTTP error responses, and requests that failed outright (DNS or connection errors), each with its URL. URLs are cut to origin and path, because query strings can carry tokens.
- **`redirectedTo`** - present when the route was sent to sign in: to another host (an identity provider) or to the site's own sign-in page. The headless capture cannot sign in, so those screenshots show the login page, not the design. Canonical redirects (http to https, with or without `www.`) are followed and not reported.

`summary` lists the routes that overflow, have page errors, redirected, or failed to capture.
`summary.truncated` lists mobile pages too long for their sheets (over about 30,000 px, usually an endless feed); judge their end from the desktop full page and say the mobile end was not seen.

## First-impression review

Capture `/` only, then judge the Home desktop and mobile first screens:

- The five-second test from Pass 1 passes on both.
- The hero has exactly one focal point.
- The primary CTA is visible without scrolling on both.
- Both fonts loaded and nothing overflows.

Write only these points, in the scorecard format below.

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

From the code under `<PROJECT_ROOT>/src`, because static screenshots cannot show states - search it rather than reading every file:

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
- A failed font check: a chosen family missing from `fonts`, or any entry in `syntheticWeights`.
- A site that could belong to any organization, or pages that look assembled from unrelated templates.

## Scorecard

Write only this - every later tool call re-sends it, so keep it compact:

1. **Scorecard** - one line per category: `n. Category - score - evidence (page, viewport, element)`.
2. **Critical gates failing** - one line each, or "None".
3. **Fixes** - at most 15, highest impact first, one line each: `page, viewport, element - problem - fix`, naming the source file.
4. **Verified** - in a later round, one line per earlier fix: fixed or still failing.

List problems only; passing details need no mention.

## Loop and completion

1. Capture, run both passes, score the rubric, and write the scorecard.
2. Fix every critical gate, then every category below 3, highest impact first, and commit.
3. Review again, capturing only the routes that changed plus `/`, and verify each earlier fix.

The pass is complete when no critical gate fails and every category scores 3 or more, or when three rounds have run and no critical gate fails - each category still below 3 is then recorded with its reason, and the Phase 7 summary shows it to the user.
A critical gate still failing after three rounds goes to the user through the `create-site:5.7.critique-blocked` gate in `SKILL.md`; it never passes silently.
Keep the final scorecard for the Phase 7 summary, then remove the screenshots with a `{"cleanup": "<outputDir>"}` request for each round's `outputDir`.
