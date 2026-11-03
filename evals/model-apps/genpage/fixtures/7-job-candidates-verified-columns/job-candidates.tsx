import { useEffect, useState } from 'react';
import type {
    ReadableTableRow,
    GeneratedComponentProps,
    cr_candidate,
} from './RuntimeTypes';
import {
    makeStyles,
    tokens,
    Text,
    Caption1,
    Link,
    Badge,
    Spinner,
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
import type { TableColumnDefinition, TableColumnSizingOptions } from '@fluentui/react-components';
import { PeopleTeamRegular } from '@fluentui/react-icons';

// Job Candidates — every candidate with their application status, interview score, recruiter and
// the requisition they applied for. Columns are the ones RuntimeTypes.ts declares on cr_candidate;
// the requisition is a lookup, so its FK column is selected and the title read from the
// FormattedValue annotation (DataAPI rule 12), like the status label.

type ReadableCandidate = ReadableTableRow<cr_candidate>;

type BadgeColor = 'brand' | 'danger' | 'informative' | 'subtle' | 'success' | 'warning';

type CandidateListState = {
    records: ReadableCandidate[];
    loading: boolean;
    error: string | null;
};

// ── Choice codes (verified against RuntimeTypes cr_candidate_cr_applicationstatus) ──
const STATUS_APPLIED = 100000000;
const STATUS_SCREENING = 100000001;
const STATUS_INTERVIEWING = 100000002;
const STATUS_OFFER = 100000003;
const STATUS_HIRED = 100000004;
const STATUS_REJECTED = 100000005;

const APPLICATION_STATUS: Record<number, { label: string; color: BadgeColor }> = {
    [STATUS_APPLIED]: { label: 'Applied', color: 'subtle' },
    [STATUS_SCREENING]: { label: 'Screening', color: 'informative' },
    [STATUS_INTERVIEWING]: { label: 'Interviewing', color: 'brand' },
    [STATUS_OFFER]: { label: 'Offer', color: 'warning' },
    [STATUS_HIRED]: { label: 'Hired', color: 'success' },
    [STATUS_REJECTED]: { label: 'Rejected', color: 'danger' },
};

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';

// Window-level cache + in-flight de-dupe (Rule 15, references/data-caching.md).
// Keys are scoped by page + query so another page reading cr_candidate never shares them.
const CACHE_KEY = '__ppJobCandidates_candidateCache';
const INFLIGHT_KEY = '__ppJobCandidates_candidateInflight';
const winAny = window as unknown as Record<string, unknown>;

type XrmLike = {
    Navigation?: {
        navigateTo: (
            pageInput: { pageType: 'entityrecord'; entityName: string; entityId: string },
        ) => Promise<unknown>;
    };
};

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
        padding: tokens.spacingHorizontalXL,
        height: '100%',
        width: '100%',
        boxSizing: 'border-box',
        '@media (max-width: 480px)': {
            padding: tokens.spacingHorizontalM,
        },
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalM,
    },
    titleGroup: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
    },
    titleIcon: {
        fontSize: tokens.fontSizeBase600,
        color: tokens.colorBrandForeground1,
    },
    count: {
        color: tokens.colorNeutralForeground3,
    },
    gridWrap: {
        flexGrow: 1,
        minHeight: 0,
        overflow: 'auto',
        borderRadius: tokens.borderRadiusMedium,
        backgroundColor: tokens.colorNeutralBackground1,
        boxShadow: tokens.shadow2,
    },
    spinnerWrap: {
        display: 'flex',
        justifyContent: 'center',
        padding: tokens.spacingVerticalXXL,
    },
    empty: {
        padding: tokens.spacingVerticalXL,
        textAlign: 'center',
        color: tokens.colorNeutralForeground3,
    },
});

function textOf(value: string | undefined): string {
    return value ?? '';
}

function formatted(row: ReadableCandidate, column: string): string {
    const label = (row as unknown as Record<string, unknown>)[`${column}${FORMATTED}`];
    return typeof label === 'string' ? label : '';
}

function requisitionTitle(row: ReadableCandidate): string {
    return formatted(row, '_cr_jobrequisition_value');
}

function applicationStatus(row: ReadableCandidate): { label: string; color: BadgeColor } {
    const known = APPLICATION_STATUS[Number(row.cr_applicationstatus)];
    return { label: formatted(row, 'cr_applicationstatus') || known?.label || 'Unknown', color: known?.color ?? 'subtle' };
}

// A candidate who has not been interviewed yet has no score; it sorts after every scored candidate.
function scoreOf(row: ReadableCandidate): number | null {
    return typeof row.cr_interviewscore === 'number' ? row.cr_interviewscore : null;
}

// Case-insensitive compare that keeps blank values at the end of an ascending sort.
function compareText(a: string, b: string): number {
    if (!a && b) return 1;
    if (a && !b) return -1;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function compareScore(a: number | null, b: number | null): number {
    if (a === null && b !== null) return 1;
    if (a !== null && b === null) return -1;
    return (a ?? 0) - (b ?? 0);
}

function openCandidate(candidateId: string): void {
    const xrm = (window as unknown as { Xrm?: XrmLike }).Xrm;
    void xrm?.Navigation?.navigateTo({
        pageType: 'entityrecord',
        entityName: 'cr_candidate',
        entityId: candidateId,
    });
}

const columns: TableColumnDefinition<ReadableCandidate>[] = [
    createTableColumn<ReadableCandidate>({
        columnId: 'name',
        compare: (a, b) => compareText(textOf(a.cr_name), textOf(b.cr_name)),
        renderHeaderCell: () => 'Candidate',
        renderCell: (item) => (
            <TableCellLayout truncate>
                <Link
                    onClick={() => openCandidate(item.cr_candidateid)}
                    title={item.cr_name || 'Unnamed candidate'}
                    aria-label={`Open candidate ${item.cr_name || 'Unnamed candidate'}`}
                >
                    {item.cr_name || 'Unnamed candidate'}
                </Link>
            </TableCellLayout>
        ),
    }),
    createTableColumn<ReadableCandidate>({
        columnId: 'requisition',
        compare: (a, b) => compareText(requisitionTitle(a), requisitionTitle(b)),
        renderHeaderCell: () => 'Requisition',
        renderCell: (item) => (
            <TableCellLayout truncate title={requisitionTitle(item)}>
                {requisitionTitle(item) || '—'}
            </TableCellLayout>
        ),
    }),
    createTableColumn<ReadableCandidate>({
        columnId: 'status',
        compare: (a, b) => compareText(applicationStatus(a).label, applicationStatus(b).label),
        renderHeaderCell: () => 'Application status',
        renderCell: (item) => {
            const status = applicationStatus(item);
            return (
                <TableCellLayout>
                    <Badge appearance="tint" color={status.color}>{status.label}</Badge>
                </TableCellLayout>
            );
        },
    }),
    createTableColumn<ReadableCandidate>({
        columnId: 'interviewscore',
        compare: (a, b) => compareScore(scoreOf(a), scoreOf(b)),
        renderHeaderCell: () => 'Interview score',
        renderCell: (item) => {
            const score = scoreOf(item);
            return (
                <TableCellLayout>
                    {score === null ? '—' : `${score} / 100`}
                </TableCellLayout>
            );
        },
    }),
    createTableColumn<ReadableCandidate>({
        columnId: 'recruiter',
        compare: (a, b) => compareText(textOf(a.cr_recruiter), textOf(b.cr_recruiter)),
        renderHeaderCell: () => 'Recruiter',
        renderCell: (item) => (
            <TableCellLayout truncate title={textOf(item.cr_recruiter)}>
                {item.cr_recruiter || '—'}
            </TableCellLayout>
        ),
    }),
];

const columnSizingOptions: TableColumnSizingOptions = {
    name: { defaultWidth: 220, idealWidth: 220, minWidth: 160 },
    requisition: { defaultWidth: 240, idealWidth: 240, minWidth: 160 },
    status: { defaultWidth: 160, idealWidth: 160, minWidth: 130 },
    interviewscore: { defaultWidth: 140, idealWidth: 140, minWidth: 110 },
    recruiter: { defaultWidth: 180, idealWidth: 180, minWidth: 130 },
};

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // list page takes no record context; destructured per the component contract
    const styles = useStyles();

    // Seed from the window cache so a second mount paints rows without a spinner.
    const [data, setData] = useState<CandidateListState>(() => {
        const cached = winAny[CACHE_KEY] as ReadableCandidate[] | undefined;
        return { records: cached ?? [], loading: cached === undefined, error: null };
    });

    const dataReady = !!dataApi;

    useEffect(() => {
        if (!dataReady) return;

        const cached = winAny[CACHE_KEY] as ReadableCandidate[] | undefined;
        if (cached !== undefined) {
            if (data.records !== cached) setData({ records: cached, loading: false, error: null });
            return;
        }
        let cancelled = false;

        // The host double-mounts the page on open; a racing second mount awaits the
        // same in-flight promise instead of issuing a second query.
        let inflight = winAny[INFLIGHT_KEY] as Promise<ReadableCandidate[]> | undefined;
        if (!inflight) {
            inflight = dataApi.queryTable('cr_candidate', {
                select: ['cr_candidateid', 'cr_name', 'cr_applicationstatus', 'cr_interviewscore', 'cr_recruiter', '_cr_jobrequisition_value'],
                orderBy: 'cr_name asc',
                pageSize: 500,
            })
                .then((result) => {
                    winAny[CACHE_KEY] = result.rows;
                    return result.rows as ReadableCandidate[];
                })
                .finally(() => { if (winAny[INFLIGHT_KEY] === inflight) delete winAny[INFLIGHT_KEY]; });
            winAny[INFLIGHT_KEY] = inflight;
        }

        inflight
            .then((rows) => { if (!cancelled) setData({ records: rows, loading: false, error: null }); })
            .catch((err) => {
                if (cancelled) return;
                const message = err instanceof Error ? err.message : 'Failed to load candidates.';
                setData({ records: [], loading: false, error: message });
            });

        return () => { cancelled = true; };
        // Readiness only — dataApi is a new reference on every render (Rule 15).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady]);

    if (data.loading) {
        return (
            <div className={styles.root}>
                <div className={styles.spinnerWrap}>
                    <Spinner labelPosition="below" label="Loading candidates…" />
                </div>
            </div>
        );
    }

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <div className={styles.titleGroup}>
                    <PeopleTeamRegular className={styles.titleIcon} aria-hidden="true" />
                    <Text as="h1" size={600} weight="semibold">
                        Job Candidates
                    </Text>
                </div>
                <Caption1 className={styles.count} aria-live="polite">
                    {data.records.length === 1 ? '1 candidate' : `${data.records.length} candidates`}
                </Caption1>
            </header>

            {data.error && (
                <MessageBar intent="error">
                    <MessageBarBody>{data.error}</MessageBarBody>
                </MessageBar>
            )}

            <div className={styles.gridWrap}>
                {data.records.length === 0 && !data.error ? (
                    <Text className={styles.empty} block>
                        No candidates found.
                    </Text>
                ) : (
                    <DataGrid
                        items={data.records}
                        columns={columns}
                        getRowId={(row) => row.cr_candidateid}
                        sortable
                        resizableColumns
                        columnSizingOptions={columnSizingOptions}
                        focusMode="composite"
                        aria-label="Job candidates"
                    >
                        <DataGridHeader>
                            <DataGridRow>
                                {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
                            </DataGridRow>
                        </DataGridHeader>
                        <DataGridBody<ReadableCandidate>>
                            {({ item, rowId }) => (
                                <DataGridRow<ReadableCandidate> key={rowId}>
                                    {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
                                </DataGridRow>
                            )}
                        </DataGridBody>
                    </DataGrid>
                )}
            </div>
        </div>
    );
};

export default GeneratedComponent;
