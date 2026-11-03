# List Component

Use this reference only to add or edit the markup for the **List** component:

```liquid
{% include 'entity_list' key: '<list name>' isModern:'true' %}
```

The underlying Dataverse/PAC record and serialized folder are named **List** (classic
`entitylist`/`adx_entitylist`). This reference does not cover the Form component
(`{% entityform name: '...' %}`, see `design-studio-basic-form-component.md`) or the
Multistep form component (`{% webform name: '...' %}`, see
`design-studio-multistep-form-component.md`).

## Scope: reference an existing list only

The **+ New list** flow creates a new Dataverse table view and the list record
itself — neither of which can be authored from local YAML alone. This skill therefore only
inserts, moves, or edits the `{% include 'entity_list' %}` tag that points at a list
**already present in the downloaded site**:

```text
lists/<list-file-name>.list.yml
```

If the request needs a list that is not already downloaded, do not create a `.list.yml` file
locally to simulate it, and do not query Dataverse (API, SDK, Web API, or CLI) or ask the
user for a view GUID, table permission, or any other record detail in order to assemble it
yourself — this skill only references a list file already serialized under `lists/` by a
prior `pac pages download`; it does not help construct, fetch, or synthesize one. Stop and
tell the user to create the list in the Data workspace, Design Studio, or the Management app
and re-download the site before this component can reference it. Do not invent a
plausible-looking list name. If asking the user how to proceed, never present "create a new
list" as a selectable option — only embedding an existing list, or stopping, are valid
choices.

## Resolving the exact list name

1. List `lists/*.list.yml` and find the file matching the request.
2. Read the file and use its exact `adx_name` value as the tag's `key` argument — not the
   file name, which PAC CLI can slugify, truncate, or escape differently.
3. Note `adx_entityname` (the bound Dataverse table) to confirm it matches the request's
   intended data source.
4. An empty `{% include 'entity_list' key: '' isModern:'true' %}` tag is a valid state (a
   List component added without selecting a backing list yet); treat it as unresolved, not
   as evidence of a broken page.

## Markup

```liquid
{% include 'entity_list' key: 'Accounts: Active Accounts' isModern:'true' %}
```

Modern list is the default experience for lists added to new sites and supports an optional
Copilot-powered AI summary. `isModern` is optional on the tag — when adding a new list
component without a stated experience, mirror the current default (`isModern:'true'`); when
editing an existing tag, leave `isModern` exactly as found (present, absent, or `'false'`)
unless the request asks to change the experience:

```liquid
{% include 'entity_list' key: 'Accounts: Active Accounts' isModern:'true' AISummaryTitle:'AI Insights' isAISummaryExpanded:'true' AISummaryChartTypes:'[1,2,3,4,5]' isAISummaryEnabled:'true' isNLSearchEnabled:'true' %}
```

| Attribute | Purpose |
|---|---|
| `key` | Exact `adx_name` of the target list record. Required. |
| `isModern` | Optional. `'true'` selects the modern list experience, `'false'` selects classic. |
| `isAISummaryEnabled` | Turns the AI-generated summary panel on or off. |
| `AISummaryTitle` | Localized heading for the AI summary panel. |
| `isAISummaryExpanded` | Whether the AI summary panel starts expanded. |
| `AISummaryChartTypes` | JSON array of enabled chart type IDs for the AI summary. |
| `isNLSearchEnabled` | Turns on natural-language search within the list. |

- Place the tag directly inside the selected `.columnBlockLayout` or Flex Container.
- Treat it as a leaf component; do not add child markup, pagination controls, or a
  hand-written table around it.
- Preserve existing attribute order and quote style when editing.
- Only add the AI-summary attributes to a tag with `isModern:'true'`; they have no effect on
  classic lists. If `isModern` is absent on the tag you're editing, confirm the rendered
  experience (or ask) before adding them, rather than assuming either default.
- Escape the selected Liquid string delimiter inside `key` and attribute values.

## Requirements

- The list's bound table must already have table permissions configured for the intended
  web roles; this component does not create them.
- List actions (create, view, edit, delete), list filters, and the number-of-records-per-page
  setting live on the list record's `adx_settings`/`adx_views` JSON, not as separate Liquid
  attributes. Do not attempt to express them inline.

## Editing

Identify one exact `{% include 'entity_list' key:'...' ... %}` tag by page, section, column,
and nearby content. Change only the requested attribute(s) or position. Preserve surrounding
Liquid, HTML, siblings, indentation, and line endings. Do not retarget `key` to a different
list unless the request explicitly asks for that record swap.

## Verification

1. Confirm the tag is `{% include 'entity_list' ... %}` (not `entityform` or `webform`).
2. Confirm `key` exactly matches the target list's `adx_name`.
3. Before adding or keeping AI-summary attributes, confirm the tag has `isModern:'true'`.
4. Confirm each requested instance appears once in the correct position.
5. Confirm unrelated content, other locales, and other pages are unchanged.

## Documentation

- [Add lists](https://learn.microsoft.com/power-pages/getting-started/add-list)
- [Tutorial: Add a list to a page](https://learn.microsoft.com/power-pages/getting-started/tutorial-add-list-to-page)
- [Configuring table permissions](https://learn.microsoft.com/power-pages/security/table-permissions)
