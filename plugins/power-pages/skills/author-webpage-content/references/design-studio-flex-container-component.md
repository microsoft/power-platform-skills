# Design Studio Flex Container

Use this reference to add or edit a Flex Container in one localized
`.webpage.copy.html` file.

## Markup

Design Studio recognizes a flex container by the `ppFlexContainer` class:

```html
<div class="ppFlexContainer" style="display: flex;"></div>
```

- Keep `ppFlexContainer`.
- Keep `display: flex`.
- Use a non-self-closing `div`.
- Place it inside the selected `.columnBlockLayout` or another Flex Container.
- Allow an empty container when requested.
- Add supported page components as direct children using their component references.
- Preserve child order.
- Allow nested Flex Containers when requested.
- Do not add an extra section, container, or column around it.

## Design Studio behavior

- The container accepts dropped components and can move between columns or Flex Containers.
- Adding a component appends it as the final direct child.
- Direction is horizontal (`row`) when `flex-direction` is absent.
- Direction controls support horizontal (`row`) and vertical (`column`).
- Horizontal alignment supports left, center, and right.
- Vertical alignment supports top, center, and bottom.
- Changing direction writes `flex-direction` and supplies `align-items: flex-start` and
  `justify-content: flex-start` when those properties are absent.
- Nested containers support selecting the parent container.
- Duplicate, reorder, move, and delete are supported. Reordering follows the parent direction:
  left/right in a row Flex Container and up/down otherwise.

## Supported design properties

| Flex control | Supported values |
|---|---|
| Direction | `row` (default), `row-reverse`, `column`, `column-reverse` |
| Flex wrap | `nowrap` (default), `wrap`, `wrap-reverse` |
| Justify | `flex-start` (default), `flex-end`, `center`, `space-between`, `space-around`, `space-evenly` |
| Align items | `stretch` (default), `flex-start`, `flex-end`, `center`, `baseline` |
| Align content | `flex-start`, `flex-end`, `center`, `space-between`, `space-around`, `stretch` |
| Align self | `auto` (default), `flex-start`, `flex-end`, `center`, `baseline`, `stretch` |
| Gap | `0-500px`, `0-100%`, or `0-20em`; the editor displays `8px` when no value is set |
| Flex grow | Unitless `0-5`; default `0` |
| Flex shrink | Unitless `0-5`; browser default `1` |
| Flex basis | `0-500px`, `0-100%`, `0-100vw`, `0-100vh`, or `0-20em`/`rem`; default `auto` |
| Order | Unitless `0-10`; default `0` |

`justify-content`, `align-items`, `align-content`, `flex-direction`, `flex-wrap`, and `gap`
control the container's children. `align-self`, `order`, `flex-grow`, `flex-shrink`, and
`flex-basis` control this container when it is itself a child of another Flex Container.
`align-content` affects wrapped multi-line content.

Do not serialize `gap: 8px` merely because the editor displays that fallback. Write it only
when the user selected it or existing markup contains it.

- Standard design: overlay, box shadow, border, border radius, and opacity.
- Layout design: display, position, dimensions, spacing, and transforms.
- Background editing: theme color or background image settings.

Use valid CSS values. Preserve existing site-local values when editing. Do not invent
layout values or flatten the children into Bootstrap columns.

The Design panel does not expose direct `background-color`, `text-shadow`, or `text-align`
controls for a Flex Container. Do not present those as native Flex Container options.

## Editing

Identify one exact `div.ppFlexContainer`. Change only the requested properties or
children. Preserve unrelated classes, styles, attributes, nested components, siblings,
indentation, and line endings.

Moving, adding, removing, or reordering children is a structural edit. Account for every
existing child before writing.

## Verification

1. Confirm the selected element retains `ppFlexContainer`.
2. Confirm every requested child appears once and in order.
3. Confirm existing children and nested containers are preserved unless explicitly changed.
4. Confirm container and flex-child properties match the resolved request.
5. Confirm only the selected localized content file changed.

## Microsoft documentation

- [Use flex containers to group and align components](https://learn.microsoft.com/power-pages/getting-started/add-flex-container)
