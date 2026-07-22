import { useEffect, useRef, useState } from "react";
import type {
    TableRow,
    QueryTableOptions,
    GeneratedComponentProps,
} from "./RuntimeTypes";
import {
    Badge,
    Button,
    DataGrid,
    DataGridBody,
    DataGridCell,
    DataGridHeader,
    DataGridHeaderCell,
    DataGridRow,
    Divider,
    Dropdown,
    Option,
    Spinner,
    TableCellLayout,
    Text,
    Toolbar,
    ToolbarGroup,
    createTableColumn,
    makeStyles,
    tokens,
    useId,
} from "@fluentui/react-components";
import {
    ArrowClockwiseRegular,
    CalendarRegular,
    LocationRegular,
    PersonRegular,
} from "@fluentui/react-icons";
import { DatePicker } from "@fluentui/react-datepicker-compat";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppointmentRow = TableRow<{
    activityid: string;
    subject: string;
    scheduledstart: Date;
    scheduledend: Date;
    location: string;
    statuscode: number;
    _regardingobjectid_value: string;
}>;

// Flattened shape used for display
interface DisplayRow {
    activityid: string;
    subject: string;
    scheduledstart: Date;
    scheduledend: Date;
    location: string;
    statuscode: number;
    statusLabel: string;
    candidateName: string;
    dayKey: string; // "YYYY-MM-DD"
}

// ---------------------------------------------------------------------------
// Module-level cache (survives module re-evaluation via window)
// ---------------------------------------------------------------------------

let _apptCache: DisplayRow[] | null =
    (window as any).__ppAppointmentCache ?? null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date | null | undefined): string {
    if (!d) return "";
    const dt = d instanceof Date ? d : new Date(d as unknown as string);
    if (isNaN(dt.getTime())) return "";
    return dt.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

function formatTime(d: Date | null | undefined): string {
    if (!d) return "";
    const dt = d instanceof Date ? d : new Date(d as unknown as string);
    if (isNaN(dt.getTime())) return "";
    return dt.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    });
}

function toDayKey(d: Date): string {
    const dt = d instanceof Date ? d : new Date(d as unknown as string);
    if (isNaN(dt.getTime())) return "";
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const day = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

function dayKeyToLabel(key: string): string {
    const dt = new Date(`${key}T00:00:00`);
    if (isNaN(dt.getTime())) return key;
    return dt.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
    });
}

const STATUS_LABELS: Record<number, string> = {
    1: "Free",
    2: "Tentative",
    3: "Completed",
    4: "Canceled",
    5: "Busy",
    6: "Out of Office",
};

type BadgeColor =
    | "brand"
    | "danger"
    | "important"
    | "informative"
    | "severe"
    | "subtle"
    | "success"
    | "warning";

function statusBadgeColor(statuscode: number): BadgeColor {
    switch (statuscode) {
        case 1: return "success";   // Free
        case 2: return "warning";   // Tentative
        case 3: return "informative"; // Completed
        case 4: return "danger";    // Canceled
        case 5: return "brand";     // Busy
        case 6: return "severe";    // Out of Office
        default: return "subtle";
    }
}

function toDisplayRow(row: any): DisplayRow {
    const startRaw = row["scheduledstart"];
    const endRaw = row["scheduledend"];
    const start = startRaw ? new Date(startRaw as unknown as string) : new Date(NaN);
    const end = endRaw ? new Date(endRaw as unknown as string) : new Date(NaN);
    const statuscode = (row["statuscode"] as number) ?? 0;
    const candidateName: string =
        row["_regardingobjectid_value@OData.Community.Display.V1.FormattedValue"] as string ??
        "";
    return {
        activityid: row["activityid"] as string,
        subject: (row["subject"] as string) ?? "(No subject)",
        scheduledstart: start,
        scheduledend: end,
        location: (row["location"] as string) ?? "",
        statuscode,
        statusLabel: STATUS_LABELS[statuscode] ?? String(statuscode),
        candidateName,
        dayKey: isNaN(start.getTime()) ? "" : toDayKey(start),
    };
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const useStyles = makeStyles({
    root: {
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        padding: tokens.spacingVerticalL,
        backgroundColor: tokens.colorNeutralBackground2,
        gap: tokens.spacingVerticalM,
    },
    header: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: tokens.spacingVerticalS,
    },
    filterBar: {
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-end",
        gap: tokens.spacingHorizontalM,
        padding: tokens.spacingVerticalM,
        backgroundColor: tokens.colorNeutralBackground1,
        borderRadius: tokens.borderRadiusMedium,
        boxShadow: tokens.shadow4,
    },
    filterField: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXS,
        minWidth: "160px",
        flex: "1 1 160px",
    },
    filterLabel: {
        fontSize: tokens.fontSizeBase200,
        fontWeight: tokens.fontWeightSemibold,
        color: tokens.colorNeutralForeground2,
    },
    statusDropdown: {
        minWidth: "160px",
    },
    contentArea: {
        flex: 1,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
        minHeight: 0,
    },
    dayGroup: {
        display: "flex",
        flexDirection: "column",
        backgroundColor: tokens.colorNeutralBackground1,
        borderRadius: tokens.borderRadiusMedium,
        boxShadow: tokens.shadow4,
        overflow: "hidden",
    },
    dayHeader: {
        display: "flex",
        alignItems: "center",
        gap: tokens.spacingHorizontalS,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        backgroundColor: tokens.colorBrandBackground2,
    },
    dayHeaderText: {
        fontWeight: tokens.fontWeightSemibold,
        color: tokens.colorBrandForeground2,
    },
    gridWrapper: {
        overflowX: "auto",
    },
    emptyState: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: tokens.spacingVerticalXXL,
        gap: tokens.spacingVerticalM,
        backgroundColor: tokens.colorNeutralBackground1,
        borderRadius: tokens.borderRadiusMedium,
        boxShadow: tokens.shadow4,
    },
    errorBanner: {
        padding: tokens.spacingVerticalM,
        backgroundColor: tokens.colorStatusDangerBackground1,
        borderRadius: tokens.borderRadiusMedium,
        color: tokens.colorStatusDangerForeground1,
    },
    cellText: {
        display: "block",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    badgeCell: {
        display: "flex",
        alignItems: "center",
    },
    spinnerWrapper: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: tokens.spacingVerticalXXL,
    },
});

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ statuscode, label }: { statuscode: number; label: string }) {
    return (
        <Badge color={statusBadgeColor(statuscode)} appearance="filled" shape="rounded">
            {label}
        </Badge>
    );
}

// Column definitions for a single-day grid
const gridColumns = [
    createTableColumn<DisplayRow>({
        columnId: "subject",
        compare: (a, b) => a.subject.localeCompare(b.subject),
        renderHeaderCell: () => "Subject",
        renderCell: (item) => (
            <TableCellLayout style={{ overflow: "hidden", minWidth: 0 }}>
                <span
                    title={item.subject}
                    style={{
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                    }}
                >
                    {item.subject}
                </span>
            </TableCellLayout>
        ),
    }),
    createTableColumn<DisplayRow>({
        columnId: "candidateName",
        compare: (a, b) => a.candidateName.localeCompare(b.candidateName),
        renderHeaderCell: () => (
            <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <PersonRegular />
                Candidate
            </span>
        ),
        renderCell: (item) => (
            <TableCellLayout style={{ overflow: "hidden", minWidth: 0 }}>
                <span
                    title={item.candidateName}
                    style={{
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                    }}
                >
                    {item.candidateName || "—"}
                </span>
            </TableCellLayout>
        ),
    }),
    createTableColumn<DisplayRow>({
        columnId: "scheduledstart",
        compare: (a, b) =>
            (a.scheduledstart?.getTime() ?? 0) - (b.scheduledstart?.getTime() ?? 0),
        renderHeaderCell: () => "Start",
        renderCell: (item) => (
            <TableCellLayout>
                {formatTime(item.scheduledstart)}
            </TableCellLayout>
        ),
    }),
    createTableColumn<DisplayRow>({
        columnId: "scheduledend",
        compare: (a, b) =>
            (a.scheduledend?.getTime() ?? 0) - (b.scheduledend?.getTime() ?? 0),
        renderHeaderCell: () => "End",
        renderCell: (item) => (
            <TableCellLayout>
                {formatTime(item.scheduledend)}
            </TableCellLayout>
        ),
    }),
    createTableColumn<DisplayRow>({
        columnId: "location",
        compare: (a, b) => a.location.localeCompare(b.location),
        renderHeaderCell: () => (
            <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <LocationRegular />
                Location
            </span>
        ),
        renderCell: (item) => (
            <TableCellLayout style={{ overflow: "hidden", minWidth: 0 }}>
                <span
                    title={item.location}
                    style={{
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                    }}
                >
                    {item.location || "—"}
                </span>
            </TableCellLayout>
        ),
    }),
    createTableColumn<DisplayRow>({
        columnId: "statusLabel",
        compare: (a, b) => a.statusLabel.localeCompare(b.statusLabel),
        renderHeaderCell: () => "Status",
        renderCell: (item) => (
            <TableCellLayout>
                <StatusBadge statuscode={item.statuscode} label={item.statusLabel} />
            </TableCellLayout>
        ),
    }),
];

const columnSizingOptions = {
    subject: { defaultWidth: 220, minWidth: 140 },
    candidateName: { defaultWidth: 180, minWidth: 120 },
    scheduledstart: { defaultWidth: 100, minWidth: 80 },
    scheduledend: { defaultWidth: 100, minWidth: 80 },
    location: { defaultWidth: 180, minWidth: 100 },
    statusLabel: { defaultWidth: 130, minWidth: 100 },
};

interface DayGridProps {
    dayKey: string;
    rows: DisplayRow[];
    onRowClick: (row: DisplayRow) => void;
}

function DayGrid({ dayKey, rows, onRowClick }: DayGridProps) {
    const styles = useStyles();
    return (
        <div className={styles.dayGroup} role="region" aria-label={`Interviews for ${dayKeyToLabel(dayKey)}`}>
            <div className={styles.dayHeader}>
                <CalendarRegular style={{ color: tokens.colorBrandForeground2 }} />
                <Text className={styles.dayHeaderText}>{dayKeyToLabel(dayKey)}</Text>
                <Badge appearance="outline" color="brand" shape="circular" size="small">
                    {rows.length}
                </Badge>
            </div>
            <div className={styles.gridWrapper}>
                <DataGrid
                    items={rows}
                    columns={gridColumns}
                    sortable
                    resizableColumns
                    columnSizingOptions={columnSizingOptions}
                    getRowId={(item) => item.activityid}
                    focusMode="composite"
                >
                    <DataGridHeader>
                        <DataGridRow>
                            {({ renderHeaderCell }) => (
                                <DataGridHeaderCell>
                                    <Text weight="semibold" size={200}>
                                        {renderHeaderCell()}
                                    </Text>
                                </DataGridHeaderCell>
                            )}
                        </DataGridRow>
                    </DataGridHeader>
                    <DataGridBody<DisplayRow>>
                        {({ item, rowId }) => (
                            <DataGridRow<DisplayRow>
                                key={rowId}
                                onClick={() => onRowClick(item)}
                                style={{ cursor: "pointer" }}
                                aria-label={`Interview: ${item.subject}, Candidate: ${item.candidateName}`}
                            >
                                {({ renderCell }) => (
                                    <DataGridCell>{renderCell(item)}</DataGridCell>
                                )}
                            </DataGridRow>
                        )}
                    </DataGridBody>
                </DataGrid>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Status filter options
// ---------------------------------------------------------------------------

const STATUS_OPTIONS = [
    { value: "all", label: "All statuses" },
    { value: "1", label: "Free" },
    { value: "2", label: "Tentative" },
    { value: "3", label: "Completed" },
    { value: "4", label: "Canceled" },
    { value: "5", label: "Busy" },
    { value: "6", label: "Out of Office" },
];

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput;

    const styles = useStyles();
    const startPickerMountRef = useRef<HTMLDivElement>(null);
    const endPickerMountRef = useRef<HTMLDivElement>(null);
    const startDatePickerId = useId("start-date");
    const endDatePickerId = useId("end-date");
    const statusDropdownId = useId("status-filter");

    // Default: show the next 30 days
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const defaultEnd = new Date(today);
    defaultEnd.setDate(today.getDate() + 30);

    const [{ records, loading, error }, setData] = useState<{
        records: DisplayRow[];
        loading: boolean;
        error: string | null;
    }>({
        records: _apptCache ?? [],
        loading: _apptCache === null,
        error: null,
    });

    const [startDate, setStartDate] = useState<Date | null>(today);
    const [endDate, setEndDate] = useState<Date | null>(defaultEnd);
    const [statusFilter, setStatusFilter] = useState<string>("all");

    // Fetch appointments
    useEffect(() => {
        if (!dataApi) {
            setData((prev) => ({ ...prev, loading: false }));
            return;
        }
        if (_apptCache !== null) return; // cached — no spinner
        (async () => {
            try {
                const opts: QueryTableOptions<"appointment"> = {
                    select: [
                        "activityid",
                        "subject",
                        "scheduledstart",
                        "scheduledend",
                        "location",
                        "statuscode",
                        "_regardingobjectid_value",
                    ],
                    orderBy: "scheduledstart asc",
                    pageSize: 250,
                };
                const result = await dataApi.queryTable("appointment", opts);
                const rows = result.rows.map(toDisplayRow);
                _apptCache = rows;
                (window as any).__ppAppointmentCache = rows;
                setData({ records: rows, loading: false, error: null });
            } catch (err) {
                if (_apptCache === null) {
                    setData({
                        records: [],
                        loading: false,
                        error: "Unable to load interviews. Please refresh and try again.",
                    });
                }
            }
        })();
    }, [dataApi]);

    // Navigate to appointment record
    function handleRowClick(row: DisplayRow) {
        const xrm = (window as any).Xrm;
        if (!xrm?.Navigation) return;
        xrm.Navigation.navigateTo({
            pageType: "entityrecord",
            entityName: "appointment",
            entityId: row.activityid,
        });
    }

    // Refresh handler — clears the cache and re-fetches
    function handleRefresh() {
        _apptCache = null;
        delete (window as any).__ppAppointmentCache;
        setData({ records: [], loading: true, error: null });
        if (!dataApi) {
            setData({ records: [], loading: false, error: null });
            return;
        }
        (async () => {
            try {
                const opts: QueryTableOptions<"appointment"> = {
                    select: [
                        "activityid",
                        "subject",
                        "scheduledstart",
                        "scheduledend",
                        "location",
                        "statuscode",
                        "_regardingobjectid_value",
                    ],
                    orderBy: "scheduledstart asc",
                    pageSize: 250,
                };
                const result = await dataApi.queryTable("appointment", opts);
                const rows = result.rows.map(toDisplayRow);
                _apptCache = rows;
                (window as any).__ppAppointmentCache = rows;
                setData({ records: rows, loading: false, error: null });
            } catch (err) {
                setData({
                    records: [],
                    loading: false,
                    error: "Unable to load interviews. Please refresh and try again.",
                });
            }
        })();
    }

    // Filter records
    const filteredRecords = records.filter((row) => {
        // Date range filter
        if (startDate && !isNaN(startDate.getTime())) {
            const dayStart = new Date(startDate);
            dayStart.setHours(0, 0, 0, 0);
            if (row.scheduledstart < dayStart) return false;
        }
        if (endDate && !isNaN(endDate.getTime())) {
            const dayEnd = new Date(endDate);
            dayEnd.setHours(23, 59, 59, 999);
            if (row.scheduledstart > dayEnd) return false;
        }
        // Status filter
        if (statusFilter !== "all") {
            if (String(row.statuscode) !== statusFilter) return false;
        }
        return true;
    });

    // Group by day
    const dayMap = new Map<string, DisplayRow[]>();
    for (const row of filteredRecords) {
        if (!row.dayKey) continue;
        if (!dayMap.has(row.dayKey)) dayMap.set(row.dayKey, []);
        dayMap.get(row.dayKey)!.push(row);
    }
    const sortedDays = Array.from(dayMap.keys()).sort();

    return (
        <div className={styles.root}>
            {/* Header */}
            <div className={styles.header}>
                <div>
                    <Text size={600} weight="semibold" block>
                        Interview schedule
                    </Text>
                    <Text size={300} style={{ color: tokens.colorNeutralForeground3 }}>
                        {filteredRecords.length} interview{filteredRecords.length !== 1 ? "s" : ""} shown
                    </Text>
                </div>
                <Button
                    icon={<ArrowClockwiseRegular />}
                    appearance="secondary"
                    onClick={handleRefresh}
                    aria-label="Refresh interview schedule"
                    disabled={loading}
                >
                    Refresh
                </Button>
            </div>

            {/* Filter bar */}
            <div className={styles.filterBar} role="search" aria-label="Interview filters">
                <div className={styles.filterField}>
                    <label id={startDatePickerId} className={styles.filterLabel}>
                        From date
                    </label>
                    <div ref={startPickerMountRef} />
                    <DatePicker
                        aria-labelledby={startDatePickerId}
                        placeholder="Start date"
                        value={startDate}
                        onSelectDate={(d) => setStartDate(d ?? null)}
                        mountNode={startPickerMountRef.current ?? undefined}
                    />
                </div>
                <div className={styles.filterField}>
                    <label id={endDatePickerId} className={styles.filterLabel}>
                        To date
                    </label>
                    <div ref={endPickerMountRef} />
                    <DatePicker
                        aria-labelledby={endDatePickerId}
                        placeholder="End date"
                        value={endDate}
                        onSelectDate={(d) => setEndDate(d ?? null)}
                        mountNode={endPickerMountRef.current ?? undefined}
                    />
                </div>
                <div className={styles.filterField}>
                    <label id={statusDropdownId} className={styles.filterLabel}>
                        Status
                    </label>
                    <Dropdown
                        aria-labelledby={statusDropdownId}
                        className={styles.statusDropdown}
                        value={STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label ?? "All statuses"}
                        selectedOptions={[statusFilter]}
                        onOptionSelect={(_, d) => {
                            if (d.optionValue) setStatusFilter(d.optionValue);
                        }}
                    >
                        {STATUS_OPTIONS.map((opt) => (
                            <Option key={opt.value} value={opt.value}>
                                {opt.label}
                            </Option>
                        ))}
                    </Dropdown>
                </div>
            </div>

            {/* Content */}
            <div className={styles.contentArea}>
                {loading && (
                    <div className={styles.spinnerWrapper}>
                        <Spinner
                            size="large"
                            label="Loading interviews..."
                            aria-label="Loading interviews"
                        />
                    </div>
                )}

                {!loading && error && (
                    <div className={styles.errorBanner} role="alert">
                        <Text>{error}</Text>
                    </div>
                )}

                {!loading && !error && sortedDays.length === 0 && (
                    <div className={styles.emptyState} role="status">
                        <CalendarRegular
                            style={{
                                fontSize: "48px",
                                color: tokens.colorNeutralForeground3,
                            }}
                        />
                        <Text size={400} weight="semibold">
                            No interviews found
                        </Text>
                        <Text size={300} style={{ color: tokens.colorNeutralForeground3 }}>
                            Adjust the date range or status filter to see results.
                        </Text>
                    </div>
                )}

                {!loading &&
                    !error &&
                    sortedDays.map((dayKey) => (
                        <DayGrid
                            key={dayKey}
                            dayKey={dayKey}
                            rows={dayMap.get(dayKey)!}
                            onRowClick={handleRowClick}
                        />
                    ))}
            </div>
        </div>
    );
};

export default GeneratedComponent;
