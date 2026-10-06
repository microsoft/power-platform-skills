import { useEffect, useMemo, useState } from 'react';
import type {
    ReadableTableRow,
    GeneratedComponentProps,
    cr_project,
    cr_milestone,
} from './RuntimeTypes';
import {
    makeStyles,
    mergeClasses,
    tokens,
    Text,
    Spinner,
    Button,
    Badge,
    ProgressBar,
    SearchBox,
    Card,
    TabList,
    Tab,
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
import type { TableColumnDefinition } from '@fluentui/react-components';
import {
    ArrowClockwiseRegular,
    BriefcaseRegular,
    CalendarLtrRegular,
    FlagRegular,
    OpenRegular,
    PersonRegular,
    WarningRegular,
} from '@fluentui/react-icons';

type ReadableProject = ReadableTableRow<cr_project>;
type ReadableMilestone = ReadableTableRow<cr_milestone>;

type BadgeColor = 'brand' | 'danger' | 'informative' | 'subtle' | 'success' | 'warning';
type MilestoneView = 'all' | 'open' | 'overdue';

// ── Choice codes (verified against RuntimeTypes cr_project_cr_status / cr_milestone_cr_status) ──
const PROJECT_PLANNING = 100000000;
const PROJECT_ACTIVE = 100000001;
const PROJECT_ON_HOLD = 100000002;
const PROJECT_COMPLETED = 100000003;

const MILESTONE_NOT_STARTED = 100000000;
const MILESTONE_IN_PROGRESS = 100000001;
const MILESTONE_COMPLETED = 100000002;
const MILESTONE_BLOCKED = 100000003;

const PROJECT_STATUS: Record<number, { label: string; color: BadgeColor }> = {
    [PROJECT_PLANNING]: { label: 'Planning', color: 'informative' },
    [PROJECT_ACTIVE]: { label: 'Active', color: 'brand' },
    [PROJECT_ON_HOLD]: { label: 'On Hold', color: 'warning' },
    [PROJECT_COMPLETED]: { label: 'Completed', color: 'success' },
};

const MILESTONE_STATUS: Record<number, { label: string; color: BadgeColor }> = {
    [MILESTONE_NOT_STARTED]: { label: 'Not Started', color: 'subtle' },
    [MILESTONE_IN_PROGRESS]: { label: 'In Progress', color: 'brand' },
    [MILESTONE_COMPLETED]: { label: 'Completed', color: 'success' },
    [MILESTONE_BLOCKED]: { label: 'Blocked', color: 'danger' },
};

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
const DUE_SOON_DAYS = 30;

// ── Window cache + in-flight de-dupe (references/data-caching.md, Pattern 1) ──
// Keys are scoped to this page so another page querying cr_project with a different
// select can never read these rows.
const CACHE_KEY = '__ppProjectTracker_projectMilestoneCache';
const INFLIGHT_KEY = '__ppProjectTracker_projectMilestoneInflight';
const winAny = window as unknown as Record<string, unknown>;

interface TrackerData {
    projects: ReadableProject[];
    milestones: ReadableMilestone[];
}

interface ProjectStats {
    total: number;
    completed: number;
    overdue: number;
    progress: number;
}

interface TrackerState extends TrackerData {
    loading: boolean;
    error: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadTracker(dataApi: GeneratedComponentProps['dataApi']): Promise<TrackerData> {
    // Both reads in one round of Promise.all so the page settles with a single setData.
    return Promise.all([
        dataApi.queryTable('cr_project', {
            select: ['cr_projectid', 'cr_name', 'cr_manager', 'cr_startdate', 'cr_targetdate', 'cr_budget', 'cr_status'],
            orderBy: 'cr_targetdate asc',
            pageSize: 250,
        }),
        dataApi.queryTable('cr_milestone', {
            select: ['cr_milestoneid', 'cr_name', 'cr_duedate', 'cr_percentcomplete', 'cr_status', '_cr_project_value'],
            orderBy: 'cr_duedate asc',
            pageSize: 500,
        }),
    ]).then(([projectResult, milestoneResult]) => ({
        projects: projectResult.rows as ReadableProject[],
        milestones: milestoneResult.rows as ReadableMilestone[],
    }));
}

function formatted(row: object, field: string): string {
    const value = (row as Record<string, unknown>)[`${field}${FORMATTED}`];
    return typeof value === 'string' ? value : '';
}

// A read lookup carries the parent GUID; the writable form is "/cr_project(<guid>)". Normalize both.
function lookupKey(value: unknown): string {
    if (typeof value !== 'string') return '';
    const wrapped = /\(([0-9a-fA-F-]{36})\)/.exec(value);
    return (wrapped ? wrapped[1] : value).toLowerCase();
}

// Date-only columns arrive as "YYYY-MM-DD"; parse them as local dates so they never shift a day.
function toDate(value: unknown): Date | null {
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    if (typeof value !== 'string' || !value) return null;
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const parsed = dateOnly
        ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
        : new Date(value);
    return isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value: unknown): string {
    const date = toDate(value);
    return date ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
}

function startOfToday(): Date {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
}

function isMilestoneOverdue(milestone: ReadableMilestone, today: Date): boolean {
    if (Number(milestone.cr_status) === MILESTONE_COMPLETED) return false;
    const due = toDate(milestone.cr_duedate);
    return due !== null && due.getTime() < today.getTime();
}

function isMilestoneDueSoon(milestone: ReadableMilestone, today: Date): boolean {
    if (Number(milestone.cr_status) === MILESTONE_COMPLETED) return false;
    const due = toDate(milestone.cr_duedate);
    if (!due) return false;
    const days = (due.getTime() - today.getTime()) / 86400000;
    return days >= 0 && days <= DUE_SOON_DAYS;
}

function projectStatus(project: ReadableProject): { label: string; color: BadgeColor } {
    const known = PROJECT_STATUS[Number(project.cr_status)];
    return { label: formatted(project, 'cr_status') || known?.label || 'Unknown', color: known?.color ?? 'subtle' };
}

function milestoneStatus(milestone: ReadableMilestone): { label: string; color: BadgeColor } {
    const known = MILESTONE_STATUS[Number(milestone.cr_status)];
    return { label: formatted(milestone, 'cr_status') || known?.label || 'Unknown', color: known?.color ?? 'subtle' };
}

function computeStats(milestones: ReadableMilestone[], today: Date): ProjectStats {
    const total = milestones.length;
    const completed = milestones.filter((m) => Number(m.cr_status) === MILESTONE_COMPLETED).length;
    const overdue = milestones.filter((m) => isMilestoneOverdue(m, today)).length;
    const percentSum = milestones.reduce((sum, m) => sum + Math.min(100, Math.max(0, Number(m.cr_percentcomplete ?? 0))), 0);
    return { total, completed, overdue, progress: total === 0 ? 0 : percentSum / (total * 100) };
}

function openRecord(entityName: 'cr_project' | 'cr_milestone', entityId: string) {
    const xrm = (window as unknown as {
        Xrm?: { Navigation?: { navigateTo: (pageInput: Record<string, unknown>) => unknown } };
    }).Xrm;
    xrm?.Navigation?.navigateTo({ pageType: 'entityrecord', entityName, entityId });
}

function buildMilestoneColumns(today: Date): TableColumnDefinition<ReadableMilestone>[] {
    return [
        createTableColumn<ReadableMilestone>({
            columnId: 'name',
            compare: (a, b) => (a.cr_name ?? '').localeCompare(b.cr_name ?? ''),
            renderHeaderCell: () => 'Milestone',
            renderCell: (item) => (
                <TableCellLayout media={<FlagRegular />} truncate title={item.cr_name ?? ''}>
                    {item.cr_name ?? '—'}
                </TableCellLayout>
            ),
        }),
        createTableColumn<ReadableMilestone>({
            columnId: 'duedate',
            compare: (a, b) => (toDate(a.cr_duedate)?.getTime() ?? 0) - (toDate(b.cr_duedate)?.getTime() ?? 0),
            renderHeaderCell: () => 'Due date',
            renderCell: (item) => <DueDateCell milestone={item} today={today} />,
        }),
        createTableColumn<ReadableMilestone>({
            columnId: 'status',
            compare: (a, b) => Number(a.cr_status) - Number(b.cr_status),
            renderHeaderCell: () => 'Status',
            renderCell: (item) => {
                const status = milestoneStatus(item);
                return (
                    <TableCellLayout>
                        <Badge appearance="tint" color={status.color}>{status.label}</Badge>
                    </TableCellLayout>
                );
            },
        }),
        createTableColumn<ReadableMilestone>({
            columnId: 'progress',
            compare: (a, b) => Number(a.cr_percentcomplete ?? 0) - Number(b.cr_percentcomplete ?? 0),
            renderHeaderCell: () => 'Progress',
            renderCell: (item) => <ProgressCell percent={Number(item.cr_percentcomplete ?? 0)} />,
        }),
        createTableColumn<ReadableMilestone>({
            columnId: 'open',
            renderHeaderCell: () => '',
            renderCell: (item) => (
                <Button
                    appearance="subtle"
                    icon={<OpenRegular />}
                    aria-label={`Open milestone ${item.cr_name ?? ''}`}
                    onClick={() => openRecord('cr_milestone', item.cr_milestoneid)}
                />
            ),
        }),
    ];
}

// ── Styles ────────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalL,
        padding: tokens.spacingHorizontalXL,
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        '@media (max-width: 600px)': {
            padding: tokens.spacingHorizontalM,
        },
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens.spacingHorizontalM,
        flexWrap: 'wrap',
    },
    titleBlock: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
    },
    subtle: {
        color: tokens.colorNeutralForeground3,
    },
    summary: {
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        gap: tokens.spacingHorizontalM,
        '@media (max-width: 1024px)': {
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        },
        '@media (max-width: 480px)': {
            gridTemplateColumns: '1fr',
        },
    },
    tile: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalM,
        padding: tokens.spacingHorizontalM,
        borderRadius: tokens.borderRadiusLarge,
        backgroundColor: tokens.colorNeutralBackground2,
    },
    tileIcon: {
        display: 'flex',
        fontSize: tokens.fontSizeBase600,
        color: tokens.colorBrandForeground1,
    },
    tileIconDanger: {
        color: tokens.colorPaletteRedForeground1,
    },
    tileText: {
        display: 'flex',
        flexDirection: 'column',
    },
    body: {
        display: 'grid',
        gridTemplateColumns: 'minmax(260px, 1fr) minmax(0, 2fr)',
        gap: tokens.spacingHorizontalL,
        flex: 1,
        minHeight: 0,
        '@media (max-width: 900px)': {
            gridTemplateColumns: '1fr',
        },
    },
    pane: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
        minHeight: 0,
        minWidth: 0,
    },
    projectList: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
        overflowY: 'auto',
        minHeight: 0,
        paddingRight: tokens.spacingHorizontalXS,
    },
    projectCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
        cursor: 'pointer',
    },
    projectCardSelected: {
        outlineStyle: 'solid',
        outlineWidth: tokens.strokeWidthThick,
        outlineColor: tokens.colorBrandStroke1,
    },
    cardTitleRow: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens.spacingHorizontalS,
    },
    cardTitle: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
    },
    metaRow: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        color: tokens.colorNeutralForeground3,
        flexWrap: 'wrap',
    },
    detail: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
        padding: tokens.spacingHorizontalL,
        borderRadius: tokens.borderRadiusLarge,
        backgroundColor: tokens.colorNeutralBackground1,
        boxShadow: tokens.shadow4,
        minHeight: 0,
        minWidth: 0,
    },
    detailFacts: {
        display: 'grid',
        gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        gap: tokens.spacingHorizontalM,
        '@media (max-width: 768px)': {
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        },
    },
    fact: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
    },
    gridScroll: {
        overflow: 'auto',
        minHeight: 0,
        flex: 1,
    },
    dateCell: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXS,
    },
    overdue: {
        color: tokens.colorPaletteRedForeground1,
        fontWeight: tokens.fontWeightSemibold,
    },
    progressCell: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        width: '100%',
    },
    progressBar: {
        flex: 1,
    },
    empty: {
        padding: tokens.spacingVerticalXL,
        textAlign: 'center',
        color: tokens.colorNeutralForeground3,
    },
    spinnerWrap: {
        display: 'flex',
        justifyContent: 'center',
        padding: tokens.spacingVerticalXXL,
    },
});

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryTile(props: { label: string; value: number; icon: JSX.Element; danger?: boolean }) {
    const styles = useStyles();
    return (
        <div className={styles.tile}>
            <span className={mergeClasses(styles.tileIcon, props.danger && styles.tileIconDanger)} aria-hidden="true">
                {props.icon}
            </span>
            <div className={styles.tileText}>
                <Text size={600} weight="semibold">{props.value}</Text>
                <Text size={200} className={styles.subtle}>{props.label}</Text>
            </div>
        </div>
    );
}

function ProjectCard(props: {
    project: ReadableProject;
    stats: ProjectStats;
    selected: boolean;
    onSelect: (projectId: string) => void;
}) {
    const styles = useStyles();
    const { project, stats, selected, onSelect } = props;
    const status = projectStatus(project);
    return (
        <Card
            className={mergeClasses(styles.projectCard, selected && styles.projectCardSelected)}
            onClick={() => onSelect(project.cr_projectid)}
            aria-current={selected ? 'true' : undefined}
            aria-label={`${project.cr_name ?? 'Project'}, ${status.label}`}
        >
            <div className={styles.cardTitleRow}>
                <Text weight="semibold" className={styles.cardTitle} title={project.cr_name ?? ''}>
                    {project.cr_name ?? '—'}
                </Text>
                <Badge appearance="filled" color={status.color}>{status.label}</Badge>
            </div>
            <div className={styles.metaRow}>
                <PersonRegular aria-hidden="true" />
                <Text size={200}>{project.cr_manager ?? 'Unassigned'}</Text>
                <CalendarLtrRegular aria-hidden="true" />
                <Text size={200}>Target {formatDate(project.cr_targetdate)}</Text>
            </div>
            <ProgressBar
                value={stats.progress}
                thickness="large"
                color={stats.overdue > 0 ? 'error' : 'brand'}
                aria-label={`${Math.round(stats.progress * 100)}% complete`}
            />
            <Text size={200} className={styles.subtle}>
                {stats.completed} of {stats.total} milestones complete
                {stats.overdue > 0 ? ` · ${stats.overdue} overdue` : ''}
            </Text>
        </Card>
    );
}

function DueDateCell(props: { milestone: ReadableMilestone; today: Date }) {
    const styles = useStyles();
    const overdue = isMilestoneOverdue(props.milestone, props.today);
    return (
        <TableCellLayout>
            <span className={mergeClasses(styles.dateCell, overdue && styles.overdue)}>
                {overdue ? <WarningRegular aria-label="Overdue" /> : <CalendarLtrRegular aria-hidden="true" />}
                {formatDate(props.milestone.cr_duedate)}
            </span>
        </TableCellLayout>
    );
}

function ProgressCell(props: { percent: number }) {
    const styles = useStyles();
    const percent = Math.min(100, Math.max(0, props.percent));
    return (
        <TableCellLayout>
            <div className={styles.progressCell}>
                <ProgressBar
                    className={styles.progressBar}
                    value={percent / 100}
                    color={percent === 100 ? 'success' : 'brand'}
                    aria-label={`${percent}% complete`}
                />
                <Text size={200}>{percent}%</Text>
            </div>
        </TableCellLayout>
    );
}

// ── Component ─────────────────────────────────────────────────────────────────

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // tracker list page takes no input; destructured per rules
    const styles = useStyles();

    const [data, setData] = useState<TrackerState>(() => {
        const cached = winAny[CACHE_KEY] as TrackerData | undefined;
        return {
            projects: cached?.projects ?? [],
            milestones: cached?.milestones ?? [],
            loading: cached === undefined,
            error: null,
        };
    });
    const [reloadKey, setReloadKey] = useState(0);
    const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [view, setView] = useState<MilestoneView>('all');

    const dataReady = !!dataApi;

    useEffect(() => {
        if (!dataReady) return; // wait until the host hands us the DataAPI

        // The window cache is authoritative: the host's second mount may have resolved it
        // between this render and this effect.
        const cached = winAny[CACHE_KEY] as TrackerData | undefined;
        if (cached !== undefined) {
            if (data.projects !== cached.projects || data.milestones !== cached.milestones) {
                setData({ projects: cached.projects, milestones: cached.milestones, loading: false, error: null });
            }
            return;
        }
        let cancelled = false;

        // Share one in-flight fetch across the host double-mount instead of querying twice.
        let inflight = winAny[INFLIGHT_KEY] as Promise<TrackerData> | undefined;
        if (!inflight) {
            inflight = loadTracker(dataApi)
                .then((result) => {
                    winAny[CACHE_KEY] = result;
                    return result;
                })
                // Clear only if still ours — a refresh may have replaced it.
                .finally(() => { if (winAny[INFLIGHT_KEY] === inflight) delete winAny[INFLIGHT_KEY]; });
            winAny[INFLIGHT_KEY] = inflight;
        }

        inflight
            .then((result) => {
                if (!cancelled) setData({ projects: result.projects, milestones: result.milestones, loading: false, error: null });
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                const message = err instanceof Error ? err.message : 'Unable to load projects and milestones.';
                setData({ projects: [], milestones: [], loading: false, error: message });
            });

        return () => { cancelled = true; };
        // Readiness + explicit reload only — never `dataApi` (a new reference every render).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady, reloadKey]);

    // Every derived value is computed above the early returns (Rule 19).
    const today = useMemo(() => startOfToday(), [data.milestones]);

    const milestonesByProject = useMemo(() => {
        const map = new Map<string, ReadableMilestone[]>();
        for (const milestone of data.milestones) {
            const key = lookupKey(milestone._cr_project_value);
            if (!key) continue;
            const list = map.get(key) ?? [];
            list.push(milestone);
            map.set(key, list);
        }
        return map;
    }, [data.milestones]);

    const statsByProject = useMemo(() => {
        const map = new Map<string, ProjectStats>();
        for (const project of data.projects) {
            const key = lookupKey(project.cr_projectid);
            map.set(key, computeStats(milestonesByProject.get(key) ?? [], today));
        }
        return map;
    }, [data.projects, milestonesByProject, today]);

    const summary = useMemo(() => ({
        active: data.projects.filter((p) => Number(p.cr_status) === PROJECT_ACTIVE).length,
        open: data.milestones.filter((m) => Number(m.cr_status) !== MILESTONE_COMPLETED).length,
        dueSoon: data.milestones.filter((m) => isMilestoneDueSoon(m, today)).length,
        overdue: data.milestones.filter((m) => isMilestoneOverdue(m, today)).length,
    }), [data.projects, data.milestones, today]);

    const filteredProjects = useMemo(() => {
        const term = search.trim().toLowerCase();
        if (!term) return data.projects;
        return data.projects.filter((p) =>
            (p.cr_name ?? '').toLowerCase().includes(term) || (p.cr_manager ?? '').toLowerCase().includes(term));
    }, [data.projects, search]);

    const selectedProject = useMemo(() => {
        const chosen = selectedProjectId
            ? filteredProjects.find((p) => lookupKey(p.cr_projectid) === selectedProjectId)
            : undefined;
        return chosen ?? filteredProjects[0] ?? null;
    }, [filteredProjects, selectedProjectId]);

    const selectedKey = selectedProject ? lookupKey(selectedProject.cr_projectid) : '';
    const selectedStats = statsByProject.get(selectedKey) ?? { total: 0, completed: 0, overdue: 0, progress: 0 };

    const visibleMilestones = useMemo(() => {
        const list = milestonesByProject.get(selectedKey) ?? [];
        if (view === 'open') return list.filter((m) => Number(m.cr_status) !== MILESTONE_COMPLETED);
        if (view === 'overdue') return list.filter((m) => isMilestoneOverdue(m, today));
        return list;
    }, [milestonesByProject, selectedKey, view, today]);

    const columns = useMemo(() => buildMilestoneColumns(today), [today]);

    const handleRefresh = () => {
        // Evict both the resolved cache and any pending promise, then re-run the effect.
        delete winAny[CACHE_KEY];
        delete winAny[INFLIGHT_KEY];
        setData({ projects: data.projects, milestones: data.milestones, loading: true, error: null });
        setReloadKey((key) => key + 1);
    };

    if (data.loading) {
        return (
            <div className={styles.root}>
                <div className={styles.spinnerWrap}>
                    <Spinner labelPosition="below" label="Loading projects and milestones…" />
                </div>
            </div>
        );
    }

    const selectedStatus = selectedProject ? projectStatus(selectedProject) : null;
    const budget = selectedProject
        ? formatted(selectedProject, 'cr_budget')
            || (typeof selectedProject.cr_budget === 'number' ? selectedProject.cr_budget.toLocaleString() : '—')
        : '—';

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <div className={styles.titleBlock}>
                    <Text as="h1" size={700} weight="semibold">Project tracker</Text>
                    <Text size={300} className={styles.subtle}>
                        {data.projects.length} projects · {data.milestones.length} milestones
                    </Text>
                </div>
                <Button appearance="secondary" icon={<ArrowClockwiseRegular />} onClick={handleRefresh}>
                    Refresh
                </Button>
            </header>

            {data.error && (
                <MessageBar intent="error">
                    <MessageBarBody>{data.error}</MessageBarBody>
                </MessageBar>
            )}

            <section className={styles.summary} aria-label="Portfolio summary">
                <SummaryTile label="Active projects" value={summary.active} icon={<BriefcaseRegular />} />
                <SummaryTile label="Open milestones" value={summary.open} icon={<FlagRegular />} />
                <SummaryTile label={`Due in the next ${DUE_SOON_DAYS} days`} value={summary.dueSoon} icon={<CalendarLtrRegular />} />
                <SummaryTile label="Overdue milestones" value={summary.overdue} icon={<WarningRegular />} danger={summary.overdue > 0} />
            </section>

            <div className={styles.body}>
                <section className={styles.pane} aria-label="Projects">
                    <SearchBox
                        placeholder="Search by project or manager"
                        value={search}
                        onChange={(_, d) => setSearch(d.value ?? '')}
                        aria-label="Search projects"
                    />
                    <div className={styles.projectList}>
                        {filteredProjects.length === 0 ? (
                            <Text className={styles.empty}>No projects match your search.</Text>
                        ) : (
                            filteredProjects.map((project) => {
                                const key = lookupKey(project.cr_projectid);
                                return (
                                    <ProjectCard
                                        key={key}
                                        project={project}
                                        stats={statsByProject.get(key) ?? { total: 0, completed: 0, overdue: 0, progress: 0 }}
                                        selected={key === selectedKey}
                                        onSelect={(id) => setSelectedProjectId(lookupKey(id))}
                                    />
                                );
                            })
                        )}
                    </div>
                </section>

                <section className={styles.detail} aria-label="Selected project">
                    {selectedProject && selectedStatus ? (
                        <>
                            <div className={styles.cardTitleRow}>
                                <div className={styles.titleBlock}>
                                    <Text as="h2" size={500} weight="semibold">{selectedProject.cr_name ?? '—'}</Text>
                                    <div className={styles.metaRow}>
                                        <Badge appearance="filled" color={selectedStatus.color}>{selectedStatus.label}</Badge>
                                        <PersonRegular aria-hidden="true" />
                                        <Text size={200}>{selectedProject.cr_manager ?? 'Unassigned'}</Text>
                                    </div>
                                </div>
                                <Button
                                    appearance="subtle"
                                    icon={<OpenRegular />}
                                    onClick={() => openRecord('cr_project', selectedProject.cr_projectid)}
                                >
                                    Open project
                                </Button>
                            </div>

                            <div className={styles.detailFacts}>
                                <div className={styles.fact}>
                                    <Text size={200} className={styles.subtle}>Start</Text>
                                    <Text weight="semibold">{formatDate(selectedProject.cr_startdate)}</Text>
                                </div>
                                <div className={styles.fact}>
                                    <Text size={200} className={styles.subtle}>Target</Text>
                                    <Text weight="semibold">{formatDate(selectedProject.cr_targetdate)}</Text>
                                </div>
                                <div className={styles.fact}>
                                    <Text size={200} className={styles.subtle}>Budget</Text>
                                    <Text weight="semibold">{budget}</Text>
                                </div>
                                <div className={styles.fact}>
                                    <Text size={200} className={styles.subtle}>Progress</Text>
                                    <Text weight="semibold">
                                        {Math.round(selectedStats.progress * 100)}% · {selectedStats.completed}/{selectedStats.total} done
                                    </Text>
                                </div>
                            </div>

                            <TabList
                                selectedValue={view}
                                onTabSelect={(_, d) => setView(d.value as MilestoneView)}
                                aria-label="Milestone filter"
                            >
                                <Tab value="all">All milestones</Tab>
                                <Tab value="open">Open</Tab>
                                <Tab value="overdue">Overdue ({selectedStats.overdue})</Tab>
                            </TabList>

                            <div className={styles.gridScroll}>
                                {visibleMilestones.length === 0 ? (
                                    <Text className={styles.empty}>No milestones in this view.</Text>
                                ) : (
                                    <DataGrid
                                        items={visibleMilestones}
                                        columns={columns}
                                        getRowId={(row) => row.cr_milestoneid}
                                        sortable
                                        resizableColumns
                                        columnSizingOptions={{
                                            name: { defaultWidth: 260, minWidth: 160 },
                                            duedate: { defaultWidth: 140, minWidth: 110 },
                                            status: { defaultWidth: 130, minWidth: 100 },
                                            progress: { defaultWidth: 180, minWidth: 120 },
                                            open: { defaultWidth: 56, minWidth: 48 },
                                        }}
                                        aria-label={`Milestones for ${selectedProject.cr_name ?? 'project'}`}
                                    >
                                        <DataGridHeader>
                                            <DataGridRow>
                                                {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
                                            </DataGridRow>
                                        </DataGridHeader>
                                        <DataGridBody<ReadableMilestone>>
                                            {({ item, rowId }) => (
                                                <DataGridRow<ReadableMilestone> key={rowId}>
                                                    {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
                                                </DataGridRow>
                                            )}
                                        </DataGridBody>
                                    </DataGrid>
                                )}
                            </div>
                        </>
                    ) : (
                        <Text className={styles.empty}>Select a project to see its milestones.</Text>
                    )}
                </section>
            </div>
        </div>
    );
};

export default GeneratedComponent;
