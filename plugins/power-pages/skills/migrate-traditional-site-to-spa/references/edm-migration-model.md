# EDM Migration Model

Use this reference during `/migrate-traditional-site-to-spa` Phases 5, 6, and 8. The goal is to turn static PAC records and runtime Playwright observations into a reviewable model that can drive SPA re-authoring.

## Contents

- [Artifact Set](#artifact-set)
- [Canonical Site Model Shape](#canonical-site-model-shape)
- [Preservation Contract](#preservation-contract)
- [Reusable Components](#reusable-components)
- [Functional Understanding](#functional-understanding)
- [Metadata Translation Model](#metadata-translation-model)
- [Route Model](#route-model)
- [Data Dependency Model](#data-dependency-model)
- [Behavior Model](#behavior-model)
- [Asset Model](#asset-model)
- [Evidence Ledger](#evidence-ledger)
- [Confidence Scoring](#confidence-scoring)
- [Migration Mapping Matrix](#migration-mapping-matrix)
- [Drift Report](#drift-report)
- [Review Standard](#review-standard)

## Artifact Set

Create these artifacts under `<TARGET_PROJECT_ROOT>/migration-artifacts/`:

| Artifact | Purpose |
|----------|---------|
| `edm-source-inventory.json` | Counts and paths for all relevant EDM records and sidecars |
| `static-analysis.json` | Structured static findings from PAC files |
| `static-analysis-summary.md` | Human-readable static findings and risk summary |
| `runtime-discovery.json` | Playwright route, network, console, auth, and interaction observations |
| `runtime-discovery-summary.md` | Human-readable runtime findings |
| `canonical-site-model.json` | Unified model that drives migration |
| `edm-to-spa-mapping.md` | Reviewable EDM capability to SPA implementation matrix |
| `metadata-translation-plan.md` | Aggregate EDM metadata to granular SPA `.powerpages-site` mapping |
| `migration-gap-log.md` | Deferred, unsupported, or low-confidence work |
| `migration-traceability.json` | Generated SPA artifacts mapped back to EDM evidence |
| `migration-verification-report.md` | Build/browser/drift verification results |

## Canonical Site Model Shape

Use this shape as a guide. Add fields when needed, but keep the top-level categories stable so reviewers can compare migrations.

```json
{
  "site": {
    "name": "",
    "sourceRoot": "",
    "targetFramework": "",
    "targetProjectRoot": "",
    "liveSiteUrl": "",
    "languages": [],
    "readiness": {
      "score": "low|medium|high",
      "risks": []
    }
  },
  "routes": [],
  "components": [],
  "dataDependencies": [],
  "forms": [],
  "lists": [],
  "authAndSecurity": {
    "authSettings": [],
    "webRoles": [],
    "tablePermissions": [],
    "pageRules": []
  },
  "metadataTranslation": {
    "sourceShape": "aggregate-edm",
    "targetShape": "granular-spa-powerpages-site",
    "siteSettings": [],
    "webRoles": [],
    "sitemarkers": [],
    "webpageRules": [],
    "siteLanguages": [],
    "publishingStates": [],
    "websiteAccess": [],
    "unmapped": []
  },
  "preservation": {
    "policy": "preserve-source-by-default",
    "dataModel": { "tables": [], "additions": [] },
    "tablePermissions": [],
    "webRoles": [],
    "constraints": []
  },
  "reusableComponents": [],
  "functionalUnderstanding": {
    "purpose": "",
    "features": [],
    "audiences": []
  },
  "assets": [],
  "unsupportedOrManual": [],
  "evidenceLedger": []
}
```

## Preservation Contract

The migration is **preservation-by-default**. The source site's data model, table permissions, and web roles all encode functionality that the migrated SPA must continue to provide. The migration is allowed to **add** new metadata when the target site genuinely needs it (a new SPA-only access path, a Web API column not in the source); it is not allowed to **modify or drop** anything the source had.

The `preservation` section of `canonical-site-model.json` is the single contract that `/create-webroles`, `/audit-permissions`, and the metadata-translation step (implement Phase 7.3.d) all consume. Each consumer refuses to drop a `source: true` entry; additions are emitted only when `source: false` with a `justification`.

### Constraints by concern

| Concern | Allowed | Forbidden |
|---|---|---|
| **Data model** | Adding new columns or tables when the SPA's Web API or new functionality genuinely needs them. Each addition is recorded under `preservation.dataModel.additions[]` (or per-table `additions[]`) with a `justification`. | Renaming, retyping, deleting, or otherwise modifying any column or table the source had. The source schema is the contract. |
| **Table permissions** | Adding new permissions when a new SPA-only access path needs one. | Dropping a source permission. Narrowing scope (e.g., changing `Global` to `Contact`) on a permission the source had. |
| **Web roles** | Adding new roles when a new SPA-only access path needs one. | Renaming, dropping, or changing the `default` / `anonymous` / `authenticated` flags on a source role. GUIDs change (the target tenant gets fresh ones); identity is preserved by name. |

### Shape

```json
{
  "policy": "preserve-source-by-default",
  "dataModel": {
    "tables": [
      {
        "logicalName": "faq_article",
        "source": true,
        "sourceEvidence": ["lists/Articles.entitylist.yml", "basic-forms/Edit-Article.basicform.yml"],
        "columns": [
          { "logicalName": "faq_articleid", "source": true, "attributeType": "Uniqueidentifier" },
          { "logicalName": "faq_articlebody", "source": true, "attributeType": "Memo" }
        ],
        "additions": []
      }
    ],
    "additions": [
      {
        "kind": "table",
        "logicalName": "faq_articlefeedback",
        "justification": "New SPA-only feedback widget needs a place to write user reactions.",
        "source": false
      }
    ]
  },
  "tablePermissions": [
    {
      "sourceName": "Article-read-anon",
      "source": true,
      "sourceFile": "table-permissions/Article-read-anon.tablepermission.yml",
      "entityLogicalName": "faq_article",
      "scope": "Global",
      "privileges": ["Read"],
      "webRoleNames": ["Anonymous Users"],
      "targetIdStrategy": "generate-new-guid",
      "justification": null
    }
  ],
  "webRoles": [
    {
      "sourceName": "Authenticated Users",
      "source": true,
      "sourceFile": "webrole.yml#Authenticated Users",
      "default": true,
      "anonymous": false,
      "authenticated": true,
      "targetIdStrategy": "generate-new-guid",
      "justification": null
    }
  ],
  "constraints": [
    "No source column may be renamed, retyped, or deleted in the target tenant.",
    "Every source table permission must exist in the target; new permissions allowed only with explicit justification.",
    "Every source web role must exist in the target; new roles allowed only with explicit justification."
  ]
}
```

### Consumer rules

- `/create-webroles` (Phase 7.3.b) — for every entry in `preservation.webRoles[]`, generate the corresponding `.powerpages-site/web-roles/<sanitized-name>.webrole.yml`. Cannot skip a `source: true` entry; if generation fails, the migration is `Blocked`.
- `/audit-permissions` (Phase 7.3.b) — for every entry in `preservation.tablePermissions[]`, generate the corresponding `.powerpages-site/table-permissions/<sanitized-name>.tablepermission.yml`. Source permissions get fresh GUIDs but identical `entityLogicalName` / `scope` / `privileges` / `webRoleNames`. Cannot drop a source permission, cannot narrow scope.
- Metadata translation (Phase 7.3.d) — for every column listed under `preservation.dataModel.tables[].columns[]`, confirm the column exists in the target tenant's Dataverse snapshot (via `verify-canonical-model-against-dataverse.js`). Mismatches are blocker findings, not deferral candidates.
- HTML plan rendering (Phase 6) — surface a **Constraints** card and an **Additions** card in the Overview tab. The user reviews additions before approving the plan; source-preserved items are summarized as counts (e.g., "All 7 source web roles will be preserved with fresh GUIDs").

## Reusable Components

The source site uses content snippets, web templates, and weblink-sets as reusable building blocks. The migration must factor them into SPA components when they're reused across multiple pages — inlining the same source content across N SPA files is a Phase 8 drift item, not a successful migration.

The static analyzer (Phase 3) enumerates every reusable source artifact deterministically (grep across page sidecars, template `.source.html`, and other snippets for the source's `adx_name` and reference patterns). The implement step (Phase 7.6) mechanically generates one SPA component per entry; page-level `componentMapping[]` entries reference the component by name.

```json
{
  "sourceArtifact": "content-snippets/Newsletter-CTA.contentsnippet.yml",
  "sourceKind": "content-snippet",
  "reuseCount": 5,
  "referencedBy": [
    "web-pages/home/Home.webpage.copy.html",
    "web-pages/about/About.webpage.copy.html",
    "web-pages/faq/FAQ.webpage.copy.html",
    "web-pages/contact/Contact.webpage.copy.html",
    "web-templates/Layout.webtemplate.source.html"
  ],
  "spaTarget": {
    "componentName": "NewsletterCTA",
    "kind": "content",
    "framework": "react",
    "props": [],
    "i18n": false
  },
  "evidence": ["content-snippets/Newsletter-CTA.contentsnippet.yml"]
}
```

| Field | Purpose |
|-------|---------|
| `sourceKind` | `content-snippet`, `web-template`, `weblink-set`, `shared-css`, or `shared-script` |
| `reuseCount` | Number of distinct source files that reference this artifact |
| `referencedBy[]` | PAC-relative paths of every referencing source file (used to update page-level `componentMapping[]` entries) |
| `spaTarget.kind` | `content` (snippet → content module), `layout` (web template → layout component), `navigation` (weblink-set → nav component), or `asset` (shared CSS/JS) |
| `spaTarget.componentName` | Derived from `adx_name` (kebab-cased into PascalCase) |
| `spaTarget.i18n` | `true` when source has multiple language variants of the snippet |

**Inlining rule (Phase 7.6):** if `reuseCount >= 2`, the SPA must factor the artifact into a single component. The agent does not get to choose to inline. A single-use snippet (`reuseCount === 1`) may be inlined into the consuming page when the snippet is trivially short; longer snippets get factored regardless.

The HTML plan surfaces a **Reusable Components** card listing each entry with `reuseCount`, `referencedBy[]` count, and `spaTarget.componentName` so the user can review the factoring before approving.

## Functional Understanding

The Overview tab of the HTML plan leads with a user-facing description of what the source site does, not designer/engineer metadata. Three fields drive it:

```json
{
  "purpose": "Public-facing knowledge base for a customer-support team. Anonymous visitors browse FAQ articles by topic; authenticated members submit support requests and track their cases.",
  "features": [
    "FAQ articles with category browsing and search",
    "Topic taxonomy with hierarchical navigation",
    "Contact form that creates a Dataverse case",
    "Authenticated profile editing",
    "Member-only support history"
  ],
  "audiences": ["Anonymous Users", "Authenticated Users", "Support Staff"]
}
```

| Field | Source |
|-------|--------|
| `purpose` | One to two plain-language sentences. Derived from the source site's name, `sitesetting.yml#Site/Description` (when present), and the static analyzer's site-type classification (portal / dashboard / knowledge / community / faq / support). |
| `features[]` | Bulleted user-visible capabilities. Derived deterministically from the canonical model's `routes[]` and `forms[]` classifications, mapped to feature names via a lookup table in the static analyzer (e.g., a route classified as `entity-list` over `kbarticle` → "Knowledge articles list"). Not free-form agent prose. |
| `audiences[]` | Sourced from `webrole.yml` (every role with `adx_name`), reordered so anonymous-first / authenticated-second / specific roles last. |

The HTML plan's Overview tab renders these as the first three cards, above any aesthetic / mood / palette / count detail.

## Metadata Translation Model

Build a metadata translation plan after `/deploy-site` creates the target `.powerpages-site/` folder. This plan must compare source EDM records with the target hydrated SPA metadata and decide whether each item is created, updated, skipped, or logged as a gap.

```json
{
  "source": "sitesetting.yml",
  "sourceRecord": {
    "adx_name": "Webapi/faq_topic/enabled",
    "adx_sitesettingid": "952b3bd5-f2a0-ed11-83fd-000d3a3b16f6",
    "adx_value": "true"
  },
  "targetFolder": ".powerpages-site/site-settings",
  "targetFile": "Webapi-faq_topic-enabled.sitesetting.yml",
  "targetRecord": {
    "name": "Webapi/faq_topic/enabled",
    "value": "true"
  },
  "idStrategy": "generate-target-id|preserve-existing-target-id|reuse-approved-id",
  "status": "create|update|skip|gap",
  "reason": "Enable Web API access for faq_topic in the migrated SPA.",
  "confidence": "high"
}
```

Rules:

- Use the target `.powerpages-site/` folder shape as the source of truth for filenames and field style.
- Do not copy aggregate EDM files such as `sitesetting.yml`, `webrole.yml`, or `sitemarker.yml`.
- Do not blindly preserve EDM record IDs or web role IDs. Target metadata may already have its own IDs after deployment.
- Prefer existing creation scripts and skills for site settings, table permissions, web roles, cloud flows, and server logic.
- Record every skipped or uncertain metadata item in `migration-gap-log.md`.

## Route Model

Each route should preserve source evidence and migration status.

```json
{
  "route": "/support",
  "sourcePages": ["web-pages/support/Support.webpage.yml"],
  "sourceTemplates": ["web-templates/support/Support.webtemplate.source.html"],
  "title": "Support",
  "spaComponent": "SupportPage",
  "layoutComponents": ["Header", "Footer"],
  "dataDependencies": ["incident"],
  "authRequirement": "anonymous|authenticated|role-gated|unknown",
  "migrationStatus": "direct|requires-webapi|requires-auth|custom-code|manual-gap",
  "confidence": "high|medium|low",
  "evidence": ["static:webpage", "runtime:crawl"]
}
```

## Data Dependency Model

Create one entry per Dataverse table or endpoint.

```json
{
  "tableLogicalName": "incident",
  "displayName": "Case",
  "sourceArtifacts": [
    "lists/Customer-Service---Cases-List.list.yml",
    "basic-forms/customer-service---create-case/Customer-Service---Create-Case.basicform.yml"
  ],
  "operations": ["read", "create", "update"],
  "uiSurfaces": ["/support/cases", "/support/create-case"],
  "permissions": ["Customer Service - Cases where contact is customer"],
  "webApiNeeded": true,
  "siteSettingsNeeded": true,
  "confidence": "high"
}
```

## Behavior Model

Use behavior entries for Liquid, custom JavaScript, runtime interactions, and portal-managed behavior.

```json
{
  "behaviorId": "create-case-contact-required",
  "source": "basic-forms/customer-service---create-case/Customer-Service---Create-Case.basicform.custom_javascript.js",
  "type": "validation|navigation|data-loading|conditional-rendering|auth|redirect|unknown",
  "description": "Requires primary contact when customer is an account.",
  "spaImplementation": "Framework form validation rule on CreateCaseForm",
  "migrationStatus": "custom-code",
  "confidence": "high",
  "evidence": ["static:custom-js"]
}
```

## Asset Model

Populate `assets[]` from the Phase 3.6 web-file inventory. Every EDM binary referenced by a migrated route, template, snippet, or CSS file must have an entry so Phase 7.6 can reuse it.

```json
{
  "assetId": "hero-banner",
  "sourcePath": "web-files/hero-banner.png/hero-banner.png",
  "originalUrl": "/hero-banner.png",
  "mediaType": "image",
  "fileExtension": ".png",
  "byteSize": 184320,
  "altText": "Customer service team collaborating",
  "targetPath": "public/hero-banner.png",
  "targetKind": "staticAsset",
  "usedBy": [
    {"kind": "route", "id": "/"},
    {"kind": "webTemplate", "id": "Home Hero"}
  ],
  "confidence": "high",
  "evidence": ["static:web-file", "static:webtemplate-ref"]
}
```

| Field | Purpose |
|-------|---------|
| `assetId` | Stable identifier used by route `componentMapping[]` entries to reference the asset |
| `sourcePath` | PAC-relative path to the **binary** alongside `*.webfile.yml` |
| `originalUrl` | EDM URL or `adx_partialurl` the source site exposed the file at |
| `mediaType` | `image`, `icon`, `document`, `font`, or `other` |
| `byteSize` | Size of the source binary; used to flag oversized assets and to guard the verification report |
| `altText` | Accessible name captured from referencing markup, if any |
| `targetPath` | Planned SPA location (typically `public/<name>` or `src/assets/<name>`) |
| `targetKind` | Always `staticAsset` for binary reuse |
| `usedBy` | Routes, templates, snippets, or CSS files that reference the asset |
| `confidence` | `high` when the reference is direct, `medium` when inferred via Liquid/dynamic URL, `low` for ambiguous matches |

Routes whose source content references one or more assets must include matching `componentMapping[]` entries with `targetKind: "staticAsset"` so the migration plan surfaces the asset reuse to the user.

Assets that exist in the EDM source but are not referenced by any migrated route/template/snippet must still be inventoried, but recorded in `unsupportedOrManual[]` (or `migration-gap-log.md` with `category: "asset-unreferenced"`) rather than silently dropped.

## Evidence Ledger

Every important generated artifact should trace to evidence. Use evidence records like:

```json
{
  "id": "evidence-001",
  "sourceType": "static|runtime|user-approved",
  "pathOrUrl": "web-pages/home/Home.webpage.yml",
  "signal": "adx_partialurl is /",
  "usedFor": ["route:/"],
  "confidenceImpact": "high"
}
```

## Confidence Scoring

| Score | Use when | Action |
|-------|----------|--------|
| High | Static and runtime agree, or deterministic YAML configuration is clear | Implement directly after plan approval |
| Medium | Only static or runtime evidence exists, but mapping is straightforward | Implement with traceability and mention in plan |
| Low | Evidence is ambiguous, source relies on complex Liquid/custom JS, or runtime path was inaccessible | Surface in the HTML plan for approval, narrow scope, or mark as manual gap |

Low-confidence items must not silently become working-looking SPA behavior. Include them in the HTML plan as explicit implementation scope or document them as manual work.

## Migration Mapping Matrix

Use this table format in the plan:

```text
| EDM capability | Evidence | SPA implementation | Status | Confidence | Notes |
|----------------|----------|--------------------|--------|------------|-------|
| Home page | web-pages/home, runtime / | / route + HomePage | Direct SPA equivalent | High | |
| Case list | lists/Customer-Service---Cases-List.list.yml | Cases route + Web API service | Requires Web API | High | Needs incident table permissions |
| Create case validation | basic form custom JS | Framework validation rule | Requires custom code | High | Requires contact when customer is account |
```

## Drift Report

During verification, compare the approved model against the SPA:

```text
| EDM route/behavior | SPA result | Status | Notes |
|--------------------|------------|--------|-------|
| /support/cases | /support/cases renders CasesPage | Match | List service pending deployment |
| Case create attachment upload | Documented manual gap | Manual gap | EDM allows image/video and document uploads |
```

Statuses:

- `match`: Represented in SPA as approved.
- `intentional change`: User approved a different implementation.
- `manual gap`: Accepted gap or deferred work.
- `unexpected drift`: Must be fixed or explicitly accepted before handoff.

## Review Standard

Before writing SPA files, the user must see:

1. Current-state site summary.
2. Route and component plan.
3. Data/API and security plan.
4. Unsupported/manual gaps.
5. Confidence scores.
6. Exact files or project areas that will be created or replaced.

Do not proceed to implementation until the user approves the migration plan.
