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
//   - Map<recordId, row> cache + in-flight-promise Map on window (Rule 15
//     detail-page pattern) so the host double-mount fetches once and return
//     visits render instantly; readiness-only deps (never `dataApi`)
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

// Map caches keyed by recordId — one resolved-row cache + one in-flight-promise
// cache so concurrent mounts (the host double-mounts on open) share one fetch per
// record. Both live on window to survive back-navigation. See data-caching.md.
const CACHE_KEY = '__ppContactDetailCache';
const INFLIGHT_KEY = '__ppContactDetailInflight';
const winAny = window as unknown as Record<string, unknown>;
const cache: Map<string, ReadableContact> =
    (winAny[CACHE_KEY] as Map<string, ReadableContact> | undefined) ?? new Map();
winAny[CACHE_KEY] = cache;
const inflight: Map<string, Promise<ReadableContact>> =
    (winAny[INFLIGHT_KEY] as Map<string, Promise<ReadableContact>> | undefined) ?? new Map();
winAny[INFLIGHT_KEY] = inflight;

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
            loading: cached === undefined,
            error: null,
        }),
    );

    const dataReady = !!dataApi;

    useEffect(() => {
        if (!dataReady) return;
        const hit = cache.get(recordId);
        if (hit !== undefined) {
            // The other mount may have resolved it between render and this effect,
            // or recordId changed in place — sync so we don't stick on the spinner.
            if (data.record !== hit) setData({ record: hit, loading: false, error: null });
            return;
        }
        let cancelled = false;

        // Share one in-flight fetch per recordId across concurrent mounts.
        let pending = inflight.get(recordId);
        if (!pending) {
            pending = dataApi
                .retrieveRow('contact', {
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
                })
                .then((row) => {
                    const typed = row as ReadableContact;
                    cache.set(recordId, typed);
                    return typed;
                })
                // Delete only if still ours (a concurrent refresh may have replaced it).
                .finally(() => { if (inflight.get(recordId) === pending) inflight.delete(recordId); });
            inflight.set(recordId, pending);
        }

        pending
            .then((row) => { if (!cancelled) setData({ record: row, loading: false, error: null }); })
            .catch((err) => {
                if (cancelled) return;
                const message = err instanceof Error ? err.message : 'Failed to load contact.';
                setData({ record: null, loading: false, error: message });
            });

        return () => { cancelled = true; };
        // Readiness + recordId only — never `dataApi`. See Rule 15.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady, recordId]);

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
