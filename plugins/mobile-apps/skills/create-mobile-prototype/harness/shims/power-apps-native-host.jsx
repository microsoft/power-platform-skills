import React from 'react';

export function PowerAppsProvider({ children }) {
  return <>{children}</>;
}

export function useAuth() {
  return {
    account: { name: 'Prototype User', username: 'prototype@contoso.com' },
    isLoading: false,
    isSignedIn: true,
    signOut: async () => {},
  };
}

export function useThemeTokens() {
  return {
    accentBase: '#0A4F8F',
    accentOnAccent: '#FFFFFF',
    text1: '#10243B',
    text2: '#526579',
  };
}

export function FilePicker({ label = 'Choose file' }) {
  return <button style={{ minHeight: 44, minWidth: 120 }}>{label}</button>;
}

export function ImagePicker({ label = 'Choose image' }) {
  return <button style={{ minHeight: 44, minWidth: 120 }}>{label}</button>;
}