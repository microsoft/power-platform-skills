'use strict';

// Bundle these dependencies so marketplace installs validate CSS offline without
// installing packages into either the plugin or the maker's downloaded site.
exports.cssTree = require('css-tree');
exports.propertyData = require('mdn-data/css/properties.json');
exports.decodeHTMLAttribute = require('entities').decodeHTMLAttribute;
exports.escapeAttribute = require('entities').escapeAttribute;
