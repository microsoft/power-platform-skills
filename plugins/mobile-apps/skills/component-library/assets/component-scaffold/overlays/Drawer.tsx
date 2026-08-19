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
        <Dialog.Overlay animation="quick" opacity={0.45} />
        <Dialog.Content alignSelf="flex-end" borderRadius={0} height="100%" maxWidth="92%" width={width}>
          <YStack flex={1} gap="$4">
            <Dialog.Title asChild><Heading size="$6">{title}</Heading></Dialog.Title>
            <YStack flex={1}>{children}</YStack>
            {footer ? <XStack justify="flex-end" gap="$2">{footer}</XStack> : null}
          </YStack>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}