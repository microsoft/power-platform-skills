// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './cli.mjs';
import { safeFailure } from './errors.mjs';

export function resolvePluginRoot(env = process.env, cwd = process.cwd()) {
  return path.resolve(env.PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT || cwd);
}

let launched;

export function launch(args = process.argv.slice(2), dependencies = {}) {
  if (launched) {
    return launched;
  }
  launched = (async () => {
    if (args.length === 0) {
      args = ['serve'];
    }
    const lifetime = new AbortController();
    const stop = () => lifetime.abort(new DOMException('Operation cancelled.', 'AbortError'));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      if (![22, 24].includes(Number(process.versions.node.split('.')[0]))) {
        console.error(
          'Process Intelligence requires supported Node.js 22 or 24 LTS. Install it explicitly.'
        );
        process.exitCode = 1;
        return 1;
      }
      if (args[0] === 'serve' && !args.includes('--profile') && process.env.PM_BRIDGE_PROFILE) {
        args = [...args, '--profile', process.env.PM_BRIDGE_PROFILE];
      }
      const code = await run(args, { ...dependencies, signal: lifetime.signal });
      process.exitCode = code;
      return code;
    } catch (error) {
      console.error(safeFailure(error));
      process.exitCode = 4;
      return 4;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  })();
  return launched;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await launch();
}
