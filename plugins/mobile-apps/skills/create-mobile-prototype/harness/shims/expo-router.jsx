import React from 'react';

export const router = {
  back() {},
  navigate(_target) {},
  push(_target) {},
  replace(_target) {},
};

export function useRouter() {
  return router;
}

export function useNavigation() {
  return {
    addListener() {
      return () => {};
    },
    dispatch() {},
  };
}

export function useLocalSearchParams() {
  return globalThis.__HARNESS_PARAMS ?? {};
}

export function useFocusEffect(effect) {
  React.useEffect(effect, [effect]);
}

export function Redirect() {
  return null;
}

export function Link({ children, ...props }) {
  return <a {...props}>{children}</a>;
}

function Navigator({ children }) {
  return <>{children}</>;
}

Navigator.Screen = function Screen() {
  return null;
};

export const Stack = Navigator;
export const Tabs = Navigator;