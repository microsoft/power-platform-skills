## Phase 2: Select a Documented Template

Present the returned templates with the disclosure:

> These templates come from the published Power Pages samples catalog. Microsoft does not publish
> an environment-specific template-catalog API, so this may not include every template shown in
> Power Pages design studio.

Explain that selection determines the provisioned baseline and informs the site's domain/data
requirements, not its final appearance. Template previews and starter layouts are references,
not a visual commitment. Carry forward genuinely requested capabilities and content; customization
may recompose supported native sections and establish a new identity without changing the data
model or weakening platform contracts. Honor explicit user preservation preferences.

<!-- gate: create-site:non-spa-2-select-template | category=plan | cancel-leaves=nothing -->

> 🚦 **Gate (plan · create-site:non-spa-2-select-template):** Select the exact supported template
> identifier submitted to Create Website.
>
> **Trigger:** Documented template list loaded.
> **Why we ask:** Display names must never be guessed or converted into API identifiers.
> **Cancel leaves:** Nothing — no site or local project exists.

Ask the user:

Build the question's choices from the helper's filtered `catalog.templates`, plus Cancel. Show
the `catalog.bootstrapCompatibility` disclosure when present, including the source and omitted
template names. Do not
offer the unfiltered catalog on the Bootstrap 5 path: not every template supports Bootstrap 5
creation (for example, Event Portal is not on the documented supported list). Never infer
compatibility from a display name or substitute another template automatically.

Keep the exact `name` from the helper result as `TEMPLATE_NAME`. This is the samples manifest's
`provisioning.templateName`, not a value inferred from its display name or catalog ID. Retain the
returned catalog `owner`, `repo`, release/ref, and commit SHA as `CATALOG_OWNER`, `CATALOG_REPO`,
and `CATALOG_SHA` in the provisioning review and status reporting. Every status-renderer call must
use those same values; never resolve `latest-release` again after template selection.
Show the selected template's description, capabilities, requirements, and warning from the helper
result. Do not rewrite or duplicate this metadata in the workflow.

### Record the selected template

Keep the selected entry's catalog `id` as `TEMPLATE_ID`, separately from API `TEMPLATE_NAME`.
After the user selects a valid template, record the selection through the existing telemetry
transport:

```bash
node "${PLUGIN_ROOT}/scripts/emit-non-spa-creation-telemetry.js" --eventName template_used --templateId "<TEMPLATE_ID>" --catalogSha "<CATALOG_SHA>"
```

Retain the returned `correlationId` as `CREATION_CORRELATION_ID` in the conversation's creation
resume context. On repeated selection calls for the **same unfinished creation**, append
`--correlationId "<CREATION_CORRELATION_ID>"`; do not generate another ID. The helper validates
membership in the already-cached non-SPA catalog, saves a private receipt outside the site
tree, and reuses context without additional PAC calls at completion. If audience is already known
to be `internal` or `external`, append `--audience "<audience>"`; otherwise omit it. Do not ask
another question or infer audience from the catalog's maker personas. Pass `--sessionId` only
when the host conversation ID is already available, never a site identifier.

Keep the same correlation across polling, authentication repair, download retries, parameter
correction and resume of this unfinished creation. A different selected template/catalog revision
or an intentional new attempt after a **recorded terminal outcome** needs a new selection ID.
Retain any accepted provisioning operation separately: a new telemetry ID never authorizes a
second POST. Never put these receipts in the downloaded project, Git baseline, or status HTML.

Treat telemetry as best-effort: `{ "ok": false }`, a skipped result, or a command failure does not
block, restart, or otherwise change creation. If no correlation was returned, omit later creation
events rather than invent a result-only ID. Do not re-fetch the catalog or retry telemetry to fix
a recording failure. Existing default skill telemetry is unchanged.
