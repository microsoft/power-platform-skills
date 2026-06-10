import * as React from 'react';
import {
    makeStyles,
    tokens,
    Button,
    Input,
    Dropdown,
    Option,
    Field,
    Text,
    Body1,
    MessageBar,
    MessageBarBody,
} from '@fluentui/react-components';
import {
    PersonRegular,
    DocumentRegular,
    CheckmarkCircleRegular,
} from '@fluentui/react-icons';
import { GeneratedComponentProps } from './RuntimeTypes';

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: tokens.spacingHorizontalL,
        gap: tokens.spacingVerticalM,
        boxSizing: 'border-box',
    },
    stepBar: {
        display: 'flex',
        gap: tokens.spacingHorizontalM,
        alignItems: 'center',
    },
    stepDot: {
        width: '28px',
        height: '28px',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tokens.colorNeutralBackground3,
        color: tokens.colorNeutralForeground2,
    },
    stepDotActive: {
        backgroundColor: tokens.colorBrandBackground,
        color: tokens.colorNeutralForegroundOnBrand,
    },
    fields: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
        maxWidth: '480px',
    },
    nav: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: tokens.spacingHorizontalM,
        marginBlockStart: tokens.spacingVerticalL,
    },
    reviewRow: {
        display: 'flex',
        justifyContent: 'space-between',
        paddingBlock: tokens.spacingVerticalXS,
        borderBlockEnd: `1px solid ${tokens.colorNeutralStroke2}`,
    },
});

type Priority = 1 | 2 | 3;
type Category = 'question' | 'problem' | 'request';

interface FormState {
    contactFirstName: string;
    contactLastName: string;
    contactEmail: string;
    title: string;
    priority: Priority;
    category: Category;
}

const initialState: FormState = {
    contactFirstName: '',
    contactLastName: '',
    contactEmail: '',
    title: '',
    priority: 2,
    category: 'question',
};

const GeneratedComponent = (props: GeneratedComponentProps) => {
    const { dataApi, pageInput } = props;
    void pageInput; // wizard does not receive incoming pageInput
    const styles = useStyles();
    const [step, setStep] = React.useState(1);
    const [form, setForm] = React.useState<FormState>(initialState);
    const [submitting, setSubmitting] = React.useState(false);
    const [submitError, setSubmitError] = React.useState<string | null>(null);
    const [submitted, setSubmitted] = React.useState(false);

    const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
        setForm((prev) => ({ ...prev, [key]: value }));
    };

    const handleSubmit = async () => {
        setSubmitting(true);
        setSubmitError(null);
        try {
            const contactId = await dataApi.createRow('contact', {
                firstname: form.contactFirstName,
                lastname: form.contactLastName,
                emailaddress1: form.contactEmail,
            });
            await dataApi.createRow('incident', {
                title: form.title,
                prioritycode: form.priority,
                casetypecode: form.category === 'question' ? 1 : form.category === 'problem' ? 2 : 3,
                'customerid_contact@odata.bind': `/contacts(${contactId})`,
            });
            setSubmitted(true);
        } catch (e) {
            setSubmitError(e instanceof Error ? e.message : String(e));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className={styles.root}>
            <Text size={600} weight="semibold">New Case</Text>

            <div className={styles.stepBar}>
                {[1, 2, 3].map((n) => (
                    <div
                        key={n}
                        className={`${styles.stepDot} ${step === n ? styles.stepDotActive : ''}`}
                        aria-label={`Step ${n}`}
                    >
                        {n}
                    </div>
                ))}
            </div>

            {step === 1 && (
                <div className={styles.fields}>
                    <Body1>
                        <PersonRegular /> Customer information
                    </Body1>
                    <Field label="First name">
                        <Input
                            aria-label="First name"
                            value={form.contactFirstName}
                            onChange={(_, d) => updateField('contactFirstName', d.value)}
                        />
                    </Field>
                    <Field label="Last name">
                        <Input
                            aria-label="Last name"
                            value={form.contactLastName}
                            onChange={(_, d) => updateField('contactLastName', d.value)}
                        />
                    </Field>
                    <Field label="Email">
                        <Input
                            aria-label="Email"
                            type="email"
                            value={form.contactEmail}
                            onChange={(_, d) => updateField('contactEmail', d.value)}
                        />
                    </Field>
                </div>
            )}

            {step === 2 && (
                <div className={styles.fields}>
                    <Body1>
                        <DocumentRegular /> Case details
                    </Body1>
                    <Field label="Title">
                        <Input
                            aria-label="Title"
                            value={form.title}
                            onChange={(_, d) => updateField('title', d.value)}
                        />
                    </Field>
                    <Field label="Priority">
                        <Dropdown
                            aria-label="Priority"
                            selectedOptions={[String(form.priority)]}
                            onOptionSelect={(_, d) => updateField('priority', Number(d.optionValue) as Priority)}
                        >
                            <Option value="1">High</Option>
                            <Option value="2">Normal</Option>
                            <Option value="3">Low</Option>
                        </Dropdown>
                    </Field>
                    <Field label="Category">
                        <Dropdown
                            aria-label="Category"
                            selectedOptions={[form.category]}
                            onOptionSelect={(_, d) => updateField('category', (d.optionValue ?? 'question') as Category)}
                        >
                            <Option value="question">Question</Option>
                            <Option value="problem">Problem</Option>
                            <Option value="request">Request</Option>
                        </Dropdown>
                    </Field>
                </div>
            )}

            {step === 3 && (
                <div className={styles.fields}>
                    <Body1>
                        <CheckmarkCircleRegular /> Review &amp; submit
                    </Body1>
                    <div className={styles.reviewRow}>
                        <Text>Contact</Text>
                        <Text weight="semibold">{form.contactFirstName} {form.contactLastName}</Text>
                    </div>
                    <div className={styles.reviewRow}>
                        <Text>Email</Text>
                        <Text weight="semibold">{form.contactEmail}</Text>
                    </div>
                    <div className={styles.reviewRow}>
                        <Text>Title</Text>
                        <Text weight="semibold">{form.title}</Text>
                    </div>
                    <div className={styles.reviewRow}>
                        <Text>Priority</Text>
                        <Text weight="semibold">{form.priority === 1 ? 'High' : form.priority === 2 ? 'Normal' : 'Low'}</Text>
                    </div>
                    <div className={styles.reviewRow}>
                        <Text>Category</Text>
                        <Text weight="semibold">{form.category}</Text>
                    </div>
                    {submitError && (
                        <MessageBar intent="error"><MessageBarBody>{submitError}</MessageBarBody></MessageBar>
                    )}
                    {submitted && (
                        <MessageBar intent="success"><MessageBarBody>Case created.</MessageBarBody></MessageBar>
                    )}
                </div>
            )}

            <div className={styles.nav}>
                <Button
                    aria-label="Back"
                    onClick={() => setStep((s) => Math.max(1, s - 1))}
                    disabled={step === 1 || submitting}
                >
                    Back
                </Button>
                {step < 3 ? (
                    <Button
                        appearance="primary"
                        aria-label="Next"
                        onClick={() => setStep((s) => Math.min(3, s + 1))}
                    >
                        Next
                    </Button>
                ) : (
                    <Button
                        appearance="primary"
                        aria-label="Submit"
                        onClick={handleSubmit}
                        disabled={submitting || submitted}
                    >
                        Submit
                    </Button>
                )}
            </div>
        </div>
    );
};

export default GeneratedComponent;
