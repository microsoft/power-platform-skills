'use strict';

/**
 * A minimal React for hook examples: `react` provides useRef and useEffect, and `mount()` creates a
 * component instance with its own refs. render() runs effects whose dependencies changed (compared
 * with Object.is), each after its previous cleanup; unmount() runs every cleanup. A sign-out that
 * unmounts a layout and a later sign-in that mounts it again are two mounts of the same module.
 */
function createHookRuntime() {
  let rendering = null;
  const react = {
    useRef: (initial) => rendering.useRef(initial),
    useEffect: (effect, deps) => rendering.useEffect(effect, deps),
  };

  function mount() {
    const slots = [];
    const cleanups = [];
    let index = 0;
    let effects = [];
    const instance = {
      useRef(initial) {
        const slot = index++;
        if (!slots[slot]) slots[slot] = { current: initial };
        return slots[slot];
      },
      useEffect(effect, deps) {
        const slot = index++;
        const previous = slots[slot];
        const unchanged = previous && deps && deps.length === previous.deps.length
          && deps.every((dep, i) => Object.is(dep, previous.deps[i]));
        if (unchanged) return;
        slots[slot] = { deps };
        effects.push(() => {
          cleanups[slot]?.();
          cleanups[slot] = effect() || undefined;
        });
      },
    };
    return {
      render(component) {
        index = 0;
        rendering = instance;
        try {
          component();
        } finally {
          rendering = null;
        }
        const pending = effects;
        effects = [];
        pending.forEach((run) => run());
      },
      unmount() {
        cleanups.splice(0).forEach((cleanup) => cleanup?.());
      },
    };
  }

  return { react, mount };
}

module.exports = { createHookRuntime };
