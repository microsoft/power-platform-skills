import React, { useState } from "react";
import { DataGrid, DataGridHeader, DataGridBody, DataGridRow, DataGridCell, DataGridHeaderCell, TableCellLayout, createTableColumn, Text, Input, MessageBar, MessageBarBody } from "@fluentui/react-components";

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
const PAGE_NAME = 'Account Grid';

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

type Account = { id: string; name: string; address1_city: string; address1_stateorprovince: string; address1_postalcode: string; address1_country: string; telephone1: string; };

const sampleAccounts: Account[] = [
    { id: "1", name: "John Doe Corp", address1_city: "New York", address1_stateorprovince: "NY", address1_postalcode: "10001", address1_country: "USA", telephone1: "123-456-7890" },
    { id: "2", name: "Jane Smith LLC", address1_city: "Los Angeles", address1_stateorprovince: "CA", address1_postalcode: "90001", address1_country: "USA", telephone1: "987-654-3210" },
    { id: "3", name: "Acme Inc", address1_city: "Chicago", address1_stateorprovince: "IL", address1_postalcode: "60601", address1_country: "USA", telephone1: "555-555-5555" },
    { id: "4", name: "Globex Corporation", address1_city: "Houston", address1_stateorprovince: "TX", address1_postalcode: "77001", address1_country: "USA", telephone1: "444-444-4444" },
    { id: "5", name: "Initech", address1_city: "Phoenix", address1_stateorprovince: "AZ", address1_postalcode: "85001", address1_country: "USA", telephone1: "333-333-3333" },
];

// Mock page: no RuntimeTypes import (not generated for mock pages), so it declares its own props.
type Props = { dataApi?: unknown; pageInput?: { id?: string } };

function PageBody(props: Props) {
    const { pageInput } = props;
    void pageInput;
    const [accounts] = useState<Account[]>(sampleAccounts);
    const [filterText, setFilterText] = useState("");
    const filteredAccounts = accounts.filter(acc => {
        const s = filterText.toLowerCase();
        return [acc.name, acc.address1_city, acc.address1_stateorprovince, acc.address1_postalcode, acc.address1_country, acc.telephone1].some(f => f.toLowerCase().includes(s));
    });

    const col = (id: keyof Account, label: string) => createTableColumn<Account>({
        columnId: id, compare: (a, b) => a[id].localeCompare(b[id]),
        renderHeaderCell: () => <Text weight="bold" size={400} style={{ padding: 8 }}>{label}</Text>,
        renderCell: (item) => <TableCellLayout>{item[id]}</TableCellLayout>
    });

    const columns = [
        col("name", "Account Name"),
        col("address1_city", "City"),
        col("address1_stateorprovince", "State"),
        col("address1_postalcode", "Zip"),
        col("address1_country", "Country"),
        col("telephone1", "Phone")
    ];

    return (
        <div style={{ flexGrow: 1, alignSelf: "stretch", width: "100%", height: "100%", padding: 20, boxSizing: "border-box", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <Text size={600} weight="semibold" block style={{ marginBottom: 12 }}>Account Grid</Text>
            <Input placeholder="Filter accounts..." value={filterText} onChange={(e, d) => setFilterText(d.value)} style={{ marginBottom: 12, maxWidth: 300 }} />
            <div style={{ flex: 1, overflow: "auto" }}>
                <DataGrid items={filteredAccounts} columns={columns} sortable selectionMode="multiselect" getRowId={i => i.id} focusMode="composite">
                    <DataGridHeader>
                        <DataGridRow selectionCell={{ checkboxIndicator: { "aria-label": "Select all rows" } }}>
                            {({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}
                        </DataGridRow>
                    </DataGridHeader>
                    <DataGridBody<Account>>
                        {({ item, rowId }) => (
                            <DataGridRow<Account> key={rowId} selectionCell={{ checkboxIndicator: { "aria-label": "Select row" } }}>
                                {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
                            </DataGridRow>
                        )}
                    </DataGridBody>
                </DataGrid>
            </div>
        </div>
    );
}

const GeneratedComponent = (props: Props) => (
    <PageErrorBoundary>
        <PageBody {...props} />
    </PageErrorBoundary>
);

export default GeneratedComponent;
