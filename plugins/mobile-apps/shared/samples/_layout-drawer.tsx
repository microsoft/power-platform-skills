/**
 * Drawer layout sample for Expo Router.
 * Use when: 5+ destinations, admin-style apps, or deep navigation.
 *
 * Requires: expo-router (Drawer is re-exported from @react-navigation/drawer).
 * The upstream template already ships @react-navigation/drawer — do NOT add it manually.
 *
 * File placement: app/(app)/_layout.tsx (replaces the default Stack layout).
 */
import { Drawer } from 'expo-router/drawer';
import { Ionicons } from '@expo/vector-icons';

export default function DrawerLayout() {
  return (
    <Drawer
      screenOptions={{
        headerShown: true,
        drawerType: 'front',
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
          drawerIcon: ({ color }) => <Ionicons name="clipboard-outline" size={22} color={color} />,
        }}
      />
      {/* Detail/form screens pushed onto the stack are NOT registered as drawer items.
          They navigate via router.push() from list screens. */}
    </Drawer>
  );
}
