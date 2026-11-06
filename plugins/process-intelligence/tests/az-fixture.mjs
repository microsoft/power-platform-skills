// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { FakeAz, token } from './helpers.mjs';
import { appendFileSync } from 'node:fs';
if (process.env.FIXTURE_AZ_REPORT) appendFileSync(process.env.FIXTURE_AZ_REPORT, JSON.stringify(process.argv.slice(2)) + '\n');
const args = process.argv.slice(2), cli = new FakeAz();
const resource = args[args.indexOf('--resource') + 1];
if (resource === 'https://api.bap.microsoft.com')
  cli.tokenOutput = token({ aud: resource });
const output = await cli.run(args);
process.stdout.write(output.stdout); process.stderr.write(output.stderr); process.exitCode = output.code;
