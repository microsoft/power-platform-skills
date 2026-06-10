import * as React from 'react';
import {
    makeStyles,
    tokens,
    Card,
    Text,
    Body1,
    Caption1,
    Spinner,
    MessageBar,
    MessageBarBody,
} from '@fluentui/react-components';
import { CalendarRegular, ClockRegular, OpenRegular } from '@fluentui/react-icons';
import { GeneratedComponentProps } from './RuntimeTypes';

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: tokens.spacingHorizontalL,
        gap: tokens.spacingVerticalM,
    },
    list: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalS,
        overflowY: 'auto',
        flex: 1,
    },
    card: { padding: tokens.spacingHorizontalM, cursor: 'pointer' },
    row: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        color: tokens.colorNeutralForeground2,
    },
});

declare const Xrm: {
    Navigation: {
        navigateTo: (
            pageInput: { pageType: string; pageId?: string; data?: Record<string, unknown> },
        ) => Promise<unknown>;
    };
};

interface Row { id: string; subject: string; start: string; duration: number; }

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    const contactId = (pageInput as { contactId?: string } | undefined)?.contactId;
    const styles = useStyles();
    const [rows, setRows] = React.useState<Row[]>([]);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        (async () => {
            const w = window as unknown as Record<string, Row[] | undefined>;
            const cacheKey = `__genpage_schedule_${contactId ?? 'all'}_v1`;
            if (w[cacheKey]) {
                setRows(w[cacheKey] as Row[]);
                setLoading(false);
                return;
            }
            try {
                const filter = contactId
                    ? `_regardingobjectid_value eq ${contactId}`
                    : undefined;
                const result = await dataApi.queryTable('appointment', {
                    select: ['activityid', 'subject', 'scheduledstart', 'scheduleddurationminutes'],
                    filter,
                    top: 100,
                });
                // queryTable returns DataTable<T> with .rows — never iterate the result directly
                const mapped: Row[] = result.rows.map((r: any) => ({
                    id: r.activityid,
                    subject: r.subject ?? '',
                    start: r.scheduledstart ?? '',
                    duration: r.scheduleddurationminutes ?? 0,
                }));
                w[cacheKey] = mapped;
                setRows(mapped);
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            } finally {
                setLoading(false);
            }
        })();
    }, [dataApi, contactId]);

    const openMetrics = async () => {
        await Xrm.Navigation.navigateTo({
            pageType: 'custom',
            pageId: 'PAGEREF_hiring-metrics',
        });
    };

    if (loading) return <Spinner label="Loading interviews..." />;
    if (error) return (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
    );

    return (
        <div className={styles.root}>
            <Text size={500} weight="semibold">Interview Schedule</Text>
            <Caption1 onClick={openMetrics} style={{ cursor: 'pointer' }}>
                <OpenRegular /> View hiring metrics
            </Caption1>
            <div className={styles.list}>
                {rows.map((r) => (
                    <Card key={r.id} className={styles.card}>
                        <Body1 weight="semibold">{r.subject}</Body1>
                        <div className={styles.row}>
                            <CalendarRegular />
                            <Caption1>{r.start}</Caption1>
                        </div>
                        <div className={styles.row}>
                            <ClockRegular />
                            <Caption1>{r.duration} min</Caption1>
                        </div>
                    </Card>
                ))}
            </div>
        </div>
    );
};

export default GeneratedComponent;
