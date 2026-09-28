// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** A scalar value Dataverse can store in a column. */
export type DataColumnValue = string | number | boolean | null;

/**
 * A Dataverse row keyed by logical column name. Returned rows can also contain OData
 * annotations such as "<column>@OData.Community.Display.V1.FormattedValue".
 */
export interface DataRow {
  [column: string]: unknown;
}

/** A Dataverse primary-key GUID. */
export type RowKeyDataColumnValue = string;

/** One page returned by a table query. */
export interface DataTable<T extends DataRow = DataRow> {
  rows: T[];
  hasMoreRows: boolean;
  /** Present when another page is available. */
  loadMoreRows?: () => Promise<DataTable<T>>;
}

/** A localized Dataverse choice option and its raw numeric value. */
export interface ChoiceOption {
  label: string;
  value: number;
}

/** Options accepted by {@link CodefulToolHostDataApi.queryTable}. */
export interface QueryTableOptions {
  /** Logical column names to return. */
  select?: string[];
  /** OData filter expression using logical column names and raw choice values. */
  filter?: string;
  /** OData order-by expression using logical column names. */
  orderBy?: string;
  /** Maximum page size requested from the host. */
  pageSize?: number;
}

/** Options accepted by {@link CodefulToolHostDataApi.retrieveRow}. */
export interface RetrieveRowOptions {
  id: RowKeyDataColumnValue;
  select?: string[];
}

export type TelemetryLevel = "info" | "warn" | "error";

/**
 * Dataverse API injected by the codeful-tool host.
 *
 * Table arguments are singular entity logical names, such as "account". Column names,
 * filters, order-by expressions, and row keys also use Dataverse logical names. Methods
 * reject on failure; they do not return success/error envelopes.
 */
export interface CodefulToolHostDataApi {
  createRow(tableName: string, row: DataRow): Promise<RowKeyDataColumnValue>;
  updateRow(tableName: string, rowId: RowKeyDataColumnValue, row: DataRow): Promise<void>;
  deleteRow(tableName: string, rowId: RowKeyDataColumnValue): Promise<void>;
  retrieveRow(tableName: string, options: RetrieveRowOptions): Promise<DataRow>;
  queryTable(tableName: string, query?: QueryTableOptions): Promise<DataTable>;
  getChoices(enumName: string): Promise<ChoiceOption[]>;
  /** Fire-and-forget host telemetry. This method never throws. */
  sendTelemetry(
    name: string,
    level: TelemetryLevel,
    properties?: Record<string, unknown>,
  ): void;
}

/** The single argument passed to a codeful tool's exported `runTool` function. */
export interface RunToolContext {
  toolInput: Record<string, unknown>;
  dataApi: CodefulToolHostDataApi;
}

export interface TextContentBlock {
  type: "text";
  text: string;
}

/**
 * Intentional MCP result-channel partition.
 *
 * `content` and `structuredContent` are visible to the model. `meta` is mapped by the
 * host to MCP `_meta`, which is delivered to the widget but excluded from model context.
 * If a returned object contains any one of these three reserved keys, the host treats it
 * as this envelope and ignores unrelated top-level siblings. Wrap business data containing
 * a reserved key inside `structuredContent`.
 */
export interface CodefulToolResult {
  content?: string | TextContentBlock[];
  structuredContent?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/**
 * A plain record is promoted to `structuredContent`. Return a CodefulToolResult when the
 * three result channels need to be controlled independently.
 */
export type RunTool = (
  context: RunToolContext,
) => Promise<Record<string, unknown> | CodefulToolResult>;
