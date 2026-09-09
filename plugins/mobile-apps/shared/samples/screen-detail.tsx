import React from 'react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AlertDialog, Button, H2, Paragraph, Separator, XStack, YStack, Text } from 'tamagui';

import { LoadingState, ErrorState, EmptyState, BottomActionBar, InfoRow } from '@/components';
import { formatDate, normalizeDataverseGuid } from '@/utils';
import { RecipesService } from '@/generated/services/RecipesService';

// Recipe routes/fields are illustrative; use the approved Navigation Contracts
// and generated model when adapting this API example.
export default function RecipeDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = normalizeDataverseGuid(Array.isArray(params.id) ? params.id[0] : params.id);
  const router = useRouter();
  const queryClient = useQueryClient();
  const deleteInFlight = React.useRef(false);
  const navigationInFlight = React.useRef(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const [deleted, setDeleted] = React.useState(false);

  useFocusEffect(React.useCallback(() => {
    navigationInFlight.current = false;
  }, []));

  const { data: recipe, isLoading, isError, refetch } = useQuery({
    queryKey: ['recipe', id],
    queryFn: async () => {
      if (!id) throw new Error('Missing recipe ID');
      const result = await RecipesService.get(id);
      if (!result.success) throw new Error(result.error?.message ?? 'Load failed');
      return result.data ?? null;
    },
    enabled: Boolean(id) && !deleted,
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!id) throw new Error('Missing recipe ID');
      const result = await RecipesService.delete(id);
      if (!result.success) throw new Error(result.error?.message ?? 'Delete failed');
    },
  });

  const returnToList = () => {
    if (router.canGoBack()) router.back();
    else router.navigate('/recipes');
  };

  const handleDelete = async () => {
    if (deleteInFlight.current || navigationInFlight.current) return;
    deleteInFlight.current = true;
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync();
    } catch (error) {
      console.error('[RecipeDetail] delete failed', error);
      setDeleteError("Couldn't delete the recipe. Try again.");
      deleteInFlight.current = false;
      return;
    }

    setDeleted(true);
    setDeleteOpen(false);
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['recipes'] }),
      queryClient.invalidateQueries({ queryKey: ['recipe', id] }),
    ]).catch((error) => console.error('[RecipeDetail] refresh after delete failed', error));
    try {
      returnToList();
    } catch (error) {
      console.error('[RecipeDetail] exit after delete failed', error);
    }
  };

  const handleEdit = () => {
    if (navigationInFlight.current || deleteInFlight.current) return;
    navigationInFlight.current = true;
    try {
      router.navigate({ pathname: '/recipes/new', params: { editId: id! } });
    } catch (error) {
      navigationInFlight.current = false;
      console.error('[RecipeDetail] edit navigation failed', error);
      setDeleteError("Couldn't open editing. Try again.");
    }
  };

  if (!id || deleted) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <EmptyState
          title={deleted ? 'Recipe deleted' : 'Invalid recipe link'}
          message={deleted ? 'This recipe has been removed.' : 'Return to the list and open the recipe again.'}
          actionLabel="Back to recipes"
          onAction={returnToList}
        />
      </SafeAreaView>
    );
  }

  if (isLoading) {
    return <SafeAreaView style={{ flex: 1 }}><LoadingState variant="detail" rows={5} /></SafeAreaView>;
  }

  if (isError) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <ErrorState title="Couldn't load recipe" message="Try again, or return to the list." onRetry={refetch} />
      </SafeAreaView>
    );
  }

  if (!recipe) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <EmptyState title="Recipe not found" message="It may have been removed." actionLabel="Back to recipes" onAction={returnToList} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <YStack flex={1} bg="$background">
        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
          <H2>{recipe.title}</H2>
          <Paragraph color="$color10">{recipe.description}</Paragraph>
          <Separator />
          <InfoRow label="Created" value={formatDate(recipe.createdon)} />
          <InfoRow label="Servings" value={recipe.servings ?? '—'} />
          <Separator />
          <YStack gap="$2">
            <Text fontSize="$5" fontWeight="600">Ingredients</Text>
            {recipe.ingredients?.map((ingredient: string, index: number) => (
              <Text key={index}>• {ingredient}</Text>
            ))}
          </YStack>
          <Separator />
          <YStack gap="$2">
            <Text fontSize="$5" fontWeight="600">Steps</Text>
            {recipe.steps?.map((step: string, index: number) => (
              <XStack key={index} gap="$2">
                <Text color="$color10">{index + 1}.</Text>
                <Text flex={1}>{step}</Text>
              </XStack>
            ))}
          </YStack>
          {deleteError && <Text role="alert" color="$red10">{deleteError}</Text>}
        </ScrollView>

        <BottomActionBar>
          <XStack gap="$3">
            <Button flex={1} bg="$blue10" disabled={deleteMutation.isPending || deleteOpen} onPress={handleEdit}>
              <Button.Text color="$color1">Edit</Button.Text>
            </Button>
            <AlertDialog open={deleteOpen} onOpenChange={(open) => {
              if (!deleteInFlight.current) setDeleteOpen(open);
            }}>
              <AlertDialog.Trigger asChild>
                <Button flex={1} theme="red" disabled={deleteMutation.isPending} icon={<Ionicons name="trash-outline" size={18} />}>Delete</Button>
              </AlertDialog.Trigger>
              <AlertDialog.Portal>
                <AlertDialog.Overlay />
                <AlertDialog.Content>
                  <YStack gap="$3">
                    <AlertDialog.Title>Delete recipe?</AlertDialog.Title>
                    <AlertDialog.Description>This can't be undone.</AlertDialog.Description>
                    {deleteError && <Text role="alert" color="$red10">{deleteError}</Text>}
                    <XStack gap="$3" justify="flex-end">
                      <AlertDialog.Cancel asChild><Button disabled={deleteMutation.isPending}>Cancel</Button></AlertDialog.Cancel>
                      {/* Keep confirmation open while awaiting the checked result. */}
                      <Button theme="red" disabled={deleteMutation.isPending} aria-busy={deleteMutation.isPending} onPress={handleDelete}>
                        {deleteMutation.isPending ? 'Deleting…' : 'Delete recipe'}
                      </Button>
                    </XStack>
                  </YStack>
                </AlertDialog.Content>
              </AlertDialog.Portal>
            </AlertDialog>
          </XStack>
        </BottomActionBar>
      </YStack>
    </SafeAreaView>
  );
}
