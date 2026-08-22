import React from 'react';
import { View } from 'react-native';

export const Swipeable = React.forwardRef(function Swipeable(
  { children, renderRightActions: _renderRightActions, ...props },
  ref,
) {
  React.useImperativeHandle(ref, () => ({ close() {} }), []);
  return <View {...props}>{children}</View>;
});
