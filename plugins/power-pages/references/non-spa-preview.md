# Non-SPA Experience Preview

The Power Pages plugin's non-SPA creation and customization experience is in preview. This
designation applies to the plugin workflows in this document, not to Power Pages, the Enhanced
data model, Design Studio, or PAC CLI generally.

## Covered entry points

Apply this disclosure contract to:

- the non-SPA route in `create-site`;
- `edit-site`;
- `author-webpage-content`.

Non-SPA component authoring, styling and supporting page-element references are not separate
entry points. The coordinator discloses preview status once for non-SPA authoring;
reading another reference does not create a covered-skill handoff.
Do not extend this disclosure
to SPA workflows or `deploy-site` unless non-SPA deployment is separately designated as
preview.

## Entry and handoff protocol

1. Run the normal plugin version check first when the skill defines one.
2. On a direct invocation, present the applicable full notice below before project inspection,
   task creation, environment discovery, questions, or writes.
3. The notice is informational. Do not add an acknowledgement question or treat it as consent for
   provisioning, local edits, deployment, or any other action. Existing approval gates remain
   authoritative.
4. After presenting the notice, treat the current preview journey as
   `previewNoticeShown: true`.
5. When one covered skill invokes another, include both:

   ```text
   previewNoticeShown: true
   invocationSource: <calling-skill-name>
   ```

   A child receiving that explicit handoff does not repeat the full notice. It must forward the
   same marker to any covered descendant. The caller may set the marker only after the full notice
   was displayed in the current user journey.
6. If the marker is absent, malformed, or not part of an actual covered-skill handoff, treat the
   invocation as direct and show the full notice. Do not infer suppression merely because a site
   was previously created, downloaded, or customized.

## Creation notice

> **Preview experience**
>
> Non-SPA Power Pages site creation and customization are currently in preview. Supported
> templates, components, and workflow behavior may change as the experience evolves.
>
> Creating a site provisions a website in the selected Power Platform environment. Review the
> target environment and provisioning plan carefully before approval. We recommend evaluating
> this experience in a non-production environment.

Use this notice after `create-site` has selected the non-SPA route and before non-SPA
prerequisite or environment discovery. For an ambiguous site-type request, also label the choice
`Non-SPA site from a Microsoft template (Preview)` before the route is selected.

## Customization notice

> **Preview experience**
>
> Non-SPA Power Pages customization is currently in preview. Supported components and
> workflow behavior may change as the experience evolves.
>
> This workflow will inspect and may modify locally downloaded site files. It will not update the
> live website unless deployment is separately requested and approved. Keep the site under source
> control and review proposed changes before applying them.

Use this notice for direct invocation of `edit-site` or
`author-webpage-content`, including styling requests and sites created in Design Studio or downloaded independently
with PAC CLI.

## Creation-to-customization continuation

When `create-site` has already shown the creation notice and the user chooses customization, use
this short transition before invoking the coordinator:

> Continuing with the preview non-SPA site customization experience.

Pass the handoff marker so the coordinator and its child skills do not repeat the full notice.

## Browser surfaces

Creation status and customization-plan approval pages should retain compact context:

> **Preview:** This non-SPA site creation and customization experience is in preview. Review
> environments, plans, and local changes before approval or deployment.

This browser text supports the terminal disclosure; it does not replace it.
