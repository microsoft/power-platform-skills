type Spy<T extends (...args: never[]) => unknown> = jest.MockedFunction<T>;

export type MockPropertyOptions = {
  readable?: boolean;
  editable?: boolean;
};

export type MockContextOptions = {
  disabled?: boolean;
  visible?: boolean;
  width?: number;
  height?: number;
  formFactor?: number;
  offline?: boolean;
  rtl?: boolean;
  languageId?: number;
  webAPI?: ComponentFramework.WebApi;
  utils?: Partial<ComponentFramework.Utility>;
};

export function mockProperty<T>(
  raw: T | null,
  formatted?: string,
  options: MockPropertyOptions = {},
): ComponentFramework.PropertyTypes.Property {
  return {
    raw,
    formatted,
    security: {
      readable: options.readable ?? true,
      editable: options.editable ?? true,
      secured: options.readable === false || options.editable === false,
    },
  } as ComponentFramework.PropertyTypes.Property;
}

export function mockContext<TInputs>(
  parameters: Partial<TInputs>,
  options: MockContextOptions = {},
): ComponentFramework.Context<TInputs> {
  // The production framework supplies many members that a field control should not touch. Tests keep
  // those omitted so a template that reaches outside its contract fails fast instead of depending on
  // a broad, misleading fake.
  return {
    parameters,
    mode: {
      isControlDisabled: options.disabled ?? false,
      isVisible: options.visible ?? true,
      allocatedWidth: options.width ?? 320,
      allocatedHeight: options.height ?? 80,
      trackContainerResize: jest.fn(),
    },
    client: {
      getFormFactor: jest.fn(() => options.formFactor ?? 1),
      isOffline: jest.fn(() => options.offline ?? false),
    },
    userSettings: {
      isRTL: options.rtl ?? false,
      languageId: options.languageId ?? 1033,
    },
    webAPI: options.webAPI ?? mockWebApi({}),
    utils: options.utils ?? {},
  } as unknown as ComponentFramework.Context<TInputs>;
}

export type WebApiHandlers = {
  retrieveRecord?: Spy<(entityLogicalName: string, id: string, options?: string) => Promise<ComponentFramework.WebApi.Entity>>;
  retrieveMultipleRecords?: Spy<(entityLogicalName: string, options?: string, maxPageSize?: number) => Promise<ComponentFramework.WebApi.RetrieveMultipleResponse>>;
  createRecord?: Spy<(entityLogicalName: string, data: ComponentFramework.WebApi.Entity) => Promise<ComponentFramework.LookupValue>>;
  updateRecord?: Spy<(entityLogicalName: string, id: string, data: ComponentFramework.WebApi.Entity) => Promise<ComponentFramework.LookupValue>>;
  deleteRecord?: Spy<(entityLogicalName: string, id: string) => Promise<ComponentFramework.LookupValue>>;
};

export function mockWebApi(handlers: WebApiHandlers): ComponentFramework.WebApi {
  const reject = (method: string) => jest.fn(() => Promise.reject(new Error(`No mock WebAPI handler registered for ${method}`)));
  return {
    retrieveRecord: handlers.retrieveRecord ?? reject("retrieveRecord"),
    retrieveMultipleRecords: handlers.retrieveMultipleRecords ?? reject("retrieveMultipleRecords"),
    createRecord: handlers.createRecord ?? reject("createRecord"),
    updateRecord: handlers.updateRecord ?? reject("updateRecord"),
    deleteRecord: handlers.deleteRecord ?? reject("deleteRecord"),
  } as ComponentFramework.WebApi;
}

export type MockDataSetRecord = Record<string, string | number | boolean | Date | null | undefined>;

export type MockDataSetOptions = {
  loading?: boolean;
  error?: boolean;
  errorMessage?: string;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
};

export function mockDataSet(
  records: Record<string, MockDataSetRecord>,
  columns: Array<{ name: string; displayName?: string }>,
  options: MockDataSetOptions = {},
): ComponentFramework.PropertyTypes.DataSet {
  const ids = Object.keys(records);
  return {
    loading: options.loading ?? false,
    error: options.error ?? false,
    errorMessage: options.errorMessage,
    sortedRecordIds: ids,
    columns: columns.map((column) => ({ ...column, displayName: column.displayName ?? column.name })),
    records: Object.fromEntries(ids.map((id) => {
      const row = records[id];
      return [id, {
        getValue: (columnName: string) => row[columnName],
        getFormattedValue: (columnName: string) => {
          const value = row[columnName];
          return value == null ? "" : String(value);
        },
        getNamedReference: () => ({
          id,
          name: String(row.name ?? row.sampleProperty ?? id),
          entityName: String(row.entityName ?? "account"),
        }),
      }];
    })),
    paging: {
      hasNextPage: options.hasNextPage ?? false,
      hasPreviousPage: options.hasPreviousPage ?? false,
      loadNextPage: jest.fn(),
      loadPreviousPage: jest.fn(),
    },
    openDatasetItem: jest.fn(),
    refresh: jest.fn(),
  } as unknown as ComponentFramework.PropertyTypes.DataSet;
}
