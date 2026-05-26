import { useEffect, useRef } from 'react';
import {
    makeStyles,
    tokens,
    Text,
    Card,
    CardHeader,
} from '@fluentui/react-components';
import {
    ArrowTrendingRegular,
    PeopleRegular,
    ShoppingBagRegular,
} from '@fluentui/react-icons';
import * as d3 from 'd3';

// Sample: dashboard layout with KPI summary cards + two D3 charts.
// Demonstrates:
//   - Rule 9: unsized icons (ArrowTrendingRegular, not ArrowTrending24Regular)
//   - Rule 11: no <FluentProvider> wrapper; no createTheme/mergeThemes
//   - makeStyles with tokens (no inline styles for static values)
//   - D3 animation guard: window flag prevents replay on remount/re-eval
//   - Realistic mock data (not "Test1" / "Lorem ipsum")
//   - Responsive flex layout (no 100vh/100vw)
//   - Top-level components, no nesting

// ---------- Mock data ----------

interface MonthRevenue { month: string; revenue: number; }
interface Segment { name: string; value: number; }

const revenueByMonth: MonthRevenue[] = [
    { month: 'Jan', revenue: 482000 },
    { month: 'Feb', revenue: 511000 },
    { month: 'Mar', revenue: 545000 },
    { month: 'Apr', revenue: 612000 },
    { month: 'May', revenue: 598000 },
    { month: 'Jun', revenue: 671000 },
    { month: 'Jul', revenue: 724000 },
    { month: 'Aug', revenue: 758000 },
];

const customerSegments: Segment[] = [
    { name: 'Enterprise', value: 42 },
    { name: 'Mid-market', value: 28 },
    { name: 'SMB', value: 19 },
    { name: 'Self-service', value: 11 },
];

// Quarter-over-quarter KPI snapshot
const kpis = {
    revenue: { value: 4901000, deltaPct: 12.4 },
    customers: { value: 1284, deltaPct: 8.1 },
    avgOrder: { value: 3818, deltaPct: -2.3 },
};

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
    pageTitle: { marginBottom: tokens.spacingVerticalS },
    kpiRow: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalL,
    },
    kpiCard: {
        flex: '1 1 240px',
        padding: tokens.spacingHorizontalL,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXS,
    },
    kpiLabel: { color: tokens.colorNeutralForeground2 },
    kpiValue: { fontSize: tokens.fontSizeHero900, fontWeight: tokens.fontWeightSemibold },
    kpiDelta: { fontSize: tokens.fontSizeBase300 },
    deltaPositive: { color: tokens.colorPaletteGreenForeground1 },
    deltaNegative: { color: tokens.colorPaletteRedForeground1 },
    chartsRow: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalL,
    },
    chartCard: { flex: '1 1 360px', minHeight: '300px' },
    chartSvg: { width: '100%', height: '260px' },
});

// ---------- Formatting helpers ----------

function formatCurrency(value: number): string {
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
    return `$${value}`;
}

function formatNumber(value: number): string {
    return new Intl.NumberFormat('en-US').format(value);
}

function formatDelta(deltaPct: number): string {
    const sign = deltaPct >= 0 ? '+' : '';
    return `${sign}${deltaPct.toFixed(1)}% QoQ`;
}

// ---------- KPI card ----------

interface KpiCardProps {
    icon: React.ReactNode;
    label: string;
    value: string;
    deltaPct: number;
}

const KpiCard = (props: KpiCardProps) => {
    const styles = useStyles();
    const deltaClass = props.deltaPct >= 0 ? styles.deltaPositive : styles.deltaNegative;
    return (
        <Card className={styles.kpiCard} aria-label={`${props.label}: ${props.value}, ${formatDelta(props.deltaPct)}`}>
            <CardHeader image={props.icon} header={<Text className={styles.kpiLabel}>{props.label}</Text>} />
            <Text className={styles.kpiValue}>{props.value}</Text>
            <Text className={`${styles.kpiDelta} ${deltaClass}`}>{formatDelta(props.deltaPct)}</Text>
        </Card>
    );
};

// ---------- Revenue trend chart (area) ----------

const REVENUE_ANIM_KEY = '__ppDashboardRevenueAnimated';

const RevenueTrendChart = () => {
    const styles = useStyles();
    const svgRef = useRef<SVGSVGElement>(null);

    useEffect(() => {
        const node = svgRef.current;
        if (!node) return;
        const svg = d3.select(node);
        const w = window as unknown as Record<string, boolean>;

        // Animation guard — skip entirely if already drawn (rule from rules.md Charts)
        if (w[REVENUE_ANIM_KEY] && svg.selectAll('path.revenue-area').size() > 0) return;
        const shouldAnimate = !w[REVENUE_ANIM_KEY];
        w[REVENUE_ANIM_KEY] = true;

        svg.selectAll('*').remove();

        const rect = node.getBoundingClientRect();
        const width = rect.width || 400;
        const height = rect.height || 260;
        const margin = { top: 16, right: 16, bottom: 28, left: 56 };
        const innerW = width - margin.left - margin.right;
        const innerH = height - margin.top - margin.bottom;

        const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

        const x = d3.scalePoint<string>().domain(revenueByMonth.map(d => d.month)).range([0, innerW]);
        const y = d3.scaleLinear()
            .domain([0, (d3.max(revenueByMonth, d => d.revenue) ?? 0) * 1.1])
            .range([innerH, 0]);

        g.append('g')
            .attr('transform', `translate(0,${innerH})`)
            .call(d3.axisBottom(x))
            .attr('color', tokens.colorNeutralForeground2);
        g.append('g')
            .call(d3.axisLeft(y).ticks(4).tickFormat(d => formatCurrency(d as number)))
            .attr('color', tokens.colorNeutralForeground2);

        const areaGen = d3.area<MonthRevenue>()
            .x(d => x(d.month) ?? 0)
            .y0(innerH)
            .y1(d => y(d.revenue))
            .curve(d3.curveMonotoneX);

        const lineGen = d3.line<MonthRevenue>()
            .x(d => x(d.month) ?? 0)
            .y(d => y(d.revenue))
            .curve(d3.curveMonotoneX);

        const area = g.append('path')
            .datum(revenueByMonth)
            .attr('class', 'revenue-area')
            .attr('fill', tokens.colorBrandBackground2)
            .attr('d', areaGen);

        const line = g.append('path')
            .datum(revenueByMonth)
            .attr('fill', 'none')
            .attr('stroke', tokens.colorBrandStroke1)
            .attr('stroke-width', 2)
            .attr('d', lineGen);

        if (shouldAnimate) {
            area.attr('opacity', 0).transition().duration(700).attr('opacity', 1);
            const totalLen = (line.node() as SVGPathElement).getTotalLength();
            line.attr('stroke-dasharray', `${totalLen} ${totalLen}`)
                .attr('stroke-dashoffset', totalLen)
                .transition()
                .duration(900)
                .attr('stroke-dashoffset', 0);
        }
    }, []);

    return <svg ref={svgRef} className={styles.chartSvg} role="img" aria-label="Revenue trend by month" />;
};

// ---------- Customer segments chart (donut) ----------

const SEGMENTS_ANIM_KEY = '__ppDashboardSegmentsAnimated';

const CustomerSegmentsChart = () => {
    const styles = useStyles();
    const svgRef = useRef<SVGSVGElement>(null);

    useEffect(() => {
        const node = svgRef.current;
        if (!node) return;
        const svg = d3.select(node);
        const w = window as unknown as Record<string, boolean>;
        if (w[SEGMENTS_ANIM_KEY] && svg.selectAll('path.arc').size() > 0) return;
        const shouldAnimate = !w[SEGMENTS_ANIM_KEY];
        w[SEGMENTS_ANIM_KEY] = true;

        svg.selectAll('*').remove();
        const rect = node.getBoundingClientRect();
        const width = rect.width || 400;
        const height = rect.height || 260;
        const radius = Math.min(width, height) / 2 - 8;

        const g = svg.append('g').attr('transform', `translate(${width / 2},${height / 2})`);

        const palette = [
            tokens.colorBrandBackground,
            tokens.colorPaletteBlueBorderActive,
            tokens.colorPalettePurpleBorderActive,
            tokens.colorPaletteTealBorderActive,
        ];

        const pie = d3.pie<Segment>().value(d => d.value).sort(null);
        const arc = d3.arc<d3.PieArcDatum<Segment>>().innerRadius(radius * 0.55).outerRadius(radius);

        const arcs = g.selectAll('path.arc')
            .data(pie(customerSegments))
            .enter()
            .append('path')
            .attr('class', 'arc')
            .attr('fill', (_, i) => palette[i % palette.length])
            .attr('stroke', tokens.colorNeutralBackground1)
            .attr('stroke-width', 2);

        if (shouldAnimate) {
            arcs.transition()
                .duration(800)
                .attrTween('d', function (d) {
                    const i = d3.interpolate({ ...d, endAngle: d.startAngle }, d);
                    return (t) => arc(i(t)) ?? '';
                });
        } else {
            arcs.attr('d', arc);
        }

        // Labels (segment name + percentage)
        const total = d3.sum(customerSegments, d => d.value);
        g.selectAll('text.segment-label')
            .data(pie(customerSegments))
            .enter()
            .append('text')
            .attr('class', 'segment-label')
            .attr('transform', d => `translate(${arc.centroid(d)})`)
            .attr('text-anchor', 'middle')
            .attr('fill', tokens.colorNeutralForegroundOnBrand)
            .attr('font-size', '12px')
            .attr('font-weight', 600)
            .text(d => `${d.data.name} ${Math.round((d.data.value / total) * 100)}%`);
    }, []);

    return <svg ref={svgRef} className={styles.chartSvg} role="img" aria-label="Customer segments distribution" />;
};

// ---------- Main component ----------

const GeneratedComponent = (props: { dataApi?: unknown; pageInput?: { data?: Record<string, unknown> } }) => {
    const { pageInput } = props;
    // pageInput is destructured per rules but unused on a mock dashboard.
    void pageInput;
    const styles = useStyles();

    return (
        <div className={styles.root}>
            <Text as="h1" size={700} weight="semibold" className={styles.pageTitle}>
                Sales Dashboard
            </Text>

            <section className={styles.kpiRow} aria-label="Key performance indicators">
                <KpiCard
                    icon={<ArrowTrendingRegular />}
                    label="Revenue (YTD)"
                    value={formatCurrency(kpis.revenue.value)}
                    deltaPct={kpis.revenue.deltaPct}
                />
                <KpiCard
                    icon={<PeopleRegular />}
                    label="Active customers"
                    value={formatNumber(kpis.customers.value)}
                    deltaPct={kpis.customers.deltaPct}
                />
                <KpiCard
                    icon={<ShoppingBagRegular />}
                    label="Avg order"
                    value={formatCurrency(kpis.avgOrder.value)}
                    deltaPct={kpis.avgOrder.deltaPct}
                />
            </section>

            <section className={styles.chartsRow} aria-label="Detailed metrics">
                <Card className={styles.chartCard}>
                    <CardHeader header={<Text weight="semibold">Revenue trend</Text>} description="Monthly recurring revenue, last 8 months" />
                    <RevenueTrendChart />
                </Card>
                <Card className={styles.chartCard}>
                    <CardHeader header={<Text weight="semibold">Customer segments</Text>} description="Active customers by tier" />
                    <CustomerSegmentsChart />
                </Card>
            </section>
        </div>
    );
};

export default GeneratedComponent;
