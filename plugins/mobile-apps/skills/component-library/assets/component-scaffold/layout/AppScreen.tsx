import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { YStack } from 'tamagui';

export type AppScreenProps = {
  children: ReactNode;
  footer?: ReactNode;
  header?: ReactNode;
  maxWidth?: number;
  padding?: number;
  safeAreaEdges?: Edge[];
  scroll?: boolean;
  scrollHorizontal?: boolean;
};

export function AppScreen({ children, footer, header, maxWidth = 1200, padding = 16, safeAreaEdges = ['top', 'right', 'bottom', 'left'], scroll = true, scrollHorizontal = false }: AppScreenProps) {
  const content = (
    <YStack width="100%" maxW={maxWidth} self="center" p={padding} flex={1}>
      {children}
    </YStack>
  );

  return (
    <SafeAreaView edges={safeAreaEdges} style={{ flex: 1 }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        {header}
        {scroll ? (
          <ScrollView
            contentContainerStyle={{ flexGrow: 1 }}
            horizontal={scrollHorizontal}
            keyboardShouldPersistTaps="handled"
          >
            {content}
          </ScrollView>
        ) : content}
        {footer}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
