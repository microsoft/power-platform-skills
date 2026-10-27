# Generative Pages Code Generation Rules Reference

Comprehensive rules for generating generative page code. Read this file during code generation (Step 6).

---

## Critical Rules

1. **React 17 + TypeScript**: All code must use React 17 with TypeScript
2. **Fluent UI V9**: Use `@fluentui/react-components` (DatePicker from `@fluentui/react-datepicker-compat`, TimePicker from `@fluentui/react-timepicker-compat` — both require `mountNode` prop)
3. **Single File**: All code (components, utilities) in one file; each as separate top-level function (no nesting). The one exception is a single top-level React class, `PageErrorBoundary` (Rule 22). Event handlers and loaders that close over a component's state stay inside that component, as before — they are not nested components or free-standing utilities. No new library or runtime dependency.
4. **Limited Imports**: Only React, Fluent UI V9, FluentUI icons, and D3.js for charts
5. **DataAPI**: ONLY use when explicit TableRegistrations provided; otherwise use mocked data
6. **Entity Logical Names**: Use singular lowercase (e.g., `"account"` not `"accounts"`)
7. **Styling**: Use `makeStyles` with tokens; avoid inline styles except for dynamic values. Tokens give the default model-driven look. When the plan's `## Design Preferences` → `Styling:` starts with `Maker-requested:`, apply that style instead — see **Layout and Styling > Maker-requested styling**
8. **Responsive Design**: Use flexbox and relative units; NEVER use `100vh`/`100vw`
9. **Icons — verified names only**: Import from `@fluentui/react-icons`; use unsized variants only (e.g., `AddRegular` not `Add24Regular`). Icon names are frequently hallucinated — names like `MedicalRegular`, `PawRegular`, `AnimalRabbitRegular`, `BirdRegular` do not exist. **Always Read `${PLUGIN_ROOT}/references/verified-icons.txt`** (~5000 names) and cross-check every icon import against that list. After writing, Grep your own output for `from "@fluentui/react-icons"` and verify each named import. If an icon you want is not in the list, pick the closest semantic substitute that is. Never guess a name.
10. **No External Libraries**: No routing libraries (React Router) or assumptions of implicit dependencies
11. **No FluentProvider**: Already provided at root — adding another causes a double-render flicker in React 17. For dark mode/theme overrides, use the `themeToVars` two-div pattern in **Special Patterns > Dark Mode Toggle**.
12. **Forbidden Functions**: Don't use `createTheme`, `mergeThemes`, `useTheme` (don't exist in Fluent UI V9)
13. **Navigation**: Use the `Xrm.Navigation.navigateTo` API for all in-app navigation. Never construct raw URLs or manipulate `window.location` — see **Special Patterns > Generative Page Navigation**.
14. **Batched async state — no intermediate renders**: React 17 does NOT batch `setState` calls inside async functions. Every separate `setState` triggers its own render. When a component fetches multiple pieces of data (e.g., a record plus related records), use a **single state object** and a **single `setData(...)` call** at the end: `const [{ record, related, loading, error }, setData] = useState({...})`. For multi-entity fetches, use `Promise.all` or `Promise.allSettled` so one `setData` completes the entire load. Never call `setLoading(false)` in a `finally` block when the data setters are in the `try` block — this always produces an intermediate render. **PageInput exception:** initial `useState({ loading: !!recordId, ... })` (PageInput rendering pattern) does NOT violate this rule — that's a synchronous initial value, not a separate `setState` call after fetch. The rule is per-effect: independent effects (e.g., usersettings fetch + record fetch) can each have their own single batched `setData`.
15. **Data fetching — de-dupe + cache, and NEVER `dataApi` in a dependency array (any real host read on mount)**: The genpage host (a) hands a **new `dataApi` reference every render** and (b) **double-mounts the page on open** — a cache-bypassing re-mount ~300ms after the first. Both make a naive on-mount fetch run 2+ times → double fetch + spinner re-flash. Fixes: **(1)** Never put `dataApi` in a `useEffect`/`useMemo`/`useCallback` dependency array, and never `useCallback` a fetch function — it re-fires the effect on every render. Depend on a **readiness boolean** (`const dataReady = !!dataApi;`) plus `recordId`/`reloadKey` as needed. **(2)** Wrap the fetch in the **in-flight-promise de-dupe + `window` cache** pattern in `references/data-caching.md` so concurrent mounts share ONE round-trip and later mounts read cache. The in-flight de-dupe — not the dep array — is what defeats the host double-mount (correct deps alone do NOT). Apply to **any page that fetches data on mount through a real host read**, including Dataverse reads, connector reads (`queryConnectorTable` / `executeConnectorOperation`), and single-visit overviews/dashboards. **Skip only pages that render inline mock arrays and forms with no initial fetch.** See the reference for the full pattern.
16. **Overlays must be confined to the page container (`mountNode`)**: The generated page shares the DOM with the genpage *designer* — the preview is NOT an isolated iframe. Every Fluent surface that renders through a portal (`Dialog` via `DialogSurface`, `Popover`, `Menu`, `Tooltip`, `Combobox`/`Dropdown` listbox, `DatePicker`, `TimePicker`) defaults to portalling to `document.body` of the **designer**, so without a `mountNode` it escapes the preview and can cover the designer chrome — including the coding-agent panel. Establish a single `containerRef`/`mountNode` on the page root and thread it to every overlay. See **Special Patterns > Dialogs and Overlays**.
17. **No full-viewport modal scrims; prefer non-modal or in-page panels**: A default `<Dialog>` is `modalType="modal"` — it draws a `position: fixed` backdrop and traps focus across the whole window, which in the designer blankets the agent panel and locks the user out (they can't even ask the agent to remove it). Default dialogs to `modalType="non-modal"` **and** pass `mountNode`, or use an in-page absolutely-positioned panel. The page root must establish a containing block (`position: relative` + `contain: layout`) so even a fixed-position overlay is clipped to the page. Never size overlays to the viewport. See **Special Patterns > Dialogs and Overlays**.
18. **Never nest a `<Dialog>` inside another `<Dialog>`**: Stacked modal scrims and nested focus traps make dialogs impossible to dismiss reliably. Render sibling dialogs as separate top-level surfaces switched by state, never one `<Dialog>` as a child of another's JSX.
19. **All hooks above every early return — no conditional hook calls**: Detail/record pages crash with **minified React error #310** ("rendered more/fewer hooks than the previous render") on the *first* open of a record, then work on the second click. Cause: a hook — usually a `useMemo` deriving chart points or display rows from loaded data — sits *below* a loading/empty early return (`if (data.loading) return <Spinner/>`). On the first render data is still loading, the component early-returns and never reaches that `useMemo` (fewer hooks); when data arrives it renders past the return and calls the extra hook → the hook count differs between renders → #310. The "works the second time" intermittency (the cached render skips the loading branch) is the signature of this bug. **Fix:** place every `useMemo`/`useState`/`useEffect`/`useCallback` **above all early returns**, and make derived memos tolerate not-yet-loaded data (read from an always-initialized value, e.g. `data.rows ?? []`). Early returns are fine — they just must come *after* the last hook call. This is the React rules of hooks: never call a hook below a conditional `return`.
20. **Never put `...` alone on a line**: Write the spread/rest token and its operand together (`...rows`, not `...` followed by `rows` on the next line).
21. **End final type-argument statements with `;`**: If the file's last statement ends in a type argument list (`Page<string>`, `Array<Row>`), terminate it with a semicolon.
22. **Consistent errors**: Route failed data operations through the page's single top-level `reportPageError`, retain bounded code and message diagnostics, and put its returned view in the operation's error state. Render errors as escaped Fluent MessageBar text with localized application fallbacks. Offer manual retry only for proven-safe reads or the documented pre-dispatch Custom API network result; never retry an indeterminate result automatically. Wrap PageBody in the page's one top-level React PageErrorBoundary. Instrument only explicitly authorized failure sites, only through the helper. Expected null/empty states are not failures. See “Missing Error Handling” for the canonical patterns and the static check's declared limits.
23. **Lookup identities**: A lookup reference is a validated table-and-bare-id pair, not its label or the first metadata target. Normalize bare GUID and `/<table>(<guid>)` read values using the logical-name annotation and/or qualified prefix, checking both against metadata and rejecting conflicts. Use the bare id for filters, retrieval and navigation; rebuild the qualified value only for writes. Record every lookup used by a join/filter and its complete target set in Per-Page Specifications. Ask about unresolved relationship/filter meaning; never broaden a failed typed query. Unresolved references cannot trigger target-dependent actions. See **DataAPI Rules > Lookup references** for the canonical `normalizeLookupReference` and the five WRONG/CORRECT pairs.
24. **Convert iterables to arrays**: The page compiler targets ES5 without iterator downleveling or full type checking. Spreading, looping over, or array-destructuring a Map, Set or iterator reads length and indices instead: values can disappear, defaults can replace them, or rest destructuring can throw. Never write `[...new Set(xs)]`, `[...m.values()]`, `for (const [k, v] of m)`, `new Set([...prev, id])`, `[...selected]` or `[...text.matchAll(re)]` directly; convert with `Array.from` or copy a Set natively. See **Common Errors > 5. Iteration that compiles to nothing**.

---

## Supported Libraries

Only the generated `package.json` dependencies below are available. Do NOT use
any other library. `scripts/lib/supported-dependencies.js` is the source of
truth for names, versions, and feature gates; this example is validated against
that module by `scripts/tests/supported-dependencies-docs.test.js`.

```json
{
  "dependencies": {
    "react": "17.0.2",
    "react-dom": "17.0.2",
    "@fluentui/react-components": "^9.54.0",
    "@fluentui/react-icons": "2.0.326",
    "d3": "^7.8.5",
    "@fluentui/react-datepicker-compat": "^0.4.50",
    "@fluentui/react-timepicker-compat": "^0.2.40"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/react": "^17.0.80",
    "@types/react-dom": "^17.0.25",
    "@types/d3": "^7.4.3"
  }
}
```

Feature-gated packages are installed only when the generator receives the
matching flag: `charts` adds `d3` and `@types/d3`, `datepicker` adds
`@fluentui/react-datepicker-compat`, and `timepicker` adds
`@fluentui/react-timepicker-compat`.

**CRITICAL**: DatePicker must be imported from `@fluentui/react-datepicker-compat` and TimePicker from `@fluentui/react-timepicker-compat` (NOT from `@fluentui/react-components`)

---

## Component Structure

Standard component pattern — the exported component only mounts the page inside its error
boundary (Critical Rule 22); the page itself lives in `PageBody`:

```typescript
import * as React from 'react';
import { MessageBar, MessageBarBody } from '@fluentui/react-components';
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

// The page error block of "Missing Error Handling" (Common Errors), copied unchanged: the PageErrorKind,
// PageErrorView and PageErrorTelemetry types, PAGE_NAME, the error copy and translate, reportPageError,
// PageErrorBar and PageErrorBoundary

// Utility functions as separate top-level functions

// Sub-components as separate top-level functions

function PageBody(props: GeneratedComponentProps) {
  const { dataApi, pageInput } = props;
  // Component implementation: hooks, state and handlers; every failed data operation goes through reportPageError
}

const GeneratedComponent = (props: GeneratedComponentProps) => (
  <PageErrorBoundary>
    <PageBody {...props} />
  </PageErrorBoundary>
);

export default GeneratedComponent;
```

`GeneratedComponent` passes its props to `PageBody` unchanged and does nothing else; never call
`PageBody(props)` as a function. `PageErrorBoundary` is the page's one class component.

---

## Layout and Styling

### Design Principles
- Follow Microsoft Fluent Design System principles
- Use sentence case for all text
- Use theme tokens (e.g., `tokens.spacingVerticalXL`, `tokens.colorNeutralBackground1`) — the default look when the maker asked for no style of their own
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

### Maker-requested styling

When the maker asks for a look of their own, that style wins over the default model-driven look.
The maker can give a screenshot or mockup to follow, an existing website to match, or a description
("navy and gold, serif headings, square corners"). The planner writes the style into
`## Design Preferences` as a `Styling:` line that starts with `Maker-requested:` and gives concrete
values. Apply each value. Do not fall back to the default tokens for a value that the style sets:

- **Colors.** Build a theme from the stated colors over `webLightTheme` (or `webDarkTheme` for a dark
  style). Apply it with the `themeToVars` two-div wrapper (see **Special Patterns > Dark Mode
  Toggle**), so every Fluent component on the page uses the colors: `colorBrandBackground`,
  `colorBrandForeground1`, `colorNeutralBackground1`, `colorNeutralForeground1`, and so on. Set
  `color: tokens.colorNeutralForeground1` on the page root, so that inherited text follows the
  theme (see the inherited-text note under **Dark Mode Toggle**). Use the same hex values in
  `makeStyles` for the elements that the theme does not reach.
- **Typography.** Set `fontFamily` on the page root to the stated font, with fallbacks that the
  user's device has (for example `"Georgia, 'Times New Roman', serif"`). Set heading sizes and
  weights in `makeStyles`.
- **Shape and density.** Set the stated corner radius, spacing, borders and shadows in `makeStyles`.
  For borders, write the longhands (see **Styling gotchas**).
- **What the style does not set** keeps the default tokens, so the page stays consistent.

```typescript
import { webLightTheme } from "@fluentui/react-components";

// Maker-requested: navy #0b2545 primary, gold #c9a227 accent, warm white #faf7f0 background, Georgia headings, 2px corners.
const brandTheme = {
    ...webLightTheme,
    colorBrandBackground: "#0b2545",
    colorBrandBackgroundHover: "#13315c",
    colorBrandForeground1: "#0b2545",
    colorNeutralBackground1: "#faf7f0",
    borderRadiusMedium: "2px",
};
// In the component: the outer div sets the variables, the inner div reads them.
// <div style={{ ...themeToVars(brandTheme), height: "100%", overflow: "hidden" }}>
//     <div className={styles.root}>{/* … */}</div>
// </div>
```

**What cannot be matched.** Tell the maker when the request needs one of these:

- A page is one `.tsx` file that uses React, Fluent UI V9, Fluent icons and D3. It cannot load a
  stylesheet, a CSS file, a web font, an image or a script from another site, and it cannot use
  another component library. The page rebuilds the widgets of a website with Fluent components that
  are styled to match. It does not copy them.
- A font that is not installed on the user's device shows its fallback. Name the closest common
  font, and a fallback.
- Only the page's own area gets the style. The app header, the navigation and the command bar around
  the page keep the look of the app. The page must not style `body` or anything outside its root.
- A screenshot is matched by eye. The layout, the colors and the type are close, not exact to the pixel.
- Contrast stays at WCAG AA. If a requested pair of colors fails, use the nearest color that passes,
  and tell the maker.

**No style asked for:** keep the model-driven defaults (Fluent UI tokens and the default theme).

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
**conditionally** — only when `scripts/list-languages.js` reports multiple
configured languages OR any non-English language. For English-only environments,
skip this entirely.

See: `${PLUGIN_ROOT}/references/localization.md`


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
const dataReady = !!dataApi;   // never depend on `dataApi` itself — see Rule 15
const [row, setRow] = useState(undefined);

useEffect(() => {
    if (entityName === "account" && recordId && dataReady) {
        // Full pages should also de-dupe the host double-mount — see
        // references/data-caching.md. Kept minimal here for the illustration.
        (async () => {
            const r = await dataApi.retrieveRow("account", {
                id: recordId,
                select: ["statuscode", "name", "_primarycontactid_value"],
            });
            setRow(r);
        })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, [dataReady, entityName, recordId]);
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

### What another page accepts (read it before you pass it data)

The platform shows no list of the inputs a page takes. A page's inputs are the values its own source
reads from its `pageInput` prop, and they are of two kinds, which travel in different places of the
`navigateTo` call:

| The target reads | Kind | Pass it in `navigateTo` as |
|---|---|---|
| `pageInput.data.<key>` | a data key | `data: { <key>: <value> }` |
| `pageInput.recordId` | record context | `recordId: <the record's id>`, at the top level beside `pageId` — not in `data` |
| `pageInput.entityName` | record context | `entityName: "<the table's logical name>"`, at the top level — not in `data` |

Before a page navigates to a page that this plan does not build, find out what that page reads:

1. **A page of an app that `/app-builder` built:** its App Spec declares its data keys as
   `pages[].pageInput.data` (each key with its type). The producing page declares the same keys in
   `navigatesTo[].data`. `download-model-app.js` writes both into the spec from the app's page manifest.
   The spec declares no record context: to know whether the page reads `pageInput.recordId` or
   `pageInput.entityName`, read its source as in 2.
2. **Any other page** (a `/genpage` page, or a page made in Maker): download it into a folder of its
   own. Do not use the working directory, and record no base marker, because this is a read:

   ```powershell
   node "${PLUGIN_ROOT}/scripts/genpage.js" download --env '<envUrl>' --page-id '<target-page-id>' --output-directory '<working-dir>/targets'
   ```

   Then search `<working-dir>/targets/<target-page-id>/page.tsx` for `pageInput`, and write down each
   read with its path:
   - Each key read from `pageInput.data` is a data key: `pageInput?.data?.accountId`,
     `pageInput?.data?.["account-id"]`, or a key read from a variable that holds `pageInput.data`. Note
     how the page converts each value (for example `toNumberOrDefault(...)` or `=== "true"`), and send a
     value of that type.
   - A read of `pageInput.recordId` or `pageInput.entityName` (also `const { recordId, entityName } =
     pageInput`) is record context. Pass both at the top level of the call: the record's id, and the
     logical name of its table.

Pass each input in the place the target reads it, with the same name: data keys in `data`, record
context at the top level. Do not move one into the other: a target that reads `pageInput.recordId` gets
nothing from `data: { recordId }`, and one that reads `pageInput.data.accountId` gets nothing from
`recordId`. (When you write both pages, put a custom identifier in `data` — see **Passing a record ID
between pages**. A page that already exists is called the way it reads its input.) Values in `data` are
primitives. The target ignores a key it does not read, so a guessed name fails silently. A page that
reads neither kind takes no input: navigate to it with its `pageId` alone.

Example — a target that reads record context and one data key, and the call that feeds it:

```typescript
// The target's page.tsx reads:
const accountId = pageInput?.recordId;   // record context
const table = pageInput?.entityName;     // record context
const view = pageInput?.data?.view;      // a data key
// So the caller passes the record context at the top level, and the data key in data:
Xrm.Navigation.navigateTo({ pageType: "generative", pageId: targetPageId, entityName: "account", recordId: selectedAccountId, data: { view: "summary" } });
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

**Passing a record ID between pages:** Always put custom identifiers in `data`, not `recordId`. `recordId` is reserved for standard Dataverse record context (used by OOB forms/views); values placed there may not arrive reliably on the receiving genpage. Use `data: { accountId: selectedId }` and read it as `pageInput?.data?.accountId` on the target page. Never rely on `recordId` as the delivery channel for a custom ID. This is how to write the pages of this plan; a page this plan does not build may already read `pageInput.recordId` and `pageInput.entityName`, and is called the way it reads them (see **Page Input > What another page accepts**).

**Passing data to a page this plan does not build:** first read the keys that page accepts — see **Page Input > What another page accepts**. Never guess the names.

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

#### Multi-page builds: use `PAGEREF_<token>` placeholders

In a multi-page deployment, page GUIDs don't exist until after first upload. Use a
`PAGEREF_<token>` placeholder as the `pageId`. The build replaces these with real GUIDs in a
resolved deployment copy after all pages are deployed; your canonical `.tsx` keeps the symbolic
token (the build never writes a GUID back into it).

**The token depends on the caller — read the plan's `## Environment` `Mode:` line:**

| `Mode:` | Token | Why |
|---------|-------|-----|
| `app-builder` | the target page's **`Key`** (the `Key` column in `## Pages`, = App Spec `pages[].key` = `navigatesTo[].targetKey`) | Rename-stable, and a downloaded page's file is a storage path (`pages/<guid>/page.tsx`) whose stem means nothing |
| absent (standalone `/genpage`) | the target page's **file name without `.tsx`**, exactly as in the `File` column | There is no App Spec, so there are no keys and the plan has no `Key` column; Phase 6.5 builds a filename-stem → page-id map |

```typescript
// Navigating to a sibling page — pass any custom id in `data` (never recordId)
xrm.Navigation.navigateTo({
    pageType: "generative",
    pageId: "PAGEREF_pet-gallery",   // app-builder: target's Key. standalone: target's file stem.
    data: { selectedPetId: selectedId },   // custom ids go in data (read as pageInput?.data?.selectedPetId)
});
```

**Must be quoted, and it is the pageId.** The build's single structural resolver only rewrites a
`PAGEREF_<token>` that appears as the **double-quoted `pageId:` value of a `pageType:"generative"`
`navigateTo` call** — the value is exactly that one string literal, with nothing after it but the
`,` or `}` that ends the property (a plain cast — `as const`, `as Name`, `satisfies Name`, with `Name` a plain or dotted
identifier — may follow the literal and is left as written; a generic, a union or a string-literal type may not). The options
object has to be **written inline in the call**: an object built in a variable and passed by name is not recognised, and
its token halts the build as stray. **Write the plain form, `navigateTo({ … })` or
`Xrm.Navigation.navigateTo({ … })`.** A parenthesised callee, `(navigateTo)({ … })`, is read only where a call can
start — at the start of a statement or after `;` `{` `(` `[` `,` `:`, a ternary `?`, an operator ending in `=`, `=>`,
`&&`, `||` or `??`, or the keyword `return` on the same line (`return (navigateTo)({ … })`; not `await` or `yield`) — and never
after a name or any other keyword, `)`, `]`, `.`, `}`, `!`, `>`, a quote or a back-tick, because
there the parentheses are an argument list for some other function (`factory!(navigateTo)({ … })`,
``tag`x`(navigateTo)({ … })``); the token in one halts the build as stray. Always emit it exactly there — never single-quoted, back-ticked,
concatenated, followed by an expression (`"PAGEREF_x".slice(8)`, `&& other`,
`("PAGEREF_x" as const).slice(1)`), in a
`pageType` that is not the plain literal, in a call spelled some way the resolver does not read, or
as a decoy string elsewhere (the pre-deploy scan **rejects** a malformed nav ref, any `PAGEREF_`
token that is not a resolvable nav pageId — **no comment may hold one**: a `//` comment, a block comment, a trailing comment
(`navigateTo({ … }); // PAGEREF_x`) and a JSX `{/* PAGEREF_x */}` are all refused, so write the comment without the token — and any
parity mismatch, and reports the page, line and column). Also keep the code before a navigation call unambiguous: the checker has
no parser, so where it cannot tell a division from a regex, or a comparison from an element — a `/` or `<` right after a `}`
(write `({ … }) / 2`, not `{ … } / 2`), after a `)` whose `(` is far back, after a word that can be a keyword or a name (`of`,
`type`, `get`, `as` …), after a `>`, or on a later line than the operand before it (`type Value = number` then a regex line);
an identifier written with a `\u` escape — it does not trust a `PAGEREF_` token at or after that spot, or a `navigateTo` call
whose object or arguments reach it. Put the operand in parentheses, end the statement with `;`, or write the navigation call above it. In `app-builder` mode every `PAGEREF_<key>` you emit must have a
matching `navigatesTo` entry in the page's spec, and every declared `navigatesTo.targetKey` must
appear as a real nav pageId in the source (the build enforces exact parity, and verification
confirms each edge resolves to the actual target).

**Every `PAGEREF_` target page must be sitemap-placed.** <a id="PAGEREF_sitemap_placement"></a>
A page referenced by a `PAGEREF_` placeholder must have a matching `page` subarea in the
app's `appShell`. Navigation-only pages — reachable only via a `PAGEREF_` call but absent from the
app sitemap — are not supported; validation rejects them. A "detail" page that receives a caller-
supplied record id or other context is a normal sitemap page; it reads its input via
`pageInput?.data?.<field>`. See [`app-spec-schema.md`](../references/app-spec-schema.md) → `## pages[]`
for the three-authority identity model and the `pages[].pageId` edit-snapshot field.

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

**Inherited text color does NOT follow the variable override.** `themeToVars` overrides CSS *variables*, but Fluent typography (`Text`, `Title`, `Body`, etc.) mostly **inherits** its `color` from the light-theme FluentProvider root — and inheritance passes the already-resolved value, so flipping `--colorNeutralForeground1` to white does not recolor inherited text (you get near-black text on a dark background, contrast ~1.07, effectively invisible). **Fix:** set `color: tokens.colorNeutralForeground1` on the page root (`styles.root`) so every descendant inherits the variable-resolved foreground. Raw `<button>` elements (e.g. custom "attention" rows) default to black `buttontext` and need an explicit `color` too. Status-color CSS vars (`--colorStatusDangerForeground1`, etc.) *do* resolve in inline styles via the `themeToVars` wrapper, so status tokens work fine.

**Pages opened via `navigateTo` are separate documents — they don't inherit the dashboard's dark mode.** A detail/dialog page reached through `Xrm.Navigation.navigateTo({ pageType: "generative", ... })` mounts fresh with no theme context. Pass the flag through `data` (`data: { darkMode: isDarkMode }`) and, on the target, read it from `pageInput.data` (see **Generative Page Navigation > Receiving navigation state**) and wrap the component in its own `themeToVars` two-div. A thin outer wrapper component is cleanest when the target page has multiple early-returns.

### Styling gotchas (Fluent + Griffel)

Recurring CSS bugs that type-check and compile but render wrong. Check for these before finishing a page:

1. **A bar/progress fill `<span>` with a `width`/`height` % but no `display` is invisible.** A `<span>` defaults to `display: inline`, which ignores width/height → a 0×0 box, so the colored fill never paints (only the track shows — looks like "the color got lost"). Symptom: computed `backgroundColor` is correct but `offsetWidth`/`offsetHeight` is `0`. Fix: add `display: "block"` (or `inline-block`) to the fill — or use a `<div>` for fills.
2. **Concatenated `makeStyles` classes lose status/warning colors to a shorthand-vs-longhand collision.** ``className={`${base} ${warning}`}`` (plain template string, not `mergeClasses`) where `base` sets a shorthand `border:` / `backgroundColor: "transparent"` and `warning` sets the longhand `borderTopColor` / `backgroundColor` — Griffel's atomic output plus the shorthand-vs-longhand cascade lets the base win, so the amber bg/border/text silently fall back to neutral. Fix: apply the status colors **inline** (`style={{ backgroundColor: tokens.colorStatusWarningBackground1, borderColor: tokens.colorStatusWarningBorder1 }}` — inline wins) or use `mergeClasses` instead of string concatenation.
3. **`tokens.fontFamilyNumeric` is Bahnschrift, not Segoe UI.** Using it for tabular numbers (counts, %, ranks, dates) renders those digits in Bahnschrift — visibly mismatched against Segoe UI everywhere else. Fix: use `tokens.fontFamilyBase` and keep `fontVariantNumeric: "tabular-nums"` for aligned digits.
4. **Gradient hero with white text: `colorPalette*Background2/3` tokens are light tints, not dark.** A gradient built from e.g. `colorPalettePurpleBackground3` / `colorPaletteTealBackground2` with `color: colorNeutralForegroundOnBrand` (white) renders white-on-light → unreadable; those `Background2/3` palette tokens are pale. Fix: build the gradient from the dark, saturated `colorPalette*Foreground2` stops (e.g. `colorPalettePurpleForeground2`, `colorPaletteTealForeground2`), which are dark enough for white text to pass AA.
5. **Ten CSS shorthands are unsupported by Griffel — `borderWidth` is the usual one.** Griffel does not support ten CSS shorthands, and `makeStyles` drops them at runtime: the page type-checks, transpiles and deploys, then renders without the border, color or reset. They are `all`, `borderColor`, `borderStyle`, `borderWidth`, `borderBlock`, `borderBlockStart`, `borderBlockEnd`, `borderInline`, `borderInlineStart` and `borderInlineEnd`. Write longhands instead: `borderColor`, `borderStyle` and `borderWidth` become one longhand per side, `border` + `Top`, `Right`, `Bottom` or `Left` + `Color`, `Style` or `Width` (`borderWidth` → `borderTopWidth`, `borderRightWidth`, `borderBottomWidth`, `borderLeftWidth`); `borderBlock`, `borderInline` and their `Start` and `End` forms become the `Width`, `Style` and `Color` longhands of the sides they name (`borderBlockStart` → `borderBlockStartWidth`, `borderBlockStartStyle`, `borderBlockStartColor`; `borderBlock` → those and the three `borderBlockEnd…` ones); `all` has no longhands, so set the properties you need one by one. Every other shorthand (`padding`, `margin`, `border`, `borderRadius`, `gap`, `outline`) is supported, and an inline `style={{ … }}` is not Griffel at all. The browser console logs `@griffel/react: You are using unsupported shorthand CSS property "<name>"` for each one that reaches it. Run `node "${PLUGIN_ROOT}/scripts/check-griffel-styles.js" --file '<page.tsx>'` on the finished page. `check-griffel-styles.js` prints each problem it finds — a key Griffel drops in a `makeStyles` call, at any depth, with its line, column and longhands, or a call or a style object it cannot read, with what to change — and exits 3 while any is left: fix what it reports and run it again, and do not transpile or upload the page until it exits 0. It reads the style objects written inline in the call, `makeStyles({ … })`, so write them there: one passed or spread in from elsewhere (`makeStyles(styles)`, `...base`) is reported, because the check cannot see its keys, and so is a key computed from an expression (`[key]: …`), whose name it cannot see (a template that starts with `--`, `&`, `:` or `@` is read); Fluent's `...shorthands.*(…)` and `...typographyStyles.*` may be spread as they are.

### Data Fetching: the host double-mount, de-dupe, and caching

Two host behaviors make a naive on-mount fetch run more than once:

1. **Double-mount on open.** The PowerApps webplayer host launches the hosted app twice when a generative page opens — a cached mount, then a cache-bypassing re-mount ~300ms later (two `POST .../powerapps/apps/<app>/launch` calls, the second `bypass-cache=true`). Each fresh mount re-runs the data effect **even with a correct dependency array**.
2. **Module re-evaluation on navigation.** Navigating back to a visited page re-evaluates the module script, resetting module-level variables (`let _cache = null`).

`window` survives both (the second mount runs in the same window), so the fix lives on `window`:

- **In-flight promise** (`window.__pp<EntityName>Inflight`) — concurrent mounts share ONE pending fetch, so the double-mount is a single round-trip. This is the piece that defeats the double-mount; the dependency array cannot.
- **Resolved cache** (`window.__pp<EntityName>Cache`) — later mounts and return visits read cache: no re-fetch, no spinner.

**Key rules:**
- **Never put `dataApi` in a dependency array** (`useEffect`/`useMemo`/`useCallback`) and never `useCallback` a fetch function — the host hands a new `dataApi` ref every render, so it re-fires the effect each render. Depend on a **readiness boolean** (`const dataReady = !!dataApi;`) plus `recordId`/`reloadKey` as needed.
- **Scope each `window` key by page + query** (include the page name, e.g. `__ppAccountOverview_accountCache`), not just the entity — two pages querying the same entity with different `select`/`filter` must not share a cache or in-flight entry.
- Seed initial `useState` from the `window` cache so the second mount paints final content with no spinner.
- Use a single batched state object (`{ records, loading, error }`) — separate `setState` calls in async functions produce intermediate renders in React 17. `error` is the `PageErrorView | null` that `reportPageError` returns (see **Common Errors > Missing Error Handling**), never a string.
- For detail pages, key both the cache and the in-flight map by `recordId` (`Map<string, ...>` on `window`).
- On mutation or manual refresh, clear the cache **and** the in-flight promise before refetching.

**When to apply:** any page that fetches data on mount through a real host read — Dataverse `dataApi` calls OR connector calls such as `queryConnectorTable` / `executeConnectorOperation` (lists, details, and single-visit overviews/dashboards). Skip only pages that render inline mock arrays and forms with no initial fetch.

See [`references/data-caching.md`](./data-caching.md) for the complete list and detail patterns.

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
12. **Lookup display-name fields cannot be in $select** - Any field ending in `name` or `yominame` that corresponds to a Foreign Key column (e.g., `primarycontactidname`, `parentaccountidname`, `regardingobjectidname`, `owneridname`, `createdbyname`) is an OData annotation, not a selectable column. This applies to **every** such field in the schema, not just the example. Select the FK column (e.g., `_primarycontactid_value`) and read the display name from its `@OData.Community.Display.V1.FormattedValue` annotation instead (the label is display text only — to filter, retrieve or open the referenced record, see **Lookup references** below):


```typescript
// WRONG — causes runtime error
select: ["subject", "regardingobjectidname"]

// CORRECT — select FK column, read display name from annotation
select: ["subject", "_regardingobjectid_value"]
const name = row["_regardingobjectid_value@OData.Community.Display.V1.FormattedValue"];
```

13. **Setting a lookup on create/update — use `_<field>_value`, never `@odata.bind`** - To *write* a lookup via `createRow`/`updateRow`, set the FK key `_<field>_value` to a string of the form `/<entityLogicalNameSingular>(<guid>)` — singular logical name (e.g. `/account(<id>)`, `/systemuser(<id>)`). Clear it with `_<field>_value: null`. The writable row type in RuntimeTypes proves the shape — the FK column is typed as a template literal, e.g. `` _primarycontactid_value: `/contact(${string})` ``. **The trap:** the raw Dataverse Web API binds lookups with `"<PascalCaseNavProp>@odata.bind": "/<entitySetPlural>(<id>)"`. The DataAPI **silently ignores** any `@odata.bind` key (unknown property → dropped, no error) and creates the row **orphaned**, with the lookup null. Symptom: `createRow` resolves with no error, but the row isn't linked, so a child list filtered by that parent stays empty — looks like "the write didn't save." Don't mix the conventions: **DataAPI → `_field_value: "/logicalSingular(id)"`**; `@odata.bind` + `/setPlural(id)` is for raw Web API only. On a lookup with more than one target (Customer, Owner, Regarding) the table you write is the one the user selected, kept with its id — see **Lookup references**, pitfall E.

```typescript
// WRONG — DataAPI silently drops @odata.bind → row created with null lookup (orphaned)
await dataApi.createRow("task", { subject: "Call", "Regarding@odata.bind": "/accounts(<id>)" });

// CORRECT — set the FK _value to "/logicalSingular(guid)"
await dataApi.createRow("task", { subject: "Call", _regardingobjectid_value: `/account(${accountId})` });
await dataApi.updateRow("task", id, { _regardingobjectid_value: null }); // clear it
```

### Lookup references (Customer, Owner, Regarding and every other lookup)

A lookup's `_<field>_value` is a **reference** — a table and a bare id — not its label and not the first table its column can point to. Rules 12 and 13 cover the label and the write format; this section covers reading, filtering, retrieving, navigating and choosing the table to write.

**What a read returns.** On a row returned by `queryTable` or `retrieveRow`, a lookup value may be a **bare GUID** or a **qualified value `/<table>(<guid>)`**. The current player has been live-verified to return the qualified form — beside a `<property>@Microsoft.Dynamics.CRM.lookuplogicalname` annotation naming the same table — for Customer lookups (both account- and contact-valued rows) and for user-owned Owner lookups. The service itself sends a bare GUID, and another player or version may pass it through, so handle both shapes everywhere. Single-target lookups, team-owned rows, Regarding and `loadMoreRows` pages were not part of that verification. A filter compares the **bare** id — `_parentcustomerid_value eq <guid>` selects the row, and the qualified value is refused with HTTP 400 — and `retrieveRow({ id })` takes the bare id (the player refuses a qualified one before sending it). Background: [lookup property data](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query/select-columns#lookup-property-data), [multi-table lookups](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/web-api-navigation-properties#multi-table-lookups), [filtering on lookup values](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query/filter-rows#filter-using-lookup-column-property-values).

**Normalize before you consume.** Copy this helper **unchanged** into the page, at the top level beside the other helpers, and pass every lookup value through it before you filter, retrieve, compare or navigate. Take `property` and `allowedTargets` from the plan's `#### Lookup metadata` record for that column — `allowedTargets` is its **complete** target set, never a subset you chose — never from user input.

```typescript
type LookupReference = { table: string; id: string };
type LookupNormalization =
  | { state: 'unset' }
  | { state: 'resolved'; reference: LookupReference }
  | { state: 'needs-target'; id: string }
  | { state: 'invalid' };

const LOOKUP_GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LOOKUP_QUALIFIED = /^\/([a-z_][a-z0-9_]*)\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)$/;

function normalizeLookupReference(
  row: unknown,
  property: string,
  allowedTargets: readonly string[],
): LookupNormalization {
  if (typeof row !== 'object' || row === null || Array.isArray(row) || allowedTargets.length === 0) return { state: 'invalid' };
  const record = row as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, property)) return { state: 'invalid' };
  const raw = record[property];
  if (raw === null) return { state: 'unset' };
  if (typeof raw !== 'string') return { state: 'invalid' };
  const value = raw.trim();
  const qualified = LOOKUP_QUALIFIED.exec(value);
  if (!qualified && !LOOKUP_GUID.test(value)) return { state: 'invalid' };
  const prefix = qualified ? qualified[1] : undefined;
  const id = (qualified ? qualified[2] : value).toLowerCase();
  if (prefix !== undefined && !allowedTargets.includes(prefix)) return { state: 'invalid' };
  const annotationKey = `${property}@Microsoft.Dynamics.CRM.lookuplogicalname`;
  let annotation: string | undefined;
  if (Object.prototype.hasOwnProperty.call(record, annotationKey)) {
    const named = record[annotationKey];
    if (typeof named !== 'string' || !allowedTargets.includes(named)) return { state: 'invalid' };
    annotation = named;
  }
  if (annotation !== undefined && prefix !== undefined && annotation !== prefix) return { state: 'invalid' };
  const table = annotation ?? prefix ?? (allowedTargets.length === 1 ? allowedTargets[0] : undefined);
  return table === undefined ? { state: 'needs-target', id } : { state: 'resolved', reference: { table, id } };
}
```

What each state means for the page:

- **`resolved`** — a validated pair. Use `reference.id` for filters, `retrieveRow({ id })`, comparisons and `entityId`, and `reference.table` for the target. Only a write rebuilds `/<table>(<id>)` (pair E).
- **`unset`** — an explicit `null`: the row has no link. A normal empty state, not an error.
- **`needs-target`** — a valid bare id with no table evidence on a lookup that has more than one target. Show the label with target-dependent actions disabled; a separate, user-started "Resolve reference" may run the bounded resolution read described below.
- **`invalid`** — a missing or malformed value, or contradictory evidence (a prefix or annotation outside the targets, or the two disagreeing). Show the label with target-dependent actions disabled. Never resolve it by any fallback.

The helper never infers a table from the FormattedValue, from a GUID being unique, from the order of the targets, or from the `@Microsoft.Dynamics.CRM.associatednavigationproperty` annotation (Owner's is the shared `ownerid`; never split a navigation name on `_` to find a table). It holds no hook, state, I/O, logging or retry. Do not log during render.

#### Five pitfalls, WRONG and CORRECT

The examples use a Customer lookup (`opportunity.customerid` → account, contact). Use the names your schema and the plan's lookup record verify, adapted to the column's actual target set.

**A. Read and consume a normalized identity.**

```typescript
// WRONG: today's qualified read value is neither a filter operand nor a retrieveRow id.
const customerId = row['_customerid_value'];
const filter = `_customerid_value eq ${customerId}`;
await dataApi.retrieveRow('account', { id: customerId });

// CORRECT: normalize before consuming; this branch requires a resolved pair.
const normalized = normalizeLookupReference(row, '_customerid_value', ['account', 'contact']);
if (normalized.state !== 'resolved') return;
const reference = normalized.reference;
// reference.id is bare; reference.table is metadata-validated, not assumed account.
```

Retrieve only a target table registered in this page's verified schema, using its actual table and `reference.id`. Display the FormattedValue, never the raw or normalized id. An account-specific predicate must still constrain the target as in B and C: extracting the bare id alone is not a target scope.

**B. Select the relationship and roll-up meaning before generating a filter.**

```typescript
// WRONG: silently deciding what "opportunities for this account" means.
filter: `_parentaccountid_value eq ${accountId}`

// CORRECT only after the plan's assumption chose direct Customer-to-account and metadata verified the path.
filter: `customerid_account/accountid eq ${reference.id}`
```

The CORRECT branch also requires `reference.table === 'account'`. If the maker chose `parentaccountid`, use it instead. Rolling up rows whose customer is one of the account's contacts is a separate recorded decision that needs the contact-to-account relationship — never an `or` across both columns. A GUID operand is validated, bare and unquoted.

**C. Non-id filters and name searches do not implicitly select a target.**

```typescript
// WRONG for an account-only view: includes contact customers too.
filter: '_customerid_value ne null'

// CORRECT for that approved view, with the metadata-supplied concrete path.
filter: 'customerid_account/accountid ne null'

// CORRECT account-only name search: the target's name column is verified separately.
const escaped = searchText.replace(/'/g, "''");
const filter = `customerid_account/accountid ne null and contains(customerid_account/name,'${escaped}')`;
```

Matching the formatted label alone is also WRONG as an account discriminator. Never filter on annotation keys or on invented lookup-name columns. For a view that explicitly covers every target, `_customerid_value ne null` is correct. A label search across all targets is allowed only when it is described as a search of the loaded rows, not of all matches or totals. If the service refuses a typed path, stop the operation and report a read failure — never post-filter the first page and present it as complete.

**D. Navigate to the resolved target with the bare id.**

```typescript
// WRONG: a Customer row may refer to a contact, and its raw value may be qualified.
await Xrm.Navigation.navigateTo({ pageType: 'entityrecord', entityName: 'account', entityId: row['_customerid_value'] });

// CORRECT after the resolved-state guard:
await Xrm.Navigation.navigateTo({ pageType: 'entityrecord', entityName: reference.table, entityId: reference.id });
```

An unset, invalid or needs-target reference cannot call navigation. Catch a rejected `navigateTo` and call `reportPageError(PAGE_NAME, 'openCustomerRecord', undefined, error, 'read')`. Never build a raw URL or infer the target from a label or from the metadata order.

**E. Write the selected target; rebuild the qualified form only at the write boundary.**

```typescript
// WRONG: the contact selected by the maker becomes an account link.
await dataApi.updateRow('opportunity', opportunityId, { _customerid_value: `/account(${selected.id})` });

// CORRECT after validating selected.table and its bare id against the picker target union:
const link: `/account(${string})` | `/contact(${string})` = selected.table === 'account'
  ? `/account(${selected.id})`
  : `/contact(${selected.id})`;
await dataApi.updateRow('opportunity', opportunityId, { _customerid_value: link });
```

The two-way formatter is legal only after every selection outside account and contact has been rejected. Keep the table in the picker's state, even for equal labels or for one GUID in two tables. Clear the link with `_customerid_value: null` — never an empty string, a plural entity set or `@odata.bind`. Honor read-only fields; no automatic Owner reassignment is introduced. The source row's `opportunityId` is a validated bare id too. A failed write calls `reportPageError(PAGE_NAME, 'changeCustomer', undefined, error, 'write')` with **no retry argument**: never retry an unknown outcome automatically. Custom API lookup inputs keep their own `{ entityName, id }` contract.

#### When a bare id has no table evidence

Today's qualified values normally resolve with no extra read even when the annotation is absent. The following applies **only** to `needs-target` — never to `invalid` evidence:

1. Prefer a target already proven by the exact typed source-relationship query that returned this same source row and value.
2. For Owner, use the verified `_owninguser_value` / `_owningteam_value` only when both were loaded, exactly one is non-null, and its **normalized** bare id equals the owner value's id (normalize each with its own target set — a raw string comparison is wrong when one is qualified). Missing or malformed values, both or neither non-null, or a mismatch stay unresolved. Never build an owner navigation path.
3. Otherwise, for an explicitly opened row and a bounded approved target subset, query the **source table** restricted by its primary key and a concrete target navigation predicate, with `pageSize: 1` — for a Customer account test, `opportunityid eq <source id> and customerid_account/accountid eq <bare lookup id>`; the contact test uses the verified contact path. Only one successful exact match proves the target.
4. Never retrieve account, then contact, by the same GUID and keep the first that succeeds. Zero or several matches, or unavailable discriminators, mean unresolved. A refused query is an error — report it with `reportPageError(…, 'read')` — never zero matches, a cached unknown, a weakened predicate or a raw `fetch`.

Use the page's existing in-flight de-duplication and cache rules for these reads. Cache a successful resolution by source table, source row id, lookup column and value snapshot — not by the lookup GUID alone — and invalidate it on a lookup write or a refresh. A missing-evidence unknown may be remembered for that snapshot; a thrown read is never cached as unknown, no match, rows or success. Ignore a stale or unmounted result. Regarding follows the same algorithm: never fan out across its targets on mount.

**Failures.** A requested resolution, read or navigation that fails is reported as `'read'`; a failed lookup write as `'write'` with no retry. Pass the thrown error or a fixed diagnostic `Error` — never a row, a reference pair or a returned success payload. The four states above are classifications, not error kinds.

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
`genpage.js types` per build with the actual entity tables,
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

### Dialog output (`setPageOutput`)

A page opened as a dialog can return a value to the page that opened it. The runtime's data API
has `setPageOutput(value: unknown): void`. It stores the value and does **not** close the dialog.
Then `Xrm.Navigation.navigateBack()` closes the dialog, and the caller's `navigateTo` promise
resolves with `{ returnValue: <the value> }`. A dialog closed without `setPageOutput` gives
`returnValue: undefined`. The method is synchronous: do not `await` it.

The generated `RuntimeTypes.ts` does **not** declare `setPageOutput`, so
`dataApi.setPageOutput(...)` fails type checking with "Property 'setPageOutput' does not exist on
type 'UxAgentDataApi'". Use this narrow typed intersection. Do not use `any`, and do not change
`RuntimeTypes.ts`:

```typescript
// In the dialog page: return the selection, then close.
const outputApi = dataApi as typeof dataApi & { setPageOutput(value: unknown): void };
if (typeof outputApi.setPageOutput === "function") outputApi.setPageOutput({ action: "selected", accountId: selectedId });
(window as any).Xrm.Navigation.navigateBack();
```

```typescript
// In the calling page: open the dialog (target 2) and read what it returned.
const result = await (window as any).Xrm.Navigation.navigateTo(
    { pageType: "generative", pageId: targetPageId, data: { mode: "pick" } },
    { target: 2, position: 1, width: { value: 50, unit: "%" } },
);
const output = result?.returnValue;   // undefined when the dialog was closed without an output
```

The caller reads `returnValue` as an `unknown`: check its shape before you use it. Call
`setPageOutput` only in a page that is opened as a dialog, and only when the user completes the
dialog's action. Do not call it on mount.

### Connector DataAPI (optional — only when the plan has Connector Bindings)

When the plan's `## Connector Bindings` is non-empty, the page may call Power
Platform connectors via `queryConnectorTable` (tabular) and
`executeConnectorOperation` (REST). These are optional runtime methods — always
presence-check before calling. See [connectors.md](./connectors.md) for the
required patterns and the binding contract.

### Custom API DataAPI (optional — only when the plan has Custom API Bindings)

When the plan's `## Custom API Bindings` contains a binding table, the page may invoke Dataverse
**Custom APIs** (server-side plug-in logic) on the signed-in user's own token. A Custom
API of kind **Action** (POST) is called with `dataApi.executeAction`; a **Function**
(GET) with `dataApi.executeFunction`; `dataApi.listBoundActions` enumerates the
page's bound operations. These are optional runtime methods — always presence-check before
calling, guard Actions against double-submit, read results from `res.outputs` (never
`res.value`), surface only the sanitized `res.error?.message`, and never auto-retry an
`indeterminate` result. Call only the `name`s in the plan's `## Custom API Bindings`; a name
not bound to the page fails with `not_bound`. See [custom-api.md](./custom-api.md) for the
required patterns, the `boundTo` rules, and the full `error.code` contract.
Automatic Function invocation requires known read semantics, not merely GET metadata.
Read the plan's separate lookup-input notes: structural `{ entityName, id }` lookup values
remain call inputs even though only primitive kinds appear in `parameterKinds`.
Discovery-only `lookupParameters` must never be copied into a wire binding.

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

For lookups: a `_<field>_value` read value may be a bare GUID or `/<table>(<guid>)` — the current player has
been verified to return the qualified form for Customer and user-owned Owner lookups. Never display it: read the
paired `..._value@OData.Community.Display.V1.FormattedValue` for the label. Before filtering, retrieving or
navigating, normalize it with `normalizeLookupReference`, which validates the annotation and the prefix against
the column's metadata targets and returns the table and the bare id (see "Lookup references" under DataAPI Rules).

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
A `try`/`catch` that logs the thrown value and sets an ad-hoc string is not enough: it logs whatever
record text the host put in the message, drops the error code, and leaves each page reporting
failures its own way. Every failed data operation goes through the page's one top-level
`reportPageError`, the view it returns goes into that operation's error state, and `PageErrorBar`
renders it. The whole page renders inside one `PageErrorBoundary`.

Copy the block below unchanged — the reporter, the error copy, the bar, the boundary and the
default export — and set `PAGE_NAME` to the plan's display name for the page (a fixed literal,
never the file name). `PageBody` is where the page itself lives: its hooks, state and handlers.
Render each operation's `<PageErrorBar error={…} />` in the component's final returned JSX, outside any
condition, ternary or list: the bar shows nothing until there is an error, and a bar that may not render
cannot show one.
`reportPageError(pageName, operation, code, message, kind, retry?, appInsights?)` takes five
required arguments:

- `operation` — one stable literal per logical operation (`'loadAccounts'`, `'createAccount'`),
  shared by its success and failure branches; never built from a record.
- `code` — the host's error code when a returned result carries one (`res.error?.code`), otherwise
  `undefined`.
- `message` — the result's `res.error?.message`, or the caught value itself (`error`). Never pass
  the result object, its outputs, a row, a lookup reference or an identity, and never change the
  result's `error` or the caught value (assign, write a field, alias) before reporting it.
- `kind` — a string literal the caller decides from the operation, never from the code or the
  wording:

| Operation or result | `kind` | `retry` (sixth argument) |
|---|---|---|
| `queryTable`, `retrieveRow`, `getChoices`, `queryConnectorTable`, `listBoundActions`; a rejected navigation | `'read'` | a named reload, or none |
| `createRow`, `updateRow`, `deleteRow`, `executeAction`; a connector operation not known to be a read | `'write'` | none |
| a Custom API result with `res.indeterminate` or `res.error?.code === 'indeterminate'` (check both first) | `'indeterminate'` | none |
| a failed Custom API result with `res.error?.code === 'network'`, after both indeterminate checks | `'network'` | a named manual retry only |
| a WhoAmI or RetrieveVersion failure | `'read'` | none |
| a render crash (the boundary) | `'render'` | none |

The reporter logs one line, `[<page name>] <operation> failed` with `{ code, message }` (the code at
most 80 characters, the message its first line and at most 300), and returns
`{ operation, message, fallbackKey, code?, kind, retry? }`. It reads only `code`, `errorCode`,
`message`, `error.code` and `error.message` of a thrown value, never logs the value itself, never
sets state and never calls `retry`. An indeterminate or render failure shows only its fixed copy and
never offers a retry, whatever its code says. Nothing retries automatically: a retry is a button the
user presses.

Store the view in the same single state update as the operation's other results (Critical Rule 14):
error state is `PageErrorView | null`, never a string. Only that operation's own success, or an
explicit dismissal, clears it — another operation's success must not erase it. A failed form stays
visible; a failed list may show the error above its empty state. A null lookup, zero rows or an
absent optional value is a normal state, not a failure. The boundary catches render crashes only —
not rejected promises or event handlers — and has no reset; never call `PageBody(props)` yourself.

```tsx
import * as React from 'react';
import { Button, Input, MessageBar, MessageBarActions, MessageBarBody } from '@fluentui/react-components';
import type { GeneratedComponentProps } from './RuntimeTypes';

type PageErrorKind = 'read' | 'write' | 'indeterminate' | 'network' | 'render';
type PageErrorView = {
  operation: string;
  message: string;
  fallbackKey: string;
  code?: string;
  kind: PageErrorKind;
  retry?: () => void;
};
type PageErrorTelemetry = {
  trackException?: (error: unknown, properties?: Record<string, unknown>) => void;
};

// The plan's display name for this page: a fixed literal, not the file name.
const PAGE_NAME = 'Account Overview';

// The error copy of an English-only page. A localized page keeps these keys in its translations
// dictionary instead (references/localization.md). Keep the built-in keys only on a page that calls
// WhoAmI or RetrieveVersion.
const ERROR_COPY: Record<string, string> = {
  'error.read': 'Unable to load data. Please try again.',
  'error.write': 'The change could not be saved. Refresh before trying again.',
  'error.network': 'The request did not go through. You can try again.',
  'error.indeterminate': "We couldn't confirm this completed — refresh before retrying.",
  'error.render': 'This page hit a problem and could not render. Refresh the page.',
  'error.tryAgain': 'Try again',
  'error.builtinFailed': 'The operation failed. No result was displayed.',
  'error.builtinUnavailable': 'The selected operation is unavailable in this environment or player. No fallback was attempted.',
  'error.builtinUnexpected': 'The operation returned an unexpected response. No result was displayed.',
  'error.builtinUnsupported': 'This page player cannot call built-in Dataverse operations.',
};

function translate(key: string): string {
  return ERROR_COPY[key] || key;
}

// The page's one error reporter. It logs bounded diagnostics once and returns the view the failed
// operation stores; it never sets state, never calls retry, and reads only the named fields of a
// thrown value, each on its own, so a throwing getter leaves that one field empty.
function reportPageError(
  pageName: string,
  operation: string,
  code: unknown,
  message: unknown,
  kind: PageErrorKind,
  retry?: () => void,
  appInsights?: PageErrorTelemetry,
): PageErrorView {
  const fields: Record<string, unknown> = {};
  for (const path of ['code', 'errorCode', 'message', 'error.code', 'error.message']) {
    try {
      let value: unknown = message;
      for (const part of path.split('.')) {
        value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
      }
      fields[path] = value;
    } catch {
      fields[path] = undefined;
    }
  }
  let normalizedCode = '';
  for (const candidate of [code, fields['code'], fields['errorCode'], fields['error.code']]) {
    const text = typeof candidate === 'string' ? candidate : typeof candidate === 'number' && Number.isFinite(candidate) ? String(candidate) : '';
    normalizedCode = text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 80);
    if (normalizedCode) break;
  }
  let normalizedMessage = '';
  for (const candidate of [message, fields['message'], fields['error.message']]) {
    const line = typeof candidate === 'string' ? candidate.trim().split(/[\r\n\u2028\u2029]/)[0].replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim() : '';
    if (!line || /^\[object [^\]]*\]$/.test(line) || /^at\s.*(?::\d+:\d+\)?|\((?:native|<anonymous>)\))$/.test(line)) continue;
    normalizedMessage = line.length > 300 ? line.slice(0, 299) + '\u2026' : line;
    break;
  }
  console.error('[' + String(pageName).replace(/[\r\n\]]/g, '') + '] ' + operation + ' failed', { code: normalizedCode, message: normalizedMessage });
  const quiet = kind === 'indeterminate' || kind === 'render';
  const view: PageErrorView = { operation, message: quiet ? '' : normalizedMessage, fallbackKey: 'error.' + kind, kind };
  if (normalizedCode) view.code = normalizedCode;
  if (typeof retry === 'function' && (kind === 'read' || kind === 'network')) view.retry = retry;
  return view;
}

function PageErrorBar(props: { error: PageErrorView | null }) {
  const { error } = props;
  if (!error) return null;
  return (
    <MessageBar intent="error">
      <MessageBarBody>{error.message || translate(error.fallbackKey)}</MessageBarBody>
      {error.retry && (
        <MessageBarActions>
          <Button onClick={error.retry}>{translate('error.tryAgain')}</Button>
        </MessageBarActions>
      )}
    </MessageBar>
  );
}

// The page's one class component: it catches a render crash below it and shows a fixed message.
class PageErrorBoundary extends React.Component<
  { children: React.ReactNode; appInsights?: PageErrorTelemetry },
  { failed: boolean }
> {
  public state = { failed: false };

  public static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  public componentDidCatch(error: Error): void {
    reportPageError(PAGE_NAME, 'render', undefined, error, 'render');
  }

  public render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <MessageBar intent="error">
          <MessageBarBody>{translate('error.render')}</MessageBarBody>
        </MessageBar>
      );
    }
    return this.props.children;
  }
}

function PageBody(props: GeneratedComponentProps) {
  const { dataApi } = props;
  const [name, setName] = React.useState('');
  const [save, setSave] = React.useState<{ saving: boolean; error: PageErrorView | null }>({ saving: false, error: null });
  const pending = React.useRef(false);

  async function createAccount() {
    if (pending.current) return;
    pending.current = true;
    setSave({ saving: true, error: null });
    try {
      await dataApi.createRow('account', { name });
      setSave({ saving: false, error: null });
    } catch (error) {
      setSave({ saving: false, error: reportPageError(PAGE_NAME, 'createAccount', undefined, error, 'write') });
    } finally {
      pending.current = false;
    }
  }

  return (
    <div>
      <PageErrorBar error={save.error} />
      <Input aria-label="Account name" value={name} onChange={(_, data) => setName(data.value)} />
      <Button appearance="primary" disabled={save.saving || !name.trim()} onClick={() => void createAccount()}>
        Create account
      </Button>
    </div>
  );
}

const GeneratedComponent = (props: GeneratedComponentProps) => (
  <PageErrorBoundary>
    <PageBody {...props} />
  </PageErrorBoundary>
);

export default GeneratedComponent;
```

The boundary uses `React.Component`; on a page that imports React only by name, import `Component`
and `ReactNode` from `'react'` and write `extends Component<…>`. On a page where no operation passes
a retry, leave out the bar's `error.retry` part and the `MessageBarActions` import.

**Failure telemetry** — only when the dispatch says `Telemetry: enabled` **and** the maker asked to
report failures (`references/page-telemetry.md`). Insert these lines immediately after the
reporter's `console.error` line, and pass `props.appInsights` as the seventh argument only at the
call sites the request covers (render crashes: `<PageErrorBoundary appInsights={props.appInsights}>`
and `reportPageError(PAGE_NAME, 'render', undefined, error, 'render', undefined, this.props.appInsights)`
in `componentDidCatch`). It sends a new `<operation> failed` error with approved properties only —
never the thrown value, host text, a row or an identity — and a recognized code (a documented
Custom API code or a Dataverse `0x` error code) as `statusCode`; any other code stays in the log.

```tsx
  appInsights?.trackException?.(new Error(operation + ' failed'), {
    outcome: 'failure',
    category: kind === 'render' ? 'errorBoundary' : 'page',
    source: operation,
    ...(/^(?:wrong_operation_kind|invalid_parameter|invalid_bound_to|not_bound|not_permitted|not_enabled|indeterminate|network|0x[0-9a-fA-F]{8})$/.test(normalizedCode) ? { statusCode: normalizedCode } : {}),
  });
```

**The complete shape of each operation** — each reference shows a whole `PageBody` built on this block:
a cached on-mount read (`references/data-caching.md`), a Custom API Action and Function
(`references/custom-api.md`), the two built-in operations (`references/dataverse-operations.md`),
connector reads and operations (`references/connectors.md`), the usersettings read of a localized page
(`references/localization.md`) and authorized failure telemetry (`references/page-telemetry.md`). Several
reads that load together either go through named helpers that each catch, report and return
`{ error }` — awaited with `Promise.all`, then one state update — or through `Promise.allSettled` with a
`status === 'rejected'` branch that reports each item's `reason` before the one update. A single `catch`
around `Promise.all` hides every failure after the first.

**What the eval check reads, and what it does not.** The eval suite does not grade a page's error handling
yet: no check proves that every failure of a page reaches `reportPageError`, that the view it returns reaches a
rendered `PageErrorBar`, that a request is current, or that a retry is safe. Write each page to this section
as it stands — the block copied unchanged, each report a statement of its failure path's own block, a literal
kind that matches what failed — including `loadMoreRows` failures.

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

### 5. Iteration that compiles to nothing

The page compiler targets ES5 without iterator downleveling or full type checking. Spreading, looping over, or array-destructuring a Map, Set or iterator reads length and indices instead of the iterator: values can disappear, defaults can replace them, or rest destructuring can throw. This includes `[...new Set(xs)]`, `[...m.values()]`, `[...seen.values()]`, `for (const [k, v] of m)`, `new Set([...prev, id])`, `[...selected]` and `[...text.matchAll(re)]`. Convert with `Array.from(...)` before spreading, looping or destructuring; copy a Set with `new Set(prev)` then `.add(id)`. Ordinary array spreads and loops remain valid. `Object.keys`, `Object.values` and `Object.entries` return arrays. Spreads of `arguments` and ordinary indexed array-likes work; rest destructuring of an array-like without `slice` does not. String spread throws, and an ES5 string loop visits UTF-16 code units rather than Unicode code points. See **Common Errors > 5. Iteration that compiles to nothing** in `references/rules.md` for the pairs.

A Dropdown built from `[...seen.values()]` can open with no options despite a clean compile. The same problem affects native collection iterators, generators, native `matchAll` results, `URLSearchParams`, `FormData` and `Headers`. JSX expressions use the same emit.

**Map values**

```typescript
// WRONG — the spread contributes no values
const seen = new Map([["a", 1], ["b", 2]]);
const choices = [...seen.values()];
```

```typescript
// CORRECT
const seen = new Map([["a", 1], ["b", 2]]);
const choices = Array.from(seen.values());
```

**Unique values**

```typescript
// WRONG — unique becomes []
const xs = [1, 1, 2];
const unique = [...new Set(xs)];
```

```typescript
// CORRECT — insertion order is preserved
const xs = [1, 1, 2];
const unique = Array.from(new Set(xs));
```

**Map pairs**

```typescript
// WRONG — the loop runs zero times
const m = new Map([["a", 1], ["b", 2]]);
const rows: Array<[string, number]> = [];
for (const [k, v] of m) rows.push([k, v]);
```

```typescript
// CORRECT — keep loop control flow
const m = new Map([["a", 1], ["b", 2]]);
const rows: Array<[string, number]> = [];
for (const [k, v] of Array.from(m)) rows.push([k, v]);
```

A native Map's `m.forEach((v, k) => { rows.push([k, v]); })` is an alternative, not a second step. Its callback order is `(value, key)`. It is not a mechanical replacement for a loop with `break`, `continue` or an outer `return`.

**Selection state — component-body examples; state values are not statically inferred**

```typescript
// WRONG — the updater loses prior ids; chosen loses every selected value
const [selected, setSelected] = React.useState(new Set<string>());
function addSelected(id: string) {
  setSelected(prev => new Set([...prev, id]));
}
const chosen = [...selected];
```

```typescript
// CORRECT — call the handler from an event, never unconditionally during render
const [selected, setSelected] = React.useState(new Set<string>());
function addSelected(id: string) {
  setSelected(prev => {
    const next = new Set(prev);
    next.add(id);
    return next;
  });
}
const chosen = Array.from(selected);
```

The Map and Set constructors consume iterables natively: `new Set(prev)` and `new Map(entries)` are not the problematic spread. Do not mutate the previous React state.

**Native matchAll result**

```typescript
// WRONG — the match iterator has no array length
const text = "a1 b2";
const re = /\d/g;
const hits = [...text.matchAll(re)].map(match => match[0]);
```

```typescript
// CORRECT
const text = "a1 b2";
const re = /\d/g;
const hits = Array.from(text.matchAll(re)).map(match => match[0]);
```

**Destructuring**

```typescript
// WRONG — first is undefined
const [first] = new Set([1, 2]);
```

```typescript
// CORRECT
const [first] = Array.from(new Set([1, 2]));
```

```typescript
// WRONG — fallback replaces the actual value
const [first = "fallback"] = new Set(["actual"]);
```

```typescript
// CORRECT
const [first = "fallback"] = Array.from(new Set(["actual"]));
```

```typescript
// WRONG — throws because the emitted rest operation calls slice
const [...rest] = new Set([1, 2]);
```

```typescript
// CORRECT
const [...rest] = Array.from(new Set([1, 2]));
```

**String spread — a separate throw, not an empty iterable result**

```typescript
// WRONG
const name = "A😀";
const chars = [...name];
```

```typescript
// CORRECT — Array.from reads Unicode code points
const name = "A😀";
const chars = Array.from(name);
```

Call and constructor arguments need the same conversion: write `f(...Array.from(iterator))` and `new C(...Array.from(iterator))`, not direct iterator spreads.

These operations remain ordinary valid patterns: `[...rows]`, `[...Object.keys(row)]`, `for (const row of rows)`, `const [first] = rows`, `{ ...tokens }`, `<div {...props} />`, rest parameters, `selected.has(id)`, `seen.set(key, value)`, `new Set(prev)` and `new Map(entries)`. A first-element binding of a string reads its indexed UTF-16 element, not a whole Unicode code point.

The authoring rule also applies when an iterable comes from props, parameters, React state, a ref, a cache or another function. Static checks cannot prove all of those origins. Do not mistake a lack of findings for proof that arbitrary iteration is safe.
