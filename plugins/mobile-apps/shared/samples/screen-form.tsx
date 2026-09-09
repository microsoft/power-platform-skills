import React from 'react'
import { useQueryClient } from '@tanstack/react-query'
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

type RecipeForm = {
  title: string
  description: string
  servings: number
  isPublic: boolean
}

type RecipeFormScreenProps = {
  // Supply the approved generated-service adapter, not a timeout or local-state save.
  saveRecipe?: (values: RecipeForm) => Promise<{ success: boolean; error?: { message?: string } }>
}

// Tamagui types the web event; native text events expose nativeEvent.text instead.
function inputText(event: React.ChangeEvent<HTMLInputElement | HTMLDivElement>): string {
  const target = event.target
  if (target && typeof target === 'object' && 'value' in target && typeof target.value === 'string') {
    return target.value
  }
  const native = event.nativeEvent
  return native && 'text' in native && typeof native.text === 'string' ? native.text : ''
}

export default function RecipeFormScreen({ saveRecipe }: RecipeFormScreenProps = {}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const submitInFlight = React.useRef(false)
  const [showSuccess, setShowSuccess] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [discardOpen, setDiscardOpen] = React.useState(false)

  const { control, handleSubmit, formState, reset } = useForm<RecipeForm>({
    mode: 'onBlur',
    defaultValues: { title: '', description: '', servings: 2, isPublic: false },
  })

  // The generated screen must also use its approved navigator-removal guard for
  // header/gesture exits; a Cancel dialog does not protect iOS swipe-back.
  useFocusEffect(
    React.useCallback(() => {
      if (Platform.OS !== 'android') return
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (submitInFlight.current) return true
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
    if (submitInFlight.current) return
    if (!saveRecipe) {
      setSaveError('Saving is unavailable until this example is connected to a data source.')
      return
    }
    submitInFlight.current = true
    setSaveError(null)
    try {
      const result = await saveRecipe(values)
      if (!result.success) throw new Error(result.error?.message ?? 'Save failed')
    } catch (error) {
      console.error('[RecipeForm] save failed', error)
      setSaveError("Couldn't save the recipe. Your changes are still here. Try again.")
      submitInFlight.current = false
      return
    }

    // A committed save must not become a retryable create if refresh/navigation fails.
    setShowSuccess(true)
    reset(values)
    void queryClient.invalidateQueries({ queryKey: ['recipes'] }).catch((error) => {
      console.error('[RecipeForm] refresh after save failed', error)
    })
    try {
      if (router.canGoBack()) router.back()
      else router.navigate('/recipes')
    } catch (error) {
      console.error('[RecipeForm] exit after save failed', error)
      setSaveError('Recipe saved. Use Cancel to return to the list.')
    }
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
                rules={{
                  required: 'Title is required',
                  maxLength: { value: 100, message: 'Use 100 characters or fewer' },
                }}
                render={({ field, fieldState }) => (
                  <YStack gap="$2">
                    <Label htmlFor="title">Title</Label>
                    <Input
                      id="title"
                      aria-label="Title"
                      aria-invalid={fieldState.invalid}
                      size="$4"
                      autoComplete="off"
                      enterKeyHint="next"
                      value={field.value}
                      onChange={(event) => field.onChange(inputText(event))}
                      onBlur={field.onBlur}
                    />
                    {fieldState.error && (
                      <Text color="$red10" fontSize="$2">{fieldState.error.message}</Text>
                    )}
                  </YStack>
                )}
              />

              <Controller
                control={control}
                name="description"
                rules={{ maxLength: { value: 500, message: 'Use 500 characters or fewer' } }}
                render={({ field, fieldState }) => (
                  <YStack gap="$2">
                    <Label htmlFor="description">Description</Label>
                    <TextArea
                      id="description"
                      aria-label="Description"
                      aria-invalid={fieldState.invalid}
                      size="$4"
                      numberOfLines={4}
                      enterKeyHint="enter"
                      value={field.value ?? ''}
                      onChange={(event) => field.onChange(inputText(event))}
                      onBlur={field.onBlur}
                    />
                    {fieldState.error && (
                      <Text color="$red10" fontSize="$2">{fieldState.error.message}</Text>
                    )}
                  </YStack>
                )}
              />

              <Controller
                control={control}
                name="servings"
                rules={{
                  min: { value: 1, message: 'Use at least 1 serving' },
                  max: { value: 100, message: 'Use 100 servings or fewer' },
                  validate: (value) => Number.isInteger(value) || 'Use a whole number',
                }}
                render={({ field, fieldState }) => (
                  <YStack gap="$2">
                    <Label htmlFor="servings">Servings</Label>
                    <Input
                      id="servings"
                      aria-label="Servings"
                      aria-invalid={fieldState.invalid}
                      size="$4"
                      inputMode="numeric"
                      enterKeyHint="done"
                      value={String(field.value ?? '')}
                      onChange={(event) => {
                        const value = inputText(event)
                        field.onChange(Number(value) || 0)
                      }}
                      onBlur={field.onBlur}
                    />
                    {fieldState.error && (
                      <Text color="$red10" fontSize="$2">{fieldState.error.message}</Text>
                    )}
                  </YStack>
                )}
              />

              <Controller
                control={control}
                name="isPublic"
                render={({ field }) => (
                  <XStack items="center" justify="space-between" gap="$3" py="$2">
                    <YStack flex={1} gap="$1">
                      <Label htmlFor="isPublic">Public recipe</Label>
                      <Text fontSize="$2" color="$color10">Share with others in your org.</Text>
                    </YStack>
                    <Switch
                      id="isPublic"
                      aria-label="Public recipe"
                      size="$3"
                      checked={field.value}
                      onCheckedChange={(next) => {
                        field.onChange(next)
                      }}
                    >
                      <Switch.Thumb transition="quick" />
                    </Switch>
                  </XStack>
                )}
              />

              <XStack gap="$3" mt="$4">
                <CancelButton
                  isDirty={formState.isDirty}
                  disabled={formState.isSubmitting}
                  open={discardOpen}
                  onOpenChange={setDiscardOpen}
                />
                <Form.Trigger asChild>
                  <Button
                    flex={1}
                    bg="$blue10"
                    disabled={!saveRecipe || !formState.isValid || formState.isSubmitting || showSuccess}
                    aria-busy={formState.isSubmitting}
                  >
                    <Button.Text color="$color1">
                      {formState.isSubmitting ? 'Saving…' : showSuccess ? 'Saved' : 'Save'}
                    </Button.Text>
                  </Button>
                </Form.Trigger>
              </XStack>

              {!saveRecipe && (
                <Text color="$color10">
                  Example only: connect an approved save handler to enable saving.
                </Text>
              )}
              {saveError && <Text role="alert" color="$red10">{saveError}</Text>}

              {showSuccess && (
                <YStack role="status" aria-live="polite" items="center" p="$3" bg="$green3" rounded="$3">
                  <Text color="$green10" fontWeight="600">Recipe saved</Text>
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
  disabled,
  open,
  onOpenChange,
}: {
  isDirty: boolean
  disabled: boolean
  open: boolean
  onOpenChange: (next: boolean) => void
}) {
  const router = useRouter()

  if (!isDirty) {
    return <Button flex={1} disabled={disabled} onPress={() => {
      if (router.canGoBack()) router.back()
      else router.navigate('/recipes')
    }}>Cancel</Button>
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Trigger asChild>
        <Button flex={1} disabled={disabled} onPress={() => onOpenChange(true)}>Cancel</Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay />
        <AlertDialog.Content>
          <YStack gap="$3">
            <AlertDialog.Title>Discard changes?</AlertDialog.Title>
            <AlertDialog.Description>
              You have unsaved changes that will be lost.
            </AlertDialog.Description>
            <XStack gap="$3" justify="flex-end">
              <AlertDialog.Cancel asChild><Button>Keep editing</Button></AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button theme="red" onPress={() => {
                  if (router.canGoBack()) router.back()
                  else router.navigate('/recipes')
                }}>Discard</Button>
              </AlertDialog.Action>
            </XStack>
          </YStack>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog>
  )
}
