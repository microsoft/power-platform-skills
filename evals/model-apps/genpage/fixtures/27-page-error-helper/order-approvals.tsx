import * as React from 'react';
import {
  Button,
  DataGrid,
  DataGridBody,
  DataGridCell,
  DataGridHeader,
  DataGridHeaderCell,
  DataGridRow,
  Field,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Spinner,
  TableCellLayout,
  Text,
  Textarea,
  createTableColumn,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CheckmarkRegular } from '@fluentui/react-icons';
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
const PAGE_NAME = 'Order Approvals';

// The error copy of an English-only page (references/rules.md, "Missing Error Handling").
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

type OrderRow = {
  salesorderid: string;
  name?: string;
  totalamount?: number;
  statuscode?: number;
  'statuscode@OData.Community.Display.V1.FormattedValue'?: string;
};
type ActionResult = { ok: boolean; indeterminate?: boolean; outputs?: Record<string, unknown>; error?: { message: string; code?: string } };
type ActionApi = {
  executeAction?: (request: { name: string; parameters?: Record<string, unknown>; boundTo?: { entityName: string; id: string } }) => Promise<ActionResult>;
};

// Page-scoped window keys (unique per page + query), so the host's double mount shares one read (references/data-caching.md).
const winAny = window as any;
const CACHE_KEY = '__ppOrderApprovals_salesorderCache';
const INFLIGHT_KEY = '__ppOrderApprovals_salesorderInflight';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalXL,
    boxSizing: 'border-box',
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalM,
  },
});

function PageBody(props: GeneratedComponentProps) {
  const { dataApi, pageInput } = props;
  void pageInput;
  const styles = useStyles();
  const actionApi = dataApi as unknown as ActionApi;
  const dataReady = !!dataApi;
  const [reloadKey, setReloadKey] = React.useState(0);
  const [{ orders, loading, error }, setData] = React.useState<{ orders: OrderRow[]; loading: boolean; error: PageErrorView | null }>(() => {
    const cached = winAny[CACHE_KEY] as OrderRow[] | undefined;
    return { orders: cached ?? [], loading: cached === undefined, error: null };
  });
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<{ order: OrderRow | null; loading: boolean; error: PageErrorView | null }>({ order: null, loading: false, error: null });
  const detailRequest = React.useRef(0);
  const [note, setNote] = React.useState('');
  const [approval, setApproval] = React.useState<{ submitting: boolean; status: string; error: PageErrorView | null }>({ submitting: false, status: '', error: null });
  const pending = React.useRef(false);
  // The order the approval panel belongs to: its result and its retry are shown only for that order.
  const approvalFor = React.useRef<string | null>(null);

  function retryLoad() {
    delete winAny[CACHE_KEY];
    delete winAny[INFLIGHT_KEY];
    setData({ orders: [], loading: true, error: null });
    setReloadKey((key) => key + 1);
  }

  React.useEffect(() => {
    if (!dataReady) return;
    const cached = winAny[CACHE_KEY] as OrderRow[] | undefined;
    if (cached !== undefined) {
      if (orders !== cached) setData({ orders: cached, loading: false, error: null });
      return;
    }
    let cancelled = false;
    let inflight = winAny[INFLIGHT_KEY] as Promise<OrderRow[]> | undefined;
    if (!inflight) {
      inflight = dataApi
        .queryTable('salesorder', { select: ['salesorderid', 'name', 'totalamount', 'statuscode'], orderBy: 'name asc', pageSize: 50 })
        .then((result: { rows: OrderRow[] }) => {
          winAny[CACHE_KEY] = result.rows;
          return result.rows;
        })
        .finally(() => { if (winAny[INFLIGHT_KEY] === inflight) delete winAny[INFLIGHT_KEY]; });
      winAny[INFLIGHT_KEY] = inflight;
    }
    inflight
      .then((rows) => { if (!cancelled) setData({ orders: rows, loading: false, error: null }); })
      .catch((failure) => { if (!cancelled) setData({ orders: [], loading: false, error: reportPageError(PAGE_NAME, 'loadOrders', undefined, failure, 'read', retryLoad) }); });
    return () => { cancelled = true; };
    // Readiness and the reload key only — never dataApi (a new reference on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataReady, reloadKey]);

  function retryDetail() {
    if (selectedId) void loadOrder(selectedId);
  }

  async function loadOrder(orderId: string) {
    const requestId = ++detailRequest.current;
    setSelectedId(orderId);
    if (orderId !== approvalFor.current) {
      // Another order starts a clean approval panel: the previous order's result, and its retry, are cleared.
      approvalFor.current = orderId;
      setApproval({ submitting: false, status: '', error: null });
      setNote('');
    }
    setDetail({ order: null, loading: true, error: null });
    try {
      const order = await dataApi.retrieveRow('salesorder', { id: orderId, select: ['salesorderid', 'name', 'totalamount', 'statuscode'] });
      if (requestId !== detailRequest.current) return;
      setDetail({ order: order as OrderRow, loading: false, error: null });
    } catch (failure) {
      if (requestId !== detailRequest.current) return;
      setDetail({ order: null, loading: false, error: reportPageError(PAGE_NAME, 'loadOrder', undefined, failure, 'read', retryDetail) });
    }
  }

  function setApprovalFailure(view: PageErrorView) {
    setApproval({ submitting: false, status: '', error: view });
  }

  function retryApprove() {
    // Re-sends the approval of the order on screen, and only while it is still the one the panel shows.
    if (selectedId && selectedId === approvalFor.current) void approveOrder(selectedId, note);
  }

  async function approveOrder(orderId: string, comment: string) {
    if (typeof actionApi.executeAction !== 'function') return;
    if (pending.current || !orderId) return;
    pending.current = true;
    setApproval({ submitting: true, status: '', error: null });
    try {
      const res = await actionApi.executeAction({
        name: 'cnt_ApproveOrder',
        parameters: { Comment: comment },
        boundTo: { entityName: 'salesorder', id: orderId },
      });
      if (orderId !== approvalFor.current) return; // another order is on screen: not its answer
      if (res.indeterminate) { setApprovalFailure(reportPageError(PAGE_NAME, 'approveOrder', res.error?.code, res.error?.message, 'indeterminate')); return; }
      if (res.error?.code === 'indeterminate') { setApprovalFailure(reportPageError(PAGE_NAME, 'approveOrder', res.error?.code, res.error?.message, 'indeterminate')); return; }
      if (!res.ok && res.error?.code === 'network') { setApprovalFailure(reportPageError(PAGE_NAME, 'approveOrder', res.error?.code, res.error?.message, 'network', retryApprove)); return; }
      if (!res.ok) { setApprovalFailure(reportPageError(PAGE_NAME, 'approveOrder', res.error?.code, res.error?.message, 'write')); return; }
      const newStatus = res.outputs?.NewStatus;
      setApproval({ submitting: false, status: typeof newStatus === 'string' ? newStatus : '', error: null });
    } catch (failure) {
      if (orderId !== approvalFor.current) return;
      setApprovalFailure(reportPageError(PAGE_NAME, 'approveOrder', undefined, failure, 'write'));
    } finally {
      pending.current = false;
    }
  }

  const columns = [
    createTableColumn<OrderRow>({
      columnId: 'name',
      renderHeaderCell: () => 'Order',
      renderCell: (item) => <TableCellLayout>{item.name ?? '—'}</TableCellLayout>,
    }),
    createTableColumn<OrderRow>({
      columnId: 'totalamount',
      renderHeaderCell: () => 'Total',
      renderCell: (item) => <TableCellLayout>{item.totalamount ?? '—'}</TableCellLayout>,
    }),
    createTableColumn<OrderRow>({
      columnId: 'statuscode',
      renderHeaderCell: () => 'Status',
      renderCell: (item) => <TableCellLayout>{item['statuscode@OData.Community.Display.V1.FormattedValue'] ?? '—'}</TableCellLayout>,
    }),
  ];

  return (
    <div className={styles.root}>
      <Text as="h1" size={700} weight="semibold">Order Approvals</Text>
      <PageErrorBar error={error} />
      {loading ? <Spinner label="Loading orders" /> : (
        <DataGrid
          items={orders}
          columns={columns}
          getRowId={(row) => row.salesorderid}
          resizableColumns
          columnSizingOptions={{
            name: { defaultWidth: 240, minWidth: 160 },
            totalamount: { defaultWidth: 140, minWidth: 100 },
            statuscode: { defaultWidth: 160, minWidth: 120 },
          }}
          aria-label="Sales orders"
        >
          <DataGridHeader>
            <DataGridRow>
              {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
            </DataGridRow>
          </DataGridHeader>
          <DataGridBody<OrderRow>>
            {({ item }) => (
              <DataGridRow<OrderRow> key={item.salesorderid}>
                {({ renderCell, columnId }) => (columnId === 'name' ? (
                  <DataGridCell>
                    <Button appearance="transparent" disabled={approval.submitting} onClick={() => void loadOrder(item.salesorderid)}>{item.name ?? '—'}</Button>
                  </DataGridCell>
                ) : (
                  <DataGridCell>{renderCell(item)}</DataGridCell>
                ))}
              </DataGridRow>
            )}
          </DataGridBody>
        </DataGrid>
      )}
      <section className={styles.panel} aria-label="Selected order">
        <PageErrorBar error={detail.error} />
        <PageErrorBar error={approval.error} />
        {detail.loading && <Spinner label="Loading the order" />}
        {detail.order && (
          <>
            <Text weight="semibold">{detail.order.name}</Text>
            <Text>{detail.order['statuscode@OData.Community.Display.V1.FormattedValue'] ?? ''}</Text>
            <Field label="Approval note">
              <Textarea value={note} onChange={(_, data) => setNote(data.value)} />
            </Field>
            {approval.status && (
              <MessageBar intent="success">
                <MessageBarBody>{`Approved. New status: ${approval.status}.`}</MessageBarBody>
              </MessageBar>
            )}
            <Button
              appearance="primary"
              icon={<CheckmarkRegular />}
              disabled={approval.submitting}
              onClick={() => void approveOrder(detail.order?.salesorderid ?? '', note)}
            >
              Approve order
            </Button>
          </>
        )}
      </section>
    </div>
  );
}

const GeneratedComponent = (props: GeneratedComponentProps) => (
  <PageErrorBoundary>
    <PageBody {...props} />
  </PageErrorBoundary>
);

export default GeneratedComponent;
