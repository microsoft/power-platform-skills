import { useEffect, useState } from 'react';
import type { GeneratedComponentProps } from './RuntimeTypes';
import {
    makeStyles,
    tokens,
    Text,
    Spinner,
    Button,
    Card,
    Field,
    Textarea,
    MessageBar,
    MessageBarBody,
} from '@fluentui/react-components';

// Sample: Dataverse Custom API (plug-in) invocation from a form-embedded page.
// Demonstrates (see references/custom-api.md — gated behind the `custom-api` feature flag):
//   - Presence-checking optional dataApi methods before wiring a trigger (cast to an
//     optional action-method shape; the methods are absent on older runtimes)
//   - A read-only FUNCTION on mount (executeFunction) — no double-submit guard needed
//   - An entity-bound ACTION (executeAction) with boundTo derived from pageInput, and a
//     double-submit guard so a mutating call can't fire twice
//   - Result handling per the contract: read res.outputs (never res.value), surface only the
//     sanitized res.error.message, and NEVER auto-retry an indeterminate result
//   - Only `network` is safely retryable (the request never left the client)
// Custom API names, parameters, and output fields come from the plan's `## Custom API
// Bindings` — never guessed. Here: new_GetOrderSummary (Function) + new_ApproveOrder (Action,
// bound to salesorder).

// Optional runtime methods — not part of the generated dataApi type, so declare the shape and
// presence-check before every call.
type ActionResult = {
    ok: boolean;
    indeterminate?: boolean;
    outputs?: Record<string, unknown>;
    error?: { message: string; code?: string };
};
type CustomApiDataApi = {
    executeAction?: (request: {
        name: string;
        parameters?: Record<string, unknown>;
        boundTo?: { entityName: string; id: string };
    }) => Promise<ActionResult>;
    executeFunction?: (request: {
        name: string;
        parameters?: Record<string, unknown>;
    }) => Promise<ActionResult>;
};

type OrderSummary = { Total: number; Status: string };

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalL,
        padding: tokens.spacingHorizontalXL,
        width: '100%',
        boxSizing: 'border-box',
    },
    card: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
        padding: tokens.spacingHorizontalL,
    },
    summaryGrid: {
        display: 'grid',
        gridTemplateColumns: 'minmax(120px, max-content) 1fr',
        rowGap: tokens.spacingVerticalS,
        columnGap: tokens.spacingHorizontalL,
    },
    label: {
        color: tokens.colorNeutralForeground2,
        fontWeight: tokens.fontWeightSemibold,
    },
    actions: {
        display: 'flex',
        gap: tokens.spacingHorizontalM,
        alignItems: 'center',
    },
    spinnerWrap: {
        display: 'flex',
        justifyContent: 'center',
        padding: tokens.spacingVerticalXXL,
    },
});

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    const styles = useStyles();

    // The page is embedded on a Dataverse form, so pageInput carries the record the bound
    // Action must target. Derive synchronously from props (no useState — state init re-renders).
    const entityName = pageInput?.entityName;
    const recordId = pageInput?.recordId;

    // Cast once to the optional action-method shape and presence-check each method before use.
    const actionApi = dataApi as unknown as CustomApiDataApi;
    const canReadSummary = typeof actionApi.executeFunction === 'function';
    const canApprove = typeof actionApi.executeAction === 'function';

    const [summary, setSummary] = useState<OrderSummary | null>(null);
    const [loadingSummary, setLoadingSummary] = useState<boolean>(canReadSummary);
    const [summaryError, setSummaryError] = useState<string | null>(null);

    const [reason, setReason] = useState<string>('');
    const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
    const [approveMessage, setApproveMessage] = useState<{ intent: 'success' | 'warning' | 'error'; text: string } | null>(null);
    const [canRetry, setCanRetry] = useState<boolean>(false);

    // FUNCTION: read-only, safe to run on mount and whenever the record changes. No double-submit
    // guard — a function never mutates. Ignore a stale response instead of blocking concurrent reads.
    useEffect(() => {
        if (!canReadSummary || !recordId) {
            setSummary(null);
            setLoadingSummary(false);
            return;
        }
        let cancelled = false;
        setLoadingSummary(true);
        setSummaryError(null);
        (async () => {
            const res = await actionApi.executeFunction!({
                name: 'new_GetOrderSummary',
                parameters: { OrderId: recordId }, // GUID-formatted string, matching the declared kind
            });
            if (cancelled) return;
            if (!res.ok) {
                setSummaryError(res.error?.message ?? 'Could not load the order summary.'); // sanitized only
                setLoadingSummary(false);
                return;
            }
            const { Total, Status } = res.outputs as OrderSummary; // read from outputs, never `value`
            setSummary({ Total, Status });
            setLoadingSummary(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [actionApi, canReadSummary, recordId]);

    // ACTION: may mutate, so guard against double-submit and require boundTo (this operation is
    // bound to `salesorder`; its entityName must match the record the page is on).
    const approve = async () => {
        if (!canApprove || isSubmitting || !entityName || !recordId) return;
        setIsSubmitting(true);
        setApproveMessage(null);
        setCanRetry(false);
        try {
            const res = await actionApi.executeAction!({
                name: 'new_ApproveOrder',
                parameters: { Comment: reason },
                boundTo: { entityName, id: recordId },
            });
            if (res.indeterminate) {
                // Never auto-retry — the server may have committed it. Ask the user to refresh.
                setApproveMessage({ intent: 'warning', text: "We couldn't confirm the approval completed — refresh before retrying." });
                return;
            }
            if (!res.ok) {
                setApproveMessage({ intent: 'error', text: res.error?.message ?? 'The approval failed.' });
                // Only a `network` failure is safely retryable: the request never left the client.
                setCanRetry(res.error?.code === 'network');
                return;
            }
            const { NewStatus } = res.outputs as { NewStatus: string };
            setApproveMessage({ intent: 'success', text: `Order approved. New status: ${NewStatus}.` });
        } finally {
            setIsSubmitting(false); // never leave the button stuck disabled
        }
    };

    if (entityName !== 'salesorder' || !recordId) {
        return (
            <div className={styles.root}>
                <Text>Open this page from a sales order form to manage its approval.</Text>
            </div>
        );
    }

    return (
        <div className={styles.root}>
            <Card className={styles.card}>
                <Text as="h2" size={600} weight="semibold">Order summary</Text>
                {loadingSummary ? (
                    <div className={styles.spinnerWrap}>
                        <Spinner labelPosition="below" label="Loading summary…" />
                    </div>
                ) : summaryError ? (
                    <MessageBar intent="error"><MessageBarBody>{summaryError}</MessageBarBody></MessageBar>
                ) : summary ? (
                    <div className={styles.summaryGrid}>
                        <Text className={styles.label}>Total</Text>
                        <Text>{summary.Total}</Text>
                        <Text className={styles.label}>Status</Text>
                        <Text>{summary.Status}</Text>
                    </div>
                ) : (
                    <Text>Order summary is unavailable on this runtime.</Text>
                )}
            </Card>

            <Card className={styles.card}>
                <Text as="h2" size={600} weight="semibold">Approve order</Text>
                {approveMessage && (
                    <MessageBar intent={approveMessage.intent}>
                        <MessageBarBody>{approveMessage.text}</MessageBarBody>
                    </MessageBar>
                )}
                <Field label="Approval note">
                    <Textarea
                        value={reason}
                        onChange={(_e, d) => setReason(d.value)}
                        disabled={!canApprove || isSubmitting}
                        placeholder="Optional note recorded with the approval"
                    />
                </Field>
                <div className={styles.actions}>
                    <Button appearance="primary" onClick={approve} disabled={!canApprove || isSubmitting}>
                        {isSubmitting ? 'Approving…' : 'Approve order'}
                    </Button>
                    {canRetry && (
                        <Button appearance="secondary" onClick={approve} disabled={isSubmitting}>
                            Try again
                        </Button>
                    )}
                    {!canApprove && <Text>Approval isn't available on this runtime.</Text>}
                </div>
            </Card>
        </div>
    );
};

export default GeneratedComponent;
