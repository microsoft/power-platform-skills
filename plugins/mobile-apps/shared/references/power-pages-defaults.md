# Power Pages Default Theme

Cached reference for Microsoft Power Pages base theme tokens. Used by `/design-system --power-pages-defaults` as a pre-baked direction bundle.

Source: MS Learn MCP queries (refreshable via `/design-system --refresh-cache`).
Last cached: 2026-05-04

---

## Palette (Microsoft Power Pages default)

| Token | Hex | Usage |
|---|---|---|
| bg | #FFFFFF | Page background |
| surface | #F8F9FA | Card / section background (Bootstrap .bg-light) |
| primary | #0078D4 | Primary CTAs, links (Microsoft Blue) |
| accent | #005A9E | Pressed / active states |
| text | #212529 | Body text (Bootstrap default) |
| text-muted | #6C757D | Secondary text (Bootstrap .text-muted) |
| border | #DEE2E6 | Borders, dividers (Bootstrap .border) |

## Status palette

| Token | Hex |
|---|---|
| success | #28A745 |
| warning | #FFC107 |
| danger | #DC3545 |
| info | #17A2B8 |

## Typography

| Role | Family | Size | Weight | Line | Tracking |
|---|---|---|---|---|---|
| Display | Segoe UI | 32px | 600 | 1.2 | -0.01em |
| Heading | Segoe UI | 24px | 600 | 1.25 | 0 |
| Title | Segoe UI | 20px | 600 | 1.3 | 0 |
| Body | Segoe UI | 16px | 400 | 1.5 | 0 |
| Body-sm | Segoe UI | 14px | 400 | 1.4 | 0 |
| Caption | Segoe UI | 12px | 400 | 1.3 | 0 |
| Mono | Consolas | 14px | 400 | 1.4 | 0 |

## Spacing

Bootstrap spacing scale: 0 / 4 / 8 / 16 / 24 / 48 (mapped from .p-0 through .p-5)

## Components (Power Pages conventions)

### Button
- Primary: filled, 6px radius, 38px height
- Secondary: outlined, same radius
- No pill buttons in standard theme

### Card / Panel
- 1px border (#DEE2E6), 4px radius, 16px padding
- Optional shadow via `.shadow-sm` (box-shadow: 0 .125rem .25rem rgba(0,0,0,.075))

### Form (Entity Form)
- Input height: 38px
- Border: 1px solid #CED4DA
- Focus: blue glow (0 0 0 .2rem rgba(0,120,212,.25))
- Label: 14px, font-weight 400 (not bold)

### List (Entity Grid)
- Table-based layout (not card-based)
- Striped rows optional (.table-striped)
- Row height: ~48px
- Sort indicators in column headers

### Badge / Status
- Small rounded rect (4px radius)
- Background: status color at ~20% opacity
- Text: status color at full saturation

## Negatives (Power Pages conventions)

- ✗ No border-radius > 8px (Bootstrap standard limits)
- ✗ No custom scrollbars
- ✗ No fixed-position headers (Power Pages uses JS-managed sticky)
- ✗ No decorative animations (accessibility requirement)
- ✗ No button heights < 38px (Bootstrap minimum)

## Provenance

- Source: Microsoft Learn documentation on Power Pages theming
- Bootstrap version: 5.x (current Power Pages default)
- Applicable to: sites created after 2023 (older sites may use Bootstrap 4)

## Refresh

To update this cache, run:
```
/design-system --refresh-cache
```

This re-queries MS Learn MCP for the latest Power Pages theming documentation and overwrites this file.
