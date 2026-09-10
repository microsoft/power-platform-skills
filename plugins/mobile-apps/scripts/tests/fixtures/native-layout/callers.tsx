import React from 'react';
import { Button, Text } from 'tamagui';
import { BottomActionBar, InfoRow, ScreenHeader } from '@/components';

export function ExistingCallers({ onPress }: { onPress: () => void }) {
  return (
    <>
      <ScreenHeader
        title="Inspection log"
        subtitle="Recent activity"
        status={<Text>Pending</Text>}
        meta={<Text>Assigned team</Text>}
        rightAction={<Button onPress={onPress}>Options</Button>}
      >
        <Text>Additional context</Text>
      </ScreenHeader>
      <InfoRow label="Reference" value="Inspection log" mono />
      <BottomActionBar><Button onPress={onPress}>Continue</Button></BottomActionBar>
    </>
  );
}

export function OptionalLayoutCallers({ onPress }: { onPress: () => void }) {
  return (
    <>
      <ScreenHeader
        variant="compact"
        title="Reading review"
        backAction={{ onPress, label: 'Back to reviews', disabled: false }}
      />
      <InfoRow label="Review condition" value="Read the full document before approving." layout="stacked" />
      <BottomActionBar includeBottomInset={false}>
        <Button minH={48} onPress={onPress}>Approve document</Button>
      </BottomActionBar>
    </>
  );
}

// Keep the additions constrained rather than accepting arbitrary layout strings.
// @ts-expect-error The compact/standard contract is deliberately finite.
const invalidHeader = <ScreenHeader title="Reading" variant="hero-grid" />;
// @ts-expect-error The caller must choose whether it owns the inset.
const invalidInset = <BottomActionBar includeBottomInset="tabs"><Text>Review</Text></BottomActionBar>;
void invalidHeader;
void invalidInset;
