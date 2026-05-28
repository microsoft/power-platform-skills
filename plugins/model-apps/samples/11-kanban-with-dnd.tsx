import * as React from 'react';
import {
    makeStyles,
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
import { GeneratedComponentProps, Task } from './RuntimeTypes';

// Sample: kanban board with native HTML5 drag-and-drop.
// Demonstrates:
//   - Rule: no external DnD library (no react-dnd / @dnd-kit / react-beautiful-dnd)
//   - Status updates persist via dataApi.updateRow on drop
//   - Native HTML5 events: onDragStart, onDragOver (with preventDefault),
//     onDrop, onDragEnd
//   - Three columns mapped to task statuscode values (Not Started=2,
//     In Progress=3, Completed=5 — Dataverse defaults for the `task` entity;
//     see task_statuscode in RuntimeTypes)
//   - Window cache (window.__genpage_tasks_v1) for the inline IIFE pattern
//   - Realistic empty / loading / error states
//   - Logical CSS properties (paddingInline, paddingBlock, marginInlineStart)
//   - Unsized Fluent icons (ClipboardTaskRegular, PlayRegular, CheckmarkCircleRegular)
//   - export default GeneratedComponent and pageInput destructured

// ---------- Constants ----------

const STATUS_NOT_STARTED = 2 as const;
const STATUS_IN_PROGRESS = 3 as const;
const STATUS_COMPLETED = 5 as const;

type StatusValue = typeof STATUS_NOT_STARTED | typeof STATUS_IN_PROGRESS | typeof STATUS_COMPLETED;

interface Column {
    key: StatusValue;
    label: string;
    icon: React.ReactNode;
    accent: 'brand' | 'warning' | 'success';
}

const COLUMNS: Column[] = [
    { key: STATUS_NOT_STARTED, label: 'To Do', icon: <ClipboardTaskRegular />, accent: 'brand' },
    { key: STATUS_IN_PROGRESS, label: 'In Progress', icon: <PlayRegular />, accent: 'warning' },
    { key: STATUS_COMPLETED, label: 'Done', icon: <CheckmarkCircleRegular />, accent: 'success' },
];

// ---------- Styles ----------

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
    },
    board: {
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(240px, 1fr))',
        gap: tokens.spacingHorizontalM,
        flex: 1,
        overflowX: 'auto',
        overflowY: 'hidden',
    },
    column: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
        paddingInline: tokens.spacingHorizontalS,
        paddingBlock: tokens.spacingVerticalS,
        backgroundColor: tokens.colorNeutralBackground2,
        borderRadius: tokens.borderRadiusMedium,
        minHeight: 0,
    },
    columnHover: {
        backgroundColor: tokens.colorBrandBackground2,
        outline: `2px dashed ${tokens.colorBrandStroke1}`,
    },
    columnHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXS,
        paddingBlockEnd: tokens.spacingVerticalXS,
    },
    columnBody: {
        flex: 1,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
        minHeight: 0,
    },
    card: {
        padding: tokens.spacingHorizontalS,
        cursor: 'grab',
    },
    cardDragging: { opacity: 0.5 },
    emptyHint: {
        color: tokens.colorNeutralForeground3,
        fontStyle: 'italic',
        textAlign: 'center',
        paddingBlock: tokens.spacingVerticalL,
    },
});

// ---------- Component ----------

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // board does not consume incoming pageInput
    const styles = useStyles();

    const [tasks, setTasks] = React.useState<Task[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [draggingId, setDraggingId] = React.useState<string | null>(null);
    const [hoverColumn, setHoverColumn] = React.useState<StatusValue | null>(null);

    React.useEffect(() => {
        (async () => {
            const cacheKey = '__genpage_tasks_v1';
            const w = window as unknown as Record<string, Task[] | undefined>;
            if (w[cacheKey]) {
                setTasks(w[cacheKey] as Task[]);
                setLoading(false);
                return;
            }
            try {
                const result = await dataApi.queryTable<Task>('task', {
                    select: ['activityid', 'subject', 'description', 'statuscode', 'prioritycode'],
                    top: 200,
                });
                // queryTable returns DataTable<T> = { rows: T[], hasMoreRows, loadMoreRows() } — access records via .rows
                w[cacheKey] = result.rows;
                setTasks(result.rows);
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            } finally {
                setLoading(false);
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
        setHoverColumn(null);
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>, columnKey: StatusValue) => {
        // preventDefault is required to allow drop
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (hoverColumn !== columnKey) setHoverColumn(columnKey);
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        // Only clear hover state when leaving the column entirely (not entering a child)
        if (e.currentTarget === e.target) setHoverColumn(null);
    };

    const handleDrop = async (
        e: React.DragEvent<HTMLDivElement>,
        targetStatus: StatusValue,
    ) => {
        e.preventDefault();
        const taskId = e.dataTransfer.getData('text/plain');
        setHoverColumn(null);
        if (!taskId) return;

        const current = tasks.find((t) => t.activityid === taskId);
        if (!current || current.statuscode === targetStatus) return;

        // Optimistic update + window cache sync; rollback on failure.
        const nextTasks: Task[] = tasks.map((t) =>
            t.activityid === taskId ? { ...t, statuscode: targetStatus } : t,
        );
        const prevTasks = tasks;
        setTasks(nextTasks);
        const w = window as unknown as Record<string, Task[] | undefined>;
        w.__genpage_tasks_v1 = nextTasks;

        try {
            await dataApi.updateRow('task', taskId, { statuscode: targetStatus });
        } catch (err) {
            setTasks(prevTasks);
            w.__genpage_tasks_v1 = prevTasks;
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    if (loading) return <Spinner label="Loading tasks..." />;
    if (error) return (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
    );

    return (
        <div className={styles.root}>
            <div className={styles.header}>
                <ClipboardTaskRegular />
                <Text size={500} weight="semibold">Task Board ({tasks.length})</Text>
            </div>

            <div className={styles.board}>
                {COLUMNS.map((col) => {
                    const items = tasks.filter((t) => t.statuscode === col.key);
                    const columnClass = `${styles.column} ${
                        hoverColumn === col.key ? styles.columnHover : ''
                    }`;
                    return (
                        <div
                            key={col.key}
                            className={columnClass}
                            onDragOver={(e) => handleDragOver(e, col.key)}
                            onDragLeave={handleDragLeave}
                            onDrop={(e) => handleDrop(e, col.key)}
                            aria-label={col.label}
                        >
                            <div className={styles.columnHeader}>
                                {col.icon}
                                <Body1 weight="semibold">{col.label}</Body1>
                                <Badge appearance="filled" color={col.accent}>{items.length}</Badge>
                            </div>
                            <div className={styles.columnBody}>
                                {items.length === 0 ? (
                                    <Caption1 className={styles.emptyHint}>
                                        Drop tasks here
                                    </Caption1>
                                ) : (
                                    items.map((task) => {
                                        const cardClass = `${styles.card} ${
                                            draggingId === task.activityid ? styles.cardDragging : ''
                                        }`;
                                        return (
                                            <Card
                                                key={task.activityid}
                                                className={cardClass}
                                                draggable
                                                onDragStart={(e) => handleDragStart(e, task.activityid)}
                                                onDragEnd={handleDragEnd}
                                                aria-grabbed={draggingId === task.activityid}
                                            >
                                                <CardHeader
                                                    header={
                                                        <Body1 weight="semibold">{task.subject}</Body1>
                                                    }
                                                />
                                                {task.description && (
                                                    <Caption1>{task.description}</Caption1>
                                                )}
                                            </Card>
                                        );
                                    })
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
