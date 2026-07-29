import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AlertDialog, Button, H2, Paragraph, Separator, XStack, YStack, Text } from 'tamagui';

import { LoadingState, ErrorState, BottomActionBar, InfoRow } from '@/components';
import { formatDate } from '@/utils';
import { RecipesService } from '@/generated/services/RecipesService';

export default function RecipeDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['recipe', id],
    queryFn: () => RecipesService.get(id!),
    enabled: !!id,
  });

  const recipe = data?.data;

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <LoadingState variant="detail" rows={5} />
      </SafeAreaView>
    );
  }

  if (isError || !recipe) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <ErrorState
          title="Recipe not found"
          message={(error as Error)?.message ?? 'Try going back.'}
          onRetry={refetch}
        />
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
            {recipe.ingredients?.map((ing: string, i: number) => (
              <Text key={i}>• {ing}</Text>
            ))}
          </YStack>

          <Separator />

          <YStack gap="$2">
            <Text fontSize="$5" fontWeight="600">Steps</Text>
            {recipe.steps?.map((step: string, i: number) => (
              <XStack key={i} gap="$2">
                <Text color="$color10">{i + 1}.</Text>
                <Text flex={1}>{step}</Text>
              </XStack>
            ))}
          </YStack>
        </ScrollView>

        <BottomActionBar>
          <XStack gap="$3">
            <Button
              flex={1}
              bg="$blue10"
              icon={<Ionicons name="create-outline" size={18} color="white" />}
              onPress={() => router.push(`/recipes/${id}/edit`)}
            >
              <Button.Text color="$color1">Edit</Button.Text>
            </Button>
            <DeleteButton id={id!} onDeleted={() => router.back()} />
          </XStack>
        </BottomActionBar>
      </YStack>
    </SafeAreaView>
  );
}

function DeleteButton({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  return (
    <AlertDialog>
      <AlertDialog.Trigger asChild>
        <Button flex={1} theme="red" icon={<Ionicons name="trash-outline" size={18} />}>Delete</Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay />
        <AlertDialog.Content>
          <YStack gap="$3">
            <AlertDialog.Title>Delete recipe?</AlertDialog.Title>
            <AlertDialog.Description>This can't be undone.</AlertDialog.Description>
            <XStack gap="$3" justify="flex-end">
              <AlertDialog.Cancel asChild><Button>Cancel</Button></AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  theme="red"
                  onPress={async () => { await RecipesService.delete(id); onDeleted(); }}
                >
                  Delete
                </Button>
              </AlertDialog.Action>
            </XStack>
          </YStack>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog>
  );
}
