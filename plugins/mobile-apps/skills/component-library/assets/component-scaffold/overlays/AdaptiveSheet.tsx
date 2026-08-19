import type { ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { Dialog, Sheet, YStack } from 'tamagui';

export type AdaptiveSheetProps = {
  children: ReactNode;
  header?: ReactNode;
  onBeforeClose?: () => boolean | Promise<boolean>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  size?: 'sm' | 'md' | 'lg';
  title?: string;
};

const snapPoints = { sm: [35], md: [60], lg: [90] } as const;

export function AdaptiveSheet({ children, header, onBeforeClose, onOpenChange, open, size = 'md', title = 'Dialog' }: AdaptiveSheetProps) {
  const { width } = useWindowDimensions();
  const handleOpenChange = async (next: boolean) => {
    if (!next && onBeforeClose && !(await onBeforeClose())) return;
    onOpenChange(next);
  };

  if (width >= 768) {
    return (
      <Dialog modal open={open} onOpenChange={handleOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay opacity={0.5} />
          <Dialog.Content gap="$4" maxWidth={size === 'sm' ? 420 : size === 'md' ? 640 : 880}>
            <Dialog.Title>{title}</Dialog.Title>
            {header}
            {children}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    );
  }

  return (
    <Sheet modal open={open} onOpenChange={handleOpenChange} dismissOnSnapToBottom snapPoints={[...snapPoints[size]]}>
      <Sheet.Overlay opacity={0.5} />
      <Sheet.Frame padding="$4">
        <Sheet.Handle />
        {header}
        <YStack flex={1}>{children}</YStack>
      </Sheet.Frame>
    </Sheet>
  );
}
