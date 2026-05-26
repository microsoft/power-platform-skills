import React, { useRef, useState } from "react";
import { Button, Text, tokens } from "@fluentui/react-components";

const GeneratedComponent = () => {
    const fileInputRef = useRef<HTMLInputElement>(null); // Ref for hidden file input
    const [uploadedFiles, setUploadedFiles] = useState<File[]>([]); // State for uploaded files

    const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        if (event.target.files) {
            setUploadedFiles((prevFiles) => [...prevFiles, ...Array.from(event.target.files)]);
        }
    };

    const handleFileRemove = (fileName: string) => {
        setUploadedFiles((prevFiles) => prevFiles.filter((file) => file.name !== fileName));
    };

    const handleButtonClick = () => {
        fileInputRef.current?.click();
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <Text size={400} block>
                Upload revocation documentation:
            </Text>

            {/* Upload Button */}
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

            {/* Uploaded Files List */}
            {uploadedFiles.length > 0 && (
                <div style={{ padding: "10px", border: "1px solid #ddd", borderRadius: tokens.borderRadiusMedium }}>
                    <Text size={400} weight="semibold" block>
                        Uploaded Files:
                    </Text>
                    {uploadedFiles.map((file, index) => (
                        <div
                            key={index}
                            style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                marginTop: "8px",
                            }}
                        >
                            <Text size={300}>{file.name}</Text>
                            <Button
                                appearance="subtle"
                                onClick={() => handleFileRemove(file.name)}
                                style={{ marginLeft: "10px" }}
                            >
                                Remove
                            </Button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default GeneratedComponent;
