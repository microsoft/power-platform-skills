# SPA Output Rules — What MUST NOT Appear

Reference for `migrate-traditional-site-to-spa-implement` Phase 7.6. The artifacts under `migration-artifacts/` (canonical model, verification checklist, gap log, manifest, plan) are **planning context** — they exist so the migration is auditable. They must not be rendered into the SPA itself.

Pages migrated from EDM source should look like the EDM source did, not like an internal status dashboard.

## Contents

- Forbidden categories (what must never appear in rendered SPA output)
- How to render genuinely-incomplete components
- Scope of the rule (not just visible UI — `<head>`, meta tags, build manifests too)
- The corresponding validator gates that enforce this rule

## Forbidden Categories

None of the following may appear in any visible component output, page copy, layout chrome, badge, header, footer, hero, or alt text:

### 1. Phase or scaffold labels

Strings like `SCAFFOLD`, `PHASE 7.5`, `PHASE 7.6`, `Phase 7.3 invokes ...`, `Phase 7.6 wires ...`, `migration-runtime-discoverer`, `migration-validator`, any badge that references a sub-step of this skill. These are scaffolding markers — the migration is the off-stage process; the SPA is the on-stage product.

### 2. Migration-internal metadata as content

Keys like `Route`, `EDM source`, `Badges`, `componentMapping`, `evidence`, `confidence`, `targetKind`, `manualGap`, or any other key from `migration-artifacts/` rendered as a labeled row, badge, or descriptor on the page. If the user needs to see the route's source path, they will read the traceability file — not the home page.

### 3. Sensitive identifiers

Entra ID tenant IDs, client IDs (application IDs), object IDs, `response_type`, `code id_token`, OIDC `scope` lists, Dataverse organization URLs, environment URLs, service-principal IDs, secret keys, connection strings, Web API keys, or any other identifier that is configuration rather than content. These belong in `.env` / `.powerpages-site/*.sitesetting.yml` and are consumed by code at runtime; they must never be hard-coded into a rendered string.

A migrated sign-in page that displays `tenant 9548b2c9-...` to the end user is a security defect even when the tenant is non-confidential — it leaks the auth wiring and trains users to ignore credential-shaped strings on screen.

### 4. Internal phase-by-phase commentary as page copy

Sentences like:

- "Phase 7.6 wires faqTopicService.list and faqArticleService.list"
- "Public landing page with topic cards" (rendered as page copy)
- "Sign-in entry point. Phase 7.3 invokes /setup-auth"
- "EDM source web-pages/home/Home.webpage.yml"

These read like the author's planning notes leaking through. Page copy must be derived from the EDM source's `.copy.html` / `.summary.html` / web template content, not from `static-analysis.json` or the canonical model.

### 5. TODO/placeholder strings in production-shape components

A page that displays its own implementation TODO inline (rather than rendering the EDM content and recording the gap in `migration-gap-log.md`) is a planning leak. TODOs belong in source comments and the gap log, not in the rendered DOM.

## Handling Genuinely-Incomplete Components

If a component is genuinely incomplete (e.g., `/setup-auth` was user-deferred), it must say so explicitly to the end user in plain terms — for example:

> `"Sign-in requires /setup-auth to be configured. See migration-gap-log.md."`

It must **not** display internal IDs, phase numbers, or planning prose. A typed stub at the source level is preferable to a "debug page" that leaks the migration's internals.

## Scope

The rule applies recursively to **all** rendered output paths, not just visible page bodies:

- Component JSX/Vue/Astro templates and their string literals.
- Page `<title>`, `<meta>`, `<og:*>` tags.
- `<head>` `<script>` content.
- Source-map comments and build manifests.
- `robots.txt`, `sitemap.xml`, and other generated public files.

The same forbidden strings must not appear in any of those either.

## Validator Enforcement

Phase 8.4's `migration-validator` agent runs three synthetic gate checks (severity `blocker`) that enforce this reference:

- `gate-no-scaffold-leak` — greps for category-1 phrases (`SCAFFOLD`, `PHASE \d+`, agent names) in rendered text (excluding source comments).
- `gate-no-planning-metadata` — greps for category-2 labels and category-4 phase-commentary sentences.
- `gate-no-secret-leak` — greps for category-3 identifiers in template literals (allowing them in `.env*` and `.powerpages-site/`).

A single hit on any of these forces `Blocked` — Phase 9 cannot present `Migration Complete`.
