# Basic Form Component

Use this reference only to add or edit the markup for the **Form** component (the
underlying Dataverse/PAC record and serialized folder are named **Basic Form**):

```liquid
{% entityform name: '<basic form name>' %}
```

This component renders one existing basic form record. This reference does not cover the
Multistep form component (`{% webform name: '...' %}`, see
`design-studio-multistep-form-component.md`) or the List component
(`{% include 'entity_list' ... %}`, see `design-studio-list-component.md`).

## Scope: reference an existing basic form only

The **+ New form** flow creates a new Dataverse table form, a table-permission
record, and the basic form record itself — none of which can be authored from local YAML
alone. This skill therefore only inserts, moves, or edits the `{% entityform %}` tag that
points at a basic form **already present in the downloaded site**:

```text
basic-forms/<basic-form-directory>/<basic-form-directory>.basicform.yml
```

If the request needs a basic form that is not already downloaded, do not create a
`.basicform.yml`/`.basicformmetadata.yml` pair locally to simulate it, and do not query
Dataverse (API, SDK, Web API, or CLI) or ask the user for a Dataverse form ID, table
permission, or any other record detail in order to assemble it yourself — this skill only
references a form already serialized under `basic-forms/` by a prior `pac pages download`;
it does not help construct, fetch, or synthesize one. Stop and tell the user to create the
form in the Data workspace, Design Studio, or the Management app and re-download the site
before this component can reference it. Do not invent a plausible-looking form name. If
asking the user how to proceed, never present "create a new form" as a selectable option —
only embedding an existing form, or stopping, are valid choices.

## Resolving the exact form name

1. List `basic-forms/` and find the directory matching the request.
2. Read `<directory>.basicform.yml` and use its exact `adx_name` value as the tag's `name`
   argument — not the directory name, which PAC CLI can slugify or truncate.
3. Note `adx_entityname` (the bound Dataverse table) to confirm it matches the request's
   intended data source.
4. An empty `{% entityform name: '' %}` tag is a valid state (a Form component added
   without selecting a backing form yet); treat it as unresolved, not as evidence of a
   broken page.

## Markup

```liquid
{% entityform name: 'Simple Contact Us Form' %}
```

- Place the tag directly inside the selected `.columnBlockLayout` or Flex Container.
- Treat it as a leaf component; do not add child markup, duplicate field markup, or a
  hand-written `<form>` around it.
- Allow multiple instances of the same basic form on one page only when the request asks for
  it; by default, treat each basic form as rendered once per page.
- Do not impose a column width, breakpoint, padding, or margin.
- Escape the selected Liquid string delimiter.
- Preserve existing attribute order and quote style when editing.

## Requirements

- The basic form's bound table must already have table permissions configured for the
  intended web roles; this component does not create them.
- Attachment, CAPTCHA, AI form-fill, and code-component field settings live on the basic
  form/Dataverse-form record, not in the `.webpage.copy.html` markup. Do not attempt to
  express them as additional Liquid attributes.
- `adx_entityformid` binds the basic form to its Dataverse form definition; do not edit it
  through this component — that is a basic-form-record change, not a page-content change.

## Editing

Identify one exact `{% entityform name:'...' %}` tag by page, section, column, and nearby
content. Change only the requested tag (its `name`, or its position). Preserve surrounding
Liquid, HTML, siblings, indentation, and line endings. Do not retarget a tag to a different
basic form unless the request explicitly asks for that record swap.

## Verification

1. Confirm the tag uses `entityform` (not `webform` or `include 'entity_list'`).
2. Confirm `name` exactly matches the target basic form's `adx_name`.
3. Confirm each requested instance appears once in the correct position.
4. Confirm unrelated content, other locales, and other pages are unchanged.

## Documentation

- [Add forms](https://learn.microsoft.com/power-pages/getting-started/add-form)
- [Tutorial: Add a form to a page](https://learn.microsoft.com/power-pages/getting-started/tutorial-add-form-to-page)
- [Configuring table permissions](https://learn.microsoft.com/power-pages/security/table-permissions)
