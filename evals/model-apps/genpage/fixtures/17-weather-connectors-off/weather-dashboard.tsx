import { useState } from 'react';
import {
    makeStyles,
    mergeClasses,
    tokens,
    Text,
    Card,
    CardHeader,
    Badge,
} from '@fluentui/react-components';
import {
    TemperatureRegular,
    WeatherSunnyRegular,
    WaterRegular,
} from '@fluentui/react-icons';

// Mock weather data for Seattle — the MSN Weather connector is gated behind the
// connectors feature flag (currently OFF), so this page uses inline mock data.

interface WeatherRecord {
    date: string;
    tempHigh: number;
    tempLow: number;
    conditions: string;
    humidity: number;
}

const weeklyForecast: WeatherRecord[] = [
    { date: 'Mon', tempHigh: 58, tempLow: 45, conditions: 'Partly Cloudy', humidity: 72 },
    { date: 'Tue', tempHigh: 54, tempLow: 43, conditions: 'Rainy', humidity: 88 },
    { date: 'Wed', tempHigh: 62, tempLow: 48, conditions: 'Partly Sunny', humidity: 65 },
    { date: 'Thu', tempHigh: 65, tempLow: 50, conditions: 'Sunny', humidity: 58 },
    { date: 'Fri', tempHigh: 60, tempLow: 47, conditions: 'Cloudy', humidity: 75 },
];

const currentConditions = {
    temperature: 58,
    feelsLike: 54,
    conditions: 'Partly Cloudy',
    humidity: 72,
    location: 'Seattle, WA',
};

const useStyles = makeStyles({
    root: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalL,
        padding: tokens.spacingHorizontalXL,
        width: '100%',
        boxSizing: 'border-box',
    },
    pageTitle: { marginBottom: tokens.spacingVerticalS },
    mockBanner: {
        backgroundColor: tokens.colorNeutralBackground2,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        borderRadius: tokens.borderRadiusMedium,
        color: tokens.colorNeutralForeground2,
        fontSize: tokens.fontSizeBase200,
    },
    sectionHeading: { marginBottom: tokens.spacingVerticalM },
    metricsRow: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalL,
    },
    metricCard: {
        flex: '1 1 200px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: tokens.spacingVerticalS,
        padding: tokens.spacingHorizontalL,
    },
    metricValue: {
        fontSize: tokens.fontSizeHero700,
        fontWeight: tokens.fontWeightSemibold,
        color: tokens.colorBrandForeground1,
    },
    metricLabel: {
        color: tokens.colorNeutralForeground2,
        fontSize: tokens.fontSizeBase300,
    },
    forecastRow: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalM,
    },
    forecastCard: {
        flex: '1 1 100px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: tokens.spacingVerticalXS,
        padding: tokens.spacingHorizontalM,
        cursor: 'pointer',
    },
    forecastCardSelected: {
        backgroundColor: tokens.colorBrandBackground2,
    },
    forecastDay: { fontWeight: tokens.fontWeightSemibold },
    forecastTemps: { fontSize: tokens.fontSizeBase300 },
    forecastMeta: {
        color: tokens.colorNeutralForeground2,
        fontSize: tokens.fontSizeBase200,
        textAlign: 'center',
    },
    detailBar: {
        backgroundColor: tokens.colorNeutralBackground2,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        borderRadius: tokens.borderRadiusMedium,
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
    },
});

const MetricCard = (props: {
    icon: React.ReactNode;
    label: string;
    value: string;
    subLabel?: string;
}) => {
    const styles = useStyles();
    return (
        <Card className={styles.metricCard} aria-label={`${props.label}: ${props.value}`}>
            <CardHeader
                image={props.icon}
                header={<Text className={styles.metricLabel}>{props.label}</Text>}
            />
            <Text className={styles.metricValue}>{props.value}</Text>
            {props.subLabel && <Badge appearance="outline">{props.subLabel}</Badge>}
        </Card>
    );
};

const GeneratedComponent = (props: { dataApi?: unknown; pageInput?: { data?: Record<string, unknown> } }) => {
    const { pageInput } = props;
    // pageInput is destructured per rules but unused in this mock dashboard.
    void pageInput;
    const styles = useStyles();
    const [selectedDay, setSelectedDay] = useState<string>('Mon');

    const selectedForecast = weeklyForecast.find((d) => d.date === selectedDay) ?? weeklyForecast[0];

    return (
        <div className={styles.root}>
            <Text as="h1" size={700} weight="semibold" className={styles.pageTitle}>
                Seattle Weather Dashboard
            </Text>

            <div className={styles.mockBanner} role="note">
                Displaying mock weather data — live connector support is coming soon
            </div>

            <section aria-label="Current conditions">
                <Text as="h2" size={500} weight="semibold" className={styles.sectionHeading}>
                    Current Conditions — {currentConditions.location}
                </Text>
                <div className={styles.metricsRow}>
                    <MetricCard
                        icon={<TemperatureRegular aria-hidden="true" />}
                        label="Temperature"
                        value={`${currentConditions.temperature}°F`}
                        subLabel={`Feels like ${currentConditions.feelsLike}°F`}
                    />
                    <MetricCard
                        icon={<WeatherSunnyRegular aria-hidden="true" />}
                        label="Sky Conditions"
                        value={currentConditions.conditions}
                    />
                    <MetricCard
                        icon={<WaterRegular aria-hidden="true" />}
                        label="Humidity"
                        value={`${currentConditions.humidity}%`}
                    />
                </div>
            </section>

            <section aria-label="5-day forecast">
                <Text as="h2" size={500} weight="semibold" className={styles.sectionHeading}>
                    5-Day Forecast
                </Text>
                <div className={styles.forecastRow}>
                    {weeklyForecast.map((day) => (
                        <Card
                            key={day.date}
                            className={mergeClasses(
                                styles.forecastCard,
                                selectedDay === day.date && styles.forecastCardSelected
                            )}
                            onClick={() => setSelectedDay(day.date)}
                            aria-label={`${day.date}: ${day.conditions}, high ${day.tempHigh}°F, low ${day.tempLow}°F, humidity ${day.humidity}%`}
                        >
                            <Text className={styles.forecastDay}>{day.date}</Text>
                            <Text className={styles.forecastTemps}>{day.tempHigh}° / {day.tempLow}°</Text>
                            <Text className={styles.forecastMeta}>{day.conditions}</Text>
                        </Card>
                    ))}
                </div>
                {selectedForecast && (
                    <Text className={styles.detailBar} aria-live="polite">
                        {selectedForecast.date}: High {selectedForecast.tempHigh}°F · Low {selectedForecast.tempLow}°F · Humidity {selectedForecast.humidity}%
                    </Text>
                )}
            </section>
        </div>
    );
};

export default GeneratedComponent;
