import React from 'react';
import { View } from 'react-native';

const DEFAULT_INSETS = { top: 0, right: 0, bottom: 20, left: 0 };
const InsetsContext = React.createContext(DEFAULT_INSETS);

export function SafeAreaProvider({ children, initialMetrics }) {
  return <InsetsContext.Provider value={initialMetrics?.insets ?? DEFAULT_INSETS}>{children}</InsetsContext.Provider>;
}

export function SafeAreaView({ children, style, ...props }) {
  const insets = React.useContext(InsetsContext);
  return (
    <View
      {...props}
      style={[
        {
          paddingTop: insets.top,
          paddingRight: insets.right,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function useSafeAreaInsets() {
  return React.useContext(InsetsContext);
}

export const initialWindowMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: DEFAULT_INSETS,
};