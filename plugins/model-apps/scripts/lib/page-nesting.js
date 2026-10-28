'use strict';
// A coded refusal for a page whose elements nest too deeply to compile.
//
// TypeScript parses and transforms a page with recursive functions, one level of recursion per nested JSX element (and one more per nested
// expression). Around a thousand nested elements exhaust V8's default stack, and the compiler then throws
//   RangeError: Maximum call stack size exceeded
// out of `transpileModule`. The SDK compiles a page on every push that changes its source, and the bundles before model-apps 2.20.5 did not catch that, so
// without this module the maker was shown a bare RangeError — or, through the page backend's own settling of a push that "got no usable answer", a message about a
// create that "was sent twice", although the SDK compiles BEFORE it writes anything: the page was not written to the service (its metadata reads
// may already have been made). The bundle now refuses such a page itself (SDK_COMPILE_DEPTH_EXCEEDED below); this module keeps the plugin's code for both.
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

// The bundled SDK refuses the same page itself: every stage of its compile — TypeScript's parse, emit and checker, and its own walks over the tree — sits behind one
// boundary that turns a stack overflow into an SdkError with this code, before any write. The guard below fires first wherever the overflow is in one of the compiler's
// entry points (measured: deep elements, and chains of operators, calls, brackets and parentheses all overflow in the parse), so the SDK's code reaches a caller only
// from a stage the guard does not wrap. It is the same refusal, so the page backend reports it as this module's (lib/genpage-sdk.js): one code and one instruction for the
// maker, whichever layer fired.
const SDK_COMPILE_DEPTH_EXCEEDED = 'GENPAGE_COMPILE_DEPTH_EXCEEDED';

// `error` as the maker is told it: the SDK's compile-depth refusal becomes `makeError(PAGE_NESTING_TOO_DEEP, PAGE_NESTING_MESSAGE)`, keeping the SDK's own error as its
// `cause`; every other error is returned as it is. The caller decides that `error` is the SDK's (an SdkError): the code alone is not the proof.
function asPageNestingRefusal(error, makeError) {
  if (!error || typeof error !== 'object' || error.code !== SDK_COMPILE_DEPTH_EXCEEDED) return error;
  const refusal = makeError(PAGE_NESTING_TOO_DEEP, PAGE_NESTING_MESSAGE);
  Object.defineProperty(refusal, 'cause', { value: error, configurable: true, writable: true, enumerable: false });
  return refusal;
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

module.exports = { PAGE_NESTING_TOO_DEEP, PAGE_NESTING_MESSAGE, SDK_COMPILE_DEPTH_EXCEEDED, isStackOverflow, guardPageNesting, asPageNestingRefusal };
