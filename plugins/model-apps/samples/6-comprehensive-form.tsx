import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Checkbox, Combobox, Field, Input, makeStyles, Option, Radio, RadioGroup, Slider, SpinButton, Switch, Textarea, tokens, Button, Text, Caption1, Subtitle1, Body1, MessageBar, useId as useFluentId, mergeClasses, MessageBarBody } from "@fluentui/react-components";
import { DatePicker } from "@fluentui/react-datepicker-compat";
import { TimePicker } from "@fluentui/react-timepicker-compat";
import { CheckmarkCircleFilled, ErrorCircleFilled } from "@fluentui/react-icons";

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
const PAGE_NAME = 'User Information Form';

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
    container: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXL, padding: tokens.spacingHorizontalM, maxWidth: "800px", margin: "0 auto", width: "100%", boxSizing: "border-box", height: '100%', overflowY: 'auto', "@media (max-width: 768px)": { padding: tokens.spacingHorizontalS, gap: tokens.spacingVerticalL }, "@media (max-width: 480px)": { padding: tokens.spacingHorizontalXS } },
    formSection: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL, padding: tokens.spacingHorizontalL, borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1, "@media (max-width: 768px)": { padding: tokens.spacingHorizontalM }, "@media (max-width: 480px)": { padding: tokens.spacingHorizontalS } },
    sectionHeader: { marginBottom: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalS, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
    formGrid: { display: "grid", gridTemplateColumns: "1fr", gap: tokens.spacingVerticalL, width: "100%" },
    twoColumnGrid: { gridTemplateColumns: "1fr 1fr", gap: tokens.spacingHorizontalL, "@media (max-width: 768px)": { gridTemplateColumns: "1fr", gap: tokens.spacingVerticalL } },
    radioGroupContainer: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
    radioGroupHorizontal: { flexDirection: "row", flexWrap: "wrap", gap: tokens.spacingHorizontalL, "@media (max-width: 768px)": { flexDirection: "column", gap: tokens.spacingVerticalS } },
    sliderContainer: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, width: "100%" },
    sliderValue: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200, textAlign: "right" },
    buttonGroup: { display: "flex", gap: tokens.spacingHorizontalM, justifyContent: "flex-end", alignItems: "center", marginTop: tokens.spacingVerticalL, paddingTop: tokens.spacingVerticalM, borderTop: `1px solid ${tokens.colorNeutralStroke2}`, "@media (max-width: 768px)": { flexDirection: "column-reverse", gap: tokens.spacingVerticalS } },
    messageContainer: { marginBottom: tokens.spacingVerticalM },
    validationSummary: { padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusSmall, backgroundColor: tokens.colorPaletteRedBackground1, border: `1px solid ${tokens.colorPaletteRedBorder1}` },
    comboboxListbox: { backgroundColor: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke1}` },
    datePicker: { width: "100%" }
});

interface FormData { textInput: string; textArea: string; comboboxValue: string; spinButtonValue: number; checkboxChecked: boolean; sliderValue: number; switchEnabled: boolean; radioSelection: string; email: string; phone: string; dateOfBirth: Date | null; preferredContactTime: string; }
interface ValidationErrors { [key: string]: string; }
interface FormSectionProps { title: string; description?: string; children: React.ReactNode; titleId: string; descriptionId?: string; }

const FormSection: React.FC<FormSectionProps> = ({ title, description, children, titleId, descriptionId }) => {
    const styles = useStyles();
    return (
        <section className={styles.formSection} aria-labelledby={titleId} aria-describedby={descriptionId}>
            <header className={styles.sectionHeader}>
                <Subtitle1 as="h2" block>{title}</Subtitle1>
                {description && <Body1 id={descriptionId} style={{ color: tokens.colorNeutralForeground2 }} block>{description}</Body1>}
            </header>
            {children}
        </section>
    );
};

// Mock page: no RuntimeTypes import (not generated for mock pages), so it declares its own props.
type Props = { dataApi?: unknown; pageInput?: { id?: string } };

function PageBody(props: Props) {
    const { pageInput } = props;
    void pageInput;
    const styles = useStyles();
    const containerRef = useRef<HTMLDivElement>(null);
    const [formData, setFormData] = useState<FormData>({ textInput: "", textArea: "", comboboxValue: "", spinButtonValue: 0, checkboxChecked: false, sliderValue: 25, switchEnabled: false, radioSelection: "", email: "", phone: "", dateOfBirth: null, preferredContactTime: "" });
    const [errors, setErrors] = useState<ValidationErrors>({});
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitMessage, setSubmitMessage] = useState<{ type: "success" | "error"; content: string } | null>(null);
    const basicInfoTitleId = useFluentId('basic-info-title'), basicInfoDescId = useFluentId('basic-info-desc'), contactTitleId = useFluentId('contact-title'), contactDescId = useFluentId('contact-desc'), preferencesTitleId = useFluentId('preferences-title'), preferencesDescId = useFluentId('preferences-desc');
    const [mountNode, setMountNode] = useState<HTMLElement | null>(null);

    const validateForm = useCallback((): ValidationErrors => {
        const newErrors: ValidationErrors = {};
        if (!formData.textInput.trim()) newErrors.textInput = "Name is required"; else if (formData.textInput.length < 2) newErrors.textInput = "Name must be at least 2 characters";
        if (!formData.email.trim()) newErrors.email = "Email is required"; else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) newErrors.email = "Please enter a valid email address";
        if (!formData.phone.trim()) newErrors.phone = "Phone number is required"; else if (!/^\+?[\d\s\-\(\)]{10,}$/.test(formData.phone)) newErrors.phone = "Please enter a valid phone number";
        if (!formData.radioSelection) newErrors.radioSelection = "Please select a contact preference";
        if (formData.textArea.length > 500) newErrors.textArea = "Message must be 500 characters or less";
        if (!formData.dateOfBirth) newErrors.dateOfBirth = "Date of birth is required";
        else if (formData.dateOfBirth > new Date()) newErrors.dateOfBirth = "Date of birth cannot be in the future";
        else if (formData.dateOfBirth < new Date(1900, 0, 1)) newErrors.dateOfBirth = "Please enter a valid date of birth";
        return newErrors;
    }, [formData]);

    useEffect(() => { setErrors(validateForm()); }, [formData, validateForm]);
    const updateField = useCallback((field: keyof FormData, value: any) => { setFormData(prev => ({ ...prev, [field]: value })); if (submitMessage) setSubmitMessage(null); }, [submitMessage]);

    const handleSubmit = useCallback(async () => {
        const validationErrors = validateForm();
        if (Object.keys(validationErrors).length > 0) { setErrors(validationErrors); setSubmitMessage({ type: "error", content: "Please correct the errors below before submitting." }); const firstErrorField = Object.keys(validationErrors)[0]; const errorElement = document.querySelector(`[data-field="${firstErrorField}"]`) as HTMLElement; errorElement?.focus(); return; }
        setIsSubmitting(true);
        try { await new Promise(resolve => setTimeout(resolve, 2000)); setSubmitMessage({ type: "success", content: "Form submitted successfully! Thank you for your information." }); setFormData({ textInput: "", textArea: "", comboboxValue: "", spinButtonValue: 0, checkboxChecked: false, sliderValue: 25, switchEnabled: false, radioSelection: "", email: "", phone: "", dateOfBirth: null, preferredContactTime: "" }); }
        catch { setSubmitMessage({ type: "error", content: "Failed to submit form. Please try again." }); }
        finally { setIsSubmitting(false); }
    }, [validateForm]);

    const resetForm = useCallback(() => { setFormData({ textInput: "", textArea: "", comboboxValue: "", spinButtonValue: 0, checkboxChecked: false, sliderValue: 25, switchEnabled: false, radioSelection: "", email: "", phone: "", dateOfBirth: null, preferredContactTime: "" }); setErrors({}); setSubmitMessage(null); }, []);

    // This is required for DatePicker and TimePicker components
    useEffect(() => {
        if (containerRef.current) {
            setMountNode(containerRef.current);
        }
    }, []);

    return (
        <div className={styles.container} ref={containerRef}>
            <header>
                <Subtitle1 as="h1" block>User Information Form</Subtitle1>
                <Body1 style={{ color: tokens.colorNeutralForeground2, marginTop: tokens.spacingVerticalXS }} block>Please fill out all required fields. Fields marked with * are mandatory.</Body1>
            </header>
            {submitMessage && <div className={styles.messageContainer}><MessageBar intent={submitMessage.type === "success" ? "success" : "error"} icon={submitMessage.type === "success" ? <CheckmarkCircleFilled /> : <ErrorCircleFilled />}>{submitMessage.content}</MessageBar></div>}
            <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} noValidate aria-label="User information form">
                <FormSection title="Basic Information" description="Tell us about yourself" titleId={basicInfoTitleId} descriptionId={basicInfoDescId}>
                    <div className={mergeClasses(styles.formGrid, styles.twoColumnGrid)}>
                        <Field label="Full Name *" validationState={errors.textInput ? "error" : "none"} validationMessage={errors.textInput} required><Input data-field="textInput" value={formData.textInput} onChange={(_, data) => updateField("textInput", data.value)} placeholder="Enter your full name" aria-invalid={!!errors.textInput} /></Field>
                        <Field label="Date of Birth *" validationState={errors.dateOfBirth ? "error" : "none"} validationMessage={errors.dateOfBirth} required>
                            <DatePicker
                                data-field="dateOfBirth"
                                value={formData.dateOfBirth}
                                onSelectDate={(date) => updateField("dateOfBirth", date)}
                                placeholder="Select date of birth"
                                aria-invalid={!!errors.dateOfBirth}
                                maxDate={new Date()}
                                formatDate={(date) => date ? date.toLocaleDateString() : ""}
                                className={styles.datePicker}
                                // All Date Pickers must have this prop
                                mountNode={mountNode}
                            />
                        </Field>
                        <Field label="Department" hint="Select your department or team">
                            <Combobox value={formData.comboboxValue} onOptionSelect={(_, data) => updateField("comboboxValue", data.optionValue || "")} placeholder="Choose department" positioning="below" inlinePopup={false} listbox={{ className: styles.comboboxListbox }}>
                                <Option value="engineering">Engineering</Option><Option value="design">Design</Option><Option value="product">Product Management</Option><Option value="marketing">Marketing</Option><Option value="sales">Sales</Option><Option value="support">Customer Support</Option>
                            </Combobox>
                        </Field>
                    </div>
                    <Field label="Experience Level" hint="Years of experience in your field">
                        <div className={styles.sliderContainer}><div className={styles.sliderValue}>{formData.spinButtonValue} years</div><SpinButton value={formData.spinButtonValue} onChange={(_, data) => updateField("spinButtonValue", data.value || 0)} min={0} max={50} step={1} /></div>
                    </Field>
                    <Field label="About You" validationState={errors.textArea ? "error" : "none"} validationMessage={errors.textArea} hint={`${formData.textArea.length}/500 characters`}><Textarea value={formData.textArea} onChange={(_, data) => updateField("textArea", data.value)} placeholder="Tell us about your background..." rows={4} resize="vertical" aria-invalid={!!errors.textArea} /></Field>
                </FormSection>
                <FormSection title="Contact Information" description="How can we reach you?" titleId={contactTitleId} descriptionId={contactDescId}>
                    <div className={mergeClasses(styles.formGrid, styles.twoColumnGrid)}>
                        <Field label="Email Address *" validationState={errors.email ? "error" : "none"} validationMessage={errors.email} required><Input data-field="email" type="email" value={formData.email} onChange={(_, data) => updateField("email", data.value)} placeholder="your.email@company.com" aria-invalid={!!errors.email} /></Field>
                        <Field label="Phone Number *" validationState={errors.phone ? "error" : "none"} validationMessage={errors.phone} required><Input data-field="phone" type="tel" value={formData.phone} onChange={(_, data) => updateField("phone", data.value)} placeholder="+1 (555) 123-4567" aria-invalid={!!errors.phone} /></Field>
                    </div>
                     <div className={styles.formGrid}>
                        <Field label="Preferred Contact Time" hint="What time of day would you prefer to be contacted?">
                            <TimePicker
                                data-field="preferredContactTime"
                                value={formData.preferredContactTime}
                                onTimeChange={(_, data) => updateField("preferredContactTime", data.selectedTime || "")}
                                placeholder="Select preferred contact time"
                                freeform={false}
                                showSeconds={false}
                                mountNode={mountNode}
                            />
                        </Field>
                    </div>
                </FormSection>
                <FormSection title="Preferences" description="Customize your experience" titleId={preferencesTitleId} descriptionId={preferencesDescId}>
                    <div className={styles.formGrid}>
                        <Field label="Preferred Contact Method *" validationState={errors.radioSelection ? "error" : "none"} validationMessage={errors.radioSelection} required>
                            <RadioGroup value={formData.radioSelection} onChange={(_, data) => updateField("radioSelection", data.value)} className={mergeClasses(styles.radioGroupContainer, styles.radioGroupHorizontal)} aria-invalid={!!errors.radioSelection}>
                                <Radio label="Email" value="email" /><Radio label="Phone" value="phone" /><Radio label="Text Message" value="sms" /><Radio label="Teams/Slack" value="chat" />
                            </RadioGroup>
                        </Field>
                        <Field label="Communication Frequency" hint="How often would you like to receive updates?">
                            <div className={styles.sliderContainer}>
                                <div className={styles.sliderValue}>{formData.sliderValue === 0 && "Never"}{formData.sliderValue > 0 && formData.sliderValue <= 25 && "Rarely"}{formData.sliderValue > 25 && formData.sliderValue <= 50 && "Sometimes"}{formData.sliderValue > 50 && formData.sliderValue <= 75 && "Often"}{formData.sliderValue > 75 && "Frequently"}</div>
                                <Slider value={formData.sliderValue} onChange={(_, data) => updateField("sliderValue", data.value)} min={0} max={100} step={5} />
                            </div>
                        </Field>
                        <div className={mergeClasses(styles.formGrid, styles.twoColumnGrid)}>
                            <Field hint="Receive newsletter and product updates"><Checkbox label="Subscribe to Newsletter" checked={formData.checkboxChecked} onChange={(_, data) => updateField("checkboxChecked", data.checked)} /></Field>
                            <Field hint="Enable push notifications for important updates"><Switch label="Push Notifications" checked={formData.switchEnabled} onChange={(_, data) => updateField("switchEnabled", data.checked)} /></Field>
                        </div>
                    </div>
                </FormSection>
                <div className={styles.buttonGroup}><Button appearance="secondary" onClick={resetForm} disabled={isSubmitting}>Reset Form</Button><Button appearance="primary" type="submit" disabled={isSubmitting || Object.keys(errors).length > 0}>{isSubmitting ? "Submitting..." : "Submit Form"}</Button></div>
            </form>
            {Object.keys(errors).length > 0 && <div className={styles.validationSummary} role="alert" aria-live="polite" aria-label="Form validation errors"><Text weight="semibold" style={{ color: tokens.colorPaletteRedForeground1 }}>Please correct the following errors:</Text><ul style={{ margin: `${tokens.spacingVerticalXS} 0`, paddingLeft: tokens.spacingHorizontalM }}>{Object.entries(errors).map(([field, error]) => (<li key={field} style={{ color: tokens.colorPaletteRedForeground1 }}><Caption1>{error}</Caption1></li>))}</ul></div>}
        </div>
    );
}

const GeneratedComponent = (props: Props) => (
    <PageErrorBoundary>
        <PageBody {...props} />
    </PageErrorBoundary>
);

export default GeneratedComponent;
