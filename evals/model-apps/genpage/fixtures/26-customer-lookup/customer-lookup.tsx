import * as React from 'react';
import {
  Button,
  Dropdown,
  Field,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Option,
  SearchBox,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { OpenRegular } from '@fluentui/react-icons';
import type { GeneratedComponentProps, ReadableTableRow, opportunity } from './RuntimeTypes';

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
const PAGE_NAME = 'Customer Opportunities';

// The error copy of an English-only page (references/rules.md, "Missing Error Handling").
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
      {error.retry && (
        <MessageBarActions>
          <Button onClick={error.retry}>{translate('error.tryAgain')}</Button>
        </MessageBarActions>
      )}
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

// The lookup normalizer of references/rules.md ("Lookup references"), copied unchanged.
type LookupReference = { table: string; id: string };
type LookupNormalization =
  | { state: 'unset' }
  | { state: 'resolved'; reference: LookupReference }
  | { state: 'needs-target'; id: string }
  | { state: 'invalid' };

const LOOKUP_GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LOOKUP_QUALIFIED = /^\/([a-z_][a-z0-9_]*)\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)$/;

function normalizeLookupReference(
  row: unknown,
  property: string,
  allowedTargets: readonly string[],
): LookupNormalization {
  if (typeof row !== 'object' || row === null || Array.isArray(row) || allowedTargets.length === 0) return { state: 'invalid' };
  const record = row as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, property)) return { state: 'invalid' };
  const raw = record[property];
  if (raw === null) return { state: 'unset' };
  if (typeof raw !== 'string') return { state: 'invalid' };
  const value = raw.trim();
  const qualified = LOOKUP_QUALIFIED.exec(value);
  if (!qualified && !LOOKUP_GUID.test(value)) return { state: 'invalid' };
  const prefix = qualified ? qualified[1] : undefined;
  const id = (qualified ? qualified[2] : value).toLowerCase();
  if (prefix !== undefined && !allowedTargets.includes(prefix)) return { state: 'invalid' };
  const annotationKey = `${property}@Microsoft.Dynamics.CRM.lookuplogicalname`;
  let annotation: string | undefined;
  if (Object.prototype.hasOwnProperty.call(record, annotationKey)) {
    const named = record[annotationKey];
    if (typeof named !== 'string' || !allowedTargets.includes(named)) return { state: 'invalid' };
    annotation = named;
  }
  if (annotation !== undefined && prefix !== undefined && annotation !== prefix) return { state: 'invalid' };
  const table = annotation ?? prefix ?? (allowedTargets.length === 1 ? allowedTargets[0] : undefined);
  return table === undefined ? { state: 'needs-target', id } : { state: 'resolved', reference: { table, id } };
}

type OpportunityRow = ReadableTableRow<opportunity>;
// A customer the maker can pick: the table is kept with the id, so equal labels — or one GUID — in two tables stay two choices.
type Picked = { table: 'account' | 'contact'; id: string; label: string };

// Page-scoped window keys (unique per page + query), so the host's double mount shares one read (references/data-caching.md).
const winAny = window as any;
const CACHE_KEY = '__ppCustomerOpportunities_opportunityCache';
const INFLIGHT_KEY = '__ppCustomerOpportunities_opportunityInflight';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalXL,
    boxSizing: 'border-box',
  },
  item: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalM,
  },
});

// The customer's label: display text only, never an identity (rules.md DataAPI Rule 12).
function customerLabel(row: OpportunityRow): string {
  return String(row['_customerid_value@OData.Community.Display.V1.FormattedValue'] ?? '');
}

// One choice per resolved table-and-id pair; an unresolved customer offers none.
function customerChoice(row: OpportunityRow): Picked | null {
  const normalized = normalizeLookupReference(row, '_customerid_value', ['account', 'contact']);
  if (normalized.state !== 'resolved') return null;
  const reference = normalized.reference;
  return { table: reference.table === 'account' ? 'account' : 'contact', id: reference.id, label: customerLabel(row) };
}

function OpportunityItem(props: {
  row: OpportunityRow;
  onOpen: (row: OpportunityRow) => void;
  onAccountView: (row: OpportunityRow) => void;
  onChangeCustomer: (opportunityId: string) => void;
}) {
  const { row } = props;
  const styles = useStyles();
  const customer = normalizeLookupReference(row, '_customerid_value', ['account', 'contact']);
  // An unset, invalid or untargeted customer shows its label and offers nothing that needs its table.
  if (customer.state !== 'resolved') {
    return (
      <div className={styles.item}>
        <Text weight="semibold">{row.name}</Text>
        <Text>{customerLabel(row) || 'No customer'}</Text>
        <Text size={200}>This customer cannot be opened or filtered from this page.</Text>
        <Button onClick={() => props.onChangeCustomer(row.opportunityid)}>Change customer</Button>
      </div>
    );
  }
  const reference = customer.reference;
  return (
    <div className={styles.item}>
      <Text weight="semibold">{row.name}</Text>
      <Text>{customerLabel(row)}</Text>
      <Button icon={<OpenRegular />} onClick={() => props.onOpen(row)}>Open customer</Button>
      {reference.table === 'account' && <Button onClick={() => props.onAccountView(row)}>Show this account's opportunities</Button>}
      <Button onClick={() => props.onChangeCustomer(row.opportunityid)}>Change customer</Button>
    </div>
  );
}

function PageBody(props: GeneratedComponentProps) {
  const { dataApi, pageInput } = props;
  void pageInput;
  const styles = useStyles();
  const dataReady = !!dataApi;
  const [reloadKey, setReloadKey] = React.useState(0);
  // F3: every opportunity that has a customer, of either table, read once and cached (A2).
  const [{ opportunities, loading, error }, setData] = React.useState<{ opportunities: OpportunityRow[]; loading: boolean; error: PageErrorView | null }>(() => {
    const cached = winAny[CACHE_KEY] as OpportunityRow[] | undefined;
    return { opportunities: cached ?? [], loading: cached === undefined, error: null };
  });
  // F2: a search of the loaded rows by customer name.
  const [searchText, setSearchText] = React.useState('');
  // R1 and F1: the account view (A1 — the direct customer account, no contact roll-up).
  const [accountView, setAccountView] = React.useState<{ label: string; rows: OpportunityRow[]; loading: boolean; error: PageErrorView | null }>({ label: '', rows: [], loading: false, error: null });
  const accountRequest = React.useRef(0);
  const [navigation, setNavigation] = React.useState<{ error: PageErrorView | null }>({ error: null });
  const [change, setChange] = React.useState<{ opportunityId: string; picked: Picked | null; saving: boolean; error: PageErrorView | null }>({ opportunityId: '', picked: null, saving: false, error: null });
  const saving = React.useRef(false);

  // "Try again" after a failed load, and the refresh after a customer change: drop the cached rows and read again.
  function reloadOpportunities() {
    delete winAny[CACHE_KEY];
    delete winAny[INFLIGHT_KEY];
    setData({ opportunities: [], loading: true, error: null });
    setReloadKey((key) => key + 1);
  }

  React.useEffect(() => {
    if (!dataReady) return;
    const cached = winAny[CACHE_KEY] as OpportunityRow[] | undefined;
    if (cached !== undefined) {
      if (opportunities !== cached) setData({ opportunities: cached, loading: false, error: null });
      return;
    }
    let cancelled = false;
    let inflight = winAny[INFLIGHT_KEY] as Promise<OpportunityRow[]> | undefined;
    if (!inflight) {
      inflight = dataApi
        .queryTable('opportunity', { select: ['opportunityid', 'name', '_customerid_value'], filter: '_customerid_value ne null', orderBy: 'name asc', pageSize: 50 })
        .then((result: { rows: OpportunityRow[] }) => {
          winAny[CACHE_KEY] = result.rows;
          return result.rows;
        })
        .finally(() => { if (winAny[INFLIGHT_KEY] === inflight) delete winAny[INFLIGHT_KEY]; });
      winAny[INFLIGHT_KEY] = inflight;
    }
    inflight
      .then((rows) => { if (!cancelled) setData({ opportunities: rows, loading: false, error: null }); })
      .catch((failure) => { if (!cancelled) setData({ opportunities: [], loading: false, error: reportPageError(PAGE_NAME, 'loadOpportunities', undefined, failure, 'read', reloadOpportunities) }); });
    return () => { cancelled = true; };
    // Readiness and the reload key only — never dataApi (a new reference on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataReady, reloadKey]);

  async function showAccountOpportunities(row: OpportunityRow) {
    const normalized = normalizeLookupReference(row, '_customerid_value', ['account', 'contact']);
    if (normalized.state !== 'resolved') return;
    const reference = normalized.reference;
    if (reference.table !== 'account') return;
    const filter = `customerid_account/accountid eq ${reference.id}`;
    const requestId = ++accountRequest.current;
    setAccountView({ label: customerLabel(row), rows: [], loading: true, error: null });
    try {
      const result = await dataApi.queryTable('opportunity', { select: ['opportunityid', 'name', '_customerid_value'], filter, orderBy: 'name asc', pageSize: 50 });
      if (requestId !== accountRequest.current) return;
      setAccountView({ label: customerLabel(row), rows: result.rows, loading: false, error: null });
    } catch (failure) {
      if (requestId !== accountRequest.current) return;
      // A refused typed path stops here as a read failure: the filter is never weakened and nothing is post-filtered.
      setAccountView({ label: customerLabel(row), rows: [], loading: false, error: reportPageError(PAGE_NAME, 'loadAccountOpportunities', undefined, failure, 'read') });
    }
  }

  async function openCustomer(row: OpportunityRow) {
    const normalized = normalizeLookupReference(row, '_customerid_value', ['account', 'contact']);
    if (normalized.state !== 'resolved') return;
    const reference = normalized.reference;
    setNavigation({ error: null });
    try {
      await Xrm.Navigation.navigateTo({ pageType: 'entityrecord', entityName: reference.table, entityId: reference.id });
    } catch (failure) {
      setNavigation({ error: reportPageError(PAGE_NAME, 'openCustomerRecord', undefined, failure, 'read') });
    }
  }

  async function changeCustomer(opportunityId: string, selected: Picked) {
    if (saving.current) return;
    saving.current = true;
    setChange({ opportunityId, picked: selected, saving: true, error: null });
    // Pitfall E: the qualified value is built only here, for the table the maker picked.
    const link: `/account(${string})` | `/contact(${string})` = selected.table === 'account'
      ? `/account(${selected.id})`
      : `/contact(${selected.id})`;
    try {
      await dataApi.updateRow('opportunity', opportunityId, { _customerid_value: link });
      setChange({ opportunityId: '', picked: null, saving: false, error: null });
      reloadOpportunities();
    } catch (failure) {
      // A failed write is reported once and never retried: it may have reached the server.
      setChange({ opportunityId, picked: selected, saving: false, error: reportPageError(PAGE_NAME, 'changeCustomer', undefined, failure, 'write') });
    } finally {
      saving.current = false;
    }
  }

  const choices = React.useMemo(() => {
    const seen = new Map<string, Picked>();
    for (const row of opportunities) {
      const choice = customerChoice(row);
      if (choice && !seen.has(`${choice.table}:${choice.id}`)) seen.set(`${choice.table}:${choice.id}`, choice);
    }
    return Array.from(seen.values());
  }, [opportunities]);
  const term = searchText.trim().toLowerCase();
  // F2 searches the loaded rows only — it is not a search of every opportunity on the server.
  const shown = term ? opportunities.filter((row) => customerLabel(row).toLowerCase().includes(term)) : opportunities;

  return (
    <div className={styles.root}>
      <Text as="h1" size={700} weight="semibold">Customer Opportunities</Text>
      <PageErrorBar error={error} />
      <PageErrorBar error={navigation.error} />
      <SearchBox
        aria-label="Search the loaded opportunities by customer name"
        placeholder="Search the loaded opportunities by customer name"
        value={searchText}
        onChange={(_, data) => setSearchText(data.value ?? '')}
      />
      {loading ? <Spinner label="Loading opportunities" /> : shown.map((row) => (
        <OpportunityItem
          key={row.opportunityid}
          row={row}
          onOpen={(item) => void openCustomer(item)}
          onAccountView={(item) => void showAccountOpportunities(item)}
          onChangeCustomer={(opportunityId) => setChange({ opportunityId, picked: null, saving: false, error: null })}
        />
      ))}
      <section className={styles.panel} aria-label="Account opportunities">
        <PageErrorBar error={accountView.error} />
        {accountView.loading && <Spinner label="Loading the account's opportunities" />}
        {accountView.label && !accountView.loading && <Text weight="semibold">{accountView.label}</Text>}
        {accountView.rows.map((row) => <Text key={row.opportunityid}>{row.name}</Text>)}
      </section>
      <PageErrorBar error={change.error} />
      {change.opportunityId && (
        <section className={styles.panel} aria-label="Change customer">
          <Field label="New customer">
            <Dropdown
              placeholder="Pick a customer"
              selectedOptions={change.picked ? [`${change.picked.table}:${change.picked.id}`] : []}
              onOptionSelect={(_, data) => setChange({ opportunityId: change.opportunityId, picked: choices.find((choice) => `${choice.table}:${choice.id}` === data.optionValue) ?? null, saving: false, error: null })}
            >
              {choices.map((choice) => (
                <Option key={`${choice.table}:${choice.id}`} value={`${choice.table}:${choice.id}`} text={`${choice.label} (${choice.table})`}>
                  {`${choice.label} (${choice.table})`}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Button
            appearance="primary"
            disabled={!change.picked || change.saving}
            onClick={() => { if (change.picked) void changeCustomer(change.opportunityId, change.picked); }}
          >
            Save customer
          </Button>
        </section>
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
