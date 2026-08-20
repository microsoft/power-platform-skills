import type { ReactNode } from 'react';
import { Button, Popover, Text, XStack, YStack } from 'tamagui';

export type ContextMenuItem = { disabled?: boolean; icon?: ReactNode; label: string; onPress: () => void };

export type ContextMenuProps = {
  items: ContextMenuItem[];
  trigger: ReactNode;
};

export function ContextMenu({ items, trigger }: ContextMenuProps) {
  return (
    <Popover placement="bottom-end">
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Content bg="$background" borderColor="$borderColor" borderWidth={1} elevation="$2" p="$2" rounded="$4">
        <YStack minW={180} gap="$1">
          {items.map((item) => (
            <Button chromeless disabled={item.disabled} justify="flex-start" key={item.label} onPress={item.onPress}>
              <XStack gap="$2" items="center">{item.icon}<Text>{item.label}</Text></XStack>
            </Button>
          ))}
        </YStack>
      </Popover.Content>
    </Popover>
  );
}