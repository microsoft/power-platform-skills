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
        <AlertDialog.Content borderColor="$borderColor" borderWidth={1} elevation="$3" key="content" gap="$3" maxW={440} p="$4" rounded="$5">
          <AlertDialog.Title>{title}</AlertDialog.Title>
          <AlertDialog.Description>{description}</AlertDialog.Description>
          <XStack gap="$2" justify="flex-end">
            <AlertDialog.Cancel asChild><Button disabled={loading}>{cancelLabel}</Button></AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button accessibilityState={{ busy: loading }} bg={destructive ? '$red9' : undefined} disabled={loading} onPress={onConfirm}>
                {loading ? 'Working...' : confirmLabel}
              </Button>
            </AlertDialog.Action>
          </XStack>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog>
  );
}
