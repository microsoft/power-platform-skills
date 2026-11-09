import { useEffect, useState } from 'react';
import type {
    TableRow,
    ReadableTableRow,
    GeneratedComponentProps,
} from './RuntimeTypes';
import {
    makeStyles,
    tokens,
    Card,
    CardHeader,
    Text,
    Caption1,
    Spinner,
    MessageBar,
    MessageBarBody,
} from '@fluentui/react-components';
import { BuildingRegular, GlobeRegular, MailRegular, CallRegular } from '@fluentui/react-icons';

// Accounts Gallery — Account records as a scrollable gallery of cards.
// Every column below is verified in RuntimeTypes.ts (account): accountid, name, websiteurl,
// emailaddress1 and telephone1. Selecting a card opens the Account record.

type AccountRow = TableRow<{
    readonly accountid: string;
    name?: string;
    websiteurl?: string;
    emailaddress1?: string;
    telephone1?: string;
}>;

type ReadableAccount = ReadableTableRow<AccountRow>;

type GalleryState = {
    records: ReadableAccount[];
    loading: boolean;
    error: string | null;
};

// Window-level cache + in-flight de-dupe (Rule 15, references/data-caching.md).
// Keys are scoped by page + query so another page reading account never shares them.
const CACHE_KEY = '__ppAccountsGallery_accountCache';
const INFLIGHT_KEY = '__ppAccountsGallery_accountInflight';
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
    gallery: {
        flexGrow: 1,
        minHeight: 0,
        overflowY: 'auto',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: tokens.spacingHorizontalL,
        alignContent: 'start',
        paddingBlock: tokens.spacingVerticalXS,
    },
    card: {
        cursor: 'pointer',
        ':hover': {
            boxShadow: tokens.shadow8,
        },
    },
    detail: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        minWidth: 0,
        color: tokens.colorNeutralForeground2,
    },
    detailText: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
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

function openAccount(accountId: string): void {
    const xrm = (window as unknown as { Xrm?: XrmLike }).Xrm;
    void xrm?.Navigation?.navigateTo({
        pageType: 'entityrecord',
        entityName: 'account',
        entityId: accountId,
    });
}

function DetailLine(props: { icon: JSX.Element; value: string | undefined }) {
    const styles = useStyles();
    return (
        <div className={styles.detail}>
            {props.icon}
            <Caption1 className={styles.detailText} title={props.value || ''}>
                {props.value || '—'}
            </Caption1>
        </div>
    );
}

function AccountCard(props: { account: ReadableAccount }) {
    const styles = useStyles();
    const { account } = props;
    const name = account.name || 'Unnamed account';
    return (
        <Card
            className={styles.card}
            onClick={() => openAccount(account.accountid)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openAccount(account.accountid);
                }
            }}
            tabIndex={0}
            role="button"
            aria-label={`Open account ${name}`}
        >
            <CardHeader
                image={<BuildingRegular aria-hidden="true" />}
                header={<Text weight="semibold">{name}</Text>}
            />
            <DetailLine icon={<GlobeRegular aria-hidden="true" />} value={account.websiteurl} />
            <DetailLine icon={<MailRegular aria-hidden="true" />} value={account.emailaddress1} />
            <DetailLine icon={<CallRegular aria-hidden="true" />} value={account.telephone1} />
        </Card>
    );
}

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // gallery page takes no record context; destructured per the component contract
    const styles = useStyles();

    // Seed from the window cache so a second mount paints cards without a spinner.
    const [data, setData] = useState<GalleryState>(() => {
        const cached = winAny[CACHE_KEY] as ReadableAccount[] | undefined;
        return { records: cached ?? [], loading: cached === undefined, error: null };
    });

    const dataReady = !!dataApi;

    useEffect(() => {
        if (!dataReady) return;

        const cached = winAny[CACHE_KEY] as ReadableAccount[] | undefined;
        if (cached !== undefined) {
            if (data.records !== cached) setData({ records: cached, loading: false, error: null });
            return;
        }
        let cancelled = false;

        // The host double-mounts the page on open; a racing second mount awaits the
        // same in-flight promise instead of issuing a second query.
        let inflight = winAny[INFLIGHT_KEY] as Promise<ReadableAccount[]> | undefined;
        if (!inflight) {
            inflight = dataApi.queryTable('account', {
                select: ['accountid', 'name', 'websiteurl', 'emailaddress1', 'telephone1'],
                orderBy: 'name asc',
                pageSize: 250,
            })
                .then((result) => {
                    winAny[CACHE_KEY] = result.rows;
                    return result.rows as ReadableAccount[];
                })
                .finally(() => { if (winAny[INFLIGHT_KEY] === inflight) delete winAny[INFLIGHT_KEY]; });
            winAny[INFLIGHT_KEY] = inflight;
        }

        inflight
            .then((rows) => { if (!cancelled) setData({ records: rows, loading: false, error: null }); })
            .catch((err) => {
                if (cancelled) return;
                const message = err instanceof Error ? err.message : 'Failed to load accounts.';
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
                    <Spinner labelPosition="below" label="Loading accounts…" />
                </div>
            </div>
        );
    }

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <div className={styles.titleGroup}>
                    <BuildingRegular className={styles.titleIcon} aria-hidden="true" />
                    <Text as="h1" size={600} weight="semibold">
                        Accounts
                    </Text>
                </div>
                <Caption1 className={styles.count} aria-live="polite">
                    {data.records.length === 1 ? '1 account' : `${data.records.length} accounts`}
                </Caption1>
            </header>

            {data.error && (
                <MessageBar intent="error">
                    <MessageBarBody>{data.error}</MessageBarBody>
                </MessageBar>
            )}

            {data.records.length === 0 && !data.error ? (
                <Text className={styles.empty} block>
                    No accounts found.
                </Text>
            ) : (
                <div className={styles.gallery} role="list" aria-label="Accounts">
                    {data.records.map((account) => (
                        <div role="listitem" key={account.accountid}>
                            <AccountCard account={account} />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default GeneratedComponent;
