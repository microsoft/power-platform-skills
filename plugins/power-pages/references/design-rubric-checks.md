# Design Rubric — Check Catalog

<!-- Generated from design-rubric-catalog.json v2.3.1 by scripts/lib/design-grade/render-rubric.js. Do not edit by hand. -->

Each row is one check. **Auto** checks are measured with fixed thresholds and become *candidates* the reviewer confirms or dismisses. **Judgment** checks are answered from screenshots using the pass/fail anchors. Severity is fixed per check unless an escalation rule is listed. See [design-rubric.md](design-rubric.md) for the method.

## Severities

- **major** (load 1): A clear defect a visitor would notice, or one that blocks some visitors, that a design reviewer would ask to fix before shipping. Examples: text too faint to read, a layout that breaks on phones, no clear main action, placeholder text left on the page.
- **minor** (load 0.25): A polish or consistency problem that makes the site feel less finished but does not stop anyone using it. Examples: too many corner styles, a missing favicon, slightly uneven section spacing.

## Critical gates

A failing gate makes the verdict **Not ready**. Gate issues are always major.

| Gate | Title | Definition | Checks |
|---|---|---|---|
| G1 | Unclear offering or primary call to action | On some page's first screen, a visitor cannot tell what is offered or what to do next. | J-02, J-14 |
| G2 | Competing focal points | Two or more elements compete to be the first thing seen on a first screen. | J-01 |
| G3 | Inaccessible primary flow | The main journey fails for keyboard, focus, form-label, or contrast reasons. | ACC-01, ACC-03, ACC-08 |
| G4 | Invented proof or misrepresentation | Proof presented as fact is invented, or the interface misrepresents what the site does. | J-20 |
| G5 | Broken mobile layout | On phones the page overflows sideways, text overlaps or is clipped, or the primary call to action is pushed off the first screen. | RES-01, RES-02, RES-03, RES-04, J-06, J-15 |
| G6 | Failed font check | A chosen font did not load, or headings are drawn in a weight the font does not ship (faked bold). | TYP-07, TYP-09 |
| G7 | Generic or assembled look | The site could belong to any organization, or its pages look assembled from unrelated templates. | J-08 |

## Message & Persuasion

_Will visitors understand it, trust it, and act?_

### FI — First impression & clarity

_In the first five seconds, before scrolling, can a visitor tell what this is, who it is for, why to trust it, and what to do next?_

| ID | Check | Detection | Severity | Gate | Effort | Trigger |
|---|---|---|---|---|---|---|
| J-02 | No dominant primary call to action | judgment | major | G1: Gate G1 always. | S | FAIL only if the desktop or mobile fold screenshot has no visually primary action (a filled, high-contrast button), or several actions have equal visual weight so no primary is distinguishable. Applies to: Landing, home, and marketing pages whose job is to move a visitor to act. Mark n/a for pages whose main content is a form (the visitor already chose to act, and the form is the next step; see J-25) and for pages with no single primary action. PASS example: Exactly one filled, accent-colored button stands out, and any secondary actions are visibly quieter (outline or text style). FAIL example: Two filled accent buttons ('Learn more' and 'Sign up') sit side by side with equal weight. |
| J-14 | Fails the five-second test | judgment | major | G1: Gate G1 always. | M | FAIL only if, from the desktop or mobile first-screen screenshot alone, you cannot write down at least three of: what the site offers, who it is for, why to trust it, and what to do next. PASS example: Headline plus one supporting line state the offering and audience, and a visible button says what to do next. FAIL example: A large 'Welcome to our site' over a stock photo, with no description and no button on the first screen. |
| J-15 | Primary action not visible on the mobile first screen | judgment | major | G5: Gate G5 always. | M | FAIL only if the page's primary call to action is visible on the desktop first screen but not on the mobile first screen. Applies to: Landing, home, and marketing pages with a primary call to action. Mark n/a for pages whose main content is a form (their submit button belongs after the fields; see J-25) and for pages without a primary call to action. PASS example: On the mobile first screen the headline and the primary button are both visible without scrolling. FAIL example: On mobile a 600px-tall hero image pushes the headline and button below the fold. |

### AH — Attention & hierarchy

_Is there one obvious focal point per screen, and a clear reading order created by size, weight, and color?_

| ID | Check | Detection | Severity | Gate | Effort | Trigger |
|---|---|---|---|---|---|---|
| TYP-01 | Page has no H1, or more than one | auto | major |  | S | The page has no visible h1 (major), or more than one visible h1 (minor, variant=multiple). |
| TYP-02 | Weak typographic scale | auto | major (minor when the ratio is between 1.6 and 2.0.) |  | S | At the desktop viewport, h1 font size divided by body text size is below 1.6. |
| J-01 | No clear focal point in the first viewport | judgment | major | G2: Gate G2 always. | M | FAIL only if, in the desktop fold screenshot, you cannot name a single dominant element (headline or hero) within 2 seconds: several elements compete at similar size and weight, or the headline is visually weaker than secondary content. PASS example: One headline is clearly the largest, highest-contrast text, and the eye lands on it first. FAIL example: The hero has a large headline, an equally large rotating banner, and three bright buttons of the same size. |

### NF — Narrative & page flow

_Does each page tell a story in a sensible order, with each section earning the next scroll and a strong ending?_

| ID | Check | Detection | Severity | Gate | Effort | Trigger |
|---|---|---|---|---|---|---|
| J-16 | Sections are in an illogical order | judgment | minor |  | M | FAIL only if, in the desktop full-page screenshot, the section order clearly breaks the visitor's logic, for example proof or pricing before the offering is explained, or a form in the middle of unrelated content. Applies to: Pages with three or more content sections. Mark n/a otherwise. PASS example: Sections build an argument: what it is, why it matters, proof, how it works, then a call to act. FAIL example: Testimonials appear before the page has said what is offered, and the contact form sits between two feature sections. |
| J-17 | Page ends without a next step | judgment | minor |  | S | FAIL only if the desktop full-page screenshot ends with no closing call to action or next step before the footer. Applies to: Marketing, landing, and content pages. Mark n/a for tools, dashboards, and forms. PASS example: The last section before the footer repeats the primary action or points to the next logical page. FAIL example: The page ends with a feature grid and then the footer; there is nothing to click. |

### CV — Copy & value communication

_Is the text real, specific, outcome-led, and consistent (including call-to-action labels), with no placeholder or leftover content?_

| ID | Check | Detection | Severity | Gate | Effort | Trigger |
|---|---|---|---|---|---|---|
| CON-01 | Placeholder or garbage text visible | auto | major |  | S | Visible text or the title contains lorem ipsum, undefined, NaN, null, [object Object], unrendered template syntax ({{ }}, ${ }), or __UPPER_CASE__ tokens. |
| CON-02 | Scaffold or template leftovers | auto | major |  | S | Visible text or the title contains known scaffold strings (create-site placeholder screens such as "Waiting for your input" or "Initializing...", framework defaults such as "Vite + React" or "React App", or generic text such as "Your Company" or "Welcome to your site"). |
| J-11 | Copy quality problems | judgment | minor |  | S | FAIL only for visible copy defects: obvious typos, the same blurb repeated across cards, sentences cut off mid-way, or filler marketing text that says nothing specific about the organization. PASS example: Copy is specific to the site's purpose, varied, and error-free. FAIL example: All three feature cards say 'We deliver high-quality solutions tailored to your needs.' |
| J-18 | Inconsistent call-to-action labels | judgment | minor |  | S | FAIL only if the same destination or action is labeled differently across buttons or pages (for example 'Get started', 'Sign up now', and 'Join' all going to the same form). PASS example: Each action has one label used everywhere it appears. FAIL example: The hero says 'Book a session', the header says 'Register', and the footer says 'Get started', all opening the same booking form. |

### TP — Trust & proof

_Does the site give honest, relevant reasons to believe it, placed where visitors would doubt?_

| ID | Check | Detection | Severity | Gate | Effort | Trigger |
|---|---|---|---|---|---|---|
| IMG-04 | Placeholder image services | auto | major |  | S | An image is served from a placeholder service (placehold.co, via.placeholder.com, picsum.photos, dummyimage.com, placekitten.com, fakeimg.pl, loremflickr.com, placeimg.com). |
| J-19 | No proof where visitors hesitate | judgment | minor |  | M | FAIL only if the page asks for a commitment but shows no supporting proof (testimonial, rating, member or customer count, logos, credentials, real photos) anywhere near the primary action or the form. Applies to: Pages that ask the visitor to commit (sign up, buy, contact, apply). Mark n/a otherwise. PASS example: Relevant proof sits next to, or just before, the primary action or form. FAIL example: A sign-up form with no testimonial, rating, or indication of who else uses the service. |
| J-20 | Proof looks invented, or the interface misrepresents the site | judgment | major | G4: Gate G4 always. | S | FAIL only if proof is presented as fact but is clearly generic or fabricated (for example 'Great service! - John D.', '10,000+ happy customers' on a brand-new site, fake partner logos), or the interface promises something the site does not do (a 'Live chat' button that does nothing). PASS example: Every claim is specific and plausible for this organization, and every control does what it says. FAIL example: Three testimonials with stock headshots and first-name-only quotes like 'Amazing!', on a site launched this week. |

## Usability & Accessibility

_Can everyone use it easily, on any device?_

### UX — Cognitive fluency & usability

_Is the site effortless to use: simple navigation and forms, working links, no errors, and fast, stable loading?_

| ID | Check | Detection | Severity | Gate | Effort | Trigger |
|---|---|---|---|---|---|---|
| INT-02 | Dead links | auto | minor (major when the dead link is inside the header or navigation.) |  | S | A visible link has an empty href, href="#", or a javascript: URL. |
| INT-03 | JavaScript errors at runtime | auto | major |  | M | An uncaught exception or console.error occurs while the page loads. |
| INT-04 | Failed resource requests | auto | major |  | S | A stylesheet, script, font, or data request returns HTTP 400 or higher or fails to load (images are covered by IMG-01). |
| IMG-05 | Oversized image files | auto | minor |  | S | An image rendered at least 50px wide has a natural width more than 4× its largest rendered width (more than 2× even on a 2× display). |
| PRF-01 | Layout shifts during load | auto | minor (major when CLS is above 0.25.) |  | M | Cumulative Layout Shift (no recent input) is above 0.1. |
| PRF-02 | Web fonts block text rendering | auto | minor |  | S | A Google Fonts stylesheet without display=swap/optional/fallback, or an @font-face with font-display auto or block. |
| PRF-03 | Heavy page weight | auto | minor |  | M | Images, fonts, stylesheets, and documents downloaded by the page exceed 4 MB in total. Scripts are excluded so dev-server builds are not penalized. |
| J-13 | Navigation gives no sense of place | judgment | minor |  | S | FAIL only if the navigation does not indicate the current page, or the navigation items or order differ between pages. Applies to: Sites with two or more routes. Mark n/a for single-page sites. PASS example: The current page is highlighted (for example aria-current with a visual style), and the navigation is identical on every page. FAIL example: The navigation does not highlight the current page, and the About page shows a different menu order. |
| J-21 | Navigation or forms demand unnecessary effort | judgment | minor |  | M | FAIL only for a visible usability burden: more than about 7 top-level navigation items, vague navigation labels ('Solutions', 'Resources Hub'), forms asking for clearly unnecessary information, or error messages that do not say how to fix the input. PASS example: A short navigation with plain labels, forms that ask only what is needed, and errors that explain the fix. FAIL example: A 12-item top menu and a contact form that requires a fax number. |
| J-25 | Form's main action is unclear or misplaced | judgment | minor |  | S | FAIL only if, in the full-page screenshots, the page heading does not say what the form is for; or the submit button is not styled as the single primary action (a filled, high-contrast button); or it is not placed directly after the fields it submits; or several buttons at the end of the form look equally important. A submit button below the first screen is not a failure. Applies to: Pages whose main content is a form (submit a case, contact, apply, sign up). Mark n/a otherwise. PASS example: The heading names the task, the fields follow in order, and one filled accent button directly after the last field submits the form, with any cancel or back action visibly quieter. FAIL example: A 'Submit' outline button and a 'Cancel' filled button sit side by side under the form, so the destructive action looks primary. |

### RA — Responsive & accessible design

_Does it work on every screen size and for people with disabilities (WCAG 2.2 AA: contrast, keyboard, focus, labels, zoom, reduced motion)?_

| ID | Check | Detection | Severity | Gate | Effort | Trigger |
|---|---|---|---|---|---|---|
| ACC-01 | Text contrast below WCAG AA | auto | major | G3: Gate G3 when any failing text is below 2.5:1. | S | axe rule color-contrast reports at least one node. |
| ACC-02 | Images or icons without a text alternative | auto | major |  | S | axe rules image-alt, role-img-alt, svg-img-alt, input-image-alt, area-alt, or object-alt report at least one node. |
| ACC-03 | Form controls without labels | auto | major | G3: Gate G3 always: unlabeled form fields break the primary flow for screen-reader users. | S | axe rules label, select-name, aria-input-field-name, aria-toggle-field-name, or label-title-only report at least one node. |
| ACC-04 | Links or buttons without an accessible name | auto | major |  | S | axe rules link-name, button-name, or aria-command-name report at least one node. |
| ACC-05 | Heading levels skipped or empty | auto | minor |  | S | axe rules heading-order or empty-heading report at least one node. |
| ACC-06 | Missing or misused landmarks | auto | minor |  | M | axe rules region, landmark-one-main, landmark-no-duplicate-main, landmark-unique, landmark-banner-is-top-level, landmark-contentinfo-is-top-level, landmark-main-is-top-level, or landmark-complementary-is-top-level report at least one node. |
| ACC-07 | Document language or title missing | auto | major |  | S | axe rules html-has-lang, html-lang-valid, valid-lang, or document-title report a violation. |
| ACC-08 | Keyboard focus is not visible | auto | major | G3: Gate G3 always: keyboard users cannot see where they are. | S | At least one of the first 20 keyboard tab stops shows no visible change (outline, box-shadow, border, background, color, underline, or transform) when focused. |
| ACC-09 | Animations ignore prefers-reduced-motion | auto | minor (major when at least one of those animations loops infinitely.) |  | S | With prefers-reduced-motion: reduce emulated, at least one element still has a CSS animation longer than 10ms, or a script-driven Web Animation is still running. |
| ACC-10 | Touch targets too small | auto | minor (major when 5 or more targets fail.) |  | S | axe rule target-size reports at least one node (targets smaller than 24×24 CSS px without sufficient spacing). |
| ACC-11 | Other WCAG violations | auto | major (major when any of those rules has axe impact critical or serious; otherwise minor.) |  | M | Any other WCAG 2.2 A/AA axe rule reports a violation. All such rules form one issue, listed rule by rule as instances. |
| ACC-12 | Pinch-zoom disabled | auto | major |  | S | axe rule meta-viewport reports a violation (user-scalable=no or maximum-scale below 2). |
| RES-01 | Horizontal scrolling on narrow screens | auto | major | G5: Gate G5 when it happens at the mobile width. | M | At a mobile (390px) or tablet width, the page is wider than the screen, so it scrolls sideways. |
| RES-02 | Missing responsive viewport meta tag | auto | major | G5: Gate G5 always: without it phones render a shrunken desktop page. | S | No <meta name="viewport"> containing width=device-width. |
| RES-03 | Text elements overlap | auto | major | G5: Gate G5 when it happens at the mobile width. | M | Two visible, unrelated text elements overlap by at least 30% of the smaller element's area (at least 50px²) at any viewport. Elements under 0.5 opacity or aria-hidden are ignored. |
| RES-04 | Text clipped by its container | auto | minor (major when it happens at the mobile width.) | G5: Gate G5 (and major) when it happens at the mobile width. | S | A text element with overflow: hidden has content larger than its box, and no intentional truncation (text-overflow: ellipsis or line-clamp) is set. |
| RES-05 | Body text too small on mobile | auto | major |  | S | At the mobile viewport, at least one paragraph-like text block (at least 40 characters) is rendered below 14px. |
| RES-06 | Fixed header takes too much of the mobile screen | auto | major |  | S | At the mobile viewport, a fixed or sticky full-width element at the top of the screen is taller than 20% of the viewport height. |
| TYP-03 | Body text below 16px on desktop | auto | minor |  | S | At the desktop viewport, the dominant paragraph text size is below 16px. |
| J-06 | Mobile layout visibly broken | judgment | major | G5: Gate G5 always. | M | FAIL only for concrete breakage in the mobile screenshots that auto checks did not already report: content cut off or pushed off-screen; text or elements overlapping; columns so narrow that words break mid-word or run one or two characters per line; the page headline missing from the first mobile screen because of the stacking order; or a navigation that cannot be opened or used. Cramped but readable layouts (cards side by side whose labels wrap, table values that wrap onto two lines, a less-than-ideal section order) are not breakage; judge them with J-26. When in doubt, pass. PASS example: Every element is fully visible and readable without overlap, the headline is on the first mobile screen, and the navigation works, even if some parts look cramped. FAIL example: On mobile, a pricing table's right two columns are cut off at the screen edge, and the price text overlaps the button below it. Not counted on a page where RES-01, RES-03, RES-04 is confirmed. |
| J-12 | Text over imagery is hard to read | judgment | major |  | S | FAIL only if text placed over a photo, video, or busy gradient is visibly hard to read in some area (axe cannot measure contrast over images). PASS example: Overlay text sits on a scrim, solid panel, or calm image area and reads clearly. FAIL example: White body text sits directly on a bright, busy photo with no overlay. |
| J-26 | Cramped or awkwardly ordered mobile layout | judgment | minor |  | S | FAIL only if, in the mobile screenshots, content is readable but visibly cramped or out of order: cards or stats stay side by side so short labels wrap one word per line or their values misalign; short table values (dates, scores, amounts) break across lines; or the page's key summary or outcome appears only after long secondary content such as a message thread. Pass when J-06 already fails for the same element on the same page. PASS example: On mobile, cards and stats collapse to one or two comfortable columns, short table values stay on one line or rows stack as labeled blocks, and the key summary comes before secondary detail. FAIL example: On mobile, three summary cards stay side by side at about 115px wide, so 'Recorded assessments' wraps one word per line, and the scores in the grades table break onto two lines. |

### IM — Interaction & motion craft

_Do interactive elements respond with designed states (hover, focus, loading, empty, error), and does motion help rather than distract?_

| ID | Check | Detection | Severity | Gate | Effort | Trigger |
|---|---|---|---|---|---|---|
| INT-01 | Buttons show no hover feedback | auto | minor |  | S | At the desktop viewport, at least half of the sampled buttons and button-styled links (up to 8) show no visual change on hover. The link for the current page (aria-current or an active class) and skip links or other controls kept off-screen until focused are not sampled. |
| AES-04 | No motion or micro-interaction at all | auto | minor |  | S | No element defines a CSS transition or animation with non-zero duration. |
| J-22 | Data views lack loading, empty, or error states | judgment | minor |  | M | FAIL only if a data-driven view shows a blank area, a raw error, or nothing at all instead of a designed loading, empty, or error state (from the screenshots, or from the source when available). Applies to: Pages that show data loaded at runtime (lists, tables, dashboards, search). Mark n/a otherwise. PASS example: Loading shows a skeleton or spinner, empty lists show a helpful message and an action, and errors explain what to do. FAIL example: An events page shows a white gap where the list should be when there are no events. |
| J-24 | Motion distracts from reading | judgment | minor |  | S | FAIL only if motion visibly competes with content: constantly looping or bouncing elements, auto-advancing carousels, or reveal animations that hide content until it is scrolled past (visible as blank areas in the full-page screenshot). PASS example: Motion is brief and purposeful (an entrance, a hover, a state change) and content is readable at all times. FAIL example: Hero text cycles every two seconds and feature cards stay invisible in the full-page screenshot because they only fade in on scroll. |

## Visual Craft & Brand

_Does it look deliberate, cohesive, polished, and specific to this organization?_

### BC — Brand & visual coherence

_Do fonts, colors, shapes, icons, imagery, and motion form one system that feels specific to this organization?_

| ID | Check | Detection | Severity | Gate | Effort | Trigger |
|---|---|---|---|---|---|---|
| TYP-06 | Too many font families | auto | minor |  | S | More than 3 distinct primary font families render visible text. |
| TYP-07 | Declared web font did not load | auto | major | G6: Gate G6 always. | S | A font face fails to load, or visible text declares a non-system primary family that is not available, so text silently falls back. |
| TYP-08 | Font-size sprawl | auto | minor |  | M | At the desktop viewport, more than 10 distinct font sizes render visible text. |
| CLR-01 | Color palette sprawl | auto | minor |  | M | More than 10 visually distinct chromatic colors (saturation 0.15 or higher, perceptually clustered) are used for text, backgrounds, or borders. |
| CLR-02 | No color design tokens | auto | minor |  | M | No CSS custom properties with color values are defined on :root or html, and no utility-class color system is in use (fewer than 10 classes such as bg-blue-500). |
| LAY-02 | Inconsistent corner radii | auto | minor |  | S | More than 6 distinct non-zero border-radius values are used (999px+ pill values count as one). |
| LAY-03 | Inconsistent shadows | auto | minor |  | S | More than 6 distinct box-shadow values are used. |
| AES-01 | Default or overused typefaces | auto | minor (major when both the heading and body fonts are on the list (no typographic choice was made).) |  | S | The primary heading or body font is one of Inter, Roboto, Open Sans, Lato, Arial, Helvetica, Segoe UI, system-ui, or a generic family. |
| AES-02 | Cliché purple gradient on white | auto | minor |  | S | A gradient covering at least 15% of the first viewport uses two or more purple/violet stops (hue 245–295°, saturation 0.3 or higher) on a near-white page background. |
| AES-03 | Flat, atmosphere-free backgrounds | auto | minor |  | M | At the desktop viewport, every large section (200px or taller) shares one solid background color and no element uses a background image or gradient. |
| J-05 | Same component styled inconsistently | judgment | major |  | M | FAIL only if components that play the same role look different without a reason: buttons of the same priority with different shapes, sizes, or colors, or cards in the same list with different padding, radius, or heading styles. PASS example: Every button of a given priority, and every card in a set, is visually identical apart from content. FAIL example: Primary buttons are rounded on Home but square on Contact; cards in one grid have different padding. |
| J-08 | Generic template look | judgment | major | G7: Gate G7 always. | L | FAIL only if the page is the stock pattern (centered hero with a gradient, a row of 3–4 identical icon cards, a CTA band, then the footer) and has NO distinctive element: no custom layout, imagery, typographic moment, or brand motif. PASS example: At least one deliberate, memorable design move (an editorial layout, a strong typographic treatment, custom illustration, or a distinctive color story). FAIL example: Centered gradient hero, a row of three icon cards, a CTA band, then the footer, with stock icons and no brand imagery. |
| J-09 | Accent color not reserved for emphasis | judgment | minor |  | S | FAIL only if the accent or CTA color is used on so many non-interactive elements that actions no longer stand out, or several saturated colors compete with no clear accent. PASS example: One accent color marks actions and key highlights, and the rest of the palette is quieter. FAIL example: The accent orange is used for headings, borders, icons, and backgrounds, so the orange button no longer stands out. |
| J-10 | Mixed visual language | judgment | minor |  | M | FAIL only if styles visibly clash: mixed icon sets (outline mixed with filled, or emoji used as UI icons), playful rounded elements next to sharp corporate ones, or illustrations in conflicting styles. PASS example: Icons, corners, illustrations, and imagery feel like one family. FAIL example: Outline icons in the header, filled icons in the features, and emoji used as bullet icons in the footer. |
| TYP-09 | Headings drawn in a faked weight | auto | major | G6: Gate G6 always. | S | A visible heading is rendered at a font weight its loaded font family does not include, so the browser synthesizes (fakes) the bold. |

### DF — Detail & memorable finish

_Are alignment, spacing, crops, and small details refined, and does the site have a memorable signature moment?_

| ID | Check | Detection | Severity | Gate | Effort | Trigger |
|---|---|---|---|---|---|---|
| TYP-04 | Cramped or loose line height | auto | major |  | S | Multi-line paragraph text (at least 80 characters and 2 or more rendered lines, excluding headings and navigation) with line-height/font-size below 1.3 (major) or above 2.0 (minor, variant=loose). |
| TYP-05 | Lines too long to read comfortably | auto | minor |  | S | At the desktop viewport, a paragraph of at least 150 characters wraps onto 2 or more lines at more than about 90 characters per line. |
| LAY-01 | Spacing does not follow a scale | auto | minor |  | M | At the desktop viewport, more than 30% of distinct margin/padding/gap values up to 160px are not multiples of 4px, or more than 24 distinct values are used. Larger values are treated as layout, not spacing. |
| CON-03 | Missing meta description or favicon | auto | minor |  | S | No non-empty <meta name="description">, or no <link rel="icon">. |
| CON-04 | Empty visible section | auto | minor |  | S | A visible section or main-level block at least 200px tall contains no text, media, or background image. |
| IMG-01 | Broken images | auto | major |  | S | A visible <img> finished loading with naturalWidth 0, or its request failed. |
| IMG-02 | Distorted (stretched or squashed) images | auto | major |  | S | A visible image uses object-fit: fill and its rendered aspect ratio differs from its natural aspect ratio by more than 5%. |
| IMG-03 | Upscaled, blurry images | auto | major |  | S | A visible image at least 150px wide is rendered wider than its natural pixel width. |
| J-03 | Misaligned content edges | judgment | minor |  | M | FAIL only if, in the desktop full-page screenshot, section content visibly starts at different left edges or container widths with no apparent intent (for example one section is flush-left while the others are inset). PASS example: Content snaps to a consistent container and grid. Intentional full-bleed sections are fine. FAIL example: The features section is flush to the left edge while every other section is inset in a centered container. |
| J-04 | Inconsistent vertical rhythm | judgment | minor |  | S | FAIL only if, in the full-page screenshot, the space between sections or between a heading and its content is visibly inconsistent (for example one section is cramped while the others breathe, or there is a large accidental gap). PASS example: Sections have consistent padding, and heading-to-content spacing repeats predictably. FAIL example: One section has 24px of padding and the next has 160px, with no visual reason. |
| J-07 | Imagery mismatched or poorly cropped | judgment | minor |  | S | FAIL only if an image clearly does not relate to the adjacent content, or its crop cuts off the important subject (for example faces or product). PASS example: Images support the message and their subjects are framed well. FAIL example: A photo of a laptop illustrates a rowing club's 'Our boats' section; a portrait is cropped through the eyes. |
| J-23 | No memorable signature moment | judgment | minor |  | L | FAIL only if, across the full-page screenshots, there is no single distinctive design moment: no striking typographic treatment, custom illustration, brand pattern, notable photography, or unusual layout that a visitor would remember. PASS example: At least one deliberate, memorable element that is specific to this organization. FAIL example: Every section is a centered heading over a three-card grid; nothing stands out. |
