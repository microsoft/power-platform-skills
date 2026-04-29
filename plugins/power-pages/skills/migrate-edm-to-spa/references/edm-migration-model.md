# EDM Migration Model

Use this reference during `/migrate-edm-to-spa` Phases 5, 6, and 8. The goal is to turn static PAC records and runtime Playwright observations into a reviewable model that can drive SPA re-authoring.

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
  "assets": [],
  "unsupportedOrManual": [],
  "evidenceLedger": []
}
```

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
| Low | Evidence is ambiguous, source relies on complex Liquid/custom JS, or runtime path was inaccessible | Ask user to approve, narrow scope, or mark as manual gap |

Low-confidence items must not silently become working-looking SPA behavior. Either implement with explicit user approval or document as manual work.

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
