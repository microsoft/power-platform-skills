# MCP App Widget Design Guidelines

These are defaults for producing polished output. They can be overridden by user requests.

## Visual states

Every widget should handle three states:

1. **Loading** - a spinner with a contextual message ("Finding attractions..." not just "Loading...")
2. **Data** - the actual content, rendered compactly
3. **Error** - a friendly message with a "Try again" button

### How "Try again" works

If the widget knows the tool name and can call it (because the user provided a tool name and the widget uses `callServerTool`), the retry button should:
1. Show the loading state
2. Call `app.callServerTool({ name: toolName, arguments: lastArguments })`
3. On success, call `renderData` with the new result
4. On failure, show the error state again

If the widget only receives data passively via `ontoolresult` (no tool name provided), the retry button can't re-trigger the tool. In that case, show a message like "Something went wrong. Please try again." The host will handle re-invoking the tool.

Disable action buttons while a tool call is in flight to prevent double-submission.

## Typography

- Use 2-3 font sizes max. Example: 1rem (headings, semibold 600), 0.875rem (body), 0.75rem (captions/metadata).
- Create hierarchy through font-weight (600 vs 400) and color (primary vs secondary text), not big size jumps.
- No custom fonts or external font imports. The template font stack handles it.

## Spacing

Use a consistent scale: 4px, 8px, 12px, 16px, 24px, 32px. Avoid arbitrary values like 10px, 14px, 22px.

- Card internal padding: 16px or 24px
- Gap between list items: 8px or 12px
- Gap between sections: 16px or 24px
- Border radius: 8px for small elements, 12px for cards/containers
- Use the full available width. Do NOT set max-width on the widget container.

## Color

Use theme tokens so light/dark mode works automatically. Do NOT use hardcoded color values.

**Text:**
- `var(--colorNeutralForeground1)` - primary text
- `var(--colorNeutralForeground2)` - secondary/muted text
- `var(--colorNeutralForeground3)` - tertiary text (metadata, timestamps)

**Backgrounds:**
- `var(--colorNeutralBackground1)` - primary background
- `var(--colorNeutralBackground2)` - subtle background (cards, hover states)
- `var(--colorNeutralBackground3)` - alternate subtle background

**Brand:**
- `var(--colorBrandBackground)` - accent/brand color (buttons, badges)
- `var(--colorBrandForeground1)` - text/icons on brand-colored surfaces

**Borders:**
- `var(--colorNeutralStroke1)` - borders, dividers
- `var(--colorNeutralStroke2)` - subtle borders

**Status:**
- `var(--colorStatusDangerForeground1)` - error text
- `var(--colorStatusSuccessForeground1)` - success text
- `var(--colorStatusWarningForeground1)` - warning text

Do NOT use made-up variable names like `--neutral-layer-2` or `--error`.

**Contrast rules:**
- Text on `var(--colorBrandBackground)` (brand/accent surfaces): use `var(--colorNeutralForegroundOnBrand)` (white), NOT `var(--colorNeutralForeground1)` (dark)
- Text on `var(--colorNeutralBackground1)` (default surface): use `var(--colorNeutralForeground1)` (dark)
- Always verify text is readable against its background. Dark text on blue = unreadable.

## Interactions

- Subtle CSS transitions on interactive elements: `transition: all 0.2s ease`
- Button labels should describe the action: "Translate", "Get Weather", "Find Attractions" (not "Submit" or "Go")
- For errors, use friendly language: "Try again" not "Retry"
- Respect `prefers-reduced-motion`: wrap animations in `@media (prefers-reduced-motion: no-preference) { }`
