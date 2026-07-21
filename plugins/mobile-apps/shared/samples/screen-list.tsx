import React from 'react';
import { FlatList, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Input, Paragraph, Spinner, XStack, YStack, Text } from 'tamagui';

import {
  LoadingState,
  ErrorState,
  EmptyState,
  ScreenHeader,
} from '@/components';
import { useCursorListData } from '@/hooks';
import { containsFilter, formatDate } from '@/utils';
import { RecipesService } from '@/generated/services/RecipesService';
import type { Recipe } from '@/generated/models/RecipesModel';

export default function RecipesListScreen() {
  const router = useRouter();
  const {
    items,
    loading,
    refreshing,
    loadingMore,
    hasNextPage,
    error,
    query,
    setQuery,
    onRefresh,
    refetch,
    loadMore,
  } = useCursorListData<Recipe>({
    queryKey: ['recipes'],
    fetchPage: ({ pageSize, search, skipToken }) => RecipesService.getAll({
      maxPageSize: pageSize,
      orderBy: ['createdon desc', 'id asc'],
      select: ['id', 'title', 'description', 'createdon'],
      ...(search ? { filter: containsFilter('title', search) } : {}),
      ...(skipToken ? { skipToken } : {}),
    } as any),
  });

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <YStack f={1} bg="$background">
        <ScreenHeader
          title="Recipes"
          subtitle={`${items.length} recipe${items.length === 1 ? '' : 's'}`}
          rightAction={
            <Button
              size="$3"
              circular
              icon={<Ionicons name="add" size={20} />}
              accessibilityLabel="Add recipe"
              onPress={() => router.push('/recipes/new')}
            />
          }
        />

        <XStack px="$4" pb="$2" pt="$2">
          <Input
            f={1}
            size="$4"
            placeholder="Search recipes…"
            value={query}
            onChangeText={setQuery}
          />
        </XStack>

        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : (
          <FlatList
            data={items}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ padding: 16, flexGrow: 1 }}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
            }
            onEndReached={hasNextPage ? loadMore : undefined}
            onEndReachedThreshold={0.3}
            ListFooterComponent={loadingMore ? <Spinner size="small" /> : null}
            ListEmptyComponent={
              <EmptyState
                icon={query ? 'search-outline' : 'book-outline'}
                title={query ? 'No matches' : 'No recipes yet'}
                message={query ? 'Try a different search term.' : 'Add your first recipe to get started.'}
                actionLabel={query ? 'Clear search' : 'Add a recipe'}
                onAction={query ? () => setQuery('') : () => router.push('/recipes/new')}
              />
            }
            renderItem={({ item }) => (
              <RecipeRow item={item} onPress={() => router.push(`/recipes/${item.id}`)} />
            )}
          />
        )}
      </YStack>
    </SafeAreaView>
  );
}

function RecipeRow({ item, onPress }: { item: Recipe; onPress: () => void }) {
  return (
    <YStack
      bg="$color2"
      br="$4"
      p="$4"
      gap="$2"
      mb="$3"
      pressStyle={{ scale: 0.98 }}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.title}`}
    >
      <XStack ai="center" jc="space-between">
        <Text fontSize="$6" fontWeight="700" numberOfLines={1} f={1}>{item.title}</Text>
        <Text fontSize="$2" col="$color10">{formatDate(item.createdon)}</Text>
      </XStack>
      <Paragraph col="$color10" numberOfLines={2}>{item.description}</Paragraph>
    </YStack>
  );
}
