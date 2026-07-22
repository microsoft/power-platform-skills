# Tamagui → HTML/CSS Mapping Reference

Reference for converting React Native / Tamagui screens to static HTML previews. Used by the `/preview-screens` skill.

---

## 1. Component Mapping

| Tamagui Component | HTML Element | Key CSS |
|---|---|---|
| `YStack` | `<div>` | `display:flex; flex-direction:column;` |
| `XStack` | `<div>` | `display:flex; flex-direction:row;` |
| `Stack` | `<div>` | `display:flex;` |
| `SafeAreaView` | `<div>` | `padding-top:44px; flex:1;` |
| `ScrollView` | `<div>` | `overflow-y:auto; flex:1;` |
| `KeyboardAvoidingView` | `<div>` | `flex:1;` (no keyboard behavior in HTML) |
| `H2` | `<h2>` | `font-size:28px; font-weight:700; color:var(--color);` |
| `H3` | `<h3>` | `font-size:23px; font-weight:700; color:var(--color);` |
| `H4` | `<h4>` | `font-size:20px; font-weight:600; color:var(--color);` |
| `H5` | `<h5>` | `font-size:17px; font-weight:600; color:var(--color);` |
| `Text` | `<span>` | `color:var(--color);` |
| `SizableText` | `<span>` | `color:var(--color);` + font-size from `size` prop |
| `Paragraph` | `<p>` | `color:var(--color); line-height:1.5;` |
| `Button` | `<button>` | `padding:10px 18px; border-radius:8px; border:1px solid var(--border-color); background:var(--color2); color:var(--color); cursor:pointer; font-weight:500; font-family:inherit;` |
| `Button bg="$blue10" color="$color1"` | `<button>` | `background:var(--blue10); color:var(--color1); border:none;` |
| `Button theme="red"` | `<button>` | `background:var(--red10); color:#fff; border:none;` |
| `Button circular` | `<button>` | Add `border-radius:50%; width:40px; height:40px; padding:0; display:flex; align-items:center; justify-content:center;` |
| `Button disabled` | `<button>` | Add `opacity:0.5; cursor:not-allowed;` |
| `Input` | `<input>` | `padding:10px 12px; border:1px solid var(--border-color); border-radius:8px; background:var(--background); color:var(--color); font-size:16px; width:100%; box-sizing:border-box; font-family:inherit;` |
| `TextArea` | `<textarea>` | Same as Input + `min-height:100px; resize:vertical;` |
| `Label` | `<label>` | `font-size:14px; font-weight:500; color:var(--color);` |
| `Form` | `<form>` | Standard semantics |
| `Form.Trigger` | — | Wrapping element; render the child `<button>` directly |
| `Card` | `<div>` | `border:1px solid var(--border-color); border-radius:12px; padding:16px; background:var(--background);` |
| `Card bordered` | `<div>` | Same as Card (bordered is default) |
| `Separator` | `<hr>` | `border:none; border-top:1px solid var(--border-color); margin:8px 0;` |
| `Avatar` | `<div>` | `width:40px; height:40px; border-radius:50%; overflow:hidden; background:var(--color4); display:flex; align-items:center; justify-content:center;` |
| `Avatar.Image` | `<img>` | `width:100%; height:100%; object-fit:cover;` |
| `Avatar.Fallback` | `<span>` | `font-size:14px; font-weight:600;` |
| `FlatList` | `<div>` | `overflow-y:auto; flex:1;` — render 3–4 representative child items |
| `ListItem` | `<div>` | `display:flex; align-items:center; padding:12px 16px; gap:12px; border-bottom:1px solid var(--border-color);` |
| `AlertDialog` | `<div>` (overlay) | `position:absolute; inset:0; background:rgba(0,0,0,0.4); display:none; align-items:center; justify-content:center; z-index:50;` |
| `AlertDialog.Content` | `<div>` | `background:var(--background); border-radius:12px; padding:20px; max-width:300px; width:85%;` |
| `Sheet` | `<div>` (overlay) | Same overlay; content anchored to bottom with `border-radius:12px 12px 0 0;` |
| `Sheet.Handle` | `<div>` | `width:36px; height:4px; border-radius:2px; background:var(--color4); margin:0 auto 12px;` |
| `Switch` | `<div>` | Styled toggle: `width:44px; height:24px; border-radius:12px; background:var(--color4);` with inner thumb |
| `Spinner` | `<div>` | `width:20px; height:20px; border:2px solid var(--color4); border-top-color:var(--blue10); border-radius:50%; animation:spin 0.8s linear infinite;` |
| `Theme name="red"` | wrapper `<div>` | Set `--accent:var(--red10)` on this subtree |

---

## 2. Token Tables

### Spacing tokens

| Token | CSS |
|---|---|
| `$1` | `4px` |
| `$2` | `8px` |
| `$3` | `12px` |
| `$4` | `16px` |
| `$5` | `20px` |
| `$6` | `24px` |
| `$8` | `32px` |
| `$10` | `40px` |
| `$true` | `16px` |

### Font-size tokens

| Token | CSS |
|---|---|
| `$1` | `11px` |
| `$2` | `12px` |
| `$3` | `13px` |
| `$4` | `14px` |
| `$5` | `16px` |
| `$6` | `18px` |
| `$7` | `20px` |
| `$8` | `23px` |
| `$9` | `28px` |
| `$10` | `34px` |

### Shorthand props

| Prop | CSS Property |
|---|---|
| `f` / `flex` | `flex` |
| `bg` / `backgroundColor` | `background` |
| `p` / `padding` | `padding` |
| `px` / `paddingHorizontal` | `padding-left` + `padding-right` |
| `py` / `paddingVertical` | `padding-top` + `padding-bottom` |
| `m` / `margin` | `margin` |
| `mb` / `marginBottom` | `margin-bottom` |
| `mt` / `marginTop` | `margin-top` |
| `br` / `borderRadius` | `border-radius` |
| `ai` / `alignItems` | `align-items` |
| `jc` / `justifyContent` | `justify-content` |
| `col` / `color` | `color` |
| `gap` | `gap` |
| `h` / `height` | `height` |
| `w` / `width` | `width` |
| `ta` / `textAlign` | `text-align` |

### Theme colors

| Token | Light | Dark | CSS Variable |
|---|---|---|---|
| `$background` | `#ffffff` | `#1a1a1a` | `var(--background)` |
| `$backgroundStrong` | `#f5f5f5` | `#000000` | `var(--bg-strong)` |
| `$color` | `#1a1a1a` | `#f5f5f5` | `var(--color)` |
| `$color2` | `#f0f0f0` | `#2a2a2a` | `var(--color2)` |
| `$color4` | `#e0e0e0` | `#3a3a3a` | `var(--color4)` |
| `$color5` | `#d0d0d0` | `#4a4a4a` | `var(--color5)` |
| `$color9` | `#888888` | `#8e8e93` | `var(--color9)` |
| `$color10` | `#666666` | `#a0a0a0` | `var(--color10)` |
| `$color12` | `#111111` | `#f5f5f7` | `var(--color12)` |
| `$borderColor` | `#e0e0e0` | `#3a3a3a` | `var(--border-color)` |
| `$red8` | `#e25050` | `#e25050` | `var(--red8)` |
| `$red10` | `#d13438` | `#ff6369` | `var(--red10)` |
| `$blue10` | `#0078d4` | `#7c96f3` | `var(--blue10)` |

---

## 3. Conversion Guidelines

1. **Static approximation only.** Do not replicate React state, hooks, or data fetching. Show the populated/happy-path state with placeholder data.

2. **Dynamic lists.** When you see `.map()` over an array or a `FlatList`, generate **3–4 items** with plausible placeholder text relevant to the domain (e.g., recipe names, employee names, inspection IDs).

3. **Conditional renders.** Show only the primary data-present branch. Skip loading skeletons and error states.

4. **Icons.** Replace Lucide icon components with Unicode or simple text:
   - `Plus` → `+`
   - `Edit3` → `✎`
   - `Trash2` → `🗑`
   - `ChevronLeft` → `‹`
   - `ChevronRight` → `›`
   - `Search` → `🔍`
   - `X` → `✕`
   - `Check` → `✓`
   - `Settings` → `⚙`
   - `User` → `👤`
   - `LogOut` → `↪`
   - Other → use the component name as text in a small gray circle

5. **pressStyle / animation.** Ignore — static preview only. Add `:hover { opacity: 0.85; }` on buttons for minimal interactivity.

6. **Theme cascading.** When `<Theme name="red">` wraps a subtree, apply `color:var(--red10)` to text and `background:var(--red10)` to buttons within that subtree's HTML.

7. **Images.** Use a placeholder rectangle: `background:var(--color4); border-radius:8px;` with the same dimensions. Add a centered "📷" if the image is a user avatar or photo.

8. **Custom brand tokens.** If `tamagui.config.ts` exists in the project and defines custom brand colors (look for `tokens: { color: { ... } }`), extract hex values and add them as additional CSS custom properties (e.g., `--brand-primary: #hex`).

9. **Navigation.** Ignore `useRouter()`, `router.push()`, `router.back()` calls. Buttons that navigate render as normal buttons with no click behavior.

10. **Form validation.** Show form fields in their default (empty or with `defaultValues`) state. Do not show error messages.

---

## 4. Phone Frame HTML Template

Use this as the outer shell for the generated `preview.html`. Replace `{{APP_NAME}}`, `{{TABS}}`, and `{{SCREENS}}` with generated content.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{APP_NAME}} — Screen Preview</title>
<style>
  :root {
    --background: #ffffff; --bg-strong: #f5f5f5;
    --color: #1a1a1a; --color2: #f0f0f0; --color4: #e0e0e0;
    --color5: #d0d0d0; --color9: #888; --color10: #666; --color12: #111;
    --border-color: #e0e0e0;
    --red8: #e25050; --red10: #d13438; --blue10: #0078d4;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  }
  html.dark {
    --background: #1a1a1a; --bg-strong: #000;
    --color: #f5f5f5; --color2: #2a2a2a; --color4: #3a3a3a;
    --color5: #4a4a4a; --color9: #8e8e93; --color10: #a0a0a0; --color12: #f5f5f7;
    --border-color: #3a3a3a;
    --red10: #ff6369; --blue10: #7c96f3;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--font); background: #1a1a2e; min-height: 100vh; padding: 40px 20px; }

  /* Page header */
  .page-title { color: #fff; text-align: center; font-size: 24px; font-weight: 700; margin-bottom: 6px; }
  .page-sub { color: #aaa; text-align: center; font-size: 13px; margin-bottom: 32px; }

  /* Tabs */
  .tabs { display: flex; justify-content: center; gap: 8px; margin-bottom: 28px; flex-wrap: wrap; }
  .tab {
    padding: 7px 18px; border-radius: 20px; border: 1px solid #444;
    background: transparent; color: #ccc; cursor: pointer; font-size: 13px;
    font-family: var(--font); transition: all 0.2s;
  }
  .tab:hover { border-color: #888; color: #fff; }
  .tab.active { background: var(--blue10); border-color: var(--blue10); color: #fff; }

  /* Dark toggle */
  .dark-toggle {
    position: fixed; top: 16px; right: 20px; padding: 7px 14px;
    border-radius: 8px; border: 1px solid #444; background: transparent;
    color: #ccc; cursor: pointer; font-size: 12px; font-family: var(--font);
  }
  .dark-toggle:hover { border-color: #888; color: #fff; }

  /* Phone frame */
  .phone { width: 375px; height: 812px; margin: 0 auto; background: #000; border-radius: 44px; padding: 14px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  .screen-wrap { width: 100%; height: 100%; background: var(--background); border-radius: 34px; overflow: hidden; display: flex; flex-direction: column; }
  .notch { width: 120px; height: 28px; background: #000; border-radius: 0 0 16px 16px; margin: 0 auto; flex-shrink: 0; }
  .screen-area { flex: 1; overflow-y: auto; }
  .screen-area::-webkit-scrollbar { display: none; }

  /* Screen visibility */
  .screen { display: none; min-height: 100%; }
  .screen.active { display: flex; flex-direction: column; }

  /* Home indicator */
  .home-ind { height: 28px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .home-ind div { width: 120px; height: 4px; background: var(--color4); border-radius: 2px; }

  /* Shared component styles */
  hr { border: none; border-top: 1px solid var(--border-color); margin: 8px 0; }
  button { font-family: var(--font); }
  input, textarea { font-family: var(--font); outline: none; }
  input:focus, textarea:focus { border-color: var(--blue10); }

  /* Spin animation for Spinner */
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="page-title">{{APP_NAME}}</div>
  <p class="page-sub">Power Platform · Expo + Tamagui · Screen Preview</p>
  <button class="dark-toggle" onclick="document.documentElement.classList.toggle('dark'); this.textContent = document.documentElement.classList.contains('dark') ? 'Light' : 'Dark'">Dark</button>

  <div class="tabs">
    {{TABS}}
  </div>

  <div class="phone">
    <div class="screen-wrap">
      <div class="notch"></div>
      <div class="screen-area">
        {{SCREENS}}
      </div>
      <div class="home-ind"><div></div></div>
    </div>
  </div>

  <script>
    function showScreen(id) {
      document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
      document.getElementById(id).classList.add('active');
      document.querySelector('[data-screen="' + id + '"]').classList.add('active');
    }
    // Show first screen
    var first = document.querySelector('.screen');
    if (first) first.classList.add('active');
    var firstTab = document.querySelector('.tab');
    if (firstTab) firstTab.classList.add('active');
  </script>
</body>
</html>
```

**Tab markup** (one per screen):
```html
<button class="tab" data-screen="screen-{id}" onclick="showScreen('screen-{id}')">Screen Name</button>
```

**Screen markup** (one per screen):
```html
<div id="screen-{id}" class="screen">
  <!-- Converted HTML here -->
</div>
```
