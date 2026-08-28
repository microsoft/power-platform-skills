# Work Management Patterns

## 23. Start/Stop Work Timer

Used for: field service, time tracking, billable hours, task management.

```tsx
function WorkTimer({ taskId }) {
  const [running, setRunning] = React.useState(false)
  const [elapsed, setElapsed] = React.useState(0)
  const startTime = React.useRef(null)

  React.useEffect(() => {
    if (!running) return
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime.current)
    }, 1000)
    return () => clearInterval(interval)
  }, [running])

  const toggle = () => {
    if (running) {
      setRunning(false)
      // Save elapsed time
    } else {
      startTime.current = Date.now() - elapsed
      setRunning(true)
    }
  }

  const formatTime = (ms) => {
    const s = Math.floor(ms / 1000)
    const hours = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${hours.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
  }

  return (
    <YStack items="center" gap="$4" p="$5">
      {/* Elapsed time display */}
      <Text fontSize={48} fontWeight="700" fontFamily="$mono" letterSpacing={2}>
        {formatTime(elapsed)}
      </Text>

      {/* Start/Stop button */}
      <Button size="$6" circular
        bg={running ? '$red10' : '$green10'}
        icon={running ? Square : Play}
        color="white"
        onPress={toggle}
        pressStyle={{ scale: 0.95 }}
      />
      <Text fontSize="$2" color="$color9">
        {running ? 'Tap to stop' : elapsed > 0 ? 'Tap to resume' : 'Tap to start'}
      </Text>

      {/* Elapsed summary when paused */}
      {!running && elapsed > 0 && (
        <XStack gap="$3" mt="$3">
          <Button size="$3" icon={RotateCcw} onPress={() => setElapsed(0)}>Reset</Button>
          <Button size="$3" theme="blue" icon={Save} onPress={() => saveTime(taskId, elapsed)}>Save</Button>
        </XStack>
      )}
    </YStack>
  )
}
```

**Rules:**
- Monospace font for elapsed time — digits must not shift
- Large circular start/stop button (72pt) — green for start, red for stop
- Show Reset + Save only when paused with time on the clock

---

## 24. Kanban Board View

Used for: project management, field service workflows, CRM pipelines.

```tsx
// Horizontal-scrolling kanban columns
<ScrollView horizontal showsHorizontalScrollIndicator={false}
  contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>
  {columns.map((column) => (
    <YStack key={column.id} width={280} bg="$color2" rounded="$4" overflow="hidden">
      {/* Column header */}
      <XStack items="center" justify="space-between" p="$3" bg="$color3">
        <XStack items="center" gap="$2">
          <YStack width={8} height={8} rounded={4} bg={column.color} />
          <Text fontWeight="700" fontSize="$3">{column.title}</Text>
        </XStack>
        <Text fontSize="$2" color="$color8" fontFamily="$mono">{column.items.length}</Text>
      </XStack>

      {/* Column items */}
      <ScrollView style={{ maxHeight: 500 }} contentContainerStyle={{ padding: 8, gap: 8 }}>
        {column.items.map((item) => (
          <Pressable key={item.id} onLongPress={() => startDrag(item)}>
            <YStack bg="$background" rounded="$3" p="$3" gap="$2"
              borderWidth={1} borderColor="$borderColor"
              pressStyle={{ scale: 0.98 }}>
              <Text fontWeight="600" fontSize="$2">{item.title}</Text>
              {item.subtitle && <Text fontSize="$1" color="$color9">{item.subtitle}</Text>}
              <XStack items="center" justify="space-between" mt="$1">
                {item.assignee && (
                  <YStack width={24} height={24} rounded={12} bg="$color4" items="center" justify="center">
                    <Text fontSize={10} fontWeight="600">{item.assignee.initials}</Text>
                  </YStack>
                )}
                {item.dueDate && (
                  <Text fontSize="$1" color="$color8" fontFamily="$mono">{item.dueDate}</Text>
                )}
              </XStack>
            </YStack>
          </Pressable>
        ))}
      </ScrollView>
    </YStack>
  ))}
</ScrollView>
```

**Rules:**
- Columns 280px wide, horizontal scroll between them
- Color dot in header identifies the column/status
- Cards show title, optional subtitle, assignee avatar, due date
- Long-press to initiate drag (actual drag-and-drop requires `react-native-gesture-handler` + reanimated)
- Column scroll is vertical, board scroll is horizontal — nested scrolling

---
