import React from 'react';
import { View } from 'react-native';

export function LinearGradient({ colors = [], start: _start, end: _end, locations: _locations, style, ...props }) {
  return (
    <View
      {...props}
      style={[style, colors[colors.length - 1] ? { backgroundColor: colors[colors.length - 1] } : null]}
    />
  );
}
