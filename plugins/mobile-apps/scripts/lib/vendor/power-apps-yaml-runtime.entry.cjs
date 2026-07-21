'use strict';

// Build-only entry point. Runtime consumers load the checked-in bundle next to
// this file; these package imports are resolved only when maintainers regenerate
// that bundle from the pinned versions documented in THIRD_PARTY_NOTICES.md.
const YAML = require('yaml');
const AjvModule = require('ajv');

module.exports = {
  Ajv: AjvModule.default || AjvModule,
  LineCounter: YAML.LineCounter,
  isAlias: YAML.isAlias,
  isMap: YAML.isMap,
  isScalar: YAML.isScalar,
  isSeq: YAML.isSeq,
  parseAllDocuments: YAML.parseAllDocuments,
};
