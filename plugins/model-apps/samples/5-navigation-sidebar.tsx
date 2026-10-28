import React, { useState } from 'react';
import { Button, Text, tokens, MessageBar, MessageBarBody } from '@fluentui/react-components';

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
const PAGE_NAME = 'Navigation Sidebar';

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

const sections = ['Home', 'About', 'Contact'];
const subsectionsMap: Record<string, string[]> = {
    Home: ['Home Subsection 1', 'Home Subsection 2', 'Home Subsection 3'],
    About: ['About Subsection 1', 'About Subsection 2', 'About Subsection 3'],
    Contact: ['Contact Subsection 1', 'Contact Subsection 2', 'Contact Subsection 3'],
};

// Mock page: no RuntimeTypes import (not generated for mock pages), so it declares its own props.
type Props = { dataApi?: unknown; pageInput?: { id?: string } };

function PageBody(props: Props) {
    const { pageInput } = props;
    void pageInput;
    const [activeSection, setActiveSection] = useState('Home');
    const [activeSubsection, setActiveSubsection] = useState('');

    const renderContent = () => {
        if (activeSubsection) return <Text size={400}>You are viewing: {activeSubsection}</Text>;
        switch (activeSection) {
            case 'Home':
                return <Text size={400}>Welcome to the Home Page!</Text>;
            case 'About':
                return <Text size={400}>Learn more about us on the About Page.</Text>;
            case 'Contact':
                return <Text size={400}>Reach out to us via the Contact Page.</Text>;
            default:
                return null;
        }
    };

    const renderLeftNav = () => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {subsectionsMap[activeSection]?.map((sub) => (
                <Button
                    key={sub}
                    appearance="subtle"
                    onClick={() => setActiveSubsection(sub)}
                    style={{ justifyContent: 'flex-start' }}
                >
                    {sub}
                </Button>
            ))}
        </div>
    );

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
            <style>
                {`
          @media (max-width: 768px) {
            .main-content { flex-direction: column; }
            .sidebar { width: 100%; flex-direction: row; overflow-x: auto; }
          }
        `}
            </style>
            {/* Navbar */}
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    backgroundColor: '#0078D4',
                    padding: '10px 20px',
                    color: 'white',
                    height: '60px',
                    boxSizing: 'border-box',
                }}
            >
                <Text size={600} weight="semibold" style={{ color: 'white' }}>
                    Website Title
                </Text>
                <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                    {sections.map((sec) => (
                        <Button
                            key={sec}
                            appearance="transparent"
                            style={{ color: 'white' }}
                            onClick={() => {
                                setActiveSection(sec);
                                setActiveSubsection('');
                            }}
                        >
                            {sec}
                        </Button>
                    ))}
                </div>
            </div>
            {/* Main Content Area */}
            <div className="main-content" style={{ flex: 1, display: 'flex', boxSizing: 'border-box' }}>
                {/* Left Sidebar */}
                <div
                    className="sidebar"
                    style={{
                        width: '200px',
                        backgroundColor: '#F3F2F1',
                        padding: '20px',
                        boxSizing: 'border-box',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                    }}
                >
                    {renderLeftNav()}
                </div>
                {/* Content Area */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '20px' }}>
                    <div
                        style={{
                            backgroundColor: '#E1DFDD',
                            padding: '20px',
                            borderRadius: tokens.borderRadiusMedium,
                            marginBottom: '20px',
                            boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)',
                        }}
                    >
                        <Text size={500} weight="semibold">
                            {activeSubsection || activeSection}
                        </Text>
                    </div>
                    <div
                        style={{
                            flex: 1,
                            padding: '20px',
                            borderRadius: tokens.borderRadiusMedium,
                            boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)',
                            backgroundColor: '#FFFFFF',
                            display: 'flex',
                            justifyContent: 'center',
                            alignItems: 'center',
                            textAlign: 'center',
                        }}
                    >
                        {renderContent()}
                    </div>
                </div>
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
