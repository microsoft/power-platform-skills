import React, { useState } from 'react';
import { Button, Text, RadioGroup, Radio, Divider, ProgressBar, tokens } from '@fluentui/react-components';

const GeneratedComponent = () => {
    const [currentStep, setCurrentStep] = useState(0);
    const [responses, setResponses] = useState({
        signatureQuestion1: '',
        signatureQuestion2: '',
        recencyQuestion: '',
        complianceQuestion1: '',
        complianceQuestion2: '',
        complianceQuestion3: '',
    });

    const steps = [
        { content: <SignatureStep responses={responses} setResponses={setResponses} /> },
        { content: <RecencyStep responses={responses} setResponses={setResponses} /> },
        { content: <ComplianceStep responses={responses} setResponses={setResponses} /> },
        { content: <ConfirmationStep responses={responses} /> },
    ];

    const totalSteps = steps.length;
    const progress = (currentStep + 1) / totalSteps;

    const handleNext = () => {
        if (validateStep()) {
            setCurrentStep((prevStep) => prevStep + 1);
        }
    };

    const handleBack = () => {
        setCurrentStep((prevStep) => prevStep - 1);
    };

    const validateStep = () => {
        const validationMap: Record<number, boolean> = {
            0: Boolean(responses.signatureQuestion1 && responses.signatureQuestion2),
            1: Boolean(responses.recencyQuestion),
            2: Boolean(responses.complianceQuestion1 && responses.complianceQuestion2 && responses.complianceQuestion3),
        };
        return currentStep === 3 || validationMap[currentStep];
    };

    return (
        <div style={{ width: '100%', height: '100%', padding: '0.5rem', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <ProgressBar
                value={progress}
                thickness="large"
                shape="rounded"
                style={{ marginBottom: '0.75rem', width: '100%', maxWidth: '800px' }}
                aria-valuenow={progress * 100}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Wizard progress"
            />
            <section
                style={{
                    marginTop: '0.75rem',
                    padding: '0.75rem',
                    borderRadius: tokens.borderRadiusSmall,
                    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
                    width: '100%',
                    maxWidth: '800px',
                    backgroundColor: '#fff',
                }}
                role="region"
                aria-labelledby={`step-title-${currentStep}`}
            >
                {steps[currentStep].content}
            </section>
            <div style={{ marginTop: '0.75rem', display: 'flex', justifyContent: 'space-between', width: '100%', maxWidth: '800px' }}>
                <Button appearance="secondary" disabled={currentStep === 0} onClick={handleBack} aria-label="Go to previous step">
                    Back
                </Button>
                {currentStep < steps.length - 1 ? (
                    <Button appearance="primary" disabled={!validateStep()} onClick={handleNext} aria-label="Go to next step">
                        Next
                    </Button>
                ) : null}
            </div>
        </div>
    );
};

const SignatureStep = ({ responses, setResponses }: { responses: any; setResponses: any }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <Text id="signature-q1" size={300} block>
            The Power of Attorney has been signed and dated by a principal:
        </Text>
        <RadioGroup
            aria-labelledby="signature-q1"
            value={responses.signatureQuestion1}
            onChange={(e, data) => setResponses({ ...responses, signatureQuestion1: data.value })}
        >
            <Radio value="yes" label="Yes" />
            <Radio value="no" label="No" />
        </RadioGroup>
        <Divider />
        <Text id="signature-q2" size={300} block>
            The signature has been acknowledged before a notary public or individual authorized by law to take acknowledgement:
        </Text>
        <RadioGroup
            aria-labelledby="signature-q2"
            value={responses.signatureQuestion2}
            onChange={(e, data) => setResponses({ ...responses, signatureQuestion2: data.value })}
        >
            <Radio value="yes" label="Yes" />
            <Radio value="no" label="No" />
        </RadioGroup>
    </div>
);

const RecencyStep = ({ responses, setResponses }: { responses: any; setResponses: any }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <Text id="recency-q" size={300} block>
            The Power of Attorney has been signed less than 60 days ago:
        </Text>
        <RadioGroup
            aria-labelledby="recency-q"
            value={responses.recencyQuestion}
            onChange={(e, data) => setResponses({ ...responses, recencyQuestion: data.value })}
        >
            <Radio value="yes" label="Yes" />
            <Radio value="no" label="No" />
        </RadioGroup>
    </div>
);

const ComplianceStep = ({ responses, setResponses }: { responses: any; setResponses: any }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <Text id="compliance-q1" size={300} block>
            This PoA does not write a will for someone nor edit a current will:
        </Text>
        <RadioGroup
            aria-labelledby="compliance-q1"
            value={responses.complianceQuestion1}
            onChange={(e, data) => setResponses({ ...responses, complianceQuestion1: data.value })}
        >
            <Radio value="yes" label="Yes" />
            <Radio value="no" label="No" />
        </RadioGroup>
        <Divider />
        <Text id="compliance-q2" size={300} block>
            This PoA does not take money from someone's bank account:
        </Text>
        <RadioGroup
            aria-labelledby="compliance-q2"
            value={responses.complianceQuestion2}
            onChange={(e, data) => setResponses({ ...responses, complianceQuestion2: data.value })}
        >
            <Radio value="yes" label="Yes" />
            <Radio value="no" label="No" />
        </RadioGroup>
        <Divider />
        <Text id="compliance-q3" size={300} block>
            This PoA does not make decisions after the represented person died:
        </Text>
        <RadioGroup
            aria-labelledby="compliance-q3"
            value={responses.complianceQuestion3}
            onChange={(e, data) => setResponses({ ...responses, complianceQuestion3: data.value })}
        >
            <Radio value="yes" label="Yes" />
            <Radio value="no" label="No" />
        </RadioGroup>
    </div>
);

const ConfirmationStep = ({ responses }: { responses: any }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <Text id="confirmation-title" size={300} block>
            Review your responses:
        </Text>
        <div style={{ marginTop: '0.75rem', padding: '0.5rem', border: '1px solid #ddd', borderRadius: tokens.borderRadiusSmall }}>
            <Text size={300}>Step 1 - Signature:</Text>
            <Text>The Power of Attorney has been signed and dated by a principal: {responses.signatureQuestion1}</Text>
            <Text>The signature has been acknowledged before a notary public: {responses.signatureQuestion2}</Text>
            <Divider />
            <Text size={300}>Step 2 - Recency:</Text>
            <Text>The Power of Attorney has been signed less than 60 days ago: {responses.recencyQuestion}</Text>
            <Divider />
            <Text size={300}>Step 3 - Compliance:</Text>
            <Text>This PoA does not write a will for someone nor edit a current will: {responses.complianceQuestion1}</Text>
            <Text>This PoA does not take money from someone's bank account: {responses.complianceQuestion2}</Text>
            <Text>This PoA does not make decisions after the represented person died: {responses.complianceQuestion3}</Text>
        </div>
    </div>
);

export default GeneratedComponent;
