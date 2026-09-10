# Design Studio Text Component

Shared reference for skills that add or edit text on a Power Pages Design Studio page in
a PAC CLI-downloaded declarative site. This reference applies to sites with a root-level
`.portalconfig` directory and localized webpage content under `web-pages/`.

First follow `${PLUGIN_ROOT}/references/design-studio-component-authoring.md`: derive the
page, locale, target text or insertion point, content, style, formatting, and links from
the user's prompt and existing markup; use engineering judgment for safe mechanical
details; ask only about material ambiguity. This reference supplies text-specific markup,
edit boundaries, safety, preservation, and verification rules.

Microsoft Learn documents the text component's authoring capabilities. The exact
section and column markup below comes from PAC-downloaded Design Studio page samples;
Microsoft Learn does not specify this serialized HTML contract.

## Target file contract

Edit only the selected localized content file:

```text
web-pages/<page-directory>/content-pages/<Page>.<locale>.webpage.copy.html
```

Do not substitute the page-level `<Page>.webpage.copy.html`. It belongs to the root
webpage record and can be empty or differ from the localized page body.

The calling skill is responsible for selecting the page and language, validating the
localized record against its root webpage, and obtaining approval for the exact insertion
point before using this reference.

## Text component contract

A basic paragraph text component serializes as a paragraph inside a
`.columnBlockLayout`:

```html
<p>Enter text</p>
```

`Enter text` is only Design Studio placeholder text. Replace it with the user's
HTML-escaped content:

```html
<p>Applications close on September 30.</p>
```

The text can contain any user-provided wording; it is not restricted to the placeholder.
Do not leave `Enter text` in the final markup unless the user explicitly requested those
words.

When inserting text into an existing section, add only the approved text element at the
approved position inside the selected `.columnBlockLayout`. Do not wrap it in another
section, container, or column.

## OOB section layouts

Design Studio provides five column layouts: one column, two equal columns, three equal
columns, one-third left, and one-third right. Their shared PAC-observed HTML is defined in
`${PLUGIN_ROOT}/references/design-studio-section-layouts.md`.

Do not add empty sibling columns when inserting text into an existing multi-column
section; add only the text element to the selected existing column. When creating a new
multi-column section, replace the shared template's `<!-- COMPONENT_HTML -->` marker
with the approved text element and preserve the empty sibling columns.

## Text styles

Microsoft Learn lists these Design Studio text styles:

- Title
- Heading 1
- Heading 2
- Heading 3
- Subheading 1
- Subheading 2
- Paragraph
- Small text

Use `<p>` for the baseline paragraph component demonstrated by the PAC sample. For another
style, first inspect an existing text component with that style in the downloaded site and
reuse its exact tag, classes, and inline-style pattern. Microsoft Learn documents the
available style names but not their exact exported HTML, so do not guess a serialization.

Preserve semantic heading order. Do not choose a heading level merely to make text look
larger; use the site's established styles or CSS when the request is purely visual.

## Formatting and alignment

Design Studio supports bold, italic, underline, alignment, and theme-palette colors.
When the user requests formatting:

- apply it only to the selected text;
- reuse markup and inline-style patterns already present in the downloaded site;
- preserve inherited theme colors unless the user explicitly selects another palette color;
- do not add arbitrary fonts, sizes, or colors that are absent from the request;
- do not convert the whole paragraph when only a phrase needs formatting.

If exact Design Studio serialization for a requested format is not observable in the
downloaded site, stop and ask for a Design Studio-generated example rather than inventing
platform-specific markup.

## Links within text

Microsoft Learn supports linking selected text to either a URL or another page in the
same site. Keep surrounding text inside the paragraph:

```html
<p>Read the <a href="/application-guide">application guide</a> before you apply.</p>
```

For external links, require an absolute URL including its scheme:

```html
<p>Visit the <a href="https://example.com/help">help center</a> for assistance.</p>
```

- Reject active-content schemes such as `javascript:`, `data:`, and `vbscript:`.
- Prefer HTTPS for external web destinations.
- Add `target="_blank" rel="noopener noreferrer"` only when the user explicitly chooses
  new-window behavior.
- Make linked text describe its destination; avoid "click here."
- If the user requests a Design Studio link-style override, reuse an observed local style.
  Do not invent a class because Microsoft Learn does not document the exported class mapping.

## Content safety and accessibility

- HTML-escape user-provided plain text before insertion, including `&`, `<`, and `>`.
- Treat HTML supplied by the user as markup only when they explicitly request rich HTML and
  it passes the same safety review as surrounding authored content.
- Do not introduce scripts, event-handler attributes, iframes, or active embedded content.
- Preserve meaningful paragraph and heading semantics.
- Do not use `<br>` repeatedly to simulate separate paragraphs; use separate `<p>` elements.
- Do not add empty headings or empty paragraphs as spacing controls.
- Preserve intentional Liquid expressions and HTML entities already in the target file.
- Apply localized text only to the selected locale. Never copy one language's wording into
  every localized content page automatically.

## Editing an existing text component

The calling skill must identify the exact text element or text range before editing it.
Report the selected element's section, column, tag, current text, nearby content, and any
formatting or link markup. If repeated text creates multiple candidates, require the user
to select one; never use a global text replacement.

Use the narrowest edit boundary that satisfies the request:

- wording change: replace only the selected text node and preserve its containing tag,
  links, inline styles, and sibling markup;
- style change: change only the selected text component's observed tag/classes/styles;
- formatting change: wrap or unwrap only the selected phrase;
- link change: update, add, or remove only the selected `<a>` element while preserving
  surrounding paragraph text;
- alignment or color change: edit only the relevant observed style declaration or class.

HTML-escape replacement text unless the user explicitly approved rich HTML. Preserve
spaces and punctuation around inline elements so words do not run together after an
edit. When removing a link, keep its visible text in place. When replacing an entire
paragraph or heading, preserve its tag unless a semantic style change was explicitly
approved.

Do not change heading levels merely to alter visual size. Do not collapse multiple
paragraphs into one or split a paragraph unless requested. If the selected text contains
Liquid, entities, or nested markup that makes the replacement boundary ambiguous, stop
and show the exact before/after fragment for approval.

## Preserve the existing page

- Read the complete target file before editing.
- Make the smallest possible insertion.
- Preserve existing sections, columns, Liquid, classes, `data-*` attributes, inline styles,
  indentation, and line endings.
- Do not reformat unrelated markup.
- Insert content only at the exact approved section, column, and relative position.
- Add a new section only when the user explicitly approved its layout.

## Verification checklist

After editing:

1. Re-read the complete localized `.webpage.copy.html` file.
2. Confirm all previous content remains.
3. Confirm the text is inside the approved `.columnBlockLayout`.
4. Confirm the inserted wording matches the user's text and contains no unintended
   `Enter text` placeholder.
5. Confirm dynamic plain text and link attributes are correctly escaped.
6. Confirm heading semantics and requested formatting are correct.
7. Confirm links use an approved site-relative path or safe absolute scheme.
8. For an edit, confirm only the selected text range or component properties changed and
   surrounding inline markup remains valid.
9. Confirm no other locale or page-level copy changed.
10. Review the local diff before any `pac pages upload`.

Editing the downloaded file changes only the local copy. A skill using this reference
must not upload or deploy unless the user separately requests and approves that action.

## Microsoft documentation

- [Add text](https://learn.microsoft.com/power-pages/getting-started/add-text)
