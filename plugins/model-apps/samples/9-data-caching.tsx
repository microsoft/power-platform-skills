/**
 * Data Caching Across Navigations
 *
 * Demonstrates the window-based caching pattern for genpage components.
 * The platform re-evaluates the module script on every navigation, resetting
 * module-level variables. This pattern persists data on `window` so return
 * visits render instantly without a loading spinner.
 *
 * Two variants:
 *   1. List/explorer page — caches an array of rows
 *   2. Detail page — caches individual rows in a Map keyed by recordId
 */

import React, { useState, useEffect } from "react";
import {
  DataGrid, DataGridHeader, DataGridBody, DataGridRow, DataGridCell,
  DataGridHeaderCell, TableCellLayout, createTableColumn,
  Text, Spinner, makeStyles, tokens,
} from "@fluentui/react-components";
import type {
  TableRow, ReadableTableRow, GeneratedComponentProps,
} from "./RuntimeTypes";

// =============================================================================
// LIST PAGE — array cache
// =============================================================================

// Module-level: read from window on eval (survives navigation)
// Replace MyRow with the actual entity type from RuntimeTypes.
type MyRow = ReadableTableRow<TableRow<{ readonly id: string; name: string; statuscode?: number }>>;
let _recordsCache: MyRow[] | null = (window as any).__ppMyEntityCache ?? null;

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM, padding: tokens.spacingHorizontalL },
  spinner: { display: "flex", justifyContent: "center", padding: tokens.spacingVerticalXXL },
});

const GeneratedComponent = (props: GeneratedComponentProps) => {
  const { dataApi } = props;
  const styles = useStyles();

  // Single batched state object — avoids intermediate renders in React 17
  const [{ records, loading, error }, setData] = useState<{
    records: MyRow[];
    loading: boolean;
    error: string | null;
  }>({ records: _recordsCache ?? [], loading: _recordsCache === null, error: null });

  useEffect(() => {
    if (!dataApi) { setData(prev => ({ ...prev, loading: false })); return; }
    if (_recordsCache !== null) return; // already cached — skip fetch, no spinner
    (async () => {
      try {
        const result = await dataApi.queryTable("myentity", {
          select: ["name", "statuscode"],
          pageSize: 100,
        });
        _recordsCache = result.rows;
        (window as any).__ppMyEntityCache = result.rows; // persist through navigation
        setData({ records: result.rows, loading: false, error: null });
      } catch (err) {
        setData({ records: [], loading: false, error: "Unable to load records." });
      }
    })();
  }, [dataApi]);

  if (loading) return <div className={styles.spinner}><Spinner label="Loading..." /></div>;
  if (error) return <Text>{error}</Text>;

  const columns = [
    createTableColumn<MyRow>({
      columnId: "name",
      compare: (a, b) => (a.name ?? "").localeCompare(b.name ?? ""),
      renderHeaderCell: () => <Text weight="bold">Name</Text>,
      renderCell: (item) => <TableCellLayout>{item.name}</TableCellLayout>,
    }),
  ];

  return (
    <div className={styles.root}>
      <Text size={500} weight="semibold">Records ({records.length})</Text>
      <DataGrid items={records} columns={columns} sortable>
        <DataGridHeader><DataGridRow>{({ renderHeaderCell }) => <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>}</DataGridRow></DataGridHeader>
        <DataGridBody<MyRow>>{({ item, rowId }) => <DataGridRow<MyRow> key={rowId}>{({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}</DataGridRow>}</DataGridBody>
      </DataGrid>
    </div>
  );
};

export default GeneratedComponent;

// =============================================================================
// DETAIL PAGE — per-record Map cache (reference pattern, not a separate component)
// =============================================================================
//
// Use this variant when the page receives a recordId via pageInput and displays
// a single record. The Map keyed by recordId allows caching multiple detail views.
//
// // IIFE re-attaches to the existing window Map on module re-eval
// const _detailCache: Map<string, MyRow> = (() => {
//     if (!(window as any).__ppMyEntityDetailCache) {
//         (window as any).__ppMyEntityDetailCache = new Map<string, MyRow>();
//     }
//     return (window as any).__ppMyEntityDetailCache;
// })();
//
// // In component:
// const recordId = pageInput?.recordId;
// const cachedRecord = recordId ? (_detailCache.get(recordId) ?? null) : null;
//
// const [{ record, loading, error }, setData] = useState({
//     record: cachedRecord, loading: !!recordId && cachedRecord === null, error: null as string | null,
// });
//
// useEffect(() => {
//     if (!dataApi || !recordId) return;
//     if (_detailCache.has(recordId)) return; // cached — no spinner
//     (async () => {
//         try {
//             const row = await dataApi.retrieveRow("myentity", { id: recordId, select: [...] });
//             _detailCache.set(recordId, row);
//             setData({ record: row, loading: false, error: null });
//         } catch (err) {
//             setData({ record: null, loading: false, error: "Unable to load record." });
//         }
//     })();
// }, [dataApi, recordId]);
