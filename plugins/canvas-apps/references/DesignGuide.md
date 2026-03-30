# Canvas App Design Guide

This guide helps create distinctive, production-grade Canvas App screens that avoid generic "AI slop" aesthetics.

## Design Thinking Process

Before generating YAML, understand the context and commit to a BOLD aesthetic direction:

- **Purpose**: What problem does this screen solve? Who uses it? What's their context?
- **Tone**: Pick an extreme aesthetic direction - brutally minimal, maximalist information density, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, data-dense dashboard, etc.
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

## Know Your Control Palette Before Designing

**Run list_controls before committing to any layout.** The available controls are not just technical building blocks — they are design options. Designing without knowing what exists means you'll build inferior versions of things that already exist as polished, semantic components.

Key controls that directly expand your design vocabulary:

| Control | What it enables |
|---------|----------------|
| `ModernCard` | Ready-made card with Title, Subtitle, Description hierarchy, built-in shadow, and `OnSelect` — use this as your card primitive, not `GroupContainer` |
| `Avatar` | User/entity representation with image, initials fallback, and size variants — no need to fake it with a circle and a label |
| `Badge` | Status indicators, counts, and labels with semantic color variants — replaces ad-hoc colored rectangles with text |
| `Progress` | Linear and circular progress display — replaces manual progress bar constructions |
| `ModernTabList` | Tab navigation with selection state built in — replaces button rows with manual highlight logic |

**The pattern to avoid:** Choosing an aesthetic direction, then reaching for `GroupContainer` + `Label` + `Rectangle` to assemble something that already exists. The controls above are not conveniences — they are fundamentally better starting points with richer built-in behavior and visual consistency.

## Know Your Data Sources and APIs Before Creating Collections

**Run list_data_sources and list_apis before creating any local collections with `ClearCollect()` or `Collect()` calls.** The
data sources and APIs you have access to are not just technical details — they are design constraints and opportunities.
Designing without knowing what data you can pull in and how means you'll create static, fake content that doesn't reflect
the real user experience.

## Canvas App Aesthetics Guidelines

### Typography & Text Hierarchy

- **Control Selection**: When there are multiple controls for the same purpose, and one of them is a "Classic" control, favor the modern controls:
	- Favor `ModernText` over `Label`, `ModernCombobox` over `Classic/ComboBox`, `ModernRadio` over `Classic/Radio`, `Button` or `ModernButton` over `Classic/Button`, `ModernTabList` over building tabs with `Button` or `Toggle`, `ModernTextInput` over `Classic/TextInput`, and so on.
- **Font Weight**: Use `ModernText` for headlines with `FontWeight: =FontWeight.Bold` and a large font size. Use `ModernText` with `FontWeight: =FontWeight.Normal` for body content.
- **Size Contrast**: Create dramatic hierarchy with size differences. Headers at 24-32, subheaders at 18-20, body at 14-16.
- **Alignment as Statement**: Mix `Align.Left`, `Align.Center`, `Align.Right` intentionally. Centered text for impact, left-aligned for readability.
- **Font Properties**: Leverage `Size` / `FontSize`, `FontWeight`, `Align`, `VerticalAlign`, and `FontColor` to create visual interest.

### Color & Visual Theme

- **Commit to a Palette**: Use `Color` constants or custom `RGBA()` values consistently throughout.
- **Dominant + Accent**: Choose one dominant color for primary actions and backgrounds, with sharp contrasting accents. Avoid evenly distributed pastels.
- **Contextual Color**: Use `BasePaletteColor` on buttons to reinforce hierarchy.
- **State-Based Color**: Use formulas like `=If(isActive, Color.Blue, Color.Gray)` to create dynamic interfaces.
- **Background Depth**: Don't default to `Color.White`. Use subtle grays, tinted backgrounds, or bold color fills.

### Spatial Composition & Layout

- **Layout Strategy Choice**:
  - Use `ManualLayout` for precise, pixel-perfect designs
  - Use `AutoLayout` for responsive, flexible layouts
- **Asymmetry & Breaking Grid**: Don't center everything. Offset elements. Use unexpected positioning.
- **Spacing as Design**: Generous padding creates breathing room. Dense layouts create energy.
- **Layering**: Use multiple `GroupContainer` controls to create visual depth.
- **Scale Variation**: Mix large and small controls. A massive header with tiny supporting text creates drama.
- **Card UI — use `ModernCard` as the starting point**: For anything that functions as a card, `ModernCard` is the right primitive. `GroupContainer` cannot be clicked and requires workarounds to match what `ModernCard` provides natively — see the Technical Guide for details.

### Interactive States & Behavior

- **State-Driven Design**: Use `Set()` variables to create dynamic interfaces that respond to user actions.
- **DisplayMode as Design**: Toggle between `DisplayMode.Edit`, `DisplayMode.View`, and `DisplayMode.Disabled`.
- **Visibility Choreography**: Use `Visible` property with state variables to reveal/hide elements.
- **Button States**: Make buttons feel alive with `BasePaletteColor` changes based on state.
- **Conditional Styling**: Every property can be a formula. Use `If()` statements to change `Fill`, `FontColor`, `Size`.

### Visual Details & Polish

- **DropShadow**: Use `DropShadow.Semilight`, `DropShadow.Regular`, `DropShadow.Heavy` for elevation and depth.
- **Border Radius**: Use `RadiusTopLeft`, `RadiusTopRight`, `RadiusBottomLeft`, `RadiusBottomRight` intentionally.
- **Transparency**: Use RGBA with alpha < 1 for overlays, subtle backgrounds, and layering.
- **Touch Targets**: Make interactive elements at least 44-48px for mobile.
- **Data Visualization**: Use appropriate controls with thoughtful `TemplateSize` and spacing.

## NEVER Use Generic Canvas App Aesthetics

Avoid these antipatterns:

**Generic Color Choices:**
- ❌ Default white backgrounds (`Color.White`) with no variation
- ❌ Overused blue accent colors without considering context
- ❌ Purple-on-white schemes that scream "generic business app"
- ❌ Timid pastels that lack visual impact

**Predictable Layouts:**
- ❌ Everything centered and evenly spaced with no hierarchy
- ❌ Uniform button sizes and spacing (everything at 40px height, 10px gaps)
- ❌ Forms that look like database entry screens
- ❌ Screens that are just vertical lists of identically-styled buttons

**Lazy Control Choices:**
- ❌ Using `Button` for everything when other controls are better
- ❌ Defaulting to `Classic` controls without considering alternatives
- ❌ Not exploring specialized controls
- ❌ Generic control names like `Button1`, `Label2`
- ❌ Building `Avatar`, `Badge`, `Progress`, `ModernTabList`, or card layouts from primitives when the semantic controls exist — always run list_controls first

**Timid Typography:**
- ❌ All text at size 12-14 with no hierarchy
- ❌ Not using `FontWeight.Bold` or `FontWeight.Semibold` for emphasis
- ❌ Everything left-aligned or everything centered with no variation
- ❌ Ignoring the power of scale contrast

**Missing Interactivity:**
- ❌ Static screens with no state management or visual feedback
- ❌ Buttons that don't change appearance when clicked or disabled
- ❌ No use of `DisplayMode` to guide user flows
- ❌ Forgetting to use `Visible` property for progressive disclosure

**No Attention to Detail:**
- ❌ Ignoring spacing and letting everything be equidistant
- ❌ Not using `DropShadow` or radius properties for visual depth
- ❌ Forgetting to use `RGBA()` for transparency effects
- ❌ Uniform sizes across all controls

## Creative Interpretation

Interpret creatively and make unexpected choices:

- **Vary Themes**: Don't always use light backgrounds. Try dark themes, colored backgrounds, or bold fills.
- **Mix Layout Strategies**: Combine `ManualLayout` precision with `AutoLayout` flexibility.
- **Experiment with Control Types**: Explore beyond basic buttons and labels.
- **Context-Specific Palettes**: A game uses playful colors. A dashboard uses data-viz colors. A form uses sophisticated grays.
- **No Design Should Be the Same**: Each screen should feel custom-designed for its purpose, not templated.

**IMPORTANT**: Match implementation complexity to the aesthetic vision:

- **Maximalist designs** need elaborate control hierarchies, dynamic state management, conditional visibility, layered containers, and rich color palettes.
- **Minimalist designs** need restraint, precision spacing, careful typography choices, subtle color usage, and attention to negative space.
- **Elegance comes from executing the vision well**, whether controlled chaos or refined simplicity.

## Design Process Summary

1. **Discover your palette** — Run list_controls before committing to any design direction
2. **Choose an aesthetic direction** — Commit to a specific, bold tone (see Design Thinking Process above)
3. **Plan visual hierarchy** — What are the primary, secondary, and tertiary elements? How do they relate?
4. **Choose layout strategy** — ManualLayout for precision; AutoLayout for responsiveness
5. **Plan interactivity** — What state variables drive dynamic behavior? What does the user experience over time?
6. **Implement YAML** — Execute the vision with intentional aesthetic choices at every property
7. **Validate** — Use compile_canvas early, not just at the end
8. **Refine** — Polish spacing, color, sizing, and depth until the design feels intentional

Remember: Canvas Apps can be visually striking and memorable despite platform constraints. Don't hold back. Show what can truly be created when thinking outside the box and committing fully to a distinctive vision.