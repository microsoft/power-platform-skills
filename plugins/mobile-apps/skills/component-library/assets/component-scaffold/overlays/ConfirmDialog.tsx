import { AlertDialog, Button, XStack } from 'tamagui';

export type ConfirmDialogProps = {
  cancelLabel?: string;
  confirmLabel?: string;
  description: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
};

export function ConfirmDialog({
  cancelLabel = 'Cancel',
  confirmLabel = 'Confirm',
  description,
  destructive = false,
  loading = false,
  onConfirm,
  onOpenChange,
  open,
  title,
}: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay key="overlay" opacity={0.5} />
        <AlertDialog.Content key="content" gap="$4" maxWidth={440}>
          <AlertDialog.Title>{title}</AlertDialog.Title>
          <AlertDialog.Description>{description}</AlertDialog.Description>
          <XStack gap="$3" justify="flex-end">
            <AlertDialog.Cancel asChild><Button disabled={loading}>{cancelLabel}</Button></AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button accessibilityState={{ busy: loading }} backgroundColor={destructive ? '$red9' : undefined} disabled={loading} onPress={onConfirm}>
                {loading ? 'Working...' : confirmLabel}
              </Button>
            </AlertDialog.Action>
          </XStack>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog>
  );
}
