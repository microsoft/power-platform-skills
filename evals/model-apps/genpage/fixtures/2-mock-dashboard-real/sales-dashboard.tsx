import React, { useMemo, useState, useEffect, useRef } from 'react';
import {
    makeStyles,
    mergeClasses,
    tokens,
    webDarkTheme,
    Text,
    Title2,
    Title3,
    Subtitle2,
    Caption1,
    Body1,
    Card,
    CardHeader,
    Badge,
    Button,
    Divider,
    Tooltip,
    Table,
    TableHeader,
    TableHeaderCell,
    TableBody,
    TableRow,
    TableCell,
} from '@fluentui/react-components';
import {
    ArrowTrendingRegular,
    HandshakeRegular,
    MoneyRegular,
    TrophyRegular,
    ArrowUpRegular,
    ArrowDownRegular,
    ArrowClockwiseRegular,
} from '@fluentui/react-icons';

// ---------- Theme application (force dark mode via themeToVars two-div pattern) ----------

function themeToVars(theme: Record<string, string>): React.CSSProperties {
    const vars: Record<string, string> = {};
    Object.entries(theme).forEach(([k, v]) => {
        vars[`--${k}`] = v;
    });
    return vars as React.CSSProperties;
}

// ---------- Types ----------

type RangeKey = '6M' | '12M' | 'YTD';

interface MonthPoint {
    month: string;
    revenue: number;
}

interface KpiTile {
    key: string;
    label: string;
    value: string;
    deltaPct: number;
    sparkline: number[];
    icon: React.ReactNode;
    accent: 'teal' | 'magenta' | 'amber' | 'blue';
}

interface CustomerRow {
    rank: number;
    name: string;
    revenueYtd: number;
    dealsClosed: number;
    growthPct: number;
}

interface MockSalesData {
    monthly: MonthPoint[];
    customers: CustomerRow[];
    totalRevenueMtd: number;
    newDealsClosed: number;
    avgDealSize: number;
    winRatePct: number;
    deltas: {
        revenue: number;
        deals: number;
        avg: number;
        win: number;
    };
    sparklines: {
        revenue: number[];
        deals: number[];
        avg: number[];
        win: number[];
    };
}

// ---------- Deterministic seeded RNG ----------

function mulberry32(seed: number) {
    let s = seed >>> 0;
    return function () {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------- Mock data generator ----------

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CUSTOMER_NAMES = [
    'Northwind Traders',
    'Contoso Pharmaceuticals',
    'Adventure Works Cycles',
    'Fabrikam Industries',
    'Wide World Importers',
    'Tailspin Toys',
    'Litware Inc.',
    'Proseware Solutions',
    'Lucerne Publishing',
    'Margie’s Travel',
];

function generateMockSales(seed: number): MockSalesData {
    const rand = mulberry32(seed);

    const monthly: MonthPoint[] = MONTH_LABELS.map((m, i) => {
        const trend = 380000 + i * 14000;
        const wobble = (rand() - 0.4) * 95000;
        const seasonal = Math.sin((i / 11) * Math.PI) * 38000;
        return {
            month: m,
            revenue: Math.max(180000, Math.round(trend + wobble + seasonal)),
        };
    });

    const customers: CustomerRow[] = CUSTOMER_NAMES.slice(0)
        .map((name) => ({
            name,
            revenueYtd: Math.round(420000 + rand() * 1_980_000),
            dealsClosed: Math.round(8 + rand() * 54),
            growthPct: Math.round((rand() * 70 - 18) * 10) / 10,
        }))
        .sort((a, b) => b.revenueYtd - a.revenueYtd)
        .slice(0, 5)
        .map((c, i) => ({ ...c, rank: i + 1 }));

    const totalRevenueMtd = monthly[monthly.length - 1].revenue;
    const prevRevenue = monthly[monthly.length - 2].revenue;
    const newDealsClosed = Math.round(54 + rand() * 38);
    const avgDealSize = Math.round(totalRevenueMtd / newDealsClosed);
    const winRatePct = Math.round((42 + rand() * 28) * 10) / 10;

    const revenueDelta = ((totalRevenueMtd - prevRevenue) / prevRevenue) * 100;
    const dealsDelta = (rand() * 22 - 6);
    const avgDelta = (rand() * 18 - 5);
    const winDelta = (rand() * 12 - 4);

    const sparkRevenue = monthly.slice(-8).map((m) => m.revenue);
    const sparkDeals = Array.from({ length: 8 }, () => Math.round(20 + rand() * 60));
    const sparkAvg = Array.from({ length: 8 }, () => Math.round(7000 + rand() * 9000));
    const sparkWin = Array.from({ length: 8 }, () => Math.round((40 + rand() * 30) * 10) / 10);

    return {
        monthly,
        customers,
        totalRevenueMtd,
        newDealsClosed,
        avgDealSize,
        winRatePct,
        deltas: {
            revenue: Math.round(revenueDelta * 10) / 10,
            deals: Math.round(dealsDelta * 10) / 10,
            avg: Math.round(avgDelta * 10) / 10,
            win: Math.round(winDelta * 10) / 10,
        },
        sparklines: {
            revenue: sparkRevenue,
            deals: sparkDeals,
            avg: sparkAvg,
            win: sparkWin,
        },
    };
}

function sliceMonthly(monthly: MonthPoint[], range: RangeKey): MonthPoint[] {
    if (range === '6M') return monthly.slice(-6);
    if (range === '12M') return monthly.slice(-12);
    // YTD: today is 2026-05-26 — use Jan..May (first 5 months)
    return monthly.slice(0, 5);
}

// ---------- Formatting ----------

function formatCurrency(value: number): string {
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
    return `$${value}`;
}

function formatCurrencyExact(value: number): string {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function formatNumber(value: number): string {
    return new Intl.NumberFormat('en-US').format(value);
}

function formatPct(value: number, withSign = false): string {
    const sign = withSign ? (value >= 0 ? '+' : '') : '';
    return `${sign}${value.toFixed(1)}%`;
}

function formatToday(): string {
    const now = new Date();
    return now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------- Styles ----------

const useStyles = makeStyles({
    themeRoot: {
        height: '100%',
        overflow: 'hidden',
        backgroundColor: '#0E1116',
    },
    root: {
        height: '100%',
        width: '100%',
        overflowY: 'auto',
        backgroundColor: '#0E1116',
        color: tokens.colorNeutralForeground1,
        boxSizing: 'border-box',
    },
    page: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXL,
        maxWidth: '1440px',
        margin: '0 auto',
        padding: `${tokens.spacingVerticalXL} ${tokens.spacingHorizontalXXL}`,
        boxSizing: 'border-box',
        '@media (max-width: 768px)': {
            padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalL}`,
        },
    },
    // Header
    header: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: tokens.spacingHorizontalL,
        flexWrap: 'wrap',
    },
    headerText: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
    },
    headerTitle: {
        color: tokens.colorNeutralForeground1,
        letterSpacing: '-0.01em',
    },
    headerCaption: {
        color: tokens.colorNeutralForeground3,
    },
    headerActions: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens.spacingHorizontalM,
        flexWrap: 'wrap',
    },
    // Range toggle
    rangeToggle: {
        display: 'flex',
        flexDirection: 'row',
        backgroundColor: '#1B1F25',
        borderRadius: tokens.borderRadiusXLarge,
        padding: '4px',
        gap: '4px',
        border: `1px solid ${tokens.colorNeutralStroke2}`,
    },
    rangePill: {
        appearance: 'none',
        background: 'transparent',
        border: 'none',
        color: tokens.colorNeutralForeground3,
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`,
        borderRadius: tokens.borderRadiusXLarge,
        fontSize: tokens.fontSizeBase300,
        fontWeight: tokens.fontWeightSemibold,
        cursor: 'pointer',
        transitionDuration: tokens.durationNormal,
        transitionProperty: 'background-color, color',
        ':hover': {
            color: tokens.colorNeutralForeground1,
            backgroundColor: tokens.colorNeutralBackground1Hover,
        },
        ':focus-visible': {
            outline: `2px solid ${tokens.colorStrokeFocus2}`,
            outlineOffset: '2px',
        },
    },
    rangePillActive: {
        backgroundColor: '#2EE6D6',
        color: '#0E1116',
        ':hover': {
            backgroundColor: '#2EE6D6',
            color: '#0E1116',
        },
    },
    refreshBtn: {
        backgroundColor: '#1B1F25',
        color: tokens.colorNeutralForeground1,
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        ':hover': {
            backgroundColor: tokens.colorNeutralBackground1Hover,
            color: tokens.colorNeutralForeground1,
            border: `1px solid ${tokens.colorNeutralStroke1}`,
        },
    },
    // KPI bar
    kpiBar: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: tokens.spacingHorizontalL,
    },
    kpiCard: {
        backgroundColor: '#1B1F25',
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: tokens.borderRadiusLarge,
        padding: tokens.spacingHorizontalL,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
        boxShadow: tokens.shadow16,
        transitionDuration: tokens.durationNormal,
        transitionProperty: 'transform, border-color, box-shadow',
        ':hover': {
            transform: 'translateY(-2px)',
            borderColor: tokens.colorNeutralStroke1,
            boxShadow: tokens.shadow28,
        },
    },
    kpiHeader: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens.spacingHorizontalS,
    },
    kpiLabel: {
        color: tokens.colorNeutralForeground3,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        fontSize: tokens.fontSizeBase200,
        fontWeight: tokens.fontWeightSemibold,
    },
    kpiIconWrap: {
        width: '32px',
        height: '32px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: tokens.borderRadiusMedium,
        fontSize: '18px',
    },
    kpiIconTeal: { backgroundColor: 'rgba(46, 230, 214, 0.14)', color: '#2EE6D6' },
    kpiIconMagenta: { backgroundColor: 'rgba(255, 79, 163, 0.14)', color: '#FF4FA3' },
    kpiIconAmber: { backgroundColor: 'rgba(255, 181, 71, 0.14)', color: '#FFB547' },
    kpiIconBlue: { backgroundColor: 'rgba(96, 175, 255, 0.14)', color: '#60AFFF' },
    kpiValue: {
        color: tokens.colorNeutralForeground1,
        fontSize: '32px',
        lineHeight: '38px',
        fontWeight: tokens.fontWeightSemibold,
        letterSpacing: '-0.01em',
    },
    kpiFooter: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens.spacingHorizontalS,
    },
    kpiDelta: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontSize: tokens.fontSizeBase300,
        fontWeight: tokens.fontWeightSemibold,
    },
    deltaPositive: { color: '#2EE6D6' },
    deltaNegative: { color: '#FF4FA3' },
    sparkline: {
        width: '88px',
        height: '28px',
        flexShrink: 0,
    },
    // Chart card
    chartCard: {
        backgroundColor: '#1B1F25',
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: tokens.borderRadiusLarge,
        padding: tokens.spacingHorizontalL,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
        boxShadow: tokens.shadow16,
    },
    chartHeader: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: tokens.spacingHorizontalL,
        flexWrap: 'wrap',
    },
    chartHeaderText: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
    },
    chartTitle: { color: tokens.colorNeutralForeground1 },
    chartCaption: { color: tokens.colorNeutralForeground3 },
    chartLegend: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens.spacingHorizontalM,
    },
    legendItem: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground3,
    },
    legendSwatch: {
        width: '10px',
        height: '10px',
        borderRadius: '2px',
        backgroundColor: '#2EE6D6',
    },
    chartSurface: {
        position: 'relative',
        width: '100%',
        aspectRatio: '16 / 6',
        minHeight: '240px',
    },
    chartSvg: {
        width: '100%',
        height: '100%',
        display: 'block',
        overflow: 'visible',
    },
    chartTooltip: {
        position: 'absolute',
        pointerEvents: 'none',
        backgroundColor: '#0E1116',
        border: `1px solid ${tokens.colorNeutralStroke1}`,
        borderRadius: tokens.borderRadiusMedium,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        color: tokens.colorNeutralForeground1,
        fontSize: tokens.fontSizeBase200,
        boxShadow: tokens.shadow28,
        minWidth: '140px',
        transform: 'translate(-50%, -110%)',
        whiteSpace: 'nowrap',
    },
    tooltipMonth: {
        color: tokens.colorNeutralForeground3,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        fontSize: '11px',
    },
    tooltipValue: {
        color: tokens.colorNeutralForeground1,
        fontSize: tokens.fontSizeBase400,
        fontWeight: tokens.fontWeightSemibold,
    },
    srOnly: {
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: 0,
        margin: '-1px',
        overflow: 'hidden',
        clip: 'rect(0,0,0,0)',
        whiteSpace: 'nowrap',
        borderWidth: 0,
    },
    // Customers card
    tableCard: {
        backgroundColor: '#1B1F25',
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        borderRadius: tokens.borderRadiusLarge,
        padding: tokens.spacingHorizontalL,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
        boxShadow: tokens.shadow16,
    },
    tableWrap: {
        width: '100%',
        overflowX: 'auto',
    },
    table: {
        backgroundColor: 'transparent',
    },
    tableHeaderCell: {
        color: tokens.colorNeutralForeground3,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        fontSize: tokens.fontSizeBase200,
        fontWeight: tokens.fontWeightSemibold,
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    },
    tableRow: {
        transitionDuration: tokens.durationFaster,
        transitionProperty: 'background-color',
        ':hover': {
            backgroundColor: 'rgba(255, 255, 255, 0.03)',
        },
    },
    rankCell: {
        width: '64px',
    },
    rankBadge: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '28px',
        height: '28px',
        borderRadius: '50%',
        backgroundColor: 'rgba(46, 230, 214, 0.14)',
        color: '#2EE6D6',
        fontSize: tokens.fontSizeBase200,
        fontWeight: tokens.fontWeightSemibold,
    },
    custName: { color: tokens.colorNeutralForeground1, fontWeight: tokens.fontWeightSemibold },
    custNumeric: { color: tokens.colorNeutralForeground2, fontVariantNumeric: 'tabular-nums' },
    growthBadgePositive: {
        backgroundColor: 'rgba(46, 230, 214, 0.18)',
        color: '#2EE6D6',
        borderColor: 'transparent',
    },
    growthBadgeNegative: {
        backgroundColor: 'rgba(255, 79, 163, 0.18)',
        color: '#FF4FA3',
        borderColor: 'transparent',
    },
});

// ---------- Sparkline (mini chart on each KPI tile) ----------

interface SparklineProps {
    values: number[];
    accent: string;
    ariaLabel: string;
}

const Sparkline = (props: SparklineProps) => {
    const styles = useStyles();
    const { values, accent, ariaLabel } = props;
    const w = 88;
    const h = 28;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const stepX = values.length > 1 ? w / (values.length - 1) : 0;
    const points = values
        .map((v, i) => `${(i * stepX).toFixed(2)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(2)}`)
        .join(' ');
    const areaPath = values.length
        ? `M0,${h} L${points.split(' ').map((p) => p).join(' L')} L${w},${h} Z`
        : '';
    const gradId = `spark-grad-${accent.replace(/[^a-zA-Z0-9]/g, '')}`;

    return (
        <svg
            className={styles.sparkline}
            viewBox={`0 0 ${w} ${h}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={ariaLabel}
        >
            <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={accent} stopOpacity={0.45} />
                    <stop offset="100%" stopColor={accent} stopOpacity={0} />
                </linearGradient>
            </defs>
            <path d={areaPath} fill={`url(#${gradId})`} />
            <polyline points={points} fill="none" stroke={accent} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
    );
};

// ---------- KPI Tile ----------

const accentClassMap: Record<KpiTile['accent'], keyof ReturnType<typeof useStyles>> = {
    teal: 'kpiIconTeal',
    magenta: 'kpiIconMagenta',
    amber: 'kpiIconAmber',
    blue: 'kpiIconBlue',
};

const accentColorMap: Record<KpiTile['accent'], string> = {
    teal: '#2EE6D6',
    magenta: '#FF4FA3',
    amber: '#FFB547',
    blue: '#60AFFF',
};

const KpiTileCard = (props: { tile: KpiTile }) => {
    const styles = useStyles();
    const { tile } = props;
    const positive = tile.deltaPct >= 0;
    const iconClass = styles[accentClassMap[tile.accent]];
    const sparkAccent = accentColorMap[tile.accent];

    return (
        <div
            className={styles.kpiCard}
            role="group"
            aria-label={`${tile.label}: ${tile.value}, change ${formatPct(tile.deltaPct, true)} vs. prior period`}
        >
            <div className={styles.kpiHeader}>
                <Text className={styles.kpiLabel}>{tile.label}</Text>
                <div className={mergeClasses(styles.kpiIconWrap, iconClass)} aria-hidden="true">
                    {tile.icon}
                </div>
            </div>
            <Text className={styles.kpiValue}>{tile.value}</Text>
            <div className={styles.kpiFooter}>
                <span
                    className={mergeClasses(
                        styles.kpiDelta,
                        positive ? styles.deltaPositive : styles.deltaNegative,
                    )}
                >
                    {positive ? <ArrowUpRegular fontSize={16} /> : <ArrowDownRegular fontSize={16} />}
                    {formatPct(Math.abs(tile.deltaPct), false)} vs. prior
                </span>
                <Sparkline values={tile.sparkline} accent={sparkAccent} ariaLabel={`${tile.label} trend, last ${tile.sparkline.length} weeks`} />
            </div>
        </div>
    );
};

// ---------- Range Toggle ----------

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
    { key: '6M', label: 'Last 6M' },
    { key: '12M', label: 'Last 12M' },
    { key: 'YTD', label: 'YTD' },
];

interface RangeToggleProps {
    value: RangeKey;
    onChange: (v: RangeKey) => void;
}

const RangeToggle = (props: RangeToggleProps) => {
    const styles = useStyles();
    const { value, onChange } = props;
    const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

    const focusIndex = (i: number) => {
        const next = (i + RANGE_OPTIONS.length) % RANGE_OPTIONS.length;
        btnRefs.current[next]?.focus();
        onChange(RANGE_OPTIONS[next].key);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            focusIndex(idx + 1);
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            focusIndex(idx - 1);
        } else if (e.key === 'Home') {
            e.preventDefault();
            focusIndex(0);
        } else if (e.key === 'End') {
            e.preventDefault();
            focusIndex(RANGE_OPTIONS.length - 1);
        }
    };

    return (
        <div className={styles.rangeToggle} role="tablist" aria-label="Time range">
            {RANGE_OPTIONS.map((opt, idx) => {
                const active = value === opt.key;
                return (
                    <button
                        key={opt.key}
                        ref={(el) => {
                            btnRefs.current[idx] = el;
                        }}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        tabIndex={active ? 0 : -1}
                        className={mergeClasses(styles.rangePill, active && styles.rangePillActive)}
                        onClick={() => onChange(opt.key)}
                        onKeyDown={(e) => handleKeyDown(e, idx)}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
};

// ---------- Revenue chart (custom inline SVG, theme-aware, hover tooltip) ----------

interface RevenueChartProps {
    data: MonthPoint[];
}

const RevenueChart = (props: RevenueChartProps) => {
    const styles = useStyles();
    const { data } = props;
    const wrapRef = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState({ w: 720, h: 280 });
    const [hoverIdx, setHoverIdx] = useState<number | null>(null);

    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return;
        const update = () => {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const margin = { top: 16, right: 24, bottom: 28, left: 56 };
    const innerW = Math.max(0, size.w - margin.left - margin.right);
    const innerH = Math.max(0, size.h - margin.top - margin.bottom);

    const values = data.map((d) => d.revenue);
    const max = Math.max(...values, 0);
    const min = Math.min(...values, 0);
    const yMax = max * 1.12;
    const yMin = Math.max(0, min * 0.85);
    const ySpan = yMax - yMin || 1;

    const stepX = data.length > 1 ? innerW / (data.length - 1) : innerW;
    const points = data.map((d, i) => ({
        x: i * stepX,
        y: innerH - ((d.revenue - yMin) / ySpan) * innerH,
        month: d.month,
        revenue: d.revenue,
    }));

    // Smooth path via cubic Bezier (Catmull-Rom-ish)
    const smoothPath = (() => {
        if (points.length === 0) return '';
        if (points.length === 1) return `M${points[0].x},${points[0].y}`;
        let d = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
        for (let i = 0; i < points.length - 1; i++) {
            const p0 = points[i - 1] ?? points[i];
            const p1 = points[i];
            const p2 = points[i + 1];
            const p3 = points[i + 2] ?? p2;
            const t = 0.18;
            const c1x = p1.x + (p2.x - p0.x) * t;
            const c1y = p1.y + (p2.y - p0.y) * t;
            const c2x = p2.x - (p3.x - p1.x) * t;
            const c2y = p2.y - (p3.y - p1.y) * t;
            d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
        }
        return d;
    })();
    const areaPath = `${smoothPath} L${(points[points.length - 1]?.x ?? 0).toFixed(2)},${innerH} L0,${innerH} Z`;

    // Y-axis gridlines/labels (5 ticks)
    const tickCount = 5;
    const ticks = Array.from({ length: tickCount }, (_, i) => {
        const v = yMin + (ySpan * (tickCount - 1 - i)) / (tickCount - 1);
        const y = (i * innerH) / (tickCount - 1);
        return { v, y };
    });

    const monthMoMChange = (idx: number): number | null => {
        if (idx <= 0) return null;
        const prev = data[idx - 1].revenue;
        if (prev === 0) return null;
        return ((data[idx].revenue - prev) / prev) * 100;
    };

    const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
        const svg = e.currentTarget;
        const rect = svg.getBoundingClientRect();
        const localX = e.clientX - rect.left - margin.left;
        if (localX < 0 || localX > innerW || data.length === 0) {
            setHoverIdx(null);
            return;
        }
        const idx = Math.round(localX / stepX);
        const clamped = Math.max(0, Math.min(data.length - 1, idx));
        setHoverIdx(clamped);
    };

    const hovered = hoverIdx !== null ? points[hoverIdx] : null;
    const hoverMoM = hoverIdx !== null ? monthMoMChange(hoverIdx) : null;

    const tooltipLeft = hovered ? margin.left + hovered.x : 0;
    const tooltipTop = hovered ? margin.top + hovered.y : 0;

    return (
        <div
            ref={wrapRef}
            className={styles.chartSurface}
            onMouseLeave={() => setHoverIdx(null)}
        >
            <svg
                className={styles.chartSvg}
                viewBox={`0 0 ${size.w} ${size.h}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={`Monthly revenue chart, ${data.length} months from ${data[0]?.month ?? ''} to ${data[data.length - 1]?.month ?? ''}`}
                onMouseMove={handleMove}
            >
                <defs>
                    <linearGradient id="revenue-area-grad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2EE6D6" stopOpacity={0.38} />
                        <stop offset="100%" stopColor="#2EE6D6" stopOpacity={0} />
                    </linearGradient>
                </defs>

                <g transform={`translate(${margin.left},${margin.top})`}>
                    {/* Gridlines and Y labels */}
                    {ticks.map((t, i) => (
                        <g key={`tick-${i}`}>
                            <line
                                x1={0}
                                x2={innerW}
                                y1={t.y}
                                y2={t.y}
                                stroke={tokens.colorNeutralStroke2}
                                strokeDasharray={i === ticks.length - 1 ? '0' : '3 4'}
                                strokeWidth={1}
                                opacity={i === ticks.length - 1 ? 0.6 : 0.35}
                            />
                            <text
                                x={-10}
                                y={t.y + 4}
                                fill={tokens.colorNeutralForeground3}
                                fontSize="11"
                                textAnchor="end"
                            >
                                {formatCurrency(t.v)}
                            </text>
                        </g>
                    ))}

                    {/* X labels */}
                    {points.map((p, i) => (
                        <text
                            key={`x-${i}`}
                            x={p.x}
                            y={innerH + 18}
                            fill={tokens.colorNeutralForeground3}
                            fontSize="11"
                            textAnchor="middle"
                        >
                            {p.month}
                        </text>
                    ))}

                    {/* Area + line */}
                    <path d={areaPath} fill="url(#revenue-area-grad)" />
                    <path
                        d={smoothPath}
                        fill="none"
                        stroke="#2EE6D6"
                        strokeWidth={2.25}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />

                    {/* Hover guideline + dot */}
                    {hovered && (
                        <g>
                            <line
                                x1={hovered.x}
                                x2={hovered.x}
                                y1={0}
                                y2={innerH}
                                stroke="#2EE6D6"
                                strokeOpacity={0.5}
                                strokeWidth={1}
                                strokeDasharray="2 3"
                            />
                            <circle cx={hovered.x} cy={hovered.y} r={5} fill="#0E1116" stroke="#2EE6D6" strokeWidth={2} />
                        </g>
                    )}
                </g>
            </svg>

            {hovered && (
                <div
                    className={styles.chartTooltip}
                    style={{ left: `${tooltipLeft}px`, top: `${tooltipTop}px` }}
                    role="tooltip"
                >
                    <div className={styles.tooltipMonth}>{hovered.month}</div>
                    <div className={styles.tooltipValue}>{formatCurrencyExact(hovered.revenue)}</div>
                    {hoverMoM !== null && (
                        <div
                            style={{
                                color: hoverMoM >= 0 ? '#2EE6D6' : '#FF4FA3',
                                fontSize: '12px',
                                marginTop: '2px',
                            }}
                        >
                            {formatPct(hoverMoM, true)} MoM
                        </div>
                    )}
                </div>
            )}

            {/* Visually hidden data table for screen readers */}
            <table className={styles.srOnly} aria-label="Monthly revenue, tabular data">
                <thead>
                    <tr>
                        <th scope="col">Month</th>
                        <th scope="col">Revenue (USD)</th>
                    </tr>
                </thead>
                <tbody>
                    {data.map((d) => (
                        <tr key={d.month}>
                            <th scope="row">{d.month}</th>
                            <td>{d.revenue}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

// ---------- Top customers table ----------

interface CustomersTableProps {
    rows: CustomerRow[];
}

const CustomersTable = (props: CustomersTableProps) => {
    const styles = useStyles();
    const { rows } = props;
    return (
        <div className={styles.tableWrap}>
            <Table className={styles.table} aria-label="Top 5 customers by revenue YTD">
                <TableHeader>
                    <TableRow>
                        <TableHeaderCell className={mergeClasses(styles.tableHeaderCell, styles.rankCell)}>
                            Rank
                        </TableHeaderCell>
                        <TableHeaderCell className={styles.tableHeaderCell}>Customer</TableHeaderCell>
                        <TableHeaderCell className={styles.tableHeaderCell}>Revenue YTD</TableHeaderCell>
                        <TableHeaderCell className={styles.tableHeaderCell}>Deals closed</TableHeaderCell>
                        <TableHeaderCell className={styles.tableHeaderCell}>Growth</TableHeaderCell>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((row) => {
                        const positive = row.growthPct >= 0;
                        return (
                            <TableRow key={row.rank} className={styles.tableRow}>
                                <TableCell className={styles.rankCell}>
                                    <span className={styles.rankBadge}>{row.rank}</span>
                                </TableCell>
                                <TableCell>
                                    <Text className={styles.custName}>{row.name}</Text>
                                </TableCell>
                                <TableCell>
                                    <Text className={styles.custNumeric}>{formatCurrencyExact(row.revenueYtd)}</Text>
                                </TableCell>
                                <TableCell>
                                    <Text className={styles.custNumeric}>{formatNumber(row.dealsClosed)}</Text>
                                </TableCell>
                                <TableCell>
                                    <Badge
                                        appearance="filled"
                                        className={positive ? styles.growthBadgePositive : styles.growthBadgeNegative}
                                        icon={positive ? <ArrowUpRegular /> : <ArrowDownRegular />}
                                    >
                                        {formatPct(Math.abs(row.growthPct), false)}
                                    </Badge>
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
};

// ---------- Main component ----------

const GeneratedComponent = (props: { dataApi?: unknown; pageInput?: { data?: Record<string, unknown> } }) => {
    const { pageInput } = props;
    void pageInput;
    const styles = useStyles();
    const [seed, setSeed] = useState<number>(20260526);
    const [range, setRange] = useState<RangeKey>('12M');

    const data = useMemo(() => generateMockSales(seed), [seed]);
    const monthlySlice = useMemo(() => sliceMonthly(data.monthly, range), [data.monthly, range]);

    const tiles: KpiTile[] = useMemo(
        () => [
            {
                key: 'revenue',
                label: 'Total revenue (MTD)',
                value: formatCurrency(data.totalRevenueMtd),
                deltaPct: data.deltas.revenue,
                sparkline: data.sparklines.revenue,
                icon: <ArrowTrendingRegular fontSize={18} />,
                accent: 'teal',
            },
            {
                key: 'deals',
                label: 'New deals closed',
                value: formatNumber(data.newDealsClosed),
                deltaPct: data.deltas.deals,
                sparkline: data.sparklines.deals,
                icon: <HandshakeRegular fontSize={18} />,
                accent: 'magenta',
            },
            {
                key: 'avg',
                label: 'Average deal size',
                value: formatCurrency(data.avgDealSize),
                deltaPct: data.deltas.avg,
                sparkline: data.sparklines.avg,
                icon: <MoneyRegular fontSize={18} />,
                accent: 'amber',
            },
            {
                key: 'win',
                label: 'Win rate',
                value: formatPct(data.winRatePct, false),
                deltaPct: data.deltas.win,
                sparkline: data.sparklines.win,
                icon: <TrophyRegular fontSize={18} />,
                accent: 'blue',
            },
        ],
        [data],
    );

    const handleRefresh = () => {
        setSeed((s) => s + 1);
    };

    return (
        <div className={styles.themeRoot} style={themeToVars(webDarkTheme as unknown as Record<string, string>)}>
            <div className={styles.root}>
                <main className={styles.page}>
                    <header className={styles.header}>
                        <div className={styles.headerText}>
                            <Title2 as="h1" className={styles.headerTitle}>
                                Sales dashboard
                            </Title2>
                            <Caption1 className={styles.headerCaption}>Last updated {formatToday()}</Caption1>
                        </div>
                        <div className={styles.headerActions}>
                            <RangeToggle value={range} onChange={setRange} />
                            <Tooltip content="Refresh mock data" relationship="label">
                                <Button
                                    appearance="secondary"
                                    icon={<ArrowClockwiseRegular />}
                                    className={styles.refreshBtn}
                                    onClick={handleRefresh}
                                    aria-label="Refresh dashboard data"
                                >
                                    Refresh
                                </Button>
                            </Tooltip>
                        </div>
                    </header>

                    <section className={styles.kpiBar} aria-label="Key performance indicators">
                        {tiles.map((t) => (
                            <KpiTileCard key={t.key} tile={t} />
                        ))}
                    </section>

                    <section
                        className={styles.chartCard}
                        aria-labelledby="revenue-chart-title"
                    >
                        <div className={styles.chartHeader}>
                            <div className={styles.chartHeaderText}>
                                <Title3 id="revenue-chart-title" className={styles.chartTitle}>
                                    Monthly revenue
                                </Title3>
                                <Caption1 className={styles.chartCaption}>
                                    {range === 'YTD'
                                        ? 'Year to date'
                                        : range === '6M'
                                        ? 'Last 6 months'
                                        : 'Last 12 months'}
                                    {' · hover to inspect any month'}
                                </Caption1>
                            </div>
                            <div className={styles.chartLegend} aria-hidden="true">
                                <span className={styles.legendItem}>
                                    <span className={styles.legendSwatch} /> Revenue
                                </span>
                            </div>
                        </div>
                        <RevenueChart data={monthlySlice} />
                    </section>

                    <section
                        className={styles.tableCard}
                        aria-labelledby="top-customers-title"
                    >
                        <div className={styles.chartHeader}>
                            <div className={styles.chartHeaderText}>
                                <Title3 id="top-customers-title" className={styles.chartTitle}>
                                    Top 5 customers
                                </Title3>
                                <Caption1 className={styles.chartCaption}>
                                    Ranked by revenue year to date
                                </Caption1>
                            </div>
                        </div>
                        <Divider style={{ opacity: 0.4 }} />
                        <CustomersTable rows={data.customers} />
                    </section>
                </main>
            </div>
        </div>
    );
};

export default GeneratedComponent;
