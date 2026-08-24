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
import { ScrollView, Image as RNImage } from 'react-native';
import { useRouter } from 'expo-router';
import { YStack, XStack, ZStack, Text, Button, useTheme } from 'tamagui';
import { LinearGradient } from 'expo-linear-gradient';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
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
        <Button bg="$blue10" onPress={onAction}>
          <Button.Text color="$accentOnAccent">{actionLabel}</Button.Text>
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

// ─── ScreenHeader ────────────────────────────────────────────────────────────

export type HeaderMode = 'root' | 'back' | 'close' | 'none';

export function ScreenShell({
  headerMode = 'root',
  title,
  subtitle,
  rightAction,
  onBack,
  onClose,
  fallbackHref = '/(app)/home',
  children,
}: {
  headerMode?: HeaderMode;
  title?: string;
  subtitle?: string;
  rightAction?: React.ReactNode;
  onBack?: () => void;
  onClose?: () => void;
  fallbackHref?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const handleBack = () => {
    if (onBack) return onBack();
    if (router.canGoBack()) return router.back();
    router.replace(fallbackHref as never);
  };
  const handleClose = () => {
    if (onClose) return onClose();
    handleBack();
  };

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1 }}>
      {headerMode !== 'none' && title ? (
        <ScreenHeader
          title={title}
          subtitle={subtitle}
          headerMode={headerMode}
          onBack={handleBack}
          onClose={handleClose}
          rightAction={rightAction}
        />
      ) : null}
      <YStack flex={1}>{children}</YStack>
    </SafeAreaView>
  );
}

export function ScreenHeader({
  title,
  subtitle,
  status,
  meta,
  rightAction,
  children,
  headerMode = 'root',
  onBack,
  onClose,
}: {
  title: string;
  subtitle?: string;
  status?: React.ReactNode;
  meta?: React.ReactNode;
  rightAction?: React.ReactNode;
  children?: React.ReactNode;
  headerMode?: HeaderMode;
  onBack?: () => void;
  onClose?: () => void;
}) {
  const leading = headerMode === 'back' ? (
    <Button chromeless width={48} height={48} minWidth={48} minHeight={48} onPress={onBack} aria-label="Back">
      <Ionicons name="chevron-back" size={24} />
    </Button>
  ) : headerMode === 'close' ? (
    <Button chromeless width={48} height={48} minWidth={48} minHeight={48} onPress={onClose} aria-label="Close">
      <Ionicons name="close" size={24} />
    </Button>
  ) : null;
  return (
    <YStack px="$5" pb="$3" gap="$2" borderBottomWidth={1} borderBottomColor="$borderColor">
      <XStack items="center" justify="space-between" gap="$3">
        {leading}
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

export type LocalIllustrationRecipe = {
  key: string;
  kind: 'local-illustration';
  family: string;
  label: string;
  category: string | null;
};

export type ExperienceMedia = {
  imageUrl?: string | null;
  imageAltText?: string | null;
  imageCacheKey?: string | null;
  imageAssetKey?: string | null;
};

/**
 * Renders a local illustration recipe, Dataverse base64 string, or trusted URL.
 * CDN-backed apps pass media from the canonical experience view model so Expo
 * Image can cache the URL while the local recipe remains an offline fallback.
 */
export function EntityImage({
  source,
  assetKey,
  assetRecipe,
  media,
  title,
  category,
  accessibilityLabel,
  width,
  height,
  borderRadius = 0,
  fallbackIcon = 'image-outline',
}: {
  source?: string | null;
  assetKey?: string | null;
  assetRecipe?: LocalIllustrationRecipe | null;
  media?: ExperienceMedia | null;
  title?: string;
  category?: string;
  accessibilityLabel?: string;
  width: number | string;
  height: number | string;
  borderRadius?: number;
  fallbackIcon?: IoniconName;
}) {
  const theme = useTheme();
  const imageUrl = media?.imageUrl || (source?.startsWith('http') || source?.startsWith('data:') ? source : null);
  const [remoteFailed, setRemoteFailed] = React.useState(false);
  React.useEffect(() => setRemoteFailed(false), [imageUrl]);
  const localKey = assetKey || media?.imageAssetKey || assetRecipe?.key || (source?.startsWith('asset://') ? source : null);
  const semantic = `${assetRecipe?.family || ''} ${assetRecipe?.category || ''} ${assetRecipe?.label || ''} ${category || ''} ${title || ''} ${localKey || ''}`.toLowerCase();
  const illustration = /beauty|skin|care/.test(semantic)
    ? { icon: 'sparkles' as IoniconName, label: 'Beauty collection' }
    : /watch|time/.test(semantic)
      ? { icon: 'watch-outline' as IoniconName, label: 'Watch collection' }
      : /travel|bag|accessor|journey/.test(semantic)
        ? { icon: 'briefcase-outline' as IoniconName, label: 'Travel collection' }
        : { icon: 'cube-outline' as IoniconName, label: 'Product collection' };
  const localIllustration = localKey || (!source && (title || category));

  if (imageUrl && !remoteFailed) {
    return (
      <YStack width={width} height={height} overflow="hidden" borderRadius={borderRadius} bg="$mediaSurface">
        <ExpoImage
          source={{ uri: imageUrl }}
          cachePolicy="memory-disk"
          recyclingKey={media?.imageCacheKey || imageUrl}
          contentFit="cover"
          style={{ width: '100%', height: '100%' }}
          accessible={true}
          accessibilityLabel={media?.imageAltText || accessibilityLabel || title}
          onError={() => setRemoteFailed(true)}
        />
      </YStack>
    );
  }

  if (localIllustration) {
    return (
      <YStack
        width={width}
        height={height}
        borderRadius={borderRadius}
        bg="$mediaSurface"
        overflow="hidden"
        p="$3"
        justify="space-between"
        accessibilityRole="image"
        aria-label={media?.imageAltText || accessibilityLabel || `${title || assetRecipe?.label || illustration.label} illustration`}
      >
        <YStack width={56} height={56} rounded="$10" bg="$accentSoft" items="center" justify="center">
          <Ionicons name={illustration.icon} size={28} color={theme.accentBase.val} />
        </YStack>
        <YStack gap="$1">
          {category ? <Text fontSize="$2" color="$text1" numberOfLines={1}>{category}</Text> : null}
          <Text fontSize="$4" fontWeight="700" color="$text0" numberOfLines={2}>{title || assetRecipe?.label || illustration.label}</Text>
        </YStack>
      </YStack>
    );
  }
  
  if (!source) {
    return (
      <YStack width={width} height={height} borderRadius={borderRadius} bg="$surface2" items="center" justify="center" overflow="hidden">
        <Ionicons name={fallbackIcon} size={24} color={theme.text3.val} />
      </YStack>
    );
  }

  // Handle CDN mockup urls and Dataverse base64 safely.
  const uri = source.startsWith('http') || source.startsWith('data:') ? source : `data:image/jpeg;base64,${source}`;

  return (
    <YStack width={width} height={height} overflow="hidden" borderRadius={borderRadius} bg="$surface2">
      <RNImage
        source={{ uri }}
        style={{ width: '100%', height: '100%', resizeMode: 'cover' }}
        accessible={true}
        accessibilityRole="image"
        accessibilityLabel={media?.imageAltText || accessibilityLabel || title}
      />
    </YStack>
  );
}
