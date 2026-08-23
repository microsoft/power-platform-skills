/**
 * Shared UI kit — 24 public components. Scaffolded at project creation.
 * Import from here. Never re-define inline and never add industry widgets.
 *
 * Usage:
 *   import { LoadingState, ErrorState, EmptyState, ScreenHeader,
 *            ModalHeader, BottomActionBar, FloatingActionButton, FilterChipRow, FormField, RowPick,
 *            StatusPill, StatTile, Hero, ImageHero, ProgressMeter, EntityRow,
 *            NumericStepper, Callout, SectionHeader, EntityImage,
 *            AvatarInitials, InfoRow, ActionRow, Gradient } from '@/components';
 */

import React from 'react';
import { ScrollView, Image as RNImage } from 'react-native';
import { YStack, XStack, ZStack, Text, Button, useTheme } from 'tamagui';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { gradients, shadows, type GradientName } from '@/tokens';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

// ─── Gradient ────────────────────────────────────────────────────────────────

export function Gradient({
  name,
  style,
  children,
}: {
  name: GradientName;
  style?: object;
  children?: React.ReactNode;
}) {
  return (
    <LinearGradient colors={[...gradients[name]]} style={[{ borderRadius: 12 }, style]}>
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
      bg="$surface1" rounded="$4" p="$4" gap="$1" flex={1}
      {...shadows.sm}
      aria-label={`${label}: ${value}${trend ? ', trend ' + trend : ''}`}
    >
      <XStack items="center" gap="$2">
        {iconName && <Ionicons name={iconName} size={14} color={theme.color10.val} />}
        <Text fontSize="$2" color="$color10" numberOfLines={1}>{label}</Text>
      </XStack>
      <Text fontFamily="$heading" fontSize="$8" fontWeight="700" color="$color12">
        {String(value)}
      </Text>
      {trend && (
        <Text fontSize="$1" color={trendUp ? '$statusComplete' : '$statusOverdue'} fontWeight="600">
          {trend}
        </Text>
      )}
    </YStack>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────────────

export function Hero({
  title,
  subtitle,
  gradient = 'hero',
  action,
  variant = 'banner',
  origin,
  destination,
}: {
  title: string;
  subtitle?: string;
  gradient?: GradientName;
  action?: { label: string; iconName?: IoniconName; onPress: () => void };
  variant?: 'banner' | 'endpoint-pair';
  origin?: { label: string; value: string };
  destination?: { label: string; value: string };
}) {
  const pair = variant === 'endpoint-pair' && origin && destination;

  return (
    <Gradient name={gradient} style={{ borderRadius: 0 }}>
      <YStack px="$5" pt="$6" pb="$5" gap="$3">
        {pair ? (
          <XStack items="center" justify="space-between" gap="$3">
            <YStack flex={1} gap="$1">
              <Text fontFamily="$heading" fontSize="$8" fontWeight="700" color="white" numberOfLines={1}>
                {origin.value}
              </Text>
              <Text fontSize="$2" color="white" numberOfLines={1}>{origin.label}</Text>
            </YStack>
            <Ionicons name="arrow-forward" size={20} color="white" />
            <YStack flex={1} items="flex-end" gap="$1">
              <Text fontFamily="$heading" fontSize="$8" fontWeight="700" color="white" numberOfLines={1}>
                {destination.value}
              </Text>
              <Text fontSize="$2" color="white" numberOfLines={1}>{destination.label}</Text>
            </YStack>
          </XStack>
        ) : null}
        <XStack items="center" justify="space-between" gap="$3">
          <YStack gap="$1" flex={1}>
            <Text fontFamily="$heading" fontSize={pair ? '$5' : '$7'} fontWeight="700" color="white" numberOfLines={1}>
              {title}
            </Text>
            {subtitle && (
              <Text fontSize="$3" color="white" numberOfLines={2}>
                {subtitle}
              </Text>
            )}
          </YStack>
          {action && (
            <Button
              size="$3" chromeless
              borderColor="rgba(255,255,255,0.7)" borderWidth={1.5}
              onPress={action.onPress}
              icon={action.iconName ? <Ionicons name={action.iconName} size={16} color="white" /> : undefined}
            >
              <Button.Text color="white">{action.label}</Button.Text>
            </Button>
          )}
        </XStack>
      </YStack>
    </Gradient>
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
      <Text fontFamily="$heading" fontSize="$5" fontWeight="600" color="$color11">{title}</Text>
      {action && (
        <Button size="$3" chromeless onPress={action.onPress}>
          <Text fontSize="$3" color="$accentBase">{action.label}</Text>
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
      <YStack width={dim} height={dim} rounded={dim / 2} bg="$accentSoft" items="center" justify="center" aria-label={name}>
        <Text fontSize={fontSize} fontWeight="600" color="$accentDeep">{initials}</Text>
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
        fontFamily={mono ? '$body' : undefined}
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
      <Ionicons name="chevron-forward" size={16} color={theme.color10.val} />
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
        <Button bg="$accentBase" onPress={onAction}>
          <Button.Text color="$accentOnAccent">{actionLabel}</Button.Text>
        </Button>
      )}
    </YStack>
  );
}

// ─── BottomActionBar ─────────────────────────────────────────────────────────

export function BottomActionBar({
  children,
  safeArea = true,
}: {
  children: React.ReactNode;
  safeArea?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <YStack
      px="$4"
      pt="$3"
      pb={safeArea && insets.bottom > 0 ? insets.bottom + 20 : 12}
      bg="$surface1"
      borderTopWidth={1}
      borderTopColor="$borderColor"
      gap="$2"
    >
      {children}
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
  const theme = useTheme();
  return (
    <Button
      position="absolute"
      r={20}
      b={insets.bottom + 20}
      width={extended ? undefined : 56}
      height={56}
      px={extended ? '$4' : 0}
      rounded="$10"
      bg="$accentBase"
      boxShadow="0 4px 16px rgba(0, 0, 0, 0.12)"
      onPress={onPress}
      role="button"
      aria-label={label}
      icon={<Ionicons name={iconName} size={22} color={theme.accentOnAccent.val} />}
      pressStyle={{ scale: 0.96 }}
    >
      {extended ? <Button.Text color="$accentOnAccent">{label}</Button.Text> : null}
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
            size="$2"
            rounded="$10"
            px="$3"
            minH={40}
            bg={selected ? '$accentBase' : '$surface2'}
            borderWidth={selected ? 0 : 1}
            borderColor="$borderColor"
            onPress={() => onChange(option.key)}
            role="button"
            aria-pressed={selected}
            aria-label={label}
            pressStyle={{ scale: 0.98 }}
          >
            <Button.Text fontSize="$2" fontWeight="600" color={selected ? '$accentOnAccent' : '$color11'}>
              {label}
            </Button.Text>
          </Button>
        );
      })}
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
    <YStack
      px="$5"
      pt="$3"
      pb="$3"
      gap="$2"
      bg="$surface0"
      borderBottomWidth={1}
      borderBottomColor="$borderColor"
    >
      <XStack items="center" justify="space-between" gap="$3">
        <YStack flex={1} gap="$1">
          <XStack items="center" gap="$2" flexWrap="wrap">
            <Text fontFamily="$heading" fontSize={28} fontWeight="700" letterSpacing={0}>
              {title}
            </Text>
            {status}
          </XStack>
          {subtitle && (
            <Text fontFamily="$body" fontSize={14} color="$color10" fontWeight="500">
              {subtitle}
            </Text>
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
      <Text fontSize={11} fontWeight="700" color="$color10" letterSpacing={0.6}>
        {label.toUpperCase()}
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
      role="radio"
      aria-label={label}
      aria-checked={selected}
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
  width: number | string;
  height: number | string;
  borderRadius?: number;
  fallbackIcon?: IoniconName;
}) {
  const theme = useTheme();
  
  if (!source) {
    return (
      <YStack style={{ width, height, borderRadius }} bg="$surface2" items="center" justify="center" overflow="hidden">
        <Ionicons name={fallbackIcon} size={24} color={theme.text3.val} />
      </YStack>
    );
  }

  // Handle CDN mockup urls and Dataverse base64 safely.
  const uri = source.startsWith('http') || source.startsWith('data:') ? source : `data:image/jpeg;base64,${source}`;

  return (
    <YStack style={{ width, height, borderRadius }} overflow="hidden" bg="$surface2">
      <RNImage
        source={{ uri }}
        style={{ width: '100%', height: '100%', resizeMode: 'cover' }}
        accessible={true}
        accessibilityRole="image"
      />
    </YStack>
  );
}

// ─── ImageHero ────────────────────────────────────────────────────────────────

export function ImageHero({
  source,
  title,
  subtitle,
  overlay,
  height = 220,
  action,
  fallbackIcon = 'image-outline',
}: {
  source?: string | null;
  title: string;
  subtitle?: string;
  overlay?: React.ReactNode;
  height?: number;
  action?: { label: string; iconName?: IoniconName; onPress: () => void };
  fallbackIcon?: IoniconName;
}) {
  const theme = useTheme();

  return (
    <ZStack height={height} overflow="hidden">
      <EntityImage source={source} width="100%" height={height} fallbackIcon={fallbackIcon} />
      <YStack
        position="absolute"
        l={0}
        r={0}
        b={0}
        pt="$8"
        px="$5"
        pb="$4"
        gap="$2"
        bg="rgba(0,0,0,0.45)"
      >
        <XStack items="flex-end" justify="space-between" gap="$3">
          <YStack flex={1} gap="$1">
            <Text fontFamily="$heading" fontSize="$7" fontWeight="700" color="white" numberOfLines={2}>
              {title}
            </Text>
            {subtitle ? (
              <Text fontSize="$3" color="white" numberOfLines={2}>{subtitle}</Text>
            ) : null}
          </YStack>
          {action ? (
            <Button
              size="$3"
              bg="$accentBase"
              onPress={action.onPress}
              icon={action.iconName ? <Ionicons name={action.iconName} size={16} color={theme.accentOnAccent.val} /> : undefined}
            >
              <Button.Text color="$accentOnAccent">{action.label}</Button.Text>
            </Button>
          ) : null}
        </XStack>
        {overlay}
      </YStack>
    </ZStack>
  );
}

// ─── ProgressMeter ────────────────────────────────────────────────────────────

export function ProgressMeter({
  value,
  max = 100,
  variant = 'bar',
  label,
  segments,
}: {
  value: number;
  max?: number;
  variant?: 'ring' | 'bar' | 'segments';
  label?: string;
  segments?: Array<{ key: string; complete: boolean; label?: string }>;
}) {
  const ratio = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
  const percent = Math.round(ratio * 100);

  if (variant === 'segments' && segments?.length) {
    return (
      <YStack gap="$2" aria-label={label ?? `Progress ${percent} percent`}>
        <XStack gap="$1.5">
          {segments.map((segment) => (
            <YStack
              key={segment.key}
              flex={1}
              height={8}
              rounded="$10"
              bg={segment.complete ? '$accentBase' : '$color4'}
            />
          ))}
        </XStack>
        {label ? <Text fontSize="$2" color="$color10">{label}</Text> : null}
      </YStack>
    );
  }

  if (variant === 'ring') {
    return (
      <YStack items="center" justify="center" width={72} height={72} aria-label={label ?? `Progress ${percent} percent`}>
        <YStack
          width={72}
          height={72}
          rounded={36}
          borderWidth={6}
          borderColor="$color4"
          items="center"
          justify="center"
        >
          <YStack
            position="absolute"
            width={72}
            height={72}
            rounded={36}
            borderWidth={6}
            borderColor="$accentBase"
            opacity={ratio === 0 ? 0 : 1}
          />
          <Text fontSize="$5" fontWeight="700" color="$color12">{percent}</Text>
        </YStack>
        {label ? <Text fontSize="$1" color="$color10" mt="$2">{label}</Text> : null}
      </YStack>
    );
  }

  return (
    <YStack gap="$2" aria-label={label ?? `Progress ${percent} percent`}>
      <XStack justify="space-between" items="center">
        {label ? <Text fontSize="$2" color="$color10">{label}</Text> : <YStack />}
        <Text fontSize="$2" fontWeight="600" color="$color11">{percent}%</Text>
      </XStack>
      <YStack height={8} rounded="$10" bg="$color4" overflow="hidden">
        <YStack height={8} width={`${percent}%`} bg="$accentBase" />
      </YStack>
    </YStack>
  );
}

// ─── EntityRow ────────────────────────────────────────────────────────────────

export function EntityRow({
  title,
  subtitle,
  meta,
  variant = 'status',
  status,
  statusLabel,
  imageSource,
  checked,
  onCheckedChange,
  avatarName,
  onPress,
}: {
  title: string;
  subtitle?: string;
  meta?: string;
  variant?: 'status' | 'media' | 'check' | 'timeline' | 'avatar' | 'sentence';
  status?: StatusVariant;
  statusLabel?: string;
  imageSource?: string | null;
  checked?: boolean;
  onCheckedChange?: (next: boolean) => void;
  avatarName?: string;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const stripe = status ? STATUS_STYLES[status].text : undefined;

  return (
    <XStack
      items="center"
      gap="$3"
      py="$3"
      px="$4"
      minH={56}
      borderLeftWidth={variant === 'status' && status ? 4 : 0}
      borderLeftColor={stripe}
      pressStyle={onPress || onCheckedChange ? { bg: '$color3' } : undefined}
      onPress={onCheckedChange ? () => onCheckedChange(!checked) : onPress}
      role={onPress || onCheckedChange ? 'button' : undefined}
      aria-label={title}
    >
      {variant === 'check' ? (
        <Ionicons
          name={checked ? 'checkbox' : 'square-outline'}
          size={22}
          color={theme.color11.val}
        />
      ) : null}
      {variant === 'media' ? (
        <EntityImage source={imageSource} width={48} height={48} borderRadius={8} />
      ) : null}
      {variant === 'avatar' ? (
        <AvatarInitials name={avatarName || title} size="md" />
      ) : null}
      {variant === 'timeline' ? (
        <YStack width={10} items="center">
          <YStack width={10} height={10} rounded={5} bg="$accentBase" />
        </YStack>
      ) : null}
      <YStack flex={1} gap="$0.5">
        <Text
          fontSize="$4"
          fontWeight="600"
          color="$color12"
          textDecorationLine={variant === 'check' && checked ? 'line-through' : undefined}
          numberOfLines={variant === 'sentence' ? 2 : 1}
        >
          {title}
        </Text>
        {subtitle ? <Text fontSize="$2" color="$color10" numberOfLines={1}>{subtitle}</Text> : null}
      </YStack>
      {status ? <StatusPill status={status} label={statusLabel} /> : null}
      {meta ? <Text fontSize="$2" color="$color10" fontFamily="$body">{meta}</Text> : null}
      {onPress ? <Ionicons name="chevron-forward" size={16} color={theme.color10.val} /> : null}
    </XStack>
  );
}

// ─── NumericStepper ───────────────────────────────────────────────────────────

export function NumericStepper({
  value,
  onChange,
  min = 0,
  max = 99,
  step = 1,
  label,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
}) {
  const theme = useTheme();
  const decrement = () => onChange(Math.max(min, value - step));
  const increment = () => onChange(Math.min(max, value + step));

  return (
    <XStack items="center" gap="$3" aria-label={label ?? 'Quantity'}>
      <Button
        size="$4"
        circular
        minH={48}
        minW={48}
        bg="$surface2"
        disabled={value <= min}
        onPress={decrement}
        aria-label={`Decrease ${label ?? 'value'}`}
        icon={<Ionicons name="remove" size={18} color={theme.color12.val} />}
      />
      <Text fontSize="$6" fontWeight="700" color="$color12" minW={28} text="center">
        {value}
      </Text>
      <Button
        size="$4"
        circular
        minH={48}
        minW={48}
        bg="$surface2"
        disabled={value >= max}
        onPress={increment}
        aria-label={`Increase ${label ?? 'value'}`}
        icon={<Ionicons name="add" size={18} color={theme.color12.val} />}
      />
    </XStack>
  );
}

// ─── Callout ──────────────────────────────────────────────────────────────────

export function Callout({
  title,
  message,
  tone = 'info',
  action,
}: {
  title: string;
  message?: string;
  tone?: 'info' | 'warning' | 'danger' | 'success';
  action?: { label: string; onPress: () => void };
}) {
  const toneStyles = {
    info: { bg: '$accentSoft', icon: 'information-circle' as IoniconName, color: '$accentDeep' },
    warning: { bg: '$statusPendingBg', icon: 'warning' as IoniconName, color: '$statusPending' },
    danger: { bg: '$statusOverdueBg', icon: 'alert-circle' as IoniconName, color: '$statusOverdue' },
    success: { bg: '$statusCompleteBg', icon: 'checkmark-circle' as IoniconName, color: '$statusComplete' },
  } as const;
  const tones = toneStyles[tone];
  const theme = useTheme();

  return (
    <XStack
      bg={tones.bg}
      rounded="$4"
      p="$4"
      gap="$3"
      items="flex-start"
      aria-label={`${tone}: ${title}`}
    >
      <Ionicons name={tones.icon} size={20} color={theme.color12.val} />
      <YStack flex={1} gap="$1">
        <Text fontSize="$4" fontWeight="700" color="$color12">{title}</Text>
        {message ? <Text fontSize="$3" color="$color11">{message}</Text> : null}
        {action ? (
          <Button size="$3" chromeless onPress={action.onPress}>
            <Text fontSize="$3" color={tones.color} fontWeight="600">{action.label}</Text>
          </Button>
        ) : null}
      </YStack>
    </XStack>
  );
}
