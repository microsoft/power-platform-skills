/**
 * Industry sample: Field Inspection List
 * Demonstrates: high contrast, large touch targets, status badges,
 * camera-forward actions, offline-ready patterns for field/ops apps.
 */
import React from 'react'
import { FlatList } from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Button, H3, H4, Paragraph, Spinner, Text, XStack, YStack } from 'tamagui'

import { useCursorListData } from '@/hooks'
import { InspectionService } from '../../src/generated/services/InspectionService'

interface Inspection {
  id: string
  title: string
  location: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  dueDate: string
  itemCount: number
}

const shadows = {
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
} as const

export default function InspectionsListScreen() {
  const router = useRouter()
  const {
    items,
    loading,
    error,
    refetch,
    refreshing,
    loadingMore,
    hasNextPage,
    loadMore,
    onRefresh,
  } = useCursorListData<Inspection>({
    queryKey: ['inspections'],
    fetchPage: ({ pageSize, skipToken }) => InspectionService.getAll({
      maxPageSize: pageSize,
      orderBy: ['dueDate asc', 'id asc'],
      select: ['id', 'title', 'location', 'status', 'dueDate', 'itemCount'],
      ...(skipToken ? { skipToken } : {}),
    } as any),
  })

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <YStack f={1} bg="$backgroundStrong">
        {/* Header — large, high-contrast for outdoor use */}
        <XStack ai="center" jc="space-between" px="$4" py="$4">
          <H3 fontWeight="700">Inspections</H3>
          <Button
            size="$4"
            bg="$blue10"
            color="$color1"
            icon={<Ionicons name="add" size={20} />}
            accessibilityLabel="New inspection"
            onPress={() => router.push('/inspection/new')}
          >
            New
          </Button>
        </XStack>

        {loading && <LoadingState />}
        {error && (
          <YStack f={1} ai="center" jc="center" p="$6" gap="$3">
            <Ionicons name="alert-circle" size={40} color="$statusOverdue" />
            <H4>Failed to load inspections</H4>
            <Paragraph ta="center" col="$color10">{error}</Paragraph>
            <Button onPress={refetch}>Try again</Button>
          </YStack>
        )}
        {!loading && !error && items.length === 0 && (
          <YStack f={1} ai="center" jc="center" p="$6" gap="$3">
            <Ionicons name="clipboard-outline" size={48} color="$color10" />
            <H4>No inspections</H4>
            <Paragraph ta="center" col="$color10">
              Create your first inspection to get started.
            </Paragraph>
            <Button bg="$blue10" color="$color1" onPress={() => router.push('/inspection/new')}>
              Create inspection
            </Button>
          </YStack>
        )}
        {!loading && !error && items.length > 0 && (
          <FlatList
            data={items}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ padding: 16 }}
            refreshing={refreshing}
            onRefresh={onRefresh}
            onEndReached={hasNextPage ? loadMore : undefined}
            onEndReachedThreshold={0.3}
            ListFooterComponent={loadingMore ? <Spinner size="small" /> : null}
            renderItem={({ item }) => (
              <InspectionRow
                item={item}
                onPress={() => router.push(`/inspection/${item.id}`)}
                onCamera={() => router.push(`/inspection/${item.id}/photo`)}
              />
            )}
          />
        )}
      </YStack>
    </SafeAreaView>
  )
}

function InspectionRow({
  item,
  onPress,
  onCamera,
}: {
  item: Inspection
  onPress: () => void
  onCamera: () => void
}) {
  return (
    <YStack
      bg="$color2"
      br="$4"
      p="$4"
      gap="$3"
      mb="$3"
      {...shadows.md}
      pressStyle={{ scale: 0.98 }}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.title} — ${item.status}`}
    >
      <XStack ai="center" jc="space-between">
        <Text fontSize="$6" fontWeight="700" numberOfLines={1} f={1}>
          {item.title}
        </Text>
        <InspectionStatusBadge status={item.status} />
      </XStack>

      <Text col="$color10" fontSize="$4" numberOfLines={1}>
        {item.location}
      </Text>

      <XStack ai="center" jc="space-between">
        <XStack ai="center" gap="$2">
          <Ionicons name="time-outline" size={14} color="$color10" />
          <Text col="$color10" fontSize="$3">
            Due {item.dueDate}
          </Text>
          <Text col="$color10" fontSize="$3">
            · {item.itemCount} items
          </Text>
        </XStack>

        {/* Camera quick-action — large touch target for field use */}
        <Button
          size="$3"
          circular
          icon={<Ionicons name="camera" size={18} />}
          accessibilityLabel="Take inspection photo"
          onPress={(e) => {
            e.stopPropagation?.()
            onCamera()
          }}
          hitSlop={8}
        />
      </XStack>
    </YStack>
  )
}

function InspectionStatusBadge({ status }: { status: Inspection['status'] }) {
  const config = {
    pending:     { label: 'Pending',     bg: '$yellow3', text: '$yellow10', icon: 'time-outline' as const },
    in_progress: { label: 'In Progress', bg: '$blue3',   text: '$blue10',   icon: 'time-outline' as const },
    completed:   { label: 'Completed',   bg: '$green3',  text: '$green10',  icon: 'checkmark-circle' as const },
    failed:      { label: 'Failed',      bg: '$red3',    text: '$red10',    icon: 'close-circle' as const },
  }
  const c = config[status]
  return (
    <XStack bg={c.bg} px="$2" py="$1" br="$10" ai="center" gap="$1">
      <Ionicons name={c.icon} size={12} color="$color10" />
      <Text fontSize="$1" fontWeight="600" col={c.text}>{c.label}</Text>
    </XStack>
  )
}

function LoadingState() {
  return (
    <YStack gap="$3" p="$4">
      {Array.from({ length: 4 }).map((_, i) => (
        <YStack key={i} bg="$color2" br="$4" p="$4" gap="$3" {...shadows.md}>
          <XStack ai="center" jc="space-between">
            <YStack h={18} w="55%" bg="$color4" br="$2" />
            <YStack h={20} w={80} bg="$color4" br="$10" />
          </XStack>
          <YStack h={14} w="70%" bg="$color4" br="$2" />
          <XStack ai="center" jc="space-between">
            <YStack h={12} w="40%" bg="$color4" br="$2" />
            <YStack h={32} w={32} bg="$color4" br={16} />
          </XStack>
        </YStack>
      ))}
    </YStack>
  )
}
