# Page Telemetry (`props.appInsights`)

How a generated page reports its own custom telemetry to the customer's
Application Insights resource.

> **Not the plugin's own telemetry.** This document is about code the *generated
> page* emits at runtime inside a model-driven app. It is unrelated to the
> plugin's `skill_started` usage telemetry (`/model-apps:telemetry`), which
> measures the authoring tool rather than the page.

**Gated by the default-OFF `custom-telemetry` feature flag.** `genpage-page-builder`
reads this file only when its dispatch says `Telemetry: enabled`. With the flag OFF
a generated page contains no telemetry calls at all, exactly as before the feature
existed.

---

## 1. When to instrument - read this first

This section decides whether you write **any** telemetry at all. It outranks every
other section in this document.

- **Telemetry is opt-in per request.** Instrument the page **only** when the maker's
  request describes a measurement, tracking, logging, analytics, monitoring, or
  reporting need *in their own words*. Their words are the trigger - not the
  availability of the API, and not the fact that you were given this file.
- **The default is zero telemetry.** If the maker did not ask to measure or track
  something, write **no** telemetry calls whatsoever. A page with no telemetry is
  the correct and expected output for the overwhelming majority of requests. Do not
  add telemetry to be helpful, thorough, or complete.
- **Being handed this file is not a request to use it.** It is loaded whenever the
  flag is on for the environment. Treat this section as a locked door: the maker's
  own words are the only key.
- **Do not infer intent from the page's subject matter.** A page about orders, KPIs,
  revenue, dashboards, reports, or "metrics" as *displayed content* is not a request
  to *emit* telemetry. Showing a number to the user and reporting a number to
  Application Insights are unrelated concerns; only the latter needs this API.
- **Do not infer intent from the words "error", "fail", or "retry"** when they
  describe UI behavior the maker wants (an error message, a retry button). Those
  describe what the user sees, not what gets reported.
- **When intent is genuinely ambiguous, do not instrument.** Prefer omission; the
  page can always be instrumented in a follow-up turn.
- **A narrow request stays narrow.** If the maker asks for telemetry in one place,
  instrument only that place. Never generalize it into page-wide instrumentation.
- **An explicit refusal wins.** If the maker says not to add telemetry, or asks to
  remove it, emit none regardless of anything else they said.

### Trigger patterns

Maker language that **does** authorize instrumentation, and what to add for each.
Match on intent, not exact wording.

| Maker says something like... | Add |
|---|---|
| "track when a user completes a task" | `trackEvent('TaskCompleted', { ... })` in the completion handler |
| "log errors to App Insights" / "report failures" | the failure-telemetry lines inserted into the page's `reportPageError` (rules.md → *Missing Error Handling*), and `props.appInsights` as the **seventh argument** of every data failure's report; render crashes too, through the boundary (section 3) |
| "report failed saves" | the same insertion, and `props.appInsights` as the seventh argument of the save's reports **only** — never the loads' and never the boundary's |
| "measure how many records load" | `trackMetric('AccountsLoaded', rows.length)` after the load resolves |
| "track which filters users apply" | `trackEvent('FilterApplied', { ... }, { throttle: { key: 'FilterApplied', windowMs: 1000 } })` |
| "track searches as the user types" | debounce at the source, then `trackEvent('Searched', { count }, { throttle: ... })` |
| "how long the page takes to load data" | `startTrack` / `stopTrack` around the fetch |
| "log when a form is submitted" | `trackEvent('FormSubmitted', { entityName, recordId, outcome })` |
| "track navigation between pages" | `trackEvent('NavigatedToDetails', { entityName, recordId })` immediately before the navigation call |
| a bare "add telemetry", no detail | ask **one** clarifying question about what they want to learn, then instrument only what they confirm |

Counter-examples that **do not** authorize instrumentation: "show a chart of sales by
region", "display the record count", "add a KPI tile", "show an error message if the
save fails", "add a retry button", "make the page load fast".

**Failures are reported in one place.** Every page reports its failures through its one
`reportPageError` (rules.md, Critical Rule 22) whether or not telemetry is on. A request to
report failures does not add `trackException` calls to catch blocks: it inserts the documented
lines into that reporter and hands `props.appInsights` to exactly the reports the request
covers. The reporter sends a new `<operation> failed` error with `outcome`, `category`,
`source` and a recognized `statusCode` — never the thrown value, the host's message, a row, a
lookup or an identity. A request that asks only for success events ("track when a user completes
a task") leaves the reporter and the boundary as they are.

---

## 2. The API

```typescript
/**
 * The ONLY property keys a page may attach to a telemetry call.
 * Any other key is silently dropped. Never pass customer data in these values.
 */
export interface GenUXTelemetryProperties {
    /** Logical name of the table involved, e.g. 'account'. */
    entityName?: string;
    /** Id of the record involved. Ids only - never a name or other field value. */
    recordId?: string;
    /** Result of the action, e.g. 'success' | 'failure' | 'cancelled'. */
    outcome?: string;
    /** Coarse grouping for the call site, e.g. 'form' | 'grid' | 'chart'. */
    category?: string;
    /** The kind of thing acted on, e.g. 'order' | 'attachment'. */
    itemType?: string;
    /** What triggered the action, e.g. 'toolbar' | 'contextMenu' | 'autoRefresh'. */
    source?: string;
    /** HTTP or error status code, as a string. */
    statusCode?: string;
    /** A count, e.g. number of rows returned. Never derived from record content. */
    count?: number;
    /** A duration in milliseconds. */
    durationMs?: number;
    /** Short non-sensitive diagnostic detail. NEVER user input or record content. */
    detail?: string;
}

/**
 * Coalescing options for call sites that can fire rapidly.
 * Calls sharing a `key` within the window collapse into one.
 */
export interface GenUXTelemetryThrottleOptions {
    /** Stable identifier for this call site. Required. */
    key: string;
    /** Coalescing window in milliseconds. Defaults to 1000. */
    windowMs?: number;
    /** 'trailing' (default) reports the last call; 'leading' reports the first. */
    mode?: 'trailing' | 'leading';
}

export interface GenUXTelemetryCallOptions {
    throttle?: GenUXTelemetryThrottleOptions;
}

/**
 * Every method is fire-and-forget: returns void, never throws, never returns data.
 * Do NOT await these calls and do NOT wrap them in try/catch.
 */
export interface IGenUXPageAppInsightsTelemetry {
    /** Report a failure. A page calls it ONLY from inside its reportPageError (rules.md, "Missing Error Handling"). */
    trackException(error: unknown, properties?: GenUXTelemetryProperties, options?: GenUXTelemetryCallOptions): void;

    /** Report a diagnostic message. Use sparingly. */
    trackTrace(message: string, properties?: GenUXTelemetryProperties, options?: GenUXTelemetryCallOptions): void;

    /** Report a call to an external system. */
    trackDependency(name: string, properties?: GenUXTelemetryProperties, options?: GenUXTelemetryCallOptions): void;

    /** Report a meaningful user action or page milestone. `name` must be a stable literal. */
    trackEvent(name: string, properties?: GenUXTelemetryProperties, options?: GenUXTelemetryCallOptions): void;

    /** Report a numeric measurement worth aggregating. */
    trackMetric(name: string, value: number, properties?: GenUXTelemetryProperties, options?: GenUXTelemetryCallOptions): void;

    /** Start timing an operation. Must be matched by exactly one stopTrack with the same name. */
    startTrack(name: string): void;

    /** Stop timing an operation started with startTrack; the duration is reported automatically. */
    stopTrack(name: string, properties?: GenUXTelemetryProperties, options?: GenUXTelemetryCallOptions): void;
}
```

### Declaring the prop

`appInsights` is an **optional** addition to the page's props. When you instrument a
page, declare the methods the page actually uses at the top of the file and intersect
them into the component signature - do not assume `GeneratedComponentProps` already
carries the prop, because the generated `RuntimeTypes.ts` may predate it:

```typescript
type PageTelemetry = {
    trackEvent(name: string, properties?: Record<string, unknown>, options?: unknown): void;
    trackMetric(name: string, value: number, properties?: Record<string, unknown>, options?: unknown): void;
    startTrack(name: string): void;
    stopTrack(name: string, properties?: Record<string, unknown>, options?: unknown): void;
};

function PageBody(props: GeneratedComponentProps & { appInsights?: PageTelemetry }) {
    const { dataApi, pageInput, appInsights } = props;
    // ...
}

const GeneratedComponent = (props: GeneratedComponentProps & { appInsights?: PageTelemetry }) => (
    <PageErrorBoundary>
        <PageBody {...props} />
    </PageErrorBoundary>
);
```

Only declare the methods the page actually calls. `trackException` is not one of them: the
reporter's own `PageErrorTelemetry` type declares it, because only the reporter calls it. On a
page you are **not** instrumenting, add none of this - the signatures stay exactly
`(props: GeneratedComponentProps)`.

---

## 3. Rules

These apply **only** once section 1 has authorized instrumentation. They never
justify adding telemetry on their own.

- **Destructure it with the other props:** `const { dataApi, pageInput, appInsights } = props;`
- **Call it straight off the prop — never wrap it in a `useRef`.** Read
  `appInsights?.trackEvent(...)` directly from the destructured value at the call
  site. Do **not** mirror it into a ref (`const telemetryRef = useRef(appInsights)`)
  to "keep the latest reference" for an effect that omits it from its dependency
  array. Telemetry is fire-and-forget, so the value captured by that render's
  closure is always good enough — there is no stale-reference bug to defend
  against. The ref is pure ceremony, and the usual way of maintaining it
  (`telemetryRef.current = appInsights` in the component body) is a
  **mutation during render**, which React does not permit. For the same reason,
  do **not** add `appInsights` to a `useEffect` dependency array: the host hands a
  new props object on every render, so depending on it re-fires the effect
  (exactly the failure mode Rule 15 exists to prevent). Depend on the readiness
  boolean as usual and let the effect close over `appInsights`.
- **The prop is optional and is frequently absent** (older runtimes, the authoring
  and preview surfaces, the feature turned off). **Always** call through optional
  chaining - `appInsights?.trackEvent(...)`. Never store it in a non-optional
  variable, and never branch page behavior on whether it exists.
- **Fire-and-forget.** Every method returns `void`, never throws, and never returns
  data. Never `await` a telemetry call, never wrap one in `try`/`catch`, and never
  let a telemetry result affect rendering.
- **Never on the critical path.** Emit after the work succeeds or fails - never
  before it, and never in place of it.
- **No customer data.** Never pass record contents, user-entered text, search terms,
  names, email addresses, phone numbers, addresses, or free-form field values. Emit
  shapes and outcomes ("saved", "failed", a count, a duration), not the data itself.
- **Only the property keys in `GenUXTelemetryProperties` are allowed.** Any other key
  is silently dropped, so do not invent keys.
- **Always pass the contextually relevant properties** as the second argument -
  entity name, record id, outcome, count, duration. Avoid empty property objects: an
  event with no properties is rarely worth emitting. Do not pass page or correlation
  context; the platform stamps that automatically.
- **Be selective even when asked.** Instrument the moments the maker asked about and
  stop there. A well-instrumented page emits a handful of calls, not dozens.
- **Never instrument render**, per-row rendering, per-keystroke, mouse-move, scroll,
  hover, or any effect that runs on every render. High-frequency call sites are the
  main risk this API carries.
- **Throttle rapid-fire call sites.** When an authorized call site can fire rapidly
  but is still worth measuring (typing in a search box, dragging a slider, applying
  filters), you **must** pass the throttle option with a stable, distinct `key` per
  call site: `{ throttle: { key: 'ordersSearch', windowMs: 1000 } }`.
- **Failures go through `reportPageError` only.** Never call `trackException` — or
  `trackTrace` — in a `catch` block or anywhere else yourself. Insert the documented
  telemetry lines into the page's reporter (right after its `console.error` line) and pass
  `props.appInsights` as the seventh argument of exactly the reports the request covers:
  `reportPageError(PAGE_NAME, 'saveOrder', undefined, error, 'write', undefined, props.appInsights)`.
  Do **not** report expected empty states (a query returning zero rows, an optional lookup
  finding nothing) or validation the user is expected to hit; those are normal outcomes, not
  failures, and they never reach the reporter.
- **The boundary reports render crashes only when the request covers them.** A render crash
  never reaches a `catch` block, so a request to report failures generally covers it: then
  render `<PageErrorBoundary appInsights={props.appInsights}>` and make its `componentDidCatch`
  report `reportPageError(PAGE_NAME, 'render', undefined, error, 'render', undefined, this.props.appInsights)`
  (rules.md shows both). A request about one operation ("report failed saves") leaves the
  boundary as it is.
- **`trackTrace`** is for a diagnostic breadcrumb at a key decision point in
  genuinely complex logic (which branch a multi-step flow took, why a fallback
  engaged). Do not narrate ordinary control flow with it.
- **`trackMetric`** is only for a genuine number worth aggregating (row counts,
  durations); **`trackDependency`** is for a call to an external system.
- **`startTrack`/`stopTrack`** time an operation and compute the duration for you.
  Every `startTrack` must have exactly one matching `stopTrack` with the same name,
  including on the error path.
- **Names are short, stable, PascalCase literals naming the business action**, not
  the UI gesture. Good: `TaskCompleted`, `FilterApplied`, `RecordOpened`,
  `FormSubmitted`. Bad: `ButtonClicked`, `CheckboxChanged`, `RowClicked` - these
  describe the widget, not what happened, and are useless in aggregate. **Never build
  a name by interpolating data**; a dynamic name creates unbounded distinct values
  and makes the data unusable.
- **Do not duplicate what the platform already reports.** No page-view events, and do
  not manually track DataAPI calls unless the page makes outbound calls of its own.

---

## 4. Known-good shapes

Shape references for pages whose maker **asked** to track or measure something - not
a default template. Note how few calls even an intentionally instrumented page makes.
Each page is built on the page error block of rules.md: its failures are reported through
`reportPageError` either way, and only an authorized request hands that reporter
`props.appInsights`.

A whole `PageBody` for "report failed saves": the reporter carries the inserted telemetry
lines, the save's two reports pass `appInsights` as the seventh argument, and nothing else is
instrumented — not the load, not the boundary.

```tsx
type OrderRow = { orderid: string; name: string };
type PageTelemetry = { trackEvent(name: string, properties?: Record<string, unknown>, options?: unknown): void };

function PageBody(props: GeneratedComponentProps & { appInsights?: PageTelemetry }) {
    const { dataApi, pageInput, appInsights } = props;
    void pageInput;
    const [name, setName] = React.useState('');
    const [save, setSave] = React.useState<{ saving: boolean; error: PageErrorView | null }>({ saving: false, error: null });
    const pending = React.useRef(false);

    async function saveOrder() {
        if (pending.current) return;
        pending.current = true;
        setSave({ saving: true, error: null });
        try {
            await dataApi.createRow('order', { name });
            setSave({ saving: false, error: null });
        } catch (error) {
            // The one call that reaches Application Insights for this failure: the reporter sends
            // `saveOrder failed` with approved properties only — never `error` itself.
            setSave({ saving: false, error: reportPageError(PAGE_NAME, 'saveOrder', undefined, error, 'write', undefined, appInsights) });
        } finally {
            pending.current = false;
        }
    }

    return (
        <div>
            <PageErrorBar error={save.error} />
            <Input aria-label="Order name" value={name} onChange={(_, data) => setName(data.value)} />
            <Button appearance="primary" disabled={save.saving || !name.trim()} onClick={() => void saveOrder()}>Save order</Button>
        </div>
    );
}
```

Handler shapes for other requests. Each sits inside `PageBody`, which destructures
`appInsights` from its props:

```tsx
// GOOD: "how long saving takes" - one timed operation, stopped on BOTH paths. The failure is
// reported without telemetry: this request measures a duration, it does not ask to report failures.
async function submitOrder(): Promise<void> {
    appInsights?.startTrack('OrderSubmit');
    try {
        await dataApi.createRow('order', values);
        // stopTrack reports the elapsed time for you - do not compute it yourself.
        appInsights?.stopTrack('OrderSubmit', { outcome: 'success', entityName: 'order' });
        setSubmit({ submitting: false, error: null });
    } catch (error) {
        appInsights?.stopTrack('OrderSubmit', { outcome: 'failure', entityName: 'order' });
        setSubmit({ submitting: false, error: reportPageError(PAGE_NAME, 'submitOrder', undefined, error, 'write') });
    }
}

// GOOD: "log when a form is submitted" - an event on BOTH the success and failure paths. The
// event names the outcome; it carries no error, and the failure goes to the reporter as usual.
async function handleSubmit(): Promise<void> {
    try {
        const recordId = await dataApi.createRow('order', values);
        appInsights?.trackEvent('OrderSubmitted', { outcome: 'success', entityName: 'order', recordId, source: 'toolbar' });
        setSubmit({ submitting: false, error: null });
    } catch (error) {
        appInsights?.trackEvent('OrderSubmitted', { outcome: 'failure', entityName: 'order', source: 'toolbar' });
        setSubmit({ submitting: false, error: reportPageError(PAGE_NAME, 'submitOrder', undefined, error, 'write') });
    }
}

// GOOD: a rapid-fire call site MUST pass a throttle with a stable key.
const handleSearchChange = (value: string): void => {
    setSearchText(value);
    appInsights?.trackEvent(
        'OrdersSearched',
        // The search TEXT is never sent - only the fact that a search happened.
        { category: 'grid', count: value.length },
        { throttle: { key: 'ordersSearch', windowMs: 1000 } }
    );
};
```

For "report failures" (every failure), insert the reporter's telemetry lines, pass
`props.appInsights` as the seventh argument of every data failure's report, and instrument the
boundary as rules.md shows: `<PageErrorBoundary appInsights={props.appInsights}>` in the default
export, and `reportPageError(PAGE_NAME, 'render', undefined, error, 'render', undefined, this.props.appInsights)`
in its `componentDidCatch`. A render crash never reaches a `catch` block, so the boundary is
the only place it can be reported.

---
## 5. Anti-patterns

```tsx
// BAD: fires on every render, thousands of times. Never instrument render.
const BadRow = ({ order }: { order: TableRow }) => {
    appInsights?.trackEvent('RowRendered', { recordId: order.id });
    return <div>{order.name}</div>;
};

// BAD: leaks customer data into telemetry.
appInsights?.trackEvent('Searched', { detail: searchText });
appInsights?.trackEvent('OrderSaved', { detail: customer.emailAddress });

// BAD: dynamic event name creates unbounded distinct values.
appInsights?.trackEvent(`Order_${order.id}_Saved`);

// BAD: telemetry is fire-and-forget. Never await it, never try/catch it, never branch on it.
await appInsights?.trackEvent('Saved');
try {
    appInsights?.trackEvent('Saved');
} catch {
    /* unnecessary - telemetry never throws */
}

// BAD: non-optional access crashes wherever the prop is absent
// (preview, older runtimes, feature off).
props.appInsights.trackEvent('Saved');

// BAD: mirroring the prop into a ref "so the effect sees the latest one".
// Telemetry is fire-and-forget, so closing over the prop is already correct —
// and assigning to `.current` in the component body mutates during render.
const telemetryRef = useRef(appInsights);
telemetryRef.current = appInsights;          // mutation during render
useEffect(() => {
    telemetryRef.current?.startTrack('OrdersLoad');
}, [dataReady]);

// GOOD: call the destructured prop directly; the effect closes over it.
useEffect(() => {
    appInsights?.startTrack('OrdersLoad');
    // Do NOT add `appInsights` here — the host hands a new props object every
    // render, so depending on it re-fires the effect (Rule 15).
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, [dataReady]);

// BAD: reporting an expected empty state as an error. Zero rows is a normal outcome.
if (rows.length === 0) {
    appInsights?.trackException(new Error('No orders found'), { entityName: 'order' });
}

// BAD: a trackException of its own in a catch block. It sends the thrown value - which can
// carry record text - and bypasses the page's reporter. Report through reportPageError, which
// alone calls trackException, and only with a fixed `<operation> failed` error.
try {
    await dataApi.createRow('order', values);
} catch (error) {
    appInsights?.trackException(error, { entityName: 'order', category: 'form' });
}

// BAD: a save-only request ("report failed saves") spread to the load and the boundary.
// A narrow request stays narrow: only the save's reports get `appInsights`.
reportPageError(PAGE_NAME, 'loadOrders', undefined, failure, 'read', retryLoad, appInsights);

// BAD: an un-throttled rapid call site.
const onSliderChange = (v: number): void => appInsights?.trackMetric('SliderValue', v);

// BAD: an empty property object - nothing to slice by, so the event tells you nothing.
appInsights?.trackEvent('OrderSubmitted', {});
```
