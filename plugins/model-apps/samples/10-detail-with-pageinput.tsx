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
    Card,
    Divider,
} from '@fluentui/react-components';
import { ArrowLeftRegular } from '@fluentui/react-icons';

// Sample: detail page receiving pageInput from a sibling list page.
// Demonstrates:
//   - pageInput.entityName + pageInput.recordId derived SYNCHRONOUSLY from
//     props (no useState for these — state init triggers re-renders)
//   - Initial loading=true on frame 0 when recordId is present — avoids
//     blank-flip-to-spinner flicker
//   - Early-return when required input is missing (no conditional wrapper div)
//   - Rule 14: SINGLE batched setData call after fetch
//   - Map<recordId, row> cache on window (Rule 15 detail-page pattern) so
//     return visits render instantly
//   - Lookup formatted-value access via @OData.Community.Display.V1.FormattedValue

type ContactRow = TableRow<{
    readonly contactid: string;
    fullname?: string;
    emailaddress1?: string;
    telephone1?: string;
    jobtitle?: string;
    address1_city?: string;
    address1_stateorprovince?: string;
    _parentcustomerid_value?: string;
}>;

type ReadableContact = ReadableTableRow<ContactRow>;

// Map cache: key by recordId so each detail visit hits its own cached row.
const CACHE_KEY = '__ppContactDetailCache';
const winAny = window as unknown as Record<string, Map<string, ReadableContact> | undefined>;
const cache: Map<string, ReadableContact> = winAny[CACHE_KEY] ?? new Map();
winAny[CACHE_KEY] = cache;

// ---------- Styles ----------

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalL,
        padding: tokens.spacingHorizontalXL,
        width: '100%',
        boxSizing: 'border-box',
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalM,
    },
    title: { flex: 1 },
    card: { padding: tokens.spacingHorizontalL },
    fieldGrid: {
        display: 'grid',
        gridTemplateColumns: 'minmax(140px, max-content) 1fr',
        rowGap: tokens.spacingVerticalS,
        columnGap: tokens.spacingHorizontalL,
    },
    fieldLabel: {
        color: tokens.colorNeutralForeground2,
        fontWeight: tokens.fontWeightSemibold,
    },
    spinnerWrap: {
        display: 'flex',
        justifyContent: 'center',
        padding: tokens.spacingVerticalXXL,
    },
    emptyState: {
        padding: tokens.spacingVerticalXXL,
        textAlign: 'center',
        color: tokens.colorNeutralForeground2,
    },
    errorBanner: {
        padding: tokens.spacingHorizontalM,
        backgroundColor: tokens.colorStatusDangerBackground2,
        color: tokens.colorStatusDangerForeground2,
        borderRadius: tokens.borderRadiusMedium,
    },
    divider: {
        marginTop: tokens.spacingVerticalM,
        marginBottom: tokens.spacingVerticalM,
    },
});

// ---------- Field row ----------

const Field = (props: { label: string; value?: string | null }) => {
    const styles = useStyles();
    return (
        <>
            <Text className={styles.fieldLabel}>{props.label}</Text>
            <Text>{props.value ?? '—'}</Text>
        </>
    );
};

// ---------- Component ----------

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    const styles = useStyles();

    // Synchronous derivation from props — NOT useState. State init would
    // trigger an extra render before the spinner can show.
    const entityName = pageInput?.entityName;
    const recordId = pageInput?.recordId;

    // Early return: required input missing. Don't render a wrapper div with
    // conditional inner content — that costs an extra render cycle.
    if (entityName !== 'contact' || !recordId) {
        return (
            <div className={styles.root}>
                <div className={styles.emptyState}>
                    <Text>No contact selected. Open this page from the contacts list.</Text>
                </div>
            </div>
        );
    }

    // Initial loading state is `true` when recordId is present — spinner shows
    // on frame 0, not a blank page that flips to a spinner.
    // Pre-warm `record` from the cache if we have it (return visits = instant).
    const cached = cache.get(recordId);
    const [data, setData] = useState<{ record: ReadableContact | null; loading: boolean; error: string | null }>(
        () => ({
            record: cached ?? null,
            loading: !cached,
            error: null,
        }),
    );

    useEffect(() => {
        // Cache hit — already pre-warmed in initial state, nothing to fetch.
        if (cache.has(recordId)) return;

        (async () => {
            try {
                const row = (await dataApi.retrieveRow('contact', {
                    id: recordId,
                    select: [
                        'contactid',
                        'fullname',
                        'emailaddress1',
                        'telephone1',
                        'jobtitle',
                        'address1_city',
                        'address1_stateorprovince',
                        '_parentcustomerid_value',
                    ],
                })) as ReadableContact;
                cache.set(recordId, row);
                setData({ record: row, loading: false, error: null });
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Failed to load contact.';
                setData({ record: null, loading: false, error: message });
            }
        })();
    }, [dataApi, recordId]);

    const goBack = () => {
        const xrm = (window as unknown as { Xrm?: { Navigation?: { navigateTo: (opts: unknown) => unknown } } }).Xrm;
        xrm?.Navigation?.navigateTo({
            pageType: 'generative',
            pageId: 'PAGEREF_9-list-with-caching',
            entityName: 'contact',
        });
    };

    if (data.loading) {
        return (
            <div className={styles.root}>
                <div className={styles.spinnerWrap}>
                    <Spinner labelPosition="below" label="Loading contact…" />
                </div>
            </div>
        );
    }

    const row = data.record;
    const parentCompany = row?.['_parentcustomerid_value@OData.Community.Display.V1.FormattedValue'];

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <Button
                    appearance="subtle"
                    icon={<ArrowLeftRegular />}
                    onClick={goBack}
                    aria-label="Back to contacts list"
                >
                    Back
                </Button>
                <Text as="h1" size={700} weight="semibold" className={styles.title}>
                    {row?.fullname ?? 'Contact'}
                </Text>
            </header>

            {data.error && (
                <div role="alert" className={styles.errorBanner}>
                    {data.error}
                </div>
            )}

            {row && (
                <Card className={styles.card}>
                    <div className={styles.fieldGrid}>
                        <Field label="Name" value={row.fullname} />
                        <Field label="Title" value={row.jobtitle} />
                        <Field label="Email" value={row.emailaddress1} />
                        <Field label="Phone" value={row.telephone1} />
                    </div>
                    <Divider className={styles.divider} />
                    <div className={styles.fieldGrid}>
                        <Field label="City" value={row.address1_city} />
                        <Field label="State / Province" value={row.address1_stateorprovince} />
                        <Field label="Parent company" value={parentCompany} />
                    </div>
                </Card>
            )}
        </div>
    );
};

export default GeneratedComponent;
