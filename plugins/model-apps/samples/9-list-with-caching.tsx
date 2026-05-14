import { useEffect, useState } from 'react';
import type {
    TableRow,
    ReadableTableRow,
    GeneratedComponentProps,
} from './RuntimeTypes';
import {
    makeStyles,
    tokens,
    Text,
    Spinner,
    Button,
    DataGrid,
    DataGridHeader,
    DataGridHeaderCell,
    DataGridBody,
    DataGridRow,
    DataGridCell,
    TableCellLayout,
    createTableColumn,
    SearchBox,
} from '@fluentui/react-components';
import { SearchRegular } from '@fluentui/react-icons';

// Sample: list page with data caching (Rule 15).
// Demonstrates:
//   - Rule 14: SINGLE batched setData({records, loading, error}) — no separate setState
//   - Rule 15: window cache + inline async IIFE + cache guard
//   - No useCallback for dataApi (it gets a new ref each render — would re-fire)
//   - Cross-page navigation via Xrm.Navigation.navigateTo to a sibling generative page
//   - PAGEREF_ placeholder for the detail page (multi-page-build pattern)
//   - DataGrid with createTableColumn + columnSizingOptions

type ContactRow = TableRow<{
    readonly contactid: string;
    fullname?: string;
    emailaddress1?: string;
    telephone1?: string;
    jobtitle?: string;
}>;

type ReadableContact = ReadableTableRow<ContactRow>;

// ---------- Module-level cache ----------
// Initialise from window so the data survives module re-evaluation on
// back-navigation. Cache key = entity logical name. The window object persists
// for the browser session; module-level `let` does not.
const CACHE_KEY = '__ppContactListCache';
const winAny = window as unknown as Record<string, ReadableContact[] | undefined>;
let cache: ReadableContact[] | null = winAny[CACHE_KEY] ?? null;

// ---------- Styles ----------

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
        padding: tokens.spacingHorizontalXL,
        width: '100%',
        boxSizing: 'border-box',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens.spacingHorizontalM,
    },
    spinnerWrap: {
        display: 'flex',
        justifyContent: 'center',
        padding: tokens.spacingVerticalXXL,
    },
    errorBanner: {
        padding: tokens.spacingHorizontalM,
        backgroundColor: tokens.colorStatusDangerBackground2,
        color: tokens.colorStatusDangerForeground2,
        borderRadius: tokens.borderRadiusMedium,
    },
});

// ---------- Component ----------

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // list page doesn't take input; destructure anyway per rules
    const styles = useStyles();

    const [data, setData] = useState<{ records: ReadableContact[]; loading: boolean; error: string | null }>(
        () => ({
            records: cache ?? [],
            loading: cache === null,
            error: null,
        }),
    );
    const [search, setSearch] = useState('');

    useEffect(() => {
        // Cache guard — already loaded, skip fetch entirely.
        if (cache !== null) return;

        // Inline async IIFE — no useCallback. dataApi gets a new object ref each
        // render, so a useCallback would recreate and re-fire this effect.
        (async () => {
            try {
                const result = await dataApi.queryTable('contact', {
                    select: ['contactid', 'fullname', 'emailaddress1', 'telephone1', 'jobtitle'],
                    orderBy: 'fullname asc',
                    pageSize: 100,
                });
                cache = result.rows as ReadableContact[];
                winAny[CACHE_KEY] = cache;
                setData({ records: cache, loading: false, error: null });
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Failed to load contacts.';
                setData({ records: [], loading: false, error: message });
            }
        })();
    }, [dataApi]);

    const filtered = data.records.filter((c) => {
        if (!search) return true;
        const term = search.toLowerCase();
        return (
            (c.fullname?.toLowerCase().includes(term) ?? false) ||
            (c.emailaddress1?.toLowerCase().includes(term) ?? false) ||
            (c.jobtitle?.toLowerCase().includes(term) ?? false)
        );
    });

    const columns = [
        createTableColumn<ReadableContact>({
            columnId: 'fullname',
            renderHeaderCell: () => 'Name',
            renderCell: (item) => <TableCellLayout>{item.fullname ?? '—'}</TableCellLayout>,
        }),
        createTableColumn<ReadableContact>({
            columnId: 'jobtitle',
            renderHeaderCell: () => 'Title',
            renderCell: (item) => <TableCellLayout>{item.jobtitle ?? '—'}</TableCellLayout>,
        }),
        createTableColumn<ReadableContact>({
            columnId: 'email',
            renderHeaderCell: () => 'Email',
            renderCell: (item) => <TableCellLayout>{item.emailaddress1 ?? '—'}</TableCellLayout>,
        }),
        createTableColumn<ReadableContact>({
            columnId: 'phone',
            renderHeaderCell: () => 'Phone',
            renderCell: (item) => <TableCellLayout>{item.telephone1 ?? '—'}</TableCellLayout>,
        }),
    ];

    const openDetail = (contactId: string) => {
        const xrm = (window as unknown as { Xrm?: { Navigation?: { navigateTo: (opts: unknown) => unknown } } }).Xrm;
        // Navigate to the sibling detail page. In a multi-page build the
        // pageId starts as a "PAGEREF_<filename>" placeholder; the skill's
        // Phase 6.5 fix-up substitutes the real GUID after first upload.
        // Custom IDs go in `data`, NOT `recordId` — `recordId` is reserved
        // for OOB record context and may not arrive reliably.
        xrm?.Navigation?.navigateTo({
            pageType: 'generative',
            pageId: 'PAGEREF_10-detail-with-pageinput',
            entityName: 'contact',
            recordId: contactId,
        });
    };

    if (data.loading) {
        return (
            <div className={styles.root}>
                <div className={styles.spinnerWrap}>
                    <Spinner labelPosition="below" label="Loading contacts…" />
                </div>
            </div>
        );
    }

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <Text as="h1" size={700} weight="semibold">
                    Contacts
                </Text>
                <SearchBox
                    placeholder="Search by name, email, title"
                    value={search}
                    onChange={(_, d) => setSearch(d.value ?? '')}
                    contentBefore={<SearchRegular />}
                    aria-label="Search contacts"
                />
            </header>

            {data.error && (
                <div role="alert" className={styles.errorBanner}>
                    {data.error}
                </div>
            )}

            <DataGrid
                items={filtered}
                columns={columns}
                getRowId={(row) => row.contactid}
                resizableColumns
                columnSizingOptions={{
                    fullname: { idealWidth: 220, minWidth: 160 },
                    jobtitle: { idealWidth: 200, minWidth: 140 },
                    email: { idealWidth: 240, minWidth: 180 },
                    phone: { idealWidth: 160, minWidth: 120 },
                }}
                aria-label="Contacts list"
            >
                <DataGridHeader>
                    <DataGridRow>
                        {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
                    </DataGridRow>
                </DataGridHeader>
                <DataGridBody<ReadableContact>>
                    {({ item }) => (
                        <DataGridRow<ReadableContact> key={item.contactid}>
                            {({ renderCell, columnId }) =>
                                columnId === 'fullname' ? (
                                    <DataGridCell>
                                        <Button appearance="transparent" onClick={() => openDetail(item.contactid)}>
                                            {item.fullname ?? '—'}
                                        </Button>
                                    </DataGridCell>
                                ) : (
                                    <DataGridCell>{renderCell(item)}</DataGridCell>
                                )
                            }
                        </DataGridRow>
                    )}
                </DataGridBody>
            </DataGrid>
        </div>
    );
};

export default GeneratedComponent;
