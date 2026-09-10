import React from 'react';
import { Text, type TextProps } from 'tamagui';
import type { NativeTypographyTextProps } from '../tokens/native-typography';

export function TypographyText({
  typography,
  ...props
}: TextProps & { typography: NativeTypographyTextProps }) {
  return <Text {...props} {...typography} />;
}
