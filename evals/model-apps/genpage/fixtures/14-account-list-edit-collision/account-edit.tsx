import { useEffect, useMemo, useState } from 'react';
import type {
    GeneratedComponentProps,
    account,
    ReadableTableRow,
    RetrieveRowOptions,
    WritableTableRow,
} from './RuntimeTypes';
import {
    makeStyles,
    tokens,
    Text,
    Spinner,
    Button,
    Card,
    Divider,
    Field,
    Input,
    Textarea,
    MessageBar,
    MessageBarBody,
} from '@fluentui/react-components';
import { ArrowLeftRegular, ArrowUndoRegular, SaveRegular } from '@fluentui/react-icons';

type AccountRow = ReadableTableRow<account>;
type XrmNavigation = { Navigation?: { navigateTo?: (input: Record<string, unknown>) => Promise<unknown> } };

const EDITABLE_FIELDS = [
    'name',
    'accountnumber',
    'telephone1',
    'emailaddress1',
    'websiteurl',
    'address1_line1',
    'address1_city',
    'address1_stateorprovince',
    'address1_postalcode',
    'address1_country',
    'description',
] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];
type AccountForm = Record<EditableField, string>;
type Notice = { intent: 'success' | 'error'; text: string };
type PageState = {
    record: AccountRow | null;
    form: AccountForm;
    loading: boolean;
    error: string | null;
    saving: boolean;
    showErrors: boolean;
    notice: Notice | null;
};

const FIELD_LABELS: Record<EditableField, string> = {
    name: 'Account name',
    accountnumber: 'Account number',
    telephone1: 'Main phone',
    emailaddress1: 'Email',
    websiteurl: 'Website',
    address1_line1: 'Street',
    address1_city: 'City',
    address1_stateorprovince: 'State/Province',
    address1_postalcode: 'ZIP/Postal code',
    address1_country: 'Country/Region',
    description: 'Description',
};

const DETAILS_FIELDS: EditableField[] = ['name', 'accountnumber', 'telephone1', 'emailaddress1', 'websiteurl'];
const ADDRESS_FIELDS: EditableField[] = ['address1_line1', 'address1_city', 'address1_stateorprovince', 'address1_postalcode', 'address1_country'];

const SELECT_COLUMNS: RetrieveRowOptions<account>['select'] = [
    'accountid',
    'name',
    'accountnumber',
    'telephone1',
    'emailaddress1',
    'websiteurl',
    'address1_line1',
    'address1_city',
    'address1_stateorprovince',
    'address1_postalcode',
    'address1_country',
    'description',
    'modifiedon',
];

// Per-record Map cache + in-flight Map on window (references/data-caching.md, Pattern 2), so the
// host double-mount retrieves each account once and a return visit renders without a spinner.
const DETAIL_CACHE_KEY = '__ppAccountEdit_accountCache';
const DETAIL_INFLIGHT_KEY = '__ppAccountEdit_accountInflight';
// Owned by the Accounts list page; evicted after a save so the list shows the edit on return.
const LIST_CACHE_KEY = '__ppAccountList_accountCache';
const LIST_INFLIGHT_KEY = '__ppAccountList_accountInflight';
const winAny = window as unknown as Record<string, unknown>;
const detailCache: Map<string, AccountRow> =
    (winAny[DETAIL_CACHE_KEY] as Map<string, AccountRow> | undefined) ?? new Map<string, AccountRow>();
winAny[DETAIL_CACHE_KEY] = detailCache;
const detailInflight: Map<string, Promise<AccountRow>> =
    (winAny[DETAIL_INFLIGHT_KEY] as Map<string, Promise<AccountRow>> | undefined) ?? new Map<string, Promise<AccountRow>>();
winAny[DETAIL_INFLIGHT_KEY] = detailInflight;

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const useStyles = makeStyles({
    root: {
        position: 'relative',
        contain: 'layout',
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalL,
        height: '100%',
        width: '100%',
        boxSizing: 'border-box',
        padding: tokens.spacingHorizontalXL,
        overflowY: 'auto',
        color: tokens.colorNeutralForeground1,
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalM,
    },
    titleBlock: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
        flexGrow: 1,
        minWidth: 0,
    },
    title: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    meta: {
        color: tokens.colorNeutralForeground2,
    },
    card: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
        padding: tokens.spacingHorizontalL,
        maxWidth: '960px',
    },
    sectionTitle: {
        fontWeight: tokens.fontWeightSemibold,
    },
    fieldGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        columnGap: tokens.spacingHorizontalL,
        rowGap: tokens.spacingVerticalM,
        '@media (max-width: 720px)': {
            gridTemplateColumns: 'minmax(0, 1fr)',
        },
    },
    actions: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalS,
    },
    centered: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: tokens.spacingVerticalM,
        padding: tokens.spacingVerticalXXL,
        color: tokens.colorNeutralForeground2,
        textAlign: 'center',
    },
});

function readAccountId(pageInput: { data?: Record<string, unknown> } | undefined): string | undefined {
    // pageInput.data values are unknown-typed primitives; accept only a GUID string (braces allowed).
    const raw = pageInput?.data?.accountId;
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim().replace(/^\{/, '').replace(/\}$/, '');
    return GUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function fieldText(row: AccountRow | null, field: string): string {
    if (!row) return '';
    const value = (row as unknown as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : '';
}

function toForm(row: AccountRow | null): AccountForm {
    const form = {} as AccountForm;
    for (const field of EDITABLE_FIELDS) form[field] = fieldText(row, field);
    return form;
}

function changedFields(original: AccountForm, current: AccountForm): EditableField[] {
    return EDITABLE_FIELDS.filter((field) => original[field] !== current[field]);
}

function validate(form: AccountForm): Partial<Record<EditableField, string>> {
    const errors: Partial<Record<EditableField, string>> = {};
    if (!form.name.trim()) errors.name = 'Account name is required.';
    if (form.emailaddress1.trim() && !EMAIL_PATTERN.test(form.emailaddress1.trim())) {
        errors.emailaddress1 = 'Enter a valid email address.';
    }
    return errors;
}

function toPayload(form: AccountForm, fields: EditableField[]): Record<string, string | null> {
    // An emptied text box clears the column rather than storing an empty string.
    const payload: Record<string, string | null> = {};
    for (const field of fields) {
        const value = form[field].trim();
        payload[field] = value ? value : null;
    }
    return payload;
}

function openAccountsList() {
    const xrm = (window as unknown as { Xrm?: XrmNavigation }).Xrm;
    void xrm?.Navigation?.navigateTo?.({
        pageType: "generative",
        pageId: "14141414-1414-4414-8414-141414141401",
    });
}

function initialState(accountId: string | undefined): PageState {
    const cached = accountId ? detailCache.get(accountId) : undefined;
    return {
        record: cached ?? null,
        form: toForm(cached ?? null),
        loading: !!accountId && cached === undefined,
        error: null,
        saving: false,
        showErrors: false,
        notice: null,
    };
}

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    const styles = useStyles();

    // Derived synchronously from props on every render; never copied into state.
    const accountId = readAccountId(pageInput as { data?: Record<string, unknown> } | undefined);
    const dataReady = !!dataApi && !!accountId;

    const [state, setData] = useState<PageState>(() => initialState(accountId));
    const { record, form, loading, error, saving, showErrors, notice } = state;

    useEffect(() => {
        if (!dataReady || !accountId) return;
        const id = accountId;

        const hit = detailCache.get(id);
        if (hit !== undefined) {
            if (record !== hit) {
                setData({ record: hit, form: toForm(hit), loading: false, error: null, saving: false, showErrors: false, notice: null });
            }
            return;
        }
        let cancelled = false;

        let pending = detailInflight.get(id);
        if (!pending) {
            const request: Promise<AccountRow> = (async () => {
                const row = await dataApi.retrieveRow('account', { id, select: SELECT_COLUMNS });
                detailCache.set(id, row);
                return row;
            })().finally(() => {
                if (detailInflight.get(id) === request) detailInflight.delete(id);
            });
            detailInflight.set(id, request);
            pending = request;
        }
        const shared = pending;

        (async () => {
            try {
                const row = await shared;
                if (!cancelled) {
                    setData({ record: row, form: toForm(row), loading: false, error: null, saving: false, showErrors: false, notice: null });
                }
            } catch (err) {
                if (cancelled) return;
                const message = err instanceof Error ? err.message : 'Unable to load the account.';
                setData({ record: null, form: toForm(null), loading: false, error: message, saving: false, showErrors: false, notice: null });
            }
        })();

        return () => {
            cancelled = true;
        };
        // Readiness and the account id only: dataApi is a new reference on every render (Rule 15).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady, accountId]);

    const original = useMemo(() => toForm(record), [record]);
    const changed = useMemo(() => changedFields(original, form), [original, form]);
    const errors = useMemo(() => validate(form), [form]);

    const setField = (field: EditableField, value: string) => {
        setData((prev) => ({ ...prev, form: { ...prev.form, [field]: value }, notice: null }));
    };

    const discard = () => {
        setData((prev) => ({ ...prev, form: toForm(prev.record), showErrors: false, notice: null }));
    };

    const handleSave = async () => {
        if (!accountId || !record || saving || changed.length === 0) return;
        if (Object.keys(errors).length > 0) {
            setData((prev) => ({ ...prev, showErrors: true, notice: { intent: 'error', text: 'Fix the highlighted fields before saving.' } }));
            return;
        }
        const payload = toPayload(form, changed);
        setData((prev) => ({ ...prev, saving: true, notice: null }));
        try {
            await dataApi.updateRow('account', accountId, payload as unknown as WritableTableRow<account>);
            const merged = { ...record, ...payload } as unknown as AccountRow;
            detailCache.set(accountId, merged);
            delete winAny[LIST_CACHE_KEY];
            delete winAny[LIST_INFLIGHT_KEY];
            setData({
                record: merged,
                form: toForm(merged),
                loading: false,
                error: null,
                saving: false,
                showErrors: false,
                notice: { intent: 'success', text: 'Account saved.' },
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unable to save the account.';
            setData((prev) => ({ ...prev, saving: false, notice: { intent: 'error', text: message } }));
        }
    };

    const renderField = (field: EditableField) => {
        const message = showErrors ? errors[field] : undefined;
        return (
            <Field
                key={field}
                label={FIELD_LABELS[field]}
                required={field === 'name'}
                validationState={message ? 'error' : 'none'}
                validationMessage={message}
            >
                <Input
                    type={field === 'emailaddress1' ? 'email' : field === 'websiteurl' ? 'url' : 'text'}
                    value={form[field]}
                    onChange={(_, data) => setField(field, data.value)}
                    disabled={saving}
                />
            </Field>
        );
    };

    if (!accountId) {
        return (
            <div className={styles.root}>
                <div className={styles.centered}>
                    <Text>No account selected. Open this page from the Accounts list.</Text>
                    <Button icon={<ArrowLeftRegular />} onClick={openAccountsList}>
                        Back to accounts
                    </Button>
                </div>
            </div>
        );
    }

    if (loading) {
        return (
            <div className={styles.root}>
                <div className={styles.centered}>
                    <Spinner labelPosition="below" label="Loading account…" />
                </div>
            </div>
        );
    }

    if (!record) {
        return (
            <div className={styles.root}>
                <MessageBar intent="error">
                    <MessageBarBody>{error ?? 'The account could not be found.'}</MessageBarBody>
                </MessageBar>
                <div>
                    <Button icon={<ArrowLeftRegular />} onClick={openAccountsList}>
                        Back to accounts
                    </Button>
                </div>
            </div>
        );
    }

    const modifiedOn = fieldText(record, 'modifiedon@OData.Community.Display.V1.FormattedValue');

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <Button appearance="subtle" icon={<ArrowLeftRegular />} onClick={openAccountsList} aria-label="Back to accounts">
                    Back
                </Button>
                <div className={styles.titleBlock}>
                    <Text as="h1" size={700} weight="semibold" className={styles.title}>
                        Edit {original.name || 'account'}
                    </Text>
                    {modifiedOn && (
                        <Text size={200} className={styles.meta}>
                            Last modified {modifiedOn}
                        </Text>
                    )}
                </div>
            </header>

            {notice && (
                <MessageBar intent={notice.intent}>
                    <MessageBarBody>{notice.text}</MessageBarBody>
                </MessageBar>
            )}
            {!notice && changed.length > 0 && (
                <MessageBar intent="warning">
                    <MessageBarBody>You have unsaved changes.</MessageBarBody>
                </MessageBar>
            )}

            <form
                aria-label="Edit account"
                onSubmit={(event) => {
                    event.preventDefault();
                    void handleSave();
                }}
            >
                <Card className={styles.card}>
                    <Text as="h2" size={400} className={styles.sectionTitle}>
                        Account details
                    </Text>
                    <div className={styles.fieldGrid}>{DETAILS_FIELDS.map(renderField)}</div>
                    <Divider />
                    <Text as="h2" size={400} className={styles.sectionTitle}>
                        Address
                    </Text>
                    <div className={styles.fieldGrid}>{ADDRESS_FIELDS.map(renderField)}</div>
                    <Divider />
                    <Field label={FIELD_LABELS.description}>
                        <Textarea
                            value={form.description}
                            onChange={(_, data) => setField('description', data.value)}
                            resize="vertical"
                            disabled={saving}
                        />
                    </Field>
                    <div className={styles.actions}>
                        <Button type="submit" appearance="primary" icon={saving ? <Spinner size="tiny" /> : <SaveRegular />} disabled={saving || changed.length === 0}>
                            {saving ? 'Saving' : 'Save'}
                        </Button>
                        <Button type="button" icon={<ArrowUndoRegular />} onClick={discard} disabled={saving || changed.length === 0}>
                            Discard changes
                        </Button>
                    </div>
                </Card>
            </form>
        </div>
    );
};

export default GeneratedComponent;
