import type { ReactNode } from 'react';
import { Dialog, Heading, XStack, YStack } from 'tamagui';

export type DrawerProps = {
  children: ReactNode;
  footer?: ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
  width?: number;
};

export function Drawer({ children, footer, onOpenChange, open, title, width = 420 }: DrawerProps) {
  return (
    <Dialog modal onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay opacity={0.45} />
        <Dialog.Content borderColor="$borderColor" borderLeftWidth={1} elevation="$3" height="100%" maxW="92%" p="$4" rounded="$5" self="flex-end" width={width}>
          <YStack flex={1} gap="$3">
            <Dialog.Title asChild><Heading size="$6">{title}</Heading></Dialog.Title>
            <YStack flex={1}>{children}</YStack>
            {footer ? <XStack justify="flex-end" gap="$2">{footer}</XStack> : null}
          </YStack>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}