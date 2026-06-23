/**
 * Shared UI components — scaffolded at project creation.
 * Import from here. Never re-define inline in screen files.
 *
 * Usage:
 *   import { LoadingState, ErrorState, EmptyState, ScreenHeader,
 *            ModalHeader, BottomActionBar, FloatingActionButton, FilterChipRow, FormField, RowPick,
 *            StatusPill, StatTile, Hero, SectionHeader,
 *            AvatarInitials, InfoRow, ActionRow, Gradient } from '@/components';
 */

import React from 'react';
import { ScrollView } from 'react-native';
import { YStack, XStack, ZStack, Text, Button } from 'tamagui';
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

const STATUS_STYLES: Record<StatusVariant, { bg: string; text: string; label: string }> = {
  overdue:       { bg: '$statusOverdueBg',    text: '$statusOverdue',    label: 'Overdue' },
  complete:      { bg: '$statusCompleteBg',   text: '$statusComplete',   label: 'Complete' },
  'in-progress': { bg: '$statusInProgressBg', text: '$statusInProgress', label: 'In Progress' },
  pending:       { bg: '$statusPendingBg',    text: '$statusPending',    label: 'Pending' },
  draft:         { bg: '$statusDraftBg',      text: '$statusDraft',      label: 'Draft' },
  cancelled:     { bg: '$statusCancelledBg',  text: '$statusCancelled',  label: 'Cancelled' },
};

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
      bg={s.bg} px="$2" py="$1" br="$10" ai="center"
      accessibilityLabel={`Status: ${label ?? s.label}`}
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
  return (
    <YStack
      bg="$color2" br="$4" p="$4" gap="$1" f={1}
      {...shadows.sm}
      accessibilityLabel={`${label}: ${value}${trend ? ', trend ' + trend : ''}`}
    >
      <XStack ai="center" gap="$2">
        {iconName && <Ionicons name={iconName} size={14} color="$color10" />}
        <Text fontSize="$2" col="$color10" numberOfLines={1}>{label}</Text>
      </XStack>
      <Text fontSize="$8" fontWeight="700" col="$color12">{String(value)}</Text>
      {trend && (
        <Text fontSize="$1" col={trendUp ? '$statusComplete' : '$statusOverdue'} fontWeight="600">
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
}: {
  title: string;
  subtitle?: string;
  gradient?: GradientName;
  action?: { label: string; iconName?: IoniconName; onPress: () => void };
}) {
  return (
    <Gradient name={gradient} style={{ borderRadius: 0 }}>
      <YStack px="$5" pt="$6" pb="$5" gap="$1">
        <XStack ai="center" jc="space-between">
          <YStack gap="$1" f={1}>
            <Text fontSize="$7" fontWeight="700" color="white" numberOfLines={1}>
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
              size="$3" chromeless color="white"
              borderColor="rgba(255,255,255,0.7)" borderWidth={1.5}
              onPress={action.onPress}
              icon={action.iconName ? <Ionicons name={action.iconName} size={16} color="white" /> : undefined}
            >
              {action.label}
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
    <XStack ai="center" jc="space-between" mb="$2">
      <Text fontSize="$5" fontWeight="600" col="$color11">{title}</Text>
      {action && (
        <Button size="$2" chromeless onPress={action.onPress}>
          <Text fontSize="$3" col="$blue10">{action.label}</Text>
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
  const initials = name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const dotColors = { online: '$statusComplete', away: '$statusPending', offline: '$statusDraft' } as const;

  return (
    <ZStack w={dim} h={dim}>
      <YStack w={dim} h={dim} br={dim / 2} bg="$blue3" ai="center" jc="center" accessibilityLabel={name}>
        <Text fontSize={fontSize} fontWeight="600" col="$blue10">{initials}</Text>
      </YStack>
      {statusDot && (
        <YStack
          position="absolute" bottom={0} right={0}
          w={10} h={10} br={5}
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
    <XStack jc="space-between" py="$2" ai="center">
      <Text col="$color10" fontSize="$4" f={1}>{label}</Text>
      <Text
        fontSize="$4" fontWeight="500"
        fontFamily={mono ? '$mono' : undefined}
        col="$color12" ta="right" f={1}
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
  return (
    <XStack
      ai="center" gap="$3" py="$3" px="$4" minHeight={48}
      pressStyle={{ bg: '$color3' }}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {iconName && <Ionicons name={iconName} size={18} color={destructive ? '$statusOverdue' : '$color10'} />}
      <YStack f={1} gap="$0.5">
        <Text fontSize="$4" col={destructive ? '$statusOverdue' : '$color12'}>{label}</Text>
        {subtitle && <Text fontSize="$2" col="$color10">{subtitle}</Text>}
      </YStack>
      <Ionicons name="chevron-forward" size={16} color="$color10" />
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
      <YStack f={1} gap="$3" p="$4">
        <YStack bg="$color4" h={22} w="55%" br="$2" />
        <YStack bg="$color4" h={14} w="35%" br="$2" />
        <YStack bg="$color4" h={1} w="100%" my="$2" />
        {Array.from({ length: rows }).map((_, i) => (
          <XStack key={i} jc="space-between" py="$2">
            <YStack bg="$color4" h={14} w="30%" br="$2" />
            <YStack bg="$color4" h={14} w="45%" br="$2" />
          </XStack>
        ))}
      </YStack>
    );
  }

  return (
    <YStack gap="$3" p="$4">
      {Array.from({ length: rows }).map((_, i) => (
        <XStack key={i} ai="center" gap="$3" py="$3" borderBottomWidth={0.5} borderBottomColor="$borderColor">
          <YStack h={14} f={1} bg="$color4" br="$2" />
          <YStack h={22} w={48} bg="$color4" br="$10" />
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
  return (
    <YStack f={1} ai="center" jc="center" p="$6" gap="$3">
      <Ionicons name="alert-circle" size={48} color="$statusOverdue" />
      <Text fontSize="$6" fontWeight="700" col="$color12">{title}</Text>
      <Text col="$color10" ta="center">{message}</Text>
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
  return (
    <YStack f={1} ai="center" jc="center" p="$6" gap="$3">
      <Ionicons name={icon} size={48} color="$color10" />
      <Text fontSize="$5" fontWeight="600" col="$color12">{title}</Text>
      <Text col="$color10" ta="center" fontSize="$4">{message}</Text>
      {actionLabel && onAction && (
        <Button bg="$blue10" color="$color1" onPress={onAction}>{actionLabel}</Button>
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
      right={20}
      bottom={insets.bottom + 20}
      width={extended ? undefined : 56}
      height={56}
      px={extended ? '$4' : 0}
      borderRadius="$10"
      bg="$blue10"
      color="$color1"
      elevation="$6"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      icon={<Ionicons name={iconName} size={22} color="white" />}
      pressStyle={{ scale: 0.96 }}
    >
      {extended ? label : null}
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
            borderRadius="$10"
            px="$3"
            minHeight={36}
            bg={selected ? '$blue10' : '$surface2'}
            color={selected ? '$color1' : '$color11'}
            borderWidth={selected ? 0 : 1}
            borderColor="$borderColor"
            onPress={() => onChange(option.key)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={label}
            pressStyle={{ scale: 0.98 }}
          >
            {label}
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
    <YStack px="$5" pb="$3" gap="$2" borderBottomWidth={1} borderBottomColor="$borderColor">
      <XStack ai="center" jc="space-between" gap="$3">
        <YStack f={1} gap="$1">
          <XStack ai="center" gap="$2" flexWrap="wrap">
            <Text fontSize={28} fontWeight="700" letterSpacing={0}>{title}</Text>
            {status}
          </XStack>
          {subtitle && (
            <Text fontSize={13} col="$color10" fontWeight="500">{subtitle}</Text>
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
    <XStack px="$4" pt="$5" pb="$3" ai="center" jc="space-between">
      <Button chromeless onPress={onCancel}>Cancel</Button>
      <Text fontSize={17} fontWeight="700">{title}</Text>
      {onSave ? (
        <Button chromeless onPress={onSave} disabled={saving} fontWeight="600">
          {saveLabel}
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
      <Text fontSize={11} fontWeight="700" col="$color10" letterSpacing={0.6}>
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
      px="$3" py="$3" ai="center" jc="space-between" br="$3"
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
