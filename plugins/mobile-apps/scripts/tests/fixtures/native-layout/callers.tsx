import React from 'react';
import { Button, Text } from 'tamagui';
import { BottomActionBar, Hero, InfoRow, ScreenHeader } from '@/components';

export function ExistingCallers({ onPress }: { onPress: () => void }) {
  return (
    <>
      <Hero title="Inspection overview" />
      <Hero title="Inspection overview" subtitle="Existing explicit gradient"
        gradient="hero" action={{ label: 'Open', iconName: 'open-outline', onPress }} />
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
      <Hero
        title="Review the complete accessibility and inspection findings"
        subtitle="Long content can wrap rather than being clamped to a banner."
        backgroundColor="$surface1" foregroundColor="$text0"
        titleTypography={{ fontFamily: '$heading', fontSize: 24, fontWeight: '600', lineHeight: 30, letterSpacing: 0 }}
        subtitleTypography={{ fontFamily: '$body', fontSize: 16, fontWeight: '400', lineHeight: 24, letterSpacing: 0 }}
        actionTypography={{ fontFamily: '$body', fontSize: 16, fontWeight: '600', lineHeight: 24, letterSpacing: 0 }}
        actionPlacement="below"
        action={{ label: 'Review findings', onPress, disabled: false }}
      />
      <Hero title="Intentionally compact label" titleNumberOfLines={1} subtitleNumberOfLines={2} />
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
// @ts-expect-error A typography override must apply all role metrics, not size alone.
const partialHeroTypography = <Hero title="Reading" titleTypography={{ fontSize: 24 }} />;
void partialHeroTypography;
