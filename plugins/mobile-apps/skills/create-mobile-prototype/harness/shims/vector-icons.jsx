import React from 'react';

function Icon({ name, size = 24, color = 'currentColor', style, testID }) {
  return (
    <span
      aria-label={name}
      data-harness-icon={name}
      data-testid={testID}
      style={{
        alignItems: 'center',
        color,
        display: 'inline-flex',
        flex: `0 0 ${size}px`,
        fontSize: Math.max(10, Math.round(size * 0.55)),
        height: size,
        justifyContent: 'center',
        lineHeight: `${size}px`,
        overflow: 'hidden',
        width: size,
        ...style,
      }}
    >
      {'\u25cf'}
    </span>
  );
}

export const AntDesign = Icon;
export const Entypo = Icon;
export const Feather = Icon;
export const FontAwesome = Icon;
export const FontAwesome5 = Icon;
export const FontAwesome6 = Icon;
export const Fontisto = Icon;
export const Foundation = Icon;
export const Ionicons = Icon;
export const MaterialCommunityIcons = Icon;
export const MaterialIcons = Icon;
export const Octicons = Icon;
export const SimpleLineIcons = Icon;
export const Zocial = Icon;