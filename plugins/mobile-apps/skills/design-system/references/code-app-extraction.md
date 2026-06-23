# Code App Extraction (`--from-code-app`)

Extracts palette, typography, spacing, radius, and component conventions from an existing web code app (sibling Power Apps code app or standalone web project).

## Pipeline

```
1. Validate path (path-safety hook — not same as target native app, has package.json)
2. Detect UI framework via package.json dependencies
3. Read framework-specific config files
4. Build token map (palette + typography + spacing + radius + components)
5. Translate to Tamagui equivalents via mapping table
6. Optional: use logos in public/ as --logo fallback if no palette found
7. Optional: MS Learn MCP for Fluent BrandVariants schema validation
```

## Framework detection

Read `package.json` `dependencies` + `devDependencies`:

| Dependency pattern | Framework |
|---|---|
| `tailwindcss` | Tailwind CSS |
| `@fluentui/react-components` or `@fluentui/react` | Fluent UI |
| `shadcn` or `class-variance-authority` + `tailwindcss` | shadcn/ui |
| `styled-components` | styled-components |
| `@emotion/styled` or `@emotion/react` | Emotion |
| None of above + `.css` files | Vanilla CSS |

## Per-framework extraction

### Tailwind CSS

**Config locations (check in order):**
- `tailwind.config.ts` / `tailwind.config.js` (v3)
- `src/index.css` or `app/globals.css` with `@theme` block (v4)

**Extract from config:**
```
theme.extend.colors → palette tokens
theme.extend.fontFamily → typography tokens
theme.extend.spacing → space tokens
theme.extend.borderRadius → radius policy
```

**Tailwind v4 (CSS-first):**
```css
@theme {
  --color-primary: #0078D4;
  --font-heading: 'Inter', sans-serif;
  --radius-lg: 12px;
}
```

**Dynamic config fallback:** If `tailwind.config.ts` uses runtime functions → try `npx tailwindcss --print-config` (if Node available), else static parse with warning.

### Fluent UI

**Config locations:**
- `src/theme.ts` or `src/theme/*.ts`
- Look for `BrandVariants` or `createLightTheme` / `createDarkTheme`

**Extract:**
```ts
const brand: BrandVariants = {
  10: '#00060A', // → brand scale step 10
  ...
  80: '#0078D4', // → palette.primary (step 80 = base)
}
```

### shadcn/ui

**Config locations:**
- `src/components/ui/*.tsx` (cva variant definitions)
- `src/index.css` or `app/globals.css` (CSS custom properties)

**Extract from CSS:**
```css
:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --primary: 221.2 83.2% 53.3%;
}
```

Convert HSL values to hex.

### styled-components / Emotion

**Config locations:**
- `src/theme.ts` or `src/styles/theme.ts`
- `createGlobalStyle` blocks

**Extract:** Parse the theme object (Sonnet assist for complex nested themes).

### Vanilla CSS

**Config locations:**
- `src/index.css` `:root` custom properties
- `index.html` `<meta theme-color>` + font links
- All `.css` files → frequency map of colors

## Token translation table (Framework → Tamagui)

| Source token | Tamagui equivalent |
|---|---|
| `colors.primary` / `--color-primary` | `$accentBase` |
| `colors.background` / `--background` | `$surface0` |
| `colors.muted` / `--muted` | `$surface1` |
| `colors.destructive` / `--destructive` | status.danger |
| `fontFamily.sans` / `--font-sans` | `$body` font family |
| `fontFamily.heading` / `--font-heading` | `$heading` font family |
| `fontFamily.mono` / `--font-mono` | `$mono` font family |
| `borderRadius.lg` / `--radius` | radius policy inference |
| `spacing.*` | space tokens (4/8/12/16/24/32/48/64) |

## Failure modes

| Condition | Action |
|---|---|
| Path not a code app (no `package.json` or no UI deps) | STOP — ask user to confirm path |
| Path is same as native app being scaffolded (circular) | STOP with clear error |
| Mix of Tailwind + Fluent + shadcn (no clear winner) | Ask user which is canonical |
| No central theme — raw CSS scattered | Frequency-only extraction with warning |
| CSS modules only (`*.module.css`) | Parse with lower-confidence flag |
| `tailwind.config.ts` uses dynamic functions | Try `--print-config`, else static parse with warning |
| `@apply` used heavily without token exposure | Frequency map of class names |

## Cost

~5-8k tokens (mostly deterministic + Sonnet for ambiguous CSS-in-JS theme objects).
