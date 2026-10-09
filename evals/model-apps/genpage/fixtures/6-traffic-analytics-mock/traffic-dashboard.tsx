import * as React from 'react';
import { useEffect, useRef } from 'react';
import { makeStyles, tokens, Text, Card, CardHeader } from '@fluentui/react-components';
import * as d3 from 'd3';

// ---------- Mock data (last 12 weeks) ----------

interface WeeklyTraffic {
    week: string;
    visitors: number;
    pageViews: number;
}

interface Share {
    label: string;
    percent: number;
}

const weeklyTraffic: WeeklyTraffic[] = [
    { week: 'Jul 13', visitors: 17840, pageViews: 50120 },
    { week: 'Jul 20', visitors: 18320, pageViews: 51870 },
    { week: 'Jul 27', visitors: 17960, pageViews: 50340 },
    { week: 'Aug 3', visitors: 19410, pageViews: 55260 },
    { week: 'Aug 10', visitors: 20150, pageViews: 57410 },
    { week: 'Aug 17', visitors: 19780, pageViews: 56030 },
    { week: 'Aug 24', visitors: 21030, pageViews: 60280 },
    { week: 'Aug 31', visitors: 21890, pageViews: 62950 },
    { week: 'Sep 7', visitors: 22470, pageViews: 64170 },
    { week: 'Sep 14', visitors: 22960, pageViews: 66020 },
    { week: 'Sep 21', visitors: 23280, pageViews: 67340 },
    { week: 'Sep 28', visitors: 24860, pageViews: 71290 },
];

const ageGroups: Share[] = [
    { label: '18–24', percent: 18.6 },
    { label: '25–34', percent: 31.2 },
    { label: '35–44', percent: 22.4 },
    { label: '45–54', percent: 14.1 },
    { label: '55–64', percent: 8.9 },
    { label: '65+', percent: 4.8 },
];

const topCountries: Share[] = [
    { label: 'United States', percent: 38.4 },
    { label: 'United Kingdom', percent: 11.7 },
    { label: 'Germany', percent: 9.2 },
    { label: 'India', percent: 8.5 },
    { label: 'Canada', percent: 6.3 },
    { label: 'Other', percent: 25.9 },
];

const sessionStats = {
    avgSessionSeconds: 192,
    avgSessionDeltaPct: -1.5,
    bounceRatePct: 41.6,
    bounceRateDeltaPct: -2.3,
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
    header: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
    },
    subtitle: { color: tokens.colorNeutralForeground3 },
    kpiRow: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: tokens.spacingHorizontalM,
    },
    kpiCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXS,
        padding: tokens.spacingHorizontalL,
    },
    kpiLabel: { color: tokens.colorNeutralForeground2 },
    kpiValue: { fontSize: tokens.fontSizeHero800, fontWeight: tokens.fontWeightSemibold },
    deltaGood: { color: tokens.colorPaletteGreenForeground1 },
    deltaBad: { color: tokens.colorPaletteRedForeground1 },
    chartGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: tokens.spacingHorizontalL,
        '@media (max-width: 768px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
    },
    wideCard: {
        gridColumnStart: 1,
        gridColumnEnd: -1,
        padding: tokens.spacingHorizontalL,
    },
    chartCard: { padding: tokens.spacingHorizontalL },
    trendSvg: { width: '100%', height: '280px' },
    barSvg: { width: '100%', height: '220px' },
    legend: {
        display: 'flex',
        gap: tokens.spacingHorizontalL,
        color: tokens.colorNeutralForeground2,
    },
    legendItem: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXS,
    },
    swatch: {
        display: 'inline-block',
        width: '12px',
        height: '3px',
        borderRadius: tokens.borderRadiusSmall,
    },
    swatchVisitors: { backgroundColor: tokens.colorBrandStroke1 },
    swatchPageViews: { backgroundColor: tokens.colorPaletteTealBorderActive },
});

// ---------- Helpers ----------

function percentChange(current: number, previous: number): number {
    return previous === 0 ? 0 : ((current - previous) / previous) * 100;
}

function formatCompact(value: number): string {
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatDuration(totalSeconds: number): string {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function formatDelta(deltaPct: number): string {
    const sign = deltaPct >= 0 ? '+' : '';
    return `${sign}${deltaPct.toFixed(1)}% vs last week`;
}

// ---------- KPI card ----------

interface KpiCardProps {
    label: string;
    value: string;
    deltaPct: number;
    higherIsBetter: boolean;
}

const KpiCard = (props: KpiCardProps) => {
    const styles = useStyles();
    const improved = props.higherIsBetter ? props.deltaPct >= 0 : props.deltaPct <= 0;
    return (
        <Card className={styles.kpiCard} aria-label={`${props.label}: ${props.value}, ${formatDelta(props.deltaPct)}`}>
            <Text className={styles.kpiLabel}>{props.label}</Text>
            <Text className={styles.kpiValue}>{props.value}</Text>
            <Text size={200} className={improved ? styles.deltaGood : styles.deltaBad}>
                {formatDelta(props.deltaPct)}
            </Text>
        </Card>
    );
};

// ---------- Traffic trend (D3 line chart) ----------

const TREND_ANIM_KEY = '__ppTrafficTrendAnimated';

type TrafficMetric = 'visitors' | 'pageViews';

const trendSeries: { key: TrafficMetric; label: string; color: string }[] = [
    { key: 'pageViews', label: 'Page views', color: tokens.colorPaletteTealBorderActive },
    { key: 'visitors', label: 'Visitors', color: tokens.colorBrandStroke1 },
];

const TrafficTrendChart = () => {
    const styles = useStyles();
    const svgRef = useRef<SVGSVGElement>(null);

    useEffect(() => {
        const node = svgRef.current;
        if (!node) return;
        const svg = d3.select(node);
        const w = window as unknown as Record<string, boolean>;
        // Animation guard (rules.md Charts): animate once per session, never replay on remount.
        if (w[TREND_ANIM_KEY] && svg.selectAll('path.trend-line').size() > 0) return;
        const shouldAnimate = !w[TREND_ANIM_KEY];
        w[TREND_ANIM_KEY] = true;
        svg.selectAll('*').remove();

        const rect = node.getBoundingClientRect();
        const width = rect.width || 640;
        const height = rect.height || 280;
        const margin = { top: 12, right: 16, bottom: 28, left: 48 };
        const innerW = width - margin.left - margin.right;
        const innerH = height - margin.top - margin.bottom;
        const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

        const x = d3.scalePoint<string>().domain(weeklyTraffic.map((d) => d.week)).range([0, innerW]);
        const y = d3.scaleLinear()
            .domain([0, (d3.max(weeklyTraffic, (d) => d.pageViews) ?? 0) * 1.1])
            .nice()
            .range([innerH, 0]);

        g.append('g')
            .attr('transform', `translate(0,${innerH})`)
            .call(d3.axisBottom(x).tickValues(x.domain().filter((_, i) => i % 2 === 0)))
            .style('color', tokens.colorNeutralForeground3);
        g.append('g')
            .call(d3.axisLeft(y).ticks(4).tickFormat((d) => formatCompact(d as number)))
            .style('color', tokens.colorNeutralForeground3);

        for (const series of trendSeries) {
            const line = d3.line<WeeklyTraffic>()
                .x((d) => x(d.week) ?? 0)
                .y((d) => y(d[series.key]))
                .curve(d3.curveMonotoneX);

            const path = g.append('path')
                .datum(weeklyTraffic)
                .attr('class', 'trend-line')
                .attr('fill', 'none')
                .attr('stroke-width', 2)
                .style('stroke', series.color)
                .attr('d', line);

            g.selectAll(`circle.${series.key}`)
                .data(weeklyTraffic)
                .enter()
                .append('circle')
                .attr('class', series.key)
                .attr('cx', (d) => x(d.week) ?? 0)
                .attr('cy', (d) => y(d[series.key]))
                .attr('r', 3)
                .style('fill', series.color)
                .append('title')
                .text((d) => `${series.label}, week of ${d.week}: ${d[series.key].toLocaleString('en-US')}`);

            if (shouldAnimate) {
                const length = (path.node() as SVGPathElement).getTotalLength();
                path.attr('stroke-dasharray', `${length} ${length}`)
                    .attr('stroke-dashoffset', length)
                    .transition()
                    .duration(500)
                    .attr('stroke-dashoffset', 0);
            }
        }
    }, []);

    return <svg ref={svgRef} className={styles.trendSvg} role="img" aria-label="Weekly visitors and page views over the last 12 weeks" />;
};

// ---------- Demographics (D3 horizontal bar chart) ----------

interface ShareBarChartProps {
    data: Share[];
    animKey: string;
    ariaLabel: string;
}

const ShareBarChart = (props: ShareBarChartProps) => {
    const styles = useStyles();
    const svgRef = useRef<SVGSVGElement>(null);
    const { data, animKey, ariaLabel } = props;

    useEffect(() => {
        const node = svgRef.current;
        if (!node) return;
        const svg = d3.select(node);
        const w = window as unknown as Record<string, boolean>;
        if (w[animKey] && svg.selectAll('rect.bar').size() > 0) return;
        const shouldAnimate = !w[animKey];
        w[animKey] = true;
        svg.selectAll('*').remove();

        const rect = node.getBoundingClientRect();
        const width = rect.width || 360;
        const height = rect.height || 220;
        const margin = { top: 4, right: 48, bottom: 4, left: 112 };
        const innerW = width - margin.left - margin.right;
        const innerH = height - margin.top - margin.bottom;
        const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

        const y = d3.scaleBand<string>().domain(data.map((d) => d.label)).range([0, innerH]).padding(0.3);
        const x = d3.scaleLinear().domain([0, d3.max(data, (d) => d.percent) ?? 0]).range([0, innerW]);

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
            .text((d) => d.label);

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
            .attr('width', (d) => (shouldAnimate ? 0 : x(d.percent)));
        bars.append('title').text((d) => `${d.label}: ${d.percent.toFixed(1)}% of visitors`);
        if (shouldAnimate) {
            bars.transition().duration(400).attr('width', (d) => x(d.percent));
        }

        g.selectAll('text.bar-value')
            .data(data)
            .enter()
            .append('text')
            .attr('class', 'bar-value')
            .attr('x', (d) => x(d.percent) + 6)
            .attr('y', (d) => (y(d.label) ?? 0) + y.bandwidth() / 2)
            .attr('dy', '0.35em')
            .attr('font-size', '12px')
            .style('fill', tokens.colorNeutralForeground1)
            .text((d) => `${d.percent.toFixed(1)}%`);
    }, [data, animKey]);

    return <svg ref={svgRef} className={styles.barSvg} role="img" aria-label={ariaLabel} />;
};

// ---------- Page ----------

const GeneratedComponent = (props: { pageInput?: { data?: Record<string, unknown> } }) => {
    const { pageInput } = props;
    // pageInput is destructured per rules but unused on a mock dashboard.
    void pageInput;
    const styles = useStyles();

    const thisWeek = weeklyTraffic[weeklyTraffic.length - 1];
    const lastWeek = weeklyTraffic[weeklyTraffic.length - 2];

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <Text as="h1" size={700} weight="semibold">Website analytics</Text>
                <Text className={styles.subtitle}>Week of {thisWeek.week} · sample data</Text>
            </header>

            <section className={styles.kpiRow} aria-label="Traffic summary">
                <KpiCard
                    label="Visitors"
                    value={formatCompact(thisWeek.visitors)}
                    deltaPct={percentChange(thisWeek.visitors, lastWeek.visitors)}
                    higherIsBetter
                />
                <KpiCard
                    label="Page views"
                    value={formatCompact(thisWeek.pageViews)}
                    deltaPct={percentChange(thisWeek.pageViews, lastWeek.pageViews)}
                    higherIsBetter
                />
                <KpiCard
                    label="Avg. session"
                    value={formatDuration(sessionStats.avgSessionSeconds)}
                    deltaPct={sessionStats.avgSessionDeltaPct}
                    higherIsBetter
                />
                <KpiCard
                    label="Bounce rate"
                    value={`${sessionStats.bounceRatePct.toFixed(1)}%`}
                    deltaPct={sessionStats.bounceRateDeltaPct}
                    higherIsBetter={false}
                />
            </section>

            <section className={styles.chartGrid} aria-label="Traffic charts">
                <Card className={styles.wideCard}>
                    <CardHeader
                        header={<Text weight="semibold">Traffic trend</Text>}
                        description="Weekly visitors and page views, last 12 weeks"
                    />
                    <div className={styles.legend} aria-hidden="true">
                        <span className={styles.legendItem}>
                            <span className={`${styles.swatch} ${styles.swatchVisitors}`} />
                            <Text size={200}>Visitors</Text>
                        </span>
                        <span className={styles.legendItem}>
                            <span className={`${styles.swatch} ${styles.swatchPageViews}`} />
                            <Text size={200}>Page views</Text>
                        </span>
                    </div>
                    <TrafficTrendChart />
                </Card>
                <Card className={styles.chartCard}>
                    <CardHeader
                        header={<Text weight="semibold">Visitors by age</Text>}
                        description="Share of visitors, last 12 weeks"
                    />
                    <ShareBarChart data={ageGroups} animKey="__ppTrafficAgeAnimated" ariaLabel="Share of visitors by age group" />
                </Card>
                <Card className={styles.chartCard}>
                    <CardHeader
                        header={<Text weight="semibold">Top countries</Text>}
                        description="Share of visitors, last 12 weeks"
                    />
                    <ShareBarChart data={topCountries} animKey="__ppTrafficCountryAnimated" ariaLabel="Share of visitors by country" />
                </Card>
            </section>
        </div>
    );
};

export default GeneratedComponent;
