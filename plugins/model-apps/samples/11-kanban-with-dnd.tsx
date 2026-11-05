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

// ---------- Page errors ----------
// The page error block of references/rules.md ("Missing Error Handling"), copied unchanged: every failed data
// operation goes through reportPageError, PageErrorBar shows the view it returns, and the page renders inside
// PageErrorBoundary.

type PageErrorKind = 'read' | 'write' | 'indeterminate' | 'network' | 'render';
type PageErrorView = {
  operation: string;
  message: string;
  fallbackKey: string;
  code?: string;
  kind: PageErrorKind;
  retry?: () => void;
};
type PageErrorTelemetry = {
  trackException?: (error: unknown, properties?: Record<string, unknown>) => void;
};

// The plan's display name for this page: a fixed literal, not the file name.
const PAGE_NAME = 'Task Board';

// The error copy of an English-only page. A localized page keeps these keys in its translations dictionary instead.
const ERROR_COPY: Record<string, string> = {
  'error.read': 'Unable to load data. Please try again.',
  'error.write': 'The change could not be saved. Refresh before trying again.',
  'error.network': 'The request did not go through. You can try again.',
  'error.indeterminate': "We couldn't confirm this completed — refresh before retrying.",
  'error.render': 'This page hit a problem and could not render. Refresh the page.',
  'error.tryAgain': 'Try again',
};

function translate(key: string): string {
  return ERROR_COPY[key] || key;
}

// The page's one error reporter. It logs bounded diagnostics once and returns the view the failed
// operation stores; it never sets state, never calls retry, and reads only the named fields of a
// thrown value, each on its own, so a throwing getter leaves that one field empty.
function reportPageError(
  pageName: string,
  operation: string,
  code: unknown,
  message: unknown,
  kind: PageErrorKind,
  retry?: () => void,
  appInsights?: PageErrorTelemetry,
): PageErrorView {
  const fields: Record<string, unknown> = {};
  for (const path of ['code', 'errorCode', 'message', 'error.code', 'error.message']) {
    try {
      let value: unknown = message;
      for (const part of path.split('.')) {
        value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
      }
      fields[path] = value;
    } catch {
      fields[path] = undefined;
    }
  }
  let normalizedCode = '';
  for (const candidate of [code, fields['code'], fields['errorCode'], fields['error.code']]) {
    const text = typeof candidate === 'string' ? candidate : typeof candidate === 'number' && Number.isFinite(candidate) ? String(candidate) : '';
    normalizedCode = text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 80);
    if (normalizedCode) break;
  }
  let normalizedMessage = '';
  for (const candidate of [message, fields['message'], fields['error.message']]) {
    const line = typeof candidate === 'string' ? candidate.trim().split(/[\r\n\u2028\u2029]/)[0].replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim() : '';
    if (!line || /^\[object [^\]]*\]$/.test(line) || /^at\s.*(?::\d+:\d+\)?|\((?:native|<anonymous>)\))$/.test(line)) continue;
    normalizedMessage = line.length > 300 ? line.slice(0, 299) + '\u2026' : line;
    break;
  }
  console.error('[' + String(pageName).replace(/[\r\n\]]/g, '') + '] ' + operation + ' failed', { code: normalizedCode, message: normalizedMessage });
  const quiet = kind === 'indeterminate' || kind === 'render';
  const view: PageErrorView = { operation, message: quiet ? '' : normalizedMessage, fallbackKey: 'error.' + kind, kind };
  if (normalizedCode) view.code = normalizedCode;
  if (typeof retry === 'function' && (kind === 'read' || kind === 'network')) view.retry = retry;
  return view;
}

function PageErrorBar(props: { error: PageErrorView | null }) {
  const { error } = props;
  if (!error) return null;
  return (
    <MessageBar intent="error">
      <MessageBarBody>{error.message || translate(error.fallbackKey)}</MessageBarBody>
    </MessageBar>
  );
}

// The page's one class component: it catches a render crash below it and shows a fixed message.
class PageErrorBoundary extends React.Component<
  { children: React.ReactNode; appInsights?: PageErrorTelemetry },
  { failed: boolean }
> {
  public state = { failed: false };

  public static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  public componentDidCatch(error: Error): void {
    reportPageError(PAGE_NAME, 'render', undefined, error, 'render');
  }

  public render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <MessageBar intent="error">
          <MessageBarBody>{translate('error.render')}</MessageBarBody>
        </MessageBar>
      );
    }
    return this.props.children;
  }
}

// Sample: kanban board with native HTML5 drag-and-drop.
// Demonstrates:
//   - Rule: no external DnD library (no react-dnd / @dnd-kit / react-beautiful-dnd)
//   - Status updates persist via dataApi.updateRow on drop
//   - Native HTML5 events: onDragStart, onDragOver (with preventDefault),
//     onDrop, onDragEnd
//   - Three columns mapped to task statuscode values (Not Started=2,
//     In Progress=3, Completed=5 — Dataverse defaults for the `task` entity;
//     see task_statuscode in RuntimeTypes)
//   - Page-scoped window cache (window.__ppTaskBoard_taskCache) + in-flight de-dupe
//   - Realistic empty / loading / error states: a failed load or move goes through
//     reportPageError and PageErrorBar (Rule 22), and the board stays on screen
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

function PageBody(props: GeneratedComponentProps) {
    const { dataApi, pageInput } = props;
    void pageInput; // board does not consume incoming pageInput
    const styles = useStyles();

    // Page-scoped window keys (unique per page + query) so this board doesn't
    // collide with other pages caching the same entity — see data-caching.md.
    const CACHE_KEY = '__ppTaskBoard_taskCache';
    const INFLIGHT_KEY = '__ppTaskBoard_taskInflight';
    const winAny = window as unknown as Record<string, unknown>;
    // Single batched fetch state (Rule 14 — React 17 doesn't batch setState in
    // async callbacks, so one object + one setData avoids intermediate renders).
    // Lazy-init from the window cache so the host's second mount paints tasks
    // immediately instead of flashing the spinner (see references/data-caching.md).
    const [{ tasks, loading, error }, setData] = React.useState<{ tasks: Task[]; loading: boolean; error: PageErrorView | null }>(
        () => {
            const cached = winAny[CACHE_KEY] as Task[] | undefined;
            return { tasks: cached ?? [], loading: cached === undefined, error: null };
        },
    );
    const [draggingId, setDraggingId] = React.useState<string | null>(null);
    const [hoverColumn, setHoverColumn] = React.useState<StatusValue | null>(null);

    const dataReady = !!dataApi;

    React.useEffect(() => {
        if (!dataReady) return;
        const cacheKey = CACHE_KEY;
        const inflightKey = INFLIGHT_KEY;
        const w = winAny;

        const cached = w[cacheKey] as Task[] | undefined;
        if (cached !== undefined) {
            setData({ tasks: cached, loading: false, error: null });
            return;
        }

        let cancelled = false;

        // De-dupe the host double-mount: concurrent mounts share one fetch.
        let pending = w[inflightKey] as Promise<Task[]> | undefined;
        if (!pending) {
            pending = dataApi
                .queryTable<Task>('task', {
                    select: ['activityid', 'subject', 'description', 'statuscode', 'prioritycode'],
                    top: 200,
                })
                // queryTable returns DataTable<T> = { rows: T[], ... } — read .rows
                .then((result) => {
                    w[cacheKey] = result.rows;
                    return result.rows;
                })
                .finally(() => { if (w[inflightKey] === pending) delete w[inflightKey]; });
            w[inflightKey] = pending;
        }

        pending
            .then((rows) => { if (!cancelled) setData({ tasks: rows, loading: false, error: null }); })
            .catch((failure) => { if (!cancelled) setData({ tasks: [], loading: false, error: reportPageError(PAGE_NAME, 'loadTasks', undefined, failure, 'read') }); });

        return () => { cancelled = true; };
        // Readiness only — never `dataApi`. See Rule 15.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady]);

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
        setData((prev) => ({ ...prev, tasks: nextTasks }));
        winAny[CACHE_KEY] = nextTasks;

        try {
            await dataApi.updateRow('task', taskId, { statuscode: targetStatus });
        } catch (failure) {
            // A failed move is a write: the card goes back, the failure is reported once, and nothing retries it.
            setData({ tasks: prevTasks, loading: false, error: reportPageError(PAGE_NAME, 'moveTask', undefined, failure, 'write') });
            winAny[CACHE_KEY] = prevTasks;
            return;
        }
        // A move that succeeds clears an earlier failed move's error — and only that operation's error.
        setData((prev) => (prev.error?.operation === 'moveTask' ? { ...prev, error: null } : prev));
    };

    if (loading) return <Spinner label="Loading tasks..." />;

    return (
        <div className={styles.root}>
            <div className={styles.header}>
                <ClipboardTaskRegular />
                <Text size={500} weight="semibold">Task Board ({tasks.length})</Text>
            </div>

            <PageErrorBar error={error} />

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
}

const GeneratedComponent = (props: GeneratedComponentProps) => (
    <PageErrorBoundary>
        <PageBody {...props} />
    </PageErrorBoundary>
);

export default GeneratedComponent;
