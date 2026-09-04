# Canvas App Design Guide

This guide helps create distinctive, production-grade Canvas App screens that avoid generic "AI slop" aesthetics.

**Who does what.** Discovery tools (`list_controls`, `describe_control`, the data and API
tools) belong to the orchestrator and the `canvas-app-planner`. A `canvas-screen-builder`
cannot call them and works from the control definitions recorded in its screen brief.
Where this guide says "run list_controls", that instruction is addressed to the
orchestrator and planner.

## Contents

- Design Thinking Process
- Control, Data Source, and API Discovery
- Typography and Color
- Spatial Composition and Layout
- Interactive States
- Visual Polish
- Aesthetic Anti-Patterns
- Creative Interpretation
- Design Process Summary

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
| `ModernCard` | Ready-made card with Title, Subtitle, Description hierarchy, built-in shadow, and `OnSelect` — use this as your card primitive, not `GroupContainer`. **Set `Image` (or `Image: =Blank()`) and every text slot you display: unset slots render a stock photo and the literal words "Subtitle"/"Description".** |
| `Avatar` | User/entity representation with image, initials fallback, and size variants — no need to fake it with a circle and a label |
| `Badge` | Status indicators, counts, and labels with semantic color variants — replaces ad-hoc colored rectangles with text |
| `Progress` | Linear and circular progress display — replaces manual progress bar constructions |
| `ModernTabList` | In-screen tab/panel navigation with selection state built in. Use ModernButtons for navigation between separate screens. |

**The pattern to avoid:** Choosing an aesthetic direction, then reaching for `GroupContainer` + `Label` + `Rectangle` to assemble something that already exists. The controls above are not conveniences — they are fundamentally better starting points with richer built-in behavior and visual consistency.

## Know Your Data Sources and APIs Before Creating Collections

**Run list_data_sources and list_apis before creating any local collections with `ClearCollect()` or `Collect()` calls.** The
data sources and APIs you have access to are not just technical details — they are design constraints and opportunities.
Designing without knowing what data you can pull in and how means you'll create static, fake content that doesn't reflect
the real user experience.

## Canvas App Aesthetics Guidelines

### Typography & Text Hierarchy

- **Control Selection**: When there are multiple controls for the same purpose, favor the modern control whose interaction matches the data:
	- Favor `ModernText` over `Label`, `ModernRadio` or a directly selectable modern dropdown for short static choices, `ModernCombobox` over `Classic/ComboBox` only for large searchable sets, `ModernRadio` over `Classic/Radio`, `Button` or `ModernButton` over `Classic/Button`, `ModernTabList` for in-screen tabs, `ModernButton` rows for cross-screen navigation, `ModernTextInput` over `Classic/TextInput`, and so on. Never choose a searchable control merely because it is modern when a required short choice should take one click or tap.
- **Font Weight**: Use `ModernText` for headlines with `FontWeight: =FontWeight.Bold` and a large font size. Use `ModernText` with `FontWeight: =FontWeight.Normal` for body content.
- **Size Contrast**: Create dramatic hierarchy with size differences. Headers at 24-32, subheaders at 18-20, body at 14-16.
- **Alignment as Statement**: Mix `Align.Left`, `Align.Center`, `Align.Right` intentionally. Centered text for impact, left-aligned for readability.
- **Font Properties**: Leverage `Size`, `FontWeight`, `Align`, `VerticalAlign`, and `Color` to create visual interest. On the modern React controls the text color property is `Color` and the font size property is `Size` — `FontColor` and `FontSize` exist only on `Badge`. Confirm with `describe_control` rather than assuming.

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
- **Design for the narrowest width you claim to support**: A layout composed at 1440px and never re-checked will clip at 1024px and collapse on a phone. Size layout containers with `Parent.Width` or `FillPortions`, never a literal like `Width: =1120`. Reserve fixed pixel sizes for icons, avatars, and steppers — and keep interactive ones at 44px or larger.
- **Every horizontal row of more than two controls needs a reflow strategy**: Set `LayoutWrap: =true`, or drive `LayoutDirection` from a width breakpoint, so rows stack instead of squeezing. This is the single most common defect in generated apps and it is invisible at the width you designed at.
- **The screen root must scroll** whenever it holds a gallery, a form, or more than about three stacked sections: canvas screens do not scroll on their own, so give the root container `LayoutOverflowY: =LayoutOverflow.Scroll` and content below the fold stays reachable on short viewports.
- **Set foreground wherever you set background**: Text does not inherit a contrasting color. Every time you choose a container `Fill`, set `Color` on the text inside it — dark-on-dark passes every automated check and is unreadable.
- **Rows inside a `Gallery` need their own container**: `Gallery` is a Classic control and positions its template children absolutely, so a row authored at desktop width stays at desktop width everywhere. Put one AutoLayout `GroupContainer` in the template and build the row inside it. See `${PLUGIN_ROOT}/references/LayoutGuide.md`.
- **Asymmetry & Breaking Grid**: Don't center everything. Offset elements. Use unexpected positioning.
- **Spacing as Design**: Generous padding creates breathing room. Dense layouts create energy.
- **Layering**: Use multiple `GroupContainer` controls to create visual depth.
- **Scale Variation**: Mix large and small controls. A massive header with tiny supporting text creates drama.
- **Card UI — use `ModernCard` as the starting point**: For anything that functions as a card, `ModernCard` is the right primitive. `GroupContainer` cannot be clicked and requires workarounds to match what `ModernCard` provides natively — see `${PLUGIN_ROOT}/references/ControlGuide.md` for details.

### Interactive States & Behavior

- **State-Driven Design**: Use `Set()` variables to create dynamic interfaces that respond to user actions.
- **DisplayMode as Design**: Toggle between `DisplayMode.Edit`, `DisplayMode.View`, and `DisplayMode.Disabled`.
- **Visibility Choreography**: Use `Visible` property with state variables to reveal/hide elements.
- **Button States**: Make buttons feel alive with `BasePaletteColor` changes based on state.
- **Conditional Styling**: Every property can be a formula. Use `If()` statements to change `Fill`, `FontColor`, `Size`.

### Visual Details & Polish

- **DropShadow**: Use `DropShadow.Semilight`, `DropShadow.Regular`, `DropShadow.Heavy` for elevation and depth. Available on `GroupContainer` and `ModernCard`.
- **Border Radius**: Rounding is spelled differently per control. `GroupContainer` and the modern text/input/button controls use the four corner properties `RadiusTopLeft`, `RadiusTopRight`, `RadiusBottomLeft`, `RadiusBottomRight`. `ModernCard` uses a single numeric `BorderRadius`. `Rectangle` has no rounding at all — use a `GroupContainer` when you need a rounded filled surface. Confirm with `describe_control` before styling.
- **Transparency**: Use RGBA with alpha < 1 for overlays, subtle backgrounds, and layering.
- **Touch Targets**: Make interactive elements at least 44px, preferably 48px, for mobile.
- **Accessible by construction**: Give every content and input control an `AccessibleLabel`, and every interactive gallery a `TabIndex`, while you are designing it. Nothing downstream adds them for you, and retrofitting labels across a finished screen is far more work than writing them in place.
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
