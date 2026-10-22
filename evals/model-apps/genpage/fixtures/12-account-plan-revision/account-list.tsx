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
    Badge,
    SearchBox,
    Toolbar,
    ToolbarButton,
    ToolbarDivider,
    Dropdown,
    Option,
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
import { ArrowClockwiseRegular, FilterDismissRegular, FilterRegular, SearchRegular } from '@fluentui/react-icons';

type AccountRow = ReadableTableRow<account>;
type LoadedAccounts = { rows: AccountRow[]; hasMoreRows: boolean };
type LoadState = LoadedAccounts & { loading: boolean; error: string | null };
type StatusFilter = 'all' | 'active' | 'inactive';
type Filters = { status: StatusFilter; industry: string; country: string };

// Window-scoped cache + in-flight promise (references/data-caching.md, Pattern 1). The keys
// carry the page name so another page querying account with a different select never shares them.
const CACHE_KEY = '__ppAccountFilterList_accountCache';
const INFLIGHT_KEY = '__ppAccountFilterList_accountInflight';
const winAny = window as unknown as Record<string, unknown>;

const PAGE_SIZE = 500;
const ALL = '__all__';
const NO_FILTERS: Filters = { status: 'all', industry: ALL, country: ALL };
const FORMATTED = '@OData.Community.Display.V1.FormattedValue';

const ACCOUNT_QUERY: QueryTableOptions<account> = {
    select: [
        'accountid',
        'name',
        'accountnumber',
        'industrycode',
        'address1_city',
        'address1_country',
        'telephone1',
        'emailaddress1',
        'statecode',
    ],
    orderBy: 'name asc',
    pageSize: PAGE_SIZE,
};

const STATUS_LABELS: Record<StatusFilter, string> = {
    all: 'All statuses',
    active: 'Active',
    inactive: 'Inactive',
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
    titleBlock: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
    },
    subtitle: {
        color: tokens.colorNeutralForeground2,
    },
    search: {
        minWidth: '240px',
        maxWidth: '360px',
        flexGrow: 1,
        '@media (max-width: 640px)': {
            maxWidth: '100%',
        },
    },
    toolbar: {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        paddingTop: tokens.spacingVerticalXS,
        paddingBottom: tokens.spacingVerticalXS,
        paddingLeft: tokens.spacingHorizontalS,
        paddingRight: tokens.spacingHorizontalS,
        backgroundColor: tokens.colorNeutralBackground2,
        borderRadius: tokens.borderRadiusMedium,
    },
    toolbarLabel: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXS,
        color: tokens.colorNeutralForeground2,
        fontWeight: tokens.fontWeightSemibold,
    },
    filterDropdown: {
        minWidth: '160px',
        '@media (max-width: 640px)': {
            minWidth: '100%',
        },
    },
    gridArea: {
        flexGrow: 1,
        minHeight: 0,
        overflow: 'auto',
        borderTopWidth: tokens.strokeWidthThin,
        borderRightWidth: tokens.strokeWidthThin,
        borderBottomWidth: tokens.strokeWidthThin,
        borderLeftWidth: tokens.strokeWidthThin,
        borderTopStyle: 'solid',
        borderRightStyle: 'solid',
        borderBottomStyle: 'solid',
        borderLeftStyle: 'solid',
        borderTopColor: tokens.colorNeutralStroke2,
        borderRightColor: tokens.colorNeutralStroke2,
        borderBottomColor: tokens.colorNeutralStroke2,
        borderLeftColor: tokens.colorNeutralStroke2,
        borderRadius: tokens.borderRadiusMedium,
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

function formattedValue(row: AccountRow, field: string): string {
    const value = (row as unknown as Record<string, unknown>)[`${field}${FORMATTED}`];
    return typeof value === 'string' ? value : '';
}

function textOf(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function compareText(a: string, b: string): number {
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function isActive(row: AccountRow): boolean {
    // statecode 0 = Active, 1 = Inactive for every Dataverse table with a state model.
    return Number(row.statecode) === 0;
}

function matchesSearch(row: AccountRow, term: string): boolean {
    if (!term) return true;
    const haystack = [
        textOf(row.name),
        textOf(row.accountnumber),
        textOf(row.address1_city),
        textOf(row.address1_country),
        textOf(row.emailaddress1),
        textOf(row.telephone1),
    ];
    return haystack.some((value) => value.toLowerCase().includes(term));
}

function matchesFilters(row: AccountRow, filters: Filters): boolean {
    if (filters.status === 'active' && !isActive(row)) return false;
    if (filters.status === 'inactive' && isActive(row)) return false;
    if (filters.industry !== ALL && formattedValue(row, 'industrycode') !== filters.industry) return false;
    if (filters.country !== ALL && textOf(row.address1_country) !== filters.country) return false;
    return true;
}

function distinctValues(rows: AccountRow[], pick: (row: AccountRow) => string): string[] {
    const values = new Set<string>();
    for (const row of rows) {
        const value = pick(row).trim();
        if (value) values.add(value);
    }
    return Array.from(values).sort(compareText);
}

function activeFilterCount(filters: Filters): number {
    return (filters.status !== 'all' ? 1 : 0) + (filters.industry !== ALL ? 1 : 0) + (filters.country !== ALL ? 1 : 0);
}

function readCache(): LoadedAccounts | undefined {
    return winAny[CACHE_KEY] as LoadedAccounts | undefined;
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
    name: { defaultWidth: 240, minWidth: 180 },
    accountnumber: { defaultWidth: 130, minWidth: 100 },
    industry: { defaultWidth: 170, minWidth: 130 },
    city: { defaultWidth: 140, minWidth: 110 },
    country: { defaultWidth: 140, minWidth: 110 },
    phone: { defaultWidth: 150, minWidth: 120 },
    email: { defaultWidth: 220, minWidth: 160 },
    status: { defaultWidth: 110, minWidth: 90 },
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
            columnId: 'industry',
            compare: (a, b) => compareText(formattedValue(a, 'industrycode'), formattedValue(b, 'industrycode')),
            renderHeaderCell: () => 'Industry',
            renderCell: (item) => <TextCell value={formattedValue(item, 'industrycode')} className={truncate} layoutClassName={cellLayout} />,
        }),
        createTableColumn<AccountRow>({
            columnId: 'city',
            compare: (a, b) => compareText(textOf(a.address1_city), textOf(b.address1_city)),
            renderHeaderCell: () => 'City',
            renderCell: (item) => <TextCell value={textOf(item.address1_city)} className={truncate} layoutClassName={cellLayout} />,
        }),
        createTableColumn<AccountRow>({
            columnId: 'country',
            compare: (a, b) => compareText(textOf(a.address1_country), textOf(b.address1_country)),
            renderHeaderCell: () => 'Country/Region',
            renderCell: (item) => <TextCell value={textOf(item.address1_country)} className={truncate} layoutClassName={cellLayout} />,
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
            columnId: 'status',
            compare: (a, b) => Number(a.statecode) - Number(b.statecode),
            renderHeaderCell: () => 'Status',
            renderCell: (item) => (
                <TableCellLayout>
                    <Badge appearance="tint" color={isActive(item) ? 'success' : 'informative'}>
                        {formattedValue(item, 'statecode') || (isActive(item) ? 'Active' : 'Inactive')}
                    </Badge>
                </TableCellLayout>
            ),
        }),
    ];
}

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // list page takes no input; destructured per the component contract
    const styles = useStyles();
    const dataReady = !!dataApi;

    // Overlay listboxes portal into this element instead of the designer's document.body (Rule 16).
    const [mountNode, setMountNode] = useState<HTMLElement | null>(null);
    const [{ rows, hasMoreRows, loading, error }, setData] = useState<LoadState>(() => {
        const cached = readCache();
        return cached
            ? { rows: cached.rows, hasMoreRows: cached.hasMoreRows, loading: false, error: null }
            : { rows: [], hasMoreRows: false, loading: true, error: null };
    });
    const [reloadKey, setReloadKey] = useState(0);
    const [search, setSearch] = useState('');
    const [filters, setFilters] = useState<Filters>(NO_FILTERS);

    useEffect(() => {
        if (!dataReady) return;

        const cached = readCache();
        if (cached !== undefined) {
            if (cached.rows !== rows) setData({ rows: cached.rows, hasMoreRows: cached.hasMoreRows, loading: false, error: null });
            return;
        }
        let cancelled = false;

        // One shared promise on window: the host double-mounts the page on open, and the second
        // mount must await this query rather than issue its own.
        let inflight = winAny[INFLIGHT_KEY] as Promise<LoadedAccounts> | undefined;
        if (!inflight) {
            const pending: Promise<LoadedAccounts> = (async () => {
                const result = await dataApi.queryTable('account', ACCOUNT_QUERY);
                const loaded: LoadedAccounts = { rows: result.rows, hasMoreRows: result.hasMoreRows };
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
                if (!cancelled) setData({ rows: loaded.rows, hasMoreRows: loaded.hasMoreRows, loading: false, error: null });
            } catch (err) {
                if (cancelled) return;
                const message = err instanceof Error ? err.message : 'Unable to load accounts.';
                setData({ rows: [], hasMoreRows: false, loading: false, error: message });
            }
        })();

        return () => {
            cancelled = true;
        };
        // Readiness and the manual reload key only: dataApi is a new reference on every render (Rule 15).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady, reloadKey]);

    const columns = useMemo(() => buildColumns(styles.truncate, styles.cellLayout), [styles.truncate, styles.cellLayout]);
    const industries = useMemo(() => distinctValues(rows, (row) => formattedValue(row, 'industrycode')), [rows]);
    const countries = useMemo(() => distinctValues(rows, (row) => textOf(row.address1_country)), [rows]);
    const visibleRows = useMemo(() => {
        const term = search.trim().toLowerCase();
        return rows.filter((row) => matchesSearch(row, term) && matchesFilters(row, filters));
    }, [rows, search, filters]);

    const filterCount = activeFilterCount(filters);

    const refresh = () => {
        delete winAny[CACHE_KEY];
        delete winAny[INFLIGHT_KEY];
        setData({ rows: [], hasMoreRows: false, loading: true, error: null });
        setReloadKey((key) => key + 1);
    };

    const clearFilters = () => setFilters(NO_FILTERS);

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
        <div className={styles.root} ref={setMountNode}>
            <header className={styles.header}>
                <div className={styles.titleBlock}>
                    <Text as="h1" size={700} weight="semibold">
                        Accounts
                    </Text>
                    <Text size={200} className={styles.subtitle}>
                        Search, filter and sort account records
                    </Text>
                </div>
                <SearchBox
                    className={styles.search}
                    placeholder="Search name, number, city, email or phone"
                    value={search}
                    onChange={(_, data) => setSearch(data.value ?? '')}
                    contentBefore={<SearchRegular />}
                    aria-label="Search accounts"
                />
            </header>

            <Toolbar className={styles.toolbar} aria-label="Account filters">
                <span className={styles.toolbarLabel}>
                    <FilterRegular aria-hidden="true" />
                    Filters
                    {filterCount > 0 && (
                        <Badge size="small" appearance="filled" color="brand" aria-label={`${filterCount} filters applied`}>
                            {filterCount}
                        </Badge>
                    )}
                </span>
                <Dropdown
                    className={styles.filterDropdown}
                    aria-label="Filter by status"
                    value={STATUS_LABELS[filters.status]}
                    selectedOptions={[filters.status]}
                    onOptionSelect={(_, data) =>
                        setFilters((prev) => ({ ...prev, status: (data.optionValue as StatusFilter | undefined) ?? 'all' }))
                    }
                    mountNode={mountNode}
                >
                    <Option value="all">All statuses</Option>
                    <Option value="active">Active</Option>
                    <Option value="inactive">Inactive</Option>
                </Dropdown>
                <Dropdown
                    className={styles.filterDropdown}
                    aria-label="Filter by industry"
                    value={filters.industry === ALL ? 'All industries' : filters.industry}
                    selectedOptions={[filters.industry]}
                    onOptionSelect={(_, data) => setFilters((prev) => ({ ...prev, industry: data.optionValue ?? ALL }))}
                    mountNode={mountNode}
                >
                    <Option value={ALL}>All industries</Option>
                    {industries.map((industry) => (
                        <Option key={industry} value={industry}>
                            {industry}
                        </Option>
                    ))}
                </Dropdown>
                <Dropdown
                    className={styles.filterDropdown}
                    aria-label="Filter by country or region"
                    value={filters.country === ALL ? 'All countries/regions' : filters.country}
                    selectedOptions={[filters.country]}
                    onOptionSelect={(_, data) => setFilters((prev) => ({ ...prev, country: data.optionValue ?? ALL }))}
                    mountNode={mountNode}
                >
                    <Option value={ALL}>All countries/regions</Option>
                    {countries.map((country) => (
                        <Option key={country} value={country}>
                            {country}
                        </Option>
                    ))}
                </Dropdown>
                <ToolbarDivider />
                <ToolbarButton icon={<FilterDismissRegular />} onClick={clearFilters} disabled={filterCount === 0}>
                    Clear filters
                </ToolbarButton>
                <ToolbarButton icon={<ArrowClockwiseRegular />} onClick={refresh} aria-label="Refresh accounts">
                    Refresh
                </ToolbarButton>
            </Toolbar>

            {error && (
                <MessageBar intent="error">
                    <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
            )}

            <div className={styles.gridArea}>
                {visibleRows.length === 0 ? (
                    <div className={styles.centered} role="status">
                        <Text>{rows.length === 0 ? 'No accounts found.' : 'No accounts match the current search and filters.'}</Text>
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
                {hasMoreRows ? ` (first ${PAGE_SIZE} by name — refine your search to narrow the list)` : ''}
            </Text>
        </div>
    );
};

export default GeneratedComponent;
