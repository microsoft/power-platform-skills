import { useEffect, useState } from 'react';
import type {
    TableRow,
    ReadableTableRow,
    GeneratedComponentProps,
} from './RuntimeTypes';
import {
    makeStyles,
    tokens,
    Text,
    Caption1,
    Link,
    Spinner,
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
import type { TableColumnDefinition, TableColumnSizingOptions } from '@fluentui/react-components';
import { BuildingRegular } from '@fluentui/react-icons';

// Account List — a simple, sortable list of Account records.
// Columns are the verified account columns from RuntimeTypes.ts. The primary contact
// is a lookup, so the FK column is selected and its display name read from the
// FormattedValue annotation (DataAPI rule 12).

type AccountRow = TableRow<{
    readonly accountid: string;
    name?: string;
    accountnumber?: string;
    telephone1?: string;
    address1_city?: string;
    readonly _primarycontactid_value?: string;
}>;

type ReadableAccount = ReadableTableRow<AccountRow>;

type AccountListState = {
    records: ReadableAccount[];
    loading: boolean;
    error: string | null;
};

// Window-level cache + in-flight de-dupe (Rule 15, references/data-caching.md).
// Keys are scoped by page + query so another page reading account never shares them.
const CACHE_KEY = '__ppAccountList_accountCache';
const INFLIGHT_KEY = '__ppAccountList_accountInflight';
const winAny = window as unknown as Record<string, unknown>;

const PRIMARY_CONTACT_LABEL = '_primarycontactid_value@OData.Community.Display.V1.FormattedValue';

type XrmLike = {
    Navigation?: {
        navigateTo: (
            pageInput: { pageType: 'entityrecord'; entityName: string; entityId: string },
        ) => Promise<unknown>;
    };
};

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
        padding: tokens.spacingHorizontalXL,
        height: '100%',
        width: '100%',
        boxSizing: 'border-box',
        '@media (max-width: 480px)': {
            padding: tokens.spacingHorizontalM,
        },
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalM,
    },
    titleGroup: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
    },
    titleIcon: {
        fontSize: tokens.fontSizeBase600,
        color: tokens.colorBrandForeground1,
    },
    count: {
        color: tokens.colorNeutralForeground3,
    },
    gridWrap: {
        flexGrow: 1,
        minHeight: 0,
        overflow: 'auto',
        borderRadius: tokens.borderRadiusMedium,
        backgroundColor: tokens.colorNeutralBackground1,
        boxShadow: tokens.shadow2,
    },
    spinnerWrap: {
        display: 'flex',
        justifyContent: 'center',
        padding: tokens.spacingVerticalXXL,
    },
    empty: {
        padding: tokens.spacingVerticalXL,
        textAlign: 'center',
        color: tokens.colorNeutralForeground3,
    },
});

function textOf(value: string | undefined): string {
    return value ?? '';
}

function primaryContactName(row: ReadableAccount): string {
    const label = (row as unknown as Record<string, unknown>)[PRIMARY_CONTACT_LABEL];
    return typeof label === 'string' ? label : '';
}

// Case-insensitive compare that keeps blank values at the end of an ascending sort.
function compareText(a: string, b: string): number {
    if (!a && b) return 1;
    if (a && !b) return -1;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function openAccount(accountId: string): void {
    const xrm = (window as unknown as { Xrm?: XrmLike }).Xrm;
    void xrm?.Navigation?.navigateTo({
        pageType: 'entityrecord',
        entityName: 'account',
        entityId: accountId,
    });
}

const columns: TableColumnDefinition<ReadableAccount>[] = [
    createTableColumn<ReadableAccount>({
        columnId: 'name',
        compare: (a, b) => compareText(textOf(a.name), textOf(b.name)),
        renderHeaderCell: () => 'Account name',
        renderCell: (item) => (
            <TableCellLayout truncate>
                <Link
                    onClick={() => openAccount(item.accountid)}
                    title={item.name || 'Unnamed account'}
                    aria-label={`Open account ${item.name || 'Unnamed account'}`}
                >
                    {item.name || 'Unnamed account'}
                </Link>
            </TableCellLayout>
        ),
    }),
    createTableColumn<ReadableAccount>({
        columnId: 'accountnumber',
        compare: (a, b) => compareText(textOf(a.accountnumber), textOf(b.accountnumber)),
        renderHeaderCell: () => 'Account number',
        renderCell: (item) => (
            <TableCellLayout truncate title={textOf(item.accountnumber)}>
                {item.accountnumber || '—'}
            </TableCellLayout>
        ),
    }),
    createTableColumn<ReadableAccount>({
        columnId: 'telephone1',
        compare: (a, b) => compareText(textOf(a.telephone1), textOf(b.telephone1)),
        renderHeaderCell: () => 'Main phone',
        renderCell: (item) => (
            <TableCellLayout truncate title={textOf(item.telephone1)}>
                {item.telephone1 || '—'}
            </TableCellLayout>
        ),
    }),
    createTableColumn<ReadableAccount>({
        columnId: 'address1_city',
        compare: (a, b) => compareText(textOf(a.address1_city), textOf(b.address1_city)),
        renderHeaderCell: () => 'City',
        renderCell: (item) => (
            <TableCellLayout truncate title={textOf(item.address1_city)}>
                {item.address1_city || '—'}
            </TableCellLayout>
        ),
    }),
    createTableColumn<ReadableAccount>({
        columnId: 'primarycontact',
        compare: (a, b) => compareText(primaryContactName(a), primaryContactName(b)),
        renderHeaderCell: () => 'Primary contact',
        renderCell: (item) => (
            <TableCellLayout truncate title={primaryContactName(item)}>
                {primaryContactName(item) || '—'}
            </TableCellLayout>
        ),
    }),
];

const columnSizingOptions: TableColumnSizingOptions = {
    name: { defaultWidth: 260, idealWidth: 260, minWidth: 180 },
    accountnumber: { defaultWidth: 150, idealWidth: 150, minWidth: 110 },
    telephone1: { defaultWidth: 160, idealWidth: 160, minWidth: 120 },
    address1_city: { defaultWidth: 160, idealWidth: 160, minWidth: 110 },
    primarycontact: { defaultWidth: 220, idealWidth: 220, minWidth: 150 },
};

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // list page takes no record context; destructured per the component contract
    const styles = useStyles();

    // Seed from the window cache so a second mount paints rows without a spinner.
    const [data, setData] = useState<AccountListState>(() => {
        const cached = winAny[CACHE_KEY] as ReadableAccount[] | undefined;
        return { records: cached ?? [], loading: cached === undefined, error: null };
    });

    const dataReady = !!dataApi;

    useEffect(() => {
        if (!dataReady) return;

        const cached = winAny[CACHE_KEY] as ReadableAccount[] | undefined;
        if (cached !== undefined) {
            if (data.records !== cached) setData({ records: cached, loading: false, error: null });
            return;
        }
        let cancelled = false;

        // The host double-mounts the page on open; a racing second mount awaits the
        // same in-flight promise instead of issuing a second query.
        let inflight = winAny[INFLIGHT_KEY] as Promise<ReadableAccount[]> | undefined;
        if (!inflight) {
            inflight = dataApi.queryTable('account', {
                select: ['accountid', 'name', 'accountnumber', 'telephone1', 'address1_city', '_primarycontactid_value'],
                orderBy: 'name asc',
                pageSize: 250,
            })
                .then((result) => {
                    winAny[CACHE_KEY] = result.rows;
                    return result.rows as ReadableAccount[];
                })
                .finally(() => { if (winAny[INFLIGHT_KEY] === inflight) delete winAny[INFLIGHT_KEY]; });
            winAny[INFLIGHT_KEY] = inflight;
        }

        inflight
            .then((rows) => { if (!cancelled) setData({ records: rows, loading: false, error: null }); })
            .catch((err) => {
                if (cancelled) return;
                const message = err instanceof Error ? err.message : 'Failed to load accounts.';
                setData({ records: [], loading: false, error: message });
            });

        return () => { cancelled = true; };
        // Readiness only — dataApi is a new reference on every render (Rule 15).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady]);

    if (data.loading) {
        return (
            <div className={styles.root}>
                <div className={styles.spinnerWrap}>
                    <Spinner labelPosition="below" label="Loading accounts…" />
                </div>
            </div>
        );
    }

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <div className={styles.titleGroup}>
                    <BuildingRegular className={styles.titleIcon} aria-hidden="true" />
                    <Text as="h1" size={600} weight="semibold">
                        Accounts
                    </Text>
                </div>
                <Caption1 className={styles.count} aria-live="polite">
                    {data.records.length === 1 ? '1 account' : `${data.records.length} accounts`}
                </Caption1>
            </header>

            {data.error && (
                <MessageBar intent="error">
                    <MessageBarBody>{data.error}</MessageBarBody>
                </MessageBar>
            )}

            <div className={styles.gridWrap}>
                {data.records.length === 0 && !data.error ? (
                    <Text className={styles.empty} block>
                        No accounts found.
                    </Text>
                ) : (
                    <DataGrid
                        items={data.records}
                        columns={columns}
                        getRowId={(row) => row.accountid}
                        sortable
                        resizableColumns
                        columnSizingOptions={columnSizingOptions}
                        focusMode="composite"
                        aria-label="Accounts"
                    >
                        <DataGridHeader>
                            <DataGridRow>
                                {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
                            </DataGridRow>
                        </DataGridHeader>
                        <DataGridBody<ReadableAccount>>
                            {({ item, rowId }) => (
                                <DataGridRow<ReadableAccount> key={rowId}>
                                    {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
                                </DataGridRow>
                            )}
                        </DataGridBody>
                    </DataGrid>
                )}
            </div>
        </div>
    );
};

export default GeneratedComponent;
