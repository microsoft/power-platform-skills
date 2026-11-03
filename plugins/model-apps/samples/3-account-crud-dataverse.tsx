import React, { useEffect, useState } from "react";
import {
    Button,
    Input,
    Text,
    DataGrid,
    DataGridHeader,
    DataGridBody,
    DataGridRow,
    DataGridCell,
    DataGridHeaderCell,
    TableCellLayout,
    createTableColumn,
    MessageBar,
    MessageBarBody,
} from "@fluentui/react-components";
import type {
    GeneratedComponentProps,
    account,
    ReadableTableRow,
    WritableTableRow,
    QueryTableOptions,
} from "./RuntimeTypes";

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
const PAGE_NAME = 'Accounts';

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

// Module-level key aliases — VALUES live on `window` (single source of truth) so
// they survive the host double-mount on open and back-navigation, and stay
// coherent across module re-evaluation. See references/data-caching.md.
const CACHE_KEY = "__ppAccountCrud_accountCache";
const INFLIGHT_KEY = "__ppAccountCrud_accountInflight";
const winAny = window as unknown as Record<string, unknown>;

function PageBody(props: GeneratedComponentProps) {
    const { dataApi, pageInput } = props;
    void pageInput; // the list takes no input; destructure it anyway, per the rules
    const dataReady = !!dataApi;
    // Single batched fetch state (Rule 14 — React 17 doesn't batch setState in
    // async callbacks, so one object + one setData avoids intermediate renders).
    // `loading` also gates mutations until the initial load resolves, so a
    // create/update can't race an in-flight first fetch (stale-write the cache).
    // `error` is the list's own PageErrorView (Rule 22), never a string.
    const [{ accounts, loading, error }, setData] = useState<{ accounts: ReadableTableRow<account>[]; loading: boolean; error: PageErrorView | null }>(
        () => {
            const cached = winAny[CACHE_KEY] as ReadableTableRow<account>[] | undefined;
            return { accounts: cached ?? [], loading: cached === undefined, error: null };
        },
    );
    // The save keeps its own pending flag and error view, so loading the list never
    // clears a failed save, and a save never clears a failed load.
    const [save, setSave] = useState<{ saving: boolean; error: PageErrorView | null }>({ saving: false, error: null });
    const [selectedAccount, setSelectedAccount] = useState<ReadableTableRow<account> | null>(null);
    const [formData, setFormData] = useState<WritableTableRow<account>>({
        name: "",
        address1_city: "",
        address1_stateorprovince: "",
        address1_postalcode: "",
        address1_country: "",
        telephone1: "",
    });

    // Fetch accounts from Dataverse (de-duped against the host double-mount)
    useEffect(() => {
        if (!dataReady) return;

        // Authoritative window cache — sync on a hit so a mount that renders while
        // another mount's fetch is resolving doesn't stay stuck on the old list.
        const cached = winAny[CACHE_KEY] as ReadableTableRow<account>[] | undefined;
        if (cached !== undefined) {
            if (accounts !== cached || loading) setData({ accounts: cached, loading: false, error: null });
            return;
        }
        let cancelled = false;

        let inflight = winAny[INFLIGHT_KEY] as Promise<ReadableTableRow<account>[]> | undefined;
        if (!inflight) {
            const query: QueryTableOptions<account> = {
                select: ["name", "address1_city", "address1_stateorprovince", "address1_postalcode", "address1_country", "telephone1", "accountid"],
                pageSize: 50,
                orderBy: "name asc",
            };
            inflight = dataApi
                .queryTable("account", query)
                .then((result) => {
                    winAny[CACHE_KEY] = result.rows;
                    return result.rows;
                })
                // Clear only if still ours — a concurrent refresh may have replaced it.
                .finally(() => { if (winAny[INFLIGHT_KEY] === inflight) delete winAny[INFLIGHT_KEY]; });
            winAny[INFLIGHT_KEY] = inflight;
        }

        inflight
            .then((rows) => { if (!cancelled) setData({ accounts: rows, loading: false, error: null }); })
            // Reported once (bounded code and message, never the thrown value) and never cached.
            .catch((failure) => { if (!cancelled) setData({ accounts: [], loading: false, error: reportPageError(PAGE_NAME, "loadAccounts", undefined, failure, "read") }); });

        return () => { cancelled = true; };
        // Readiness only — never `dataApi` (new ref each render). See Rule 15.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady]);

    const handleInputChange = (field: keyof WritableTableRow<account>, value: string) => {
        setFormData((prev) => ({ ...prev, [field]: value }));
    };

    const handleAddOrUpdate = async () => {
        if (loading || save.saving) return;   // don't mutate while the initial load is still in flight, or twice
        setSave({ saving: true, error: null });
        try {
            if (selectedAccount) {
                await dataApi.updateRow("account", selectedAccount.accountid, formData);
            } else {
                await dataApi.createRow("account", formData);
            }
        } catch (failure) {
            // The form keeps what was typed. A failed write is reported once and never retried:
            // the save may or may not have reached the server.
            setSave({ saving: false, error: reportPageError(PAGE_NAME, "saveAccount", undefined, failure, "write") });
            return;
        }
        setSave({ saving: false, error: null });
        // Refresh list — evict the stale cache and publish the refetch as the
        // shared in-flight promise, so a mount that happens WHILE this refresh is
        // pending awaits THIS query instead of returning the stale cache. Mirrors
        // the initial-fetch de-dupe (references/data-caching.md invalidation).
        const query: QueryTableOptions<account> = {
            select: ["name", "address1_city", "address1_stateorprovince", "address1_postalcode", "address1_country", "telephone1", "accountid"],
            pageSize: 50,
            orderBy: "name asc",
        };
        delete winAny[CACHE_KEY];
        const refetch = dataApi
            .queryTable("account", query)
            .then((result) => { winAny[CACHE_KEY] = result.rows; return result.rows; })
            .finally(() => { if (winAny[INFLIGHT_KEY] === refetch) delete winAny[INFLIGHT_KEY]; });
        winAny[INFLIGHT_KEY] = refetch;
        refetch
            .then((rows) => {
                setData({ accounts: rows, loading: false, error: null });
                // Reset form
                setFormData({
                    name: "",
                    address1_city: "",
                    address1_stateorprovince: "",
                    address1_postalcode: "",
                    address1_country: "",
                    telephone1: "",
                });
                setSelectedAccount(null);
            })
            .catch((failure) => { setData({ accounts: [], loading: false, error: reportPageError(PAGE_NAME, "loadAccounts", undefined, failure, "read") }); });
    };

    const handleRowSelect = (account: ReadableTableRow<account>) => {
        setSelectedAccount(account);
        setFormData({
            name: account.name || "",
            address1_city: account.address1_city || "",
            address1_stateorprovince: account.address1_stateorprovince || "",
            address1_postalcode: account.address1_postalcode || "",
            address1_country: account.address1_country || "",
            telephone1: account.telephone1 || "",
        });
    };

    const columns = [
        createTableColumn<ReadableTableRow<account>>({
            columnId: "name",
            renderHeaderCell: () => "Account Name",
            renderCell: (item) => <TableCellLayout>{item.name}</TableCellLayout>,
        }),
        createTableColumn<ReadableTableRow<account>>({
            columnId: "address1_city",
            renderHeaderCell: () => "City",
            renderCell: (item) => <TableCellLayout>{item.address1_city}</TableCellLayout>,
        }),
        createTableColumn<ReadableTableRow<account>>({
            columnId: "address1_stateorprovince",
            renderHeaderCell: () => "State",
            renderCell: (item) => <TableCellLayout>{item.address1_stateorprovince}</TableCellLayout>,
        }),
        createTableColumn<ReadableTableRow<account>>({
            columnId: "address1_postalcode",
            renderHeaderCell: () => "Zip",
            renderCell: (item) => <TableCellLayout>{item.address1_postalcode}</TableCellLayout>,
        }),
        createTableColumn<ReadableTableRow<account>>({
            columnId: "address1_country",
            renderHeaderCell: () => "Country",
            renderCell: (item) => <TableCellLayout>{item.address1_country}</TableCellLayout>,
        }),
        createTableColumn<ReadableTableRow<account>>({
            columnId: "telephone1",
            renderHeaderCell: () => "Phone",
            renderCell: (item) => <TableCellLayout>{item.telephone1}</TableCellLayout>,
        }),
    ];

    return (
        <div style={{ width: "100%", margin: "0 auto", minHeight: "100%", display: "flex", flexDirection: "column", boxSizing: "border-box", padding: "10px" }}>
            {/* Header */}
            <header style={{ padding: "10px", textAlign: "center" }}>
                <Text as="h1" size={800} weight="semibold">
                    Accounts List
                </Text>
            </header>

            {/* Content */}
            <div
                style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "row",
                    alignItems: "flex-start",
                    gap: "20px",
                    padding: "10px",
                    flexWrap: "wrap",
                }}
            >
                {/* Form */}
                <section style={{ flex: "1 1 300px", minWidth: "280px", display: "flex", flexDirection: "column", gap: "8px" }} aria-label="Account form section">
                    <Text as="h2" size={500} block weight="semibold">
                        Account Form
                    </Text>
                    <PageErrorBar error={save.error} />
                    <Input aria-label="Account Name" placeholder="Enter account name" value={formData.name || ""} onChange={(e, data) => handleInputChange("name", data.value)} />
                    <Input aria-label="City" placeholder="Enter city" value={formData.address1_city || ""} onChange={(e, data) => handleInputChange("address1_city", data.value)} />
                    <Input aria-label="State" placeholder="Enter state" value={formData.address1_stateorprovince || ""} onChange={(e, data) => handleInputChange("address1_stateorprovince", data.value)} />
                    <Input aria-label="Zip" placeholder="Enter zip code" value={formData.address1_postalcode || ""} onChange={(e, data) => handleInputChange("address1_postalcode", data.value)} />
                    <Input aria-label="Country" placeholder="Enter country" value={formData.address1_country || ""} onChange={(e, data) => handleInputChange("address1_country", data.value)} />
                    <Input aria-label="Phone" placeholder="Enter phone number" value={formData.telephone1 || ""} onChange={(e, data) => handleInputChange("telephone1", data.value)} />
                    <Button style={{ width: "100%", marginTop: "12px" }} appearance="primary" onClick={handleAddOrUpdate} disabled={loading || save.saving}>
                        {selectedAccount ? "Update Account" : "Add Account"}
                    </Button>
                </section>

                {/* Grid */}
                <section style={{ flex: "2 1 400px", minWidth: "300px", display: "flex", flexDirection: "column" }} aria-label="Accounts data grid section">
                    <PageErrorBar error={error} />
                    <div style={{ flex: 1, minHeight: 0 }}>
                        <DataGrid
                            items={accounts}
                            columns={columns}
                            selectionMode="single"
                            aria-label="Accounts data grid"
                            style={{ height: "100%" }}
                            onRowClick={(e, data) => handleRowSelect(data.item)}
                        >
                            <DataGridHeader>
                                <DataGridRow>
                                    {({ renderHeaderCell }) => (
                                        <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
                                    )}
                                </DataGridRow>
                            </DataGridHeader>
                            <DataGridBody<ReadableTableRow<account>>>
                                {({ item }) => (
                                    <DataGridRow key={item.accountid}>
                                        {({ renderCell }) => (
                                            <DataGridCell>{renderCell(item)}</DataGridCell>
                                        )}
                                    </DataGridRow>
                                )}
                            </DataGridBody>
                        </DataGrid>
                    </div>
                </section>
            </div>
        </div>
    );
}

const GeneratedComponent = (props: GeneratedComponentProps) => (
    <PageErrorBoundary>
        <PageBody {...props} />
    </PageErrorBoundary>
);

export default GeneratedComponent;
