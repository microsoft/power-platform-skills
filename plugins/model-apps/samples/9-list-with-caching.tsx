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

// Sample: list page with data fetching (Rule 15).
// Demonstrates:
//   - Rule 14: SINGLE batched setData({records, loading, error}) — no separate setState
//   - Rule 15: window cache + in-flight-promise de-dupe + readiness-only deps
//     (survives the host double-mount on open — one fetch, no spinner re-flash)
//   - dataApi is NEVER in the dep array (new ref each render — would re-fire)
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

// ---------- Module-level cache + in-flight de-dupe ----------
// The VALUES live on `window` (the single source of truth) so they survive module
// re-evaluation on back-navigation AND the host's double-mount on open (a second
// mount ~300ms later re-runs the effect). CACHE_KEY holds resolved rows;
// INFLIGHT_KEY holds the pending promise so a racing second mount shares one
// round-trip. Read `window` in the effect — never a module-local snapshot, which
// a re-eval can leave stale. See references/data-caching.md.
const CACHE_KEY = '__ppContactListCache';
const INFLIGHT_KEY = '__ppContactListInflight';
const winAny = window as unknown as Record<string, unknown>;

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
        () => {
            const cached = winAny[CACHE_KEY] as ReadableContact[] | undefined;
            return { records: cached ?? [], loading: !cached, error: null };
        },
    );
    const [search, setSearch] = useState('');

    const dataReady = !!dataApi;

    useEffect(() => {
        if (!dataReady) return;      // wait until the host hands us the DataAPI

        // Read the authoritative window cache — the other mount may have resolved
        // it between this render and this effect. Sync state on a hit so we never
        // stick on the spinner (reference compare avoids a redundant render).
        const cached = winAny[CACHE_KEY] as ReadableContact[] | undefined;
        if (cached) {
            if (data.records !== cached) setData({ records: cached, loading: false, error: null });
            return;
        }
        let cancelled = false;

        // De-dupe the host double-mount: reuse an in-flight fetch if one exists,
        // else start one and publish its promise on window so a racing second
        // mount awaits it instead of firing a duplicate query.
        let inflight = winAny[INFLIGHT_KEY] as Promise<ReadableContact[]> | undefined;
        if (!inflight) {
            inflight = dataApi
                .queryTable('contact', {
                    select: ['contactid', 'fullname', 'emailaddress1', 'telephone1', 'jobtitle'],
                    orderBy: 'fullname asc',
                    pageSize: 100,
                })
                .then((result) => {
                    winAny[CACHE_KEY] = result.rows;
                    return result.rows as ReadableContact[];
                })
                // Clear only if still ours — a concurrent refresh may have replaced it.
                .finally(() => { if (winAny[INFLIGHT_KEY] === inflight) delete winAny[INFLIGHT_KEY]; });
            winAny[INFLIGHT_KEY] = inflight;
        }

        inflight
            .then((rows) => { if (!cancelled) setData({ records: rows, loading: false, error: null }); })
            .catch((err) => {
                if (cancelled) return;
                const message = err instanceof Error ? err.message : 'Failed to load contacts.';
                setData({ records: [], loading: false, error: message });
            });

        return () => { cancelled = true; };
        // Depend on readiness only — never `dataApi` (new ref each render would
        // re-fire this effect on every render). See Rule 15.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady]);

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
