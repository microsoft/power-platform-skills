import { useState, useEffect } from 'react';
import {
    makeStyles,
    tokens,
    Text,
    Card,
    CardHeader,
    Badge,
    MessageBar,
    MessageBarBody,
} from '@fluentui/react-components';
import {
    TemperatureRegular,
    WeatherSunnyRegular,
    WaterRegular,
} from '@fluentui/react-icons';

// EDITED PAGE — this started life as a mock-data weather dashboard (eval 17). The maker's edit
// request was "pull the current conditions from the real MSN Weather connector instead of the
// hard-coded numbers", so the page now binds to the new_uxtest_msnweather connection reference.
//
// MSN Weather is a REST/action connector, not a table/list one, so it uses the
// executeConnectorOperation pattern from references/connectors.md — NOT queryConnectorTable.
// The weekly forecast below is deliberately left as inline sample data: the edit plan's
// Preservation Constraints keep it, because the operation returns current conditions only.

interface WeatherRecord {
    date: string;
    tempHigh: number;
    tempLow: number;
    conditions: string;
    humidity: number;
}

interface CurrentConditions {
    temperature: number;
    feelsLike: number;
    conditions: string;
    humidity: number;
    location: string;
}

// PRESERVED from the original mock page — the connector operation returns current conditions
// only, so the forecast strip keeps its sample data rather than losing the feature.
const weeklyForecast: WeatherRecord[] = [
    { date: 'Mon', tempHigh: 58, tempLow: 45, conditions: 'Partly Cloudy', humidity: 72 },
    { date: 'Tue', tempHigh: 54, tempLow: 43, conditions: 'Rainy', humidity: 88 },
    { date: 'Wed', tempHigh: 62, tempLow: 48, conditions: 'Partly Sunny', humidity: 65 },
    { date: 'Thu', tempHigh: 65, tempLow: 50, conditions: 'Sunny', humidity: 58 },
    { date: 'Fri', tempHigh: 60, tempLow: 47, conditions: 'Cloudy', humidity: 75 },
];

// Shown until the connector answers, and whenever it is unavailable or fails.
const FALLBACK_CURRENT: CurrentConditions = {
    temperature: 58,
    feelsLike: 54,
    conditions: 'Partly Cloudy',
    humidity: 72,
    location: 'Seattle, WA',
};

const CONNECTOR_LOGICAL_NAME = 'new_uxtest_msnweather';
const OPERATION_NAME = 'CurrentWeather';
const winAny = window as any;
const CACHE_KEY = '__ppWeatherCurrentCache';
const INFLIGHT_KEY = '__ppWeatherCurrentInflight';

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
    currentCard: { padding: tokens.spacingHorizontalL },
    currentRow: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalL,
    },
    bigTemp: {
        fontSize: tokens.fontSizeHero800,
        fontWeight: tokens.fontWeightSemibold,
        lineHeight: tokens.lineHeightHero800,
    },
    metric: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalXS,
        color: tokens.colorNeutralForeground2,
    },
    metricIcon: { color: tokens.colorBrandForeground1, flexShrink: 0 },
    forecastStrip: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: tokens.spacingHorizontalM,
        '@media (max-width: 480px)': {
            gridTemplateColumns: '1fr',
        },
    },
    dayCard: { padding: tokens.spacingHorizontalM },
    dayName: { fontWeight: tokens.fontWeightSemibold },
    daySub: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase200 },
});

const DayCard = (props: { day: WeatherRecord }) => {
    const { day } = props;
    const styles = useStyles();
    return (
        <Card
            className={styles.dayCard}
            aria-label={`${day.date}: ${day.conditions}, high ${day.tempHigh}, low ${day.tempLow}, humidity ${day.humidity} percent`}
        >
            <Text className={styles.dayName}>{day.date}</Text>
            <Text className={styles.daySub}>{day.conditions}</Text>
            <Text className={styles.daySub}>
                {day.tempHigh}° / {day.tempLow}°
            </Text>
        </Card>
    );
};

const GeneratedComponent = (props: { dataApi?: unknown; pageInput?: { data?: Record<string, unknown> } }) => {
    const { dataApi, pageInput } = props;
    void pageInput;
    const styles = useStyles();
    // Cast to an OPTIONAL connector shape — the runtime may not expose the method if the
    // connection reference is not active yet.
    const connectorApi = dataApi as unknown as {
        executeConnectorOperation?: (
            connectorLogicalName: string,
            operationName: string,
            parameters: Record<string, unknown>
        ) => Promise<{ ok: boolean; body: unknown }>;
    };
    const dataReady = !!dataApi;
    const [{ current, live, error }, setData] = useState<{
        current: CurrentConditions;
        live: boolean;
        error: string | null;
    }>(() => {
        const cached = winAny[CACHE_KEY] as CurrentConditions | undefined;
        return { current: cached ?? FALLBACK_CURRENT, live: cached !== undefined, error: null };
    });

    useEffect(() => {
        if (!dataReady) return;

        const cached = winAny[CACHE_KEY] as CurrentConditions | undefined;
        if (cached !== undefined) {
            if (current !== cached) {
                setData({ current: cached, live: true, error: null });
            }
            return;
        }

        // Presence-check before calling, per references/connectors.md.
        if (typeof connectorApi?.executeConnectorOperation !== 'function') {
            setData({ current: FALLBACK_CURRENT, live: false, error: null });
            return;
        }

        let cancelled = false;
        let inflight = winAny[INFLIGHT_KEY] as Promise<CurrentConditions> | undefined;
        if (!inflight) {
            inflight = connectorApi
                .executeConnectorOperation(CONNECTOR_LOGICAL_NAME, OPERATION_NAME, {
                    Location: 'Seattle',
                    units: 'I',
                })
                .then((response) => {
                    // Check `ok` before reading `body` — a failed operation still resolves.
                    if (!response.ok) throw new Error('operation returned ok:false');
                    const body = response.body as {
                        temperature?: number;
                        feelsLike?: number;
                        conditions?: string;
                        humidity?: number;
                        location?: string;
                    };
                    const mapped: CurrentConditions = {
                        temperature: body.temperature ?? FALLBACK_CURRENT.temperature,
                        feelsLike: body.feelsLike ?? FALLBACK_CURRENT.feelsLike,
                        conditions: body.conditions ?? FALLBACK_CURRENT.conditions,
                        humidity: body.humidity ?? FALLBACK_CURRENT.humidity,
                        location: body.location ?? FALLBACK_CURRENT.location,
                    };
                    winAny[CACHE_KEY] = mapped;
                    return mapped;
                })
                .finally(() => {
                    if (winAny[INFLIGHT_KEY] === inflight) {
                        delete winAny[INFLIGHT_KEY];
                    }
                });
            winAny[INFLIGHT_KEY] = inflight;
        }

        inflight
            .then((mapped) => {
                if (!cancelled) {
                    setData({ current: mapped, live: true, error: null });
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setData({
                        current: FALLBACK_CURRENT,
                        live: false,
                        error: 'Could not reach the MSN Weather connector. Showing sample conditions.',
                    });
                }
            });

        return () => {
            cancelled = true;
        };
        // dataApi is a new reference on each render, so depend on readiness only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataReady]);

    return (
        <div className={styles.root}>
            <Text as="h1" size={800} weight="semibold" className={styles.pageTitle}>
                Seattle Weather
            </Text>

            {error && (
                <MessageBar intent="warning">
                    <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
            )}

            <Card className={styles.currentCard}>
                <CardHeader
                    header={<Text weight="semibold">Current conditions — {current.location}</Text>}
                    action={
                        <Badge appearance="outline" aria-label={live ? 'Live connector data' : 'Sample data'}>
                            {live ? 'Live' : 'Sample'}
                        </Badge>
                    }
                />
                <div className={styles.currentRow}>
                    <Text className={styles.bigTemp}>{current.temperature}°</Text>
                    <div className={styles.metric}>
                        <WeatherSunnyRegular className={styles.metricIcon} aria-hidden="true" />
                        <Text>{current.conditions}</Text>
                    </div>
                    <div className={styles.metric}>
                        <TemperatureRegular className={styles.metricIcon} aria-hidden="true" />
                        <Text>Feels like {current.feelsLike}°</Text>
                    </div>
                    <div className={styles.metric}>
                        <WaterRegular className={styles.metricIcon} aria-hidden="true" />
                        <Text>{current.humidity}% humidity</Text>
                    </div>
                </div>
            </Card>

            <Text as="h2" size={500} weight="semibold">
                Five-day forecast
            </Text>
            <div className={styles.forecastStrip}>
                {weeklyForecast.map((day) => (
                    <DayCard key={day.date} day={day} />
                ))}
            </div>
        </div>
    );
};

export default GeneratedComponent;
