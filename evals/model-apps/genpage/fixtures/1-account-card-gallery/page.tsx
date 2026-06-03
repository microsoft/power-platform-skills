import * as React from 'react';
import {
    makeStyles,
    tokens,
    Card,
    CardHeader,
    Text,
    Body1,
    Caption1,
    Spinner,
    MessageBar,
    MessageBarBody,
} from '@fluentui/react-components';
import {
    BuildingRegular,
    MailRegular,
    PhoneRegular,
    GlobeRegular,
} from '@fluentui/react-icons';
import { GeneratedComponentProps, Account } from './RuntimeTypes';

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: tokens.spacingHorizontalL,
        gap: tokens.spacingVerticalM,
        boxSizing: 'border-box',
    },
    header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
    gallery: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: tokens.spacingVerticalM,
        overflowY: 'auto',
        flex: 1,
    },
    card: {
        cursor: 'pointer',
        padding: tokens.spacingHorizontalM,
    },
    detail: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXS,
        color: tokens.colorNeutralForeground2,
    },
});

declare const Xrm: {
    Navigation: {
        navigateTo: (
            pageInput: { pageType: string; entityName: string; entityId: string },
        ) => Promise<unknown>;
    };
};

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // list page does not consume pageInput
    const styles = useStyles();
    const [accounts, setAccounts] = React.useState<Account[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        (async () => {
            const cacheKey = '__genpage_accounts_v1';
            const w = window as unknown as Record<string, Account[] | undefined>;
            if (w[cacheKey]) {
                setAccounts(w[cacheKey] as Account[]);
                setLoading(false);
                return;
            }
            try {
                const result = await dataApi.queryTable('account', {
                    select: ['accountid', 'name', 'websiteurl', 'emailaddress1', 'telephone1'],
                    top: 100,
                });
                // queryTable returns DataTable<T> = { rows: T[], hasMoreRows, loadMoreRows() } — access records via .rows
                w[cacheKey] = result.rows;
                setAccounts(result.rows);
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            } finally {
                setLoading(false);
            }
        })();
    }, [dataApi]);

    const openAccount = async (id: string) => {
        await Xrm.Navigation.navigateTo({
            pageType: 'entityrecord',
            entityName: 'account',
            entityId: id,
        });
    };

    if (loading) return <Spinner label="Loading accounts..." />;
    if (error) return (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
    );

    return (
        <div className={styles.root}>
            <div className={styles.header}>
                <BuildingRegular />
                <Text size={500} weight="semibold">Accounts ({accounts.length})</Text>
            </div>
            <div className={styles.gallery}>
                {accounts.map((a) => (
                    <Card
                        key={a.accountid}
                        className={styles.card}
                        onClick={() => openAccount(a.accountid)}
                    >
                        <CardHeader header={<Body1 weight="semibold">{a.name}</Body1>} />
                        {a.websiteurl && (
                            <div className={styles.detail}>
                                <GlobeRegular />
                                <Caption1>{a.websiteurl}</Caption1>
                            </div>
                        )}
                        {a.emailaddress1 && (
                            <div className={styles.detail}>
                                <MailRegular />
                                <Caption1>{a.emailaddress1}</Caption1>
                            </div>
                        )}
                        {a.telephone1 && (
                            <div className={styles.detail}>
                                <PhoneRegular />
                                <Caption1>{a.telephone1}</Caption1>
                            </div>
                        )}
                    </Card>
                ))}
            </div>
        </div>
    );
};

export default GeneratedComponent;
