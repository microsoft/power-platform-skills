# Design Studio Content Snippet Authoring

Canonical reference for workflows that create or modify content snippets in a PAC
CLI-downloaded declarative Power Pages site. This reference applies to sites with a
root-level `.portalconfig` directory, `website.yml`, `websitelanguage.yml`, and
`content-snippets/` content. It does not apply to Power Pages code sites built with
React, Angular, Vue, or Astro.

A content snippet is a small, reusable value that can be rendered from a webpage or web
template by its logical name. In multilingual sites, translatable snippets are normally
represented by separate language-specific records. PAC downloads can also contain
language-neutral records with no language binding. Snippets can contain plain text,
HTML, Liquid, or a combination of HTML and Liquid. They are appropriate for
maker-managed content such as labels, messages, logos, headings, and shared header or
footer regions.

## Content snippet creation workflow

Create a content snippet in this order:

1. Resolve `<SITE_ROOT>` by following
   `${PLUGIN_ROOT}/references/design-studio-site-discovery.md`, requiring
   `content-snippets/` and `websitelanguage.yml`.
2. Treat `websitelanguage.yml` as the authoritative set of enabled website languages.
   Join each record's `adx_portallanguageid` to `.portalconfig/portallanguage.yml` to
   map its website-language ID to a locale code; never invent either value.
3. Read all existing content-snippet metadata and value files.
4. Resolve the logical name, display name, type, intended rendering context, callers,
   and whether the record is localized or intentionally language-neutral. For
   localized content, resolve the translated value for every target language.
5. Reject a duplicate logical name in the same localized or language-neutral scope.
   Filesystem suffixes do not make duplicate runtime lookup names safe.
6. Generate one content-snippet UUID per new record with
   `${PLUGIN_ROOT}/scripts/generate-uuid.js`.
7. For a new translatable snippet, create one localized record per enabled website
   language unless the request explicitly limits the language scope. Create its value
   file according to the empty/non-empty and Text/HTML rules below. Create a
   language-neutral record only when that scope is intentional and consistent with the
   site's established usage.
8. Create or update only the separately approved webpage or web-template callers.
9. Verify identity, localization, type, Liquid, escaping, and all name-based
   dependencies.

Creating a content snippet does not make it visible. A webpage or web template must
render it by name.

## Record and localization model

A translatable logical snippet is represented by a separate Dataverse content-snippet
record for each website language:

```text
Announcement
├── English record: name Announcement, language en-US, unique UUID
├── French record:  name Announcement, language fr-FR, unique UUID
└── German record:  name Announcement, language de-DE, unique UUID
```

All translations must:

- use the same `adx_name`;
- normally use the same `adx_display_name`;
- use the same Text or HTML type;
- use different `adx_contentsnippetid` values;
- reference the existing website-language ID for their locale;
- contain a value written for that language.

The current site language selects the matching record. The snippet name is the stable
lookup key; the translated value is not.

Do not copy the default-language record ID into another language. Do not point every
translation at the default website-language ID.

### Language-neutral records

Some PAC downloads contain content-snippet records that:

- omit `adx_contentsnippetlanguageid`;
- omit the locale segment from the metadata and value filenames;
- retain one website-wide value rather than one record per configured language.

Treat this as a distinct record scope, not as a malformed localized record. Preserve an
existing language-neutral record's missing language binding and filename shape during
ordinary edits. Do not add the default website-language ID merely because the site is
multilingual.

For new visitor-facing text, prefer localized records so each configured language can
own an appropriate value. Use a language-neutral record only when the value is
deliberately shared across languages, the site already uses that pattern for the same
kind of content, and callers do not require translated output. Do not assume or invent
runtime precedence when a language-neutral record and a localized record share the same
`adx_name`.

## PAC download structure

Each localized record is stored under `content-snippets/`:

```text
<site-root>/
├── .portalconfig/
│   └── portallanguage.yml
├── website.yml
├── websitelanguage.yml
└── content-snippets/
    └── <snippet-directory>/
        ├── <Snippet-Stem>.<locale>.contentsnippet.yml
        └── <Snippet-Stem>.<locale>.contentsnippet.value.html
```

The files have separate responsibilities:

- `.contentsnippet.yml` stores identity, language, name, and type.
- `.contentsnippet.value.html` stores the complete value.

PAC uses the `.value.html` suffix for exported values even when `adx_type` is Text. The
suffix describes the serialized value file, not the content-snippet type. Determine the
type from metadata.

A language-neutral PAC record uses the same pair without a locale segment:

```text
content-snippets/<snippet-directory>/
├── <Snippet-Stem>.contentsnippet.yml
└── <Snippet-Stem>.contentsnippet.value.html
```

Its metadata omits `adx_contentsnippetlanguageid`. Filename shape and metadata must
agree: a locale-suffixed record requires the matching language binding, while a
language-neutral record has neither.

An intentionally empty Text snippet can be represented by metadata without a value
file. An empty HTML snippet can retain an adjacent empty value file. Once either type
has a non-empty value, create and maintain the adjacent value file rather than adding
an `adx_value` field to YAML.

## Language mapping

Resolve language data from the downloaded site:

- `.portalconfig/portallanguage.yml` provides locale codes such as `en-US`.
- `websitelanguage.yml` identifies the languages enabled for the website.
- For a localized record, `adx_contentsnippetlanguageid` must reference the existing
  website-language record for the file's locale.

Map the files by stable IDs:

1. Start with one enabled record from `websitelanguage.yml`.
2. Read its `adx_websitelanguageid` for
   `adx_contentsnippetlanguageid`.
3. Match its `adx_portallanguageid` to the same ID in
   `.portalconfig/portallanguage.yml`.
4. Use the matched `adx_languagecode` as the filename locale.

Do not join the files by translated display names when the ID relationship is
available. Do not create a snippet for a portal-language entry that has no enabled
website-language record.

For example:

```yaml
# .portalconfig/portallanguage.yml
- adx_languagecode: en-US
  adx_portallanguageid: <english-language-id>
```

```yaml
# websitelanguage.yml
- adx_name: English
  adx_portallanguageid: <english-language-id>
  adx_websitelanguageid: <english-website-language-id>
```

The localized snippet filename uses `en-US`, while its metadata uses
`<english-website-language-id>`.

Do not derive the ID from the locale text, use the website default-language ID for all
locales, or create a new language record as part of routine snippet authoring.
Do not add a language ID to an existing language-neutral record as routine cleanup.

## Naming convention

`adx_name` is the functional Liquid lookup key. Preserve its intended spelling,
spacing, slash characters, and casing.

When creating a snippet with no stronger site-local filename convention:

- directory name: replace spaces and `/` with `-`, then lowercase;
- file stem: split on spaces and `/`, capitalize each segment's first character, and
  join the segments with `-`;
- locale: use the exact configured language code;
- metadata name: preserve the intended logical name exactly.

For example:

```text
adx_name: Search/NoResults

content-snippets/search-noresults/
├── Search-NoResults.en-US.contentsnippet.yml
└── Search-NoResults.en-US.contentsnippet.value.html
```

Names containing spaces or `/` require bracket lookup syntax in Liquid:

```liquid
{{ snippets["Search/NoResults"] }}
{{ snippets["Site name"] }}
```

Do not change `adx_name` merely to make its directory or filename more convenient.

### Filesystem collisions

Different logical names can normalize to the same directory or file stem. Existing PAC
downloads can also contain duplicate records whose directories and stems are suffixed
with part of their record IDs:

```text
content-snippets/site-name_902e22ac/
└── Site-name_902E22AC.en-US.contentsnippet.yml
```

A suffix distinguishes files only. Liquid still resolves the record by `adx_name`.

For a new snippet:

1. Require its logical name to be unique for every target language.
2. Check the normalized directory and stem separately for filesystem collisions.
3. If a different unique logical name normalizes to an occupied path, append a stable
   UUID-derived suffix to the directory and stem.
4. Do not append the suffix to `adx_name`.

Preserve existing suffixed paths during ordinary edits. Do not rename them as cleanup.

## Content snippet YAML

Create one localized metadata file per target language:

```yaml
adx_contentsnippetid: <new-language-specific-snippet-id>
adx_contentsnippetlanguageid: <existing-website-language-id>
adx_display_name: <display-name>
adx_name: <logical-name>
adx_type: <type-value>
```

Type values are:

| Type | `adx_type` |
|---|---:|
| Text | `756150000` |
| HTML | `756150001` |

Some downloaded Text snippets omit `adx_type`, relying on the Text default. Preserve
that shape during unrelated edits. For a new record, follow the site's existing
serialization convention; when explicit typing is used, use `756150000` for Text.
HTML snippets must use `756150001`.

An intentionally language-neutral record omits the language field and locale suffix:

```yaml
adx_contentsnippetid: <new-language-neutral-snippet-id>
adx_display_name: <display-name>
adx_name: <logical-name>
adx_type: <type-value>
```

### Metadata rules

- `adx_contentsnippetid` must be a new, unique UUID for each language.
- For a localized record, `adx_contentsnippetlanguageid` must resolve to the file
  locale's existing website-language record.
- For a language-neutral record, omit `adx_contentsnippetlanguageid` and the filename
  locale together.
- `adx_name` must be the exact name used by Liquid callers.
- `adx_display_name` is maker-facing and normally matches the logical name.
- All language variants should use the same type.
- Preserve unknown or optional fields already serialized by PAC.
- Do not add an `adx_websiteid`; the downloaded site root provides website context.
- Do not add `adx_value` when the value is represented by the adjacent value file.

## Value file

Store the complete snippet value at:

```text
content-snippets/<snippet-directory>/
└── <Snippet-Stem>.<locale>.contentsnippet.value.html
```

The value file can contain:

- plain text;
- HTML;
- Liquid output and control-flow expressions;
- references to other snippets;
- references to supported Power Pages Liquid objects.

Despite the `.html` suffix, a Text snippet's value must follow Text semantics and should
not depend on HTML markup.

Do not add frontmatter, metadata, Markdown fences, or wrapper elements unless they are
part of the intended rendered value.

## Choosing Text or HTML

Choose the narrowest type that matches the intended authoring and rendering behavior.

### Text

Use Text for labels, titles, alternative text, URLs, short messages, and other values
that should not require rich-text markup:

```text
No results found.
```

Text values can contain Liquid. The caller remains responsible for evaluating Liquid
when required and encoding the result for its output context.

### HTML

Use HTML when the value intentionally owns markup:

```html
<p>Copyright &copy; {{ now | date: 'yyyy' }}. All rights reserved.</p>
```

HTML snippets can also contain Liquid control flow and references to other snippets:

```liquid
<a href="~/">
  {% if snippets["Logo URL"] %}
    <img
      src="{{ snippets["Logo URL"] | escape }}"
      alt="{{ snippets["Logo alt text"] | escape }}">
  {% endif %}
  {% if snippets["Site name"] %}
    <span>{{ snippets["Site name"] | escape }}</span>
  {% endif %}
</a>
```

Treat HTML snippets as executable presentation content. Review their markup, Liquid,
URLs, accessibility, and script behavior with the same care as a web template.

Do not use HTML merely because PAC stores the value in a `.value.html` file.

## Rendering snippets with Liquid

Power Pages supports several snippet rendering patterns. Use the pattern that matches
the caller's purpose and preserve the site's established syntax.

### Direct lookup

Render a snippet by logical name:

```liquid
{{ snippets["Announcement"] }}
```

Bracket syntax is required for names containing spaces, slashes, or other characters
that are not valid in dot notation.

Use a default when the snippet can be absent or empty:

```liquid
{{ snippets["Search/NoResults"] | default: "No results found." | escape }}
```

Apply escaping after the default so both possible values are encoded.

### Editable snippet

Use the editable tag when authorized makers should be able to edit the snippet through
supported inline authoring experiences:

```liquid
{% editable snippets 'Footer' type: 'html' %}
```

Keep the declared editable type aligned with the content-snippet metadata. Do not mark a
Text snippet as HTML merely to render it.

Editable output can add authoring markup for users with editing permissions. Do not
assume its generated HTML is identical to a direct lookup in every context.

### Snippet include

Use the built-in snippet include when the value is intended to be processed as a snippet
template:

```liquid
{% include 'snippet' snippet_name: 'AccountData' %}
```

This pattern is useful for values containing Liquid that must be evaluated rather than
displayed as literal template text.

### Explicit Liquid evaluation

Some existing templates retrieve a snippet and then apply the `liquid` filter:

```liquid
{% assign result_count = snippets["Search/ResultsCount"] %}
{{ result_count | liquid }}
```

Use explicit evaluation only when the snippet is intentionally trusted to contain
Liquid. Do not apply `| liquid` to arbitrary user-authored or untrusted content.

## Output-context safety

A snippet's type does not make its output safe for every destination. Encode the final
value for the context where the caller places it.

### HTML text

Escape Text snippets rendered as ordinary text:

```liquid
<span>{{ snippets["Site name"] | escape }}</span>
```

Do not escape an intentional, trusted HTML snippet when markup must render; doing so
would display the tags as text. Review and tightly control who can edit such snippets.

### HTML attributes

Always escape snippet values used in attributes:

```liquid
<img
  src="{{ snippets["Logo URL"] | escape }}"
  alt="{{ snippets["Logo alt text"] | escape }}">
```

Validate URL-valued snippets as URLs as well as escaping them. Do not allow
script-bearing or unsupported schemes.

### JavaScript, CSS, and JSON

Do not place a snippet directly into JavaScript, CSS, or JSON using HTML escaping.
Either:

- use the platform's appropriate context-specific serialization pattern;
- keep the value in HTML data attributes with safe encoding and read it at runtime; or
- avoid using a content snippet in that executable context.

Never treat a maker-editable HTML snippet as trusted script.

## Liquid and data access

Snippet values can use Power Pages Liquid objects and query Dataverse data. When they
do:

- escape values read from user-controlled or untrusted fields;
- request only the data needed for rendering;
- ensure the required table permissions exist;
- do not embed environment-specific record IDs when a stable site marker, setting, or
  other configurable reference is appropriate;
- do not store credentials, access tokens, connection strings, or secrets in snippets;
- preserve fallback behavior when related records or snippets are absent.

Liquid in a snippet can reference another snippet by name. These nested references form
dependencies and must be included in rename and deletion analysis.

Avoid circular snippet references. A snippet must not directly or indirectly render
itself.

## Header and footer caching

Snippets rendered by a cached header or footer can contain request-, page-, language-,
user-, or time-dependent Liquid. The caller must place such output inside a narrowly
scoped `substitution` block:

```liquid
{% substitution %}
  {% include 'snippet' snippet_name: 'User Greeting' %}
{% endsubstitution %}
```

Do not assume dynamic Liquid inside the snippet bypasses header or footer output caching.
Keep the uncached region as small as possible.

## Duplicate logical names

Localized lookup depends on the website, current language, and `adx_name`.
Language-neutral records add another possible scope for the same logical name.
Ordinary snippet Liquid lookup does not select a record by
`adx_contentsnippetid`, so duplicate localized records and overlapping
language-neutral/localized names require explicit runtime verification.

For new records:

- reject an existing `adx_name` in the same language;
- reject an overlapping language-neutral and localized `adx_name` unless the site
  already relies on that exact arrangement and its behavior has been verified;
- do not create a second record and rely on an ID-derived folder suffix;
- add a missing translation to the existing logical snippet instead.

When a downloaded site already contains duplicates:

1. Inventory every record ID, language, type, value, and file path.
2. Identify all callers of the shared logical name.
3. Do not guess which duplicate is active.
4. Modify only the explicitly resolved record when the request identifies one.
5. Do not consolidate or delete duplicates without approval and runtime verification.

A filesystem suffix records an export collision; it does not establish runtime
precedence.

## Modifying an existing content snippet

Resolve the intended record by logical name, language, and UUID before changing it.
Apply the smallest required change.

| Requested change | Required files and checks |
|---|---|
| Change one translation's value | Edit only that locale's value file; preserve metadata and IDs |
| Change all translations' message | Edit every approved locale value independently; do not copy untranslated text blindly |
| Change display name | Update `adx_display_name` only in the approved language records |
| Rename logical snippet | Update `adx_name` for every language and any language-neutral variant, plus every name-based caller; preserve IDs |
| Change Text to HTML | Update type consistently, review markup and trust boundary, and update editable callers |
| Change HTML to Text | Supply an explicit plain-text replacement; do not automatically strip tags |
| Add a language | Generate a new UUID, use the existing language ID, and create the localized pair |
| Remove a language | Remove only that localized record after verifying language behavior and fallback requirements |
| Change a language-neutral value | Edit its unsuffixed value file; preserve the absent language binding |
| Localize a language-neutral snippet | Treat as a scope migration: create language-specific records and verify callers before removing the neutral record |
| Change Liquid behavior | Review nested dependencies, data permissions, escaping, caching, and all rendering contexts |

### Identity preservation

Do not regenerate `adx_contentsnippetid` during a normal value, type, name, or path
change. A new ID represents a new Dataverse record.

Preserve `adx_contentsnippetlanguageid` unless the record is being deliberately moved to
another existing website language. Changing the language ID is not a translation; it
reassigns the record.

Adding a language ID to a language-neutral record or removing one from a localized
record changes lookup scope. Do not make either change as incidental normalization.

### Value changes

Before editing a value:

1. Confirm the metadata and value file belong to the intended UUID and locale.
2. Read the complete value, including Liquid and markup.
3. Identify whether callers render it as text, HTML, an attribute, a URL, or evaluated
   Liquid.
4. Preserve required placeholders, variables, tags, accessibility text, and fallbacks.
5. Change only the requested localized value.

Do not reformat a large HTML/Liquid value for a small copy change.

### Rename safety

A logical-name rename is a dependency migration:

1. Inventory all language records using the old `adx_name`.
2. Confirm the new name is unique in every target language.
3. Search web-template source, localized webpage copy, other snippet values, and other
   text-based site content for exact lookups of the old name.
4. Update `adx_name` in every translation.
5. Rename directories and file pairs only when required to preserve the site convention
   or avoid a collision.
6. Update every confirmed Liquid caller.
7. Preserve all record IDs and language IDs.
8. Re-scan for the old lookup name.

Do not broadly replace a common phrase. The same text can occur as visible content,
another component's name, or an unrelated value.

### Type conversion

Changing type affects authoring and rendering expectations.

For Text to HTML:

- update every language variant and any language-neutral record consistently;
- validate the existing values as intentional HTML or replace them with approved markup;
- review who can edit the snippet;
- update `{% editable %}` callers to the matching type;
- verify direct callers do not escape markup that is now intended to render.

For HTML to Text:

- require an explicit plain-text value for each language and any language-neutral
  variant;
- remove markup and Liquid only when approved;
- update editable callers;
- verify callers escape the resulting text;
- do not preserve HTML tags and assume the platform will remove them safely.

## Adding a translation

To add a locale to an existing logical snippet:

1. Confirm the language already exists in `websitelanguage.yml`.
2. Resolve its locale code and website-language ID.
3. Confirm no record already uses the logical name for that language.
4. Generate a new content-snippet UUID.
5. Create the locale-specific metadata and value files in the logical snippet's
   directory.
6. Copy structure, placeholders, and required Liquid from another locale only as a
   starting contract.
7. Provide a real translation; do not silently ship default-language text as translated
   content.
8. Keep the type and logical name consistent with the other languages.

If a translation is intentionally deferred, document and use the site's established
fallback behavior rather than creating misleading duplicate-language content.

## Deletion rules

Do not delete a content snippet until all dependencies are understood:

1. Search web templates, localized webpage copy, other snippet values, and text-based
   site content for the exact logical name.
2. Search direct lookup, editable, include, assigned-variable, and `| liquid` patterns.
3. Check for defaults that would mask the deletion and confirm whether that fallback is
   intended.
4. Check every language variant, language-neutral record, and duplicate-name record.
5. Remove or migrate approved callers first.
6. Delete the metadata and value file together for each approved record.
7. Delete the directory only when it contains no remaining localized or
   language-neutral records.

Deleting one locale can produce missing or fallback content only in that language.
Deleting all locale records does not remove a same-name language-neutral record.

## Verification checklist

After creating or modifying a content snippet:

1. Confirm every metadata YAML file parses successfully.
2. Confirm every non-empty localized or language-neutral record has a matching
   `.contentsnippet.value.html` file.
3. Confirm each localized filename locale is configured in the site.
4. Confirm each localized `adx_contentsnippetlanguageid` resolves to the matching
   existing website-language record.
5. Confirm every language-neutral record omits both the filename locale and
   `adx_contentsnippetlanguageid`.
6. Confirm every record has a valid, unique `adx_contentsnippetid`.
7. Confirm all translations use the same `adx_name`.
8. Confirm the logical name is unique per website and language and does not
   unintentionally overlap a language-neutral record.
9. Confirm all variants use the intended Text or HTML type.
10. Confirm the directory and file stems do not collide with another logical snippet.
11. Confirm existing records retained their IDs and language scope.
12. Confirm no `adx_value` was added when an adjacent value file is used.
13. Confirm Liquid tags and output delimiters are balanced.
14. Confirm every nested snippet, site marker, setting, template, and data dependency
    exists.
15. Confirm there are no direct or indirect circular snippet references.
16. Confirm untrusted output is escaped for its final context.
17. Confirm HTML markup is valid, accessible, and intentionally trusted.
18. Confirm URL values use allowed schemes and resolve to the intended destination.
19. Confirm data-reading Liquid has the required table permissions.
20. Confirm dynamic header/footer output is protected from caching with a narrowly
    scoped substitution block.
21. Confirm every renamed or deleted lookup was migrated in all callers and record
    scopes.
22. Review the final diff for unrelated snippet, translation, template, or page changes.

## Microsoft documentation

- [Customize content by using content snippets](https://learn.microsoft.com/power-pages/configure/customize-content-snippets)
- [Available Liquid objects](https://learn.microsoft.com/power-pages/configure/liquid/liquid-objects)
- [Liquid overview](https://learn.microsoft.com/power-pages/configure/liquid/liquid-overview)
- [Template tags](https://learn.microsoft.com/power-pages/configure/liquid/template-tags)
- [Enable multiple-language support](https://learn.microsoft.com/power-pages/configure/enable-multiple-language-support)
- [Header and footer output caching](https://learn.microsoft.com/power-pages/configure/enable-header-footer-output-caching)

## Prohibited shortcuts

- Do not create only one language when the requested logical snippet requires all
  configured languages.
- Do not reuse one content-snippet UUID across translations.
- Do not invent or copy the wrong website-language ID.
- Do not map website and portal languages by display name when their IDs are available.
- Do not create records for portal languages that are not enabled in
  `websitelanguage.yml`.
- Do not add or remove `adx_contentsnippetlanguageid` as routine normalization.
- Do not assume precedence between same-name language-neutral and localized records.
- Do not use a filesystem suffix to justify a duplicate logical name.
- Do not infer Text or HTML from the `.value.html` suffix.
- Do not add `adx_value` when PAC stores the value in the adjacent file.
- Do not rename `adx_name` without updating every name-based caller.
- Do not regenerate IDs during value edits, renames, type changes, or path changes.
- Do not render untrusted snippet values without context-appropriate encoding.
- Do not apply `| liquid` to untrusted or arbitrary content.
- Do not store secrets or environment-specific credentials in snippet values.
- Do not delete one or all translations before checking site-wide and nested
  dependencies.
- Do not modify `.portalconfig` manifests during routine content-snippet authoring.
