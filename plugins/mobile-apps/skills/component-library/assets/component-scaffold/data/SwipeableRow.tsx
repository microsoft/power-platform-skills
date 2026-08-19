import type { ReactNode } from 'react';
import { Swipeable } from 'react-native-gesture-handler';
import { Button, XStack } from 'tamagui';

export type SwipeRowAction = {
  destructive?: boolean;
  id: string;
  label: string;
  onPress: () => void;
};

export type SwipeableRowProps = {
  actions: SwipeRowAction[];
  children: ReactNode;
  visibleActionAlternative: ReactNode;
};

export function SwipeableRow({ actions, children, visibleActionAlternative }: SwipeableRowProps) {
  return (
    <Swipeable
      overshootRight={false}
      renderRightActions={() => (
        <XStack backgroundColor="$backgroundStrong" items="stretch">
          {actions.map((action) => (
            <Button
              accessibilityLabel={action.label}
              backgroundColor={action.destructive ? '$red9' : '$backgroundStrong'}
              borderRadius="$0"
              color={action.destructive ? '$white1' : '$color'}
              key={action.id}
              minHeight={44}
              onPress={action.onPress}
            >
              {action.label}
            </Button>
          ))}
        </XStack>
      )}
    >
      <XStack backgroundColor="$background" items="center">
        <XStack flex={1}>{children}</XStack>
        {visibleActionAlternative}
      </XStack>
    </Swipeable>
  );
}