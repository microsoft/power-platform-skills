/**
 * Industry sample: Enterprise Dashboard (Productivity / CRM)
 * Demonstrates: dense layout, stat cards, quick-actions,
 * minimal near-monochrome palette, strong grid for productivity apps.
 */
import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Button, H3, H4, H5, Paragraph, Separator, Text, XStack, YStack } from 'tamagui'

import { DashboardService } from '../../src/generated/services/DashboardService'

interface DashboardData {
  stats: { label: string; value: string; trend?: string; trendUp?: boolean }[]
  recentTasks: { id: string; title: string; status: 'done' | 'in_progress' | 'overdue'; assignee: string }[]
  quickActions: { label: string; route: string; icon: string }[]
}

const shadows = {
  sm: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
  md: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 3 },
} as const

export default function DashboardScreen() {
  const router = useRouter()
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: DashboardService.getSummary,
  })

  if (isLoading) return <DashboardSkeleton />

  if (isError) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
        <YStack f={1} ai="center" jc="center" p="$6" gap="$3">
          <Ionicons name="alert-circle" size={40} color="$statusOverdue" />
          <H4>Dashboard unavailable</H4>
          <Paragraph ta="center" col="$color10">{(error as Error).message}</Paragraph>
          <Button onPress={refetch}>Retry</Button>
        </YStack>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <YStack f={1} bg="$backgroundStrong" p="$4" gap="$4">
          <H3 fontWeight="700">Dashboard</H3>

          {/* Stat cards — 2-column grid */}
          <XStack flexWrap="wrap" gap="$3">
            {data?.stats.map((stat, i) => (
              <StatCard key={i} {...stat} />
            ))}
          </XStack>

          {/* Quick actions row */}
          <YStack gap="$2">
            <H5 fontWeight="600" col="$color10">Quick Actions</H5>
            <XStack gap="$3" flexWrap="wrap">
              <QuickActionButton
                label="New Task"
                icon={<Ionicons name="checkbox-outline" size={20} />}
                onPress={() => router.push('/task/new')}
              />
              <QuickActionButton
                label="Team"
                icon={<Ionicons name="people-outline" size={20} />}
                onPress={() => router.push('/team')}
              />
              <QuickActionButton
                label="Reports"
                icon={<Ionicons name="trending-up" size={20} />}
                onPress={() => router.push('/reports')}
              />
              <QuickActionButton
                label="Messages"
                icon={<Ionicons name="chatbubble-outline" size={20} />}
                onPress={() => router.push('/messages')}
              />
            </XStack>
          </YStack>

          <Separator />

          {/* Recent tasks — dense list */}
          <YStack gap="$2">
            <XStack ai="center" jc="space-between">
              <H5 fontWeight="600" col="$color10">Recent Tasks</H5>
              <Button
                size="$2"
                chromeless
                iconAfter={<Ionicons name="arrow-up" size={16} />}
                onPress={() => router.push('/tasks')}
              >
                View all
              </Button>
            </XStack>

            {data?.recentTasks.length === 0 && (
              <YStack ai="center" p="$4" gap="$2">
                <Ionicons name="grid-outline" size={32} color="$color10" />
                <Paragraph col="$color10">No recent tasks</Paragraph>
              </YStack>
            )}

            {data?.recentTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onPress={() => router.push(`/task/${task.id}`)}
              />
            ))}
          </YStack>
        </YStack>
      </ScrollView>
    </SafeAreaView>
  )
}

function StatCard({
  label,
  value,
  trend,
  trendUp,
}: {
  label: string
  value: string
  trend?: string
  trendUp?: boolean
}) {
  return (
    <YStack
      bg="$color2"
      br="$4"
      p="$3"
      gap="$1"
      width="47%"
      {...shadows.sm}
    >
      <Text fontSize="$2" col="$color10" fontWeight="500">{label}</Text>
      <Text fontSize="$8" fontWeight="700">{value}</Text>
      {trend && (
        <Text
          fontSize="$1"
          col={trendUp ? '$green10' : '$red10'}
          fontWeight="600"
        >
          {trendUp ? '↑' : '↓'} {trend}
        </Text>
      )}
    </YStack>
  )
}

function QuickActionButton({
  label,
  icon,
  onPress,
}: {
  label: string
  icon: React.ReactNode
  onPress: () => void
}) {
  return (
    <YStack
      ai="center"
      gap="$1"
      p="$3"
      br="$3"
      bg="$color2"
      pressStyle={{ scale: 0.98 }}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      width="22%"
      {...shadows.sm}
    >
      {icon}
      <Text fontSize="$1" fontWeight="500" numberOfLines={1}>{label}</Text>
    </YStack>
  )
}

function TaskRow({
  task,
  onPress,
}: {
  task: { id: string; title: string; status: string; assignee: string }
  onPress: () => void
}) {
  const statusConfig: Record<string, { bg: string; text: string; label: string }> = {
    done:        { bg: '$green3', text: '$green10', label: 'Done' },
    in_progress: { bg: '$blue3',  text: '$blue10',  label: 'Active' },
    overdue:     { bg: '$red3',   text: '$red10',   label: 'Overdue' },
  }
  const c = statusConfig[task.status] ?? statusConfig.in_progress

  return (
    <XStack
      ai="center"
      jc="space-between"
      py="$2"
      px="$3"
      bg="$color2"
      br="$3"
      pressStyle={{ scale: 0.98 }}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${task.title} — ${c.label}`}
    >
      <YStack f={1} gap="$1" mr="$2">
        <Text fontSize="$4" fontWeight="600" numberOfLines={1}>{task.title}</Text>
        <Text fontSize="$2" col="$color10">{task.assignee}</Text>
      </YStack>
      <XStack bg={c.bg} px="$2" py="$1" br="$10">
        <Text fontSize="$1" fontWeight="600" col={c.text}>{c.label}</Text>
      </XStack>
    </XStack>
  )
}

function DashboardSkeleton() {
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <YStack f={1} bg="$backgroundStrong" p="$4" gap="$4">
        <YStack h={28} w="40%" bg="$color4" br="$2" />
        {/* Stat card skeletons */}
        <XStack flexWrap="wrap" gap="$3">
          {Array.from({ length: 4 }).map((_, i) => (
            <YStack key={i} bg="$color2" br="$4" p="$3" gap="$2" width="47%" {...shadows.sm}>
              <YStack h={10} w="50%" bg="$color4" br="$2" />
              <YStack h={24} w="60%" bg="$color4" br="$2" />
            </YStack>
          ))}
        </XStack>
        {/* Quick action skeletons */}
        <XStack gap="$3">
          {Array.from({ length: 4 }).map((_, i) => (
            <YStack key={i} ai="center" p="$3" br="$3" bg="$color2" width="22%">
              <YStack h={20} w={20} bg="$color4" br={10} />
              <YStack h={10} w="80%" bg="$color4" br="$2" mt="$1" />
            </YStack>
          ))}
        </XStack>
        <Separator />
        {/* Task row skeletons */}
        {Array.from({ length: 5 }).map((_, i) => (
          <XStack key={i} ai="center" py="$2" px="$3" bg="$color2" br="$3">
            <YStack f={1} gap="$1" mr="$2">
              <YStack h={14} w="70%" bg="$color4" br="$2" />
              <YStack h={10} w="40%" bg="$color4" br="$2" />
            </YStack>
            <YStack h={20} w={60} bg="$color4" br="$10" />
          </XStack>
        ))}
      </YStack>
    </SafeAreaView>
  )
}
