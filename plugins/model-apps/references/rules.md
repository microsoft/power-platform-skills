# Generative Pages Code Generation Rules Reference

Comprehensive rules for generating generative page code. Read this file during code generation (Step 6).

---

## Critical Rules

1. **React 17 + TypeScript**: All code must use React 17 with TypeScript
2. **Fluent UI V9**: Use `@fluentui/react-components` (DatePicker from `@fluentui/react-datepicker-compat`, TimePicker from `@fluentui/react-timepicker-compat` — both require `mountNode` prop)
3. **Single File**: All code (components, utilities) in one file; each as separate top-level function (no nesting)
4. **Limited Imports**: Only React, Fluent UI V9, FluentUI icons, and D3.js for charts
5. **DataAPI**: ONLY use when explicit TableRegistrations provided; otherwise use mocked data
6. **Entity Logical Names**: Use singular lowercase (e.g., `"account"` not `"accounts"`)
7. **Styling**: Use `makeStyles` with tokens; avoid inline styles except for dynamic values
8. **Responsive Design**: Use flexbox and relative units; NEVER use `100vh`/`100vw`
9. **Icons — verified names only**: Import from `@fluentui/react-icons`; use unsized variants only (e.g., `AddRegular` not `Add24Regular`). Icon names are frequently hallucinated — names like `MedicalRegular`, `PawRegular`, `AnimalRabbitRegular`, `BirdRegular` do not exist. **Always Read `${CLAUDE_PLUGIN_ROOT}/references/verified-icons.txt`** (~5000 names) and cross-check every icon import against that list. After writing, Grep your own output for `from "@fluentui/react-icons"` and verify each named import. If an icon you want is not in the list, pick the closest semantic substitute that is. Never guess a name.
10. **No External Libraries**: No routing libraries (React Router) or assumptions of implicit dependencies
11. **No FluentProvider**: Already provided at root — adding another causes a double-render flicker in React 17. For dark mode/theme overrides, use the `themeToVars` two-div pattern in **Special Patterns > Dark Mode Toggle**.
12. **Forbidden Functions**: Don't use `createTheme`, `mergeThemes`, `useTheme` (don't exist in Fluent UI V9)
13. **Navigation**: Use the `Xrm.Navigation.navigateTo` API for all in-app navigation. Never construct raw URLs or manipulate `window.location` — see **Special Patterns > Generative Page Navigation**.
14. **Batched async state — no intermediate renders**: React 17 does NOT batch `setState` calls inside async functions. Every separate `setState` triggers its own render. When a component fetches multiple pieces of data (e.g., a record plus related records), use a **single state object** and a **single `setData(...)` call** at the end: `const [{ record, related, loading, error }, setData] = useState({...})`. For multi-entity fetches, use `Promise.all` or `Promise.allSettled` so one `setData` completes the entire load. Never call `setLoading(false)` in a `finally` block when the data setters are in the `try` block — this always produces an intermediate render. **PageInput exception:** initial `useState({ loading: !!recordId, ... })` (PageInput rendering pattern) does NOT violate this rule — that's a synchronous initial value, not a separate `setState` call after fetch. The rule is per-effect: independent effects (e.g., usersettings fetch + record fetch) can each have their own single batched `setData`.
15. **Data fetching — inline IIFE + cache guard (Dataverse list/detail pages)**: For pages where the user navigates away and returns (list paired with detail, tabbed UIs), use the module-level `window` cache + inline async IIFE pattern documented in `references/data-caching.md`. Never use `useCallback` for data-fetching functions — `dataApi` gets a new object reference after the initial render, so a `useCallback` recreates, re-fires the effect, and any `setData(loading: true)` call resets the spinner causing flicker. The cache guard (`if (cache.has(key)) return`) is the fix. **Do NOT apply this pattern to forms, single-visit dashboards, or mock-data pages.** See the reference for the full pattern.
16. **Overlays must be confined to the page container (`mountNode`)**: The generated page shares the DOM with the genpage *designer* — the preview is NOT an isolated iframe. Every Fluent surface that renders through a portal (`Dialog` via `DialogSurface`, `Popover`, `Menu`, `Tooltip`, `Combobox`/`Dropdown` listbox, `DatePicker`, `TimePicker`) defaults to portalling to `document.body` of the **designer**, so without a `mountNode` it escapes the preview and can cover the designer chrome — including the coding-agent panel. Establish a single `containerRef`/`mountNode` on the page root and thread it to every overlay. See **Special Patterns > Dialogs and Overlays**.
17. **No full-viewport modal scrims; prefer non-modal or in-page panels**: A default `<Dialog>` is `modalType="modal"` — it draws a `position: fixed` backdrop and traps focus across the whole window, which in the designer blankets the agent panel and locks the user out (they can't even ask the agent to remove it). Default dialogs to `modalType="non-modal"` **and** pass `mountNode`, or use an in-page absolutely-positioned panel. The page root must establish a containing block (`position: relative` + `contain: layout`) so even a fixed-position overlay is clipped to the page. Never size overlays to the viewport. See **Special Patterns > Dialogs and Overlays**.
18. **Never nest a `<Dialog>` inside another `<Dialog>`**: Stacked modal scrims and nested focus traps make dialogs impossible to dismiss reliably. Render sibling dialogs as separate top-level surfaces switched by state, never one `<Dialog>` as a child of another's JSX.

---

## Supported Libraries

Only these libraries are available. Do NOT use any other library.

```
"react": "^17.0.2"
"uuid": "^9.0.1"
"@fluentui/react-icons": "^2.0.292"
"@fluentui/react-calendar-compat": "^0.2.2"
"@fluentui/react-components": "^9.46.4"
"@fluentui/react-datepicker-compat": "^0.5.0"
"@fluentui/react-timepicker-compat": "^0.3.0"
"@fluentui/react-theme": "^9.1.24"
"d3": "^7.9.0"
```

**CRITICAL**: DatePicker must be imported from `@fluentui/react-datepicker-compat` and TimePicker from `@fluentui/react-timepicker-compat` (NOT from `@fluentui/react-components`)

---

## Component Structure

Standard component pattern:

```typescript
import {useEffect, useState} from 'react';
import type {
  TableRow,
  DataColumnValue,
  RowKeyDataColumnValue,
  QueryTableOptions,
  ReadableTableRow,
  ExtractFields,
  GeneratedComponentProps
} from "./RuntimeTypes";

// Additional imports: @fluentui/react-components, @fluentui/react-icons, @fluentui/react-datepicker-compat, d3

// Utility functions as separate top-level functions

// Sub-components as separate top-level functions

const GeneratedComponent = (props: GeneratedComponentProps) => {
  const { dataApi, pageInput } = props;
  // Component implementation
}

export default GeneratedComponent;
```

---

## Layout and Styling

### Design Principles
- Follow Microsoft Fluent Design System principles
- Use sentence case for all text
- Use theme tokens (e.g., `tokens.spacingVerticalXL`, `tokens.colorNeutralBackground1`)
- `makeStyles` for styling; inline styles only for dynamic values
- Group content in sections for visual separation

### Responsive Design
- Mobile-first; adapt to 320px, 480px, 768px, 1024px, 1440px breakpoints
- Use relative units (%, rem, em); avoid fixed widths
- Root container is flex column; use flex properties to fill space
- `boxSizing: border-box`; images: `max-width: 100%, height: auto`
- NEVER use `100vh`/`100vw` — the page is hosted inside the designer, not the full window; viewport units (and `position: fixed` overlays) size to the whole designer and bleed over the agent panel
- **Media queries go INSIDE the slot they modify** — never as a top-level
  `makeStyles` key. Griffel compiles each top-level key as an independent
  class, so a top-level `'@media (...)'` slot generates an unused class
  (its overrides never apply) and also fails type-checking. Nest the query
  in each slot and override only that slot's properties:
```typescript
const useStyles = makeStyles({
  // CORRECT: @media nested inside the slot
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    '@media (max-width: 768px)': { gridTemplateColumns: '1fr' },
  },
  // WRONG: @media as a top-level key reaching into other slots
  // '@media (max-width: 768px)': { grid: { gridTemplateColumns: '1fr' } },
});
```

### Page Layout
- Page-level functions (nav, search, filters) in header opposite title
- Only scrollable bodies scroll, not entire page
- Fix height of parent, set overflow on content area
- Consistent padding/spacing; strong text contrast
- Include hover/focus/active states

### Scrollable Areas
- Use fixed `maxHeight` for parent + `overflow: auto` for scrollable area
- Calculate `maxHeight: calc(100% - [fixed element heights])`
- Only content area scrolls, never entire page
- Example:
```typescript
<div style={{ maxHeight: 'calc(100% - 100px)', overflow: 'auto' }}>
  <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
    {/* scrollable content */}
  </div>
</div>
```

### Navigation
- Multiple screens within a page: Use Fluent UI V9 Tabs/Breadcrumbs
- Provide back/forward navigation for wizard flows
- No React Router or hash/history API routing

### User-Provided Mockups/Screenshots
- When user provides mockups, those take precedence for layout, structure, and visual design
- Follow the provided design closely while adapting to Fluent UI V9 components
- Maintain all technical constraints: accessibility (ARIA, keyboard nav, WCAG AA), responsive design, proper semantic HTML
- If the mockup conflicts with accessibility or responsive design requirements, prioritize accessibility while staying as close to the visual design as possible
- Translate design elements to equivalent Fluent UI components (e.g., custom buttons -> Fluent Button with appropriate styling)

---

## Accessibility

- Use semantic HTML elements (`button`, `nav`, `main`, `section`, etc.)
- Add `aria-label` to icon-only buttons and interactive elements
- Use `aria-labelledby`/`aria-describedby` for form sections
- Ensure text contrast meets WCAG AA standards (use theme tokens)
- Include keyboard navigation support (tab order, enter/space for actions)
- Example:
```typescript
<Button aria-label="Delete item" icon={<DeleteRegular />} />
<section aria-labelledby="form-title" aria-describedby="form-desc">
  <Text id="form-title">Account Form</Text>
</section>
```

---

## Localization

Localization guidance has been moved to a separate reference that is loaded
**conditionally** — only when `pac model list-languages` returns multiple
configured languages OR any non-English language. For English-only environments,
skip this entirely.

See: `${CLAUDE_PLUGIN_ROOT}/references/localization.md`


---

## Page Input

The generated component receives an optional `pageInput` prop from the hosting
page (selected record context, custom data). Already in `GeneratedComponentProps`
— destructure with `const { dataApi, pageInput } = props;`.

### Interface

```typescript
export interface PageInput {
    entityName?: string;   // logical name (not display name)
    recordId?: string;     // record GUID
    data?: Record<string, unknown>;  // custom values — primitives only, type unknown
}
```

### Rules

- Only use `pageInput` when the user explicitly asks — don't speculate on inputs.
- Never set defaults for missing `pageInput` fields.
- `data` values are unknown-typed primitives — cast robustly, never assume.

### Rendering pattern (avoid double-render flicker)

`pageInput` is available synchronously on the first render via `Xrm.Navigation.navigateTo`:

- **Derive synchronously from props**, not `useState`. State init triggers re-renders.
- **Early-return** if a required field is missing — no conditional wrapper divs.
- **No `setTimeout` or `pageInputReady` flags** — 500ms delays let the platform fall back to the previous page.
- **Initialize `loading: true`** when `recordId` is present — spinner on frame 0, not blank-flip-to-spinner.

### Example — record context

```typescript
const { dataApi, pageInput } = props;
const recordId = pageInput?.recordId;
const entityName = pageInput?.entityName;
const [row, setRow] = useState(undefined);

useEffect(() => {
    if (entityName === "account" && recordId && dataApi) {
        (async () => {
            const r = await dataApi.retrieveRow("account", {
                id: recordId,
                select: ["statuscode", "name", "_primarycontactid_value"],
            });
            setRow(r);
        })();
    }
}, [dataApi, entityName, recordId]);
```

### Example — `data` with safe casting

```typescript
function toNumberOrDefault(v: unknown, fallback: number): number {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
        const parsed = Number(v);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

const { pageInput } = props;
const [lat] = useState(toNumberOrDefault(pageInput?.data?.latitude, 0));
const [lng] = useState(toNumberOrDefault(pageInput?.data?.longitude, 0));
```

---

## Special Patterns

### Dialogs and Overlays

**Why this matters:** the generated page renders into the **same document as the genpage designer** — the preview is not a sandboxed iframe. Any Fluent component that renders through a portal (`Dialog`, `Popover`, `Menu`, `Tooltip`, `Combobox`/`Dropdown` listbox, `DatePicker`, `TimePicker`) defaults to portalling to `document.body`. In a normal app that's the page; in the designer that's the **whole tool**. A default `<Dialog>` (`modalType="modal"`) additionally paints a `position: fixed` backdrop and traps focus across the entire window. The result is the #1 reported genpage failure: a modal that **covers the designer and the coding-agent panel on the left, and can't be dismissed** — the user is locked out and can't even ask the agent to remove it.

Three rules prevent it:

1. **Thread a `mountNode` to every overlay** so the portal stays inside the page's own container.
2. **Make the page root a containing block** (`position: relative` + `contain: layout`) so any `position: fixed` descendant is clipped to the page, never the designer.
3. **Default dialogs to `modalType="non-modal"`** (no blocking scrim), or use an in-page panel. Never nest a `<Dialog>` inside another `<Dialog>`.

```typescript
const GeneratedComponent = (props: GeneratedComponentProps) => {
    const [mountNode, setMountNode] = useState<HTMLElement | null>(null);
    // Callback ref captures the container the instant it mounts (before paint), so
    // mountNode is set before any user-opened dialog renders — no window where the
    // portal falls back to the designer's document.body. (Prefer this over a useEffect,
    // whose first-paint gap leaves mountNode null if a dialog opens immediately.)
    const setContainer = useCallback((node: HTMLDivElement | null) => setMountNode(node), []);

    const [open, setOpen] = useState(false);

    return (
        // contain: 'layout' makes this div the containing block for any fixed-position overlay
        <div ref={setContainer} style={{ position: "relative", contain: "layout", height: "100%", overflow: "hidden" }}>
            {/* ...page content... */}

            {/* Sibling dialog at top level — NOT nested inside another Dialog */}
            <Dialog open={open} onOpenChange={(_, d) => setOpen(d.open)} modalType="non-modal">
                <DialogSurface mountNode={mountNode}>
                    <DialogBody>
                        <DialogTitle>Edit item</DialogTitle>
                        {/* ...fields... */}
                        <DialogActions>
                            <Button appearance="secondary" onClick={() => setOpen(false)}>Cancel</Button>
                            <Button appearance="primary" onClick={() => setOpen(false)}>Save</Button>
                        </DialogActions>
                    </DialogBody>
                </DialogSurface>
            </Dialog>
        </div>
    );
};
```

- `mountNode` goes on **`DialogSurface`** (not `Dialog`). For `Popover`/`Menu`/`Tooltip` pass `mountNode` to the component; for `Combobox`/`Dropdown` use the same `mountNode`; for `DatePicker`/`TimePicker` the `mountNode` prop is already required (see sample 6).
- If a dialog genuinely must block the page (rare), keep `modalType="modal"` **but still** pass `mountNode` and rely on the `contain: layout` root so the scrim is clipped to the page, not the designer.
- **Multiple dialogs:** declare each as a separate top-level `<Dialog>` switched by its own state flag. Never render one `<Dialog>` inside another's JSX tree.

### Generative Page Navigation

Use `Xrm.Navigation.navigateTo` for all in-app navigation. Raw URL construction (`window.location`, query strings) breaks the hosting context and must not be used — not even as a fallback.

```typescript
const xrm = (window as any).Xrm;

// Another generative page with record context (entityName and recordId arrive as props.pageInput)
xrm.Navigation.navigateTo({ pageType: "generative", pageId: targetPageId, entityName: "account", recordId: selectedRecordId });

// Another generative page with custom data (arrives as props.pageInput.data on the target)
xrm.Navigation.navigateTo({ pageType: "generative", pageId: targetPageId, data: { customParam1: "value1", customParam2: 42 } });

// Combining record context with additional custom data
xrm.Navigation.navigateTo({ pageType: "generative", pageId: targetPageId, entityName: "account", recordId: selectedRecordId, data: { view: "summary" } });
```

**CRITICAL — never use `pageType: "entityrecord"` or `pageType: "entitylist"` to navigate to another generative page.** Those open the standard OOB form/list, not the custom page. Always use `pageType: "generative"` with the target page's GUID.

**Passing a record ID between pages:** Always put custom identifiers in `data`, not `recordId`. `recordId` is reserved for standard Dataverse record context (used by OOB forms/views); values placed there may not arrive reliably on the receiving genpage. Use `data: { accountId: selectedId }` and read it as `pageInput?.data?.accountId` on the target page. Never rely on `recordId` as the delivery channel for a custom ID.

**Receiving navigation state:** On any page reachable via `navigateTo` (e.g., a detail page, or an explorer page the user navigates back to), initialize shared UI state — dark mode toggle, active filters, selected view — from `pageInput.data` first. URL params are a valid secondary source (e.g., for bookmarked URLs or direct links), but `pageInput.data` takes priority because `navigateTo` does not populate URL params. Pattern:

```typescript
// CORRECT — pageInput.data takes priority; URL param is a valid fallback
const isDark =
    pageInput?.data?.darkMode === true || pageInput?.data?.darkMode === "true"
        ? true
        : pageInput?.data?.darkMode === false || pageInput?.data?.darkMode === "false"
        ? false
        : new URLSearchParams(window.location.search).get("darkMode") === "true";
const [isDarkMode, setIsDarkMode] = useState(isDark);
```

#### Multi-page builds: use `PAGEREF_` placeholders

In a multi-page deployment, page GUIDs don't exist until after first upload. Use a
`PAGEREF_<filename-without-tsx>` placeholder as the `pageId` — the skill replaces
these with real GUIDs in a second pass after all pages are deployed.

```typescript
// Navigating to a sibling page — use PAGEREF_ placeholder at build time
xrm.Navigation.navigateTo({
    pageType: "generative",
    pageId: "PAGEREF_pet-gallery",    // replaced with real GUID post-deploy
    entityName: "adopt_pet",
    recordId: selectedId,
});
```

The placeholder format is `PAGEREF_` followed by the sibling page's filename without
`.tsx` (e.g., `pet-gallery.tsx` → `PAGEREF_pet-gallery`).

**Must be quoted.** The skill's Phase 6.5 fix-up looks for `"PAGEREF_<name>"` as a
quoted token to avoid partial-string collisions (e.g., `PAGEREF_pet` inside
`PAGEREF_pet-gallery`). Always emit the placeholder as a string literal inside
double quotes — assign it to `pageId` as a string, never construct it via
concatenation.

### Dark Mode Toggle

Instead of `<FluentProvider theme={webDarkTheme}>` (which flickers in React 17 — see Rule 11), use a local `themeToVars` helper to apply theme tokens synchronously as CSS custom properties.

**Implement `themeToVars` locally** — do not import it from `@fluentui/react-components`:

```typescript
function themeToVars(theme: Record<string, string>): React.CSSProperties {
    const vars: Record<string, string> = {};
    Object.entries(theme).forEach(([k, v]) => { vars[`--${k}`] = v; });
    return vars as React.CSSProperties;
}
```

**Use a two-div wrapper.** Applying both `style={themeToVars(...)}` and `className={styles.root}` to the same div causes a CSS variable self-reference flicker because `makeStyles` reads the same CSS custom properties that `themeToVars` is writing. Separate them: outer div sets the vars, inner div reads them via the class:

```typescript
import { webDarkTheme, webLightTheme } from "@fluentui/react-components";

// WRONG — style and className on the same div causes CSS variable self-reference flicker
<div style={themeToVars(theme)} className={styles.root}>

// CORRECT — outer div sets CSS vars only, inner div reads them via className
// CRITICAL: outer div MUST have height: 100% and overflow: hidden so the inner
// div can scroll. Without this, the page content overflows invisibly with no scrollbar.
<div style={{ ...themeToVars(isDarkMode ? webDarkTheme : webLightTheme), height: "100%", overflow: "hidden" }}>
    <div className={styles.root}>
        {/* all Fluent descendants inherit the theme via CSS variables */}
    </div>
</div>
```

**Root div scrolling:** The inner `styles.root` div must have `height: "100%"` and `overflowY: "auto"` so the page content is scrollable. The genpage host provides a fixed-height container — if neither the outer nor inner div establishes a scroll context, content below the fold is unreachable.

### Data Caching Across Navigations

The genpage platform **re-evaluates the module script on every navigation** — including when the user navigates back to a page they've already visited. This means module-level variables (e.g., `let _cache = null`) are reset on each visit, causing the component to re-fetch data and show a loading spinner even on return visits.

**Fix: initialize module-level variables from `window`, and write back to `window` on fetch.** The `window` object persists for the lifetime of the browser session regardless of module re-evaluation.

Use `window.__pp<EntityName>Cache` as a naming convention to avoid collisions with other scripts.

**Always use a single batched state object** (`{ records, loading, error }`) — multiple separate `setState` calls in an async function produce separate renders in React 17, each potentially showing an intermediate state.

**Key rules:**
- Initialize module-level variables from `window.__pp<EntityName>Cache` (naming convention to avoid collisions)
- Write back to `window` after fetch so the data survives module re-evaluation
- Use a single batched state object (`{ records, loading, error }`) — separate `setState` calls in async functions produce intermediate renders in React 17
- For detail pages, use a `Map<string, MyRow>` on `window` keyed by `recordId`

**When to apply:** Any time a page fetches Dataverse data and the user may navigate away and return (e.g., an explorer page paired with a detail page). First visit shows a spinner; return visits render instantly.

See [`references/data-caching.md`](./data-caching.md) for complete list-page and detail-page caching examples.

### Charts and Visualization
- Use D3.js for all charts
- D3 uses `group()` not `nest()`
- Include tooltips, hover states, click behaviors
- Smooth transitions (300-500ms)
- **D3 animation guard (required):** The genpage runtime may re-evaluate modules or remount components, causing D3 transitions in `useEffect` to replay visibly. Any D3 animation (arc tweens, number counters, bar transitions, etc.) must use a `window`-level flag to ensure the animation runs only once. On subsequent effect invocations, draw the final state immediately. Also add an early-return guard if the SVG already contains rendered content. Pattern:
  ```typescript
  const ANIM_KEY = "__ppMyChartAnimated";
  function MyChart(props: { value: number }) {
      const svgRef = useRef<SVGSVGElement>(null);
      useEffect(() => {
          if (!svgRef.current) return;
          const svg = d3.select(svgRef.current);
          const w = window as any;
          // Skip entirely if already drawn
          if (w[ANIM_KEY] && svg.selectAll("path").size() > 0) return;
          const shouldAnimate = !w[ANIM_KEY];
          w[ANIM_KEY] = true;
          svg.selectAll("*").remove();
          // ... draw chart ...
          if (shouldAnimate) { /* .transition().duration(800)... */ }
          else { /* draw final state directly */ }
      }, [props.value]);
  }
  ```
  Use a unique `ANIM_KEY` per chart component (e.g., `"__ppScoreGaugeAnimated"`, `"__ppBarChartAnimated"`). Do NOT use `useRef` or module-level variables for the flag — neither survives runtime module re-evaluation.

### Image Generation
- You CANNOT generate images or media files
- If user requests an image, create similar visuals using SVG and CSS
- Add styling/animations to make SVG/CSS graphics visually appealing
- NEVER use external image URLs or libraries unless user explicitly requests it

### File Upload (Fluent UI V9 has no file uploader component)
```typescript
const fileInputRef = useRef<HTMLInputElement>(null);
const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);

const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
  if (event.target.files) {
    setUploadedFiles(prev => [...prev, ...Array.from(event.target.files)]);
  }
};

return (
  <>
    <input
      type="file"
      multiple
      ref={fileInputRef}
      onChange={handleFileUpload}
      style={{ display: "none" }}
    />
    <Button onClick={() => fileInputRef.current?.click()}>
      Upload Files
    </Button>
    {/* Display uploaded files list */}
  </>
);
```

---

## DataAPI Rules

**CRITICAL - MUST FOLLOW ALL:**

1. **Only use dataApi when TableRegistrations provided** - NEVER assume tables/entities/fields exist
2. **NEVER guess column names** - Always verify from the generated RuntimeTypes.ts schema. Custom entities have unpredictable column names (e.g., `cr69c_fullname` not `cr69c_name`). Generate schema first, read it, then write code.
3. **Entity logical names** - Singular lowercase (e.g., `"account"`)
4. **Only defined fields** - Reference only columns that exist in the generated schema
5. **Mocked data fallback** - If no types provided, use sample data
6. **No placeholder CRUD** - Don't include CRUD calls without proper types
7. **No dynamic column generation** - Don't generate DataGrid columns from assumed schemas
8. **Preserve API signatures** - Don't rename dataApi methods/parameters
9. **Check TableRegistrations** - Only use tables defined in TableRegistrations interface
10. **Follow dataApi_definition** - Use the DataAPI interfaces defined below
11. **queryTable returns `{ rows: T[] }`, NOT a raw array** — `dataApi.queryTable()` returns a `DataTable<T>` object with `.rows`, `.hasMoreRows`, and `.loadMoreRows()`. Always access the records via `result.rows`. `retrieveRow()` returns the row object directly (no wrapper).
12. **Lookup display-name fields cannot be in $select** - Any field ending in `name` or `yominame` that corresponds to a Foreign Key column (e.g., `primarycontactidname`, `parentaccountidname`, `regardingobjectidname`, `owneridname`, `createdbyname`) is an OData annotation, not a selectable column. This applies to **every** such field in the schema, not just the example. Select the FK column (e.g., `_primarycontactid_value`) and read the display name from its `@OData.Community.Display.V1.FormattedValue` annotation instead:


```typescript
// WRONG — causes runtime error
select: ["subject", "regardingobjectidname"]

// CORRECT — select FK column, read display name from annotation
select: ["subject", "_regardingobjectid_value"]
const name = row["_regardingobjectid_value@OData.Community.Display.V1.FormattedValue"];
```

### DataGrid Requirements
- Import `createTableColumn` from Fluent UI V9
- Define all columns using `createTableColumn`
- Enable column sorting by default (use `sortable: true` on columns)
- Enable column filtering when appropriate for user data exploration
- Don't connect to Dataverse without explicit table registrations
- Use mocked data if no data source provided
- **Column sizing — always required:** Set `columnSizingOptions` with `defaultWidth` and `minWidth` for every column, and add `resizableColumns` to the `DataGrid`. Without explicit widths the browser distributes space unevenly and variable-length content bleeds into adjacent columns.
- **Text overflow in cells:** For any cell that may contain variable-length text (URLs, email addresses, long names, descriptions), apply truncation to the inner element and `minWidth: 0` on the `TableCellLayout` so the cell can actually shrink. Add a `title` attribute for full-value tooltip on hover:

```typescript
// CORRECT — truncates long URLs without bleeding into the next column
<TableCellLayout style={{ overflow: "hidden", minWidth: 0 }}>
    <a
        href={normalizedUrl}
        title={url}          // full value visible on hover
        style={{
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
        }}
    >
        {url}
    </a>
</TableCellLayout>
```

---

## DataAPI Type Definitions

The canonical TypeScript types live in `./RuntimeTypes.ts`, auto-generated by
`pac model genpage generate-types` per build with the actual entity tables,
enum registrations, and a fully-instantiated `GeneratedComponentProps`. The
page-builder reads that file in Step 2. **Do not duplicate the types here**
— anything we'd write would be stale relative to the generated source.

What you can rely on from RuntimeTypes:
- `TableRow`, `ReadableTableRow<E>`, `WritableTableRow<E>` — table row shapes
- `DataColumnValue`, `RowKeyDataColumnValue` — primitive value types
- `QueryTableOptions<E>`, `RetrieveRowOptions<E>` — query parameter shapes
- `TableRegistrations`, `EnumRegistrations` — env-specific table/enum maps
- `GeneratedComponentProps` — the top-level props (includes `dataApi`, `pageInput`)
- `BaseUxAgentDataApi<TR, ER>` — the dataApi interface with `createRow`,
  `updateRow`, `deleteRow`, `retrieveRow`, `queryTable`, `getChoices`

---

## DataAPI Usage Examples

```typescript
// Query
const result = await dataApi.queryTable("table1", {
  select: ["name", "status"],
  filter: `contains(name,'test')`,
  orderBy: `name asc`,
  pageSize: 50,
});
// result.hasMoreRows + result.loadMoreRows() for pagination

// IMPORTANT: queryTable returns DataTable<T> = { rows: T[], hasMoreRows: boolean }
// Access the array via result.rows — it is NOT a raw array
const records = result.rows;

// Load more pages
if (result.hasMoreRows && result.loadMoreRows) {
  const nextPage = await result.loadMoreRows();
  const moreRecords = nextPage.rows;
}

// Create / Update / Retrieve
const id = await dataApi.createRow("table1", { name: "New", status: 0 });
await dataApi.updateRow("table1", id, { name: "Updated" });
const row = await dataApi.retrieveRow("table1", { id, select: ["name", "status"] });

// Formatted values (enums, lookups, dates) — use @OData.Community.Display.V1.FormattedValue:
const statusLabel = row["status@OData.Community.Display.V1.FormattedValue"];
const contactName = row["_primarycontactid_value@OData.Community.Display.V1.FormattedValue"];

// Enum choices
const choices = await dataApi.getChoices("table1-status");
```

For lookups: `_<field>_value` is the GUID — never display it. Always read the
paired `..._value@OData.Community.Display.V1.FormattedValue` for the label.

---

## Common Errors

**Scope:** generation-time anti-patterns the page-builder must not emit.
For deployment / runtime / env issues (PAC CLI failures, auth, browser
verification, etc.), see `references/troubleshooting.md`.

### 1. Undefined Identifier
Every identifier must be defined or imported. Don't assume implicit availability.
```typescript
// Error: processData not defined
const result = processData(data);

// Fix 1: Define
function processData(data) { return data.map(x => x * 2); }

// Fix 2: Import
import { processData } from "@package";
```

### 2. Missing Error Handling
Always wrap async dataApi calls in try-catch.
```typescript
// Error: Unhandled promise rejection
const data = await dataApi.queryTable("table1", {});

// Fix: Wrap in try-catch
try {
  const data = await dataApi.queryTable("table1", {});
  setRecords(data.rows);
} catch (error) {
  console.error("Failed to load data:", error);
  setErrorMessage("Unable to load data. Please try again.");
}
```

### 3. Inline Styles Instead of makeStyles
Use `makeStyles` with tokens.
```typescript
// Error: Using inline styles for static styling
<div style={{ padding: "20px", gap: "16px", display: "flex" }}>

// Fix: Use makeStyles
const useStyles = makeStyles({
  container: {
    display: "flex",
    gap: tokens.spacingVerticalL,
    padding: tokens.spacingHorizontalXL
  }
});
const styles = useStyles();
<div className={styles.container}>
```

### 4. Media Queries as Top-Level makeStyles Keys
Each top-level `makeStyles` key is compiled to an independent class. A media
query placed at the top level becomes a class literally named
`@media (...)`, whose nested slot overrides are never applied to any element
— the responsive behavior silently does nothing, and it fails type-checking
(`'<prop>' does not exist in type 'string[]'` when a slot name collides with a
CSS shorthand). Nest the query inside each slot instead.
```typescript
// Error: media query as a top-level key, reaching into other slots
const useStyles = makeStyles({
  grid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)" },
  "@media (max-width: 768px)": { grid: { gridTemplateColumns: "1fr" } }
});

// Fix: nest the media query inside the slot it modifies
const useStyles = makeStyles({
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    "@media (max-width: 768px)": { gridTemplateColumns: "1fr" }
  }
});
```
