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
| "log errors to App Insights" / "report failures" | `trackException(err, { ... })` in the relevant `catch` blocks |
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
    /** Report a caught error. Prefer this over trackTrace inside a catch block. */
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
    trackException(error: unknown, properties?: Record<string, unknown>, options?: unknown): void;
    trackMetric(name: string, value: number, properties?: Record<string, unknown>, options?: unknown): void;
    startTrack(name: string): void;
    stopTrack(name: string, properties?: Record<string, unknown>, options?: unknown): void;
};

const GeneratedComponent = (props: GeneratedComponentProps & { appInsights?: PageTelemetry }) => {
    const { dataApi, pageInput, appInsights } = props;
    // ...
};
```

Only declare the methods the page actually calls. On a page you are **not**
instrumenting, add none of this - the signature stays exactly
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
- **Prefer `trackException` in catch blocks over `trackTrace`.** Reserve it for
  errors genuinely worth surfacing - a failed save, a failed load, a rejected
  request. Do **not** call it for expected empty states (a query returning zero rows,
  an optional lookup finding nothing) or for validation the user is expected to hit;
  those are normal outcomes, not failures.
- **Instrument the error boundary.** If the page has a React error boundary - or you
  add one for resilience - call
  `appInsights?.trackException(error, { category: 'errorBoundary' })` from its
  `componentDidCatch`. A render crash is the single most valuable error to report,
  and it never reaches a `catch` block.
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

```tsx
// GOOD: one page-level load event, emitted once, with a count and a duration.
const GeneratedComponent = (props: GeneratedComponentProps & { appInsights?: PageTelemetry }) => {
    const { dataApi, pageInput, appInsights } = props;
    const [orders, setOrders] = useState<TableRow[]>([]);

    useEffect(() => {
        let cancelled = false;
        appInsights?.startTrack('OrdersLoad');
        (async () => {
            try {
                const result = await dataApi.queryTable('order', { select: ['name', 'statuscode'], pageSize: 50 });
                if (cancelled) {
                    return;
                }
                setOrders(result.rows);
                // stopTrack reports the elapsed time for you - do not compute it yourself.
                appInsights?.stopTrack('OrdersLoad', { outcome: 'success', entityName: 'order', count: result.rows.length });
            } catch (error) {
                // A catch block is the single highest-value place to instrument.
                appInsights?.stopTrack('OrdersLoad', { outcome: 'failure', entityName: 'order' });
                appInsights?.trackException(error, { entityName: 'order', category: 'grid', source: 'pageLoad' });
            }
        })();
        return () => {
            cancelled = true;
        };
        // Never put dataApi in a dependency array - see rules.md Rule 15.
    }, []);

    // ...
};

// GOOD: a completed user action, instrumented on BOTH the success and failure paths.
const handleSubmit = async (): Promise<void> => {
    try {
        const recordId = await dataApi.createRow('order', values);
        appInsights?.trackEvent('OrderSubmitted', {
            outcome: 'success',
            entityName: 'order',
            recordId,
            source: 'toolbar',
        });
    } catch (error) {
        appInsights?.trackEvent('OrderSubmitted', { outcome: 'failure', entityName: 'order', source: 'toolbar' });
        appInsights?.trackException(error, { entityName: 'order', category: 'form' });
    }
};

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

// GOOD: an error boundary reports render crashes, which never reach a catch block.
class PageErrorBoundary extends React.Component<{ appInsights?: PageTelemetry }, { hasError: boolean }> {
    public state = { hasError: false };

    public static getDerivedStateFromError(): { hasError: boolean } {
        return { hasError: true };
    }

    public componentDidCatch(error: Error): void {
        this.props.appInsights?.trackException(error, { category: 'errorBoundary', source: 'render' });
    }

    public render(): React.ReactNode {
        return this.state.hasError ? <div>Something went wrong.</div> : this.props.children;
    }
}
```

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

// BAD: an un-throttled rapid call site.
const onSliderChange = (v: number): void => appInsights?.trackMetric('SliderValue', v);

// BAD: an empty property object - nothing to slice by, so the event tells you nothing.
appInsights?.trackEvent('OrderSubmitted', {});
```
