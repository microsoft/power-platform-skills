'use strict';

const example = "execSync(`${process.env.INPUT}`)";
const matcher = /spawn\("tool", args, \{ shell: true \}\)/;

// execSync(`tool ${userInput}`);
module.exports = { example, matcher };
