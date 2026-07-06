# Design System Gallery — HTML Preview Template

Deterministic HTML template for `brand/design-system.html`. **Zero LLM cost** — all values are substituted from `brand/design-system.md`.

## Template

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{{app_name}} — Design System</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  @import url('https://fonts.googleapis.com/css2?family={{heading_font_url}}&family={{body_font_url}}&display=swap');
  <style>
    :root {
      --bg: {{palette.bg}};
      --surface: {{palette.surface}};
      --primary: {{palette.primary}};
      --accent: {{palette.accent}};
      --text: {{palette.text}};
      --text-muted: {{palette.text_muted}};
      --border: {{palette.border}};
      --status-success: {{status.success}};
      --status-warning: {{status.warning}};
      --status-danger: {{status.danger}};
      --status-info: {{status.info}};
      --heading-font: '{{typography.heading_family}}', system-ui, sans-serif;
      --body-font: '{{typography.body_family}}', system-ui, sans-serif;
      --mono-font: '{{typography.mono_family}}', monospace;
      --radius-sm: {{radius.sm}}px;
      --radius-md: {{radius.md}}px;
      --radius-lg: {{radius.lg}}px;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: var(--body-font); background: #f5f5f7; color: var(--text); }

    .container { max-width: 1200px; margin: 0 auto; padding: 32px; }

    /* Header */
    .header {
      text-align: center; padding: 48px 24px; margin-bottom: 48px;
      background: var(--bg); border-radius: 16px; border: 1px solid var(--border);
    }
    .header h1 { font-family: var(--heading-font); font-size: 36px; font-weight: 700; margin-bottom: 8px; }
    .header .meta { color: var(--text-muted); font-size: 14px; }
    .header .direction-badge {
      display: inline-block; margin-top: 12px; padding: 4px 12px;
      background: var(--primary); color: white; border-radius: 999px; font-size: 12px; font-weight: 600;
    }

    /* Section */
    .section { margin-bottom: 48px; }
    .section h2 { font-family: var(--heading-font); font-size: 24px; font-weight: 600; margin-bottom: 20px; padding-bottom: 8px; border-bottom: 2px solid var(--border); }

    /* Palette swatches */
    .swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
    .swatch {
      border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--border);
      background: white;
    }
    .swatch-color { height: 64px; }
    .swatch-label { padding: 8px 10px; font-size: 12px; }
    .swatch-label .name { font-weight: 600; }
    .swatch-label .hex { color: var(--text-muted); font-family: var(--mono-font); }

    /* Typography ladder */
    .type-ladder { display: flex; flex-direction: column; gap: 16px; }
    .type-row { display: flex; align-items: baseline; gap: 16px; padding: 12px 0; border-bottom: 1px solid #eee; }
    .type-role { width: 80px; font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; flex-shrink: 0; }
    .type-sample { flex: 1; }

    /* Component gallery */
    .components { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
    .component-card { background: white; border-radius: var(--radius-lg); padding: 24px; border: 1px solid var(--border); }
    .component-card h3 { font-size: 14px; color: var(--text-muted); margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.05em; }

    /* Buttons */
    .btn { display: inline-flex; align-items: center; justify-content: center; padding: 10px 20px; font-family: var(--body-font); font-size: 15px; font-weight: 500; border: none; cursor: pointer; transition: all 0.15s; }
    .btn-primary { background: var(--primary); color: white; border-radius: var(--radius-md); }
    .btn-secondary { background: transparent; color: var(--primary); border: 1px solid var(--border); border-radius: var(--radius-md); }
    .btn-tertiary { background: transparent; color: var(--primary); border: none; text-decoration: underline; }
    .btn-destructive { background: var(--status-danger); color: white; border-radius: var(--radius-md); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }

    /* Inputs */
    .input-demo { display: flex; flex-direction: column; gap: 12px; }
    .input {
      height: {{size.inputHeight}}px; padding: 0 12px; font-family: var(--body-font); font-size: 16px;
      border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface);
    }
    .input:focus { outline: none; border-color: var(--primary); border-width: 2px; }
    .input-error { border-color: var(--status-danger); }

    /* Cards */
    .card-demo { display: flex; gap: 16px; }
    .card {
      background: var(--surface); border-radius: var(--radius-md); padding: 16px;
      border: 1px solid var(--border); flex: 1;
    }
    .card-elevated { box-shadow: 0 1px 3px rgba(0,0,0,0.1); border: none; }
    .card h4 { font-family: var(--heading-font); font-size: 16px; font-weight: 600; margin-bottom: 4px; }
    .card p { font-size: 14px; color: var(--text-muted); }

    /* List rows */
    .list-demo { border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
    .list-row {
      display: flex; align-items: center; gap: 12px; padding: 12px 16px;
      height: {{size.listRowHeight}}px; border-bottom: 1px solid var(--border);
    }
    .list-row:last-child { border-bottom: none; }
    .list-row .status-bar { width: 4px; height: 32px; border-radius: 2px; flex-shrink: 0; }
    .list-row .content { flex: 1; }
    .list-row .title { font-weight: 500; font-size: 15px; }
    .list-row .meta { font-size: 13px; color: var(--text-muted); }

    /* Badges */
    .badge {
      display: inline-flex; align-items: center; padding: 2px 8px;
      border-radius: 999px; font-size: 12px; font-weight: 500;
    }
    .badge-success { background: {{status.success}}22; color: var(--status-success); }
    .badge-warning { background: {{status.warning}}22; color: var(--status-warning); }
    .badge-danger { background: {{status.danger}}22; color: var(--status-danger); }
    .badge-info { background: {{status.info}}22; color: var(--status-info); }
    .badge-row { display: flex; gap: 8px; flex-wrap: wrap; }

    /* Negatives */
    .negatives { background: #fef2f2; border-radius: var(--radius-md); padding: 20px; }
    .negatives ul { list-style: none; }
    .negatives li { padding: 4px 0; color: #991b1b; font-size: 14px; text-decoration: line-through; }
    .negatives li::before { content: '✗ '; font-weight: 700; }

    /* Phone frame */
    .phone-frame-container { display: flex; justify-content: center; padding: 32px 0; }
    .phone-frame {
      width: 375px; height: 812px; border-radius: 40px; overflow: hidden;
      border: 8px solid #1a1a1a; background: var(--bg);
      box-shadow: 0 20px 60px rgba(0,0,0,0.15);
    }
    .phone-frame .status-bar-mock {
      height: 44px; display: flex; align-items: center; justify-content: center;
      font-size: 14px; font-weight: 600;
    }
    .phone-content { padding: 0 16px; }

    /* Footer */
    .footer { text-align: center; padding: 32px; color: var(--text-muted); font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <!-- 1. Header -->
    <div class="header">
      <h1>{{app_name}}</h1>
      <div class="meta">Design System | Generated {{date}} | /design-system v0.1</div>
      <span class="direction-badge">{{direction}}</span>
    </div>

    <!-- 2. Palette -->
    <div class="section">
      <h2>Palette</h2>
      <div class="swatches">
        <!-- Repeat for each token in ## Palette -->
        <div class="swatch">
          <div class="swatch-color" style="background: {{hex}}"></div>
          <div class="swatch-label">
            <div class="name">{{token_name}}</div>
            <div class="hex">{{hex}}</div>
            <div style="font-size:11px;color:var(--text-muted)">{{usage}}</div>
          </div>
        </div>
        <!-- ... -->
      </div>
    </div>

    <!-- 3. Status palette -->
    <div class="section">
      <h2>Status Palette</h2>
      <div class="swatches">
        <!-- Repeat for success, warning, danger, info -->
        <div class="swatch">
          <div class="swatch-color" style="background: {{hex}}"></div>
          <div class="swatch-label">
            <div class="name">{{name}}</div>
            <div class="hex">{{hex}}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 4. Typography ladder -->
    <div class="section">
      <h2>Typography</h2>
      <div class="type-ladder">
        <!-- Repeat for each role in ## Typography -->
        <div class="type-row">
          <div class="type-role">{{role}}</div>
          <div class="type-sample" style="font-family: {{family}}; font-size: {{size}}px; font-weight: {{weight}}; line-height: {{line_height}}; letter-spacing: {{tracking}};">
            The quick brown fox jumps over the lazy dog
          </div>
        </div>
      </div>
    </div>

    <!-- 5. Component gallery -->
    <div class="section">
      <h2>Components</h2>
      <div class="components">
        <!-- Buttons -->
        <div class="component-card">
          <h3>Buttons</h3>
          <div class="btn-row">
            <button class="btn btn-primary">Primary</button>
            <button class="btn btn-secondary">Secondary</button>
            <button class="btn btn-tertiary">Tertiary</button>
            <button class="btn btn-destructive">Destructive</button>
          </div>
          <div class="btn-row">
            <button class="btn btn-primary" disabled>Disabled</button>
          </div>
        </div>

        <!-- Inputs -->
        <div class="component-card">
          <h3>Inputs</h3>
          <div class="input-demo">
            <input class="input" placeholder="Default input" />
            <input class="input" style="border-color: var(--primary); border-width: 2px;" placeholder="Focused input" />
            <input class="input input-error" placeholder="Error input" />
          </div>
        </div>

        <!-- Cards -->
        <div class="component-card">
          <h3>Cards</h3>
          <div class="card-demo">
            <div class="card">
              <h4>Flat Card</h4>
              <p>Border-defined, no shadow</p>
            </div>
            <div class="card card-elevated">
              <h4>Elevated Card</h4>
              <p>Shadow-defined, no border</p>
            </div>
          </div>
        </div>

        <!-- Badges -->
        <div class="component-card">
          <h3>Badges</h3>
          <div class="badge-row">
            <span class="badge badge-success">Completed</span>
            <span class="badge badge-warning">In Progress</span>
            <span class="badge badge-danger">Overdue</span>
            <span class="badge badge-info">Scheduled</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 6. List rows -->
    <div class="section">
      <h2>List Rows</h2>
      <div class="list-demo">
        <div class="list-row">
          <div class="status-bar" style="background: var(--status-success)"></div>
          <div class="content">
            <div class="title">Boiler Room — Lvl 3, panel 4 (north wall…</div>
            <div class="meta">J. Martínez · 2h ago</div>
          </div>
          <span class="badge badge-success">Done</span>
        </div>
        <div class="list-row">
          <div class="status-bar" style="background: var(--status-warning)"></div>
          <div class="content">
            <div class="title">HVAC Unit #4 — Roof access required</div>
            <div class="meta">A. Chen · Yesterday</div>
          </div>
          <span class="badge badge-warning">In Progress</span>
        </div>
        <div class="list-row">
          <div class="status-bar" style="background: var(--status-danger)"></div>
          <div class="content">
            <div class="title">Fire suppression check — overdue</div>
            <div class="meta">—</div>
          </div>
          <span class="badge badge-danger">Overdue</span>
        </div>
      </div>
    </div>

    <!-- 7. Negatives -->
    <div class="section">
      <h2>Forbidden Patterns (Negatives)</h2>
      <div class="negatives">
        <ul>
          <!-- Repeat for each rule in ## Negatives -->
          <li>{{negative_rule}}</li>
        </ul>
      </div>
    </div>

    <!-- Footer -->
    <div class="footer">
      Generated by /design-system v0.1 | {{app_name}} | {{direction}} direction<br>
      Source of truth: brand/design-system.md | Tokens: brand/tokens.ts
    </div>
  </div>
</body>
</html>
```

## Substitution rules

1. All `{{variable}}` placeholders are replaced with values from `brand/design-system.md`
2. Palette swatches: iterate over `## Palette` table rows
3. Status swatches: iterate over `## Status palette` table rows
4. Typography ladder: iterate over `## Typography` table rows, render each at actual size/weight
5. Negatives: iterate over `## Negatives` list items
6. List row sample data: synthesize 3 rows from the app's entity names (use realistic edge-case data)
7. Google Fonts import: construct URL from heading + body font families (skip if system fonts)

## Rendering notes

- **Zero LLM cost** — this is pure template substitution
- Font import via Google Fonts `@import` for self-contained HTML
- If heading font is proprietary (UberMove, Saans), fall back to Inter in the preview
- Badge background colors use the status hex + `22` suffix (13% opacity)
- List row sample data should include one truncated title, one missing meta, one edge timestamp
