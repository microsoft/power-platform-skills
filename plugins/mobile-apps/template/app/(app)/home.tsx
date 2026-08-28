import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text, YStack, useTheme } from 'tamagui';

export default function HomeScreen() {
  const theme = useTheme();

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1 }}>
      <YStack
        flex={1}
        items="center"
        justify="center"
        px="$6"
        bg="$surface0"
      >
        <YStack
          width={72}
          height={72}
          rounded="$5"
          items="center"
          justify="center"
          mb="$5"
          bg="$accentSoft"
          aria-label="Power Apps data source ready"
        >
          <Ionicons name="server-outline" size={34} color={theme.accentDeep.val} />
        </YStack>
        <Text color="$text0" fontSize="$8" fontWeight="700" text="center">
          Power Apps Standalone
        </Text>
        <Text
          maxW={360}
          mt="$3"
          color="$text2"
          fontSize="$4"
          lineHeight={23}
          text="center"
        >
          Build your first screen by connecting data sources, adding native capabilities,
          and replacing this starter view with your app workflow.
        </Text>
      </YStack>
    </SafeAreaView>
  );
}
