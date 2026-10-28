import React, { useEffect, useRef, useState } from 'react';
import type { GeneratedComponentProps } from './RuntimeTypes';
import {
    makeStyles,
    tokens,
    Text,
    Spinner,
    Button,
    Card,
    Field,
    Textarea,
    MessageBar,
    MessageBarActions,
    MessageBarBody,
} from '@fluentui/react-components';

// ---------- Page errors ----------
// The page error block of references/rules.md ("Missing Error Handling"), copied unchanged: every failed data
// operation goes through reportPageError, PageErrorBar shows the view it returns, and the page renders inside
// PageErrorBoundary.

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
const PAGE_NAME = 'Order Approval';

// The error copy of an English-only page. A localized page keeps these keys in its translations dictionary instead.
const ERROR_COPY: Record<string, string> = {
  'error.read': 'Unable to load data. Please try again.',
  'error.write': 'The change could not be saved. Refresh before trying again.',
  'error.network': 'The request did not go through. You can try again.',
  'error.indeterminate': "We couldn't confirm this completed — refresh before retrying.",
  'error.render': 'This page hit a problem and could not render. Refresh the page.',
  'error.tryAgain': 'Try again',
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

// Sample: Dataverse Custom API (plug-in) invocation from a form-embedded page.
// Demonstrates (see references/custom-api.md):
//   - Presence-checking optional dataApi methods before wiring a trigger (cast to an
//     optional action-method shape; the methods are absent on older runtimes)
//   - A FUNCTION the plan records as a read runs on mount (executeFunction) — no double-submit
//     guard needed — and a stale answer for an earlier record is ignored
//   - An entity-bound ACTION (executeAction) with boundTo from the record the page is on, and a
//     double-submit latch so a mutating call can't fire twice
//   - The approval belongs to the record it was started on: when the page moves to another record
//     its result and its retry are cleared, and a late answer for the earlier record is ignored
//   - Result handling per the contract, in order: res.indeterminate, then an `indeterminate`
//     code (never retried), then `network` (a manual "Try again"), then any other failure — each
//     reported through reportPageError and shown by PageErrorBar before res.outputs is read
//   - Only `network` is safely retryable (the request never left the client)
// Custom API names, parameters, and output fields come from the plan's `## Custom API
// Bindings` — never guessed. Here: new_GetOrderSummary (Function) + new_ApproveOrder (Action,
// bound to salesorder).

// Optional runtime methods — not part of the generated dataApi type, so declare the shape and
// presence-check before every call.
type ActionResult = {
    ok: boolean;
    indeterminate?: boolean;
    outputs?: Record<string, unknown>;
    error?: { message: string; code?: string };
};
type CustomApiDataApi = {
    executeAction?: (request: {
        name: string;
        parameters?: Record<string, unknown>;
        boundTo?: { entityName: string; id: string };
    }) => Promise<ActionResult>;
    executeFunction?: (request: {
        name: string;
        parameters?: Record<string, unknown>;
    }) => Promise<ActionResult>;
};

type OrderSummary = { Total: number; Status: string };

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalL,
        padding: tokens.spacingHorizontalXL,
        width: '100%',
        boxSizing: 'border-box',
    },
    card: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
        padding: tokens.spacingHorizontalL,
    },
    summaryGrid: {
        display: 'grid',
        gridTemplateColumns: 'minmax(120px, max-content) 1fr',
        rowGap: tokens.spacingVerticalS,
        columnGap: tokens.spacingHorizontalL,
    },
    label: {
        color: tokens.colorNeutralForeground2,
        fontWeight: tokens.fontWeightSemibold,
    },
    actions: {
        display: 'flex',
        gap: tokens.spacingHorizontalM,
        alignItems: 'center',
    },
    spinnerWrap: {
        display: 'flex',
        justifyContent: 'center',
        padding: tokens.spacingVerticalXXL,
    },
});

function PageBody(props: GeneratedComponentProps) {
    const { dataApi, pageInput } = props;
    const styles = useStyles();

    // The page is embedded on a Dataverse form, so pageInput carries the record the bound
    // Action must target. Derive synchronously from props (no useState — state init re-renders).
    const entityName = pageInput?.entityName;
    const recordId = pageInput?.recordId;

    // Cast once to the optional action-method shape and presence-check each method before use.
    const actionApi = dataApi as unknown as CustomApiDataApi;
    const canReadSummary = typeof actionApi.executeFunction === 'function';
    const canApprove = typeof actionApi.executeAction === 'function';

    // One state object per operation (Rule 14): its result, its pending flag and its error view.
    const [summaryState, setSummaryState] = useState<{ summary: OrderSummary | null; loading: boolean; error: PageErrorView | null }>(
        () => ({ summary: null, loading: canReadSummary && !!recordId, error: null }),
    );
    const summaryRequest = useRef(0); // the latest summary request; an older answer is ignored

    const [reason, setReason] = useState<string>('');
    const [approval, setApproval] = useState<{ submitting: boolean; status: string; error: PageErrorView | null }>({ submitting: false, status: '', error: null });
    const pending = useRef(false); // double-submit latch: set before the call, reset in finally
    // The record the approval panel belongs to. An approval's result — and the retry it carries — is shown only
    // for the record it was started on: another record clears the panel, and a late answer for the record the
    // page has left is ignored, so nothing on this record can approve a record the maker is not looking at.
    const approvalFor = useRef(recordId);

    function setSummaryFailure(view: PageErrorView) {
        setSummaryState({ summary: null, loading: false, error: view });
    }

    function setApprovalFailure(view: PageErrorView) {
        setApproval({ submitting: false, status: '', error: view });
    }

    function retrySummary() {
        if (recordId) void loadSummary(recordId);
    }

    function retryApprove() {
        // Re-sends this record's approval, and only while the page still shows this record.
        if (recordId && recordId === approvalFor.current) void approve(recordId, reason);
    }

    // FUNCTION: the plan records it as a read, so it may run on mount and whenever the record changes.
    async function loadSummary(orderId: string) {
        if (typeof actionApi.executeFunction !== 'function') return;
        const requestId = ++summaryRequest.current;
        setSummaryState({ summary: null, loading: true, error: null });
        try {
            const res = await actionApi.executeFunction({
                name: 'new_GetOrderSummary',
                parameters: { OrderId: orderId }, // GUID-formatted string, matching the declared kind
            });
            if (requestId !== summaryRequest.current) return; // a newer request owns the state
            if (res.indeterminate) { setSummaryFailure(reportPageError(PAGE_NAME, 'loadSummary', res.error?.code, res.error?.message, 'indeterminate')); return; }
            if (res.error?.code === 'indeterminate') { setSummaryFailure(reportPageError(PAGE_NAME, 'loadSummary', res.error?.code, res.error?.message, 'indeterminate')); return; }
            if (!res.ok && res.error?.code === 'network') { setSummaryFailure(reportPageError(PAGE_NAME, 'loadSummary', res.error?.code, res.error?.message, 'network', retrySummary)); return; }
            if (!res.ok) { setSummaryFailure(reportPageError(PAGE_NAME, 'loadSummary', res.error?.code, res.error?.message, 'read', retrySummary)); return; }
            const total = res.outputs?.Total; // read from outputs, never `value`
            const status = res.outputs?.Status;
            setSummaryState({ summary: { Total: typeof total === 'number' ? total : 0, Status: typeof status === 'string' ? status : '' }, loading: false, error: null });
        } catch (error) {
            if (requestId !== summaryRequest.current) return;
            setSummaryFailure(reportPageError(PAGE_NAME, 'loadSummary', undefined, error, 'read', retrySummary));
        }
    }

    // ACTION: may mutate, so guard against double-submit and require boundTo (this operation is
    // bound to `salesorder`; the page only offers it on a sales order form).
    async function approve(orderId: string, note: string) {
        if (typeof actionApi.executeAction !== 'function') return;
        if (pending.current) return;
        pending.current = true;
        setApproval({ submitting: true, status: '', error: null });
        try {
            const res = await actionApi.executeAction({
                name: 'new_ApproveOrder',
                parameters: { Comment: note },
                boundTo: { entityName: 'salesorder', id: orderId },
            });
            // The page moved to another record while this ran: the answer is not that record's to show.
            if (orderId !== approvalFor.current) return;
            // Never auto-retry an indeterminate result — the server may have committed it.
            if (res.indeterminate) { setApprovalFailure(reportPageError(PAGE_NAME, 'approveOrder', res.error?.code, res.error?.message, 'indeterminate')); return; }
            if (res.error?.code === 'indeterminate') { setApprovalFailure(reportPageError(PAGE_NAME, 'approveOrder', res.error?.code, res.error?.message, 'indeterminate')); return; }
            // Only a `network` failure is safely retryable: the request never left the client.
            if (!res.ok && res.error?.code === 'network') { setApprovalFailure(reportPageError(PAGE_NAME, 'approveOrder', res.error?.code, res.error?.message, 'network', retryApprove)); return; }
            if (!res.ok) { setApprovalFailure(reportPageError(PAGE_NAME, 'approveOrder', res.error?.code, res.error?.message, 'write')); return; }
            const newStatus = res.outputs?.NewStatus;
            setApproval({ submitting: false, status: typeof newStatus === 'string' ? newStatus : '', error: null });
        } catch (error) {
            if (orderId !== approvalFor.current) return;
            setApprovalFailure(reportPageError(PAGE_NAME, 'approveOrder', undefined, error, 'write'));
        } finally {
            pending.current = false; // never leave the latch stuck
        }
    }

    useEffect(() => {
        // A new record starts a clean approval panel: the previous record's result, and its retry, go. An
        // approval still running for that record keeps the latch until it answers; its answer is ignored.
        approvalFor.current = recordId;
        setApproval({ submitting: false, status: '', error: null });
    }, [recordId]);

    useEffect(() => {
        if (!canReadSummary || !recordId) return;
        void loadSummary(recordId);
        // An answer that arrives after the record changed, or after unmount, is ignored.
        return () => { summaryRequest.current += 1; };
        // The record only — never `dataApi` or the action shape derived from it (a new ref each render). See Rule 15.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canReadSummary, recordId]);

    if (entityName !== 'salesorder' || !recordId) {
        return (
            <div className={styles.root}>
                <Text>Open this page from a sales order form to manage its approval.</Text>
            </div>
        );
    }

    return (
        <div className={styles.root}>
            <Card className={styles.card}>
                <Text as="h2" size={600} weight="semibold">Order summary</Text>
                <PageErrorBar error={summaryState.error} />
                {summaryState.loading ? (
                    <div className={styles.spinnerWrap}>
                        <Spinner labelPosition="below" label="Loading summary…" />
                    </div>
                ) : summaryState.summary ? (
                    <div className={styles.summaryGrid}>
                        <Text className={styles.label}>Total</Text>
                        <Text>{summaryState.summary.Total}</Text>
                        <Text className={styles.label}>Status</Text>
                        <Text>{summaryState.summary.Status}</Text>
                    </div>
                ) : !canReadSummary ? (
                    <Text>Order summary is unavailable on this runtime.</Text>
                ) : null}
            </Card>

            <Card className={styles.card}>
                <Text as="h2" size={600} weight="semibold">Approve order</Text>
                <PageErrorBar error={approval.error} />
                {approval.status && (
                    <MessageBar intent="success">
                        <MessageBarBody>{`Order approved. New status: ${approval.status}.`}</MessageBarBody>
                    </MessageBar>
                )}
                <Field label="Approval note">
                    <Textarea
                        value={reason}
                        onChange={(_e, d) => setReason(d.value)}
                        disabled={!canApprove || approval.submitting}
                        placeholder="Optional note recorded with the approval"
                    />
                </Field>
                <div className={styles.actions}>
                    <Button appearance="primary" onClick={() => void approve(recordId, reason)} disabled={!canApprove || approval.submitting}>
                        {approval.submitting ? 'Approving…' : 'Approve order'}
                    </Button>
                    {!canApprove && <Text>Approval isn't available on this runtime.</Text>}
                </div>
            </Card>
        </div>
    );
}

const GeneratedComponent = (props: GeneratedComponentProps) => (
    <PageErrorBoundary>
        <PageBody {...props} />
    </PageErrorBoundary>
);

export default GeneratedComponent;
