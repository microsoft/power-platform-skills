## Phase 3: Component Planning

**Goal**: Determine what pages, components, and design elements the site needs — while the user previews the running scaffold

<!-- gate: create-site:3.requirements | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:3.requirements):** Four sub-prompts (features multi-select, aesthetic, mood, brand) plus a brand follow-up when the user has brand inputs - shape the Phase 4 plan and the Phase 5 implementation. Fires at step 2 of the action list below.
>
> **Trigger:** Phase 3 entry; scaffold loader is up.
> **Why we ask:** Wrong feature set / aesthetic / brand gets baked into the rendered plan - the Phase 4.7 gate would still catch most errors, but it's wasteful to defer the catch.
> **Cancel leaves:** Nothing — scaffold loader files are throwaway artifacts replaced wholesale in Phase 5.

**Actions**:

1. **Raise the "awaiting input" banner** so the user notices the terminal prompt even while the browser loader is full-screen. Write `<PROJECT_ROOT>/public/scaffold-status.json`:

   ```json
   { "message": "Planning your site", "awaitingInput": true, "inputPrompt": "Features, aesthetic, mood, and brand - please answer in the terminal." }
   ```

   Immediately after the user answers (including any brand follow-up), update the same file with `"awaitingInput": false` so the banner disappears.

2. Collect feature and design requirements.

   Ask the user:

   | Question | Header | Options |
   |----------|--------|---------|
   | Which features? (multi-select) | Features | *(generate 3-4 context-aware options based on the site name, purpose, and audience from Phase 1)* |
   | What aesthetic direction do you want? | Aesthetic | Minimal & Clean (Recommended), Bold & Vibrant, Dark & Moody, Warm & Organic |
   | What's the overall mood? | Mood | Professional & Trustworthy (Recommended), Creative & Playful, Technical & Precise, Elegant & Premium |
   | Is there an existing brand the site should match? | Brand | No, create a fresh identity (Recommended), Match my existing website, Use my brand colors or logo |

   **Brand follow-up.** Record the answer as `BRAND_SOURCE` (`fresh`, `website`, or `assets`). For **Match my existing website**, ask the user to ask for the URL (free text - use a single generic option so the user types it via "Other"); accept only an `http://` or `https://` URL and ask again otherwise. For **Use my brand colors or logo**, ask the same way for the hex colors and/or the absolute path of a logo file. On the template customization path, skip this sub-prompt (see Phase 1.5 step 20).

   > **Feature options are NOT hardcoded.** Infer relevant features from Phase 1 answers. For example:
   > - "HR Dashboard" + Internal → Employee Directory, Leave Requests, Announcements, Org Chart
   > - "Contoso Portal" + External → Contact Form, Service Catalog, Knowledge Base, FAQ
   > - "Partner Hub" + Internal → Document Library, Partner Directory, Deal Tracker, Notifications
   >
   > Always generate options that make sense for the specific site — never reuse a fixed list.
   >
   > **If you include an Authentication feature option**, describe it generically as "Login/signup for tracking application status" or similar. Do NOT mention a specific identity provider (e.g., "Entra ID", "SAML", "Google") in the feature description — the `/power-pages:setup-auth` skill will ask the user which provider they want.

3. **AI Component Planning** - Based on Phase 1 answers and the feature selection, propose relevant Power Pages generative-AI summarization APIs.
   The site ships with reserved slots and runs without AI; `/add-ai-webapi` populates them later.
   Ask the user:

   | Question | Header | Options |
   |----------|--------|---------|
   | Which AI summarization features should the site have? (multi-select — each can be added later with `/add-ai-webapi`) | AI Summaries | *(generate 2-4 context-aware options plus "None for now")* |

   > **Options are NOT hardcoded.** Infer relevant AI summary features from Phase 1 and the features picked above. Examples:
   > - "HR Dashboard" + Leave Requests feature → "Data summarization for leave requests", "Search summary on the knowledge base"
   > - "Contoso Portal" + Knowledge Base → "Search summary on site-wide search", "Data summarization for articles"
   > - "Customer Self-Service" + Support Cases / Incidents → "Data summarization for support cases (Microsoft-shipped recipe)", "Data summarization for attached knowledge articles"
   >
   > Treat the standard `incident` table like any other Dataverse table — propose Data
   > Summarization for it when the site handles support cases, but don't force the Microsoft-shipped
   > recipe (`$select=description,title` + the portal-comments expand) unless that genuinely fits
   > the user's UX. A custom case-like table or a different facet of the standard incident is a
   > regular Data Summarization pick. Always include **None for now** so the user can defer. Do
   > NOT integrate the APIs in this skill — only record the user's picks so Phase 4's plan can
   > mention them and Phase 8 can suggest `/add-ai-webapi` as a recommended next step.
   >
   > Capture the selection in memory as `AI_SUMMARY_PICKS` — a list of one or more of: `search-summary`, `data-summarization`.

4. **Map picks to target pages.** For each entry in `AI_SUMMARY_PICKS`, decide which page will carry the AI surface and store the mapping as `AI_SUMMARY_PLACEMENTS`. This is what Phase 4 shows the user and what Phase 5 reserves slots for. Use the feature selection from step 2 — and treat this mapping as an *input* to the page list the agent proposes in step 7: if a pick has no natural target page, add one to the plan so the summary has a home:

   | Pick | Default target page | If no matching page is planned |
   |------|--------------------|-------------------------------|
   | `search-summary` | A search / search-results page (e.g., `SearchResults`, `Search`) | Add a search page to the plan so the summary has a home |
   | `data-summarization` | The detail page of the table the user called out (e.g., `ProductDetail` for products, `CaseDetail` for support cases) — ask the user if ambiguous | Propose adding a detail page; if rejected, fall back to a list/dashboard page |

   `AI_SUMMARY_PLACEMENTS` shape: one record per placement, e.g.
   `[{ pick: "data-summarization", targetPage: "CaseDetail", marker: "POWERPAGES:AI-SLOT kind=data-summarization" }]`.

   The `marker` string is the comment tag Phase 5 emits into the page source as a reserved anchor that `/add-ai-webapi` later finds. Keep the shape uniform — one marker per placement, always the same tag, so the follow-up skill's explore step can grep for them deterministically.

5. Read the design references: `${PLUGIN_ROOT}/references/design-aesthetics.md`, `${PLUGIN_ROOT}/references/page-blueprints.md`, and `${PLUGIN_ROOT}/references/bidirectional-design.md`.
6. **Write the experience brief** (design-aesthetics.md section 1) - audience and job, primary and secondary action, principal doubt, proof strategy, design thesis, hero concept, and signature moment. Resolve the brand source first (section 2): for `website`, extract the brand from the URL with the Playwright snippet there; for `assets`, build the palette around the supplied colors; for `fresh`, start from the matching cell of the aesthetic x mood map (section 11). Record the display and body fonts, color direction, geometry, and motion direction. Font choices must support the complete writing system used by `SITE_LOCALE`; verify glyph coverage and shaping rather than selecting a Latin-only font solely because it matches the aesthetic, and use a compatible script-aware fallback stack.
7. Analyze requirements and determine needed components. Plan each page's content as narrative beats from `page-blueprints.md`, in order, one line per section with its purpose. If `AI_SUMMARY_PLACEMENTS` from step 4 implies a page that wasn't already in the plan (e.g., a `CaseDetail` page for a data-summarization pick on the support-case table), add it to the page list now. Present the component plan to the user as a table:

   ```
   | Component Type      | Count | Details |
   |---------------------|-------|---------|
   | Pages               | 4     | Home, About, Services, Contact |
   | Shared Components   | 3     | Navbar, Footer, ContactForm |
   | Design Elements     | 5     | Schibsted Grotesk + Public Sans, 15 color tokens, product-moment hero, status-timeline signature moment, paper-grain backgrounds |
   | Routes              | 4     | /, /about, /services, /contact |
   ```

   Build `BIDIRECTIONAL_REVIEW_DATA` for every planned visible or interactive
   component, including page-local controls that are not shared source
   components. Classify each entry as `direction-neutral`, `direction-aware`,
   `direction-fixed`, or `unknown-third-party` using the shared bidirectional
   standard. Record the localized reason, applicable states, applicable
   `desktop`/`narrow` viewports, and planned checks. Treat anything involving
   inline placement, text direction, horizontal movement, sequence,
   directional meaning, mixed-script content, or rendering outside the normal
   component subtree as a potential bidirectional surface.

   This is the expected review scope, not a project manifest. Phase 5 must
   reconcile it against the actual source and rendered application, adding
   components or states discovered during implementation. Do not write a
   separate component-inventory JSON file.

8. Choose the final color tokens - every color role in design-aesthetics.md section 3 - from the brief and brand source. Check each text and background pair against WCAG AA now, before the values reach the plan. These are written fresh into a new `theme.css` during Implementation (Phase 5) when the scaffold loading screen is completely replaced.

**Output**: Confirmed list of pages (with narrative beats), components, design elements, and routes to create, plus the experience brief and color tokens

---
