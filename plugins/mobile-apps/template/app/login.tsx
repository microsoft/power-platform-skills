import {
  Button,
  Spinner,
  Text,
  YStack,
} from 'tamagui';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Redirect } from 'expo-router';
import { useAuth } from '@microsoft/power-apps-native-host';

export default function LoginScreen() {
  const { isLoading, isAuthReady, isSignedIn, signIn, error } = useAuth();
  const busy = isLoading || !isAuthReady;

  if (isSignedIn) {
    return <Redirect href="/(app)/home" />;
  }

  return (
    <YStack
      flex={1}
      alignItems="center"
      justifyContent="center"
      paddingHorizontal="$6"
      backgroundColor="$background"
      gap="$4"
    >
      <YStack
        width={72}
        height={72}
        borderRadius={18}
        backgroundColor="$blue10"
        alignItems="center"
        justifyContent="center"
        marginBottom="$2"
      >
        <MaterialCommunityIcons name="microsoft-powerpoint" size={34} color="white" />
      </YStack>

      <Text fontSize="$8" fontWeight="700" color="$color12" textAlign="center">
        Power Apps Standalone
      </Text>

      <Text fontSize="$4" color="$color10" textAlign="center" lineHeight="$5">
        Sign in to connect this app to Power Platform data.
      </Text>


      {error ? (
        <Text color="$red10" fontSize="$3" textAlign="center">
          {error.message}
        </Text>
      ) : null}

      <Button
        size="$5"
        width="100%"
        backgroundColor="$blue10"
        color="white"
        fontWeight="600"
        onPress={signIn}
        disabled={busy}
        icon={busy ? <Spinner size="small" color="white" /> : undefined}
        pressStyle={{ opacity: 0.85 }}
      >
        {isLoading ? 'Signing in...' : !isAuthReady ? 'Loading...' : 'Sign in with Microsoft'}
      </Button>
    </YStack>
  );
}
