"use strict";

require("./jest-setup").installPunycodeDeprecationFilter();

const JsdomEnvironment = require("jest-environment-jsdom").TestEnvironment;

module.exports = JsdomEnvironment;
