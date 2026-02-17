# Genux Code Generation Rules Reference

Comprehensive rules for generating genux page code. Read this file during code generation (Step 6).

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
9. **Icons**: Import from `@fluentui/react-icons`; use unsized variants only (e.g., `AddRegular` not `Add24Regular`)
10. **No External Libraries**: No routing libraries (React Router) or assumptions of implicit dependencies
11. **No FluentProvider**: Already provided at root; don't add in components
12. **Forbidden Functions**: Don't use `createTheme`, `mergeThemes`, `useTheme` (don't exist in Fluent UI V9)

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
  const { dataApi } = props;
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
- NEVER use `100vh`/`100vw`

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
- Multiple screens: Use Fluent UI V9 Tabs/Breadcrumbs
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

## Special Patterns

### Charts and Visualization
- Use D3.js for all charts
- D3 uses `group()` not `nest()`
- Include tooltips, hover states, click behaviors
- Smooth transitions (300-500ms)

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

### DataGrid Requirements
- Import `createTableColumn` from Fluent UI V9
- Define all columns using `createTableColumn`
- Enable column sorting by default (use `sortable: true` on columns)
- Enable column filtering when appropriate for user data exploration
- Don't connect to Dataverse without explicit table registrations
- Use mocked data if no data source provided

---

## DataAPI Type Definitions

```typescript
// Core Types
export type DataColumnValue = string | number | boolean | Date | null;
export type RowKeyDataColumnValue = string;

export interface DataRow {
  [column: string]: DataColumnValue
}

export type TableRow<R extends DataRow = DataRow> = R;

export interface DataTable<T> {
  rows: T[];
  hasMoreRows: boolean;
  loadMoreRows?: () => Promise<DataTable<T>>;
}

export type ExtractFields<T, FieldType = DataColumnValue> = {
  [K in keyof T as Required<T>[K] extends FieldType ? K : never]: T[K]
};

export type ExtractSelectable<E> = {
  [K in keyof ExtractFields<E, DataColumnValue>]: E[K]
};

export type ReadableTableRow<E> = ExtractSelectable<E> & {
  [K in keyof ExtractFields<E, DataColumnValue> as `${Extract<K, string>}@OData.Community.Display.V1.FormattedValue`]?: string
};

// Helper to exclude readonly properties
export type ExcludeReadonly<T> = {
  [P in keyof T as (<Q>() => Q extends { [K in P]: T[P] } ? 1 : 2) extends
    (<Q>() => Q extends { -readonly [K in P]: T[P] } ? 1 : 2) ? P : never]: T[P]
};

export type WritableTableRow<E extends TableRow> = {
  [K in keyof ExcludeReadonly<ExtractFields<E, DataColumnValue>>]: E[K]
}

// Query Options
export interface QueryTableOptions<E extends TableRow> {
  select?: (keyof ExtractSelectable<E>)[];
  pageSize?: number;
  filter?: string;  // ODATA $filter
  orderBy?: string; // ODATA $orderby
}

export interface RetrieveRowOptions<E extends TableRow> {
  id: string;
  select?: (keyof ExtractSelectable<E>)[];
}

// Registrations
export interface BaseTableRegistrations {
  [tableName: string]: TableRow;
}

export interface BaseEnumRegistrations {
  [enumName: string]: number;
}

export interface EnumChoice<E extends EnumName<ER>, ER extends BaseEnumRegistrations> {
  label: string;
  value: ER[E];
}

// Main API Interface
export interface BaseUxAgentDataApi<TR extends BaseTableRegistrations, ER extends BaseEnumRegistrations> {
  createRow<T extends keyof TR>(tableName: T, row: WritableTableRow<TR[T]>): Promise<RowKeyDataColumnValue>;
  updateRow<T extends keyof TR>(tableName: T, rowId: RowKeyDataColumnValue, row: WritableTableRow<TR[T]>): Promise<void>;
  deleteRow<T extends keyof TR>(tableName: T, rowId: RowKeyDataColumnValue): Promise<void>;
  retrieveRow<T extends keyof TR>(tableName: T, options: RetrieveRowOptions<TR[T]>): Promise<ReadableTableRow<TR[T]>>;
  queryTable<T extends keyof TR>(tableName: T, query: QueryTableOptions<TR[T]>): Promise<DataTable<ReadableTableRow<TR[T]>>>;
  getChoices<E extends EnumName<ER>>(enumName: E): Promise<EnumChoice<E, ER>[]>;
}
```

---

## DataAPI Usage Examples

```typescript
// User-provided type definitions example (when provided):
const enum Table1Status { Active = 0, Dormant = 1 }

type Table1 = TableRow<{
  readonly id: RowKeyDataColumnValue;
  name: string;
  phoneNumber?: string;
  status?: Table1Status;
}>

interface TableRegistrations extends BaseTableRegistrations {
  "table1": Table1; // Use logical name as key
}

interface EnumRegistrations extends BaseEnumRegistrations {
  "table1-status": Table1Status;
}

declare const dataApi: BaseUxAgentDataApi<TableRegistrations, EnumRegistrations>;

// Query with pagination
const result = await dataApi.queryTable("table1", {
  select: ["name", "status"],
  filter: `contains(name,'test')`,
  orderBy: `name asc`,
  pageSize: 50
});

// Load more pages
if (result.hasMoreRows && result.loadMoreRows) {
  const nextPage = await result.loadMoreRows();
}

// Create
await dataApi.createRow("table1", {
  name: "New Record",
  status: Table1Status.Active
});

// Update
await dataApi.updateRow("table1", "record-id", {
  name: "Updated"
});

// Retrieve
const row = await dataApi.retrieveRow("table1", {
  id: "record-id",
  select: ["name", "status"]
});

// Access formatted values (for enums, lookups, dates, etc.)
const formattedStatus = row["status@OData.Community.Display.V1.FormattedValue"];

// Lookup fields: raw value is a GUID — use formatted value for display name
const contactGuid = row._primarycontactid_value;                                           // GUID — don't display this
const contactName = row["_primarycontactid_value@OData.Community.Display.V1.FormattedValue"]; // "John Smith" — display this

// Get enum choices
const choices = await dataApi.getChoices("table1-status");
```

---

## Common Errors

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
