#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { materializePrototypeImages } = require('./lib/prototype-image-assets');

async function main(argv = process.argv.slice(2)) {
  try {
    let root;
    let receipt;
    let check = false;
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === '--project-root') root = argv[++index];
      else if (argv[index] === '--receipt') receipt = argv[++index];
      else if (argv[index] === '--check') check = true;
      else throw new Error('Expected --project-root and optional --check or --receipt');
    }
    if (!root) throw new Error('--project-root is required');
    root = path.resolve(root);
    const client = process.env.MOBILE_AUTHORING_CONTEXT || process.env.MOBILE_AUTHORING_RUNNER_TOKEN
      ? require('./lib/mobile-authoring-transport').createClient({ projectRoot: root }) : null;
    let planBinding;
    if (client && !check) {
      if (!receipt) throw new Error('Player sample-image downloads require the owning signed plan receipt');
      const saved = await client.verifySavedDecision(receipt, { action: 'approve' });
      if (saved.question.kind !== 'plan' || saved.binding.type !== 'artifacts'
        || !saved.binding.files.some(entry => entry.path === '.tmp/scenario-facts.json')) {
        throw new Error('The sample-image plan must bind the canonical scenario facts');
      }
      planBinding = saved.binding;
    }
    const result = await materializePrototypeImages(root, { check,
      ...(client ? { verify: async () => {
        await client.verify({ refresh: true });
        if (planBinding && require('./lib/mobile-authoring-decisions').currentBinding(root, planBinding).sourceRevision !== planBinding.sourceRevision) {
          throw new Error('The approved sample-image plan changed; request a new decision before downloading');
        }
      } } : {}),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`materialize-prototype-images: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) main().then(exitCode => { process.exitCode = exitCode; });
module.exports = { main };