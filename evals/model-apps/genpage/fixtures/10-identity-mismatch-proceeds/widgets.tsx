import { useEffect, useState } from 'react';
import type {
    ReadableTableRow,
    GeneratedComponentProps,
    cr_widget,
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
import { BoxRegular } from '@fluentui/react-icons';

// Widgets — every widget with its SKU and the quantity on hand. Columns are the ones
// RuntimeTypes.ts declares on cr_widget.

type ReadableWidget = ReadableTableRow<cr_widget>;

type WidgetListState = {
    records: ReadableWidget[];
    loading: boolean;
    error: string | null;
};

// Window-level cache + in-flight de-dupe (Rule 15, references/data-caching.md).
// Keys are scoped by page + query so another page reading cr_widget never shares them.
const CACHE_KEY = '__ppWidgets_widgetCache';
const INFLIGHT_KEY = '__ppWidgets_widgetInflight';
const winAny = window as unknown as Record<string, unknown>;

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

// A widget with no recorded quantity sorts after every counted widget.
function quantityOf(row: ReadableWidget): number | null {
    return typeof row.cr_quantity === 'number' ? row.cr_quantity : null;
}

// Case-insensitive compare that keeps blank values at the end of an ascending sort.
function compareText(a: string, b: string): number {
    if (!a && b) return 1;
    if (a && !b) return -1;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function compareQuantity(a: number | null, b: number | null): number {
    if (a === null && b !== null) return 1;
    if (a !== null && b === null) return -1;
    return (a ?? 0) - (b ?? 0);
}

function openWidget(widgetId: string): void {
    const xrm = (window as unknown as { Xrm?: XrmLike }).Xrm;
    void xrm?.Navigation?.navigateTo({
        pageType: 'entityrecord',
        entityName: 'cr_widget',
        entityId: widgetId,
    });
}

const columns: TableColumnDefinition<ReadableWidget>[] = [
    createTableColumn<ReadableWidget>({
        columnId: 'name',
        compare: (a, b) => compareText(textOf(a.cr_name), textOf(b.cr_name)),
        renderHeaderCell: () => 'Widget',
        renderCell: (item) => (
            <TableCellLayout truncate>
                <Link
                    onClick={() => openWidget(item.cr_widgetid)}
                    title={item.cr_name || 'Unnamed widget'}
                    aria-label={`Open widget ${item.cr_name || 'Unnamed widget'}`}
                >
                    {item.cr_name || 'Unnamed widget'}
                </Link>
            </TableCellLayout>
        ),
    }),
    createTableColumn<ReadableWidget>({
        columnId: 'sku',
        compare: (a, b) => compareText(textOf(a.cr_sku), textOf(b.cr_sku)),
        renderHeaderCell: () => 'SKU',
        renderCell: (item) => (
            <TableCellLayout truncate title={textOf(item.cr_sku)}>
                {item.cr_sku || '—'}
            </TableCellLayout>
        ),
    }),
    createTableColumn<ReadableWidget>({
        columnId: 'quantity',
        compare: (a, b) => compareQuantity(quantityOf(a), quantityOf(b)),
        renderHeaderCell: () => 'Quantity',
        renderCell: (item) => {
            const quantity = quantityOf(item);
            return (
                <TableCellLayout>
                    {quantity === null ? '—' : quantity.toLocaleString()}
                </TableCellLayout>
            );
        },
    }),
];

const columnSizingOptions: TableColumnSizingOptions = {
    name: { defaultWidth: 260, idealWidth: 260, minWidth: 180 },
    sku: { defaultWidth: 160, idealWidth: 160, minWidth: 110 },
    quantity: { defaultWidth: 120, idealWidth: 120, minWidth: 90 },
};

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // list page takes no record context; destructured per the component contract
    const styles = useStyles();

    // Seed from the window cache so a second mount paints rows without a spinner.
    const [data, setData] = useState<WidgetListState>(() => {
        const cached = winAny[CACHE_KEY] as ReadableWidget[] | undefined;
        return { records: cached ?? [], loading: cached === undefined, error: null };
    });

    const dataReady = !!dataApi;

    useEffect(() => {
        if (!dataReady) return;

        const cached = winAny[CACHE_KEY] as ReadableWidget[] | undefined;
        if (cached !== undefined) {
            if (data.records !== cached) setData({ records: cached, loading: false, error: null });
            return;
        }
        let cancelled = false;

        // The host double-mounts the page on open; a racing second mount awaits the
        // same in-flight promise instead of issuing a second query.
        let inflight = winAny[INFLIGHT_KEY] as Promise<ReadableWidget[]> | undefined;
        if (!inflight) {
            inflight = dataApi.queryTable('cr_widget', {
                select: ['cr_widgetid', 'cr_name', 'cr_sku', 'cr_quantity'],
                orderBy: 'cr_name asc',
                pageSize: 500,
            })
                .then((result) => {
                    winAny[CACHE_KEY] = result.rows;
                    return result.rows as ReadableWidget[];
                })
                .finally(() => { if (winAny[INFLIGHT_KEY] === inflight) delete winAny[INFLIGHT_KEY]; });
            winAny[INFLIGHT_KEY] = inflight;
        }

        inflight
            .then((rows) => { if (!cancelled) setData({ records: rows, loading: false, error: null }); })
            .catch((err) => {
                if (cancelled) return;
                const message = err instanceof Error ? err.message : 'Failed to load widgets.';
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
                    <Spinner labelPosition="below" label="Loading widgets…" />
                </div>
            </div>
        );
    }

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <div className={styles.titleGroup}>
                    <BoxRegular className={styles.titleIcon} aria-hidden="true" />
                    <Text as="h1" size={600} weight="semibold">
                        Widgets
                    </Text>
                </div>
                <Caption1 className={styles.count} aria-live="polite">
                    {data.records.length === 1 ? '1 widget' : `${data.records.length} widgets`}
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
                        No widgets yet.
                    </Text>
                ) : (
                    <DataGrid
                        items={data.records}
                        columns={columns}
                        getRowId={(row) => row.cr_widgetid}
                        sortable
                        resizableColumns
                        columnSizingOptions={columnSizingOptions}
                        focusMode="composite"
                        aria-label="Widgets"
                    >
                        <DataGridHeader>
                            <DataGridRow>
                                {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
                            </DataGridRow>
                        </DataGridHeader>
                        <DataGridBody<ReadableWidget>>
                            {({ item, rowId }) => (
                                <DataGridRow<ReadableWidget> key={rowId}>
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
