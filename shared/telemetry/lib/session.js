"use strict";

const crypto = require("node:crypto");

let cached;

function getSessionId() {
  if (!cached) {
    cached = crypto.randomUUID();
  }
  return cached;
}

module.exports = { getSessionId };
