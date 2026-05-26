import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
    makeStyles,
    tokens,
    Text,
    Badge,
    DataGrid,
    DataGridHeader,
    DataGridHeaderCell,
    DataGridBody,
    DataGridRow,
    DataGridCell,
    TableCellLayout,
    createTableColumn,
    webDarkTheme,
} from '@fluentui/react-components';
import type { TableColumnDefinition } from '@fluentui/react-components';
import {
    ArrowTrendingRegular,
    PeopleRegular,
    MoneyRegular,
    TargetRegular,
} from '@fluentui/react-icons';
import * as d3 from 'd3';

// ── Theme helpers ──────────────────────────────────────────────────────────────

function themeToVars(theme: Record<string, string>): CSSProperties {
    const vars: Record<string, string> = {};
    Object.entries(theme).forEach(([k, v]) => { vars[`--${k}`] = v; });
    return vars as CSSProperties;
}

// Custom dark-palette constants — these are intentionally distinct from the
// Fluent webDarkTheme neutrals to match the GitHub-dark-inspired design spec.
const PAGE_BG = '#0d1117';
const CARD_BG = '#161b22';
const BORDER_COLOR = '#30363d';
const ACCENT = '#00bcd4';
const ACCENT_HOVER = '#26d8f2';
const TEXT_PRIMARY = '#e6edf3';
const TEXT_SECONDARY = '#8b949e';

// ── Mock data ──────────────────────────────────────────────────────────────────

interface MonthRevenue {
    month: string;
    revenue: number;
}

interface Customer {
    id: string;
    name: string;
    revenue: number;
    dealCount: number;
    region: string;
    status: 'Active' | 'Inactive';
}

interface KpiItem {
    id: string;
    label: string;
    value: string;
    delta: number;
    icon: ReactNode;
}

interface TooltipState {
    visible: boolean;
    x: number;
    y: number;
    month: string;
    value: number;
}

const revenueData: MonthRevenue[] = [
    { month: 'Jan', revenue: 180000 },
    { month: 'Feb', revenue: 210000 },
    { month: 'Mar', revenue: 290000 },
    { month: 'Apr', revenue: 340000 },
    { month: 'May', revenue: 410000 },
    { month: 'Jun', revenue: 380000 },
    { month: 'Jul', revenue: 450000 },
    { month: 'Aug', revenue: 510000 },
    { month: 'Sep', revenue: 490000 },
    { month: 'Oct', revenue: 570000 },
    { month: 'Nov', revenue: 600000 },
    { month: 'Dec', revenue: 620000 },
];

const customerData: Customer[] = [
    { id: '1', name: 'Contoso Ltd',       revenue: 820000, dealCount: 14, region: 'North America', status: 'Active'   },
    { id: '2', name: 'Fabrikam Inc',       revenue: 740000, dealCount: 11, region: 'Europe',        status: 'Active'   },
    { id: '3', name: 'Northwind Traders',  revenue: 610000, dealCount:  9, region: 'Asia Pacific',  status: 'Active'   },
    { id: '4', name: 'Adventure Works',    revenue: 480000, dealCount:  7, region: 'North America', status: 'Inactive' },
    { id: '5', name: 'Tailspin Toys',      revenue: 370000, dealCount:  6, region: 'Europe',        status: 'Active'   },
];

const kpiItems: KpiItem[] = [
    { id: 'revenue',   label: 'Total revenue (YTD)', value: '$3.82M', delta:  8.4, icon: <ArrowTrendingRegular /> },
    { id: 'customers', label: 'Active customers',    value: '248',    delta:  5.1, icon: <PeopleRegular />        },
    { id: 'deal-size', label: 'Avg deal size',       value: '$87.5K', delta: -2.3, icon: <MoneyRegular />         },
    { id: 'win-rate',  label: 'Win rate',            value: '64%',    delta:  3.7, icon: <TargetRegular />        },
];

// ── Format helpers ─────────────────────────────────────────────────────────────

function formatCurrency(value: number): string {
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000)     return `$${(value / 1_000).toFixed(0)}K`;
    return `$${value}`;
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalL,
        padding: `${tokens.spacingVerticalXL} ${tokens.spacingHorizontalXL}`,
        backgroundColor: PAGE_BG,
        minHeight: '100%',
        boxSizing: 'border-box',
        color: TEXT_PRIMARY,
    },
    pageTitle: {
        color: TEXT_PRIMARY,
    },
    // KPI tiles
    kpiGrid: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalM,
    },
    kpiTile: {
        flex: '1 1 180px',
        backgroundColor: CARD_BG,
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: '8px',
        padding: tokens.spacingHorizontalL,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXS,
        boxSizing: 'border-box',
    },
    kpiIconRow: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
    },
    kpiIconWrap: {
        color: ACCENT,
        display: 'flex',
        alignItems: 'center',
        fontSize: '18px',
    },
    kpiLabel: {
        color: TEXT_SECONDARY,
        fontSize: tokens.fontSizeBase200,
    },
    kpiValue: {
        color: TEXT_PRIMARY,
        fontSize: tokens.fontSizeHero700,
        fontWeight: tokens.fontWeightSemibold,
        lineHeight: '1.2',
    },
    kpiAccentBar: {
        height: '2px',
        width: '28px',
        backgroundColor: ACCENT,
        borderRadius: '1px',
        marginTop: tokens.spacingVerticalXS,
    },
    // Section cards
    sectionCard: {
        backgroundColor: CARD_BG,
        border: `1px solid ${BORDER_COLOR}`,
        borderRadius: '8px',
        padding: tokens.spacingHorizontalL,
        boxSizing: 'border-box',
    },
    sectionTitle: {
        color: TEXT_PRIMARY,
        display: 'block',
        marginBottom: tokens.spacingVerticalXS,
    },
    sectionSubtitle: {
        color: TEXT_SECONDARY,
        fontSize: tokens.fontSizeBase200,
        display: 'block',
        marginBottom: tokens.spacingVerticalM,
    },
    // Chart
    chartWrapper: {
        position: 'relative',
    },
    chartSvg: {
        width: '100%',
        height: '280px',
        display: 'block',
    },
    // Table
    tableWrapper: {
        overflowX: 'auto',
    },
    customerName: {
        color: TEXT_PRIMARY,
        fontWeight: tokens.fontWeightSemibold,
        display: 'block',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    revenueValue: {
        color: ACCENT,
        fontWeight: tokens.fontWeightSemibold,
        fontVariantNumeric: 'tabular-nums',
    },
});

// ── KpiTile ────────────────────────────────────────────────────────────────────

interface KpiTileProps {
    item: KpiItem;
}

const KpiTile = ({ item }: KpiTileProps) => {
    const styles = useStyles();
    const isPositive = item.delta >= 0;
    const deltaColor = isPositive ? '#3fb950' : '#f85149';
    return (
        <div
            className={styles.kpiTile}
            role="figure"
            aria-label={`${item.label}: ${item.value}, ${isPositive ? '+' : ''}${item.delta.toFixed(1)}% vs last month`}
        >
            <div className={styles.kpiIconRow}>
                <span className={styles.kpiIconWrap}>{item.icon}</span>
                <Text className={styles.kpiLabel}>{item.label}</Text>
            </div>
            <Text className={styles.kpiValue}>{item.value}</Text>
            <Text style={{ color: deltaColor, fontSize: '12px' }}>
                {isPositive ? '▲' : '▼'} {Math.abs(item.delta).toFixed(1)}% vs last month
            </Text>
            <div className={styles.kpiAccentBar} />
        </div>
    );
};

// ── RevenueBarChart ────────────────────────────────────────────────────────────

// Window flag prevents animation replay on module re-evaluation (rules.md Charts).
const REVENUE_ANIM_KEY = '__ppSalesDashRevenueAnimated';

const RevenueBarChart = () => {
    const styles = useStyles();
    const svgRef = useRef<SVGSVGElement>(null);
    const [tooltip, setTooltip] = useState<TooltipState>({ visible: false, x: 0, y: 0, month: '', value: 0 });
    // Keep a stable ref so D3 event closures can call setTooltip without stale capture.
    const setTooltipRef = useRef(setTooltip);
    setTooltipRef.current = setTooltip;

    useEffect(() => {
        const node = svgRef.current;
        if (!node) return;
        const svg = d3.select(node);
        const w = window as Record<string, unknown>;

        if (w[REVENUE_ANIM_KEY] && svg.selectAll<SVGRectElement, unknown>('rect.bar').size() > 0) return;
        const shouldAnimate = !w[REVENUE_ANIM_KEY];
        w[REVENUE_ANIM_KEY] = true;

        svg.selectAll('*').remove();

        const bbox = node.getBoundingClientRect();
        const width = bbox.width || 640;
        const height = bbox.height || 280;
        const margin = { top: 20, right: 16, bottom: 40, left: 68 };
        const innerW = width - margin.left - margin.right;
        const innerH = height - margin.top - margin.bottom;

        const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

        const x = d3.scaleBand()
            .domain(revenueData.map(d => d.month))
            .range([0, innerW])
            .padding(0.35);

        const maxRev = d3.max(revenueData, d => d.revenue) ?? 0;
        const y = d3.scaleLinear().domain([0, maxRev * 1.15]).range([innerH, 0]);

        // Horizontal grid lines
        g.append('g')
            .call(
                d3.axisLeft(y)
                    .ticks(5)
                    .tickSize(-innerW)
                    .tickFormat(() => '')
            )
            .call(sel => sel.select('.domain').remove())
            .call(sel =>
                sel.selectAll<SVGLineElement, unknown>('.tick line')
                    .attr('stroke', BORDER_COLOR)
                    .attr('stroke-dasharray', '4,4')
            );

        // Y axis
        g.append('g')
            .call(d3.axisLeft(y).ticks(5).tickFormat(d => formatCurrency(d as number)))
            .call(sel => sel.select('.domain').attr('stroke', BORDER_COLOR))
            .call(sel =>
                sel.selectAll<SVGTextElement, unknown>('text')
                    .attr('fill', TEXT_SECONDARY)
                    .attr('font-size', '11px')
            );

        // X axis
        g.append('g')
            .attr('transform', `translate(0,${innerH})`)
            .call(d3.axisBottom(x))
            .call(sel => sel.select('.domain').attr('stroke', BORDER_COLOR))
            .call(sel =>
                sel.selectAll<SVGTextElement, unknown>('text')
                    .attr('fill', TEXT_SECONDARY)
                    .attr('font-size', '11px')
            );

        // Bars
        const bars = g.selectAll<SVGRectElement, MonthRevenue>('rect.bar')
            .data(revenueData)
            .enter()
            .append('rect')
            .attr('class', 'bar')
            .attr('x', d => x(d.month) ?? 0)
            .attr('width', x.bandwidth())
            .attr('fill', ACCENT)
            .attr('rx', 3)
            .attr('ry', 3)
            .style('cursor', 'pointer');

        if (shouldAnimate) {
            bars
                .attr('y', innerH)
                .attr('height', 0)
                .transition()
                .duration(600)
                .delay((_, i) => i * 40)
                .attr('y', d => y(d.revenue))
                .attr('height', d => innerH - y(d.revenue));
        } else {
            bars
                .attr('y', d => y(d.revenue))
                .attr('height', d => innerH - y(d.revenue));
        }

        // Hover — update after transitions so event handler binds to final elements
        bars
            .on('mouseover', function(event: MouseEvent, d: MonthRevenue) {
                d3.select(this).attr('fill', ACCENT_HOVER);
                const svgRect = svgRef.current?.getBoundingClientRect();
                if (!svgRect) return;
                setTooltipRef.current({
                    visible: true,
                    x: event.clientX - svgRect.left,
                    y: event.clientY - svgRect.top,
                    month: d.month,
                    value: d.revenue,
                });
            })
            .on('mouseout', function() {
                d3.select(this).attr('fill', ACCENT);
                setTooltipRef.current({ visible: false, x: 0, y: 0, month: '', value: 0 });
            });

    }, []);

    return (
        <div className={styles.chartWrapper}>
            <svg
                ref={svgRef}
                className={styles.chartSvg}
                role="img"
                aria-label="Monthly revenue bar chart, Jan to Dec 2025"
            />
            {tooltip.visible && (
                <div
                    style={{
                        position: 'absolute',
                        left: tooltip.x + 14,
                        top: tooltip.y - 44,
                        background: PAGE_BG,
                        border: `1px solid ${BORDER_COLOR}`,
                        borderRadius: '6px',
                        padding: '6px 12px',
                        pointerEvents: 'none',
                        color: TEXT_PRIMARY,
                        fontSize: '12px',
                        whiteSpace: 'nowrap',
                        zIndex: 10,
                        boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
                    }}
                >
                    <strong style={{ color: ACCENT }}>{tooltip.month} 2025</strong>
                    {' — '}
                    {formatCurrency(tooltip.value)}
                </div>
            )}
        </div>
    );
};

// ── CustomersTable ─────────────────────────────────────────────────────────────

const CustomersTable = () => {
    const styles = useStyles();
    const [sortColumn, setSortColumn] = useState<string>('revenue');
    const [sortDirection, setSortDirection] = useState<'ascending' | 'descending'>('descending');

    const sortedData = [...customerData].sort((a, b) => {
        const dir = sortDirection === 'ascending' ? 1 : -1;
        switch (sortColumn) {
            case 'name':      return dir * a.name.localeCompare(b.name);
            case 'revenue':   return dir * (a.revenue - b.revenue);
            case 'dealCount': return dir * (a.dealCount - b.dealCount);
            case 'region':    return dir * a.region.localeCompare(b.region);
            case 'status':    return dir * a.status.localeCompare(b.status);
            default:          return 0;
        }
    });

    const columns: TableColumnDefinition<Customer>[] = [
        createTableColumn<Customer>({
            columnId: 'name',
            compare: (a, b) => a.name.localeCompare(b.name),
            renderHeaderCell: () => 'Customer',
            renderCell: (item) => (
                <TableCellLayout style={{ overflow: 'hidden', minWidth: 0 }}>
                    <Text className={styles.customerName} title={item.name}>
                        {item.name}
                    </Text>
                </TableCellLayout>
            ),
        }),
        createTableColumn<Customer>({
            columnId: 'revenue',
            compare: (a, b) => a.revenue - b.revenue,
            renderHeaderCell: () => 'Revenue',
            renderCell: (item) => (
                <TableCellLayout>
                    <Text className={styles.revenueValue}>{formatCurrency(item.revenue)}</Text>
                </TableCellLayout>
            ),
        }),
        createTableColumn<Customer>({
            columnId: 'dealCount',
            compare: (a, b) => a.dealCount - b.dealCount,
            renderHeaderCell: () => 'Deals',
            renderCell: (item) => (
                <TableCellLayout>
                    <Text style={{ color: TEXT_PRIMARY, fontVariantNumeric: 'tabular-nums' }}>
                        {item.dealCount}
                    </Text>
                </TableCellLayout>
            ),
        }),
        createTableColumn<Customer>({
            columnId: 'region',
            compare: (a, b) => a.region.localeCompare(b.region),
            renderHeaderCell: () => 'Region',
            renderCell: (item) => (
                <TableCellLayout>
                    <Badge appearance="tint" color="informative" shape="rounded">
                        {item.region}
                    </Badge>
                </TableCellLayout>
            ),
        }),
        createTableColumn<Customer>({
            columnId: 'status',
            compare: (a, b) => a.status.localeCompare(b.status),
            renderHeaderCell: () => 'Status',
            renderCell: (item) => (
                <TableCellLayout>
                    <Badge
                        appearance="filled"
                        color={item.status === 'Active' ? 'success' : 'danger'}
                        shape="rounded"
                    >
                        {item.status}
                    </Badge>
                </TableCellLayout>
            ),
        }),
    ];

    const columnSizingOptions = {
        name:      { defaultWidth: 220, minWidth: 140 },
        revenue:   { defaultWidth: 140, minWidth: 100 },
        dealCount: { defaultWidth:  80, minWidth:  60 },
        region:    { defaultWidth: 160, minWidth: 110 },
        status:    { defaultWidth: 110, minWidth:  80 },
    };

    return (
        <div className={styles.tableWrapper}>
            <DataGrid
                items={sortedData}
                columns={columns}
                sortable
                sortState={{ sortColumn, sortDirection }}
                onSortChange={(_e: unknown, data: { sortColumn: string; sortDirection: 'ascending' | 'descending' }) => {
                    setSortColumn(data.sortColumn);
                    setSortDirection(data.sortDirection);
                }}
                getRowId={(item) => item.id}
                columnSizingOptions={columnSizingOptions}
                resizableColumns
                aria-label="Top 5 customers by revenue"
            >
                <DataGridHeader>
                    <DataGridRow>
                        {({ renderHeaderCell }) => (
                            <DataGridHeaderCell
                                style={{ color: TEXT_SECONDARY, fontSize: '12px', fontWeight: 600 }}
                            >
                                {renderHeaderCell()}
                            </DataGridHeaderCell>
                        )}
                    </DataGridRow>
                </DataGridHeader>
                <DataGridBody<Customer>>
                    {({ item, rowId }) => (
                        <DataGridRow<Customer> key={rowId}>
                            {({ renderCell }) => (
                                <DataGridCell>{renderCell(item)}</DataGridCell>
                            )}
                        </DataGridRow>
                    )}
                </DataGridBody>
            </DataGrid>
        </div>
    );
};

// ── GeneratedComponent ─────────────────────────────────────────────────────────

interface GeneratedComponentProps {
    dataApi?: unknown;
    pageInput?: { entityName?: string; recordId?: string; data?: Record<string, unknown> };
}

const GeneratedComponent = (props: GeneratedComponentProps) => {
    void props; // mock dashboard — no Dataverse queries
    const styles = useStyles();

    return (
        <div style={themeToVars(webDarkTheme as Record<string, string>)}>
            <div className={styles.root}>
                <header>
                    <Text as="h1" size={700} weight="semibold" className={styles.pageTitle}>
                        Sales dashboard
                    </Text>
                </header>

                <section aria-label="Key performance indicators">
                    <div className={styles.kpiGrid}>
                        {kpiItems.map((item) => (
                            <KpiTile key={item.id} item={item} />
                        ))}
                    </div>
                </section>

                <section aria-label="Monthly revenue" className={styles.sectionCard}>
                    <Text as="h2" size={500} weight="semibold" className={styles.sectionTitle}>
                        Monthly revenue
                    </Text>
                    <Text className={styles.sectionSubtitle}>Jan–Dec 2025</Text>
                    <RevenueBarChart />
                </section>

                <section aria-label="Top 5 customers" className={styles.sectionCard}>
                    <Text as="h2" size={500} weight="semibold" className={styles.sectionTitle}>
                        Top 5 customers
                    </Text>
                    <Text className={styles.sectionSubtitle}>By total revenue</Text>
                    <CustomersTable />
                </section>
            </div>
        </div>
    );
};

export default GeneratedComponent;
