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
} from '@fluentui/react-components';
import { PeopleRegular, OpenRegular } from '@fluentui/react-icons';
import { GeneratedComponentProps } from './RuntimeTypes';

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: tokens.spacingHorizontalL,
        gap: tokens.spacingVerticalM,
    },
    grid: { flex: 1, overflowY: 'auto' },
});

declare const Xrm: {
    Navigation: {
        navigateTo: (
            pageInput: {
                pageType: string;
                pageId?: string;
                data?: Record<string, unknown>;
            },
        ) => Promise<unknown>;
    };
};

interface Row { id: string; name: string; email: string; phone: string; }

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // list page
    const styles = useStyles();
    const [rows, setRows] = React.useState<Row[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        (async () => {
            const w = window as unknown as Record<string, Row[] | undefined>;
            if (w.__genpage_candidates_v1) {
                setRows(w.__genpage_candidates_v1);
                setLoading(false);
                return;
            }
            try {
                const result = await dataApi.queryTable('contact', {
                    select: ['contactid', 'fullname', 'emailaddress1', 'telephone1'],
                    top: 200,
                });
                // queryTable returns DataTable<T> with .rows — never iterate the result directly
                const mapped: Row[] = result.rows.map((r: any) => ({
                    id: r.contactid,
                    name: r.fullname ?? '',
                    email: r.emailaddress1 ?? '',
                    phone: r.telephone1 ?? '',
                }));
                w.__genpage_candidates_v1 = mapped;
                setRows(mapped);
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            } finally {
                setLoading(false);
            }
        })();
    }, [dataApi]);

    const openSchedule = async (id: string) => {
        await Xrm.Navigation.navigateTo({
            pageType: 'custom',
            pageId: 'PAGEREF_interview-schedule',
            data: { contactId: id },
        });
    };

    const columns = React.useMemo(
        () => [
            createTableColumn<Row>({
                columnId: 'name',
                renderHeaderCell: () => 'Candidate',
                renderCell: (item) => (
                    <TableCellLayout media={<PeopleRegular />}>{item.name}</TableCellLayout>
                ),
            }),
            createTableColumn<Row>({
                columnId: 'email',
                renderHeaderCell: () => 'Email',
                renderCell: (item) => <TableCellLayout>{item.email}</TableCellLayout>,
            }),
            createTableColumn<Row>({
                columnId: 'phone',
                renderHeaderCell: () => 'Phone',
                renderCell: (item) => <TableCellLayout>{item.phone}</TableCellLayout>,
            }),
            createTableColumn<Row>({
                columnId: 'schedule',
                renderHeaderCell: () => '',
                renderCell: (item) => (
                    <TableCellLayout
                        media={<OpenRegular />}
                        onClick={() => openSchedule(item.id)}
                    >
                        Schedule
                    </TableCellLayout>
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
            <Text size={500} weight="semibold">Candidates ({rows.length})</Text>
            <div className={styles.grid}>
                <DataGrid
                    items={rows}
                    columns={columns}
                    resizableColumns
                    columnSizingOptions={{
                        name: { defaultWidth: 200, minWidth: 120 },
                        email: { defaultWidth: 220, minWidth: 140 },
                        phone: { defaultWidth: 160, minWidth: 100 },
                        schedule: { defaultWidth: 120, minWidth: 80 },
                    }}
                    sortable
                    aria-label="Candidates"
                >
                    <DataGridHeader>
                        <DataGridRow>
                            {({ renderHeaderCell }) => (
                                <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
                            )}
                        </DataGridRow>
                    </DataGridHeader>
                    <DataGridBody<Row>>
                        {({ item, rowId }) => (
                            <DataGridRow<Row> key={rowId}>
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
