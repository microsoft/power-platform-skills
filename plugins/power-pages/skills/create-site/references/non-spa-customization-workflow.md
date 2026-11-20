## Phase 8: Present Results

Record usage through `${PLUGIN_ROOT}/references/skill-tracking-reference.md` with skill name
`CreateSite`.

Present:

- Site name and template
- Environment
- Website record ID
- Site URL
- Local project path
- Confirmed data model: `<MODEL_VERSION>`
- Verified Bootstrap major: `<BOOTSTRAP_VERSION>`
- Validation and Git baseline result
- Creation status page URL

Explain that the local files are the validated, committed baseline of the site already created in
the environment, not yet the completed bespoke design. Do not ask to deploy the unchanged baseline.
Recommend continuing with the user's original purpose, a cohesive visual direction, and meaningful
hero/supporting imagery using the shared design-quality guidance.

<!-- gate: create-site:non-spa-8-customize | category=plan | cancel-leaves=non-spa-baseline -->

> 🚦 **Gate (plan · create-site:non-spa-8-customize):** Choose whether to continue into coordinated
> local non-SPA customization.
>
> **Trigger:** Explicit-model download, identity validation, and the untouched-template Git baseline
> succeeded.
> **Why:** Customization can create or modify several local non-SPA records, while declining
> should leave the verified Microsoft template unchanged.
> **Cancel leaves:** The created live site and verified local baseline.

Ask the user:

| Question | Header | Options |
|---|---|---|
| Would you like to customize the downloaded non-SPA template now? | Customize site | Customize now (Recommended), Keep the template unchanged |

Before this question, rewrite the `ready` status with `--activityState "awaiting-input"` and
`--requiredAction "Choose whether to customize the downloaded template now or keep it unchanged."`
Retain the same verified `--siteUrl` so the completed-site action remains available. After
receiving either answer, declining the question, or canceling it, rewrite `ready` without an
activity override, again retaining `--siteUrl`, so the notification clears and the page returns
to its completed state. Never mark the completed creation as failed or canceled because optional
customization did not start.

On **Customize now**, tell the user:

> Continuing with the preview non-SPA site customization experience.

Then invoke `/edit-site` using the available skill-invocation capability and provide:

- exact `PROJECT_ROOT` and non-SPA site root;
- site name and selected template as data-model/domain and requirements context, not a visual
  constraint; include genuinely requested capabilities/content and explicit preservation preferences;
- environment URL;
- `WEBSITE_RECORD_ID`;
- configured base language;
- the user's original site intent, when present;
- the requirement for a custom modern page composition, layout, branding and presentation,
  reusing needed native forms/lists/snippets rather than their surrounding starter layout.
  Allow removal of unneeded starter sections and component placements within the approved scope,
  without deleting backing records or discarding required capabilities.
  Record it in the existing `summary` and
  `newSiteDesign.composition` brief and carry it through `designContext`; do not default to retaining
  the starter arrangement or ask for separate redesign permission merely because it differs;
- any already established experience brief, brand source, primary action, and narrative intent;
  let the customizer complete only missing decisions rather than asking for them again;
- native-editing requirements: known layout recipes are defaults, not an exhaustive list.
  Explicit broader safe local geometry carries a Studio-editing-unverified warning through
  planning, authoring and verification; no automatic deployment or preview-component creation;
- `creationIntent: "new-site"` and `verifiedBootstrapMajor: 5` with the inspected evidence;
- `previewNoticeShown: true` and `invocationSource: create-site`;
- the requirement to include header branding, navigation styling and mobile treatment in the
  existing customization plan, including an explicit website-appropriate logo or wordmark
  decision. Pass any supplied approved logo and known brand requirements; replace an unsuitable
  starter logo rather than inheriting it by default, and honor explicit preservation preferences.
  Header work is part of the custom composition, not a replacement for page design;
- `imageDelivery: "external-url"`: record this as `newSiteDesign.imageDelivery` and use direct
  approved HTTPS URLs for new images. Skip image staging/downloads, `author-web-file` image
  imports, and fabricated import dependencies. Retain source/license, alt text, sizing/crop,
  external-host/privacy/CSP review, and the native image-component contract;
- the requirement for a coordinated design and meaningful images, unless the user explicitly
  declines imagery. The customizer records these decisions in `newSiteDesign`, not an existing-site
  preservation-only plan.

The customization plan must include actual composition work for Home and the primary visitor
journey, not only extra pages or CSS over the starter. Reuse the existing layout-planning reference
to resolve component placements and native owner operations before plan approval. Explicitly
preserved regions remain exceptions within their stated scope; they do not freeze the rest of the site.

The customization skill owns its own plan approval, authoring-skill coordination, local
verification, commits, and deployment handoff. Do not duplicate those phases here.

On **Keep the template unchanged**, do not require customization before evaluating downstream
needs.

After the customization skill returns, or immediately after **Keep the template unchanged**,
evaluate the same downstream recommendations from the verified baseline plus any returned
customization result. Customization success is not a prerequisite:

- Suggest `/setup-datamodel` only when a known site requirement needs a specific table, column, or
  relationship that is absent from the downloaded evidence and authoritative Dataverse metadata.
  Name the exact missing schema; do not recommend a generic data-model pass.
- Never suggest `/add-sample-data` for a non-SPA site. Sample records can affect shared live
  Dataverse data and are not a creation default.
- Suggest `/create-webroles` only when a known audience or access requirement needs a role that is
  absent from the normalized aggregate/per-record role inventory.
- Suggest `/integrate-webapi` only when a known interaction requires native data access or custom
  client behavior and the returned customization did not already satisfy it through a Form,
  Advanced Form, List, Liquid, settings, permissions, or existing Web API caller.
- Suppress recommendations already completed by the customization result or disproved by current
  evidence. Do not invent roles, tables, CRUD needs, or API integration merely because the
  corresponding skill exists.

Finish after presenting only the evidence-backed recommendations whose non-SPA support has
been verified.
