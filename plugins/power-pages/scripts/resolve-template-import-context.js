#!/usr/bin/env node
'use strict';

const { resolveTemplateImportContext } = require('./lib/template-import-context');
const { formatJsonResult } = require('./lib/template-cli-args');

process.stdout.write(formatJsonResult(resolveTemplateImportContext()));
