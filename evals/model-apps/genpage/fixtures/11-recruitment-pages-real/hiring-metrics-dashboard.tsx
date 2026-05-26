import { useEffect, useRef, useState } from 'react';
import type {
    ReadableTableRow,
    GeneratedComponentProps,
} from "./RuntimeTypes";
import {
    makeStyles,
    tokens,
    Text,
    Card,
    CardHeader,
    Button,
    Spinner,
    Badge,
    Divider,
} from '@fluentui/react-components';
import {
    PeopleRegular,
    CalendarRegular,
    ArrowClockwiseRegular,
    BriefcaseRegular,
    CalendarCheckmarkRegular,
} from '@fluentui/react-icons';
import * as d3 from 'd3';

// ---------- Types ----------

type ContactRow = ReadableTableRow<"contact">;
type AppointmentRow = ReadableTableRow<"appointment">;

interface DashboardProps extends GeneratedComponentProps {
    pageInput?: { entityName?: string; recordId?: string; data?: Record<string, unknown> };
}

interface DashboardData {
    contacts: ContactRow[];
    appointments: AppointmentRow[];
    loading: boolean;
    error: string | null;
}

interface RoleCount {
    role: string;
    count: number;
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
    titleRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalM,
    },
    sectionHeading: {
        marginTop: tokens.spacingVerticalS,
        marginBottom: tokens.spacingVerticalXS,
        color: tokens.colorNeutralForeground2,
    },
    statRow: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalL,
    },
    statCard: {
        flex: '1 1 200px',
        padding: tokens.spacingHorizontalL,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXS,
        cursor: 'pointer',
        ':hover': {
            boxShadow: tokens.shadow8,
        },
    },
    statLabel: {
        color: tokens.colorNeutralForeground2,
        fontSize: tokens.fontSizeBase300,
    },
    statValue: {
        fontSize: tokens.fontSizeHero900,
        fontWeight: tokens.fontWeightSemibold,
        color: tokens.colorBrandForeground1,
        lineHeight: '1',
    },
    statSubLabel: {
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
    },
    iconWrapper: {
        color: tokens.colorBrandForeground1,
        fontSize: '20px',
        display: 'flex',
        alignItems: 'center',
    },
    mainRow: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalL,
        alignItems: 'flex-start',
    },
    chartCard: {
        flex: '2 1 360px',
        minWidth: '0',
    },
    recentCard: {
        flex: '1 1 280px',
        minWidth: '0',
    },
    chartSvg: {
        width: '100%',
        height: '260px',
        display: 'block',
    },
    activityList: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
        marginTop: tokens.spacingVerticalS,
    },
    activityItem: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
        padding: `${tokens.spacingVerticalS} 0`,
    },
    activitySubject: {
        fontWeight: tokens.fontWeightSemibold,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    activityMeta: {
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
    },
    emptyState: {
        textAlign: 'center',
        padding: tokens.spacingVerticalXL,
        color: tokens.colorNeutralForeground3,
    },
    errorBanner: {
        padding: tokens.spacingHorizontalM,
        backgroundColor: tokens.colorPaletteRedBackground1,
        color: tokens.colorPaletteRedForeground1,
        borderRadius: tokens.borderRadiusMedium,
    },
    loadingContainer: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '200px',
    },
    badgeWrapper: {
        marginTop: tokens.spacingVerticalXXS,
    },
});

// ---------- Helpers ----------

function formatDate(value: unknown): string {
    if (!value) return '—';
    const d = new Date(value as string);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDateShort(value: unknown): string {
    if (!value) return '—';
    const d = new Date(value as string);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function isThisMonth(value: unknown): boolean {
    if (!value) return false;
    const d = new Date(value as string);
    if (isNaN(d.getTime())) return false;
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function isThisWeek(value: unknown): boolean {
    if (!value) return false;
    const d = new Date(value as string);
    if (isNaN(d.getTime())) return false;
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setHours(0, 0, 0, 0);
    startOfWeek.setDate(now.getDate() - now.getDay());
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 7);
    return d >= startOfWeek && d < endOfWeek;
}

function getTopRoles(contacts: ContactRow[], topN: number): RoleCount[] {
    const counts = new Map<string, number>();
    for (const c of contacts) {
        const role = (c['jobtitle'] as string) || 'Unspecified';
        counts.set(role, (counts.get(role) ?? 0) + 1);
    }
    return Array.from(counts.entries())
        .map(([role, count]) => ({ role, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, topN);
}

// ---------- Stat Card ----------

interface StatCardProps {
    icon: React.ReactNode;
    label: string;
    value: number | string;
    subLabel?: string;
    onClick?: () => void;
}

function StatCard(props: StatCardProps) {
    const styles = useStyles();
    return (
        <Card
            className={styles.statCard}
            onClick={props.onClick}
            role={props.onClick ? 'button' : undefined}
            tabIndex={props.onClick ? 0 : undefined}
            onKeyDown={props.onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') props.onClick!(); } : undefined}
            aria-label={`${props.label}: ${props.value}${props.subLabel ? `, ${props.subLabel}` : ''}`}
        >
            <CardHeader
                image={<span className={styles.iconWrapper}>{props.icon}</span>}
                header={<Text className={styles.statLabel}>{props.label}</Text>}
            />
            <Text className={styles.statValue}>{props.value}</Text>
            {props.subLabel && (
                <Text className={styles.statSubLabel}>{props.subLabel}</Text>
            )}
        </Card>
    );
}

// ---------- Pipeline Bar Chart ----------

const BAR_CHART_ANIM_KEY = '__ppHiringBarChartAnimated';

interface PipelineBarChartProps {
    data: RoleCount[];
}

function PipelineBarChart(props: PipelineBarChartProps) {
    const styles = useStyles();
    const svgRef = useRef<SVGSVGElement>(null);

    useEffect(() => {
        const node = svgRef.current;
        if (!node) return;
        if (props.data.length === 0) return;

        const svg = d3.select(node);
        const w = window as unknown as Record<string, boolean>;

        if (w[BAR_CHART_ANIM_KEY] && svg.selectAll('rect.bar').size() > 0) return;
        const shouldAnimate = !w[BAR_CHART_ANIM_KEY];
        w[BAR_CHART_ANIM_KEY] = true;

        svg.selectAll('*').remove();

        const rect = node.getBoundingClientRect();
        const width = rect.width || 480;
        const height = rect.height || 260;
        const margin = { top: 16, right: 24, bottom: 64, left: 48 };
        const innerW = width - margin.left - margin.right;
        const innerH = height - margin.top - margin.bottom;

        const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

        const x = d3.scaleBand()
            .domain(props.data.map(d => d.role))
            .range([0, innerW])
            .padding(0.3);

        const y = d3.scaleLinear()
            .domain([0, (d3.max(props.data, d => d.count) ?? 1) * 1.15])
            .range([innerH, 0])
            .nice();

        // X axis
        g.append('g')
            .attr('transform', `translate(0,${innerH})`)
            .call(d3.axisBottom(x))
            .attr('color', tokens.colorNeutralForeground3)
            .selectAll('text')
            .attr('font-size', '11px')
            .attr('fill', tokens.colorNeutralForeground2)
            .attr('dy', '1em')
            .call((textSel) => {
                textSel.each(function () {
                    const textNode = d3.select(this);
                    const label = textNode.text();
                    if (label.length > 14) {
                        textNode.text(label.slice(0, 13) + '…');
                    }
                });
            });

        // Y axis
        g.append('g')
            .call(d3.axisLeft(y).ticks(5).tickFormat(d => String(d)))
            .attr('color', tokens.colorNeutralForeground3)
            .selectAll('text')
            .attr('font-size', '11px')
            .attr('fill', tokens.colorNeutralForeground2);

        // Grid lines
        g.append('g')
            .attr('class', 'grid')
            .call(
                d3.axisLeft(y)
                    .ticks(5)
                    .tickSize(-innerW)
                    .tickFormat(() => '')
            )
            .attr('color', tokens.colorNeutralStroke2)
            .selectAll('line')
            .attr('stroke-dasharray', '3,3')
            .attr('opacity', 0.5);
        g.select('.grid .domain').remove();

        // Bars
        const bars = g.selectAll('rect.bar')
            .data(props.data)
            .enter()
            .append('rect')
            .attr('class', 'bar')
            .attr('x', d => x(d.role) ?? 0)
            .attr('width', x.bandwidth())
            .attr('rx', tokens.borderRadiusSmall)
            .attr('fill', tokens.colorBrandBackground);

        if (shouldAnimate) {
            bars
                .attr('y', innerH)
                .attr('height', 0)
                .transition()
                .duration(600)
                .delay((_, i) => i * 80)
                .attr('y', d => y(d.count))
                .attr('height', d => innerH - y(d.count));
        } else {
            bars
                .attr('y', d => y(d.count))
                .attr('height', d => innerH - y(d.count));
        }

        // Value labels on bars
        g.selectAll('text.bar-label')
            .data(props.data)
            .enter()
            .append('text')
            .attr('class', 'bar-label')
            .attr('x', d => (x(d.role) ?? 0) + x.bandwidth() / 2)
            .attr('y', d => y(d.count) - 4)
            .attr('text-anchor', 'middle')
            .attr('fill', tokens.colorNeutralForeground1)
            .attr('font-size', '12px')
            .attr('font-weight', '600')
            .text(d => String(d.count));

    }, [props.data]);

    if (props.data.length === 0) {
        return null;
    }

    return (
        <svg
            ref={svgRef}
            className={styles.chartSvg}
            role="img"
            aria-label="Pipeline by role — candidate count per job title"
        />
    );
}

// ---------- Recent Activity Item ----------

interface ActivityItemProps {
    subject: string;
    candidateName: string;
    scheduledStart: unknown;
    statecode: number;
}

function ActivityItem(props: ActivityItemProps) {
    const styles = useStyles();
    const statusLabel = props.statecode === 3 ? 'Scheduled'
        : props.statecode === 1 ? 'Completed'
        : props.statecode === 2 ? 'Canceled'
        : 'Open';
    const statusAppearance: 'informative' | 'success' | 'danger' | 'warning' =
        props.statecode === 3 ? 'informative'
        : props.statecode === 1 ? 'success'
        : props.statecode === 2 ? 'danger'
        : 'warning';

    return (
        <div className={styles.activityItem}>
            <Text className={styles.activitySubject} title={props.subject}>
                {props.subject || '(No subject)'}
            </Text>
            <Text className={styles.activityMeta}>
                {props.candidateName || 'No candidate linked'} &middot; {formatDate(props.scheduledStart)}
            </Text>
            <span className={styles.badgeWrapper}>
                <Badge appearance="tint" color={statusAppearance} size="small">
                    {statusLabel}
                </Badge>
            </span>
        </div>
    );
}

// ---------- Main Component ----------

const GeneratedComponent = (props: DashboardProps) => {
    const { dataApi, pageInput } = props;
    void pageInput;

    const [{ contacts, appointments, loading, error }, setData] = useState<DashboardData>({
        contacts: [],
        appointments: [],
        loading: true,
        error: null,
    });

    useEffect(() => {
        if (!dataApi) return;

        (async () => {
            try {
                const [contactResult, apptResult] = await Promise.all([
                    dataApi.queryTable("contact", {
                        select: ["contactid", "fullname", "jobtitle", "statuscode", "statecode"],
                        filter: "statecode eq 0",
                        pageSize: 500,
                    }),
                    dataApi.queryTable("appointment", {
                        select: ["activityid", "subject", "scheduledstart", "_regardingobjectid_value", "statecode"],
                        orderBy: "scheduledstart desc",
                        pageSize: 10,
                    }),
                ]);

                setData({
                    contacts: contactResult.rows as ContactRow[],
                    appointments: apptResult.rows as AppointmentRow[],
                    loading: false,
                    error: null,
                });
            } catch (err) {
                setData({
                    contacts: [],
                    appointments: [],
                    loading: false,
                    error: "Failed to load dashboard data. Please try refreshing.",
                });
            }
        })();
    }, [dataApi]);

    const styles = useStyles();

    function handleRefresh() {
        setData({ contacts: [], appointments: [], loading: true, error: null });
        if (!dataApi) return;

        (async () => {
            try {
                const [contactResult, apptResult] = await Promise.all([
                    dataApi.queryTable("contact", {
                        select: ["contactid", "fullname", "jobtitle", "statuscode", "statecode"],
                        filter: "statecode eq 0",
                        pageSize: 500,
                    }),
                    dataApi.queryTable("appointment", {
                        select: ["activityid", "subject", "scheduledstart", "_regardingobjectid_value", "statecode"],
                        orderBy: "scheduledstart desc",
                        pageSize: 10,
                    }),
                ]);

                setData({
                    contacts: contactResult.rows as ContactRow[],
                    appointments: apptResult.rows as AppointmentRow[],
                    loading: false,
                    error: null,
                });
            } catch (err) {
                setData({
                    contacts: [],
                    appointments: [],
                    loading: false,
                    error: "Failed to load dashboard data. Please try refreshing.",
                });
            }
        })();
    }

    function navigateToCandidates() {
        const xrm = (window as any).Xrm;
        xrm?.Navigation?.navigateTo({
            pageType: "generative",
            pageId: "492d8c42-b5fc-4ec5-ad44-6809c6673e9a",
        });
    }

    function navigateToSchedule() {
        const xrm = (window as any).Xrm;
        xrm?.Navigation?.navigateTo({
            pageType: "generative",
            pageId: "07ad1d40-5ca8-494a-aeac-ff0548acb6c0",
        });
    }

    // --- Computed metrics ---
    const totalActiveCandidates = contacts.length;
    const interviewsThisMonth = appointments.filter(a => isThisMonth(a['scheduledstart'])).length;
    const interviewsThisWeek = appointments.filter(a => isThisWeek(a['scheduledstart'])).length;
    const openRoles = (() => {
        const titles = new Set<string>();
        for (const c of contacts) {
            const title = c['jobtitle'] as string;
            if (title && title.trim()) titles.add(title.trim());
        }
        return titles.size;
    })();
    const topRoles = getTopRoles(contacts, 5);

    // Recent 5 appointments (already ordered desc by scheduledstart from API, take first 5)
    const recentAppointments = appointments.slice(0, 5);

    if (loading) {
        return (
            <div className={styles.loadingContainer} role="status" aria-label="Loading dashboard data">
                <Spinner label="Loading recruitment dashboard…" size="large" />
            </div>
        );
    }

    return (
        <main className={styles.root}>
            {/* Title + refresh */}
            <div className={styles.titleRow}>
                <Text as="h1" size={700} weight="semibold">
                    Hiring metrics dashboard
                </Text>
                <Button
                    icon={<ArrowClockwiseRegular />}
                    onClick={handleRefresh}
                    appearance="subtle"
                    aria-label="Refresh dashboard data"
                >
                    Refresh
                </Button>
            </div>

            {/* Error banner */}
            {error && (
                <div className={styles.errorBanner} role="alert">
                    <Text>{error}</Text>
                </div>
            )}

            {/* At a Glance */}
            <Text as="h2" size={400} weight="semibold" className={styles.sectionHeading}>
                At a glance
            </Text>
            <section className={styles.statRow} aria-label="Key recruitment metrics">
                <StatCard
                    icon={<PeopleRegular />}
                    label="Total active candidates"
                    value={totalActiveCandidates}
                    subLabel="Active contacts"
                    onClick={navigateToCandidates}
                />
                <StatCard
                    icon={<CalendarRegular />}
                    label="Interviews this month"
                    value={interviewsThisMonth}
                    subLabel="Appointments in current month"
                    onClick={navigateToSchedule}
                />
                <StatCard
                    icon={<CalendarCheckmarkRegular />}
                    label="Interviews this week"
                    value={interviewsThisWeek}
                    subLabel="Appointments in current week"
                    onClick={navigateToSchedule}
                />
                <StatCard
                    icon={<BriefcaseRegular />}
                    label="Open positions"
                    value={openRoles}
                    subLabel="Distinct job titles"
                />
            </section>

            <Divider />

            {/* Pipeline + Recent side by side */}
            <div className={styles.mainRow}>
                {/* Pipeline by role */}
                <Card className={styles.chartCard}>
                    <CardHeader
                        header={
                            <Text as="h2" size={400} weight="semibold">
                                Pipeline by role
                            </Text>
                        }
                        description="Top 5 job titles by active candidate count"
                    />
                    {topRoles.length === 0 ? (
                        <div className={styles.emptyState}>
                            <Text>No candidate data available.</Text>
                        </div>
                    ) : (
                        <PipelineBarChart data={topRoles} />
                    )}
                </Card>

                {/* Recent interviews */}
                <Card className={styles.recentCard}>
                    <CardHeader
                        header={
                            <Text as="h2" size={400} weight="semibold">
                                Recent interviews
                            </Text>
                        }
                        description="5 most recent appointments"
                    />
                    {recentAppointments.length === 0 ? (
                        <div className={styles.emptyState}>
                            <Text>No recent interviews found.</Text>
                        </div>
                    ) : (
                        <section className={styles.activityList} aria-label="Recent interview activity">
                            {recentAppointments.map((appt, idx) => {
                                const candidateName =
                                    (appt['_regardingobjectid_value@OData.Community.Display.V1.FormattedValue'] as string) || '';
                                return (
                                    <div key={(appt['activityid'] as string) || String(idx)}>
                                        <ActivityItem
                                            subject={appt['subject'] as string}
                                            candidateName={candidateName}
                                            scheduledStart={appt['scheduledstart']}
                                            statecode={appt['statecode'] as number}
                                        />
                                        {idx < recentAppointments.length - 1 && <Divider />}
                                    </div>
                                );
                            })}
                        </section>
                    )}
                </Card>
            </div>
        </main>
    );
};

export default GeneratedComponent;
