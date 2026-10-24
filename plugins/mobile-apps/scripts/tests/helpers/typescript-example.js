'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

// Node 20 has no built-in type stripping, so tests that execute a TypeScript example skip there and
// run on Node 22.13+.
const typescriptSkipReason = typeof stripTypeScriptTypes === 'function'
  ? false
  : `Executing TypeScript examples needs node:module stripTypeScriptTypes (Node 22.13+); this is Node ${process.versions.node}`;

/** The ```ts block in `markdownPath` whose first line is `// <fileComment>`. */
function typescriptBlock(markdownPath, fileComment) {
  const markdown = fs.readFileSync(markdownPath, 'utf8').replace(/\r\n?/g, '\n');
  const block = [...markdown.matchAll(/```ts\n([\s\S]*?)\n```/g)]
    .map((match) => match[1])
    .find((code) => code.startsWith(`// ${fileComment}\n`));
  if (!block) throw new Error(`Expected a ts example starting with // ${fileComment} in ${markdownPath}`);
  return block;
}

const compiled = new Map();

/** The example as a function of (require, ...globalNames) returning its exports. */
function compile(code, globalNames) {
  const key = `${globalNames.join(',')}\n${code}`;
  if (!compiled.has(key)) {
    const exported = [];
    const js = stripTypeScriptTypes(code)
      .replace(/^import \{([^}]*)\} from '([^']+)';$/gm, (_, names, source) =>
        `const {${names.replace(/\s+as\s+/g, ': ')}} = require(${JSON.stringify(source)});`)
      .replace(/^export ((?:async )?function|const|let) ([\w$]+)/gm, (_, kind, name) => {
        exported.push(name);
        return `${kind} ${name}`;
      });
    const unsupported = /^\s*(?:import|export)\b.*$/m.exec(js);
    if (unsupported) throw new Error(`Unsupported module syntax in example: ${unsupported[0].trim()}`);
    compiled.set(key, vm.runInThisContext(
      `(function (require, ${globalNames.join(', ')}) {\n${js}\nreturn { ${exported.join(', ')} };\n})`,
      { filename: 'typescript-example.js' },
    ));
  }
  return compiled.get(key);
}

/**
 * Loads a fresh instance of a TypeScript module example as the app would run it: types erased by
 * Node's own stripper, each `import { … } from` and `require()` served from `modules` (a value, or
 * a function called on every require, which may throw like a missing native module), and `globals`
 * such as `__DEV__` or a fake `Date` in scope. It runs in this realm, so results compare with
 * assert.deepStrictEqual.
 */
function loadTypescriptExample(code, { modules = {}, globals = {} } = {}) {
  const names = Object.keys(globals);
  const require = (id) => {
    if (!Object.hasOwn(modules, id)) throw new Error(`Cannot find module '${id}'`);
    return typeof modules[id] === 'function' ? modules[id]() : modules[id];
  };
  return compile(code, names)(require, ...names.map((name) => globals[name]));
}

/** A Date whose current time is `clock.now`; real Dates remain instances of it. */
function clockDate(clock) {
  const RealDate = Date;
  return class ClockDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [clock.now]));
    }

    static now() {
      return clock.now;
    }

    static [Symbol.hasInstance](value) {
      return value instanceof RealDate;
    }
  };
}

module.exports = { clockDate, loadTypescriptExample, typescriptBlock, typescriptSkipReason };
