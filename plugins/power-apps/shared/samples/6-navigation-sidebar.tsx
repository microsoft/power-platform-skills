import React, { useState } from 'react';
import { Button, Text, tokens } from '@fluentui/react-components';

const sections = ['Home', 'About', 'Contact'];
const subsectionsMap: Record<string, string[]> = {
    Home: ['Home Subsection 1', 'Home Subsection 2', 'Home Subsection 3'],
    About: ['About Subsection 1', 'About Subsection 2', 'About Subsection 3'],
    Contact: ['Contact Subsection 1', 'Contact Subsection 2', 'Contact Subsection 3'],
};

const GeneratedComponent = () => {
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
};

export default GeneratedComponent;
