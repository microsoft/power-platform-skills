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
    Caption1,
    Link,
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
import { PeopleRegular } from '@fluentui/react-icons';

// Contacts Directory — every contact with its company, job title, email and business phone.
// The company is the contact's Company Name lookup (parentcustomerid, account or contact),
// so the FK column is selected and the label read from its FormattedValue annotation.

type ContactRow = TableRow<{
    readonly contactid: string;
    fullname?: string;
    jobtitle?: string;
    emailaddress1?: string;
    telephone1?: string;
    readonly _parentcustomerid_value?: string;
}>;

type ReadableContact = ReadableTableRow<ContactRow>;

type ContactsState = {
    records: ReadableContact[];
    loading: boolean;
    error: string | null;
};

// Window cache + in-flight de-dupe so the host double-mount issues one query.
const CACHE_KEY = '__ppContactsDirectory_contactCache';
const INFLIGHT_KEY = '__ppContactsDirectory_contactInflight';
const winAny = window as unknown as Record<string, unknown>;

const COMPANY_LABEL = '_parentcustomerid_value@OData.Community.Display.V1.FormattedValue';

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

function companyName(row: ReadableContact): string {
    const label = (row as unknown as Record<string, unknown>)[COMPANY_LABEL];
    return typeof label === 'string' ? label : '';
}

function openContact(contactId: string): void {
    const xrm = (window as unknown as { Xrm?: XrmLike }).Xrm;
    void xrm?.Navigation?.navigateTo({
        pageType: 'entityrecord',
        entityName: 'contact',
        entityId: contactId,
    });
}

const columns: TableColumnDefinition<ReadableContact>[] = [
    createTableColumn<ReadableContact>({
        columnId: 'fullname',
        renderHeaderCell: () => 'Full name',
        renderCell: (item) => (
            <TableCellLayout truncate>
                <Link
                    onClick={() => openContact(item.contactid)}
                    title={item.fullname || 'Unnamed contact'}
                    aria-label={`Open contact ${item.fullname || 'Unnamed contact'}`}
                >
                    {item.fullname || 'Unnamed contact'}
                </Link>
            </TableCellLayout>
        ),
    }),
    createTableColumn<ReadableContact>({
        columnId: 'company',
        renderHeaderCell: () => 'Company name',
        renderCell: (item) => (
            <TableCellLayout truncate title={companyName(item)}>
                {companyName(item) || '—'}
            </TableCellLayout>
        ),
    }),
    createTableColumn<ReadableContact>({
        columnId: 'jobtitle',
        renderHeaderCell: () => 'Job title',
        renderCell: (item) => (
            <TableCellLayout truncate title={item.jobtitle ?? ''}>
                {item.jobtitle || '—'}
            </TableCellLayout>
        ),
    }),
    createTableColumn<ReadableContact>({
        columnId: 'emailaddress1',
        renderHeaderCell: () => 'Email',
        renderCell: (item) => (
            <TableCellLayout truncate title={item.emailaddress1 ?? ''}>
                {item.emailaddress1 || '—'}
            </TableCellLayout>
        ),
    }),
    createTableColumn<ReadableContact>({
        columnId: 'telephone1',
        renderHeaderCell: () => 'Business phone',
        renderCell: (item) => (
            <TableCellLayout truncate title={item.telephone1 ?? ''}>
                {item.telephone1 || '—'}
            </TableCellLayout>
        ),
    }),
];

const columnSizingOptions: TableColumnSizingOptions = {
    fullname: { defaultWidth: 220, idealWidth: 220, minWidth: 160 },
    company: { defaultWidth: 220, idealWidth: 220, minWidth: 150 },
    jobtitle: { defaultWidth: 180, idealWidth: 180, minWidth: 120 },
    emailaddress1: { defaultWidth: 240, idealWidth: 240, minWidth: 170 },
    telephone1: { defaultWidth: 160, idealWidth: 160, minWidth: 120 },
};

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // directory page takes no record context
    const styles = useStyles();

    const [data, setData] = useState<ContactsState>(() => {
        const cached = winAny[CACHE_KEY] as ReadableContact[] | undefined;
        return { records: cached ?? [], loading: cached === undefined, error: null };
    });

    const dataReady = !!dataApi;

    useEffect(() => {
        if (!dataReady) return;

        const cached = winAny[CACHE_KEY] as ReadableContact[] | undefined;
        if (cached !== undefined) {
            if (data.records !== cached) setData({ records: cached, loading: false, error: null });
            return;
        }
        let cancelled = false;

        let inflight = winAny[INFLIGHT_KEY] as Promise<ReadableContact[]> | undefined;
        if (!inflight) {
            inflight = dataApi.queryTable('contact', {
                select: ['contactid', 'fullname', '_parentcustomerid_value', 'jobtitle', 'emailaddress1', 'telephone1'],
                orderBy: 'fullname asc',
                pageSize: 250,
            })
                .then((result) => {
                    winAny[CACHE_KEY] = result.rows;
                    return result.rows as ReadableContact[];
                })
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
        // Readiness only — dataApi is a new reference on every render (Rule 15).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady]);

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
                <div className={styles.titleGroup}>
                    <PeopleRegular className={styles.titleIcon} aria-hidden="true" />
                    <Text as="h1" size={600} weight="semibold">
                        Contacts
                    </Text>
                </div>
                <Caption1 className={styles.count} aria-live="polite">
                    {data.records.length === 1 ? '1 contact' : `${data.records.length} contacts`}
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
                        No contacts found.
                    </Text>
                ) : (
                    <DataGrid
                        items={data.records}
                        columns={columns}
                        getRowId={(row) => row.contactid}
                        resizableColumns
                        columnSizingOptions={columnSizingOptions}
                        focusMode="composite"
                        aria-label="Contacts"
                    >
                        <DataGridHeader>
                            <DataGridRow>
                                {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
                            </DataGridRow>
                        </DataGridHeader>
                        <DataGridBody<ReadableContact>>
                            {({ item, rowId }) => (
                                <DataGridRow<ReadableContact> key={rowId}>
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
