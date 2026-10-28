import React, { useEffect, useState } from 'react';
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
    MessageBar,
    MessageBarBody,
} from '@fluentui/react-components';
import { ArrowLeftRegular } from '@fluentui/react-icons';

// ---------- Page errors ----------
// The page error block of references/rules.md ("Missing Error Handling"), copied unchanged: every failed data
// operation goes through reportPageError, PageErrorBar shows the view it returns, and the page renders inside
// PageErrorBoundary.

type PageErrorKind = 'read' | 'write' | 'indeterminate' | 'network' | 'render';
type PageErrorView = {
  operation: string;
  message: string;
  fallbackKey: string;
  code?: string;
  kind: PageErrorKind;
  retry?: () => void;
};
type PageErrorTelemetry = {
  trackException?: (error: unknown, properties?: Record<string, unknown>) => void;
};

// The plan's display name for this page: a fixed literal, not the file name.
const PAGE_NAME = 'Contact Detail';

// The error copy of an English-only page. A localized page keeps these keys in its translations dictionary instead.
const ERROR_COPY: Record<string, string> = {
  'error.read': 'Unable to load data. Please try again.',
  'error.write': 'The change could not be saved. Refresh before trying again.',
  'error.network': 'The request did not go through. You can try again.',
  'error.indeterminate': "We couldn't confirm this completed — refresh before retrying.",
  'error.render': 'This page hit a problem and could not render. Refresh the page.',
  'error.tryAgain': 'Try again',
};

function translate(key: string): string {
  return ERROR_COPY[key] || key;
}

// The page's one error reporter. It logs bounded diagnostics once and returns the view the failed
// operation stores; it never sets state, never calls retry, and reads only the named fields of a
// thrown value, each on its own, so a throwing getter leaves that one field empty.
function reportPageError(
  pageName: string,
  operation: string,
  code: unknown,
  message: unknown,
  kind: PageErrorKind,
  retry?: () => void,
  appInsights?: PageErrorTelemetry,
): PageErrorView {
  const fields: Record<string, unknown> = {};
  for (const path of ['code', 'errorCode', 'message', 'error.code', 'error.message']) {
    try {
      let value: unknown = message;
      for (const part of path.split('.')) {
        value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
      }
      fields[path] = value;
    } catch {
      fields[path] = undefined;
    }
  }
  let normalizedCode = '';
  for (const candidate of [code, fields['code'], fields['errorCode'], fields['error.code']]) {
    const text = typeof candidate === 'string' ? candidate : typeof candidate === 'number' && Number.isFinite(candidate) ? String(candidate) : '';
    normalizedCode = text.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 80);
    if (normalizedCode) break;
  }
  let normalizedMessage = '';
  for (const candidate of [message, fields['message'], fields['error.message']]) {
    const line = typeof candidate === 'string' ? candidate.trim().split(/[\r\n\u2028\u2029]/)[0].replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim() : '';
    if (!line || /^\[object [^\]]*\]$/.test(line) || /^at\s.*(?::\d+:\d+\)?|\((?:native|<anonymous>)\))$/.test(line)) continue;
    normalizedMessage = line.length > 300 ? line.slice(0, 299) + '\u2026' : line;
    break;
  }
  console.error('[' + String(pageName).replace(/[\r\n\]]/g, '') + '] ' + operation + ' failed', { code: normalizedCode, message: normalizedMessage });
  const quiet = kind === 'indeterminate' || kind === 'render';
  const view: PageErrorView = { operation, message: quiet ? '' : normalizedMessage, fallbackKey: 'error.' + kind, kind };
  if (normalizedCode) view.code = normalizedCode;
  if (typeof retry === 'function' && (kind === 'read' || kind === 'network')) view.retry = retry;
  return view;
}

function PageErrorBar(props: { error: PageErrorView | null }) {
  const { error } = props;
  if (!error) return null;
  return (
    <MessageBar intent="error">
      <MessageBarBody>{error.message || translate(error.fallbackKey)}</MessageBarBody>
    </MessageBar>
  );
}

// The page's one class component: it catches a render crash below it and shows a fixed message.
class PageErrorBoundary extends React.Component<
  { children: React.ReactNode; appInsights?: PageErrorTelemetry },
  { failed: boolean }
> {
  public state = { failed: false };

  public static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  public componentDidCatch(error: Error): void {
    reportPageError(PAGE_NAME, 'render', undefined, error, 'render');
  }

  public render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <MessageBar intent="error">
          <MessageBarBody>{translate('error.render')}</MessageBarBody>
        </MessageBar>
      );
    }
    return this.props.children;
  }
}

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
//   - Rule 22: a failed read goes through reportPageError and PageErrorBar; the page
//     renders inside PageErrorBoundary

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
const CACHE_KEY = '__ppContactDetail_contactCache';
const INFLIGHT_KEY = '__ppContactDetail_contactInflight';
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

function PageBody(props: GeneratedComponentProps) {
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
    const [data, setData] = useState<{ record: ReadableContact | null; loading: boolean; error: PageErrorView | null }>(
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
            .catch((failure) => {
                if (cancelled) return;
                // Reported once — bounded code and message, never the thrown value; never cached.
                setData({ record: null, loading: false, error: reportPageError(PAGE_NAME, 'loadContact', undefined, failure, 'read') });
            });

        return () => { cancelled = true; };
        // Readiness + recordId only — never `dataApi`. See Rule 15.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady, recordId]);

    const goBack = () => {
        const xrm = (window as unknown as { Xrm?: { Navigation?: { navigateTo: (opts: unknown) => unknown } } }).Xrm;
        xrm?.Navigation?.navigateTo({
            pageType: 'generative',
            pageId: "PAGEREF_9-list-with-caching",
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

            <PageErrorBar error={data.error} />

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
}

const GeneratedComponent = (props: GeneratedComponentProps) => (
    <PageErrorBoundary>
        <PageBody {...props} />
    </PageErrorBoundary>
);

export default GeneratedComponent;
