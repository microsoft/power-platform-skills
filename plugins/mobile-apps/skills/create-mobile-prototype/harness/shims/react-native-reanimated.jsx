import React from 'react';
import { View } from 'react-native';

function animationBuilder() {
  const builder = {
    delay() {
      return builder;
    },
    duration() {
      return builder;
    },
    springify() {
      return builder;
    },
  };
  return builder;
}

const AnimatedView = React.forwardRef(function AnimatedView(
  { entering: _entering, exiting: _exiting, layout: _layout, ...props },
  ref,
) {
  return <View ref={ref} {...props} />;
});

const Animated = {
  View: AnimatedView,
};

export const BounceIn = animationBuilder();
export const FadeIn = animationBuilder();
export const FadeInDown = animationBuilder();
export const FadeInUp = animationBuilder();
export const FadeOut = animationBuilder();
export const FadeOutLeft = animationBuilder();
export const LinearTransition = animationBuilder();

export default Animated;
