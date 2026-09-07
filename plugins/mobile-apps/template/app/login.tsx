import {
  Button,
  Spinner,
  Text,
  YStack,
  useTheme,
} from 'tamagui';
import { Ionicons } from '@expo/vector-icons';
import { Redirect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@microsoft/power-apps-native-host';
// @ts-ignore - power.config.json is auto-generated at build time
import powerConfig from '../power.config.json';

export default function LoginScreen() {
  const { isLoading, isAuthReady, isSignedIn, signIn, error } = useAuth();
  const theme = useTheme();
  const busy = isLoading || !isAuthReady;
  const appName = powerConfig.appDisplayName || 'Power Apps Standalone';

  if (isSignedIn) {
    return <Redirect href="/(app)/home" />;
  }

  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={{ flex: 1, backgroundColor: theme.surface0.val }}
    >
      <YStack
        flex={1}
        items="center"
        justify="center"
        px="$6"
        bg="$surface0"
        gap="$4"
      >
        <YStack
          width={72}
          height={72}
          rounded="$5"
          bg="$accentBase"
          items="center"
          justify="center"
          mb="$2"
          aria-label="Power Apps sign in"
        >
          <Ionicons name="apps-outline" size={34} color={theme.accentOnAccent.val} />
        </YStack>

        <Text fontSize="$8" fontWeight="700" color="$text0" text="center">
          {appName}
        </Text>

        <Text fontSize="$4" color="$text2" text="center" lineHeight={22}>
          Sign in with your work or school email account
        </Text>

        {error ? (
          <Text color="$statusOverdue" fontSize="$3" text="center">
            {error.message}
          </Text>
        ) : null}

        <Button
          size="$5"
          width="100%"
          maxW={360}
          bg="$accentBase"
          color="$accentOnAccent"
          fontWeight="600"
          onPress={signIn}
          disabled={busy}
          icon={busy ? <Spinner size="small" color={theme.accentOnAccent.val} /> : undefined}
          pressStyle={{ opacity: 0.85 }}
        >
          {isLoading ? 'Signing in...' : !isAuthReady ? 'Loading...' : 'Sign in with Microsoft'}
        </Button>
      </YStack>
    </SafeAreaView>
  );
}
