import React from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useFocusEffect, useRouter } from 'expo-router'
import { Controller, useForm } from 'react-hook-form'
import { BackHandler, KeyboardAvoidingView, Platform, ScrollView } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  AlertDialog,
  Button,
  Form,
  H3,
  Input,
  Label,
  Switch,
  Text,
  TextArea,
  XStack,
  YStack,
} from 'tamagui'
import { z } from 'zod'

const recipeSchema = z.object({
  title: z.string().min(1, 'Title is required').max(100),
  description: z.string().max(500).optional(),
  servings: z.coerce.number().int().positive().max(100),
  isPublic: z.boolean().default(false),
})

type RecipeForm = z.infer<typeof recipeSchema>

export default function RecipeFormScreen() {
  const router = useRouter()
  const [showSuccess, setShowSuccess] = React.useState(false)
  const [discardOpen, setDiscardOpen] = React.useState(false)

  const { control, handleSubmit, formState } = useForm<RecipeForm>({
    resolver: zodResolver(recipeSchema),
    mode: 'onBlur',
    defaultValues: { title: '', description: '', servings: 2, isPublic: false },
  })

  // Android hardware back button — dirty-form guard (screen-builder rule 31).
  // iOS swipe-back is handled by Stack navigator + AlertDialog on the Cancel button.
  useFocusEffect(
    React.useCallback(() => {
      if (Platform.OS !== 'android') return
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (formState.isDirty) {
          setDiscardOpen(true)
          return true   // consumed — do not pop
        }
        return false   // let nav handle it
      })
      return () => sub.remove()
    }, [formState.isDirty]),
  )

  const onSubmit = async (values: RecipeForm) => {
    // call mutation...
    setShowSuccess(true)
    setTimeout(() => {
      setShowSuccess(false)
      router.back()
    }, 1200)
  }

  const onInvalid = () => {
    // Validation failed — inline error messages under each field already render.
  }

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          <Form onSubmit={handleSubmit(onSubmit, onInvalid)}>
            <YStack gap="$4" p="$4">
              <H3 fontWeight="700">New Recipe</H3>

              <Controller
                control={control}
                name="title"
                render={({ field, fieldState }) => (
                  <YStack gap="$2">
                    <Label htmlFor="title">Title</Label>
                    <Input
                      id="title"
                      size="$4"
                      autoComplete="off"
                      returnKeyType="next"
                      value={field.value}
                      onChangeText={field.onChange}
                      onBlur={field.onBlur}
                    />
                    {fieldState.error && (
                      <Text col="$red10" fontSize="$2">{fieldState.error.message}</Text>
                    )}
                  </YStack>
                )}
              />

              <Controller
                control={control}
                name="description"
                render={({ field, fieldState }) => (
                  <YStack gap="$2">
                    <Label htmlFor="description">Description</Label>
                    <TextArea
                      id="description"
                      size="$4"
                      numberOfLines={4}
                      returnKeyType="default"
                      value={field.value ?? ''}
                      onChangeText={field.onChange}
                      onBlur={field.onBlur}
                    />
                    {fieldState.error && (
                      <Text col="$red10" fontSize="$2">{fieldState.error.message}</Text>
                    )}
                  </YStack>
                )}
              />

              <Controller
                control={control}
                name="servings"
                render={({ field, fieldState }) => (
                  <YStack gap="$2">
                    <Label htmlFor="servings">Servings</Label>
                    <Input
                      id="servings"
                      size="$4"
                      keyboardType="number-pad"
                      inputMode="numeric"
                      returnKeyType="done"
                      value={String(field.value ?? '')}
                      onChangeText={(t) => field.onChange(Number(t) || 0)}
                      onBlur={field.onBlur}
                    />
                    {fieldState.error && (
                      <Text col="$red10" fontSize="$2">{fieldState.error.message}</Text>
                    )}
                  </YStack>
                )}
              />

              <Controller
                control={control}
                name="isPublic"
                render={({ field }) => (
                  <XStack ai="center" jc="space-between" gap="$3" py="$2">
                    <YStack f={1} gap="$1">
                      <Label htmlFor="isPublic">Public recipe</Label>
                      <Text fontSize="$2" col="$color10">Share with others in your org.</Text>
                    </YStack>
                    <Switch
                      id="isPublic"
                      size="$3"
                      checked={field.value}
                      onCheckedChange={(next) => {
                        field.onChange(next)
                      }}
                    >
                      <Switch.Thumb animation="quick" />
                    </Switch>
                  </XStack>
                )}
              />

              <XStack gap="$3" mt="$4">
                <CancelButton
                  isDirty={formState.isDirty}
                  open={discardOpen}
                  onOpenChange={setDiscardOpen}
                />
                <Form.Trigger asChild>
                  <Button
                    f={1}
                    theme="active"
                    disabled={!formState.isValid || formState.isSubmitting}
                  >
                    {formState.isSubmitting ? 'Saving…' : 'Save'}
                  </Button>
                </Form.Trigger>
              </XStack>

              {showSuccess && (
                <YStack ai="center" p="$3" bg="$green3" br="$3">
                  <Text col="$green10" fontWeight="600">Recipe saved!</Text>
                </YStack>
              )}
            </YStack>
          </Form>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

/** Cancel with dirty-form confirmation dialog (controlled — also opened by Android BackHandler). */
function CancelButton({
  isDirty,
  open,
  onOpenChange,
}: {
  isDirty: boolean
  open: boolean
  onOpenChange: (next: boolean) => void
}) {
  const router = useRouter()

  if (!isDirty) {
    return <Button f={1} onPress={() => router.back()}>Cancel</Button>
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Trigger asChild>
        <Button f={1} onPress={() => onOpenChange(true)}>Cancel</Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay />
        <AlertDialog.Content>
          <YStack gap="$3">
            <AlertDialog.Title>Discard changes?</AlertDialog.Title>
            <AlertDialog.Description>
              You have unsaved changes that will be lost.
            </AlertDialog.Description>
            <XStack gap="$3" jc="flex-end">
              <AlertDialog.Cancel asChild><Button>Keep editing</Button></AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button theme="red" onPress={() => router.back()}>Discard</Button>
              </AlertDialog.Action>
            </XStack>
          </YStack>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog>
  )
}
