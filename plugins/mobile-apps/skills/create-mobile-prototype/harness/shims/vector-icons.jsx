import React from 'react';
import glyphMap from 'prototype-harness-glyphmaps-Ionicons.json';
import fontUrl from 'prototype-harness-Ionicons.ttf';

if (typeof document !== 'undefined' && !document.getElementById('ionicons-face')) {
  const styleElement = document.createElement('style');
  styleElement.id = 'ionicons-face';
  styleElement.textContent = `@font-face{font-family:Ionicons;src:url(${fontUrl}) format('truetype');font-display:block}`;
  document.head.appendChild(styleElement);
}

function Icon({ name, size = 24, color = 'currentColor', style, testID }) {
  const codePoint = glyphMap[name];
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
        fontFamily: 'Ionicons',
        fontSize: size,
        fontStyle: 'normal',
        fontWeight: 'normal',
        height: size,
        justifyContent: 'center',
        lineHeight: `${size}px`,
        overflow: 'hidden',
        width: size,
        ...style,
      }}
    >
      {codePoint ? String.fromCodePoint(codePoint) : ''}
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