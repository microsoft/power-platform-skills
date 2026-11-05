import React from 'react';
import { makeStyles, tokens, Button, Text, Caption1, Subtitle1, Body1, mergeClasses, Card, CardHeader, useId, MessageBar, MessageBarBody } from '@fluentui/react-components';
import { MoreHorizontalRegular } from '@fluentui/react-icons';

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
const PAGE_NAME = 'Responsive Cards';

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

const useStyles = makeStyles({
    container: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXL, padding: tokens.spacingHorizontalM, width: '100%', boxSizing: 'border-box', '@media (max-width: 768px)': { padding: tokens.spacingHorizontalS } },
    cardsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: tokens.spacingVerticalL, width: '100%', '@media (max-width: 768px)': { gridTemplateColumns: '1fr', gap: tokens.spacingVerticalM } },
    card: { width: '100%', maxWidth: '480px', height: 'fit-content', cursor: 'pointer', transition: 'transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out', '&:hover': { transform: 'translateY(-2px)', boxShadow: tokens.shadow8 }, '&:focus-visible': { outline: `2px solid ${tokens.colorBrandBackground}`, outlineOffset: '2px' }, '@media (max-width: 768px)': { maxWidth: '100%' } },
    sectionHeader: { marginBottom: tokens.spacingVerticalM },
    sectionTitle: { marginBottom: tokens.spacingVerticalXS, display: 'block' },
    sectionDescription: { color: tokens.colorNeutralForeground2, marginBottom: tokens.spacingVerticalM, display: 'block' },
    cardContent: { padding: tokens.spacingHorizontalM, lineHeight: tokens.lineHeightBase300 },
    logo: { borderRadius: tokens.borderRadiusSmall, width: '48px', height: '48px', backgroundColor: tokens.colorNeutralBackground3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px' },
    cardHeader: { margin: 0, fontWeight: tokens.fontWeightSemibold },
    cardCaption: { color: tokens.colorNeutralForeground3, display: 'block' },
});

const SectionHeader: React.FC<{ title: string; description: string; titleId: string; descriptionId: string; }> = ({ title, description, titleId, descriptionId }) => {
    const styles = useStyles();
    return (
        <header className={styles.sectionHeader}>
            <Subtitle1 as="h2" id={titleId} className={styles.sectionTitle} block>{title}</Subtitle1>
            <Body1 as="p" id={descriptionId} className={styles.sectionDescription} block>{description}</Body1>
        </header>
    );
};

const ResponsiveCard: React.FC<{ appearance?: 'filled' | 'filled-alternative' | 'outline' | 'subtle'; className?: string; 'aria-labelledby'?: string; 'aria-describedby'?: string; }> = ({ appearance = 'filled', className, 'aria-labelledby': ariaLabelledBy, 'aria-describedby': ariaDescribedBy }) => {
    const styles = useStyles(); const cardId = useId('card');
    const handleCardClick = React.useCallback(() => { console.log('Card clicked - navigate or perform action'); }, []);
    const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCardClick(); } }, [handleCardClick]);
    return (
        <Card appearance={appearance} className={mergeClasses(styles.card, className)} onClick={handleCardClick} onKeyDown={handleKeyDown} tabIndex={0} role="button" aria-labelledby={ariaLabelledBy} aria-describedby={ariaDescribedBy} id={cardId}>
            <CardHeader image={<div className={styles.logo} role="img" aria-label="Application logo">📱</div>} header={<Text as="h3" className={styles.cardHeader} block>Mobile App</Text>} description={<Caption1 className={styles.cardCaption} block>Development Team</Caption1>} action={<Button appearance="transparent" icon={<MoreHorizontalRegular />} aria-label="More options for Mobile App" onClick={(e) => { e.stopPropagation(); console.log('More options clicked'); }} />} />
            <div className={styles.cardContent}><Text block>A comprehensive mobile application that provides seamless user experience across all devices with responsive design and accessibility features built-in.</Text></div>
        </Card>
    );
};

// Mock page: no RuntimeTypes import (not generated for mock pages), so it declares its own props.
type Props = { dataApi?: unknown; pageInput?: { id?: string } };

function PageBody(props: Props) {
    const { pageInput } = props;
    void pageInput;
    const styles = useStyles();
    const sections = [
        { id: 'filled', title: 'Filled Cards (Default)', description: 'Standard card style with filled background. Use for most card designs with clear visual separation.', appearance: 'filled' as const },
        { id: 'filled-alt', title: 'Filled Alternative', description: 'Enhanced contrast for light backgrounds. Ensures adequate visual distinction on white or gray surfaces.', appearance: 'filled-alternative' as const },
        { id: 'outline', title: 'Outline Cards', description: 'Bordered cards without background fill. Perfect when you need definition without heavy visual weight.', appearance: 'outline' as const },
        { id: 'subtle', title: 'Subtle Cards', description: 'Minimal styling with hover states. Ideal for clean layouts where content takes priority.', appearance: 'subtle' as const }
    ];
    return (
        <div className={styles.container}>
            <Subtitle1 as="h1" block>Responsive Card Components</Subtitle1>
            {sections.map(s => {
                const titleId = useId(`${s.id}-title`), descriptionId = useId(`${s.id}-description`);
                return (
                    <section key={s.id} aria-labelledby={titleId} aria-describedby={descriptionId}>
                        <SectionHeader title={s.title} description={s.description} titleId={titleId} descriptionId={descriptionId} />
                        <div className={styles.cardsGrid}><ResponsiveCard appearance={s.appearance} aria-labelledby={titleId} aria-describedby={descriptionId} /></div>
                    </section>
                );
            })}
        </div>
    );
}

const GeneratedComponent = (props: Props) => (
    <PageErrorBoundary>
        <PageBody {...props} />
    </PageErrorBoundary>
);

export default GeneratedComponent;
