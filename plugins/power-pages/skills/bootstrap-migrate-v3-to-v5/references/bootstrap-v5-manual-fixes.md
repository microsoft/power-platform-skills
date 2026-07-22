# Bootstrap 5 Manual-Fix Recipes (residual items the engine only logs)

`pac pages bootstrap-migrate` auto-applies the well-known class renames but can only **flag**
structural ("hierarchy") changes and changes that require new CSS. Those appear in `logs.txt`
as `Need hierarchy change for …` lines or as "replaced with styles" notes. This reference is the
recipe book the `/bootstrap-migrate-v3-to-v5` skill uses in **Phase 6** to apply (or flag) each one.

**Apply with per-category consent. Never blindly rewrite Liquid-entangled markup — flag it instead.**
After each edit, re-check the affected lines against the file's `<file>-diff.json` so you don't
disturb the engine's auto-applied changes.

---

## 1. Grid hierarchy — move `.row` inside a `.container`

**Log signal:** `Need hierarchy change` referencing `row` / "Moving row inside container".

**Why:** Bootstrap 5 grid requires rows to live inside a `.container` / `.container-fluid` (or a
`.col`). Bootstrap 3 markup often has bare `.row`s.

**Before**
```html
<div class="row">
  <div class="col-lg-6">…</div>
</div>
```

**After**
```html
<div class="container">
  <div class="row">
    <div class="col-lg-6">…</div>
  </div>
</div>
```

**Watch for:** reverse-row layouts — if the original used a `flex-direction: row-reverse` style,
keep it on the `.row` element (`<div class="row" style="flex-direction: row-reverse;">`).

---

## 2. Navbar structure

### 2a. Delete `navbar-header`

**Log signal:** "navbar-header is dropped. Delete the division containing this class".

**Before**
```html
<nav class="navbar navbar-expand-md">
  <div class="navbar-header">
    <button class="navbar-toggler" ...><span class="navbar-toggler-icon"></span></button>
    <a class="navbar-brand" href="/">Brand</a>
  </div>
  <div class="collapse navbar-collapse">…</div>
</nav>
```

**After** — remove the `navbar-header` wrapper, lift its children to be direct children of `.navbar`:
```html
<nav class="navbar navbar-expand-md">
  <a class="navbar-brand" href="/">Brand</a>
  <button class="navbar-toggler" ...><span class="navbar-toggler-icon"></span></button>
  <div class="collapse navbar-collapse">…</div>
</nav>
```

### 2b. Collapse three `icon-bar`s into one `navbar-toggler-icon`

**Log signal:** "One navbar-toggler-icon is sufficient to replace 3 icon-bar".

**Before**
```html
<button class="navbar-toggler" ...>
  <span class="icon-bar"></span><span class="icon-bar"></span><span class="icon-bar"></span>
</button>
```

**After**
```html
<button class="navbar-toggler" ...><span class="navbar-toggler-icon"></span></button>
```

> The engine adds `navbar-expand-md`, `nav-item`, and `nav-link` where it can. Verify the toggler's
> `data-bs-toggle="collapse"` / `data-bs-target` point at the collapse container's id.

---

## 3. Panels → cards: contextual classes need CSS

The engine maps `panel*` → `card*` but **contextual** panel classes
(`panel-primary/success/info/warning/danger`) carried color styling that Bootstrap 5 cards don't
reproduce. The engine flags these as "replaced with styles."

**Apply the inline style on the card** (Bootstrap-3 color values):

| Class | Add to the card element |
|-------|-------------------------|
| `panel-primary` | `style="color:#fff;background-color:#337ab7;border-color:#337ab7;"` |
| `panel-success` | `style="color:#3c763d;background-color:#dff0d8;border-color:#d6e9c6;"` |
| `panel-info` | `style="color:#31708f;background-color:#d9edf7;border-color:#bce8f1;"` |
| `panel-warning` | `style="color:#8a6d3b;background-color:#fcf8e3;border-color:#faebcc;"` |
| `panel-danger` | `style="color:#a94442;background-color:#f2dede;border-color:#ebccd1;"` |

**Before**
```html
<div class="panel panel-primary"> … </div>
```

**After**
```html
<div class="card" style="color:#fff;background-color:#337ab7;border-color:#337ab7;"> … </div>
```

> Prefer migrating these to project CSS classes or Bootstrap 5 utilities (`text-bg-primary`, border
> utilities) if the user wants a cleaner result — the inline styles are a faithful 1:1 fallback.

---

## 4. Page header — `page-header` dropped

**Log signal:** "page-header is dropped. Can be replaced with style attributes".

**Before**
```html
<div class="page-header"><h1>Title</h1></div>
```

**After**
```html
<div style="padding-bottom:9.5px;margin:42px 0 21px;border-bottom:1px solid #eee;"><h1>Title</h1></div>
```

---

## 5. Pager — dropped, replace with styles

**Log signal:** "Pager is dropped. Replacing with style attributes to achieve the same effects".

**Before**
```html
<ul class="pager">
  <li class="previous"><a href="#">← Older</a></li>
  <li class="next"><a href="#">Newer →</a></li>
</ul>
```

**After**
```html
<ul style="padding-left:0;margin:20px 0;text-align:center;list-style:none;">
  <li style="display:inline;">
    <a style="display:inline-block;padding:5px 14px;background-color:#fff;border:1px solid #ddd;border-radius:15px;float:left;" href="#">← Older</a>
  </li>
  <li style="display:inline;">
    <a style="display:inline-block;padding:5px 14px;background-color:#fff;border:1px solid #ddd;border-radius:15px;float:right;" href="#">Newer →</a>
  </li>
</ul>
```

> For a plain (non-prev/next) pager link use the base style without the `float`. Regular
> `pagination` markup (`page-item` / `page-link`) is handled automatically — only `pager` needs this.

---

## 6. Button block — `btn-block` → `.d-grid`

**Log signal:** "Instead of using .btn-block, wrap buttons with .d-grid and a .gap-*".

**Before**
```html
<button class="btn btn-primary btn-block">Save</button>
```

**After**
```html
<div class="d-grid gap-2">
  <button class="btn btn-primary">Save</button>
</div>
```

> Group adjacent full-width buttons inside a single `.d-grid gap-2` wrapper.

---

## 7. Form structure

The engine renames most form classes (`control-label` → `col-form-label`, `input-lg` →
`form-control-lg`, `input-group-addon` → `input-group-text`, `help-block` → `form-text`, etc.) but a
few are structural / deprecated:

| Bootstrap 3 | Action in Bootstrap 5 |
|-------------|-----------------------|
| `form-group` | Deprecated; use spacing utilities (e.g. `mb-3`) on the wrapper, or `.row` for horizontal forms |
| `form-inline` | Removed; rebuild with grid/flex utilities (`d-flex`, `gap-*`, `align-items-center`) |
| `form-horizontal` | Removed; use `.row` + `col-form-label` + grid columns |
| `form-control-static` | `form-control-plaintext` |

These need a judgment call about the intended layout — apply the closest utility-based equivalent and
flag for visual QA.

---

## 8. Carousel

The engine handles most carousel renames (`item` → `carousel-item`, glyphicon chevrons →
`carousel-control-prev-icon` / `-next-icon`, drops `carousel-control`). Verify the result matches the
Bootstrap 5 control structure:

```html
<button class="carousel-control-prev" type="button" data-bs-target="#myCarousel" data-bs-slide="prev">
  <span class="carousel-control-prev-icon"></span>
</button>
```

Ensure carousel images carry `d-block w-100` and that `data-bs-ride` / `data-bs-slide-to` replaced the
`data-ride` / `data-slide-to` attributes.

---

## 9. Glyphicons → icons

Bootstrap 5 ships no glyphicons. The engine maps a few known ones (e.g. `glyphicon-search` →
`fa-solid fa-magnifying-glass`, carousel chevrons). Any remaining `glyphicon-*` references must be
replaced with the site's icon library (Font Awesome / Bootstrap Icons). List remaining glyphicons for
the user and propose mappings — don't guess silently for icons with no obvious equivalent.

---

## 10. Liquid edge cases — flag, don't rewrite

Where Bootstrap classes are entangled with Liquid, the engine deliberately leaves them. **Flag these
for the user with file + line; do not auto-rewrite:**

- Conditional dropdowns: `{% if … %} … dropdown … {% endif %}`.
- Class values built inside Liquid (`class="{% if … %}…{% endif %}"`).
- Liquid tags containing `>` (`{% … > … %}`) near markup the mappers scan.

For these, describe the change the user should make (e.g. add `dropdown-menu-end`, rename
`data-toggle` → `data-bs-toggle`) rather than editing across the Liquid boundary.

---

## 11. Web template partial paths — `RenderPartialHtml`

**Log signal:** runtime replacement note for `RenderPartialHtml`.

If web templates reference partials by path that changed during migration, update the
`RenderPartialHtml` path so the partial resolves. Verify against the migrated folder structure.

---

## Order of operations within a file

1. Let the engine's auto-applied changes stand (they're already in the V5 copy).
2. Apply structural fixes outermost-first: container/row hierarchy (§1) and navbar (§2) before
   component-level styling (§3–§9).
3. Re-render and visually QA — these residual fixes are exactly the ones the engine couldn't verify,
   so they're the most likely source of layout regressions.
