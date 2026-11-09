# Generative AI Search Component

Use this reference only to add or edit:

```liquid
{% codecomponent name:Pages.SearchSummary ... %}
```

Do not use it for `{% include 'Search' %}`, Search web templates, Search content snippets,
the Search Results page record, site markers, or search indexing/settings.

## Markup

```liquid
{% codecomponent name:Pages.SearchSummary enableRedirectToSearchPage:'true' %}
```

The designated Search Results page uses:

```liquid
{% codecomponent name:Pages.SearchSummary %}
```

- Keep `name:Pages.SearchSummary`.
- Place the tag directly inside the selected `.columnBlockLayout` or Flex Container.
- Treat it as a leaf component; do not add child markup or a custom search form.
- Allow multiple instances. Each instance keeps independent attributes.
- Do not impose a column width, breakpoint, padding, or margin.

## Attributes

Attributes are independently composable:

| Behavior | Attribute | Value |
|---|---|---|
| Show results inline | `enableRedirectToSearchPage` | `'false'` |
| Redirect to the Search Results page | `enableRedirectToSearchPage` | `'true'` |
| Search placeholder | `placeholderText` | Localized text |
| Summary heading | `searchSummaryHeading` | Localized text |
| Results heading | `searchResultHeading` | Localized text; Search Results page only |
| Component styles | `searchStyles` | Base64-encoded JSON |

Example:

```liquid
{% codecomponent name:Pages.SearchSummary enableRedirectToSearchPage:'false' placeholderText:'What would you like to search?' searchSummaryHeading:'Summary' %}
```

- Escape the selected Liquid string delimiter and backslashes.
- Preserve existing attribute order, quote style, and unrelated attributes.
- Preserve existing `enableFeedback`, `enableFollowUpActions`, `searchInputId`, and
  `enableSearchResults`; do not add them.

## Search Results page

- Identify it through the website's `Search` site marker.
- Use `searchResultHeading` and `SearchResults` styles only on that page.
- Omit `enableRedirectToSearchPage` there unless preserving existing markup.
- A website has one designated Search Results page.
- Do not create or reassign the site marker during a component edit.

## Styles

`searchStyles` decodes to:

```json
{
  "SearchBar": {},
  "SearchSummary": {},
  "SearchResults": {}
}
```

| Sector | Properties |
|---|---|
| `SearchBar` | `border`, `borderRadius`, `backgroundColor`, `box-shadow`, `display`, `position`, `width`, `height`, `minWidth`, `minHeight`, `maxWidth`, `maxHeight`, `margin`, `padding`, `top`, `right`, `bottom`, `left`, `fontFamily`, `fontWeight`, `fontSize`, `letterSpacing`, `fontHeight` |
| `SearchSummary` | Search Bar properties plus `gap`, `flexGrow`, `flexShrink`, `FlexBasis` |
| `SearchResults` | `fontSize`, `kerning`, `lineHeight` |

For a style edit:

1. Decode the existing value; stop on invalid base64 or JSON.
2. Preserve unknown sectors and properties.
3. Change only requested values.
4. Serialize compact JSON and base64-encode it.
5. Replace only the `searchStyles` value.

Do not edit the runtime-generated component DOM.

## Requirements

- Dataverse search must be enabled for the environment. This is an environment-level feature, not a site setting.
- Site search must be enabled for the website (site setting `Search/EnableDataverseSearch`).
- **Enable Site search with generative AI** must be on in the Setup workspace (site setting `Search/EnableGenerativeAI`).
- Tenant governance must allow generative AI usage for the website.
- The feature must be available for the website's region and language.
- The Dataverse search index must be provisioned and synchronized.
- Redirect mode requires a valid page assigned to the `Search` site marker.
- Faceted search is unavailable with Generative AI Search.

For Dataverse table content, the selected table must be included in the search source. Citation
links require an associated page that uses `id` as its record query-string parameter. Generative
summaries use unstructured content such as multiline text columns or files.

Before adding the component, inspect available site settings and downloaded metadata. Report
environment, tenant, region/language, or index readiness that can't be verified locally. Do not
enable search, change governance, configure indexing, or reassign site markers during a component
edit.

## Editing

Identify one exact `{% codecomponent name:Pages.SearchSummary ... %}` tag by page, section,
column, attributes, and nearby content. Change only the requested tag or its position. Preserve
surrounding Liquid, HTML, siblings, indentation, and line endings.

## Verification

1. Confirm `name:Pages.SearchSummary`.
2. Confirm each requested instance appears once in the correct position.
3. Confirm redirect behavior and localized text.
4. Confirm Search Results-only attributes are used only on the designated page.
5. Decode and verify `searchStyles`.
6. Confirm unrelated content, site configuration, pages, and locales are unchanged.

## Documentation

- [Add a search component](https://learn.microsoft.com/power-pages/getting-started/add-search)
- [Power Pages search with generative AI](https://learn.microsoft.com/power-pages/configure/search/generative-ai)
- [Power Pages search prerequisites](https://learn.microsoft.com/power-pages/configure/search/overview#pre-requisite)
- [Control generative AI usage](https://learn.microsoft.com/power-pages/admin/copilot-governance)
- [Generative AI search FAQ](https://learn.microsoft.com/power-pages/faqs-generative-ai-search)
