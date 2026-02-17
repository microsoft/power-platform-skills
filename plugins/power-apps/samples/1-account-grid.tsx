import React, { useState } from "react";
import { DataGrid, DataGridHeader, DataGridBody, DataGridRow, DataGridCell, DataGridHeaderCell, TableCellLayout, createTableColumn, Text, Input } from "@fluentui/react-components";

type Account = { id: string; name: string; address1_city: string; address1_stateorprovince: string; address1_postalcode: string; address1_country: string; telephone1: string; };

const sampleAccounts: Account[] = [
    { id: "1", name: "John Doe Corp", address1_city: "New York", address1_stateorprovince: "NY", address1_postalcode: "10001", address1_country: "USA", telephone1: "123-456-7890" },
    { id: "2", name: "Jane Smith LLC", address1_city: "Los Angeles", address1_stateorprovince: "CA", address1_postalcode: "90001", address1_country: "USA", telephone1: "987-654-3210" },
    { id: "3", name: "Acme Inc", address1_city: "Chicago", address1_stateorprovince: "IL", address1_postalcode: "60601", address1_country: "USA", telephone1: "555-555-5555" },
    { id: "4", name: "Globex Corporation", address1_city: "Houston", address1_stateorprovince: "TX", address1_postalcode: "77001", address1_country: "USA", telephone1: "444-444-4444" },
    { id: "5", name: "Initech", address1_city: "Phoenix", address1_stateorprovince: "AZ", address1_postalcode: "85001", address1_country: "USA", telephone1: "333-333-3333" },
];

const GeneratedComponent = () => {
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
};

export default GeneratedComponent;
