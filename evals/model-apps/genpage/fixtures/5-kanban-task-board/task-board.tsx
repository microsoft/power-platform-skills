import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
    makeStyles,
    tokens,
    Text,
    Body1,
    Caption1,
    Badge,
    Spinner,
    MessageBar,
    MessageBarBody,
    Button,
    Card,
    CardHeader,
} from '@fluentui/react-components';
import {
    ClipboardTaskRegular,
    PlayRegular,
    CheckmarkCircleRegular,
    CalendarLtrRegular,
} from '@fluentui/react-icons';
import type { GeneratedComponentProps, task } from './RuntimeTypes';

// ── Module-level cache (survives module re-evaluation on navigation) ───────────
// See rules: data-caching.md Pattern 1
let _taskCache: task[] | null = (window as unknown as Record<string, task[] | null>).__ppTaskBoardCache ?? null;

// ── Column definitions ─────────────────────────────────────────────────────────
// statuscode values verified from RuntimeTypes.ts task_statuscode enum:
//   Not Started=2, In Progress=3, Completed=5
// statecode values from task_statecode enum: Open=0, Completed=1

interface ColumnDef {
    label: string;
    /** Dataverse statuscode value for tasks in this column */
    statuscode: number;
    /** Dataverse statecode value to write on drop */
    statecode: number;
    icon: ReactNode;
    badgeColor: 'brand' | 'warning' | 'success';
}

const COLUMNS: ColumnDef[] = [
    { label: 'To Do',       statuscode: 2, statecode: 0, icon: <ClipboardTaskRegular  />, badgeColor: 'brand'   },
    { label: 'In Progress', statuscode: 3, statecode: 0, icon: <PlayRegular            />, badgeColor: 'warning' },
    { label: 'Done',        statuscode: 5, statecode: 1, icon: <CheckmarkCircleRegular />, badgeColor: 'success' },
];

// Columns whose tasks are included in the board
const BOARD_STATUSCODES = new Set(COLUMNS.map(c => c.statuscode));

// ── Priority helpers ───────────────────────────────────────────────────────────
// task_prioritycode: Low=0, Normal=1, High=2 (from RuntimeTypes)

interface PriorityConfig { label: string; color: 'subtle' | 'informative' | 'warning' }

function getPriority(code: number | null | undefined): PriorityConfig {
    switch (code) {
        case 2: return { label: 'High',   color: 'warning'     };
        case 1: return { label: 'Normal', color: 'informative' };
        default: return { label: 'Low',   color: 'subtle'      };
    }
}

// ── Date helper ────────────────────────────────────────────────────────────────

function formatDue(value: Date | string | null | undefined): string {
    if (!value) return '';
    const d = new Date(value as string);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        paddingInline: tokens.spacingHorizontalL,
        paddingBlock: tokens.spacingVerticalL,
        gap: tokens.spacingVerticalM,
        boxSizing: 'border-box',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        flexShrink: 0,
    },
    errorBar: {
        flexShrink: 0,
    },
    board: {
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(240px, 1fr))',
        gap: tokens.spacingHorizontalM,
        flex: 1,
        overflowX: 'auto',
        overflowY: 'hidden',
        minHeight: 0,
    },
    column: {
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: tokens.colorNeutralBackground2,
        borderRadius: tokens.borderRadiusMedium,
        paddingInline: tokens.spacingHorizontalS,
        paddingBlock: tokens.spacingVerticalS,
        gap: tokens.spacingVerticalXS,
        minHeight: 0,
        outline: 'none',
    },
    columnDragOver: {
        backgroundColor: tokens.colorBrandBackground2,
        outline: `2px dashed ${tokens.colorBrandStroke1}`,
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
        gap: tokens.spacingVerticalS,
        minHeight: 0,
        paddingBlockEnd: tokens.spacingVerticalS,
    },
    emptyHint: {
        color: tokens.colorNeutralForeground3,
        fontStyle: 'italic',
        textAlign: 'center',
        paddingBlock: tokens.spacingVerticalXL,
    },
    card: {
        paddingInline: tokens.spacingHorizontalS,
        paddingBlock: tokens.spacingVerticalXS,
        cursor: 'grab',
        flexShrink: 0,
        ':focus-visible': {
            outlineOffset: '2px',
        },
    },
    cardDragging: {
        opacity: 0.45,
        cursor: 'grabbing',
    },
    cardMeta: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        flexWrap: 'wrap',
        paddingBlockStart: tokens.spacingVerticalXS,
    },
    cardDue: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXS,
        color: tokens.colorNeutralForeground2,
    },
    kbMoveBar: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalXS,
        paddingBlockStart: tokens.spacingVerticalXS,
        alignItems: 'center',
    },
});

// ── TaskCard ───────────────────────────────────────────────────────────────────

interface TaskCardProps {
    task: task;
    isDragging: boolean;
    isKbSelected: boolean;
    currentCol: ColumnDef;
    onDragStart: (e: React.DragEvent<HTMLDivElement>, taskId: string) => void;
    onDragEnd: () => void;
    onKeyMove: (taskId: string, col: ColumnDef) => void;
    onKbSelect: (taskId: string | null) => void;
}

const TaskCard = (props: TaskCardProps) => {
    const { task, isDragging, isKbSelected, currentCol, onDragStart, onDragEnd, onKeyMove, onKbSelect } = props;
    const styles = useStyles();
    const priority = getPriority(task.prioritycode as number);
    const due = formatDue(task.scheduledend);

    const cardClass = `${styles.card} ${isDragging ? styles.cardDragging : ''}`;

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape') {
            onKbSelect(null);
            return;
        }
        if ((e.key === ' ' || e.key === 'Enter') && !isKbSelected) {
            e.preventDefault();
            onKbSelect(task.activityid);
        }
    };

    return (
        <Card
            className={cardClass}
            draggable
            tabIndex={0}
            role="article"
            aria-label={`${task.subject}, ${priority.label} priority${due ? `, due ${due}` : ''}`}
            aria-grabbed={isDragging}
            onDragStart={(e: React.DragEvent<HTMLDivElement>) => onDragStart(e, task.activityid)}
            onDragEnd={onDragEnd}
            onKeyDown={handleKeyDown}
        >
            <CardHeader
                header={
                    <Body1 weight="semibold" style={{ wordBreak: 'break-word' }}>
                        {task.subject || '(No title)'}
                    </Body1>
                }
            />
            <div className={styles.cardMeta}>
                <Badge appearance="tint" color={priority.color} shape="rounded" size="small">
                    {priority.label}
                </Badge>
                {due && (
                    <Caption1 className={styles.cardDue}>
                        <CalendarLtrRegular fontSize={12} />
                        {due}
                    </Caption1>
                )}
            </div>
            {isKbSelected && (
                <div
                    className={styles.kbMoveBar}
                    role="toolbar"
                    aria-label="Move task to column"
                >
                    <Caption1 style={{ color: tokens.colorNeutralForeground2 }}>Move to:</Caption1>
                    {COLUMNS.filter(c => c.statuscode !== currentCol.statuscode).map(col => (
                        <Button
                            key={col.statuscode}
                            size="small"
                            appearance="outline"
                            onClick={(e) => {
                                e.stopPropagation();
                                onKeyMove(task.activityid, col);
                                onKbSelect(null);
                            }}
                        >
                            {col.label}
                        </Button>
                    ))}
                    <Button
                        size="small"
                        appearance="subtle"
                        onClick={(e) => { e.stopPropagation(); onKbSelect(null); }}
                    >
                        Cancel
                    </Button>
                </div>
            )}
        </Card>
    );
};

// ── GeneratedComponent ─────────────────────────────────────────────────────────

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput;
    const styles = useStyles();

    // Batched data state — single setState per async operation (Rule 14)
    const [{ tasks, loading, error }, setData] = useState<{
        tasks: task[];
        loading: boolean;
        error: string | null;
    }>({
        tasks: _taskCache ?? [],
        loading: _taskCache === null,
        error: null,
    });

    // UI states (synchronous — separate useState is fine)
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [hoverColumn, setHoverColumn] = useState<number | null>(null);
    const [moveError, setMoveError] = useState<string | null>(null);
    const [kbSelected, setKbSelected] = useState<string | null>(null);

    // ── Data fetch ──────────────────────────────────────────────────────────

    useEffect(() => {
        const w = window as unknown as Record<string, task[] | null>;
        if (_taskCache !== null) return; // cache hit — no spinner
        (async () => {
            try {
                const result = await dataApi.queryTable('task', {
                    select: ['activityid', 'subject', 'statuscode', 'prioritycode', 'scheduledend'],
                    filter: 'statuscode eq 2 or statuscode eq 3 or statuscode eq 5',
                    orderBy: 'subject asc',
                    top: 200,
                });
                _taskCache = result as unknown as task[];
                w.__ppTaskBoardCache = _taskCache;
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

    // Auto-dismiss move errors after 5 s
    useEffect(() => {
        if (!moveError) return;
        const t = setTimeout(() => setMoveError(null), 5000);
        return () => clearTimeout(t);
    }, [moveError]);

    // ── Move handler (shared by DnD and keyboard) ───────────────────────────

    const moveTask = async (taskId: string, col: ColumnDef) => {
        const current = tasks.find(t => t.activityid === taskId);
        if (!current || (current.statuscode as unknown as number) === col.statuscode) return;

        const w = window as unknown as Record<string, task[] | null>;
        const nextTasks: task[] = tasks.map(t =>
            t.activityid === taskId
                ? { ...t, statuscode: col.statuscode as unknown as task['statuscode'], statecode: col.statecode as unknown as task['statecode'] }
                : t
        );
        const prevTasks = tasks;

        // Optimistic update
        setData({ tasks: nextTasks, loading: false, error: null });
        _taskCache = nextTasks;
        w.__ppTaskBoardCache = nextTasks;

        try {
            await dataApi.updateRow('task', taskId, {
                statecode: col.statecode as any,
                statuscode: col.statuscode as any,
            });
        } catch (err) {
            // Rollback
            setData({ tasks: prevTasks, loading: false, error: null });
            _taskCache = prevTasks;
            w.__ppTaskBoardCache = prevTasks;
            setMoveError(err instanceof Error ? err.message : 'Failed to update task.');
        }
    };

    // ── Drag handlers ───────────────────────────────────────────────────────

    const handleDragStart = (e: React.DragEvent<HTMLDivElement>, taskId: string) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', taskId);
        setDraggingId(taskId);
    };

    const handleDragEnd = () => {
        setDraggingId(null);
        setHoverColumn(null);
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>, statuscode: number) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (hoverColumn !== statuscode) setHoverColumn(statuscode);
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        if (e.currentTarget === e.target) setHoverColumn(null);
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>, col: ColumnDef) => {
        e.preventDefault();
        const taskId = e.dataTransfer.getData('text/plain');
        setHoverColumn(null);
        if (taskId) moveTask(taskId, col);
    };

    // ── Render ──────────────────────────────────────────────────────────────

    if (loading) {
        return <Spinner label="Loading tasks…" />;
    }

    if (error) {
        return (
            <MessageBar intent="error">
                <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
        );
    }

    const totalVisible = tasks.filter(t => BOARD_STATUSCODES.has(t.statuscode as unknown as number)).length;

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <ClipboardTaskRegular aria-hidden="true" />
                <Text as="h1" size={500} weight="semibold">
                    Task board
                </Text>
                <Badge appearance="tint" color="brand">{totalVisible}</Badge>
            </header>

            {moveError && (
                <MessageBar intent="error" className={styles.errorBar}>
                    <MessageBarBody>{moveError}</MessageBarBody>
                </MessageBar>
            )}

            <main
                className={styles.board}
                aria-label="Kanban board"
            >
                {COLUMNS.map((col) => {
                    const items = tasks.filter(t => (t.statuscode as unknown as number) === col.statuscode);
                    const isDragTarget = hoverColumn === col.statuscode;
                    const colClass = `${styles.column} ${isDragTarget ? styles.columnDragOver : ''}`;

                    return (
                        <section
                            key={col.statuscode}
                            className={colClass}
                            aria-label={`${col.label}, ${items.length} task${items.length !== 1 ? 's' : ''}`}
                            onDragOver={(e) => handleDragOver(e, col.statuscode)}
                            onDragLeave={handleDragLeave}
                            onDrop={(e) => handleDrop(e, col)}
                        >
                            <div className={styles.columnHeader}>
                                <span aria-hidden="true">{col.icon}</span>
                                <Body1 weight="semibold">{col.label}</Body1>
                                <Badge appearance="filled" color={col.badgeColor} shape="circular">
                                    {items.length}
                                </Badge>
                            </div>

                            <div
                                className={styles.columnBody}
                                role="list"
                                aria-label={`${col.label} tasks`}
                            >
                                {items.length === 0 ? (
                                    <Caption1 className={styles.emptyHint}>
                                        No tasks here
                                    </Caption1>
                                ) : (
                                    items.map(task => (
                                        <div key={task.activityid} role="listitem">
                                            <TaskCard
                                                task={task}
                                                isDragging={draggingId === task.activityid}
                                                isKbSelected={kbSelected === task.activityid}
                                                currentCol={col}
                                                onDragStart={handleDragStart}
                                                onDragEnd={handleDragEnd}
                                                onKeyMove={moveTask}
                                                onKbSelect={setKbSelected}
                                            />
                                        </div>
                                    ))
                                )}
                            </div>
                        </section>
                    );
                })}
            </main>
        </div>
    );
};

export default GeneratedComponent;
