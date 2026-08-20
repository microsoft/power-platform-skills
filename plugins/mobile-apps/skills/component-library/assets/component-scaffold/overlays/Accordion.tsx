import type { ReactNode } from 'react';
import { Accordion as TamaguiAccordion, Paragraph, Square } from 'tamagui';

export type AccordionItem = { content: ReactNode; disabled?: boolean; title: string; value: string };

export type AccordionProps = {
  indicator?: (open: boolean) => ReactNode;
  items: AccordionItem[];
  multiple?: boolean;
};

export function Accordion({ indicator, items, multiple = false }: AccordionProps) {
  return (
    <TamaguiAccordion backgroundColor="$background" borderColor="$borderColor" borderRadius="$4" borderWidth={1} collapsible overflow="hidden" type={multiple ? 'multiple' : 'single'}>
      {items.map((item, itemIndex) => (
        <TamaguiAccordion.Item borderBottomColor="$borderColor" borderBottomWidth={itemIndex < items.length - 1 ? 1 : 0} disabled={item.disabled} key={item.value} value={item.value}>
          <TamaguiAccordion.Trigger backgroundColor="$background" flexDirection="row" justify="space-between" paddingHorizontal="$3" paddingVertical="$2">
            {({ open }) => <><Paragraph>{item.title}</Paragraph><Square accessible={false} rotate={indicator ? '0deg' : open ? '180deg' : '0deg'}>{indicator?.(open) ?? 'v'}</Square></>}
          </TamaguiAccordion.Trigger>
          <TamaguiAccordion.HeightAnimator animation="medium">
            <TamaguiAccordion.Content animation="medium" backgroundColor="$backgroundStrong" padding="$3">{item.content}</TamaguiAccordion.Content>
          </TamaguiAccordion.HeightAnimator>
        </TamaguiAccordion.Item>
      ))}
    </TamaguiAccordion>
  );
}