import React from 'react';
import { makeStyles, tokens, Button, Text, Caption1, Subtitle1, Body1, mergeClasses, Card, CardHeader, useId } from '@fluentui/react-components';
import { MoreHorizontal20Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
    container: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXL, padding: tokens.spacingHorizontalM, width: '100%', boxSizing: 'border-box' },
    cardsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: tokens.spacingVerticalL, width: '100%' },
    card: { width: '100%', maxWidth: '480px', height: 'fit-content', cursor: 'pointer', transition: 'transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out', '&:hover': { transform: 'translateY(-2px)', boxShadow: tokens.shadow8 }, '&:focus-visible': { outline: `2px solid ${tokens.colorBrandBackground}`, outlineOffset: '2px' } },
    sectionHeader: { marginBottom: tokens.spacingVerticalM },
    sectionTitle: { marginBottom: tokens.spacingVerticalXS, display: 'block' },
    sectionDescription: { color: tokens.colorNeutralForeground2, marginBottom: tokens.spacingVerticalM, display: 'block' },
    cardContent: { padding: tokens.spacingHorizontalM, lineHeight: tokens.lineHeightBase300 },
    logo: { borderRadius: tokens.borderRadiusSmall, width: '48px', height: '48px', backgroundColor: tokens.colorNeutralBackground3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px' },
    cardHeader: { margin: 0, fontWeight: tokens.fontWeightSemibold },
    cardCaption: { color: tokens.colorNeutralForeground3, display: 'block' },
    '@media (max-width: 768px)': { container: { padding: tokens.spacingHorizontalS }, cardsGrid: { gridTemplateColumns: '1fr', gap: tokens.spacingVerticalM }, card: { maxWidth: '100%' } }
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
            <CardHeader image={<div className={styles.logo} role="img" aria-label="Application logo">📱</div>} header={<Text as="h3" className={styles.cardHeader} block>Mobile App</Text>} description={<Caption1 className={styles.cardCaption} block>Development Team</Caption1>} action={<Button appearance="transparent" icon={<MoreHorizontal20Regular />} aria-label="More options for Mobile App" onClick={(e) => { e.stopPropagation(); console.log('More options clicked'); }} />} />
            <div className={styles.cardContent}><Text block>A comprehensive mobile application that provides seamless user experience across all devices with responsive design and accessibility features built-in.</Text></div>
        </Card>
    );
};

const ResponsiveCardShowcase: React.FC = () => {
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
};

export default ResponsiveCardShowcase;
