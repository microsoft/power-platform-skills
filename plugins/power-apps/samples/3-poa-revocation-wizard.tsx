import React, { useState, useRef } from "react";
import {
    Button,
    Text,
    DataGrid,
    DataGridHeader,
    DataGridBody,
    DataGridRow,
    DataGridCell,
    DataGridHeaderCell,
    TableCellLayout,
    createTableColumn,
    RadioGroup,
    Radio,
    ProgressBar,
    tokens,
} from "@fluentui/react-components";

// Mock data for POA records and accounts
const poaRecords = [
    { id: "1", name: "John Doe POA", type: "General", createdDate: "2023-01-01" },
    { id: "2", name: "Jane Smith POA", type: "Limited", createdDate: "2022-12-15" },
];

const accounts = [
    { id: "1", accountName: "Checking Account", access: "Active" },
    { id: "2", accountName: "Savings Account", access: "Active" },
];

// ** WizardContainer ** //
const GeneratedComponent = () => {
    const [currentStep, setCurrentStep] = useState(0); // Tracks the current step
    const [selectedPOARecord, setSelectedPOARecord] = useState<any>(null); // Stores selected POA record
    const [uploadedFiles, setUploadedFiles] = useState<File[]>([]); // Stores uploaded files
    const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]); // Stores selected accounts
    const [complianceConfirmation, setComplianceConfirmation] = useState<string>(""); // Stores compliance confirmation

    const steps = [
        {
            content: (
                <SearchPOARecordStep
                    poaRecords={poaRecords}
                    selectedPOARecord={selectedPOARecord}
                    setSelectedPOARecord={setSelectedPOARecord}
                />
            ),
        },
        {
            content: (
                <DocumentationUploadStep
                    uploadedFiles={uploadedFiles}
                    setUploadedFiles={setUploadedFiles}
                />
            ),
        },
        {
            content: (
                <AccountAccessRemovalStep
                    accounts={accounts}
                    selectedAccounts={selectedAccounts}
                    setSelectedAccounts={setSelectedAccounts}
                />
            ),
        },
        {
            content: (
                <ComplianceReviewStep
                    complianceConfirmation={complianceConfirmation}
                    setComplianceConfirmation={setComplianceConfirmation}
                />
            ),
        },
        {
            content: <ConfirmationStep />,
        },
    ];

    const totalSteps = steps.length;
    const progress = (currentStep + 1) / totalSteps; // Calculate progress

    const handleNext = () => setCurrentStep((prevStep) => prevStep + 1);
    const handleBack = () => setCurrentStep((prevStep) => prevStep - 1);

    return (
        <div style={{ width: "100%", height: "100%", padding: "20px", boxSizing: "border-box", display: "flex", flexDirection: "column" }}>
            {/* Progress bar */}
            <ProgressBar value={progress} thickness="large" shape="rounded" style={{ marginBottom: "20px" }} />
            {/* Wizard content */}
            <div
                style={{
                    flex: 1,
                    marginTop: "20px",
                    padding: "20px",
                    borderRadius: tokens.borderRadiusMedium,
                    boxShadow: "0 2px 4px rgba(0, 0, 0, 0.1)",
                    overflowY: "auto"
                }}
            >
                {steps[currentStep].content}
            </div>
            {/* Navigation buttons */}
            <div style={{ marginTop: "20px", display: "flex", justifyContent: "space-between" }}>
                <Button appearance="secondary" disabled={currentStep === 0} onClick={handleBack}>
                    Back
                </Button>
                {currentStep < steps.length - 1 ? (
                    <Button appearance="primary" onClick={handleNext}>
                        Next
                    </Button>
                ) : null}
            </div>
        </div>
    );
};

// ** SearchPOARecordStep ** //
const SearchPOARecordStep = ({
    poaRecords,
    selectedPOARecord,
    setSelectedPOARecord,
}: {
    poaRecords: any[];
    selectedPOARecord: any;
    setSelectedPOARecord: (record: any) => void;
}) => {
    const columns = [
        createTableColumn({
            columnId: "name",
            renderHeaderCell: () => "POA Name",
            renderCell: (item) => <TableCellLayout>{item.name}</TableCellLayout>,
        }),
        createTableColumn({
            columnId: "type",
            renderHeaderCell: () => "Type",
            renderCell: (item) => <TableCellLayout>{item.type}</TableCellLayout>,
        }),
        createTableColumn({
            columnId: "createdDate",
            renderHeaderCell: () => "Created Date",
            renderCell: (item) => <TableCellLayout>{item.createdDate}</TableCellLayout>,
        }),
    ];
    return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
            <Text size={400} block>
                Select a POA record to revoke:
            </Text>
            <DataGrid
                items={poaRecords}
                columns={columns}
                selectionMode="single"
                aria-label="POA Records Table"
                onRowClick={(e, data) => setSelectedPOARecord(data.item)}
            >
                <DataGridHeader>
                    <DataGridRow>
                        {({ renderHeaderCell }) => (
                            <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
                        )}
                    </DataGridRow>
                </DataGridHeader>
                <DataGridBody>
                    {({ item }) => (
                        <DataGridRow key={item.id}>
                            {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
                        </DataGridRow>
                    )}
                </DataGridBody>
            </DataGrid>
        </div>
    );
};

// ** DocumentationUploadStep ** //
const DocumentationUploadStep = ({
    uploadedFiles,
    setUploadedFiles,
}: {
    uploadedFiles: File[];
    setUploadedFiles: (files: File[]) => void;
}) => {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        if (event.target.files) {
            setUploadedFiles([...uploadedFiles, ...Array.from(event.target.files)]);
        }
    };

    const handleFileRemove = (fileName: string) => {
        const updatedFiles = uploadedFiles.filter((file) => file.name !== fileName);
        setUploadedFiles(updatedFiles);
    };

    const handleButtonClick = () => {
        fileInputRef.current?.click();
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <Text size={400} block>
                Upload revocation documentation:
            </Text>
            <div
                style={{
                    padding: "10px",
                    border: "1px solid #ddd",
                    borderRadius: tokens.borderRadiusMedium,
                    backgroundColor: "#f9f9f9",
                    textAlign: "center",
                }}
            >
                <input
                    type="file"
                    multiple
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                    style={{ display: "none" }}
                />
                <Button appearance="primary" onClick={handleButtonClick}>
                    Upload Files
                </Button>
            </div>
            {uploadedFiles.length > 0 && (
                <div style={{ padding: "10px", border: "1px solid #ddd", borderRadius: tokens.borderRadiusMedium }}>
                    <Text size={400} weight="semibold" block>
                        Uploaded Files:
                    </Text>
                    {uploadedFiles.map((file, index) => (
                        <div key={index} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <Text size={300}>{file.name}</Text>
                            <Button appearance="subtle" onClick={() => handleFileRemove(file.name)} style={{ marginLeft: "10px" }}>
                                Remove
                            </Button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// ** AccountAccessRemovalStep ** //
const AccountAccessRemovalStep = ({
    accounts,
    selectedAccounts,
    setSelectedAccounts,
}: {
    accounts: any[];
    selectedAccounts: string[];
    setSelectedAccounts: (ids: string[]) => void;
}) => {
    const columns = [
        createTableColumn({
            columnId: "accountName",
            renderHeaderCell: () => "Account Name",
            renderCell: (item) => <TableCellLayout>{item.accountName}</TableCellLayout>,
        }),
        createTableColumn({
            columnId: "access",
            renderHeaderCell: () => "Access",
            renderCell: (item) => <TableCellLayout>{item.access}</TableCellLayout>,
        }),
    ];
    return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
            <Text size={400} block>
                Remove POA authority from designated accounts:
            </Text>
            <DataGrid
                items={accounts}
                columns={columns}
                selectionMode="multiselect"
                aria-label="Accounts Table"
                onSelectionChange={(e, data) => setSelectedAccounts([...data.selectedItems] as string[])}
            >
                <DataGridHeader>
                    <DataGridRow>
                        {({ renderHeaderCell }) => (
                            <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
                        )}
                    </DataGridRow>
                </DataGridHeader>
                <DataGridBody>
                    {({ item }) => (
                        <DataGridRow key={item.id}>
                            {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
                        </DataGridRow>
                    )}
                </DataGridBody>
            </DataGrid>
        </div>
    );
};

// ** ComplianceReviewStep ** //
const ComplianceReviewStep = ({
    complianceConfirmation,
    setComplianceConfirmation,
}: {
    complianceConfirmation: string;
    setComplianceConfirmation: (val: string) => void;
}) => (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
        <Text size={400} block>
            Confirm compliance with legal requirements:
        </Text>
        <RadioGroup
            value={complianceConfirmation}
            onChange={(e, data) => setComplianceConfirmation(data.value)}
        >
            <Radio value="yes" label="Yes" />
            <Radio value="no" label="No" />
        </RadioGroup>
    </div>
);

// ** ConfirmationStep ** //
const ConfirmationStep = () => (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
        <Text size={400} block>
            Revocation complete! Notifications sent and audit logs updated.
        </Text>
    </div>
);

export default GeneratedComponent;
