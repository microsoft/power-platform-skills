'use strict';
// A coded refusal for a page whose elements nest too deeply to compile.
//
// TypeScript parses and transforms a page with recursive functions, one level of recursion per nested JSX element (and one more per nested
// expression). Around a thousand nested elements exhaust V8's default stack, and the compiler then throws
//   RangeError: Maximum call stack size exceeded
// out of `transpileModule`. The SDK compiles a page on every push that changes its source and does not catch that, so without this module the
// maker was shown a bare RangeError — or, through the page backend's own settling of a push that "got no usable answer", a message about a
// create that "was sent twice", although the SDK compiles BEFORE it writes anything: the page was not written to the service (its metadata reads
// may already have been made).
//
// The depth that overflows is not a fixed number: the first compile in a process runs in the interpreter, whose frames are larger, so it
// overflows at roughly two thirds of the depth that a later, optimised, compile reaches (measured: a page nested 600 deep overflowed a cold
// Node 22 compile and compiled once warm). Hence no depth is checked here — the refusal follows what the compiler actually did.
//
// The overflow is attributed to the compile by wrapping the compiler itself: only a stack overflow thrown out of one of the compiler's own parse
// entry points is turned into the refusal. A RangeError from anywhere else — and every other error from the compiler — passes through untouched,
// as does every result, so a page that compiles is compiled exactly as before.

const PAGE_NESTING_TOO_DEEP = 'PAGE_NESTING_TOO_DEEP';

const PAGE_NESTING_MESSAGE = 'the elements of the page nest too deeply to compile (the compiler ran out of stack space) — '
  + 'split the page into components, so that no element sits inside hundreds of others';

// V8's stack overflow is `RangeError: Maximum call stack size exceeded`, in English whatever the locale (it is not a localised message). The error
// is recognised by its name and message, not by `instanceof RangeError`: a compiler evaluated in another realm throws that realm's RangeError.
function isStackOverflow(error) {
  return Boolean(error) && typeof error === 'object' && error.name === 'RangeError'
    && typeof error.message === 'string' && error.message.startsWith('Maximum call stack size exceeded');
}

// The compiler's entry points that recurse over a page's syntax: the transpile (which also runs the SDK's own walk over the tree, as a transformer),
// the parse and the program (the checker) the SDK builds to resolve enum names.
const GUARDED = ['transpileModule', 'createSourceFile', 'createProgram'];

// The compiler as the SDK is given it: the same object for every member except the entry points above, which throw `makeError(code, message)` when
// they overflow the stack. An object that INHERITS from the compiler, so a read of any other member (the SDK reads a few per syntax node) is the
// compiler's own and costs nothing; own properties are defined, not assigned, because the compiler's exports are getters without a setter.
// The compiler's functions use no `this`, so each is called with the compiler itself as before.
function guardPageNesting(ts, makeError) {
  const guarded = Object.create(ts);
  for (const name of GUARDED) {
    const original = ts[name];
    if (typeof original !== 'function') continue;
    Object.defineProperty(guarded, name, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: function guardedEntryPoint(...args) {
        try {
          return original.apply(ts, args);
        } catch (error) {
          if (isStackOverflow(error)) throw makeError(PAGE_NESTING_TOO_DEEP, PAGE_NESTING_MESSAGE);
          throw error;
        }
      },
    });
  }
  return guarded;
}

module.exports = { PAGE_NESTING_TOO_DEEP, PAGE_NESTING_MESSAGE, isStackOverflow, guardPageNesting };
