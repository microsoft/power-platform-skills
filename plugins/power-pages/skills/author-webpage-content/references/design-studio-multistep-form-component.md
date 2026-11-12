# Multistep Form Component

Use this reference only to add or edit the markup for the **Multistep form** component:

```liquid
{% webform name: '<multistep form name>' %}
```

Microsoft Learn notes that multistep forms were called **advanced forms** earlier; the
Dataverse/PAC record, serialized folder, and attribute prefixes (`adx_webformid`,
`advancedform`, `advancedformstep`) still use that earlier name. This reference does not
cover the single-step Form component (`{% entityform name: '...' %}`, see
`design-studio-basic-form-component.md`) or the List component
(`{% include 'entity_list' ... %}`, see `design-studio-list-component.md`).

## Scope: reference an existing multistep form only

The **+ New multistep form** flow creates the multistep form record, one or
more step records, their bound Dataverse table forms, and table permissions — none of which
can be authored from local YAML alone. This skill therefore only inserts, moves, or edits
the `{% webform %}` tag that points at a multistep form **already present in the downloaded
site**:

```text
advanced-forms/<form-directory>/<form-directory>.advancedform.yml
advanced-forms/<form-directory>/advanced-form-steps/<step-directory>/<step-directory>.advancedformstep.yml
```

If the request needs a multistep form that is not already downloaded, do not create
`.advancedform.yml`/`.advancedformstep.yml` files locally to simulate it, and do not query
Dataverse (API, SDK, Web API, or CLI) or ask the user for step/webform IDs, table
permissions, or any other record detail in order to assemble it yourself — this skill only
references a multistep form already serialized under `advanced-forms/` by a prior
`pac pages download`; it does not help construct, fetch, or synthesize one. Stop and tell
the user to create the multistep form in the Data workspace, Design Studio, or the
Management app and re-download the site before this component can reference it. Do not
invent a plausible-looking form name or assemble steps locally. If asking the user how to
proceed, never present "create a new multistep form" as a selectable option — only embedding
an existing form, or stopping, are valid choices.

## Resolving the exact form name

1. List `advanced-forms/` and find the directory matching the request.
2. Read `<form-directory>.advancedform.yml` and use its exact `adx_name` value as the tag's
   `name` argument — not the directory name, which PAC CLI can slugify or truncate.
3. `adx_startstep` identifies the first step's `adx_webformstepid`; cross-reference
   `advanced-form-steps/*/*.advancedformstep.yml` by that ID to confirm step order and
   count, but do not edit step linkage through this component.
4. An empty `{% webform name: '' %}` tag is a valid state (a Multistep form component added
   without selecting a backing form yet); treat it as unresolved, not as evidence of a
   broken page.

## Markup

```liquid
{% webform name: 'Multistep form 1' %}
```

- Place the tag directly inside the selected `.columnBlockLayout` or Flex Container.
- Treat it as a leaf component; do not add child markup, step indicators, or hand-written
  navigation around it — the rendered steps, progress indicator, and back button all come
  from the multistep form record.
- Do not impose a column width, breakpoint, padding, or margin.
- Escape the selected Liquid string delimiter.
- Preserve existing attribute order and quote style when editing.

## Requirements

- Every step's bound table must already have table permissions configured for the intended
  web roles; this component does not create them.
- Step order (`adx_nextstep`/`adx_startstep`), step mode (create/update/read-only), progress
  indicator, CAPTCHA, and attachment settings live on the advanced-form/advanced-form-step
  records, not in the `.webpage.copy.html` markup. Do not attempt to express them as
  additional Liquid attributes.
- Conditions and redirect steps are configured only through the Portal Management app;
  do not attempt to represent them in this component's markup.

## Editing

Identify one exact `{% webform name:'...' %}` tag by page, section, column, and nearby
content. Change only the requested tag (its `name`, or its position). Preserve surrounding
Liquid, HTML, siblings, indentation, and line endings. Do not retarget a tag to a different
multistep form unless the request explicitly asks for that record swap.

## Verification

1. Confirm the tag uses `webform` (not `entityform` or `include 'entity_list'`).
2. Confirm `name` exactly matches the target multistep form's `adx_name`.
3. Confirm each requested instance appears once in the correct position.
4. Confirm unrelated content, other locales, and other pages are unchanged.

## Documentation

- [Multistep forms](https://learn.microsoft.com/power-pages/getting-started/multistep-forms)
- [Tutorial: Add a multistep form to your page](https://learn.microsoft.com/power-pages/getting-started/tutorial-add-multi-step-form)
- [Define multistep form properties](https://learn.microsoft.com/power-pages/configure/multistep-form-properties)
- [Configuring table permissions](https://learn.microsoft.com/power-pages/security/table-permissions)
