import * as React from 'react';
import {
    makeStyles,
    tokens,
    DataGrid,
    DataGridHeader,
    DataGridHeaderCell,
    DataGridBody,
    DataGridRow,
    DataGridCell,
    TableCellLayout,
    createTableColumn,
    Spinner,
    MessageBar,
    MessageBarBody,
    Text,
    Badge,
} from '@fluentui/react-components';
import {
    PeopleRegular,
    BriefcaseRegular,
} from '@fluentui/react-icons';
import { GeneratedComponentProps, CrCandidate } from './RuntimeTypes';

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: tokens.spacingHorizontalL,
        gap: tokens.spacingVerticalM,
        boxSizing: 'border-box',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
    },
    grid: { flex: 1, overflowY: 'auto' },
});

interface DisplayRow {
    id: string;
    name: string;
    status: string;
    score: number;
    recruiter: string;
    requisition: string;
}

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // list page
    const styles = useStyles();
    const [rows, setRows] = React.useState<DisplayRow[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        (async () => {
            const cacheKey = '__genpage_candidates_v1';
            const w = window as unknown as Record<string, DisplayRow[] | undefined>;
            if (w[cacheKey]) {
                setRows(w[cacheKey] as DisplayRow[]);
                setLoading(false);
                return;
            }
            try {
                // queryTable returns DataTable<T> with .rows — never iterate the result directly
                const result = await dataApi.queryTable<CrCandidate>('cr_candidate', {
                    select: [
                        'cr_candidateid',
                        'cr_name',
                        'cr_status',
                        'cr_interviewscore',
                        'cr_recruiter',
                        '_cr_jobrequisition_value',
                    ],
                    expand: { '_cr_jobrequisition_value': { select: ['cr_title'] } },
                    top: 200,
                });
                const mapped: DisplayRow[] = result.rows.map((r: any) => ({
                    id: r.cr_candidateid,
                    name: r.cr_name ?? '',
                    status: r['cr_status@OData.Community.Display.V1.FormattedValue'] ?? '',
                    score: r.cr_interviewscore ?? 0,
                    recruiter: r.cr_recruiter ?? '',
                    requisition:
                        r['_cr_jobrequisition_value@OData.Community.Display.V1.FormattedValue'] ?? '',
                }));
                w[cacheKey] = mapped;
                setRows(mapped);
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            } finally {
                setLoading(false);
            }
        })();
    }, [dataApi]);

    const columns = React.useMemo(
        () => [
            createTableColumn<DisplayRow>({
                columnId: 'name',
                renderHeaderCell: () => 'Candidate',
                renderCell: (item) => (
                    <TableCellLayout media={<PeopleRegular />}>{item.name}</TableCellLayout>
                ),
            }),
            createTableColumn<DisplayRow>({
                columnId: 'status',
                renderHeaderCell: () => 'Status',
                renderCell: (item) => (
                    <TableCellLayout>
                        <Badge appearance="filled" color="brand">{item.status || 'Unknown'}</Badge>
                    </TableCellLayout>
                ),
            }),
            createTableColumn<DisplayRow>({
                columnId: 'score',
                renderHeaderCell: () => 'Score',
                renderCell: (item) => <TableCellLayout>{item.score}</TableCellLayout>,
            }),
            createTableColumn<DisplayRow>({
                columnId: 'recruiter',
                renderHeaderCell: () => 'Recruiter',
                renderCell: (item) => <TableCellLayout>{item.recruiter}</TableCellLayout>,
            }),
            createTableColumn<DisplayRow>({
                columnId: 'requisition',
                renderHeaderCell: () => 'Requisition',
                renderCell: (item) => (
                    <TableCellLayout media={<BriefcaseRegular />}>{item.requisition}</TableCellLayout>
                ),
            }),
        ],
        [],
    );

    if (loading) return <Spinner label="Loading candidates..." />;
    if (error) return (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
    );

    return (
        <div className={styles.root}>
            <div className={styles.header}>
                <PeopleRegular />
                <Text size={500} weight="semibold">Candidates ({rows.length})</Text>
            </div>
            <div className={styles.grid}>
                <DataGrid
                    items={rows}
                    columns={columns}
                    resizableColumns
                    columnSizingOptions={{
                        name: { defaultWidth: 200, minWidth: 120 },
                        status: { defaultWidth: 120, minWidth: 80 },
                        score: { defaultWidth: 80, minWidth: 60 },
                        recruiter: { defaultWidth: 160, minWidth: 100 },
                        requisition: { defaultWidth: 240, minWidth: 140 },
                    }}
                    sortable
                    aria-label="Candidate list"
                >
                    <DataGridHeader>
                        <DataGridRow>
                            {({ renderHeaderCell }) => (
                                <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
                            )}
                        </DataGridRow>
                    </DataGridHeader>
                    <DataGridBody<DisplayRow>>
                        {({ item, rowId }) => (
                            <DataGridRow<DisplayRow> key={rowId}>
                                {({ renderCell }) => (
                                    <DataGridCell>{renderCell(item)}</DataGridCell>
                                )}
                            </DataGridRow>
                        )}
                    </DataGridBody>
                </DataGrid>
            </div>
        </div>
    );
};

export default GeneratedComponent;
