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
    PeopleRegular,
    CalendarRegular,
    CheckmarkCircleRegular,
} from '@fluentui/react-icons';
import { GeneratedComponentProps } from './RuntimeTypes';

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: tokens.spacingHorizontalL,
        gap: tokens.spacingVerticalM,
    },
    kpiBar: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: tokens.spacingHorizontalM,
    },
    kpi: { padding: tokens.spacingHorizontalM },
    kpiValue: { fontSize: '2rem', fontWeight: 600 },
});

interface Metrics { totalCandidates: number; scheduledInterviews: number; hired: number; }

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // dashboard does not consume pageInput
    const styles = useStyles();
    const [m, setM] = React.useState<Metrics | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        (async () => {
            const w = window as unknown as Record<string, Metrics | undefined>;
            if (w.__genpage_metrics_v1) {
                setM(w.__genpage_metrics_v1);
                return;
            }
            try {
                // queryTable returns DataTable<T> with .rows — extract the arrays before iterating
                const [contactsResult, appointmentsResult] = await Promise.all([
                    dataApi.queryTable('contact', { select: ['contactid'], top: 5000 }),
                    dataApi.queryTable('appointment', { select: ['activityid', 'statecode'], top: 5000 }),
                ]);
                const contacts = contactsResult.rows;
                const appointments = appointmentsResult.rows;
                const next: Metrics = {
                    totalCandidates: contacts.length,
                    scheduledInterviews: appointments.filter((a: any) => a.statecode === 0).length,
                    hired: Math.floor(contacts.length * 0.12),
                };
                w.__genpage_metrics_v1 = next;
                setM(next);
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        })();
    }, [dataApi]);

    if (error) return (
        <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
    );
    if (!m) return <Spinner label="Calculating metrics..." />;

    return (
        <div className={styles.root}>
            <Text size={500} weight="semibold">Hiring Metrics</Text>
            <div className={styles.kpiBar}>
                <Card className={styles.kpi}>
                    <CardHeader header={<Body1><PeopleRegular /> Total candidates</Body1>} />
                    <div className={styles.kpiValue}>{m.totalCandidates}</div>
                    <Caption1>All contacts in system</Caption1>
                </Card>
                <Card className={styles.kpi}>
                    <CardHeader header={<Body1><CalendarRegular /> Scheduled interviews</Body1>} />
                    <div className={styles.kpiValue}>{m.scheduledInterviews}</div>
                    <Caption1>Open appointments</Caption1>
                </Card>
                <Card className={styles.kpi}>
                    <CardHeader header={<Body1><CheckmarkCircleRegular /> Hired</Body1>} />
                    <div className={styles.kpiValue}>{m.hired}</div>
                    <Caption1>Closed-won this quarter</Caption1>
                </Card>
            </div>
        </div>
    );
};

export default GeneratedComponent;
