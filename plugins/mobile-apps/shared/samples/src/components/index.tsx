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
import { ScrollView, useWindowDimensions } from 'react-native';
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
        <XStack items="center" justify="space-between">
          <YStack gap="$1" flex={1}>
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
      <Text fontSize="$5" fontWeight="600" color="$color11">{title}</Text>
      {action && (
        <Button size="$3" hitSlop={8} chromeless onPress={action.onPress}>
          <Text fontSize="$3" color="$accentDeep">{action.label}</Text>
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
  layout = 'inline',
}: {
  label: string;
  value: string | number;
  mono?: boolean;
  layout?: 'inline' | 'stacked';
}) {
  return (
    <YStack
      flexDirection={layout === 'inline' ? 'row' : 'column'}
      justify="space-between" py="$2" gap={layout === 'inline' ? '$3' : '$1'}
    >
      <Text color="$color10" fontSize="$4" flex={layout === 'inline' ? 1 : undefined} minW={0}>{label}</Text>
      <Text
        fontSize="$4" fontWeight="500"
        fontFamily={mono ? '$mono' : undefined}
        color="$color12" text={layout === 'inline' ? 'right' : 'left'}
        flex={layout === 'inline' ? 1 : undefined} minW={0}
      >
        {String(value)}
      </Text>
    </YStack>
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
      <YStack flex={1} minW={0} gap="$0.5">
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
  label = 'Loading content',
}: {
  rows?: number;
  variant?: 'list' | 'detail' | 'form';
  label?: string;
}) {
  if (variant === 'detail') {
    return (
      <YStack flex={1} gap="$3" p="$4" role="status" aria-live="polite" aria-busy aria-label={label}>
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
    <YStack gap="$3" p="$4" role="status" aria-live="polite" aria-busy aria-label={label}>
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
      <Text role="alert" color="$color10" text="center">{message}</Text>
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
  includeBottomInset = true,
}: {
  children: React.ReactNode;
  /** Disable when a non-overlay tab bar or outer safe area already owns this edge. */
  includeBottomInset?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <YStack
      shrink={0}
      px="$4"
      pt="$3"
      pb={20 + (includeBottomInset ? insets.bottom : 0)}
      bg="$surface1"
      borderTopWidth={1}
      borderTopColor="$borderColor"
      gap="$2"
    >
      {children}
    </YStack>
  );
}

export function CompactActionBar({
  summary, actionLabel, onAction, pending = false, pendingLabel = 'Working…',
  disabled = false, error, includeBottomInset = true,
}: {
  summary: React.ReactNode;
  actionLabel: string;
  onAction: () => void;
  pending?: boolean;
  pendingLabel?: string;
  disabled?: boolean;
  error?: string;
  includeBottomInset?: boolean;
}) {
  const { fontScale } = useWindowDimensions();
  return (
    <BottomActionBar includeBottomInset={includeBottomInset}>
      {error && <Text role="alert" color="$statusOverdue">{error}</Text>}
      <XStack items="center" flexWrap="wrap" gap="$3">
        <YStack flex={1} minW={112}>{summary}</YStack>
        <Button
          flex={1} minW={fontScale > 1.25 ? '100%' : 160} minH={48} height="auto" py="$3"
          role="button" aria-label={pending ? pendingLabel : actionLabel}
          aria-busy={pending} disabled={disabled || pending} onPress={onAction}
        >
          <Button.Text shrink={1}>{pending ? pendingLabel : actionLabel}</Button.Text>
        </Button>
      </XStack>
    </BottomActionBar>
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
      style={{ flexGrow: 0, flexShrink: 0, minHeight: 56 }}
      contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 4, alignItems: 'center' }}
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
            minH={48}
            height="auto"
            py="$2"
            bg={selected ? '$accentBase' : '$surface2'}
            borderWidth={selected ? 0 : 1}
            borderColor="$borderColor"
            onPress={() => onChange(option.key)}
            role="button"
            aria-pressed={selected}
            aria-label={label}
            pressStyle={{ scale: 0.98 }}
          >
            <Button.Text color={selected ? '$accentOnAccent' : '$color11'}>{label}</Button.Text>
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
  variant = 'standard',
  backAction,
}: {
  title: string;
  subtitle?: string;
  status?: React.ReactNode;
  meta?: React.ReactNode;
  rightAction?: React.ReactNode;
  children?: React.ReactNode;
  variant?: 'standard' | 'compact';
  backAction?: { onPress: () => void; label?: string; disabled?: boolean };
}) {
  const theme = useTheme();

  return (
    <YStack
      px={variant === 'compact' ? '$4' : '$5'} pb="$3" gap="$2" shrink={0}
      borderBottomWidth={1} borderBottomColor="$borderColor"
    >
      <XStack items="center" justify="space-between" gap="$2" minH={48}>
        {backAction && (
          <Button
            chromeless minW={48} minH={48} height="auto" p="$2" shrink={0}
            onPress={backAction.onPress}
            disabled={backAction.disabled}
            role="button"
            aria-label={backAction.label ?? 'Back'}
            icon={<Ionicons name="chevron-back" size={24} color={theme.color12.val} accessible={false} />}
          />
        )}
        <YStack flex={1} minW={0} gap="$1">
          <XStack items="center" gap="$2" flexWrap="wrap">
            <Text
              fontSize={variant === 'compact' ? 20 : 28} fontWeight="700" letterSpacing={0}
              shrink={1} minW={0} role="heading"
            >{title}</Text>
            {status}
          </XStack>
          {subtitle && (
            <Text fontSize={13} color="$color10" fontWeight="500">{subtitle}</Text>
          )}
        </YStack>
        {rightAction && <XStack shrink={1} minW={0} items="center">{rightAction}</XStack>}
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
        <Button chromeless onPress={onSave} disabled={saving} aria-busy={saving}>
          <Button.Text fontWeight="600">{saving ? 'Saving…' : saveLabel}</Button.Text>
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
  const theme = useTheme();
  return (
    <XStack
      px="$3" py="$3" minH={48} gap="$3" items="center" justify="space-between" rounded="$3"
      borderWidth={1}
      borderColor={selected ? '$accentBase' : '$borderColor'}
      bg={selected ? '$accentBase' : '$background'}
      onPress={onPress}
      role="button"
      aria-label={label}
      aria-pressed={selected}
      pressStyle={{ opacity: 0.7 }}
    >
      <YStack flex={1} minW={0}>
        <Text fontSize={15} fontWeight="600" color={selected ? '$accentOnAccent' : '$color12'}>{label}</Text>
        {subtitle ? (
          <Text fontSize={12} color={selected ? '$accentOnAccent' : '$color10'} mt="$1">
            {subtitle}
          </Text>
        ) : null}
      </YStack>
      <YStack width={20} shrink={0}>
        {selected && (
          <Ionicons name="checkmark-circle" size={20} color={theme.accentOnAccent.val} accessible={false} />
        )}
      </YStack>
    </XStack>
  );
}
