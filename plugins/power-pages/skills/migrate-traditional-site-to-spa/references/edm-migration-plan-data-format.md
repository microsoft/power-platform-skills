# EDM Migration Plan Data Format

This document defines the JSON data structure required to render `edm-migration-plan.html` via `render-edm-migration-plan.js`.

## Contents

- [Usage](#usage)
- [Required Keys](#required-keys)
- [Example Complete JSON](#example-complete-json)
- [Best Practices](#best-practices)
- [Error Handling](#error-handling)

## Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-edm-migration-plan.js" \
  --output "<PROJECT_ROOT>/docs/edm-migration-plan.html" \
  --data "<PROJECT_ROOT>/edm-migration-plan-data.json"
```

The render script:
- Reads the JSON data file
- Validates all required keys are present
- Injects data into the HTML template
- Outputs the final HTML file
- **Refuses to overwrite** existing output files (you must choose a new name or delete the old file)

---

## Required Keys

All of the following keys must be present in the JSON object. If any are missing, the render script will exit with an error.

### `SITE_NAME` (string, required)
The name of the EDM site being migrated.

**Example:** `"Customer Portal"`, `"Sales Hub"`

---

### `PLAN_TITLE` (string, required)
The title of the plan. Use: `"EDM Migration Plan"`

**Example:** `"EDM Migration Plan"`

---

### `SUMMARY` (string, required)
A one-paragraph human-readable summary of the migration scope, target framework, and overall strategy.

**Example:**
```
The Customer Portal is a classic EDM Power Pages site (6 pages, 2 entity lists, 3 entity forms) designed for customer support requests.
We will migrate it to a React SPA with Dataverse Web API integration. The site uses 2 custom web roles (Customer, Admin) and 3 main tables
(incident, contact, knowledge_article). All routes will use authenticated Web API calls backed by proper table permissions.
```

---

### `SITE_STATS` (object, required)
Pre-computed statistics about the migration scope.

**Schema:**
```json
{
  "routeCount": <number>,
  "componentCount": <number>,
  "tableCount": <number>,
  "manualGapCount": <number>
}
```

**Example:**
```json
{
  "routeCount": 8,
  "componentCount": 12,
  "tableCount": 3,
  "manualGapCount": 2
}
```

**Guidance:**
- Compute these counts from your `canonical-site-model.json` before rendering
- `routeCount`: unique SPA routes to be implemented
- `componentCount`: reusable/shared components across all routes
- `tableCount`: Dataverse tables with data dependencies
- `manualGapCount`: number of items in `GAPS_DATA`

---

### `ROUTES_DATA` (array of objects, required)
Array of SPA routes mapped from EDM pages and templates. Each route includes a typed component mapping that pairs the EDM artifact in use today with its SPA replacement.

**Schema per item:**
```json
{
  "path": "<route-path>",
  "sourcePages": [<array-of-edm-pages>],
  "componentMapping": [
    {
      "edm": "<EDM artifact description>",
      "targetKind": "component | content | webApi | serverLogic | staticAsset | manualGap",
      "target": "<SPA replacement name or hand-off label>"
    }
  ],
  "dataNeeds": [<array-of-api-or-service-names>],
  "rationale": "<one-to-two sentences on why this mapping was chosen>",
  "confidence": "<high|medium|low>"
}
```

**`targetKind` values:**

| Kind | Use it when… | Example `target` |
|------|---------------|-------------------|
| `component`  | The EDM artifact maps to a real SPA component or page section. | `IncidentList`, `Header`, `IncidentDetail` |
| `content`    | The EDM artifact maps to a content constant, snippet, or copy block (no logic). | `AnnouncementText`, `FaqIntroCopy` |
| `webApi`     | The EDM behavior is reproduced by a Dataverse Web API service the SPA can call directly with table permissions. | `incidentService.getById`, `contactService.list` |
| `serverLogic`| The EDM behavior depends on server-only context, privileged access, or server-evaluated business rules and must be migrated via `/add-server-logic`. | `getIncidentSummary`, `evaluateAccessRule` |
| `staticAsset`| The EDM artifact is a binary asset from `web-files/` (image, icon, document, font) that must be **reused** in the SPA. Use the asset's filename or `assetId` as the target. | `hero-banner.png`, `logo.svg`, `terms.pdf` |
| `manualGap`  | No automatic SPA replacement is possible; needs manual work. | `undocumented portal globals`, `legacy Liquid block` |

**Example:**
```json
[
  {
    "path": "/incidents",
    "sourcePages": ["List of Incidents"],
    "componentMapping": [
      { "edm": "Entity list 'Incidents'",                       "targetKind": "component",   "target": "IncidentList" },
      { "edm": "Custom JS sidecar (jQuery filters)",            "targetKind": "component",   "target": "FilterBar" },
      { "edm": "{% fetchxml %} for incident counts",            "targetKind": "serverLogic", "target": "getIncidentSummary" },
      { "edm": "/_api/incidents call inside Liquid",            "targetKind": "webApi",      "target": "incidentService.list" }
    ],
    "dataNeeds": ["Web API: GET /incidents", "Site setting: webapi/incident/fields"],
    "rationale": "EDM entity list + jQuery filter sidecar maps cleanly to a list page + filter component backed by `/integrate-webapi`. FetchXML aggregate moves to `/add-server-logic` because it depends on server-only context.",
    "confidence": "high"
  }
]
```

**Guidance:**

- `path`: URL-friendly route path (e.g., `/incidents`, `/incidents/:id`, `/admin/settings`).
- `sourcePages`: name(s) of EDM pages this route is derived from; can be empty array for new routes.
- `componentMapping`: list of `{ edm, targetKind, target }` pairs that show what each EDM artifact becomes in the SPA. Use this to make the EDM-to-SPA replacement visible to the user during review. Use the rules in `edm-to-spa-patterns.md` to assign `targetKind` — server-side Liquid that depends on server-only context, privileged access, or server-evaluated business rules must use `serverLogic` so it is handed off to `/add-server-logic` in Phase 7.3.
- `dataNeeds`: human-readable list of data services, API calls, or site settings this route requires.
- `rationale` (**required**): one or two sentences explaining *why* this mapping was chosen — which EDM evidence drove it, which Form Conversion Standard or pattern in `edm-to-spa-patterns.md` it follows, and any caveats. Keep it specific (cite the source artifact, the rule applied, or the runtime signal); avoid generic phrases like "standard mapping". Examples: *"Profile editor is `Edit` mode on `contact` scoped to the signed-in user → `client-form-update` per Form Conversion Standards; field set narrowed to what the EDM form exposed."* — *"Bot embed component reads `VITE_COPILOT_BOT_SCHEMA` from `.env`, value extracted from `botconsumer.yml#adx_botschemaname`."* The rendered Routes table surfaces this column so reviewers can challenge a mapping without re-reading the source.
- `confidence`: `high` (supported by static + runtime evidence), `medium` (one source), `low` (inferred/ambiguous). The rendered Routes table column header reads **"Migration Confidence"** so users understand the score reflects confidence in the EDM-to-SPA mapping, not data confidence.
  - **High-confidence items** are highlighted in green in the HTML.
  - **Medium-confidence items** are highlighted in yellow/warning color.
  - **Low-confidence items** are highlighted in red/alert color and flagged for user review.

---

### `DATAVERSE_DATA` (array of objects, required)
Array of Dataverse tables and operations required by the SPA. Optional `fields[]` and `relationships[]` drive the ER diagram in the Data Model tab of the rendered plan.

**Schema per item:**
```json
{
  "name": "<table-logical-name>",
  "source": "<edm-source-reference>",
  "operations": [<array-of-operations>],
  "siteSettings": [<array-of-site-setting-keys>],
  "followUpSkill": "<skill-name-or-empty>",
  "fields": [<array-of-strings-or-objects>],
  "relationships": [
    { "type": "<lookup|manytoone|onetomany|manytomany|onetoone>", "target": "<table-logical-name>", "field": "<field-name>", "label": "<human-readable-label>" }
  ]
}
```

**Example:**
```json
[
  {
    "name": "incident",
    "source": "Entity list on List of Incidents page",
    "operations": ["Read", "Create", "Update"],
    "siteSettings": ["webapi/incident/fields", "webapi/incident/iscreateenabled"],
    "followUpSkill": "/integrate-webapi or /create-webroles",
    "fields": ["incidentid", "title", "customerid", "createdon"],
    "relationships": [
      { "type": "lookup", "target": "contact", "field": "customerid", "label": "reported by" }
    ]
  },
  {
    "name": "contact",
    "source": "Lookup field in Incident entity form",
    "operations": ["Read"],
    "siteSettings": ["webapi/contact/fields"],
    "followUpSkill": "",
    "fields": ["contactid", "fullname", "emailaddress1"],
    "relationships": []
  }
]
```

**Guidance:**

- `name`: Dataverse table logical name (lowercase, e.g., `incident`, `contact`, `knowledgearticle`).
- `source`: Human description of where this table appears in the EDM (e.g., "Entity list on Home page", "Lookup field in Incident form").
- `operations`: List of operations the SPA will perform: `"Read"`, `"Create"`, `"Update"`, `"Delete"`.
- `siteSettings`: Array of site setting keys required for Web API access (e.g., `"webapi/incident/fields"`, `"webapi/incident/iscreateenabled"`).
- `followUpSkill`: Name of a Power Pages skill that will set up table permissions/Web API settings (e.g., `"/integrate-webapi"`, `"/create-webroles"`); leave empty if no follow-up is needed.
- `fields` (optional, recommended): list of field names captured from the EDM analysis. Strings or `{ name, type }` objects. Cap at the most important columns; the ER diagram limits the rendered list to keep the diagram readable.
- `relationships` (optional, recommended): each item is `{ type, target, field, label }`. `type` is one of `lookup`, `manytoone`, `onetomany`, `manytomany`, `onetoone` (the renderer also accepts the dashed forms `many-to-one`, `one-to-many`, `many-to-many`, `one-to-one`). `target` is the related table's logical name (must match a `name` in `DATAVERSE_DATA` to draw a connection). `field` is the source column. `label` shows on the relationship line.

---

### `SECURITY_DATA` (object, required)
Authentication, web roles, and security constraints.

**Schema:**
```json
{
  "webRoles": [
    {
      "name": "<role-name>",
      "description": "<role-description>",
      "status": "<Create|Reuse|Update>",
      "permissions": [<array-of-permissions>]
    }
  ],
  "constraints": [
    {
      "title": "<constraint-title>",
      "description": "<constraint-description>"
    }
  ]
}
```

**Example:**
```json
{
  "webRoles": [
    {
      "name": "Anonymous",
      "description": "Unauthenticated users; read-only access to published content",
      "status": "Reuse",
      "permissions": ["Read"]
    },
    {
      "name": "Customer",
      "description": "Authenticated customers; can view and create support requests",
      "status": "Create",
      "permissions": ["Read", "Create"]
    },
    {
      "name": "Admin",
      "description": "Site administrators; full access to all operations",
      "status": "Create",
      "permissions": ["Read", "Create", "Update", "Delete"]
    }
  ],
  "constraints": [
    {
      "title": "Authenticated Access Required",
      "description": "Most routes require user authentication via Web API token; anonymous access is limited to published content only."
    },
    {
      "title": "Table Permissions Enforce Scoping",
      "description": "Web role table permissions enforce row-level security; users cannot read/edit records outside their assigned scope."
    }
  ]
}
```

**Guidance:**
- `webRoles[].name`: Web role display name (e.g., `"Customer"`, `"Admin"`, `"Anonymous"`)
- `webRoles[].description`: Short description of the role's purpose
- `webRoles[].status`: One of `"Create"`, `"Reuse"`, `"Update"`
  - `"Create"`: This is a new role that doesn't exist in EDM; migration creates it
  - `"Reuse"`: EDM role is carried over without changes
  - `"Update"`: EDM role exists but needs modifications for the SPA (e.g., new permissions)
- `webRoles[].permissions`: List of permission types: `"Read"`, `"Create"`, `"Update"`, `"Delete"`
- `constraints`: Array of security constraints or design principles that the SPA must enforce

---

### `GAPS_DATA` (array of objects, required)
Array of unsupported features and manual work items. Can be an empty array if no gaps exist.

**Schema per item:**
```json
{
  "feature": "<feature-name>",
  "description": "<what-doesnt-work>",
  "impact": "<business-impact>",
  "recommendedAction": "<suggested-workaround-or-note>"
}
```

**Example:**
```json
[
  {
    "feature": "Portal-Managed Hierarchy",
    "description": "EDM portal hierarchy (organization structure, approval chains) is not natively supported in static SPAs. Custom implementation required.",
    "impact": "Users cannot navigate via portal hierarchy; manual setup of role-based views or breadcrumb navigation is needed.",
    "recommendedAction": "Implement breadcrumb navigation or sidebar menu with role-based visibility. Consider using Dataverse hierarchies if available."
  },
  {
    "feature": "Real-Time Collaboration",
    "description": "EDM pages support portal-managed real-time collaboration features; static SPA has no built-in equivalent.",
    "impact": "Collaborative editing is not possible; each user gets their own form instance.",
    "recommendedAction": "Inform users of this limitation. Consider polling or WebSocket integration if real-time updates are critical."
  }
]
```

**Guidance:**
- `feature`: Name of the unsupported EDM feature (e.g., `"Portal-Managed Hierarchy"`, `"Custom Liquid Rendering"`)
- `description`: Explanation of why it's not supported in the SPA
- `impact`: Business or user-facing impact of the gap
- `recommendedAction`: Suggested workaround, follow-up skill, or manual implementation note

---

### `RATIONALE_DATA` (array of objects, required)
Array of design rationale items explaining the migration strategy. Can be an empty array if no rationale items exist.

**Schema per item:**
```json
{
  "title": "<rationale-title>",
  "description": "<rationale-explanation>"
}
```

**Example:**
```json
[
  {
    "title": "Web API Over Portal-Managed Forms",
    "description": "Instead of using Power Pages portal-managed forms, the SPA uses Dataverse Web API directly. This provides more control over UI/UX and data validation."
  },
  {
    "title": "React for Componentization",
    "description": "React was chosen for its component reusability and ecosystem. Components like IncidentList, IncidentForm, and FilterBar can be composed and reused across multiple routes."
  },
  {
    "title": "Table Permissions for Row-Level Security",
    "description": "Dataverse table permissions enforce row-level security based on web roles. Each user only sees records they are authorized to access."
  }
]
```

**Guidance:**
- `title`: Concise title of the rationale point
- `description`: Explanation of the design choice and its benefits
- These appear in the Overview tab under "Design Rationale" in the HTML plan

---

### `DESIGN_DATA` (object, required)
The new SPA's design direction, captured in Phase 6.1 by asking the user just two high-level questions (aesthetic + mood) and deriving the rest with best judgement from `${CLAUDE_PLUGIN_ROOT}/skills/create-site/references/design-aesthetics.md`. This mirrors the `/create-site` design experience exactly so the same answers flow into the `/create-site` invocation in Phase 7.1 without re-asking.

**Schema:**
```json
{
  "framework": "<React|Vue|Angular|Astro>",
  "aesthetic": "<Minimal & Clean | Bold & Vibrant | Dark & Moody | Warm & Organic>",
  "mood": "<Professional & Trustworthy | Creative & Playful | Technical & Precise | Elegant & Premium>",
  "layout": "<Spacious|Compact>",
  "navigation": "<Sidebar|Topbar|Minimal>",
  "weblinkLayout": "<horizontal|vertical|null>",
  "typography": "<font pair description>",
  "motion": "<motion direction description>",
  "palette": {
    "name": "<short descriptive label>",
    "colors": [
      { "name": "Primary",    "hex": "#0078d4" },
      { "name": "Accent",     "hex": "#106ebe" },
      { "name": "Background", "hex": "#faf9f8" },
      { "name": "Surface",    "hex": "#ffffff" },
      { "name": "Text",       "hex": "#323130" }
    ]
  }
}
```

**Example (Bold & Vibrant + Professional):**
```json
{
  "framework": "React",
  "aesthetic": "Bold & Vibrant",
  "mood": "Professional & Trustworthy",
  "layout": "Spacious",
  "navigation": "Sidebar",
  "weblinkLayout": "vertical",
  "typography": "Cabinet Grotesk + Fira Code",
  "motion": "Confident slide-ins",
  "palette": {
    "name": "Strong Blue with Coral Accent",
    "colors": [
      { "name": "Primary",    "hex": "#1e40af" },
      { "name": "Accent",     "hex": "#fb7185" },
      { "name": "Background", "hex": "#f8fafc" },
      { "name": "Surface",    "hex": "#ffffff" },
      { "name": "Text",       "hex": "#0f172a" }
    ]
  }
}
```

**Guidance:**

- `framework`: target SPA framework chosen in Phase 1.
- `aesthetic`: high-level aesthetic direction the user picked in Phase 6.1. Pass to `/create-site` verbatim so it skips its own aesthetic prompt.
- `mood`: high-level mood the user picked in Phase 6.1. Pass to `/create-site` verbatim so it skips its own mood prompt.
- `layout`: visual density derived from the EDM source's information density and the aesthetic. `Compact` for dense data UIs (dashboards, list-heavy portals); `Spacious` for marketing/content sites. Do not ask the user.
- `navigation`: primary navigation pattern derived from the existing EDM's nav and the aesthetic (Sidebar for deep hierarchies and frequent task switching, Topbar for flat marketing sites, Minimal for landing pages). Do not ask the user.
- `weblinkLayout`: `"horizontal"` (pill / inline row), `"vertical"` (stacked list), or `null` when the source has no `weblink-sets/`. Captured in Phase 6.1.b by asking the user. Applies to every weblink set the SPA renders — Phase 7.6's link-set component reads this value. If the source has zero weblink sets, this field is `null` and Phase 6.1.b is skipped.
- `typography`: short label naming the Google Fonts pair derived from the Aesthetic × Mood Mapping table (e.g., `"Cabinet Grotesk + Fira Code"`). Never default to Inter/Roboto/Open Sans/Arial.
- `motion`: short label describing the motion direction derived from the same mapping table (e.g., `"Subtle fades, minimal"`, `"Energetic staggers"`).
- `palette.name`: short, descriptive label that reflects the actual derived palette (e.g., `"Charcoal + Copper"`, `"Earth Tones with Terracotta Accent"`). Avoid generic preset names.
- `palette.colors`: ordered list of `{ name, hex }` pairs derived from the aesthetic + mood color direction. Avoid the cliched purple-on-white AI palette. The renderer accepts any non-empty list and shows each as a labeled swatch in the Overview tab. Each `hex` must be a valid CSS color (e.g., `#0078d4`, `#0078d4cc`); invalid values fall back to a neutral gray.

### `FUNCTIONAL_UNDERSTANDING` (object, required)

User-facing description of what the source site does, rendered as the first card in the Overview tab. Pulled from `canonical-site-model.json#/functionalUnderstanding` (see [Functional Understanding](edm-migration-model.md#functional-understanding) for derivation rules). Empty fields cause the corresponding card to stay hidden so the Overview tab doesn't render blank sections.

**Schema:**

```json
{
  "purpose": "Public knowledge base for a customer-support team. Anonymous visitors browse FAQ articles by topic; authenticated members submit support requests.",
  "features": [
    "FAQ articles with category browsing",
    "Topic taxonomy with hierarchical navigation",
    "Contact form that creates a Dataverse case"
  ],
  "audiences": ["Anonymous Users", "Authenticated Users"]
}
```

`features[]` is deterministically derived from `routes[]` and `forms[]` classifications — not free-form prose. `audiences[]` is sourced from `webrole.yml` and ordered anonymous-first.

### `PRESERVATION` (object, required)

The migration's preservation contract from the canonical model. Drives the **Constraints** and **Additions** cards in the Overview tab. See [Preservation Contract](edm-migration-model.md#preservation-contract) for the full schema, derivation rules, and consumer behavior. Empty arrays cause the corresponding cards to stay hidden.

**Schema (abbreviated):**

```json
{
  "policy": "preserve-source-by-default",
  "dataModel": {
    "tables": [{ "logicalName": "faq_article", "source": true, "columns": [...], "additions": [] }],
    "additions": []
  },
  "tablePermissions": [{ "sourceName": "Article-read-anon", "source": true }],
  "webRoles": [{ "sourceName": "Authenticated Users", "source": true }],
  "constraints": ["No source column may be renamed, retyped, or deleted."]
}
```

`source: true` items are ported verbatim with fresh GUIDs (renames/retypes/drops forbidden); `source: false` items appear in the Additions card with a `justification` string the user can challenge before approving the plan.

### `REUSABLE_COMPONENTS` (array of objects, required)

The reusable-component catalog from the canonical model (see [Reusable Components](edm-migration-model.md#reusable-components)). Drives the **Reusable Components** card in the Overview tab. The renderer surfaces only entries with `reuseCount >= 2`; single-use entries are kept in the array for traceability but not shown to the user.

**Schema:**

```json
[
  {
    "sourceArtifact": "content-snippets/Newsletter CTA.contentsnippet.yml",
    "sourceKind": "content-snippet",
    "reuseCount": 5,
    "referencedBy": ["web-pages/home/...", "web-pages/about/..."],
    "spaTarget": {
      "componentName": "NewsletterCta",
      "kind": "content",
      "framework": "react",
      "i18n": false,
      "props": []
    }
  }
]
```

Pass through verbatim from `extract-edm-reusable-components.js` — no agent re-classification, no re-derivation of `componentName`.

---

## Example Complete JSON

```json
{
  "SITE_NAME": "Customer Portal",
  "PLAN_TITLE": "EDM Migration Plan",
  "SUMMARY": "The Customer Portal is a classic EDM Power Pages site with 6 pages, 2 entity lists, and 3 entity forms. We will migrate it to a React SPA with full Dataverse Web API integration, preserving the 3 custom web roles (Anonymous, Customer, Admin) and enforcing table permissions for security.",
  "SITE_STATS": {
    "routeCount": 8,
    "componentCount": 12,
    "tableCount": 3,
    "manualGapCount": 2
  },
  "DESIGN_DATA": {
    "framework": "React",
    "aesthetic": "Bold & Vibrant",
    "mood": "Professional & Trustworthy",
    "layout": "Spacious",
    "navigation": "Sidebar",
    "weblinkLayout": "vertical",
    "typography": "Cabinet Grotesk + Fira Code",
    "motion": "Confident slide-ins",
    "palette": {
      "name": "Strong Blue with Coral Accent",
      "colors": [
        { "name": "Primary",    "hex": "#1e40af" },
        { "name": "Accent",     "hex": "#fb7185" },
        { "name": "Background", "hex": "#f8fafc" },
        { "name": "Surface",    "hex": "#ffffff" },
        { "name": "Text",       "hex": "#0f172a" }
      ]
    }
  },
  "ROUTES_DATA": [
    {
      "path": "/",
      "sourcePages": ["Home"],
      "componentMapping": [
        { "edm": "Web template Home.html",     "targetKind": "component", "target": "Home" },
        { "edm": "Snippet 'Announcement'",     "targetKind": "content",   "target": "AnnouncementText" }
      ],
      "dataNeeds": ["Static assets"],
      "rationale": "Static landing page with no Liquid logic or Web API calls — direct SPA equivalent. Announcement snippet becomes a content constant per the patterns reference.",
      "confidence": "high"
    },
    {
      "path": "/incidents",
      "sourcePages": ["List of Incidents"],
      "componentMapping": [
        { "edm": "Entity list 'Incidents'",                "targetKind": "component",   "target": "IncidentList" },
        { "edm": "Custom JS sidecar (jQuery filters)",     "targetKind": "component",   "target": "FilterBar" },
        { "edm": "{% fetchxml %} for incident counts",     "targetKind": "serverLogic", "target": "getIncidentSummary" }
      ],
      "dataNeeds": ["Web API: GET /incidents", "Site setting: webapi/incident/fields"],
      "rationale": "Entity list reproducible via Dataverse Web API + table permissions; jQuery filters become a client component; FetchXML aggregate uses server-only context so it migrates via /add-server-logic.",
      "confidence": "high"
    }
  ],
  "DATAVERSE_DATA": [
    {
      "name": "incident",
      "source": "Entity list on List of Incidents page",
      "operations": ["Read", "Create", "Update"],
      "siteSettings": ["webapi/incident/fields", "webapi/incident/iscreateenabled"],
      "followUpSkill": "/integrate-webapi",
      "fields": ["incidentid", "title", "customerid", "createdon"],
      "relationships": [
        { "type": "lookup", "target": "contact", "field": "customerid", "label": "reported by" }
      ]
    },
    {
      "name": "contact",
      "source": "Lookup field in Incident entity form",
      "operations": ["Read"],
      "siteSettings": ["webapi/contact/fields"],
      "followUpSkill": "",
      "fields": ["contactid", "fullname", "emailaddress1"],
      "relationships": []
    }
  ],
  "SECURITY_DATA": {
    "webRoles": [
      {
        "name": "Customer",
        "description": "Authenticated customers",
        "status": "Reuse",
        "permissions": ["Read", "Create"]
      }
    ],
    "constraints": [
      {
        "title": "Authenticated Access Required",
        "description": "Routes require Web API authentication"
      }
    ]
  },
  "GAPS_DATA": [
    {
      "feature": "Portal-Managed Hierarchy",
      "description": "Static SPA does not support portal hierarchy navigation",
      "impact": "Manual breadcrumb or menu required",
      "recommendedAction": "Implement role-based breadcrumb navigation"
    }
  ],
  "RATIONALE_DATA": [
    {
      "title": "Web API Over Portal-Managed Forms",
      "description": "Direct Web API provides more control over UI/UX and validation"
    }
  ]
}
```

---

## Best Practices

### Data Consolidation in Phase 6

In the skill's Phase 6 (Review Migration Plan), before calling the render script:

1. Capture `DESIGN_DATA` (aesthetic, mood, palette, typography, motion, layout, navigation, weblinkLayout) by asking the user just two high-level questions in Phase 6.1 (aesthetic + mood) and one optional question in Phase 6.1.b (weblink layout, only when the source has `weblink-sets/`). Derive the remaining fields from the design aesthetics reference. See SKILL.md Phase 6.1 and 6.1.b.
2. Extract data from `canonical-site-model.json` built in Phase 5.
3. Compute `SITE_STATS`. `componentCount` must count unique SPA components only (the unique `target` values where `targetKind` is `component` or `content`). Do not count `serverLogic`, `webApi`, `staticAsset`, or `manualGap` mappings.
4. Build `ROUTES_DATA` from the model's route/page inventory. For each route, populate `componentMapping` by pairing every EDM artifact (web template, snippet, entity list, basic/advanced form, custom JS, Liquid block) with its SPA replacement and the right `targetKind`. Server-side Liquid that depends on server-only context, privileged access, or server-evaluated business rules must use `targetKind: "serverLogic"` so it is handed off to `/add-server-logic` in Phase 7.3.
5. Build `DATAVERSE_DATA` from the model's Dataverse dependency model. Populate `fields[]` and `relationships[]` so the ER diagram in the Data Model tab can render.
6. Build `SECURITY_DATA` from the model's auth/security model.
7. Build `GAPS_DATA` from the model's unsupported/manual-work model.
8. Build `RATIONALE_DATA` from the migration strategy and design decisions.
9. Write consolidated data to a temporary JSON file (e.g., `edm-migration-plan-data.json`).
10. Call the render script with `--output` and `--data` paths.
11. Open the rendered HTML in the user's browser.

### Confidence Scoring

Confidence scores (`high`, `medium`, `low`) are **critical** for route planning:

- **High**: Route discovered in both static EDM analysis AND runtime evidence (Playwright crawl), OR deterministic configuration (e.g., route name inferred from page name with 100% certainty)
- **Medium**: Route found in only one evidence source, OR inferred with some uncertainty but reasonable confidence
- **Low**: Route inferred from ambiguous Liquid or custom JavaScript, OR undocumented feature found only at runtime, OR conflicting evidence

**In the HTML, low-confidence routes are highlighted in red/alert color** to flag them for user review before implementation.

### Browser Opening (Skill Responsibility)

After calling the render script, the skill must open the HTML file in the user's default browser. Use the OS-appropriate command for the user's environment (e.g., `open` on macOS, `xdg-open` on Linux, `start` on Windows). This puts the plan in front of the user for interactive review before the approval decision.

---

## Error Handling

The render script will exit with an error if:

- `--output` or `--data` argument is missing
- The JSON data file is invalid or cannot be parsed
- Any required key is missing from the data object
- The output file already exists (to prevent accidental overwrites)

**If the output file exists**, the skill should:
1. Detect the conflict
2. Ask the user how to proceed: render to a new filename, or delete the existing plan first and re-render. The render script never overwrites in place — there is no `--force` flag — so the skill must either pass a different `--output` path or remove the old file before re-running.
3. Apply the user's choice (delete or rename) and re-invoke the renderer

Example:
```markdown
I found an existing migration plan at `docs/edm-migration-plan.html`.
The render script won't overwrite it. How should I proceed?

Options:
- Create a new file (e.g., `edm-migration-plan-revised.html`)
- Delete the existing plan and regenerate it under the same name
```
