import React, { useEffect, useState } from "react";
import {
    Button,
    Input,
    Text,
    DataGrid,
    DataGridHeader,
    DataGridBody,
    DataGridRow,
    DataGridCell,
    DataGridHeaderCell,
    TableCellLayout,
    createTableColumn,
} from "@fluentui/react-components";
import type {
    GeneratedComponentProps,
    account,
    ReadableTableRow,
    WritableTableRow,
    QueryTableOptions,
} from "./RuntimeTypes";

// Module-level key aliases — VALUES live on `window` (single source of truth) so
// they survive the host double-mount on open and back-navigation, and stay
// coherent across module re-evaluation. See references/data-caching.md.
const CACHE_KEY = "__ppAccountCrud_accountCache";
const INFLIGHT_KEY = "__ppAccountCrud_accountInflight";
const winAny = window as unknown as Record<string, unknown>;

const GeneratedComponent = ({ dataApi }: GeneratedComponentProps) => {
    const dataReady = !!dataApi;
    const [accounts, setAccounts] = useState<ReadableTableRow<account>[]>(
        () => (winAny[CACHE_KEY] as ReadableTableRow<account>[] | undefined) ?? [],
    );
    // Gate mutations until the initial load resolves so a create/update can't race
    // an in-flight first fetch (which could otherwise stale-write the cache).
    const [loading, setLoading] = useState<boolean>(
        () => (winAny[CACHE_KEY] as ReadableTableRow<account>[] | undefined) === undefined,
    );
    const [selectedAccount, setSelectedAccount] = useState<ReadableTableRow<account> | null>(null);
    const [formData, setFormData] = useState<WritableTableRow<account>>({
        name: "",
        address1_city: "",
        address1_stateorprovince: "",
        address1_postalcode: "",
        address1_country: "",
        telephone1: "",
    });

    // Fetch accounts from Dataverse (de-duped against the host double-mount)
    useEffect(() => {
        if (!dataReady) return;

        // Authoritative window cache — sync on a hit so a mount that renders while
        // another mount's fetch is resolving doesn't stay stuck on the old list.
        const cached = winAny[CACHE_KEY] as ReadableTableRow<account>[] | undefined;
        if (cached !== undefined) {
            if (accounts !== cached) setAccounts(cached);
            if (loading) setLoading(false);
            return;
        }
        let cancelled = false;

        let inflight = winAny[INFLIGHT_KEY] as Promise<ReadableTableRow<account>[]> | undefined;
        if (!inflight) {
            const query: QueryTableOptions<account> = {
                select: ["name", "address1_city", "address1_stateorprovince", "address1_postalcode", "address1_country", "telephone1", "accountid"],
                pageSize: 50,
                orderBy: "name asc",
            };
            inflight = dataApi
                .queryTable("account", query)
                .then((result) => {
                    winAny[CACHE_KEY] = result.rows;
                    return result.rows;
                })
                // Clear only if still ours — a concurrent refresh may have replaced it.
                .finally(() => { if (winAny[INFLIGHT_KEY] === inflight) delete winAny[INFLIGHT_KEY]; });
            winAny[INFLIGHT_KEY] = inflight;
        }

        inflight
            .then((rows) => { if (!cancelled) { setAccounts(rows); setLoading(false); } })
            .catch((err) => { if (!cancelled) { console.error("Failed to load accounts", err); setLoading(false); } });

        return () => { cancelled = true; };
        // Readiness only — never `dataApi` (new ref each render). See Rule 15.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady]);

    const handleInputChange = (field: keyof WritableTableRow<account>, value: string) => {
        setFormData((prev) => ({ ...prev, [field]: value }));
    };

    const handleAddOrUpdate = async () => {
        if (loading) return;   // don't mutate while the initial load is still in flight
        if (selectedAccount) {
            await dataApi.updateRow("account", selectedAccount.accountid, formData);
        } else {
            await dataApi.createRow("account", formData);
        }
        // Refresh list — write through the cache and clear any in-flight fetch so
        // a later mount stays in sync.
        const query: QueryTableOptions<account> = {
            select: ["name", "address1_city", "address1_stateorprovince", "address1_postalcode", "address1_country", "telephone1", "accountid"],
            pageSize: 50,
            orderBy: "name asc",
        };
        delete winAny[INFLIGHT_KEY];
        const result = await dataApi.queryTable("account", query);
        winAny[CACHE_KEY] = result.rows;
        setAccounts(result.rows);
        // Reset form
        setFormData({
            name: "",
            address1_city: "",
            address1_stateorprovince: "",
            address1_postalcode: "",
            address1_country: "",
            telephone1: "",
        });
        setSelectedAccount(null);
    };

    const handleRowSelect = (account: ReadableTableRow<account>) => {
        setSelectedAccount(account);
        setFormData({
            name: account.name || "",
            address1_city: account.address1_city || "",
            address1_stateorprovince: account.address1_stateorprovince || "",
            address1_postalcode: account.address1_postalcode || "",
            address1_country: account.address1_country || "",
            telephone1: account.telephone1 || "",
        });
    };

    const columns = [
        createTableColumn<ReadableTableRow<account>>({
            columnId: "name",
            renderHeaderCell: () => "Account Name",
            renderCell: (item) => <TableCellLayout>{item.name}</TableCellLayout>,
        }),
        createTableColumn<ReadableTableRow<account>>({
            columnId: "address1_city",
            renderHeaderCell: () => "City",
            renderCell: (item) => <TableCellLayout>{item.address1_city}</TableCellLayout>,
        }),
        createTableColumn<ReadableTableRow<account>>({
            columnId: "address1_stateorprovince",
            renderHeaderCell: () => "State",
            renderCell: (item) => <TableCellLayout>{item.address1_stateorprovince}</TableCellLayout>,
        }),
        createTableColumn<ReadableTableRow<account>>({
            columnId: "address1_postalcode",
            renderHeaderCell: () => "Zip",
            renderCell: (item) => <TableCellLayout>{item.address1_postalcode}</TableCellLayout>,
        }),
        createTableColumn<ReadableTableRow<account>>({
            columnId: "address1_country",
            renderHeaderCell: () => "Country",
            renderCell: (item) => <TableCellLayout>{item.address1_country}</TableCellLayout>,
        }),
        createTableColumn<ReadableTableRow<account>>({
            columnId: "telephone1",
            renderHeaderCell: () => "Phone",
            renderCell: (item) => <TableCellLayout>{item.telephone1}</TableCellLayout>,
        }),
    ];

    return (
        <div style={{ width: "100%", margin: "0 auto", minHeight: "100%", display: "flex", flexDirection: "column", boxSizing: "border-box", padding: "10px" }}>
            {/* Header */}
            <header style={{ padding: "10px", textAlign: "center" }}>
                <Text as="h1" size={800} weight="semibold">
                    Accounts List
                </Text>
            </header>

            {/* Content */}
            <div
                style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "row",
                    alignItems: "flex-start",
                    gap: "20px",
                    padding: "10px",
                    flexWrap: "wrap",
                }}
            >
                {/* Form */}
                <section style={{ flex: "1 1 300px", minWidth: "280px", display: "flex", flexDirection: "column", gap: "8px" }} aria-label="Account form section">
                    <Text as="h2" size={500} block weight="semibold">
                        Account Form
                    </Text>
                    <Input aria-label="Account Name" placeholder="Enter account name" value={formData.name || ""} onChange={(e, data) => handleInputChange("name", data.value)} />
                    <Input aria-label="City" placeholder="Enter city" value={formData.address1_city || ""} onChange={(e, data) => handleInputChange("address1_city", data.value)} />
                    <Input aria-label="State" placeholder="Enter state" value={formData.address1_stateorprovince || ""} onChange={(e, data) => handleInputChange("address1_stateorprovince", data.value)} />
                    <Input aria-label="Zip" placeholder="Enter zip code" value={formData.address1_postalcode || ""} onChange={(e, data) => handleInputChange("address1_postalcode", data.value)} />
                    <Input aria-label="Country" placeholder="Enter country" value={formData.address1_country || ""} onChange={(e, data) => handleInputChange("address1_country", data.value)} />
                    <Input aria-label="Phone" placeholder="Enter phone number" value={formData.telephone1 || ""} onChange={(e, data) => handleInputChange("telephone1", data.value)} />
                    <Button style={{ width: "100%", marginTop: "12px" }} appearance="primary" onClick={handleAddOrUpdate} disabled={loading}>
                        {selectedAccount ? "Update Account" : "Add Account"}
                    </Button>
                </section>

                {/* Grid */}
                <section style={{ flex: "2 1 400px", minWidth: "300px", display: "flex", flexDirection: "column" }} aria-label="Accounts data grid section">
                    <div style={{ flex: 1, minHeight: 0 }}>
                        <DataGrid
                            items={accounts}
                            columns={columns}
                            selectionMode="single"
                            aria-label="Accounts data grid"
                            style={{ height: "100%" }}
                            onRowClick={(e, data) => handleRowSelect(data.item)}
                        >
                            <DataGridHeader>
                                <DataGridRow>
                                    {({ renderHeaderCell }) => (
                                        <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
                                    )}
                                </DataGridRow>
                            </DataGridHeader>
                            <DataGridBody<ReadableTableRow<account>>>
                                {({ item }) => (
                                    <DataGridRow key={item.accountid}>
                                        {({ renderCell }) => (
                                            <DataGridCell>{renderCell(item)}</DataGridCell>
                                        )}
                                    </DataGridRow>
                                )}
                            </DataGridBody>
                        </DataGrid>
                    </div>
                </section>
            </div>
        </div>
    );
};

export default GeneratedComponent;
