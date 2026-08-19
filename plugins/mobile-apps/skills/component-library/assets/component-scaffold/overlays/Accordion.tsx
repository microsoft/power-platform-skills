import type { ReactNode } from 'react';
import { Accordion as TamaguiAccordion, Paragraph, Square } from 'tamagui';

export type AccordionItem = { content: ReactNode; disabled?: boolean; title: string; value: string };

export type AccordionProps = {
  items: AccordionItem[];
  multiple?: boolean;
};

export function Accordion({ items, multiple = false }: AccordionProps) {
  return (
    <TamaguiAccordion collapsible overflow="hidden" type={multiple ? 'multiple' : 'single'}>
      {items.map((item) => (
        <TamaguiAccordion.Item disabled={item.disabled} key={item.value} value={item.value}>
          <TamaguiAccordion.Trigger flexDirection="row" justify="space-between">
            {({ open }) => <><Paragraph>{item.title}</Paragraph><Square rotate={open ? '180deg' : '0deg'}>v</Square></>}
          </TamaguiAccordion.Trigger>
          <TamaguiAccordion.HeightAnimator animation="medium">
            <TamaguiAccordion.Content animation="medium">{item.content}</TamaguiAccordion.Content>
          </TamaguiAccordion.HeightAnimator>
        </TamaguiAccordion.Item>
      ))}
    </TamaguiAccordion>
  );
}