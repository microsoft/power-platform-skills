import React, { useRef, useState } from "react";
import { Button, Text, tokens, MessageBar, MessageBarBody } from "@fluentui/react-components";

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
const PAGE_NAME = 'File Upload';

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

// Mock page: no RuntimeTypes import (not generated for mock pages), so it declares its own props.
type Props = { dataApi?: unknown; pageInput?: { id?: string } };

function PageBody(props: Props) {
    const { pageInput } = props;
    void pageInput;
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
}

const GeneratedComponent = (props: Props) => (
    <PageErrorBoundary>
        <PageBody {...props} />
    </PageErrorBoundary>
);

export default GeneratedComponent;
