# Tamagui → HTML Preview Mapping

For source-derived **implementation previews only**. Intent previews use [direct HTML authoring](../../skills/preview-screens/references/intent-authoring.md), not this conversion table or shell. Mode and validation policy live in [preview-screens](../../skills/preview-screens/SKILL.md).

## 1. Resolve inputs before mapping

Read `tamagui.config.ts` and its relevant local imports, including `brand/tokens.ts`, exported `appLightTheme` / `appDarkTheme`, provider props, and font loading. Do not assume brand values are inline `tokens.color`. Do not execute application config/services to obtain them.

Implementation follows actual source even when the plan differs. Use the [native-host integration](../../skills/design-system/references/tamagui-integration.md) to understand its aliases; disclose unresolved values instead of inventing fidelity.

| Native input | HTML projection |
|---|---|
| `$surface0` … `$surface3`, `$mediaSurface` | `--surface0` … `--surface3`, `--mediaSurface`, resolved separately in each theme |
| `$text0` … `$text3`, `$color`, `$colorN` | Same-named CSS variables from the actual semantic/theme values |
| `$accentDeep`, `$accentBase`, `$accentSoft`, `$accentOnAccent` | Same-named variables, including the contrast-tested on-accent foreground |
| `$borderColor`, status foreground/background aliases | Preserve names and pairings; define every used alias |
| `$background` | `--background` from resolved theme, not a guessed synonym for surface |
| `$1`, `$4`, `$true` in space/size/radius | Resolve that category in installed defaultConfig + config; never use a universal pixel lookup |
| Named brand `$sm`, `$lg`, etc. | Resolve the named key; never remap onto numbered defaults |
| `$body`, `$heading`, `$mono` and font-size tokens | Actual configured family/face, size, weight, line-height, letter-spacing |
| Brand typography ratio/em fields | CSS unitless line-height and em tracking; native config uses size × ratio/em |

Raw `bg`/`surface`/`primary` brand fields may be transformed by `withPowerAppsSemanticAliases`; compare resolved aliases, not merely raw inputs. Light values must never leak into dark surfaces/text. Resolve any used nested theme explicitly.

Every `var(--name)` must have a value in every advertised theme. In particular, the shell defines **both `--surface0` and `--surface1`** in light and dark. Add other used variables from actual inputs. Missing tokens or assets are reported, not silently filled with a generic preset.

## 2. Component and behavior projection

| Source | HTML/CSS approach |
|---|---|
| `YStack`, `XStack`, `Stack` | Flex container; preserve direction, alignment, gap, wrapping and dimensions |
| `SafeAreaView` | Represent owned edges once; the phone shell is not an additional native inset |
| `ScrollView`, `FlatList` | Scrollable content, `min-height:0`; enough coherent scenario rows to expose the task |
| `H2`–`H5`, `Text`, `Paragraph` | Appropriate heading/text semantics using actual font props, not tag-default sizes |
| `Button`, pressable row, link | Named keyboard-operable button/link; real mock destination/action or explicit limitation |
| `Input`, `TextArea`, `Label`, `Form` | Associated label/control, appropriate type, simulated validation, no real submission |
| `Card`, `ListItem`, `Separator` | Preserve intended grouping/border/radius; do not add a border/shadow by archetype |
| `Switch`, checkbox | Native HTML control with visible label and usable target |
| `AlertDialog`, `Sheet` | Accessible dialog semantics; focus entry/containment/return, Escape/cancel |
| `Avatar`, image/media | Suitable local or verified public HTTPS imagery under the media-source policy; preserve source crop/aspect and label private-media substitutes |
| `Spinner`, skeleton | Scenario-selectable loading feedback; respect reduced motion |
| `Theme`, press/focus/disabled style | Resolve subtree theme and actual interaction appearance |
| Native camera/PDF/pen/share/upload etc. | Named native-only placeholder, never fake a native invocation |

Shorthands preserve meaning: `p`/`px`/`py` → padding, `bg` → background, `items` → align-items, `justify` → justify-content, `rounded` → border-radius. Resolve numeric/token props in their correct category.

Use a coherent illustrative scenario, not independent random filler on every screen. Read source handlers/branches for implementation. Browser state is small and in-memory; never reimplement auth, connectors, device APIs, or production persistence. A relevant error/retry or validation branch is part of the journey, not something to omit automatically.

Use consistent simple icon approximations and text labels; decorative icons are `aria-hidden`. Icons alone need an accessible name. Keep suitable source media, local or remote, when it communicates the task. Apply [media sources](media-sources.md) for URL verification, licensing and private-media substitutions. Do not invent missing source loading/error handlers; report the gap. A missing image/font must have an honest fallback label, not an unrelated remote placeholder.

## 3. Safety and fidelity

Escape untrusted values separately for text, attributes, CSS, and JS (including closing-script sequences); prefer `textContent` for dynamic labels. No imported executable HTML/JS, external scripts, remote font imports, live tenant data, or unexpected network calls. Never interpolate untrusted values into shell commands.
Declared verified HTTPS image-media requests are expected, not a blanket network violation.

Hard checks: unique IDs, reachable required actions/destinations, names/labels, keyboard/focus, contrast, essential-content reflow, token closure in both themes, and clear mock/native boundaries. Style similarity and composition heuristics are advisory.

## 4. Adaptable phone shell

Replace placeholders with escaped model-authored content and **resolved** values before writing. `{{LIGHT_EXTRA_VARIABLES}}` / `{{DARK_EXTRA_VARIABLES}}` include all additional used aliases and token categories. Font rules use approved local assets if available, not a network import. The shell establishes no screen layout.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{APP_NAME}} — {{MODE}} preview</title>
<style>
  :root {
    --surface0: {{light.surface0}}; --surface1: {{light.surface1}};
    --background: {{light.background}}; --text0: {{light.text0}};
    --accentBase: {{light.accentBase}}; --accentOnAccent: {{light.accentOnAccent}};
    --font-body: {{font.body}}; --font-heading: {{font.heading}};
    {{LIGHT_EXTRA_VARIABLES}}
  }
  html.dark {
    --surface0: {{dark.surface0}}; --surface1: {{dark.surface1}};
    --background: {{dark.background}}; --text0: {{dark.text0}};
    --accentBase: {{dark.accentBase}}; --accentOnAccent: {{dark.accentOnAccent}};
    {{DARK_EXTRA_VARIABLES}}
  }
  {{LOCAL_FONT_RULES}}
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 12px; background: var(--surface0); color: var(--text0); font-family: var(--font-body); }
  .preview-header, .preview-nav { max-width: 760px; margin: 0 auto 16px; }
  .preview-nav { display: flex; flex-wrap: wrap; gap: 8px; }
  button, input, textarea, select { font: inherit; }
  button, .preview-nav a { min-height: 48px; min-width: 48px; }
  button { cursor: pointer; }
  button:disabled { cursor: not-allowed; }
  :focus-visible { outline: 3px solid var(--accentBase); outline-offset: 3px; }
  .preview-nav [aria-current="page"] { background: var(--accentBase); color: var(--accentOnAccent); }
  .phone { width: min(100%, 390px); height: 844px; margin: auto; background: var(--surface1); border: 1px solid currentColor; border-radius: 24px; overflow: hidden; }
  .screen-area { height: 100%; overflow: auto; }
  .screen { min-height: 100%; }
  [hidden] { display: none !important; }
  @media (max-width: 420px) { body { padding: 12px 8px; } .phone { border-radius: 12px; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  {{SCREEN_STYLES}}
</style>
</head>
<body>
  <header class="preview-header">
    <h1>{{APP_NAME}}</h1>
    <p>{{MODE}} · Illustrative scenario: {{SCENARIO}}</p>
    <p>{{LIMITATIONS}}</p>
    <button id="theme-toggle" type="button" aria-pressed="false">Dark theme</button>
    {{SCENARIO_CONTROLS}}
  </header>
  <nav class="preview-nav" aria-label="Preview screens">{{TABS}}</nav>
  <main class="phone"><div class="screen-area">{{SCREENS}}</div></main>
  <script>
    function showScreen(id, moveFocus = true) {
      const target = document.getElementById(id);
      if (!target || !target.classList.contains('screen')) return false;
      document.querySelectorAll('.screen').forEach(screen => { screen.hidden = screen !== target; });
      document.querySelectorAll('[data-screen]').forEach(button => {
        if (button.dataset.screen === id) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      if (moveFocus) target.focus();
      return true;
    }
    document.querySelectorAll('[data-screen]').forEach(button => {
      button.addEventListener('click', () => showScreen(button.dataset.screen));
    });
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) themeToggle.addEventListener('click', () => {
      const dark = document.documentElement.classList.toggle('dark');
      themeToggle.setAttribute('aria-pressed', String(dark));
      themeToggle.textContent = dark ? 'Light theme' : 'Dark theme';
    });
    const first = document.querySelector('.screen');
    if (first) showScreen(first.id, false);
    {{MOCK_JOURNEY_SCRIPT}}
  </script>
</body>
</html>
```

Navigation example: `<button type="button" data-screen="screen-review">Review</button>`.
Screen example: `<section class="screen" id="screen-review" tabindex="-1" aria-label="Review" hidden>…</section>`.
Choose order/IDs from the journey. Add key-action transitions and reset in `{{MOCK_JOURNEY_SCRIPT}}`; merely switching preview tabs is not a working primary journey. Omit the theme toggle and unresolved theme block if only one theme is available, and disclose that limit.
