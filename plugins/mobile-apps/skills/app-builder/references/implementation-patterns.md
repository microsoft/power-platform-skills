# App Builder Implementation Patterns

Use these snippets as contract examples, not screen templates. Adapt names, tokens, hierarchy, breakpoints, and controls to the approved Screen Design. Verify every import against the installed package types and preserve the template's customization boundaries.

## Provider Composition

Keep `PowerAppsProvider` as the root. It already owns Gesture Handler, `ThemeProvider`, `TamaguiProvider`, portal/toast, `QueryClientProvider`, auth, and Power Apps host context. Never recreate them or instantiate `QueryClient`. Add only contexts the host does not own, such as safe-area and the app's repository composition.

```tsx
export default function AppLayout() {
  return (
    <SafeAreaProvider>
      <RepositoryProvider>
        <Stack screenOptions={{ headerShown: false }} />
      </RepositoryProvider>
    </SafeAreaProvider>
  );
}
```

`RepositoryProvider` exposes app domain repositories; it must not wrap another query provider. Repository hooks use React Query from the host-owned client.

## Semantic Theme And Typography

Configure the existing host providers rather than mounting another theme or Tamagui provider. Pass approved brand tokens through `PowerAppsProvider` and keep the app's Tamagui config supplied through its existing prop:

```tsx
<PowerAppsProvider
  msalConfig={authConfig.msal}
  powerConfig={powerConfig}
  schemaMap={schemaMap}
  tamaguiConfig={tamaguiConfig}
  theme={brandLightTheme}
  darkTheme={brandDarkTheme}
  followSystemTheme
>
  <Slot />
</PowerAppsProvider>
```

Extend the installed Tamagui config inside its customization markers. Theme names describe product roles; screens consume roles rather than hex values. Confirm the live `defaultConfig.themes` shape and run type-check immediately after adapting this pattern.

```ts
const customConfig = {
  ...defaultConfig,
  animations,
  themes: {
    ...defaultConfig.themes,
    light: {
      ...defaultConfig.themes.light,
      canvas: '#F4F1E8',
      surface: '#FFFEF9',
      identity: '#17201D',
      action: '#185ADB',
      critical: '#C64032',
      warning: '#F2C14E',
      success: '#147D64',
    },
  },
};
```

Define repeatable text roles instead of duplicating font props across screens:

```tsx
export const AppText = styled(Text, {
  name: 'AppText',
  variants: {
    role: {
      display: { fontSize: '$9', lineHeight: '$9', fontWeight: '800' },
      title: { fontSize: '$7', lineHeight: '$7', fontWeight: '700' },
      body: { fontSize: '$4', lineHeight: '$5' },
      label: { fontSize: '$3', lineHeight: '$4', fontWeight: '600' },
      caption: { fontSize: '$2', lineHeight: '$3' },
    },
  } as const,
});
```

When Screen Design requires a custom font, load it with Expo Font before dependent routes render and map its family in the live Tamagui config. Keep a deterministic installed-font fallback.

## Safe-Area Screen Shell

Use the shared `AppScreen`; do not recreate raw `ScrollView` shells in routes. Let exactly one owner protect each edge.

```tsx
export function EditScreen() {
  return (
    <AppScreen
      safeAreaEdges={['top', 'left', 'right']}
      footer={<BottomActionBar primary={<Button>Save</Button>} />}
    >
      <AppHeader title="Edit equipment" />
      <EquipmentForm />
    </AppScreen>
  );
}
```

`BottomActionBar` owns the bottom inset above, so `AppScreen` excludes `bottom`. Without an inset-owning footer or tab bar, include `bottom`. A visible native stack header may own `top`; a hidden header never does.

## Deliberate Screen Composition

Components provide behavior; Tamagui primitives establish the page-specific hierarchy. Preserve approved full-width bands and palette proportions instead of stacking default cards.

```tsx
<AppScreen>
  <YStack backgroundColor="$identity" marginHorizontal="$-4" padding="$4" gap="$2">
    <AppText color="$surface" role="caption">ACTIVE GYM</AppText>
    <AppText color="$surface" role="display">Harbor East</AppText>
  </YStack>

  <Button icon={<MaterialCommunityIcons name="qrcode-scan" size={22} />}>
    Scan equipment
  </Button>

  <XStack backgroundColor="$warning" marginHorizontal="$-4" padding="$4" gap="$5">
    <AttentionMetric label="critical" value={2} />
    <AttentionMetric label="overdue" value={3} />
  </XStack>

  <EquipmentSection />
</AppScreen>
```

The negative gutter is appropriate only when Screen Design calls for an edge-to-edge band inside a padded shell. Do not copy this composition into screens with a different focal point.

For an approved master-detail transformation, change information architecture rather than scaling the phone column:

```tsx
<XStack flex={1} gap="$5" $sm={{ flexDirection: 'column' }}>
  <YStack width={280} $sm={{ width: '100%' }}>
    <FilterRail />
  </YStack>
  <YStack flex={1} maxWidth={720}>
    <ResultsPane />
  </YStack>
</XStack>
```

Use the breakpoint names present in the live Tamagui config; adapt `$sm` when the project defines different media keys.

## Keyboard-Safe Form

Keep form state typed, errors adjacent to fields, and the submit action inside the shell's keyboard-aware fixed footer.

```tsx
const form = useForm<EquipmentInput>({ defaultValues });

<AppScreen
  safeAreaEdges={['top', 'left', 'right']}
  footer={
    <BottomActionBar
      primary={
        <Button disabled={form.formState.isSubmitting} onPress={form.handleSubmit(onSubmit)}>
          Save equipment
        </Button>
      }
    />
  }
>
  <Controller
    control={form.control}
    name="name"
    render={({ field, fieldState }) => (
      <FormField label="Equipment name" error={fieldState.error?.message}>
        <Input value={field.value} onChangeText={field.onChange} />
      </FormField>
    )}
  />
</AppScreen>
```

Connect the primary action to `form.handleSubmit`, apply the approved Zod validation without adding an unavailable resolver package, preserve values on failure, and prevent duplicate submission.

## Virtualized List

The shell owns safe areas and outer geometry; `FlatList` owns collection scrolling. Never nest it inside a vertical `ScrollView`.

```tsx
<AppScreen scroll={false}>
  <AppHeader title="Equipment" />
  <FilterBar query={query} onQueryChange={setQuery} />
  <FlatList
    data={equipment}
    keyExtractor={(item) => item.id}
    keyboardShouldPersistTaps="handled"
    contentContainerStyle={{ flexGrow: 1, paddingBottom: 16 }}
    ListEmptyComponent={<EmptyState title="No matching equipment" />}
    renderItem={({ item }) => <EquipmentRow equipment={item} />}
  />
</AppScreen>
```

## Icon Controls

Use the installed icon family consistently. Icon-only controls need a label and stable touch target; primary and unfamiliar actions retain visible text.

```tsx
<IconButton
  accessibilityLabel="Go back"
  icon={<MaterialCommunityIcons name="arrow-left" size={24} />}
  onPress={router.back}
  size={44}
/>

<Button icon={<MaterialCommunityIcons name="filter-variant" size={20} />}>
  Filters
</Button>
```

Do not substitute `Back`, Unicode arrows, emoji, or mixed icon families when Material Community Icons provides the intended symbol.

## Rendered Acceptance

After all screens and workflows are assembled, verify the real app rather than these snippets:

- every route at an iPhone-like viewport with top and bottom system insets;
- a compact viewport with increased text;
- a wide/tablet viewport;
- representative loading, empty, error, form, and fixed-action states;
- composition, palette proportion, typography, icons, overflow, and safe-area placement against Screen Design.

If no supported target can render the app, App Builder returns `BLOCKED` rather than inferring visual quality from source or type-check.