# Trust and Input Patterns

## 6. Biometric Auth / Reveal Gate

Used for: finance balances, health records, sensitive data.

```tsx
const [revealed, setRevealed] = React.useState(false)

// Blurred balance that reveals on tap
<Pressable onPress={async () => {
  const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Verify to view balance' })
  if (result.success) setRevealed(true)
}}>
  {revealed ? (
    <Animated.Text entering={FadeIn.duration(400)}>
      <Text fontSize="$9" fontWeight="700" fontFamily="$mono">$12,450.00</Text>
    </Animated.Text>
  ) : (
    <XStack items="center" gap="$2">
      <Text fontSize="$9" fontWeight="700" color="$color6">••••••</Text>
      <Eye size={20} color="$color10" />
    </XStack>
  )}
</Pressable>
```

**Rules:**
- Default to hidden on app open for sensitive values
- Show dots/blur, not empty space — user must know data exists
- Tap-to-reveal with biometric prompt
- Animate the reveal (FadeIn) so it feels intentional

---

## 7. Session Timeout Warning

Used for: finance, enterprise, health — any app with auth sessions.

```tsx
<AlertDialog open={showTimeout}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay />
    <AlertDialog.Content p="$5" gap="$4" items="center">
      <Clock size={40} color="$color9" />
      <H4 fontWeight="700" text="center">Session expiring</H4>
      <Text color="$color9" text="center">
        Your session will expire in {countdown}s due to inactivity.
      </Text>
      <XStack gap="$3" width="100%">
        <Button flex={1} size="$4" onPress={logout}>Log out</Button>
        <Button flex={1} size="$4" theme="blue" onPress={extendSession}>Stay signed in</Button>
      </XStack>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog>
```

---

## 8. Offline Sync Queue UI

Used for: field apps, any app that works without connectivity.

```tsx
// Sync status bar — sticky at top of list screens
{pendingCount > 0 && (
  <XStack bg="$yellow3" px="$4" py="$2" items="center" justify="space-between">
    <XStack items="center" gap="$2">
      <CloudOff size={16} color="$yellow10" />
      <Text fontSize="$2" color="$yellow10" fontWeight="600">
        {pendingCount} changes pending sync
      </Text>
    </XStack>
    <Button size="$2" chromeless onPress={retrySync}>
      <Text fontSize="$2" color="$yellow10" fontWeight="600">Retry</Text>
    </Button>
  </XStack>
)}

// Per-item sync indicator in list rows
<XStack items="center" gap="$1">
  {item.syncStatus === 'pending' && <CloudOff size={12} color="$yellow10" />}
  {item.syncStatus === 'syncing' && <RefreshCw size={12} color="$blue10" />}
  {item.syncStatus === 'failed' && <AlertTriangle size={12} color="$red10" />}
</XStack>
```

---

## 9. Safety / Priority Alert Banner

Used for: field apps, health alerts, system warnings. Pinned above scrollable content.

```tsx
// Pinned at top, above ScrollView
{activeAlert && (
  <XStack
    bg={activeAlert.severity === 'critical' ? '$red3' : '$yellow3'}
    px="$4" py="$3" items="center" gap="$3">
    <AlertTriangle size={20}
      color={activeAlert.severity === 'critical' ? '$red10' : '$yellow10'} />
    <YStack flex={1}>
      <Text fontWeight="700" fontSize="$2"
        color={activeAlert.severity === 'critical' ? '$red10' : '$yellow10'}>
        {activeAlert.title}
      </Text>
      <Text fontSize="$1"
        color={activeAlert.severity === 'critical' ? '$red9' : '$yellow9'}>
        {activeAlert.message}
      </Text>
    </YStack>
    <Button size="$2" chromeless onPress={() => dismissAlert(activeAlert.id)}>
      <X size={16} color="$color9" />
    </Button>
  </XStack>
)}
```

**Severity levels:**
- `critical` — red background, non-dismissable until acknowledged
- `warning` — yellow background, dismissable
- `info` — blue background, dismissable

---

## 10. Voice Input Button

Used for: field data entry with gloved hands, accessibility.

```tsx
<XStack items="center" gap="$2">
  <Input flex={1} placeholder="Enter notes..." value={value}
    onChange={event => onChange(event.target?.value ?? event.nativeEvent?.text ?? '')} />
  <Button size="$3" circular chromeless
    icon={isListening ? MicOff : Mic}
    color={isListening ? '$red10' : '$color9'}
    onPress={toggleVoiceInput}
  />
</XStack>
```

Requires `expo-speech` or platform speech-to-text API. The button is a UI-only pattern — actual speech recognition depends on available libraries.

---
