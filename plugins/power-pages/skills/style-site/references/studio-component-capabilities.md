# Power Pages Studio component styling capabilities

Contents: [Scope and routing](#scope-and-routing) | [Canonical map](#canonical-map) | [Control semantics](#control-semantics) | [Values and ranges](#values-and-ranges) | [Normalization](#normalization) | [Using the lookup](#using-the-lookup)

## Scope and routing

This reference describes the component **Design panel in the Pages workspace**. It does **not** describe site-wide themes/the Styling workspace, custom CSS, content/data settings, component configuration dialogs, or every property browsers support. Absence from this map must not be presented as absence from every Studio surface.

Before styling, identify the actual selected component, normalize the intent, find its tab/property, and check availability. Do not infer a native component family from a descriptor `kind`, a CSS class, an HTML tag, or another family's controls. **VS Code/local authoring is the default for both listed and unlisted properties.** This map describes Design-panel availability, not exclusive ownership or permission to force a Studio handoff.

| Result | Skill behavior |
|---|---|
| Listed, available property on a native component | Apply the approved local change at its verified inline declaration or effective scoped stylesheet. Verify control values/units only when claiming Design-panel compatibility or supplying explicitly requested Studio instructions. |
| Property not listed for a known component, or an unavailable tab | Allow safe local inline declarations or scoped CSS after approval, with a warning: **Not editable through this component's Studio Design panel; maintain this property in VS Code.** |
| Conditional Flex support | Confirm whether the Flex tab exists in the current environment. Until then, do not call it available; local edits remain possible with an unverified-support warning. Bootstrap version does not establish Flex-tab availability. |
| Unknown/unlisted component | Do not borrow another family's map or claim Studio support. Seek current-panel evidence when needed; otherwise permit verified local-source styling with an explicit **Studio editability unverified** warning. |

An unsupported Design-panel property is **not a styling prohibition**. It may render in Studio and at runtime without an editing control; local CSS values are not guaranteed to populate native controls. Keep unlisted/unknown/conditional warnings in review, approval and the final report. Honor native serialization/cascade: update a winning inline declaration rather than overpowering it. Preserve Bootstrap/default CSS/markers and source/approval guards. General CSS uses pinned bundled css-tree, not this map or a skill-specific property/enum/part allowlist. Parser grammar support is not Power Pages/browser/Studio rendering proof; unknown or semantic-grammar-unverified syntax yields separate warnings. Fix invalid values or verify newer browser support before approval; never bypass errors or call absent parser grammar a Power Pages prohibition.

General properties, functions, gradients, responsive rules, animation, fonts and tokens can be local without native Design-panel controls. Explicit `global: true` raw themes are outside this component map and require expanded scope/shared-name review. Namespacing, external-resource declarations and `importantReason` authoring rules are detailed in the [general CSS contract](proposal-and-verification.md#general-css-authoring), not inferred from component support.

Reserve `owner: "studio"` for explicitly requested instructions-only work, with `handoffReason: "user-requested"` and `studioAction`. Native support alone is not a reason. See [placement policy](styling-policy.md) and the [inline contract](proposal-and-verification.md#guarded-inline-declarations).

## Canonical map

The supplied capability map is normalized from YAML to JSON here so scripts can read this **single source** without installing a YAML parser. `all` means every property in the matching property set. The lookup reads this first JSON block; update it and its tests together.

```json
{
  "schemaVersion": 1,
  "surface": "Power Pages Studio component Design panel",
  "availability": { "flexTab": "conditional", "transitionTab": "unavailable" },
  "propertySets": {
    "standard": ["Overlay", "background-color", "box-shadow", "text-shadow", "border", "border-radius", "opacity"],
    "layout": ["display", "position", "width", "height", "min-width", "min-height", "max-width", "max-height", "margin", "padding", "top", "right", "bottom", "left", "transform.rotate", "transform.scale", "transform.translateX", "transform.translateY"],
    "typography": ["font-family", "font-weight", "font-size", "letter-spacing", "line-height", "text-align"],
    "flex": ["flex-direction", "justify-content", "align-items", "align-content", "align-self", "gap", "flex-grow", "flex-shrink", "flex-basis", "order"]
  },
  "componentFamilies": {
    "text": {
      "includes": ["Text", "Paragraph", "Heading 1", "Heading 2", "Heading 3", "Subheading 1", "Subheading 2", "Form heading", "Form instructions", "Form section title"],
      "tabs": ["Standard", "Layout", "Typography", "Flex"],
      "editable": {
        "Standard": ["background-color", "box-shadow", "text-shadow", "border", "border-radius", "opacity"],
        "Layout": "all",
        "Typography": "all",
        "Flex": ["gap", "flex-grow", "flex-shrink", "flex-basis"]
      }
    },
    "button": {
      "includes": ["Button"],
      "tabs": ["Standard", "Layout", "Typography", "Flex"],
      "editable": {
        "Standard": ["background-color", "box-shadow", "border", "border-radius"],
        "Layout": "all",
        "Typography": ["font-family", "font-weight", "font-size", "letter-spacing", "line-height"],
        "Flex": ["gap", "flex-grow", "flex-shrink", "flex-basis"]
      }
    },
    "imageVideo": {
      "includes": ["Image", "Linked image", "Video"],
      "tabs": ["Standard", "Layout", "Flex"],
      "editable": {
        "Standard": ["box-shadow", "border", "border-radius"],
        "Layout": "all",
        "Flex": ["gap", "flex-grow", "flex-shrink", "flex-basis"]
      }
    },
    "section": {
      "includes": ["Section"],
      "tabs": ["Standard", "Layout"],
      "editable": { "Standard": ["Overlay", "border", "border-radius", "opacity"], "Layout": "all" }
    },
    "flexContainer": {
      "includes": ["Flex container"],
      "tabs": ["Standard", "Layout", "Flex"],
      "defaultTab": "Flex",
      "editable": {
        "Standard": ["Overlay", "box-shadow", "border", "border-radius", "opacity"],
        "Layout": "all",
        "Flex": "all"
      }
    }
  }
}
```

Notable distinctions: Text supports text shadow, opacity and text alignment; Button does not. Image/video has no background-color, opacity or typography control here. Section has Overlay, border, radius and opacity, but no background-color, shadow, typography or Flex tab. Flex container adds shadow and the full conditional Flex set. All documented families have every Layout control. Transition is unavailable for all documented families.

## Control semantics

- **Background color** has a color picker and an alpha percentage. That percentage changes only the background, not the whole component.
- **Overlay** places a color layer over a background image, with a color picker and strength percentage. It is neither literal CSS `Overlay`, `background-color`, nor component `opacity`; never substitute one silently.
- **Shadow/text shadow** expand into horizontal offset, vertical offset, blur and color. They map to `box-shadow` and `text-shadow`, respectively.
- **Border** can expand into width, style and color. Radius expands into individual corners; margin and padding into individual sides.
- **Opacity** affects the entire component, from 0 to 1.
- **Rotate, scale and offsets** are controls contributing to CSS `transform`. The single Scale control changes both axes together. The synthetic names `transform.rotate`, `transform.scale`, `transform.translateX` and `transform.translateY` are lookup keys, not CSS declaration names. Arbitrary transforms such as skew/matrix are not established by this list.
- **Flex** for Text, Button and Image/video concerns their participation as flex children: gap, grow, shrink and basis only. Flex container exposes direction, justification, align-items/content/self and order as well. Never infer these controls from `display:flex` alone.
- Font-weight choices depend on the selected font family.

## Values and ranges

These are Design-panel control limits, **not universal CSS restrictions**. A property match alone does not verify that a particular value/unit is accepted.

| Control | Minimum | Maximum / units |
|---|---:|---|
| Background alpha / Overlay strength | 0 | 100% |
| Opacity | 0 | 1, unitless |
| Shadow / Text shadow | 0 | 100, pixel-based primary control plus expanded details |
| Border | 0 | 100, unit-dependent |
| Radius | 0 | 100, px or % |
| Scale | 0.1 | 10, unitless, step 0.1 |
| Rotate | 0 | 360 degrees; rad/grad also supported |
| Top/right/bottom/left | 0 | 300px or 100% |
| Font size | 5 | 200; relative/viewport-unit limits vary |
| Line height | 1 | 200; relative/viewport-unit limits vary |
| Letter spacing | 0 | 100; relative/viewport-unit limits vary |
| Width/height and their min/max constraints | 5 | 2000px or 100% |
| Flex grow/shrink | 0 | 5, unitless |
| Flex basis / Gap | 0 | 500px or 100% |
| Order | 0 | 10, unitless |

Available units vary by property; common units are `px`, `%`, `em`, `rem`, `vh`, `vw`, `deg`, `rad`, and `grad`.

## Normalization

| Maker wording | Resolve to |
|---|---|
| Background/fill/background fill | `background-color`, not Overlay |
| Background transparency/alpha | Background color percentage, not component opacity |
| Transparency/component opacity | `opacity`; clarify ambiguous "make it transparent" |
| Drop/box shadow; text shadow | `box-shadow`; `text-shadow` |
| Outline/stroke when referring to the Design control | Border; do not relabel literal CSS `outline-*` or SVG `stroke` as border |
| Rounded corners/rounding | `border-radius` |
| Outer/inner spacing | `margin` / `padding` |
| Space between flex children | `gap`, conditional on Flex-tab availability |
| Horizontal/vertical movement | `transform.translateX` / `transform.translateY` controls |
| Rotation / proportional resize | `transform.rotate` / `transform.scale` controls |
| Alignment | Clarify text alignment vs justification vs align-items/content/self |

The lookup normalizes physical margin/padding sides, border details and individual physical corners to their documented parent controls. It does not infer logical-property equivalents, hover/focus-state editor support, arbitrary transform functions, or support through other Studio surfaces.

## Using the lookup

```bash
node "${PLUGIN_ROOT}/skills/style-site/scripts/inspect-studio-capabilities.js" --component "Button" --properties "text-shadow,text-align,background-color"
node "${PLUGIN_ROOT}/skills/style-site/scripts/inspect-studio-capabilities.js" --component "Text" --properties "gap,flex-direction" --flex available
```

Use `--request "<external-request.json>"` instead to batch existing style groups. Output is bounded; narrow the request if lookup details are truncated. Normal coordinator proposals also include the assessment and warnings, so do not repeat the lookup after support is assessed.

Set optional `studioComponent` on each style group to the **actual selected native component name** (for example, `Heading 2` for an inspected child heading, not its Section parent). `studioFlex: "available"` or `"unavailable"` records confirmed current-tab availability; omission remains conditional. Descriptor `kind` does not establish either field. For site-wide theme handoffs, omit these Design-panel fields and use the separate Styling-workspace policy.

Examples: Button `text-shadow`/`text-align`, Image `opacity`/`background-color`, and any documented component's transition use the warned local path. Text `text-shadow`/`text-align` and Image `border-radius`/`box-shadow`/border details are listed and also default to local edits. Text `gap` is conditional; Text `flex-direction` is not listed. Unknown cards, lists or whole forms do not inherit Text's map merely because they contain text.
