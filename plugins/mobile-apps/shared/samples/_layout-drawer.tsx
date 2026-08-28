/**
 * Drawer layout sample for Expo Router.
 * Use when: 6+ top-level destinations, or 5+ unequal/admin/deep destinations.
 *
 * Requires: expo-router/drawer plus the template-pinned @react-navigation/drawer.
 *
 * File placement: app/(app)/_layout.tsx (replaces the default Stack layout).
 */
import { Drawer } from 'expo-router/drawer';
import { Ionicons } from '@expo/vector-icons';
import { useThemeTokens } from '@microsoft/power-apps-native-host';

export default function DrawerLayout() {
  const theme = useThemeTokens();

  return (
    <Drawer
      screenOptions={{
        headerShown: true,
        drawerType: 'front',
        drawerActiveTintColor: theme.accentBase,
        drawerInactiveTintColor: theme.text2,
        drawerStyle: { width: 280 },
      }}
    >
      <Drawer.Screen
        name="home"
        options={{
          title: 'Home',
          drawerIcon: ({ color }) => <Ionicons name="home-outline" size={22} color={color} />,
        }}
      />
      <Drawer.Screen
        name="inspections"
        options={{
          title: 'Inspections',
          headerShown: false,
          drawerIcon: ({ color }) => <Ionicons name="clipboard-outline" size={22} color={color} />,
        }}
      />
      {/* "inspections" is a folder entry. Its inner Stack owns a
          DrawerToggleButton on index and normal back buttons on children.
          Detail/form children are not registered as drawer items. */}
    </Drawer>
  );
}
