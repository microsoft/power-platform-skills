/**
 * Shared UI components — scaffolded at project creation.
 * Import from here. Never re-define inline in screen files.
 *
 * Usage:
 *   import { LoadingState, ErrorState, EmptyState, ScreenHeader,
 *            ModalHeader, BottomActionBar, FloatingActionButton, FilterChipRow, FormField, RowPick,
 *            StatusPill, StatTile, Hero, SectionHeader, EntityImage,
 *            AvatarInitials, InfoRow, ActionRow, Gradient } from '@/components';
 */

import React from 'react';
import { I18nManager, ScrollView, Image as RNImage, type ColorValue } from 'react-native';
import { YStack, XStack, ZStack, Text, Button, useTheme } from 'tamagui';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { gradients, shadows, type GradientName } from '@/tokens';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

function webDataAttributes(values: Record<string, string | number>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    `data-${key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`,
    String(value),
  ])) as any;
}

// ─── Gradient ────────────────────────────────────────────────────────────────

export function Gradient({
  name,
  source,
  style,
  children,
}: {
  name: GradientName;
  source: 'content' | 'state' | 'magnitude' | 'legibility';
  style?: object;
  children?: React.ReactNode;
}) {
  return (
    <LinearGradient
      colors={gradients[name]}
      testID={`gradient:${name}:${source}`}
      style={[{ borderRadius: 12 }, style]}
    >
      {children}
    </LinearGradient>
  );
}

// ─── StatusPill ───────────────────────────────────────────────────────────────

export type StatusVariant =
  | 'overdue'
  | 'complete'
  | 'in-progress'
  | 'pending'
  | 'draft'
  | 'cancelled';

const STATUS_STYLES = {
  overdue:       { bg: '$statusOverdueBg',    text: '$statusOverdue',    label: 'Overdue' },
  complete:      { bg: '$statusCompleteBg',   text: '$statusComplete',   label: 'Complete' },
  'in-progress': { bg: '$statusInProgressBg', text: '$statusInProgress', label: 'In Progress' },
  pending:       { bg: '$statusPendingBg',    text: '$statusPending',    label: 'Pending' },
  draft:         { bg: '$statusDraftBg',      text: '$statusDraft',      label: 'Draft' },
  cancelled:     { bg: '$statusCancelledBg',  text: '$statusCancelled',  label: 'Cancelled' },
} as const satisfies Record<StatusVariant, { bg: string; text: string; label: string }>;

export function StatusPill({
  status,
  label,
}: {
  status: StatusVariant;
  label?: string;
}) {
  const s = STATUS_STYLES[status];
  return (
    <XStack
      bg={s.bg} px="$2" py="$1" rounded="$10" items="center"
      aria-label={`Status: ${label ?? s.label}`}
    >
      <Text fontSize="$1" fontWeight="600" color={s.text}>{label ?? s.label}</Text>
    </XStack>
  );
}

// ─── StatTile ─────────────────────────────────────────────────────────────────

export function StatTile({
  label,
  value,
  trend,
  trendUp,
  iconName,
}: {
  label: string;
  value: string | number;
  trend?: string;
  trendUp?: boolean;
  iconName?: IoniconName;
}) {
  const theme = useTheme();

  return (
    <YStack
      bg="$color2" rounded="$4" p="$4" gap="$1" flex={1}
      {...shadows.sm}
      aria-label={`${label}: ${value}${trend ? ', trend ' + trend : ''}`}
    >
      <XStack items="center" gap="$2">
        {iconName && <Ionicons name={iconName} size={14} color={theme.color10.val} />}
        <Text fontSize="$2" color="$color10" numberOfLines={1}>{label}</Text>
      </XStack>
      <Text fontSize="$8" fontWeight="700" color="$color12">{String(value)}</Text>
      {trend && (
        <Text fontSize="$1" color={trendUp ? '$statusComplete' : '$statusOverdue'} fontWeight="600">
          {trend}
        </Text>
      )}
    </YStack>
  );
}

// ─── Sparkline / SeriesChart ───────────────────────────────────────────────

export type NormalizedChartPoint = {
  key: string;
  label: string;
  value: number;
  normalized: number;
};

export function Sparkline({
  points,
  summary,
  seriesColor,
}: {
  points: NormalizedChartPoint[];
  summary: string;
  seriesColor: ColorValue;
}) {
  const rendered = points.slice(0, 12);
  return (
    <YStack
      testID="chart:sparkline"
      {...webDataAttributes({ chartSeriesToken: 'seriesPrimary', chartPointCount: rendered.length })}
      aria-label={summary}
      gap="$1"
    >
      <XStack height={36} items="flex-end" gap={3}>
        {rendered.map((point, index) => (
          <YStack
            key={point.key}
            testID={`chart-point:${index}`}
            {...webDataAttributes({ chartEndpoint: index === rendered.length - 1 ? 'true' : 'false' })}
            width={index === rendered.length - 1 ? 6 : 3}
            height={Math.max(2, 4 + point.normalized * 30)}
            style={{ backgroundColor: seriesColor }}
            rounded="$1"
          />
        ))}
      </XStack>
      <Text testID="chart-caption" fontSize={11} lineHeight={16} fontWeight="500" color="$color10">
        {summary}
      </Text>
    </YStack>
  );
}

export function SeriesChart({
  points,
  summary,
  emptyRange,
  seriesColor,
  gridColor,
  form = 'bar',
}: {
  points: NormalizedChartPoint[];
  summary: string;
  emptyRange: string;
  seriesColor: ColorValue;
  gridColor: ColorValue;
  form?: 'bar' | 'area';
}) {
  const rendered = points.slice(0, 12);
  if (rendered.length === 0) {
    return (
      <EmptyState
        icon="bar-chart-outline"
        title={`No data for ${emptyRange}`}
        message="Try another reporting period."
      />
    );
  }

  const plot = (
    <XStack height={160} items="flex-end" gap="$2" borderBottomWidth={1} style={{ borderBottomColor: gridColor }}>
      {rendered.map((point, index) => (
        <YStack key={point.key} flex={1} items="center" justify="flex-end" gap="$1">
          <YStack
            testID={`chart-point:${index}`}
            width="70%"
            height={Math.max(4, 12 + point.normalized * 116)}
            style={{ backgroundColor: seriesColor }}
            rounded="$1"
          />
          <Text testID="chart-axis-label" fontSize={11} lineHeight={16} fontWeight="500" color="$color10">
            {point.label}
          </Text>
        </YStack>
      ))}
    </XStack>
  );

  return (
    <YStack
      testID={`chart:series-chart:${form}`}
      {...webDataAttributes({ chartSeriesToken: 'seriesPrimary', chartGridToken: 'grid', chartPointCount: rendered.length })}
      aria-label={summary}
      gap="$2"
    >
      {form === 'area' ? <Gradient name="chartArea" source="magnitude">{plot}</Gradient> : plot}
      <Text testID="chart-caption" fontSize={14} lineHeight={20} fontWeight="400" color="$color11">
        {summary}
      </Text>
    </YStack>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────────────

export function Hero({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: { label: string; iconName?: IoniconName; onPress: () => void };
}) {
  return (
    <YStack bg="$accentBase" px="$5" pt="$6" pb="$5" gap="$1">
      <XStack items="center" justify="space-between">
        <YStack gap="$1" flex={1}>
          <Text fontSize="$7" fontWeight="700" color="$accentOnAccent" numberOfLines={1}>
            {title}
          </Text>
          {subtitle && (
            <Text fontSize="$3" color="$accentOnAccent" numberOfLines={2}>
              {subtitle}
            </Text>
          )}
        </YStack>
        {action && (
          <Button
            size="$3" chromeless
            borderColor="$accentOnAccent" borderWidth={1}
            onPress={action.onPress}
            icon={action.iconName ? <Ionicons name={action.iconName} size={16} color="currentColor" /> : undefined}
          >
            <Button.Text color="$accentOnAccent">{action.label}</Button.Text>
          </Button>
        )}
      </XStack>
    </YStack>
  );
}

// ─── SectionHeader ────────────────────────────────────────────────────────────

export function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <XStack items="center" justify="space-between" mb="$2">
      <Text fontSize="$5" fontWeight="600" color="$color11">{title}</Text>
      {action && (
        <Button size="$2" chromeless onPress={action.onPress}>
          <Text fontSize="$3" color="$blue10">{action.label}</Text>
        </Button>
      )}
    </XStack>
  );
}

// ─── AvatarInitials ───────────────────────────────────────────────────────────

export function AvatarInitials({
  name,
  size = 'md',
  statusDot,
}: {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  statusDot?: 'online' | 'away' | 'offline';
}) {
  const dim = { sm: 28, md: 36, lg: 48 }[size];
  const fontSize = { sm: '$1', md: '$2', lg: '$4' }[size] as '$1' | '$2' | '$4';
  const initials = name.split(' ').map(word => word[0]).slice(0, 2).join('').toUpperCase();
  const dotColors = { online: '$statusComplete', away: '$statusPending', offline: '$statusDraft' } as const;

  return (
    <ZStack width={dim} height={dim}>
      <YStack width={dim} height={dim} rounded={dim / 2} bg="$blue3" items="center" justify="center" aria-label={name}>
        <Text fontSize={fontSize} fontWeight="600" color="$blue10">{initials}</Text>
      </YStack>
      {statusDot && (
        <YStack
          position="absolute" b={0} r={0}
          width={10} height={10} rounded={5}
          bg={dotColors[statusDot]}
          borderWidth={2} borderColor="$background"
        />
      )}
    </ZStack>
  );
}

// ─── InfoRow ──────────────────────────────────────────────────────────────────

export function InfoRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
}) {
  return (
    <XStack justify="space-between" py="$2" items="center">
      <Text color="$color10" fontSize="$4" flex={1}>{label}</Text>
      <Text
        fontSize="$4" fontWeight="500"
        fontFamily={mono ? '$mono' : undefined}
        color="$color12" text="right" flex={1}
        numberOfLines={1}
      >
        {String(value)}
      </Text>
    </XStack>
  );
}

// ─── ActionRow ────────────────────────────────────────────────────────────────

export function ActionRow({
  iconName,
  label,
  subtitle,
  onPress,
  destructive,
}: {
  iconName?: IoniconName;
  label: string;
  subtitle?: string;
  onPress: () => void;
  destructive?: boolean;
}) {
  const theme = useTheme();

  return (
    <XStack
      items="center" gap="$3" py="$3" px="$4" minH={48}
      pressStyle={{ bg: '$color3' }}
      onPress={onPress}
      role="button"
      aria-label={label}
    >
      {iconName && (
        <Ionicons
          name={iconName}
          size={18}
          color={destructive ? theme.statusOverdue.val : theme.color10.val}
        />
      )}
      <YStack flex={1} gap="$0.5">
        <Text fontSize="$4" color={destructive ? '$statusOverdue' : '$color12'}>{label}</Text>
        {subtitle && <Text fontSize="$2" color="$color10">{subtitle}</Text>}
      </YStack>
      <Ionicons name={I18nManager.isRTL ? 'chevron-back' : 'chevron-forward'} size={16} color={theme.color10.val} />
    </XStack>
  );
}

// ─── LoadingState ────────────────────────────────────────────────────────────

export function LoadingState({
  rows = 6,
  variant = 'list',
}: {
  rows?: number;
  variant?: 'list' | 'detail' | 'form';
}) {
  if (variant === 'detail') {
    return (
      <YStack flex={1} gap="$3" p="$4">
        <YStack bg="$color4" height={22} width="55%" rounded="$2" />
        <YStack bg="$color4" height={14} width="35%" rounded="$2" />
        <YStack bg="$color4" height={1} width="100%" my="$2" />
        {Array.from({ length: rows }).map((_, i) => (
          <XStack key={i} justify="space-between" py="$2">
            <YStack bg="$color4" height={14} width="30%" rounded="$2" />
            <YStack bg="$color4" height={14} width="45%" rounded="$2" />
          </XStack>
        ))}
      </YStack>
    );
  }

  return (
    <YStack gap="$3" p="$4">
      {Array.from({ length: rows }).map((_, i) => (
        <XStack key={i} items="center" gap="$3" py="$3" borderBottomWidth={0.5} borderBottomColor="$borderColor">
          <YStack height={14} flex={1} bg="$color4" rounded="$2" />
          <YStack height={22} width={48} bg="$color4" rounded="$10" />
        </XStack>
      ))}
    </YStack>
  );
}

// ─── ErrorState ──────────────────────────────────────────────────────────────

export function ErrorState({
  message,
  onRetry,
  title = 'Something went wrong',
}: {
  message: string;
  onRetry: () => void;
  title?: string;
}) {
  const theme = useTheme();

  return (
    <YStack flex={1} items="center" justify="center" p="$6" gap="$3">
      <Ionicons name="alert-circle" size={48} color={theme.statusOverdue.val} />
      <Text fontSize="$6" fontWeight="700" color="$color12">{title}</Text>
      <Text color="$color10" text="center">{message}</Text>
      <Button onPress={onRetry}>Try again</Button>
    </YStack>
  );
}

// ─── EmptyState ──────────────────────────────────────────────────────────────

export function EmptyState({
  icon = 'document-outline',
  title,
  message,
  actionLabel,
  onAction,
}: {
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const theme = useTheme();

  return (
    <YStack flex={1} items="center" justify="center" p="$6" gap="$3">
      <Ionicons name={icon} size={48} color={theme.color10.val} />
      <Text fontSize="$5" fontWeight="600" color="$color12">{title}</Text>
      <Text color="$color10" text="center" fontSize="$4">{message}</Text>
      {actionLabel && onAction && (
        <Button bg="$blue10" onPress={onAction}>
          <Button.Text color="$color1">{actionLabel}</Button.Text>
        </Button>
      )}
    </YStack>
  );
}

// ─── BottomActionBar ─────────────────────────────────────────────────────────

export function BottomActionBar({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <YStack
      px="$4"
      pt="$3"
      pb={insets.bottom > 0 ? insets.bottom + 20 : 20}
      bg="$surface1"
      borderTopWidth={1}
      borderTopColor="$borderColor"
      gap="$2"
    >
      {children}
    </YStack>
  );
}

// ─── BatchActionBar ────────────────────────────────────────────────────────

export type BatchAction = {
  key: string;
  label: string;
  destructive?: boolean;
  onPress: () => void;
};

export function BatchActionBar({
  selectedCount,
  actions,
  onSelectAll,
  onExit,
  onOpenOverflow,
}: {
  selectedCount: number;
  actions: BatchAction[];
  onSelectAll: () => void;
  onExit: () => void;
  onOpenOverflow?: () => void;
}) {
  const visibleActions = actions.length <= 3 ? actions : actions.slice(0, 1);
  return (
    <YStack
      testID="selection-mode:active"
      {...webDataAttributes({ selectionEntry: 'long-press-or-select', selectionExitRestores: 'primary' })}
    >
      <XStack px="$4" py="$2" items="center" justify="space-between">
        <Text testID="selection-count" fontWeight="600">{selectedCount} selected</Text>
        <XStack gap="$2">
          <Button testID="selection-select-all" chromeless onPress={onSelectAll}>Select all</Button>
          <Button testID="selection-exit" chromeless onPress={onExit}>Done</Button>
        </XStack>
      </XStack>
      <YStack testID="pinned:batch-actions">
        <BottomActionBar>
          <XStack testID={actions.length <= 3 ? 'batch-actions:buttons' : 'batch-actions:primary-overflow'} gap="$2">
            {visibleActions.map((action) => (
              <Button
                key={action.key}
                testID={action.destructive ? `batch-destructive:${action.key}` : `batch-action:${action.key}`}
                flex={1}
                onPress={action.onPress}
                aria-label={action.destructive ? `${action.label} ${selectedCount} records` : action.label}
              >
                {action.label}
              </Button>
            ))}
            {actions.length > 3 && (
              <Button testID="batch-overflow" onPress={onOpenOverflow} aria-label="More batch actions">More</Button>
            )}
          </XStack>
        </BottomActionBar>
      </YStack>
    </YStack>
  );
}

// ─── FloatingActionButton ───────────────────────────────────────────────────

export function FloatingActionButton({
  label,
  iconName = 'add',
  onPress,
  extended = false,
}: {
  label: string;
  iconName?: IoniconName;
  onPress: () => void;
  extended?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Button
      position="absolute"
      r={20}
      b={insets.bottom + 20}
      width={extended ? undefined : 56}
      height={56}
      px={extended ? '$4' : 0}
      rounded="$10"
      bg="$blue10"
      boxShadow="0 4px 16px rgba(0, 0, 0, 0.12)"
      onPress={onPress}
      role="button"
      aria-label={label}
      icon={<Ionicons name={iconName} size={22} color="white" />}
      pressStyle={{ scale: 0.96 }}
    >
      {extended ? <Button.Text color="$color1">{label}</Button.Text> : null}
    </Button>
  );
}

// ─── FilterChipRow ──────────────────────────────────────────────────────────

export type FilterChipOption = {
  key: string;
  label: string;
  count?: number;
};

export function FilterChipRow({
  options,
  selectedKey,
  onChange,
}: {
  options: FilterChipOption[];
  selectedKey: string;
  onChange: (key: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
    >
      {options.map((option) => {
        const selected = option.key === selectedKey;
        const label = typeof option.count === 'number' ? `${option.label} ${option.count}` : option.label;
        return (
          <Button
            key={option.key}
            size="$3"
            rounded="$10"
            px="$3"
            minH={36}
            bg={selected ? '$blue10' : '$surface2'}
            borderWidth={selected ? 0 : 1}
            borderColor="$borderColor"
            onPress={() => onChange(option.key)}
            role="button"
            aria-pressed={selected}
            aria-label={label}
            pressStyle={{ scale: 0.98 }}
          >
            <Button.Text color={selected ? '$color1' : '$color11'}>{label}</Button.Text>
          </Button>
        );
      })}
    </ScrollView>
  );
}

// ─── SortControl ───────────────────────────────────────────────────────────

export type SortOption = {
  key: string;
  label: string;
  orderBy: string;
};

export function SortControl({
  options,
  selectedKey,
  onChange,
  onOpenSheet,
}: {
  options: SortOption[];
  selectedKey: string;
  onChange: (key: string) => void;
  onOpenSheet?: () => void;
}) {
  const selected = options.find((option) => option.key === selectedKey) ?? options[0];
  if (!selected) return null;

  if (options.length <= 3) {
    return (
      <YStack testID="sort-control:inline-chips" gap="$2">
        <Text testID={`sort-active:${selected.key}`} fontSize="$2" color="$color10">
          Sort: {selected.label}
        </Text>
        <FilterChipRow
          options={options.map((option) => ({ key: option.key, label: option.label }))}
          selectedKey={selected.key}
          onChange={onChange}
        />
      </YStack>
    );
  }

  return (
    <Button testID="sort-control:sheet" onPress={onOpenSheet} minH={48} aria-label={`Sort: ${selected.label}`}>
      <Button.Text testID={`sort-active:${selected.key}`}>Sort: {selected.label}</Button.Text>
    </Button>
  );
}

// ─── CarouselRow ───────────────────────────────────────────────────────────

export function CarouselRow<T>({
  entity,
  items,
  keyExtractor,
  renderItem,
  itemWidth = 280,
  initialOffset = 0,
  onOffsetChange,
}: {
  entity: string;
  items: T[];
  keyExtractor: (item: T) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
  itemWidth?: number;
  initialOffset?: number;
  onOffsetChange?: (offset: number) => void;
}) {
  const gap = 12;
  const ref = React.useRef<ScrollView>(null);

  React.useEffect(() => {
    if (initialOffset > 0) ref.current?.scrollTo({ x: initialOffset, animated: false });
  }, [initialOffset]);

  return (
    <ScrollView
      ref={ref}
      testID={`carousel:${entity}:carousel-row`}
      {...webDataAttributes({ carouselSnap: 'start', autoAdvance: 'false', preservePosition: 'true' })}
      horizontal
      snapToInterval={itemWidth + gap}
      snapToAlignment="start"
      decelerationRate="fast"
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap, paddingHorizontal: 16, paddingEnd: 48 }}
      onMomentumScrollEnd={(event) => onOffsetChange?.(event.nativeEvent.contentOffset.x)}
    >
      {items.map((item, index) => (
        <YStack
          key={keyExtractor(item)}
          testID={`carousel-item:${keyExtractor(item)}`}
          width={itemWidth}
          accessibilityLabel={`${index + 1} of ${items.length}`}
        >
          {renderItem(item, index)}
        </YStack>
      ))}
    </ScrollView>
  );
}

// ─── ScreenHeader ────────────────────────────────────────────────────────────

export function ScreenHeader({
  title,
  subtitle,
  status,
  meta,
  rightAction,
  children,
}: {
  title: string;
  subtitle?: string;
  status?: React.ReactNode;
  meta?: React.ReactNode;
  rightAction?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <YStack px="$5" pb="$3" gap="$2" borderBottomWidth={1} borderBottomColor="$borderColor">
      <XStack items="center" justify="space-between" gap="$3">
        <YStack flex={1} gap="$1">
          <XStack items="center" gap="$2" flexWrap="wrap">
            <Text fontSize={28} fontWeight="700" letterSpacing={0}>{title}</Text>
            {status}
          </XStack>
          {subtitle && (
            <Text fontSize={13} color="$color10" fontWeight="500">{subtitle}</Text>
          )}
        </YStack>
        {rightAction}
      </XStack>
      {meta}
      {children}
    </YStack>
  );
}

// ─── ModalHeader ─────────────────────────────────────────────────────────────

export function ModalHeader({
  title,
  onCancel,
  onSave,
  saveLabel = 'Save',
  saving = false,
}: {
  title: string;
  onCancel: () => void;
  onSave?: () => void;
  saveLabel?: string;
  saving?: boolean;
}) {
  return (
    <XStack px="$4" pt="$5" pb="$3" items="center" justify="space-between">
      <Button chromeless onPress={onCancel}>Cancel</Button>
      <Text fontSize={17} fontWeight="700">{title}</Text>
      {onSave ? (
        <Button chromeless onPress={onSave} disabled={saving}>
          <Text fontWeight="600">{saveLabel}</Text>
        </Button>
      ) : (
        <YStack width={56} />
      )}
    </XStack>
  );
}

// ─── FormField ───────────────────────────────────────────────────────────────

export function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <YStack gap="$2">
      <Text fontSize={11} fontWeight="700" color="$color10" letterSpacing={0}>
        {label}
      </Text>
      {children}
    </YStack>
  );
}

// ─── RowPick ─────────────────────────────────────────────────────────────────

export function RowPick({
  label,
  subtitle,
  selected,
  onPress,
}: {
  label: string;
  subtitle?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <XStack
      px="$3" py="$3" items="center" justify="space-between" rounded="$3"
      borderWidth={1}
      borderColor={selected ? '$color12' : '$borderColor'}
      bg={selected ? '$color12' : '$background'}
      onPress={onPress}
      pressStyle={{ opacity: 0.7 }}
    >
      <YStack>
        <Text fontSize={15} fontWeight="600" color={selected ? 'white' : '$color12'}>{label}</Text>
        {subtitle ? (
          <Text fontSize={12} color={selected ? 'white' : '$color10'} mt="$1">
            {subtitle}
          </Text>
        ) : null}
      </YStack>
      {selected && <Ionicons name="checkmark-circle" size={20} color="white" />}
    </XStack>
  );
}

/**
 * Renders an image safely from either a Dataverse base64 string or a CDN URL
 * (used frequently in mock-backed prototypes for realistic visual data).
 */
export function EntityImage({
  source,
  width,
  height,
  borderRadius = 0,
  fallbackIcon = 'image-outline',
}: {
  source?: string | null;
  width: number;
  height: number;
  borderRadius?: number;
  fallbackIcon?: IoniconName;
}) {
  const theme = useTheme();
  
  if (!source) {
    return (
      <YStack width={width} height={height} style={{ borderRadius }} bg="$surface2" items="center" justify="center" overflow="hidden">
        <Ionicons name={fallbackIcon} size={24} color={theme.color10.val} />
      </YStack>
    );
  }

  // Handle CDN mockup urls and Dataverse base64 safely.
  const uri = source.startsWith('http') || source.startsWith('data:') ? source : `data:image/jpeg;base64,${source}`;

  return (
    <YStack width={width} height={height} overflow="hidden" style={{ borderRadius }} bg="$surface2">
      <RNImage
        source={{ uri }}
        style={{ width: '100%', height: '100%', resizeMode: 'cover' }}
        accessible={true}
        accessibilityRole="image"
      />
    </YStack>
  );
}
