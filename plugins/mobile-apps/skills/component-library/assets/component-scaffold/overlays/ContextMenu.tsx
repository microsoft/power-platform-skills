import type { ReactNode } from 'react';
import { Button, Popover, YStack } from 'tamagui';

export type ContextMenuItem = { disabled?: boolean; icon?: ReactNode; label: string; onPress: () => void };

export type ContextMenuProps = {
  items: ContextMenuItem[];
  trigger: ReactNode;
};

export function ContextMenu({ items, trigger }: ContextMenuProps) {
  return (
    <Popover placement="bottom-end">
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Content borderColor="$borderColor" borderWidth={1} padding="$2">
        <YStack minWidth={180} gap="$1">
          {items.map((item) => <Button chromeless disabled={item.disabled} icon={item.icon} justify="flex-start" key={item.label} onPress={item.onPress}>{item.label}</Button>)}
        </YStack>
      </Popover.Content>
    </Popover>
  );
}