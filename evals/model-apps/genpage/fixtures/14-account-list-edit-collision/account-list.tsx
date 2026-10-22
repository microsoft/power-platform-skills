import { useEffect, useMemo, useState } from 'react';
import type {
    GeneratedComponentProps,
    account,
    ReadableTableRow,
    QueryTableOptions,
} from './RuntimeTypes';
import {
    makeStyles,
    tokens,
    Text,
    Spinner,
    Button,
    SearchBox,
    MessageBar,
    MessageBarBody,
    DataGrid,
    DataGridHeader,
    DataGridHeaderCell,
    DataGridBody,
    DataGridRow,
    DataGridCell,
    TableCellLayout,
    createTableColumn,
} from '@fluentui/react-components';
import type { TableColumnSizingOptions } from '@fluentui/react-components';
import { ArrowClockwiseRegular, EditRegular, SearchRegular } from '@fluentui/react-icons';

type AccountRow = ReadableTableRow<account>;
type LoadedAccounts = { rows: AccountRow[]; truncated: boolean };
type LoadState = LoadedAccounts & { loading: boolean; error: string | null };
type XrmNavigation = { Navigation?: { navigateTo?: (input: Record<string, unknown>) => Promise<unknown> } };

// Window-scoped list cache + in-flight promise (references/data-caching.md, Pattern 1). The Edit
// Account page evicts these two keys after a successful save so this list refetches on return.
const CACHE_KEY = '__ppAccountList_accountCache';
const INFLIGHT_KEY = '__ppAccountList_accountInflight';
const winAny = window as unknown as Record<string, unknown>;

const PAGE_SIZE = 250;
// "All accounts" is read page by page through loadMoreRows; the cap keeps a very large table from
// holding thousands of rows in window memory, and the footer says when it was reached.
const MAX_ROWS = 5000;

const LIST_QUERY: QueryTableOptions<account> = {
    select: ['accountid', 'name', 'accountnumber', 'address1_city', 'telephone1', 'emailaddress1'],
    orderBy: 'name asc',
    pageSize: PAGE_SIZE,
};

const useStyles = makeStyles({
    root: {
        position: 'relative',
        contain: 'layout',
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
        height: '100%',
        width: '100%',
        boxSizing: 'border-box',
        padding: tokens.spacingHorizontalXL,
        overflow: 'hidden',
        color: tokens.colorNeutralForeground1,
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalM,
    },
    headerActions: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        flexGrow: 1,
        justifyContent: 'flex-end',
        '@media (max-width: 640px)': {
            justifyContent: 'stretch',
        },
    },
    search: {
        minWidth: '220px',
        maxWidth: '360px',
        flexGrow: 1,
    },
    gridArea: {
        flexGrow: 1,
        minHeight: 0,
        overflow: 'auto',
    },
    truncate: {
        display: 'block',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    cellLayout: {
        minWidth: 0,
        overflow: 'hidden',
    },
    centered: {
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: tokens.spacingVerticalXXL,
        color: tokens.colorNeutralForeground2,
    },
    footer: {
        color: tokens.colorNeutralForeground2,
    },
});

function textOf(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function compareText(a: string, b: string): number {
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function matchesSearch(row: AccountRow, term: string): boolean {
    if (!term) return true;
    return [row.name, row.accountnumber, row.address1_city, row.emailaddress1, row.telephone1]
        .map(textOf)
        .some((value) => value.toLowerCase().includes(term));
}

function readCache(): LoadedAccounts | undefined {
    return winAny[CACHE_KEY] as LoadedAccounts | undefined;
}

function openEditPage(accountId: string) {
    const xrm = (window as unknown as { Xrm?: XrmNavigation }).Xrm;
    // The sibling Edit Account page receives the id in `data` (never recordId) and reads it as
    // pageInput.data.accountId. Phase 6.5 replaces the placeholder with the deployed page id.
    void xrm?.Navigation?.navigateTo?.({
        pageType: "generative",
        pageId: "14141414-1414-4414-8414-141414141402",
        data: { accountId },
    });
}

function TextCell(props: { value: string; className: string; layoutClassName: string }) {
    return (
        <TableCellLayout className={props.layoutClassName}>
            <span className={props.className} title={props.value}>
                {props.value || '—'}
            </span>
        </TableCellLayout>
    );
}

const COLUMN_SIZING: TableColumnSizingOptions = {
    name: { defaultWidth: 260, minWidth: 180 },
    accountnumber: { defaultWidth: 140, minWidth: 110 },
    city: { defaultWidth: 160, minWidth: 120 },
    phone: { defaultWidth: 160, minWidth: 120 },
    email: { defaultWidth: 240, minWidth: 160 },
    actions: { defaultWidth: 100, minWidth: 90 },
};

function buildColumns(truncate: string, cellLayout: string) {
    return [
        createTableColumn<AccountRow>({
            columnId: 'name',
            compare: (a, b) => compareText(textOf(a.name), textOf(b.name)),
            renderHeaderCell: () => 'Account name',
            renderCell: (item) => <TextCell value={textOf(item.name)} className={truncate} layoutClassName={cellLayout} />,
        }),
        createTableColumn<AccountRow>({
            columnId: 'accountnumber',
            compare: (a, b) => compareText(textOf(a.accountnumber), textOf(b.accountnumber)),
            renderHeaderCell: () => 'Account number',
            renderCell: (item) => <TextCell value={textOf(item.accountnumber)} className={truncate} layoutClassName={cellLayout} />,
        }),
        createTableColumn<AccountRow>({
            columnId: 'city',
            compare: (a, b) => compareText(textOf(a.address1_city), textOf(b.address1_city)),
            renderHeaderCell: () => 'City',
            renderCell: (item) => <TextCell value={textOf(item.address1_city)} className={truncate} layoutClassName={cellLayout} />,
        }),
        createTableColumn<AccountRow>({
            columnId: 'phone',
            compare: (a, b) => compareText(textOf(a.telephone1), textOf(b.telephone1)),
            renderHeaderCell: () => 'Main phone',
            renderCell: (item) => <TextCell value={textOf(item.telephone1)} className={truncate} layoutClassName={cellLayout} />,
        }),
        createTableColumn<AccountRow>({
            columnId: 'email',
            compare: (a, b) => compareText(textOf(a.emailaddress1), textOf(b.emailaddress1)),
            renderHeaderCell: () => 'Email',
            renderCell: (item) => <TextCell value={textOf(item.emailaddress1)} className={truncate} layoutClassName={cellLayout} />,
        }),
        createTableColumn<AccountRow>({
            columnId: 'actions',
            renderHeaderCell: () => 'Actions',
            renderCell: (item) => (
                <TableCellLayout>
                    <Button
                        appearance="subtle"
                        size="small"
                        icon={<EditRegular />}
                        onClick={() => openEditPage(item.accountid)}
                        aria-label={`Edit ${textOf(item.name) || 'account'}`}
                    >
                        Edit
                    </Button>
                </TableCellLayout>
            ),
        }),
    ];
}

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // the list page takes no input; destructured per the component contract
    const styles = useStyles();
    const dataReady = !!dataApi;

    const [{ rows, truncated, loading, error }, setData] = useState<LoadState>(() => {
        const cached = readCache();
        return cached
            ? { rows: cached.rows, truncated: cached.truncated, loading: false, error: null }
            : { rows: [], truncated: false, loading: true, error: null };
    });
    const [reloadKey, setReloadKey] = useState(0);
    const [search, setSearch] = useState('');

    useEffect(() => {
        if (!dataReady) return;

        const cached = readCache();
        if (cached !== undefined) {
            if (cached.rows !== rows) setData({ rows: cached.rows, truncated: cached.truncated, loading: false, error: null });
            return;
        }
        let cancelled = false;

        // The host double-mounts the page on open; the second mount awaits this shared promise.
        let inflight = winAny[INFLIGHT_KEY] as Promise<LoadedAccounts> | undefined;
        if (!inflight) {
            const pending: Promise<LoadedAccounts> = (async () => {
                let page = await dataApi.queryTable('account', LIST_QUERY);
                const all: AccountRow[] = [...page.rows];
                while (page.hasMoreRows && page.loadMoreRows && all.length < MAX_ROWS) {
                    page = await page.loadMoreRows();
                    all.push(...page.rows);
                }
                const loaded: LoadedAccounts = { rows: all, truncated: page.hasMoreRows };
                winAny[CACHE_KEY] = loaded;
                return loaded;
            })().finally(() => {
                if (winAny[INFLIGHT_KEY] === pending) delete winAny[INFLIGHT_KEY];
            });
            winAny[INFLIGHT_KEY] = pending;
            inflight = pending;
        }
        const shared = inflight;

        (async () => {
            try {
                const loaded = await shared;
                if (!cancelled) setData({ rows: loaded.rows, truncated: loaded.truncated, loading: false, error: null });
            } catch (err) {
                if (cancelled) return;
                const message = err instanceof Error ? err.message : 'Unable to load accounts.';
                setData({ rows: [], truncated: false, loading: false, error: message });
            }
        })();

        return () => {
            cancelled = true;
        };
        // Readiness and the manual reload key only: dataApi is a new reference on every render (Rule 15).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady, reloadKey]);

    const columns = useMemo(() => buildColumns(styles.truncate, styles.cellLayout), [styles.truncate, styles.cellLayout]);
    const visibleRows = useMemo(() => {
        const term = search.trim().toLowerCase();
        return rows.filter((row) => matchesSearch(row, term));
    }, [rows, search]);

    const refresh = () => {
        delete winAny[CACHE_KEY];
        delete winAny[INFLIGHT_KEY];
        setData({ rows: [], truncated: false, loading: true, error: null });
        setReloadKey((key) => key + 1);
    };

    if (loading) {
        return (
            <div className={styles.root}>
                <div className={styles.centered}>
                    <Spinner labelPosition="below" label="Loading accounts…" />
                </div>
            </div>
        );
    }

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <Text as="h1" size={700} weight="semibold">
                    Accounts
                </Text>
                <div className={styles.headerActions}>
                    <SearchBox
                        className={styles.search}
                        placeholder="Search name, number, city, email or phone"
                        value={search}
                        onChange={(_, data) => setSearch(data.value ?? '')}
                        contentBefore={<SearchRegular />}
                        aria-label="Search accounts"
                    />
                    <Button icon={<ArrowClockwiseRegular />} onClick={refresh} aria-label="Refresh accounts">
                        Refresh
                    </Button>
                </div>
            </header>

            {error && (
                <MessageBar intent="error">
                    <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
            )}

            <div className={styles.gridArea}>
                {visibleRows.length === 0 ? (
                    <div className={styles.centered} role="status">
                        <Text>{rows.length === 0 ? 'No accounts found.' : 'No accounts match your search.'}</Text>
                    </div>
                ) : (
                    <DataGrid
                        items={visibleRows}
                        columns={columns}
                        getRowId={(item) => item.accountid}
                        sortable
                        defaultSortState={{ sortColumn: 'name', sortDirection: 'ascending' }}
                        resizableColumns
                        columnSizingOptions={COLUMN_SIZING}
                        focusMode="composite"
                        aria-label="Accounts"
                    >
                        <DataGridHeader>
                            <DataGridRow>
                                {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
                            </DataGridRow>
                        </DataGridHeader>
                        <DataGridBody<AccountRow>>
                            {({ item, rowId }) => (
                                <DataGridRow<AccountRow> key={rowId}>
                                    {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
                                </DataGridRow>
                            )}
                        </DataGridBody>
                    </DataGrid>
                )}
            </div>

            <Text size={200} className={styles.footer} role="status">
                Showing {visibleRows.length} of {rows.length} accounts
                {truncated ? ` (only the first ${MAX_ROWS} accounts by name are loaded)` : ''}
            </Text>
        </div>
    );
};

export default GeneratedComponent;
