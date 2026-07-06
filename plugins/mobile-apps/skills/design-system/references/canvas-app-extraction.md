# Canvas App Extraction (`--from-canvas-app`)

Extracts palette, typography, and component conventions from an existing Power Apps Canvas app (`.msapp` file).

## Pipeline

```
1. Validate .msapp path (path-safety hook — no .., no system dirs, no symlinks outside $HOME)
2. Validate file size (< 50 MB after unzip)
3. Unzip .msapp to $TMPDIR/<random>/
4. Read CanvasManifest.json → get app metadata
5. Parse Src/App.fx.yaml → extract theme variables from OnStart block:
   - Set(varTheme, {...})
   - Set(varColors, {...})
   - Set(varFonts, {...})
6. Parse per-screen Src/<ScreenName>.fx.yaml:
   - Extract Fill, Color, Font, Size, BorderRadius properties
   - Build frequency map of colors + fonts
7. Convert RGBA() values to hex (#RRGGBB)
8. Resolve ColorValue("named") constants via known-color-map
9. Extract component conventions (button shape, card style, list patterns)
10. Optional: MS Learn MCP enrichment for Canvas app theming guidance
11. Cleanup: rm -rf $TMPDIR/<random>/
```

## Theme variable detection

Look for these patterns in `App.fx.yaml` `OnStart`:

```powerfx
Set(varTheme, {
    Primary: ColorValue("#0078D4"),
    Secondary: ColorValue("#605E5C"),
    Background: ColorValue("#FFFFFF"),
    Text: ColorValue("#323130"),
    ...
})
```

If found → use as canonical palette (high confidence).

If NOT found → fall back to frequency-based extraction from per-screen properties (lower confidence, surfaced with warning).

## RGBA → Hex conversion

```
RGBA(0, 120, 212, 1) → #0078D4
RGBA(50, 49, 48, 1) → #323130
```

Alpha < 1: compute effective color against white background, then emit hex.

## Named color map (subset)

| Power Fx name | Hex |
|---|---|
| Color.Black | #000000 |
| Color.White | #FFFFFF |
| Color.DarkBlue | #00008B |
| Color.RoyalBlue | #4169E1 |
| Color.CornflowerBlue | #6495ED |
| Color.LightGray | #D3D3D3 |
| Color.DimGray | #696969 |

Full list: https://learn.microsoft.com/en-us/power-platform/power-fx/reference/function-colors

## Output mapping

| Canvas property | Maps to our token |
|---|---|
| varTheme.Primary | palette.primary |
| varTheme.Secondary | palette.accent (or text-muted) |
| varTheme.Background | palette.bg |
| varTheme.Text | palette.text |
| Most common Font in screens | typography.body.family |
| Most common heading Font (if different) | typography.heading.family |
| Most common BorderRadius | radius policy (tight/medium/loose/pill) |
| Button pattern (rounded? pill? square?) | components.button shape |

## MS Learn MCP enrichment

Query: `"Canvas app theme variable structure Power Fx"`

Purpose: Validate that extracted variables match the known Canvas theming schema. Map any non-standard variable names the user invented.

## Failure modes

| Condition | Action |
|---|---|
| `.msapp` encrypted / password-protected | STOP — ask to re-export without password |
| No theme variable detected (all hardcoded) | Frequency-only extraction with warning |
| `ColorValue("unknown")` constant | Fall back to default, log unknown |
| 30+ colors (designer drift) | Cap at top 8, surface for user confirmation |
| `.msapp` uses PCF / code components | Skip those screens with notice |
| Tablet-only source | Extract anyway, flag "density may need mobile adjustment" |
| Multiple theme variables (varTheme + varColors + varDarkTheme) | Ask user which is active |
| File > 50 MB after unzip | STOP — ask for screen subset |

## Cost

~3-8k tokens (mostly deterministic parse + optional MCP call).
