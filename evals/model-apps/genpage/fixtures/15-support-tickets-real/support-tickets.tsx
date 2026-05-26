import { useEffect, useState } from 'react';
import type {
    ReadableTableRow,
    GeneratedComponentProps,
    cr_ticket,
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
    Dropdown,
    Option,
    Badge,
} from '@fluentui/react-components';
import type { TableColumnDefinition } from '@fluentui/react-components';
import { SearchRegular, ArrowClockwiseRegular } from '@fluentui/react-icons';

type ReadableTicket = ReadableTableRow<cr_ticket>;

// ── Choice codes (verified from RuntimeTypes cr_ticket_cr_priority / cr_ticket_cr_status) ──
const PRIORITY_LOW      = 100000000;
const PRIORITY_MEDIUM   = 100000001;
const PRIORITY_HIGH     = 100000002;
const PRIORITY_CRITICAL = 100000003;

const STATUS_OPEN        = 100000000;
const STATUS_IN_PROGRESS = 100000001;
const STATUS_RESOLVED    = 100000002;
const STATUS_CLOSED      = 100000003;

const PRIORITY_OPTIONS: { value: number; label: string }[] = [
    { value: PRIORITY_LOW,      label: 'Low'      },
    { value: PRIORITY_MEDIUM,   label: 'Medium'   },
    { value: PRIORITY_HIGH,     label: 'High'     },
    { value: PRIORITY_CRITICAL, label: 'Critical' },
];

const STATUS_OPTIONS: { value: number; label: string }[] = [
    { value: STATUS_OPEN,        label: 'Open'        },
    { value: STATUS_IN_PROGRESS, label: 'In Progress' },
    { value: STATUS_RESOLVED,    label: 'Resolved'    },
    { value: STATUS_CLOSED,      label: 'Closed'      },
];

// ── Module-level cache (survives module re-evaluation on back-nav) ────────────
const CACHE_KEY = '__ppSupportTicketsCache';
const winAny = window as unknown as Record<string, ReadableTicket[] | undefined>;
let cache: ReadableTicket[] | null = winAny[CACHE_KEY] ?? null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDueDate(value: Date | string | null | undefined): string {
    if (!value) return '—';
    const d = new Date(value as string);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function isOverdue(value: Date | string | null | undefined, status: number | undefined): boolean {
    if (status === STATUS_RESOLVED || status === STATUS_CLOSED) return false;
    if (!value) return false;
    const d = new Date(value as string);
    if (isNaN(d.getTime())) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return d.getTime() < today.getTime();
}

function getPriorityConfig(priority: number | undefined): {
    color: 'success' | 'warning' | 'severe' | 'danger' | 'subtle';
    label: string;
} {
    switch (priority) {
        case PRIORITY_LOW:      return { color: 'success', label: 'Low'      };
        case PRIORITY_MEDIUM:   return { color: 'warning', label: 'Medium'   };
        case PRIORITY_HIGH:     return { color: 'severe',  label: 'High'     };
        case PRIORITY_CRITICAL: return { color: 'danger',  label: 'Critical' };
        default:                return { color: 'subtle',  label: '—'        };
    }
}

function getStatusConfig(status: number | undefined): {
    color: 'informative' | 'brand' | 'success' | 'subtle';
    label: string;
} {
    switch (status) {
        case STATUS_OPEN:        return { color: 'informative', label: 'Open'        };
        case STATUS_IN_PROGRESS: return { color: 'brand',       label: 'In Progress' };
        case STATUS_RESOLVED:    return { color: 'success',     label: 'Resolved'    };
        case STATUS_CLOSED:      return { color: 'subtle',      label: 'Closed'      };
        default:                 return { color: 'subtle',      label: '—'           };
    }
}

// ── Styles ────────────────────────────────────────────────────────────────────

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
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
    },
    titleRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens.spacingHorizontalM,
        flexWrap: 'wrap',
    },
    filterBar: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalM,
        flexWrap: 'wrap',
    },
    searchBox: {
        flex: '1 1 240px',
        maxWidth: '320px',
    },
    dropdown: {
        minWidth: '160px',
    },
    spinnerWrap: {
        display: 'flex',
        justifyContent: 'center',
        padding: tokens.spacingVerticalXXL,
    },
    errorBanner: {
        padding: tokens.spacingHorizontalM,
        backgroundColor: tokens.colorStatusDangerBackground2,
        color: tokens.colorStatusDangerForeground2,
        borderRadius: tokens.borderRadiusMedium,
    },
    emptyState: {
        padding: tokens.spacingVerticalXXL,
        textAlign: 'center',
        color: tokens.colorNeutralForeground3,
    },
    overdueDate: {
        color: tokens.colorStatusDangerForeground1,
        fontWeight: tokens.fontWeightSemibold,
    },
    nameButton: {
        textAlign: 'left',
        justifyContent: 'flex-start',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
});

// ── GeneratedComponent ───────────────────────────────────────────────────────

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput;
    const styles = useStyles();

    const [data, setData] = useState<{
        records: ReadableTicket[];
        loading: boolean;
        error: string | null;
    }>(() => ({
        records: cache ?? [],
        loading: cache === null,
        error: null,
    }));

    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<number | null>(null);
    const [priorityFilter, setPriorityFilter] = useState<number | null>(null);
    const [sortColumn, setSortColumn] = useState<string>('cr_duedate');
    const [sortDirection, setSortDirection] = useState<'ascending' | 'descending'>('ascending');

    useEffect(() => {
        if (cache !== null) return;
        (async () => {
            try {
                const result = await dataApi.queryTable('cr_ticket', {
                    select: ['cr_ticketid', 'cr_name', 'cr_priority', 'cr_status', 'cr_duedate'],
                    filter: 'statecode eq 0',
                    orderBy: 'cr_duedate asc',
                    pageSize: 200,
                });
                cache = result.rows as ReadableTicket[];
                winAny[CACHE_KEY] = cache;
                setData({ records: cache, loading: false, error: null });
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Failed to load tickets.';
                setData({ records: [], loading: false, error: message });
            }
        })();
    }, [dataApi]);

    const refresh = async () => {
        cache = null;
        delete winAny[CACHE_KEY];
        setData({ records: [], loading: true, error: null });
        try {
            const result = await dataApi.queryTable('cr_ticket', {
                select: ['cr_ticketid', 'cr_name', 'cr_priority', 'cr_status', 'cr_duedate'],
                filter: 'statecode eq 0',
                orderBy: 'cr_duedate asc',
                pageSize: 200,
            });
            cache = result.rows as ReadableTicket[];
            winAny[CACHE_KEY] = cache;
            setData({ records: cache, loading: false, error: null });
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to refresh.';
            setData({ records: [], loading: false, error: message });
        }
    };

    const openRecord = (ticketId: string) => {
        const xrm = (window as unknown as {
            Xrm?: { Navigation?: { navigateTo: (opts: unknown) => unknown } };
        }).Xrm;
        xrm?.Navigation?.navigateTo({
            pageType: 'entityrecord',
            entityName: 'cr_ticket',
            entityId: ticketId,
        });
    };

    // ── Filter ──────────────────────────────────────────────────────────────
    const filtered = data.records.filter((t) => {
        if (search) {
            const term = search.toLowerCase();
            if (!(t.cr_name?.toLowerCase().includes(term))) return false;
        }
        if (statusFilter !== null && (t.cr_status as unknown as number) !== statusFilter) return false;
        if (priorityFilter !== null && (t.cr_priority as unknown as number) !== priorityFilter) return false;
        return true;
    });

    // ── Sort (controlled — DataGrid expects pre-sorted items) ──────────────
    const sorted = [...filtered].sort((a, b) => {
        const dir = sortDirection === 'ascending' ? 1 : -1;
        switch (sortColumn) {
            case 'cr_name':
                return dir * (a.cr_name ?? '').localeCompare(b.cr_name ?? '');
            case 'cr_priority':
                return dir * ((a.cr_priority as unknown as number ?? 0) - (b.cr_priority as unknown as number ?? 0));
            case 'cr_status':
                return dir * ((a.cr_status as unknown as number ?? 0) - (b.cr_status as unknown as number ?? 0));
            case 'cr_duedate': {
                const aD = a.cr_duedate ? new Date(a.cr_duedate as unknown as string).getTime() : Number.MAX_SAFE_INTEGER;
                const bD = b.cr_duedate ? new Date(b.cr_duedate as unknown as string).getTime() : Number.MAX_SAFE_INTEGER;
                return dir * (aD - bD);
            }
            default:
                return 0;
        }
    });

    // ── Columns ─────────────────────────────────────────────────────────────
    const columns: TableColumnDefinition<ReadableTicket>[] = [
        createTableColumn<ReadableTicket>({
            columnId: 'cr_name',
            compare: (a, b) => (a.cr_name ?? '').localeCompare(b.cr_name ?? ''),
            renderHeaderCell: () => 'Ticket',
            renderCell: (item) => (
                <TableCellLayout style={{ overflow: 'hidden', minWidth: 0 }}>
                    <Button
                        appearance="transparent"
                        className={styles.nameButton}
                        onClick={() => openRecord(item.cr_ticketid)}
                        title={item.cr_name ?? ''}
                    >
                        {item.cr_name ?? '—'}
                    </Button>
                </TableCellLayout>
            ),
        }),
        createTableColumn<ReadableTicket>({
            columnId: 'cr_priority',
            compare: (a, b) => (a.cr_priority as unknown as number ?? 0) - (b.cr_priority as unknown as number ?? 0),
            renderHeaderCell: () => 'Priority',
            renderCell: (item) => {
                const cfg = getPriorityConfig(item.cr_priority as unknown as number | undefined);
                return (
                    <TableCellLayout>
                        <Badge appearance="filled" color={cfg.color} shape="rounded">
                            {cfg.label}
                        </Badge>
                    </TableCellLayout>
                );
            },
        }),
        createTableColumn<ReadableTicket>({
            columnId: 'cr_status',
            compare: (a, b) => (a.cr_status as unknown as number ?? 0) - (b.cr_status as unknown as number ?? 0),
            renderHeaderCell: () => 'Status',
            renderCell: (item) => {
                const cfg = getStatusConfig(item.cr_status as unknown as number | undefined);
                return (
                    <TableCellLayout>
                        <Badge appearance="tint" color={cfg.color} shape="rounded">
                            {cfg.label}
                        </Badge>
                    </TableCellLayout>
                );
            },
        }),
        createTableColumn<ReadableTicket>({
            columnId: 'cr_duedate',
            compare: (a, b) => {
                const aD = a.cr_duedate ? new Date(a.cr_duedate as unknown as string).getTime() : Number.MAX_SAFE_INTEGER;
                const bD = b.cr_duedate ? new Date(b.cr_duedate as unknown as string).getTime() : Number.MAX_SAFE_INTEGER;
                return aD - bD;
            },
            renderHeaderCell: () => 'Due date',
            renderCell: (item) => {
                const overdue = isOverdue(
                    item.cr_duedate as unknown as string | Date | undefined,
                    item.cr_status as unknown as number | undefined,
                );
                return (
                    <TableCellLayout className={overdue ? styles.overdueDate : undefined}>
                        {formatDueDate(item.cr_duedate as unknown as string | Date | undefined)}
                        {overdue && ' (overdue)'}
                    </TableCellLayout>
                );
            },
        }),
    ];

    // ── Render ──────────────────────────────────────────────────────────────

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <div className={styles.titleRow}>
                    <Text as="h1" size={700} weight="semibold">
                        Support tickets
                    </Text>
                    <Button
                        icon={<ArrowClockwiseRegular />}
                        onClick={refresh}
                        disabled={data.loading}
                    >
                        Refresh
                    </Button>
                </div>
                <div className={styles.filterBar} role="toolbar" aria-label="Ticket filters">
                    <SearchBox
                        className={styles.searchBox}
                        placeholder="Search by name…"
                        value={search}
                        onChange={(_, d) => setSearch(d.value ?? '')}
                        contentBefore={<SearchRegular />}
                        aria-label="Search tickets by name"
                    />
                    <Dropdown
                        className={styles.dropdown}
                        placeholder="All statuses"
                        value={
                            statusFilter === null
                                ? 'All statuses'
                                : STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label ?? ''
                        }
                        selectedOptions={statusFilter === null ? ['all'] : [String(statusFilter)]}
                        onOptionSelect={(_, d) => {
                            const v = d.optionValue;
                            setStatusFilter(!v || v === 'all' ? null : Number(v));
                        }}
                        aria-label="Filter by status"
                    >
                        <Option value="all">All statuses</Option>
                        {STATUS_OPTIONS.map((o) => (
                            <Option key={o.value} value={String(o.value)}>
                                {o.label}
                            </Option>
                        ))}
                    </Dropdown>
                    <Dropdown
                        className={styles.dropdown}
                        placeholder="All priorities"
                        value={
                            priorityFilter === null
                                ? 'All priorities'
                                : PRIORITY_OPTIONS.find((o) => o.value === priorityFilter)?.label ?? ''
                        }
                        selectedOptions={priorityFilter === null ? ['all'] : [String(priorityFilter)]}
                        onOptionSelect={(_, d) => {
                            const v = d.optionValue;
                            setPriorityFilter(!v || v === 'all' ? null : Number(v));
                        }}
                        aria-label="Filter by priority"
                    >
                        <Option value="all">All priorities</Option>
                        {PRIORITY_OPTIONS.map((o) => (
                            <Option key={o.value} value={String(o.value)}>
                                {o.label}
                            </Option>
                        ))}
                    </Dropdown>
                </div>
            </header>

            {data.error && (
                <div role="alert" className={styles.errorBanner}>
                    {data.error}
                </div>
            )}

            {data.loading ? (
                <div className={styles.spinnerWrap}>
                    <Spinner labelPosition="below" label="Loading tickets…" />
                </div>
            ) : sorted.length === 0 ? (
                <div className={styles.emptyState}>
                    <Text size={400}>
                        {data.records.length === 0
                            ? 'No tickets yet.'
                            : 'No tickets match your filters.'}
                    </Text>
                </div>
            ) : (
                <DataGrid
                    items={sorted}
                    columns={columns}
                    sortable
                    sortState={{ sortColumn, sortDirection }}
                    onSortChange={(
                        _: unknown,
                        d: { sortColumn: string; sortDirection: 'ascending' | 'descending' },
                    ) => {
                        setSortColumn(d.sortColumn);
                        setSortDirection(d.sortDirection);
                    }}
                    getRowId={(row) => row.cr_ticketid}
                    resizableColumns
                    columnSizingOptions={{
                        cr_name:     { idealWidth: 280, minWidth: 160 },
                        cr_priority: { idealWidth: 110, minWidth: 90  },
                        cr_status:   { idealWidth: 130, minWidth: 100 },
                        cr_duedate:  { idealWidth: 200, minWidth: 140 },
                    }}
                    aria-label="Support tickets"
                >
                    <DataGridHeader>
                        <DataGridRow>
                            {({ renderHeaderCell }) => (
                                <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
                            )}
                        </DataGridRow>
                    </DataGridHeader>
                    <DataGridBody<ReadableTicket>>
                        {({ item }) => (
                            <DataGridRow<ReadableTicket> key={item.cr_ticketid}>
                                {({ renderCell }) => (
                                    <DataGridCell>{renderCell(item)}</DataGridCell>
                                )}
                            </DataGridRow>
                        )}
                    </DataGridBody>
                </DataGrid>
            )}
        </div>
    );
};

export default GeneratedComponent;
