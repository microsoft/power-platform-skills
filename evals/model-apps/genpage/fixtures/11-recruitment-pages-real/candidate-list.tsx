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
    Spinner,
    Button,
    Badge,
    DataGrid,
    DataGridHeader,
    DataGridHeaderCell,
    DataGridBody,
    DataGridRow,
    DataGridCell,
    TableCellLayout,
    createTableColumn,
    SearchBox,
    Select,
    Label,
    Divider,
} from '@fluentui/react-components';
import {
    SearchRegular,
    PersonRegular,
    ArrowPreviousRegular,
    ArrowNextRegular,
    FilterRegular,
    ArrowClockwiseRegular,
} from '@fluentui/react-icons';

// ---------- Row Type ----------

type ContactRow = TableRow<{
    readonly contactid: string;
    readonly fullname: string;
    emailaddress1: string;
    telephone1: string;
    jobtitle: string;
    statuscode: number;
}>;

type ReadableContact = ReadableTableRow<ContactRow>;

// ---------- Module-level cache ----------
// Persisted on window so data survives module re-evaluation on back-navigation.
const CACHE_KEY = '__ppCandidateListCache';
const winAny = window as unknown as Record<string, ReadableContact[] | undefined>;
let _candidateCache: ReadableContact[] | null = winAny[CACHE_KEY] ?? null;

// ---------- Constants ----------

const PAGE_SIZE = 50;

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
    pageHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalM,
        paddingBottom: tokens.spacingVerticalS,
    },
    pageTitle: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
    },
    toolbar: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalM,
        padding: `${tokens.spacingVerticalS} 0`,
    },
    toolbarLeft: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        flex: '1 1 300px',
        minWidth: '220px',
    },
    toolbarRight: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        flexWrap: 'wrap',
    },
    filterGroup: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
    },
    searchBox: {
        flex: '1 1 220px',
        maxWidth: '320px',
    },
    select: {
        minWidth: '160px',
    },
    gridContainer: {
        overflowX: 'auto',
        width: '100%',
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
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.spacingVerticalM,
        padding: tokens.spacingVerticalXXL,
        color: tokens.colorNeutralForeground3,
    },
    emptyIcon: {
        fontSize: '48px',
        color: tokens.colorNeutralForeground4,
    },
    pagination: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: tokens.spacingHorizontalS,
        paddingTop: tokens.spacingVerticalS,
    },
    rowClickable: {
        cursor: 'pointer',
    },
    nameCell: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
    },
    resultCount: {
        color: tokens.colorNeutralForeground3,
    },
    headerActions: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
    },
});

// ---------- Utility Functions ----------

function getStatusBadge(statuscode: number | undefined) {
    if (statuscode === 1) {
        return (
            <Badge appearance="filled" color="success" size="small">
                Active
            </Badge>
        );
    }
    return (
        <Badge appearance="filled" color="subtle" size="small">
            Inactive
        </Badge>
    );
}

function getUniqueJobTitles(records: ReadableContact[]): string[] {
    const titles = new Set<string>();
    for (const r of records) {
        const t = r.jobtitle;
        if (t && typeof t === 'string' && t.trim() !== '') {
            titles.add(t.trim());
        }
    }
    return Array.from(titles).sort((a, b) => a.localeCompare(b));
}

// ---------- Sub-components ----------

function EmptyState({ message }: { message: string }) {
    const styles = useStyles();
    return (
        <div className={styles.emptyState} role="status" aria-live="polite">
            <PersonRegular className={styles.emptyIcon} aria-hidden="true" />
            <Text size={400} weight="semibold">
                No candidates found
            </Text>
            <Text size={300} style={{ color: tokens.colorNeutralForeground3 }}>
                {message}
            </Text>
        </div>
    );
}

// ---------- Main Component ----------

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // list page — no input record needed; destructured per rules

    const styles = useStyles();

    const [data, setData] = useState<{
        records: ReadableContact[];
        loading: boolean;
        error: string | null;
    }>({
        records: _candidateCache ?? [],
        loading: _candidateCache === null,
        error: null,
    });

    const [searchText, setSearchText] = useState('');
    const [jobTitleFilter, setJobTitleFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [currentPage, setCurrentPage] = useState(1);

    // ---------- Data fetch with caching ----------
    useEffect(() => {
        if (_candidateCache !== null) return; // cache hit — no fetch needed

        (async () => {
            try {
                const result = await dataApi.queryTable('contact', {
                    select: [
                        'contactid',
                        'fullname',
                        'emailaddress1',
                        'telephone1',
                        'jobtitle',
                        'statuscode',
                    ],
                    orderBy: 'fullname asc',
                    pageSize: 500,
                });
                _candidateCache = result.rows as ReadableContact[];
                winAny[CACHE_KEY] = _candidateCache;
                setData({ records: _candidateCache, loading: false, error: null });
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : 'Failed to load candidates.';
                setData({ records: [], loading: false, error: message });
            }
        })();
    }, [dataApi]);

    // ---------- Refresh handler ----------
    const handleRefresh = () => {
        _candidateCache = null;
        delete winAny[CACHE_KEY];
        setData({ records: [], loading: true, error: null });
        setCurrentPage(1);

        (async () => {
            try {
                const result = await dataApi.queryTable('contact', {
                    select: [
                        'contactid',
                        'fullname',
                        'emailaddress1',
                        'telephone1',
                        'jobtitle',
                        'statuscode',
                    ],
                    orderBy: 'fullname asc',
                    pageSize: 500,
                });
                _candidateCache = result.rows as ReadableContact[];
                winAny[CACHE_KEY] = _candidateCache;
                setData({ records: _candidateCache, loading: false, error: null });
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : 'Failed to load candidates.';
                setData({ records: [], loading: false, error: message });
            }
        })();
    };

    // ---------- Filtering ----------
    const filtered = data.records.filter((c) => {
        if (searchText) {
            const term = searchText.toLowerCase();
            const nameMatch = typeof c.fullname === 'string' && c.fullname.toLowerCase().includes(term);
            const emailMatch = typeof c.emailaddress1 === 'string' && c.emailaddress1.toLowerCase().includes(term);
            const titleMatch = typeof c.jobtitle === 'string' && c.jobtitle.toLowerCase().includes(term);
            if (!nameMatch && !emailMatch && !titleMatch) return false;
        }
        if (jobTitleFilter && c.jobtitle !== jobTitleFilter) return false;
        if (statusFilter !== '') {
            const code = Number(statusFilter);
            if (c.statuscode !== code) return false;
        }
        return true;
    });

    // ---------- Pagination ----------
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const safePage = Math.min(currentPage, totalPages);
    const pageStart = (safePage - 1) * PAGE_SIZE;
    const pageEnd = pageStart + PAGE_SIZE;
    const pageRecords = filtered.slice(pageStart, pageEnd);

    // Reset to page 1 when filters change
    const handleSearchChange = (_: unknown, d: { value?: string }) => {
        setSearchText(d.value ?? '');
        setCurrentPage(1);
    };

    const handleJobTitleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        setJobTitleFilter(e.target.value);
        setCurrentPage(1);
    };

    const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        setStatusFilter(e.target.value);
        setCurrentPage(1);
    };

    // ---------- Navigation ----------
    const openContactRecord = (contactId: string) => {
        const xrm = (
            window as unknown as {
                Xrm?: { Navigation?: { navigateTo: (opts: unknown) => void } };
            }
        ).Xrm;
        xrm?.Navigation?.navigateTo({
            pageType: 'entityrecord',
            entityName: 'contact',
            entityId: contactId,
        });
    };

    // ---------- Columns ----------
    const columns = [
        createTableColumn<ReadableContact>({
            columnId: 'fullname',
            renderHeaderCell: () => 'Name',
            renderCell: (item) => (
                <TableCellLayout style={{ overflow: 'hidden', minWidth: 0 }}>
                    <span
                        style={{
                            display: 'block',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontWeight: tokens.fontWeightSemibold,
                        }}
                        title={typeof item.fullname === 'string' ? item.fullname : ''}
                    >
                        {item.fullname ?? '—'}
                    </span>
                </TableCellLayout>
            ),
        }),
        createTableColumn<ReadableContact>({
            columnId: 'jobtitle',
            renderHeaderCell: () => 'Job title',
            renderCell: (item) => (
                <TableCellLayout style={{ overflow: 'hidden', minWidth: 0 }}>
                    <span
                        style={{
                            display: 'block',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                        title={typeof item.jobtitle === 'string' ? item.jobtitle : ''}
                    >
                        {item.jobtitle || '—'}
                    </span>
                </TableCellLayout>
            ),
        }),
        createTableColumn<ReadableContact>({
            columnId: 'emailaddress1',
            renderHeaderCell: () => 'Email',
            renderCell: (item) => (
                <TableCellLayout style={{ overflow: 'hidden', minWidth: 0 }}>
                    <span
                        style={{
                            display: 'block',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                        title={typeof item.emailaddress1 === 'string' ? item.emailaddress1 : ''}
                    >
                        {item.emailaddress1 || '—'}
                    </span>
                </TableCellLayout>
            ),
        }),
        createTableColumn<ReadableContact>({
            columnId: 'telephone1',
            renderHeaderCell: () => 'Phone',
            renderCell: (item) => (
                <TableCellLayout>
                    {item.telephone1 || '—'}
                </TableCellLayout>
            ),
        }),
        createTableColumn<ReadableContact>({
            columnId: 'statuscode',
            renderHeaderCell: () => 'Status',
            renderCell: (item) => (
                <TableCellLayout>
                    {getStatusBadge(typeof item.statuscode === 'number' ? item.statuscode : undefined)}
                </TableCellLayout>
            ),
        }),
    ];

    const jobTitleOptions = getUniqueJobTitles(data.records);

    // ---------- Loading state ----------
    if (data.loading) {
        return (
            <div className={styles.root}>
                <div className={styles.spinnerWrap}>
                    <Spinner labelPosition="below" label="Loading candidates..." />
                </div>
            </div>
        );
    }

    // ---------- Render ----------
    return (
        <div className={styles.root}>
            {/* Page header */}
            <header className={styles.pageHeader}>
                <div className={styles.pageTitle}>
                    <PersonRegular aria-hidden="true" style={{ fontSize: '24px', color: tokens.colorBrandForeground1 }} />
                    <Text as="h1" size={700} weight="semibold">
                        Candidates
                    </Text>
                    {!data.loading && (
                        <Text size={300} className={styles.resultCount}>
                            ({data.records.length} total)
                        </Text>
                    )}
                </div>
                <div className={styles.headerActions}>
                    <Button
                        appearance="subtle"
                        icon={<ArrowClockwiseRegular />}
                        onClick={handleRefresh}
                        aria-label="Refresh candidate list"
                    >
                        Refresh
                    </Button>
                </div>
            </header>

            <Divider />

            {/* Error banner */}
            {data.error && (
                <div role="alert" className={styles.errorBanner}>
                    <Text weight="semibold">Error:</Text> {data.error}
                </div>
            )}

            {/* Toolbar: search + filters */}
            <div className={styles.toolbar} role="search" aria-label="Filter candidates">
                <div className={styles.toolbarLeft}>
                    <SearchBox
                        className={styles.searchBox}
                        placeholder="Search by name, email, or title"
                        value={searchText}
                        onChange={handleSearchChange}
                        contentBefore={<SearchRegular aria-hidden="true" />}
                        aria-label="Search candidates"
                    />
                </div>
                <div className={styles.toolbarRight}>
                    <div className={styles.filterGroup}>
                        <FilterRegular aria-hidden="true" style={{ color: tokens.colorNeutralForeground3 }} />
                        <Label htmlFor="job-title-filter">Job title</Label>
                        <Select
                            id="job-title-filter"
                            className={styles.select}
                            value={jobTitleFilter}
                            onChange={handleJobTitleChange}
                            aria-label="Filter by job title"
                        >
                            <option value="">All titles</option>
                            {jobTitleOptions.map((title) => (
                                <option key={title} value={title}>
                                    {title}
                                </option>
                            ))}
                        </Select>
                    </div>
                    <div className={styles.filterGroup}>
                        <Label htmlFor="status-filter">Status</Label>
                        <Select
                            id="status-filter"
                            className={styles.select}
                            value={statusFilter}
                            onChange={handleStatusChange}
                            aria-label="Filter by status"
                        >
                            <option value="">All statuses</option>
                            <option value="1">Active</option>
                            <option value="2">Inactive</option>
                        </Select>
                    </div>
                </div>
            </div>

            {/* Result count */}
            {(searchText || jobTitleFilter || statusFilter !== '') && (
                <Text size={200} className={styles.resultCount} aria-live="polite" aria-atomic="true">
                    Showing {filtered.length} of {data.records.length} candidates
                </Text>
            )}

            {/* Grid */}
            {filtered.length === 0 ? (
                <EmptyState
                    message={
                        searchText || jobTitleFilter || statusFilter !== ''
                            ? 'No candidates match your current filters. Try adjusting the search or filter criteria.'
                            : 'No candidate records found in the system.'
                    }
                />
            ) : (
                <div className={styles.gridContainer}>
                    <DataGrid
                        items={pageRecords}
                        columns={columns}
                        getRowId={(row) => row.contactid as string}
                        resizableColumns
                        columnSizingOptions={{
                            fullname: { idealWidth: 220, minWidth: 160 },
                            jobtitle: { idealWidth: 200, minWidth: 140 },
                            emailaddress1: { idealWidth: 240, minWidth: 160 },
                            telephone1: { idealWidth: 160, minWidth: 120 },
                            statuscode: { idealWidth: 100, minWidth: 80 },
                        }}
                        aria-label="Candidate list"
                        aria-rowcount={filtered.length}
                    >
                        <DataGridHeader>
                            <DataGridRow>
                                {({ renderHeaderCell }) => (
                                    <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
                                )}
                            </DataGridRow>
                        </DataGridHeader>
                        <DataGridBody<ReadableContact>>
                            {({ item }) => (
                                <DataGridRow<ReadableContact>
                                    key={item.contactid as string}
                                    className={styles.rowClickable}
                                    onClick={() => openContactRecord(item.contactid as string)}
                                    aria-label={`Open record for ${item.fullname ?? 'candidate'}`}
                                    style={{ cursor: 'pointer' }}
                                >
                                    {({ renderCell }) => (
                                        <DataGridCell>{renderCell(item)}</DataGridCell>
                                    )}
                                </DataGridRow>
                            )}
                        </DataGridBody>
                    </DataGrid>
                </div>
            )}

            {/* Pagination */}
            {filtered.length > PAGE_SIZE && (
                <nav className={styles.pagination} aria-label="Pagination">
                    <Text size={200} className={styles.resultCount}>
                        Page {safePage} of {totalPages} ({filtered.length} results)
                    </Text>
                    <Button
                        appearance="subtle"
                        icon={<ArrowPreviousRegular />}
                        disabled={safePage <= 1}
                        onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                        aria-label="Previous page"
                    />
                    <Button
                        appearance="subtle"
                        icon={<ArrowNextRegular />}
                        disabled={safePage >= totalPages}
                        onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                        aria-label="Next page"
                    />
                </nav>
            )}
        </div>
    );
};

export default GeneratedComponent;
