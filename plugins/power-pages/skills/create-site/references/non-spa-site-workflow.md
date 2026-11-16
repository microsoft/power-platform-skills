# Create a Non-SPA Power Pages Site

Follow this workflow only after `create-site` routes the request to an Enhanced data model non-SPA site.
The platform creates the baseline from a documented first-party template; download that baseline rather than generating Power Pages metadata.
Use the selected template for data-model/domain context and requirements interpretation only, not as a constraint on visual design, page composition, layout, branding or modern presentation.
Custom design and layout are required on the customization path, unless the user explicitly keeps the bare template.
Reuse needed native forms, lists, content snippets and components within the fresh composition.
Preserve required functionality and explicit user exceptions, not every starter section or placement.
Use approved direct HTTPS image URLs for additions, not downloaded/imported Web Files.
Existing template images may be reused without creating new files.

## Preview disclosure

Read `${PLUGIN_ROOT}/references/non-spa-preview.md`, also linked directly from `SKILL.md`.
Before prerequisite checks, task creation, environment discovery or the first non-SPA question, present the **Creation notice**.
This is informational, not another approval gate.
After presenting it, carry `previewNoticeShown: true` through every covered-skill handoff.

## Invariants

- Support only **Enhanced with Bootstrap 5**; after confirmation set `MODEL_VERSION=Enhanced` and `BOOTSTRAP_VERSION=5`.
  An explicit Standard/SDM creation request is not consent for Enhanced; offer Enhanced non-SPA, the SPA route or cancellation.
- Bootstrap 5 creation needs Enhanced and a supported template.
  Follow [Microsoft's Bootstrap 5 guidance](https://learn.microsoft.com/power-pages/configure/bootstrap-version-5) and verify downloaded assets before version-specific authoring.
- The environment EDM toggle has no documented public read/write API.
  An administrator must verify **Switch to enhanced data model** is enabled; never automate that shared environment change.
- Use the release-pinned `microsoft/power-pages-samples` manifest, not an environment-specific catalog.
  Resolve one immutable SHA per run; fail clearly instead of using stale or bundled catalog data.
- Do not submit `websiteRecordId` for new creation; the platform creates the record.
  Never retry a Create Website POST after `202 Accepted`; resume or poll the accepted operation.
- Verify PAC reports `MODEL_VERSION`, then download with `--modelVersion "<MODEL_VERSION>"` explicitly.
  Pass the same explicit model to every status-page render.
- Do not invoke `activate-site` or show a deploy-now prompt; the API already provisions the cloud site.
  No dev server, live preview, generated styling mockup or browser inspection is required.
  Provisioning-status and customization-approval HTML documents are not live previews.

## Progress tracking

Create these eight tasks after the preview notice and before prerequisites.
Use clear action titles, in-progress labels and descriptions.

| Task | Completion condition |
|---|---|
| Verify non-SPA site prerequisites | Supported model, tools, authentication, environment and administrator confirmation verified |
| Select a non-SPA template | Supported exact template and pinned metadata selected |
| Configure the non-SPA site | Name, language, subdomain and destination agreed |
| Approve non-SPA site provisioning | Complete cloud/local plan approved |
| Provision the non-SPA site | Accepted operation reaches its verified result |
| Download the non-SPA site | Identity/model checked and explicit-model download complete |
| Validate the non-SPA baseline | Artifacts, Bootstrap and Git baseline validated |
| Complete non-SPA site setup | Results reported and customization handed off unless declined |

## Ordered stages

Load the following resources directly from the resource map in `SKILL.md` as each stage begins.
Complete each stage before the next; preserve the selected values and operation state across resources.

1. **Prerequisites:** confirm the Enhanced model, tools, authentication, environment and administrator capability.
2. **Selection:** use supported templates and record selection telemetry at its existing boundary.
3. **Configuration:** gather name, verified language, editable subdomain and destination.
4. **Provisioning:** obtain final consent, submit once, maintain status, poll/resume and record terminal failures accurately.
5. **Verified baseline:** verify service/PAC identity and actual model, download explicitly, validate assets, initialize Git and run the validator again.
6. **Customization:** emit success only after the verified baseline, report results, then offer the documented coordinated design handoff.

Keep the main conversation responsible for questions and shared status.
Telemetry is best-effort and uses only the documented fixed taxonomy.
Never turn a failed status render, uncertain operation or incomplete download into a successful result or a second creation request.
