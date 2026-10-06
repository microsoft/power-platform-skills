import * as React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TableRow, ReadableTableRow, GeneratedComponentProps } from './RuntimeTypes';
import {
    makeStyles,
    tokens,
    Text,
    Card,
    CardHeader,
    Button,
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
import {
    ArrowClockwiseRegular,
    BuildingRegular,
    CalendarRegular,
    MoneyRegular,
    PeopleTeamRegular,
} from '@fluentui/react-icons';
import * as d3 from 'd3';

// Columns verified against RuntimeTypes.ts (generate-types --data-sources 'account').
type AccountRow = TableRow<{
    readonly accountid: string;
    name?: string;
    industrycode?: number;
    revenue?: number;
    numberofemployees?: number;
    address1_city?: string;
    readonly createdon?: string;
}>;

type ReadableAccount = ReadableTableRow<AccountRow>;
type AccountDataApi = GeneratedComponentProps['dataApi'];

interface AccountSnapshot {
    rows: ReadableAccount[];
    truncated: boolean;
}

interface BarDatum {
    label: string;
    value: number;
}

interface AccountMetrics {
    activeCount: number;
    totalRevenue: number;
    averageEmployees: number;
    newLast90Days: number;
}

interface XrmLike {
    Navigation?: {
        navigateTo: (pageInput: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
    };
}

// ---------- Window cache + in-flight de-dupe (references/data-caching.md) ----------
// Keys are scoped to this page + query so another page reading `account` never shares them.
const CACHE_KEY = '__ppAccountMetrics_accountCache';
const INFLIGHT_KEY = '__ppAccountMetrics_accountInflight';
const winAny = window as unknown as Record<string, unknown>;

const PAGE_SIZE = 500;
const MAX_ACCOUNTS = 5000;
const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
const EMPTY_SNAPSHOT: AccountSnapshot = { rows: [], truncated: false };

async function fetchActiveAccounts(dataApi: AccountDataApi): Promise<AccountSnapshot> {
    let page = await dataApi.queryTable('account', {
        select: ['accountid', 'name', 'industrycode', 'revenue', 'numberofemployees', 'address1_city', 'createdon'],
        filter: 'statecode eq 0',
        orderBy: 'revenue desc',
        pageSize: PAGE_SIZE,
    });
    const rows = [...(page.rows as unknown as ReadableAccount[])];
    while (page.hasMoreRows && page.loadMoreRows && rows.length < MAX_ACCOUNTS) {
        page = await page.loadMoreRows();
        rows.push(...(page.rows as unknown as ReadableAccount[]));
    }
    return { rows, truncated: page.hasMoreRows };
}

function loadAccounts(dataApi: AccountDataApi): Promise<AccountSnapshot> {
    const pending = winAny[INFLIGHT_KEY] as Promise<AccountSnapshot> | undefined;
    if (pending) return pending;
    const inflight: Promise<AccountSnapshot> = fetchActiveAccounts(dataApi)
        .then((snapshot) => {
            winAny[CACHE_KEY] = snapshot;
            return snapshot;
        })
        // Clear only if still ours — a manual refresh may already have replaced it.
        .finally(() => {
            if (winAny[INFLIGHT_KEY] === inflight) delete winAny[INFLIGHT_KEY];
        });
    winAny[INFLIGHT_KEY] = inflight;
    return inflight;
}

// ---------- Derivations ----------

function formattedValue(row: ReadableAccount, column: string): string | undefined {
    const value = (row as unknown as Record<string, unknown>)[`${column}${FORMATTED}`];
    return typeof value === 'string' && value ? value : undefined;
}

function toDate(value: unknown): Date | null {
    if (value instanceof Date) return value;
    if (typeof value !== 'string' || !value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function industryLabel(row: ReadableAccount): string {
    return formattedValue(row, 'industrycode') ?? 'Not specified';
}

function computeMetrics(rows: ReadableAccount[], now: Date): AccountMetrics {
    const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const withEmployees = rows.filter((r) => typeof r.numberofemployees === 'number');
    return {
        activeCount: rows.length,
        totalRevenue: d3.sum(rows, (r) => r.revenue ?? 0),
        averageEmployees: withEmployees.length ? d3.mean(withEmployees, (r) => r.numberofemployees ?? 0) ?? 0 : 0,
        newLast90Days: rows.filter((r) => {
            const created = toDate(r.createdon);
            return created !== null && created >= cutoff;
        }).length,
    };
}

function industryBreakdown(rows: ReadableAccount[]): BarDatum[] {
    const counts = d3.rollups(rows, (group) => group.length, industryLabel)
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value);
    if (counts.length <= 8) return counts;
    const rest = d3.sum(counts.slice(7), (d) => d.value);
    return [...counts.slice(0, 7), { label: 'All other industries', value: rest }];
}

function newAccountsByMonth(rows: ReadableAccount[], now: Date): BarDatum[] {
    const monthKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;
    const counts = d3.rollup(
        rows.map((r) => toDate(r.createdon)).filter((d): d is Date => d !== null),
        (group) => group.length,
        monthKey,
    );
    const months: BarDatum[] = [];
    for (let offset = 11; offset >= 0; offset -= 1) {
        const month = new Date(now.getFullYear(), now.getMonth() - offset, 1);
        months.push({
            label: month.toLocaleString('en-US', { month: 'short', year: '2-digit' }),
            value: counts.get(monthKey(month)) ?? 0,
        });
    }
    return months;
}

function formatCompact(value: number): string {
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function openAccount(accountId: string): void {
    const xrm = (window as unknown as { Xrm?: XrmLike }).Xrm;
    xrm?.Navigation?.navigateTo({ pageType: 'entityrecord', entityName: 'account', entityId: accountId }, { target: 1 })
        .catch(() => undefined);
}

// ---------- Styles ----------

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalL,
        padding: tokens.spacingHorizontalXL,
        width: '100%',
        boxSizing: 'border-box',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalM,
    },
    titleBlock: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
    subtitle: { color: tokens.colorNeutralForeground3 },
    centered: { display: 'flex', justifyContent: 'center', padding: tokens.spacingVerticalXXL },
    kpiRow: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: tokens.spacingHorizontalM,
    },
    kpiCard: { padding: tokens.spacingHorizontalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
    kpiLabel: { color: tokens.colorNeutralForeground2 },
    kpiValue: { fontSize: tokens.fontSizeHero800, fontWeight: tokens.fontWeightSemibold },
    chartGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: tokens.spacingHorizontalL,
        '@media (max-width: 900px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
    },
    card: { padding: tokens.spacingHorizontalL },
    chartSvg: { width: '100%', height: '260px' },
    emptyChart: { color: tokens.colorNeutralForeground3, padding: tokens.spacingVerticalL },
    nameCell: { overflow: 'hidden', minWidth: 0 },
    nameButton: {
        display: 'block',
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: 'start',
    },
});

// ---------- KPI card ----------

interface KpiCardProps {
    icon: React.ReactElement;
    label: string;
    value: string;
}

const KpiCard = (props: KpiCardProps) => {
    const styles = useStyles();
    return (
        <Card className={styles.kpiCard} aria-label={`${props.label}: ${props.value}`}>
            <CardHeader image={props.icon} header={<Text className={styles.kpiLabel}>{props.label}</Text>} />
            <Text className={styles.kpiValue}>{props.value}</Text>
        </Card>
    );
};

// ---------- D3 charts ----------
// The window flag stores the data signature the chart last drew: the first draw animates, a remount
// with the same data returns early, and a refresh with new data redraws without replaying the animation.

function chartGuard(svgNode: SVGSVGElement, animKey: string, signature: string): { skip: boolean; animate: boolean } {
    const w = window as unknown as Record<string, string | undefined>;
    if (w[animKey] === signature && d3.select(svgNode).selectAll('rect.bar').size() > 0) {
        return { skip: true, animate: false };
    }
    const animate = w[animKey] === undefined;
    w[animKey] = signature;
    return { skip: false, animate };
}

interface ChartProps {
    data: BarDatum[];
    animKey: string;
    ariaLabel: string;
    unit: string;
}

const IndustryBarChart = (props: ChartProps) => {
    const styles = useStyles();
    const svgRef = useRef<SVGSVGElement>(null);
    const { data, animKey, ariaLabel, unit } = props;
    const signature = data.map((d) => `${d.label}:${d.value}`).join('|');

    useEffect(() => {
        const node = svgRef.current;
        if (!node) return;
        const guard = chartGuard(node, animKey, signature);
        if (guard.skip) return;
        const svg = d3.select(node);
        svg.selectAll('*').remove();

        const rect = node.getBoundingClientRect();
        const width = rect.width || 420;
        const height = rect.height || 260;
        const margin = { top: 4, right: 40, bottom: 4, left: 150 };
        const innerW = width - margin.left - margin.right;
        const innerH = height - margin.top - margin.bottom;
        const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

        const y = d3.scaleBand<string>().domain(data.map((d) => d.label)).range([0, innerH]).padding(0.25);
        const x = d3.scaleLinear().domain([0, d3.max(data, (d) => d.value) ?? 0]).range([0, innerW]);

        g.selectAll('text.bar-label')
            .data(data)
            .enter()
            .append('text')
            .attr('class', 'bar-label')
            .attr('x', -8)
            .attr('y', (d) => (y(d.label) ?? 0) + y.bandwidth() / 2)
            .attr('dy', '0.35em')
            .attr('text-anchor', 'end')
            .attr('font-size', '12px')
            .style('fill', tokens.colorNeutralForeground2)
            .text((d) => (d.label.length > 22 ? `${d.label.slice(0, 21)}…` : d.label));

        const bars = g.selectAll('rect.bar')
            .data(data)
            .enter()
            .append('rect')
            .attr('class', 'bar')
            .attr('x', 0)
            .attr('y', (d) => y(d.label) ?? 0)
            .attr('height', y.bandwidth())
            .attr('rx', 2)
            .style('fill', tokens.colorBrandBackground)
            .attr('width', (d) => (guard.animate ? 0 : x(d.value)));
        bars.append('title').text((d) => `${d.label}: ${d.value.toLocaleString('en-US')} ${unit}`);
        if (guard.animate) bars.transition().duration(400).attr('width', (d) => x(d.value));

        g.selectAll('text.bar-value')
            .data(data)
            .enter()
            .append('text')
            .attr('class', 'bar-value')
            .attr('x', (d) => x(d.value) + 6)
            .attr('y', (d) => (y(d.label) ?? 0) + y.bandwidth() / 2)
            .attr('dy', '0.35em')
            .attr('font-size', '12px')
            .style('fill', tokens.colorNeutralForeground1)
            .text((d) => d.value.toLocaleString('en-US'));
    }, [signature, animKey]);

    return <svg ref={svgRef} className={styles.chartSvg} role="img" aria-label={ariaLabel} />;
};

const MonthlyColumnChart = (props: ChartProps) => {
    const styles = useStyles();
    const svgRef = useRef<SVGSVGElement>(null);
    const { data, animKey, ariaLabel, unit } = props;
    const signature = data.map((d) => `${d.label}:${d.value}`).join('|');

    useEffect(() => {
        const node = svgRef.current;
        if (!node) return;
        const guard = chartGuard(node, animKey, signature);
        if (guard.skip) return;
        const svg = d3.select(node);
        svg.selectAll('*').remove();

        const rect = node.getBoundingClientRect();
        const width = rect.width || 420;
        const height = rect.height || 260;
        const margin = { top: 12, right: 12, bottom: 28, left: 36 };
        const innerW = width - margin.left - margin.right;
        const innerH = height - margin.top - margin.bottom;
        const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

        const x = d3.scaleBand<string>().domain(data.map((d) => d.label)).range([0, innerW]).padding(0.2);
        const y = d3.scaleLinear().domain([0, Math.max(1, d3.max(data, (d) => d.value) ?? 0)]).nice().range([innerH, 0]);

        g.append('g')
            .attr('transform', `translate(0,${innerH})`)
            .call(d3.axisBottom(x).tickValues(x.domain().filter((_, i) => i % 2 === 1)))
            .style('color', tokens.colorNeutralForeground3);
        g.append('g')
            .call(d3.axisLeft(y).ticks(4).tickFormat(d3.format('d')))
            .style('color', tokens.colorNeutralForeground3);

        const bars = g.selectAll('rect.bar')
            .data(data)
            .enter()
            .append('rect')
            .attr('class', 'bar')
            .attr('x', (d) => x(d.label) ?? 0)
            .attr('width', x.bandwidth())
            .attr('rx', 2)
            .style('fill', tokens.colorPaletteTealBorderActive)
            .attr('y', (d) => (guard.animate ? innerH : y(d.value)))
            .attr('height', (d) => (guard.animate ? 0 : innerH - y(d.value)));
        bars.append('title').text((d) => `${d.label}: ${d.value.toLocaleString('en-US')} ${unit}`);
        if (guard.animate) {
            bars.transition()
                .duration(400)
                .attr('y', (d) => y(d.value))
                .attr('height', (d) => innerH - y(d.value));
        }
    }, [signature, animKey]);

    return <svg ref={svgRef} className={styles.chartSvg} role="img" aria-label={ariaLabel} />;
};

// ---------- Top accounts grid ----------

const topAccountColumns = [
    createTableColumn<ReadableAccount>({
        columnId: 'name',
        compare: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
        renderHeaderCell: () => 'Account',
        renderCell: (item) => <TableCellLayout>{item.name ?? '(no name)'}</TableCellLayout>,
    }),
    createTableColumn<ReadableAccount>({
        columnId: 'industry',
        compare: (a, b) => industryLabel(a).localeCompare(industryLabel(b)),
        renderHeaderCell: () => 'Industry',
        renderCell: (item) => <TableCellLayout>{industryLabel(item)}</TableCellLayout>,
    }),
    createTableColumn<ReadableAccount>({
        columnId: 'city',
        compare: (a, b) => (a.address1_city ?? '').localeCompare(b.address1_city ?? ''),
        renderHeaderCell: () => 'City',
        renderCell: (item) => <TableCellLayout>{item.address1_city ?? '—'}</TableCellLayout>,
    }),
    createTableColumn<ReadableAccount>({
        columnId: 'employees',
        compare: (a, b) => (a.numberofemployees ?? 0) - (b.numberofemployees ?? 0),
        renderHeaderCell: () => 'Employees',
        renderCell: (item) => (
            <TableCellLayout>{item.numberofemployees !== undefined ? item.numberofemployees.toLocaleString('en-US') : '—'}</TableCellLayout>
        ),
    }),
    createTableColumn<ReadableAccount>({
        columnId: 'revenue',
        compare: (a, b) => (a.revenue ?? 0) - (b.revenue ?? 0),
        renderHeaderCell: () => 'Annual revenue',
        renderCell: (item) => (
            <TableCellLayout>{formattedValue(item, 'revenue') ?? (item.revenue !== undefined ? formatCompact(item.revenue) : '—')}</TableCellLayout>
        ),
    }),
];

const topAccountSizing = {
    name: { defaultWidth: 240, minWidth: 160 },
    industry: { defaultWidth: 180, minWidth: 120 },
    city: { defaultWidth: 140, minWidth: 100 },
    employees: { defaultWidth: 120, minWidth: 90 },
    revenue: { defaultWidth: 150, minWidth: 110 },
};

const TopAccountsGrid = (props: { accounts: ReadableAccount[] }) => {
    const styles = useStyles();
    return (
        <DataGrid
            items={props.accounts}
            columns={topAccountColumns}
            getRowId={(item) => item.accountid}
            sortable
            resizableColumns
            columnSizingOptions={topAccountSizing}
            aria-label="Top accounts by annual revenue"
        >
            <DataGridHeader>
                <DataGridRow>
                    {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
                </DataGridRow>
            </DataGridHeader>
            <DataGridBody<ReadableAccount>>
                {({ item, rowId }) => (
                    <DataGridRow<ReadableAccount> key={rowId}>
                        {({ renderCell, columnId }) =>
                            columnId === 'name' ? (
                                <DataGridCell>
                                    <TableCellLayout className={styles.nameCell}>
                                        <Button
                                            appearance="transparent"
                                            className={styles.nameButton}
                                            title={item.name}
                                            aria-label={`Open account ${item.name ?? ''}`}
                                            onClick={() => openAccount(item.accountid)}
                                        >
                                            {item.name ?? '(no name)'}
                                        </Button>
                                    </TableCellLayout>
                                </DataGridCell>
                            ) : (
                                <DataGridCell>{renderCell(item)}</DataGridCell>
                            )
                        }
                    </DataGridRow>
                )}
            </DataGridBody>
        </DataGrid>
    );
};

// ---------- Page ----------

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // dashboard takes no page input; destructured per rules
    const styles = useStyles();
    const dataReady = !!dataApi;
    const [reloadKey, setReloadKey] = useState(0);
    const [data, setData] = useState<{ snapshot: AccountSnapshot; loading: boolean; error: string | null }>(() => {
        const cached = winAny[CACHE_KEY] as AccountSnapshot | undefined;
        return { snapshot: cached ?? EMPTY_SNAPSHOT, loading: cached === undefined, error: null };
    });

    useEffect(() => {
        if (!dataReady) return;
        const cached = winAny[CACHE_KEY] as AccountSnapshot | undefined;
        if (cached !== undefined) {
            if (data.snapshot !== cached || data.loading) setData({ snapshot: cached, loading: false, error: null });
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const snapshot = await loadAccounts(dataApi);
                if (!cancelled) setData({ snapshot, loading: false, error: null });
            } catch (err) {
                if (cancelled) return;
                const message = err instanceof Error ? err.message : 'Unable to load accounts.';
                setData({ snapshot: EMPTY_SNAPSHOT, loading: false, error: message });
            }
        })();
        return () => {
            cancelled = true;
        };
        // Readiness and manual refresh only — never `dataApi`, which is a new reference every render (Rule 15).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady, reloadKey]);

    // All hooks stay above the early returns below (Rule 19).
    const rows = data.snapshot.rows;
    const metrics = useMemo(() => computeMetrics(rows, new Date()), [rows]);
    const industries = useMemo(() => industryBreakdown(rows), [rows]);
    const monthly = useMemo(() => newAccountsByMonth(rows, new Date()), [rows]);
    const topAccounts = useMemo(
        () => rows.filter((r) => typeof r.revenue === 'number').sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0)).slice(0, 10),
        [rows],
    );

    const refresh = () => {
        delete winAny[CACHE_KEY];
        delete winAny[INFLIGHT_KEY];
        setData({ snapshot: data.snapshot, loading: true, error: null });
        setReloadKey((key) => key + 1);
    };

    if (data.loading) {
        return (
            <div className={styles.root}>
                <div className={styles.centered}>
                    <Spinner labelPosition="below" label="Loading account metrics…" />
                </div>
            </div>
        );
    }

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <div className={styles.titleBlock}>
                    <Text as="h1" size={700} weight="semibold">Account metrics</Text>
                    <Text className={styles.subtitle}>Active accounts in this environment</Text>
                </div>
                <Button icon={<ArrowClockwiseRegular />} onClick={refresh}>Refresh</Button>
            </header>

            {data.error && (
                <MessageBar intent="error">
                    <MessageBarBody>{data.error}</MessageBarBody>
                </MessageBar>
            )}
            {data.snapshot.truncated && (
                <MessageBar intent="info">
                    <MessageBarBody>Metrics cover the first {MAX_ACCOUNTS.toLocaleString('en-US')} active accounts.</MessageBarBody>
                </MessageBar>
            )}

            <section className={styles.kpiRow} aria-label="Account summary">
                <KpiCard icon={<BuildingRegular />} label="Active accounts" value={metrics.activeCount.toLocaleString('en-US')} />
                <KpiCard icon={<MoneyRegular />} label="Total annual revenue" value={formatCompact(metrics.totalRevenue)} />
                <KpiCard icon={<PeopleTeamRegular />} label="Average employees" value={Math.round(metrics.averageEmployees).toLocaleString('en-US')} />
                <KpiCard icon={<CalendarRegular />} label="New in last 90 days" value={metrics.newLast90Days.toLocaleString('en-US')} />
            </section>

            <section className={styles.chartGrid} aria-label="Account charts">
                <Card className={styles.card}>
                    <CardHeader header={<Text weight="semibold">Accounts by industry</Text>} description="Active accounts per industry" />
                    {rows.length ? (
                        <IndustryBarChart data={industries} animKey="__ppAccountMetricsIndustryAnimated" ariaLabel="Active accounts by industry" unit="accounts" />
                    ) : (
                        <Text className={styles.emptyChart}>No active accounts yet.</Text>
                    )}
                </Card>
                <Card className={styles.card}>
                    <CardHeader header={<Text weight="semibold">New accounts by month</Text>} description="Accounts created in the last 12 months" />
                    {rows.length ? (
                        <MonthlyColumnChart data={monthly} animKey="__ppAccountMetricsMonthlyAnimated" ariaLabel="New accounts created per month over the last 12 months" unit="new accounts" />
                    ) : (
                        <Text className={styles.emptyChart}>No active accounts yet.</Text>
                    )}
                </Card>
            </section>

            <Card className={styles.card}>
                <CardHeader header={<Text weight="semibold">Top accounts by annual revenue</Text>} description="Select an account to open its record" />
                {topAccounts.length ? (
                    <TopAccountsGrid accounts={topAccounts} />
                ) : (
                    <Text className={styles.emptyChart}>No accounts have annual revenue recorded.</Text>
                )}
            </Card>
        </div>
    );
};

export default GeneratedComponent;
