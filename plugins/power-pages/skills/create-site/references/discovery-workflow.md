## Phase 1: Discovery

**Goal**: Understand what site needs to be built and what problem it solves

**Actions**:

<!-- gate: create-site:1.purpose | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:1.purpose):** Path-agnostic discovery prompt collecting site name, purpose, and audience. Determines what kind of site the user needs before the skill decides between a template-backed path and the from-scratch scaffold path. Fires only on the "site purpose unclear" branch (step 3 below).
>
> **Trigger:** Phase 1 when site name, purpose, or audience was not provided in the user's current request.
> **Why we ask:** Wrong purpose/audience context → wrong branch decision and wrong generated site plan; cleanup is annoying.
> **Cancel leaves:** Nothing — no scaffolding has started yet.

1. Create the minimal upfront todo list (see the entry-linked progress-tracking contract):
   - Discover site requirements
   - Select template or choose from-scratch
2. If site name, purpose, and audience are clear from arguments:
   - Summarize understanding
   - Identify site type (portal, dashboard, landing page, blog, etc.)
3. If site name, purpose, or audience is unclear:

   Ask the user:

   | Question | Header | Options |
   |----------|--------|---------|
   | What should the site be called? (e.g., "Contoso Portal", "HR Dashboard") | Site Name | Free text |
   | What is the site's purpose? | Purpose | Company Portal, Blog/Content, Dashboard, Landing Page |
   | Who is the target audience? | Audience | Internal (employees, partners), External (public-facing customers) |

4. From the user's answers, derive:
   - `__SITE_NAME__` (Title Case, e.g., `Contoso Portal`)
   - A preliminary `__SITE_SLUG__` (lowercase ASCII kebab-case derived from
     the site name when possible)
5. Summarize the path-agnostic understanding and confirm with user before proceeding:
   - Site name
   - Site purpose/type
   - Target audience

   Do **not** ask for framework or project location in Phase 1. Each creation path asks for its location after Phase 1.5 selects that path.

**Audience influences site generation:**

- **Internal**: Prioritize task completion - status, the next action, data tables, dashboards, authentication, navigation depth. The wow comes from clarity, density done right, and polish in the details rather than marketing heroes.
- **External**: Prioritize a striking first impression, a persuasive page narrative with proof at the point of doubt, SEO-friendly structure, and contact forms.

**Output**: Clear statement of site purpose, audience, site name, and preliminary technical slug.

---
