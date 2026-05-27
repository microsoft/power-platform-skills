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
import { PeopleRegular } from '@fluentui/react-icons';
import { GeneratedComponentProps } from './RuntimeTypes';

declare const Xrm: {
    Utility: {
        getGlobalContext: () => {
            userSettings: { languageId: number };
        };
    };
};

// Locale id → BCP-47 + RTL flag.
const LOCALE_MAP: Record<number, { tag: string; isRtl: boolean }> = {
    1033: { tag: 'en-US', isRtl: false },
    1025: { tag: 'ar-SA', isRtl: true },
    1036: { tag: 'fr-FR', isRtl: false },
};

const TRANSLATIONS: Record<string, Record<string, string>> = {
    'en-US': { title: 'Contacts', name: 'Name', email: 'Email', phone: 'Phone', empty: 'No contacts.' },
    'ar-SA': { title: 'جهات الاتصال', name: 'الاسم', email: 'البريد الإلكتروني', phone: 'الهاتف', empty: 'لا توجد جهات اتصال.' },
    'fr-FR': { title: 'Contacts', name: 'Nom', email: 'E-mail', phone: 'Téléphone', empty: 'Aucun contact.' },
};

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        paddingInlineStart: tokens.spacingHorizontalL,
        paddingInlineEnd: tokens.spacingHorizontalL,
        paddingBlock: tokens.spacingVerticalL,
        gap: tokens.spacingVerticalM,
        boxSizing: 'border-box',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        marginInlineStart: 0,
    },
    grid: { flex: 1, overflowY: 'auto' },
});

interface Row { id: string; name: string; email: string; phone: string; }

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput;
    const styles = useStyles();

    const languageId = (() => {
        try {
            return Xrm.Utility.getGlobalContext().userSettings.languageId;
        } catch {
            return 1033;
        }
    })();
    const locale = LOCALE_MAP[languageId] ?? LOCALE_MAP[1033];
    const t = (key: string) => TRANSLATIONS[locale.tag]?.[key] ?? TRANSLATIONS['en-US'][key];

    const [rows, setRows] = React.useState<Row[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        (async () => {
            const w = window as unknown as Record<string, Row[] | undefined>;
            if (w.__genpage_contacts_v1) {
                setRows(w.__genpage_contacts_v1);
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
                w.__genpage_contacts_v1 = mapped;
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
            createTableColumn<Row>({
                columnId: 'name',
                renderHeaderCell: () => t('name'),
                renderCell: (item) => <TableCellLayout>{item.name}</TableCellLayout>,
            }),
            createTableColumn<Row>({
                columnId: 'email',
                renderHeaderCell: () => t('email'),
                renderCell: (item) => <TableCellLayout>{item.email}</TableCellLayout>,
            }),
            createTableColumn<Row>({
                columnId: 'phone',
                renderHeaderCell: () => t('phone'),
                renderCell: (item) => <TableCellLayout>{item.phone}</TableCellLayout>,
            }),
        ],
        [locale.tag],
    );

    if (loading) return <Spinner label={t('title')} />;
    if (error) return (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
    );

    return (
        <div className={styles.root} dir={locale.isRtl ? 'rtl' : 'ltr'} lang={locale.tag}>
            <div className={styles.header}>
                <PeopleRegular />
                <Text size={500} weight="semibold">{t('title')} ({rows.length})</Text>
            </div>
            <div className={styles.grid}>
                {rows.length === 0 ? (
                    <Text>{t('empty')}</Text>
                ) : (
                    <DataGrid
                        items={rows}
                        columns={columns}
                        resizableColumns
                        columnSizingOptions={{
                            name: { defaultWidth: 200, minWidth: 120 },
                            email: { defaultWidth: 220, minWidth: 140 },
                            phone: { defaultWidth: 160, minWidth: 100 },
                        }}
                        sortable
                        aria-label={t('title')}
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
                )}
            </div>
        </div>
    );
};

export default GeneratedComponent;
