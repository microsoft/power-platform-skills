# Design Studio Component Authoring

Shared decision rules for skills that add or edit Design Studio components in
PAC CLI-downloaded declarative Power Pages sites.

## Start with the user's prompt

Read the complete user request before asking questions or choosing markup. Extract and
retain every detail the user already supplied, including:

- page and locale;
- existing component text, source, URL, or nearby content that identifies the target;
- whether to add a component or edit an existing one;
- section layout, column, and relative position;
- requested content, behavior, appearance, and accessibility details;
- properties the user explicitly wants preserved.

Do not ask the user to repeat a detail that is clear from the prompt. Examples in a
component reference illustrate markup; they do not override the user's requested values.

## Inspect before deciding

Read the complete selected localized `.webpage.copy.html` and relevant YAML or web-file
metadata. For an edit, find candidate components using both the prompt and the local
markup. Use section number, column, nearby heading/text, current properties, and sibling
components to distinguish candidates.

If the prompt uniquely identifies one component or insertion point, use it. If several
candidates remain plausible, present concise distinguishing details and ask the user to
choose. Never apply a broad search-and-replace merely because multiple components share
the same label, URL, filename, or class.

## Use engineering judgment

Use sound judgment for low-risk implementation details that follow directly from the
request, the target page's conventions, and these references. Examples include:

- preserving existing indentation, attribute order, and line endings;
- retaining unspecified classes, styles, attributes, and sibling components;
- selecting the documented markup form that matches the requested source type;
- escaping text and attributes;
- adding required safe-link or accessibility attributes;
- using an existing page-local convention when it differs harmlessly from an example.

Do not interrupt the user for mechanical choices with one safe, conventional answer.
Do not invent content, destinations, sources, layout placement, visual design, destructive
cleanup, or behavior that changes the user's intent.

Ask a focused question only when the missing detail could materially change:

- which page, locale, component, section, or column is modified;
- user-visible content or navigation;
- security, privacy, accessibility, or external-resource behavior;
- whether existing content is moved, replaced, or deleted;
- a structural layout mapping where more than one result is reasonable.

## Add versus edit

For an add request, insert the smallest valid component markup at the resolved location.
Create a new section only when the prompt requires one or no suitable existing placement
exists and the calling workflow resolves that choice.

For an edit request:

1. Identify the narrowest component boundary that contains the requested property.
2. Change only requested properties plus mechanically required companion attributes.
3. Preserve every unspecified property and surrounding node.
4. Do not modernize, reformat, relocate, or clean up unrelated markup.
5. Verify exactly one intended target changed unless the prompt explicitly requests a
   batch edit.

If the user's prompt already contains a clear, local, reversible edit, do not invent a
second confirmation requirement. Follow any approval gate explicitly defined by the
calling `SKILL.md`; references do not create or bypass workflow gates.

## Before writing

Resolve and retain:

- the exact localized target file;
- whether this is add, edit, move, replace, or delete;
- the exact target component or insertion boundary;
- the final property values derived from the prompt;
- any material assumption made through engineering judgment.

Surface assumptions only when they affect the result. Then apply the smallest change and
use the component reference's verification checklist.
