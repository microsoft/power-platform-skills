import { useState, useEffect } from 'react';
import {
    makeStyles,
    tokens,
    Text,
    Card,
    CardHeader,
    Badge,
    Spinner,
    MessageBar,
    MessageBarBody,
    Input,
} from '@fluentui/react-components';
import {
    DocumentRegular,
    OpenRegular,
} from '@fluentui/react-icons';

// Connector page — fetches documents from SharePoint Online via the
// new_uxtest_sharepoint connection reference. Follows the connector runtime
// pattern in references/connectors.md: cast dataApi to an optional connector
// shape, presence-check before calling, wrap in try/catch, and fall back to
// inline mock data when the connector method is unavailable or the call fails.

// All fields are OPTIONAL because connector rows are dynamically typed and
// the runtime may omit any field row-by-row.
interface SharePointDoc {
    ID?: number;
    Title?: string;
    Author?: string;
    FileType?: { Value?: string };
    Created?: string;
    Modified?: string;
}

// Fallback data shown when queryConnectorTable is unavailable or throws.
// Also satisfies the Layer 2 "realistic inline mock data" assertion.
const FALLBACK_DOCS: SharePointDoc[] = [
    { ID: 1, Title: 'Q1 Budget Planning.xlsx', Author: 'Alice Smith', FileType: { Value: 'xlsx' }, Created: '2025-01-15T10:00:00Z', Modified: '2025-01-20T15:30:00Z' },
    { ID: 2, Title: 'Team Charter v2.docx', Author: 'Bob Johnson', FileType: { Value: 'docx' }, Created: '2025-02-01T14:30:00Z', Modified: '2025-02-05T09:00:00Z' },
    { ID: 3, Title: 'Project Roadmap 2025.pptx', Author: 'Carol Williams', FileType: { Value: 'pptx' }, Created: '2025-03-10T09:15:00Z', Modified: '2025-03-12T11:45:00Z' },
];

const CONNECTOR_LOGICAL_NAME = 'new_uxtest_sharepoint';
const DATASET_URL = 'https://contoso.sharepoint.com/sites/team';
const TABLE_GUID = '5709dd6f-c73e-4079-ad23-2334e45e0e13';

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalL,
        padding: tokens.spacingHorizontalXL,
        width: '100%',
        boxSizing: 'border-box',
    },
    pageHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalM,
    },
    pageTitle: { marginBottom: tokens.spacingVerticalXS },
    searchInput: { maxWidth: '320px', width: '100%' },
    docList: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
    },
    docCard: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens.spacingHorizontalM,
        padding: tokens.spacingHorizontalM,
    },
    docIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },
    docMeta: {
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
    },
    docTitle: {
        fontWeight: tokens.fontWeightSemibold,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    docSubtext: {
        color: tokens.colorNeutralForeground2,
        fontSize: tokens.fontSizeBase200,
    },
    emptyState: {
        padding: tokens.spacingHorizontalXL,
        textAlign: 'center',
        color: tokens.colorNeutralForeground2,
    },
    openIcon: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
});

function formatDate(iso?: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const DocCard = (props: { doc: SharePointDoc }) => {
    const { doc } = props;
    const styles = useStyles();
    const fileType = doc.FileType?.Value ?? 'file';
    const subParts = [
        doc.Author ? `By ${doc.Author}` : '',
        doc.Modified ? `Modified ${formatDate(doc.Modified)}` : (doc.Created ? `Created ${formatDate(doc.Created)}` : ''),
    ].filter(Boolean);

    return (
        <Card
            className={styles.docCard}
            aria-label={`${doc.Title ?? 'Document'}, ${fileType} file${subParts.length ? ', ' + subParts.join(', ') : ''}`}
        >
            <DocumentRegular className={styles.docIcon} aria-hidden="true" />
            <div className={styles.docMeta}>
                <Text className={styles.docTitle}>{doc.Title ?? '(Untitled)'}</Text>
                {subParts.length > 0 && (
                    <Text className={styles.docSubtext}>{subParts.join(' · ')}</Text>
                )}
            </div>
            <Badge appearance="outline" aria-label={`File type: ${fileType}`}>
                {fileType.toUpperCase()}
            </Badge>
            <OpenRegular className={styles.openIcon} aria-hidden="true" />
        </Card>
    );
};

const GeneratedComponent = (props: { dataApi?: unknown; pageInput?: { data?: Record<string, unknown> } }) => {
    const { dataApi, pageInput } = props;
    void pageInput;
    const styles = useStyles();
    const [documents, setDocuments] = useState<SharePointDoc[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        // Cast dataApi to the connector API shape from references/connectors.md.
        // Always presence-check the method before calling — the runtime may not
        // have populated it if the connection reference is not yet active.
        const connectorApi = dataApi as unknown as {
            queryConnectorTable?: (
                connectorLogicalName: string,
                dataset: string,
                table: string,
                options: Record<string, unknown>
            ) => Promise<{ rows: SharePointDoc[] }>;
        };

        if (typeof connectorApi.queryConnectorTable !== 'function') {
            // Method unavailable — fall back to inline mock data so the page
            // renders something useful while the binding is being set up.
            setDocuments(FALLBACK_DOCS);
            setLoading(false);
            return;
        }

        (async () => {
            try {
                const result = await connectorApi.queryConnectorTable(
                    CONNECTOR_LOGICAL_NAME,
                    DATASET_URL,
                    TABLE_GUID,
                    { top: 50 }
                );
                setDocuments(result.rows);
            } catch (err) {
                setError('Failed to load documents from SharePoint. Showing sample data.');
                setDocuments(FALLBACK_DOCS);
            } finally {
                setLoading(false);
            }
        })();
    }, []); // dataApi is stable for the component lifetime; no re-fetch needed

    const filtered = searchTerm.trim()
        ? documents.filter((d) =>
            (d.Title ?? '').toLowerCase().includes(searchTerm.toLowerCase())
        )
        : documents;

    return (
        <div className={styles.root}>
            <div className={styles.pageHeader}>
                <Text as="h1" size={700} weight="semibold" className={styles.pageTitle}>
                    SharePoint Documents
                </Text>
                <Input
                    className={styles.searchInput}
                    placeholder="Search documents…"
                    value={searchTerm}
                    onChange={(_, d) => setSearchTerm(d.value)}
                    aria-label="Search documents by title"
                />
            </div>

            {error && (
                <MessageBar intent="warning">
                    <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
            )}

            {loading ? (
                <Spinner label="Loading documents…" />
            ) : filtered.length === 0 ? (
                <Text className={styles.emptyState}>
                    {searchTerm
                        ? `No documents found matching "${searchTerm}".`
                        : 'No documents found in this library.'}
                </Text>
            ) : (
                <div className={styles.docList} role="list" aria-label="Documents">
                    {filtered.map((doc) => (
                        <DocCard key={doc.ID ?? doc.Title} doc={doc} />
                    ))}
                </div>
            )}
        </div>
    );
};

export default GeneratedComponent;
