import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

export default function HomeScreen() {
  return (
    <View style={styles.container}>
      <View style={styles.iconFrame}>
        <MaterialCommunityIcons name="database-check-outline" size={34} color="#2563eb" />
      </View>
      <Text style={styles.title}>Power Apps Standalone</Text>
      <Text style={styles.subtitle}>
        Build your first screen by connecting data sources, adding native capabilities,
        and replacing this starter view with your app workflow.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    backgroundColor: '#f8fafc',
  },
  iconFrame: {
    width: 72,
    height: 72,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    backgroundColor: '#dbeafe',
  },
  title: {
    color: '#0f172a',
    fontSize: 26,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    maxWidth: 360,
    marginTop: 10,
    color: '#475569',
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'center',
  },
});


