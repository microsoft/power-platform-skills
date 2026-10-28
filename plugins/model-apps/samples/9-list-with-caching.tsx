import React, { useEffect, useState } from 'react';
import type {
    TableRow,
    ReadableTableRow,
    GeneratedComponentProps,
} from './RuntimeTypes';
import {
    makeStyles,
    tokens,
    Text,
    Spinner,
    Button,
    DataGrid,
    DataGridHeader,
    DataGridHeaderCell,
    DataGridBody,
    DataGridRow,
    DataGridCell,
    TableCellLayout,
    createTableColumn,
    SearchBox,
    MessageBar,
    MessageBarBody,
    MessageBarActions,
} from '@fluentui/react-components';
import { SearchRegular } from '@fluentui/react-icons';

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
const PAGE_NAME = 'Contacts';

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

// Sample: list page with data fetching (Rule 15).
// Demonstrates:
//   - Rule 14: SINGLE batched setData({records, loading, error}) — no separate setState
//   - Rule 15: window cache + in-flight-promise de-dupe + readiness-only deps
//     (survives the host double-mount on open — one fetch, no spinner re-flash)
//   - dataApi is NEVER in the dep array (new ref each render — would re-fire)
//   - Cross-page navigation via Xrm.Navigation.navigateTo to a sibling generative page
//   - PAGEREF_ placeholder for the detail page (multi-page-build pattern)
//   - DataGrid with createTableColumn + columnSizingOptions
//   - Rule 22: a failed load goes through reportPageError, is never cached, and
//     PageErrorBar shows it with a manual "Try again"; the page renders inside PageErrorBoundary

type ContactRow = TableRow<{
    readonly contactid: string;
    fullname?: string;
    emailaddress1?: string;
    telephone1?: string;
    jobtitle?: string;
}>;

type ReadableContact = ReadableTableRow<ContactRow>;

// ---------- Module-level cache + in-flight de-dupe ----------
// The VALUES live on `window` (the single source of truth) so they survive module
// re-evaluation on back-navigation AND the host's double-mount on open (a second
// mount ~300ms later re-runs the effect). CACHE_KEY holds resolved rows;
// INFLIGHT_KEY holds the pending promise so a racing second mount shares one
// round-trip. Read `window` in the effect — never a module-local snapshot, which
// a re-eval can leave stale. See references/data-caching.md.
const CACHE_KEY = '__ppContactList_contactCache';
const INFLIGHT_KEY = '__ppContactList_contactInflight';
const winAny = window as unknown as Record<string, unknown>;

// ---------- Styles ----------

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
        padding: tokens.spacingHorizontalXL,
        width: '100%',
        boxSizing: 'border-box',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens.spacingHorizontalM,
    },
    spinnerWrap: {
        display: 'flex',
        justifyContent: 'center',
        padding: tokens.spacingVerticalXXL,
    },
});

// ---------- Component ----------

function PageBody(props: GeneratedComponentProps) {
    const { dataApi, pageInput } = props;
    void pageInput; // list page doesn't take input; destructure anyway per rules
    const styles = useStyles();

    // `error` is the view reportPageError returns, rendered by PageErrorBar — never a string.
    const [data, setData] = useState<{ records: ReadableContact[]; loading: boolean; error: PageErrorView | null }>(
        () => {
            const cached = winAny[CACHE_KEY] as ReadableContact[] | undefined;
            return { records: cached ?? [], loading: cached === undefined, error: null };
        },
    );
    const [search, setSearch] = useState('');
    const [reloadKey, setReloadKey] = useState(0);

    const dataReady = !!dataApi;

    // "Try again" after a failed load: drop the failed in-flight entry and run the effect again.
    function retryLoad() {
        delete winAny[CACHE_KEY];
        delete winAny[INFLIGHT_KEY];
        setData({ records: [], loading: true, error: null });
        setReloadKey((key) => key + 1);
    }

    useEffect(() => {
        if (!dataReady) return;      // wait until the host hands us the DataAPI

        // Read the authoritative window cache — the other mount may have resolved
        // it between this render and this effect. Sync state on a hit so we never
        // stick on the spinner (reference compare avoids a redundant render).
        const cached = winAny[CACHE_KEY] as ReadableContact[] | undefined;
        if (cached !== undefined) {
            if (data.records !== cached) setData({ records: cached, loading: false, error: null });
            return;
        }
        let cancelled = false;

        // De-dupe the host double-mount: reuse an in-flight fetch if one exists,
        // else start one and publish its promise on window so a racing second
        // mount awaits it instead of firing a duplicate query.
        let inflight = winAny[INFLIGHT_KEY] as Promise<ReadableContact[]> | undefined;
        if (!inflight) {
            inflight = dataApi
                .queryTable('contact', {
                    select: ['contactid', 'fullname', 'emailaddress1', 'telephone1', 'jobtitle'],
                    orderBy: 'fullname asc',
                    pageSize: 100,
                })
                .then((result) => {
                    winAny[CACHE_KEY] = result.rows;
                    return result.rows as ReadableContact[];
                })
                // Clear only if still ours — a concurrent refresh may have replaced it.
                .finally(() => { if (winAny[INFLIGHT_KEY] === inflight) delete winAny[INFLIGHT_KEY]; });
            winAny[INFLIGHT_KEY] = inflight;
        }

        inflight
            .then((rows) => { if (!cancelled) setData({ records: rows, loading: false, error: null }); })
            .catch((failure) => {
                if (cancelled) return;
                // Reported once — bounded code and message, never the thrown value — and shown with a retry.
                // A rejection is never written to the cache, so "Try again" reads again.
                setData({ records: [], loading: false, error: reportPageError(PAGE_NAME, 'loadContacts', undefined, failure, 'read', retryLoad) });
            });

        return () => { cancelled = true; };
        // Depend on readiness only — never `dataApi` (new ref each render would
        // re-fire this effect on every render). See Rule 15.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady, reloadKey]);

    const filtered = data.records.filter((c) => {
        if (!search) return true;
        const term = search.toLowerCase();
        return (
            (c.fullname?.toLowerCase().includes(term) ?? false) ||
            (c.emailaddress1?.toLowerCase().includes(term) ?? false) ||
            (c.jobtitle?.toLowerCase().includes(term) ?? false)
        );
    });

    const columns = [
        createTableColumn<ReadableContact>({
            columnId: 'fullname',
            renderHeaderCell: () => 'Name',
            renderCell: (item) => <TableCellLayout>{item.fullname ?? '—'}</TableCellLayout>,
        }),
        createTableColumn<ReadableContact>({
            columnId: 'jobtitle',
            renderHeaderCell: () => 'Title',
            renderCell: (item) => <TableCellLayout>{item.jobtitle ?? '—'}</TableCellLayout>,
        }),
        createTableColumn<ReadableContact>({
            columnId: 'email',
            renderHeaderCell: () => 'Email',
            renderCell: (item) => <TableCellLayout>{item.emailaddress1 ?? '—'}</TableCellLayout>,
        }),
        createTableColumn<ReadableContact>({
            columnId: 'phone',
            renderHeaderCell: () => 'Phone',
            renderCell: (item) => <TableCellLayout>{item.telephone1 ?? '—'}</TableCellLayout>,
        }),
    ];

    const openDetail = (contactId: string) => {
        const xrm = (window as unknown as { Xrm?: { Navigation?: { navigateTo: (opts: unknown) => unknown } } }).Xrm;
        // Navigate to the sibling detail page. In a multi-page build the
        // pageId starts as a "PAGEREF_<filename>" placeholder; the skill's
        // Phase 6.5 fix-up substitutes the real GUID after first upload.
        // Custom IDs go in `data`, NOT `recordId` — `recordId` is reserved
        // for OOB record context and may not arrive reliably.
        xrm?.Navigation?.navigateTo({
            pageType: 'generative',
            pageId: "PAGEREF_10-detail-with-pageinput",
            entityName: 'contact',
            recordId: contactId,
        });
    };

    if (data.loading) {
        return (
            <div className={styles.root}>
                <div className={styles.spinnerWrap}>
                    <Spinner labelPosition="below" label="Loading contacts…" />
                </div>
            </div>
        );
    }

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <Text as="h1" size={700} weight="semibold">
                    Contacts
                </Text>
                <SearchBox
                    placeholder="Search by name, email, title"
                    value={search}
                    onChange={(_, d) => setSearch(d.value ?? '')}
                    contentBefore={<SearchRegular />}
                    aria-label="Search contacts"
                />
            </header>

            <PageErrorBar error={data.error} />

            <DataGrid
                items={filtered}
                columns={columns}
                getRowId={(row) => row.contactid}
                resizableColumns
                columnSizingOptions={{
                    fullname: { idealWidth: 220, minWidth: 160 },
                    jobtitle: { idealWidth: 200, minWidth: 140 },
                    email: { idealWidth: 240, minWidth: 180 },
                    phone: { idealWidth: 160, minWidth: 120 },
                }}
                aria-label="Contacts list"
            >
                <DataGridHeader>
                    <DataGridRow>
                        {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
                    </DataGridRow>
                </DataGridHeader>
                <DataGridBody<ReadableContact>>
                    {({ item }) => (
                        <DataGridRow<ReadableContact> key={item.contactid}>
                            {({ renderCell, columnId }) =>
                                columnId === 'fullname' ? (
                                    <DataGridCell>
                                        <Button appearance="transparent" onClick={() => openDetail(item.contactid)}>
                                            {item.fullname ?? '—'}
                                        </Button>
                                    </DataGridCell>
                                ) : (
                                    <DataGridCell>{renderCell(item)}</DataGridCell>
                                )
                            }
                        </DataGridRow>
                    )}
                </DataGridBody>
            </DataGrid>
        </div>
    );
}

const GeneratedComponent = (props: GeneratedComponentProps) => (
    <PageErrorBoundary>
        <PageBody {...props} />
    </PageErrorBoundary>
);

export default GeneratedComponent;
