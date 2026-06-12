import React, { useState, useEffect } from 'react';
import {
    makeStyles,
    mergeClasses,
    shorthands,
    tokens,
    Card,
    CardHeader,
    Body1,
    Caption1,
    Text,
    Badge,
    Spinner,
    MessageBar,
    MessageBarBody,
} from '@fluentui/react-components';
import {
    ClipboardTaskRegular,
    PlayRegular,
    CheckmarkCircleRegular,
} from '@fluentui/react-icons';
import type { GeneratedComponentProps, task } from './RuntimeTypes';

// ---- Status constants (verified against RuntimeTypes task_statuscode enum) ----
// RuntimeTypes: "Not Started" = 2, "In Progress" = 3, "Completed" = 5
const TO_DO = 2 as const;
const IN_PROGRESS = 3 as const;
const DONE = 5 as const;
type StatusValue = typeof TO_DO | typeof IN_PROGRESS | typeof DONE;

// Dataverse enforces statecode alignment with statuscode
function stateCodeFor(s: StatusValue): number {
    return s === DONE ? 1 : 0; // 1 = Completed, 0 = Open
}

// ---- Priority display (RuntimeTypes: Low=0, Normal=1, High=2) ----
const PRIORITY_LABEL: Record<number, string> = { 0: 'Low', 1: 'Normal', 2: 'High' };
type BadgeColor = 'success' | 'brand' | 'warning';
const PRIORITY_COLOR: Record<number, BadgeColor> = { 0: 'success', 1: 'brand', 2: 'warning' };

// ---- Column configuration ----
interface ColumnDef {
    key: StatusValue;
    label: string;
    icon: React.ReactNode;
    accent: BadgeColor;
}
const COLUMNS: ColumnDef[] = [
    { key: TO_DO,       label: 'To Do',       icon: <ClipboardTaskRegular />, accent: 'brand'   },
    { key: IN_PROGRESS, label: 'In Progress',  icon: <PlayRegular />,          accent: 'warning' },
    { key: DONE,        label: 'Done',         icon: <CheckmarkCircleRegular />, accent: 'success' },
];

// ---- Window cache (survives module re-evaluation on navigation) ----
let _taskCache: task[] | null = (window as any).__ppTaskCache ?? null;

// ---- Due date formatting ----
function formatDue(date: Date | null | undefined): { text: string; overdue: boolean } | null {
    if (!date) return null;
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    const overdue = d < new Date();
    const text = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return { text: overdue ? `${text} (overdue)` : text, overdue };
}

// ---- Styles ----
const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        paddingInline: tokens.spacingHorizontalL,
        paddingBlock: tokens.spacingVerticalL,
        gap: tokens.spacingVerticalM,
        boxSizing: 'border-box',
        overflowY: 'hidden',
    },
    pageHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        flexShrink: 0,
    },
    board: {
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(260px, 1fr))',
        gap: tokens.spacingHorizontalM,
        flex: 1,
        overflowX: 'auto',
        overflowY: 'hidden',
        minHeight: 0,
    },
    column: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXS,
        paddingInline: tokens.spacingHorizontalS,
        paddingBlock: tokens.spacingVerticalS,
        backgroundColor: tokens.colorNeutralBackground2,
        borderRadius: tokens.borderRadiusMedium,
        minHeight: 0,
        transitionProperty: 'background-color',
        transitionDuration: tokens.durationNormal,
    },
    columnOver: {
        backgroundColor: tokens.colorBrandBackground2,
        outlineWidth: '2px',
        outlineStyle: 'dashed',
        outlineColor: tokens.colorBrandStroke1,
        outlineOffset: '-2px',
    },
    columnHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXS,
        paddingBlockEnd: tokens.spacingVerticalXS,
        flexShrink: 0,
    },
    columnBody: {
        flex: 1,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXS,
        minHeight: 0,
        paddingBlockEnd: tokens.spacingVerticalXS,
    },
    card: {
        cursor: 'grab',
        transitionProperty: 'opacity',
        transitionDuration: tokens.durationNormal,
        ':active': { cursor: 'grabbing' },
    },
    cardDragging: { opacity: 0.45 },
    cardBody: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
        paddingInline: tokens.spacingHorizontalM,
        paddingBlockEnd: tokens.spacingVerticalS,
    },
    cardMeta: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXS,
        flexWrap: 'wrap',
    },
    dueNormal: { color: tokens.colorNeutralForeground3 },
    dueOverdue: { color: tokens.colorPaletteRedForeground1, fontWeight: tokens.fontWeightSemibold },
    emptyHint: {
        color: tokens.colorNeutralForeground3,
        fontStyle: 'italic',
        textAlign: 'center',
        paddingBlock: tokens.spacingVerticalL,
    },
    dropError: { flexShrink: 0 },
    spinnerWrap: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '200px',
    },
});

// ---- Task card sub-component ----

interface TaskCardProps {
    item: task;
    dragging: boolean;
    onDragStart: (e: React.DragEvent<HTMLDivElement>, id: string) => void;
    onDragEnd: () => void;
}

const TaskCard = ({ item, dragging, onDragStart, onDragEnd }: TaskCardProps) => {
    const styles = useStyles();
    const priority = item.prioritycode as unknown as number;
    const label = PRIORITY_LABEL[priority] ?? 'Normal';
    const color: BadgeColor = PRIORITY_COLOR[priority] ?? 'brand';
    const due = formatDue(item.scheduledend);

    return (
        <Card
            className={mergeClasses(styles.card, dragging && styles.cardDragging)}
            draggable
            onDragStart={(e) => onDragStart(e, item.activityid)}
            onDragEnd={onDragEnd}
            aria-grabbed={dragging}
            aria-label={`Task: ${item.subject}`}
        >
            <CardHeader header={<Body1 weight="semibold">{item.subject}</Body1>} />
            <div className={styles.cardBody}>
                <div className={styles.cardMeta}>
                    <Badge appearance="tint" color={color} size="small">
                        {label}
                    </Badge>
                    {due && (
                        <Caption1 className={due.overdue ? styles.dueOverdue : styles.dueNormal}>
                            {due.text}
                        </Caption1>
                    )}
                </div>
            </div>
        </Card>
    );
};

// ---- Main component ----

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput;
    const styles = useStyles();

    const [{ tasks, loading, error }, setData] = useState<{
        tasks: task[];
        loading: boolean;
        error: string | null;
    }>({
        tasks: _taskCache ?? [],
        loading: _taskCache === null,
        error: null,
    });

    // Drag/hover state is intentionally separate — these are pure UI, not data state
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [hoverCol, setHoverCol] = useState<StatusValue | null>(null);
    const [dropError, setDropError] = useState<string | null>(null);

    useEffect(() => {
        if (!dataApi || _taskCache !== null) return;
        (async () => {
            try {
                const result = await dataApi.queryTable('task', {
                    select: ['activityid', 'subject', 'statuscode', 'prioritycode', 'scheduledend'],
                    orderBy: 'createdon asc',
                    pageSize: 200,
                });
                _taskCache = result.rows as unknown as task[];
                (window as any).__ppTaskCache = _taskCache;
                setData({ tasks: _taskCache, loading: false, error: null });
            } catch (err) {
                setData({
                    tasks: [],
                    loading: false,
                    error: err instanceof Error ? err.message : 'Failed to load tasks.',
                });
            }
        })();
    }, [dataApi]);

    const handleDragStart = (e: React.DragEvent<HTMLDivElement>, taskId: string) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', taskId);
        setDraggingId(taskId);
    };

    const handleDragEnd = () => {
        setDraggingId(null);
        setHoverCol(null);
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>, colKey: StatusValue) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (hoverCol !== colKey) setHoverCol(colKey);
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setHoverCol(null);
        }
    };

    const handleDrop = async (e: React.DragEvent<HTMLDivElement>, targetStatus: StatusValue) => {
        e.preventDefault();
        const taskId = e.dataTransfer.getData('text/plain');
        setHoverCol(null);
        setDropError(null);
        if (!taskId) return;

        const current = tasks.find((t) => t.activityid === taskId);
        if (!current) return;
        if ((current.statuscode as unknown as number) === targetStatus) return;

        // Optimistic update
        const nextTasks = tasks.map((t) =>
            t.activityid === taskId
                ? { ...t, statuscode: targetStatus as unknown as typeof t.statuscode }
                : t,
        );
        const prevTasks = tasks;
        _taskCache = nextTasks;
        (window as any).__ppTaskCache = nextTasks;
        setData({ tasks: nextTasks, loading: false, error: null });

        try {
            await dataApi.updateRow('task', taskId, {
                statuscode: targetStatus as unknown as typeof current.statuscode,
                statecode: stateCodeFor(targetStatus) as unknown as typeof current.statecode,
            });
        } catch (err) {
            // Rollback on failure
            _taskCache = prevTasks;
            (window as any).__ppTaskCache = prevTasks;
            setData({ tasks: prevTasks, loading: false, error: null });
            setDropError(
                err instanceof Error ? err.message : 'Failed to update task. Changes reverted.',
            );
        }
    };

    if (loading) {
        return (
            <div className={styles.spinnerWrap}>
                <Spinner label="Loading tasks..." />
            </div>
        );
    }

    if (error) {
        return (
            <MessageBar intent="error">
                <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
        );
    }

    return (
        <div className={styles.root}>
            <div className={styles.pageHeader}>
                <ClipboardTaskRegular aria-hidden="true" />
                <Text size={500} weight="semibold">Task board</Text>
                <Badge appearance="filled" color="brand">{tasks.length}</Badge>
            </div>

            {dropError && (
                <MessageBar intent="error" className={styles.dropError}>
                    <MessageBarBody>{dropError}</MessageBarBody>
                </MessageBar>
            )}

            <div
                className={styles.board}
                role="application"
                aria-label="Task management board"
            >
                {COLUMNS.map((col) => {
                    const items = tasks.filter(
                        (t) => (t.statuscode as unknown as number) === col.key,
                    );
                    const isOver = hoverCol === col.key;

                    return (
                        <div
                            key={col.key}
                            className={mergeClasses(styles.column, isOver && styles.columnOver)}
                            onDragOver={(e) => handleDragOver(e, col.key)}
                            onDragLeave={handleDragLeave}
                            onDrop={(e) => handleDrop(e, col.key)}
                            aria-label={`${col.label} column, ${items.length} task${items.length !== 1 ? 's' : ''}`}
                            aria-dropeffect="move"
                        >
                            <div className={styles.columnHeader}>
                                {col.icon}
                                <Body1 weight="semibold">{col.label}</Body1>
                                <Badge appearance="filled" color={col.accent} size="small">
                                    {items.length}
                                </Badge>
                            </div>

                            <div className={styles.columnBody}>
                                {items.length === 0 ? (
                                    <Caption1 className={styles.emptyHint}>
                                        No tasks — drop one here
                                    </Caption1>
                                ) : (
                                    items.map((t) => (
                                        <TaskCard
                                            key={t.activityid}
                                            item={t}
                                            dragging={draggingId === t.activityid}
                                            onDragStart={handleDragStart}
                                            onDragEnd={handleDragEnd}
                                        />
                                    ))
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default GeneratedComponent;
