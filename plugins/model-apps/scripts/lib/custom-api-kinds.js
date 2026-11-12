'use strict';

// A declared kind the page action runtime does not support drops the WHOLE binding. Discovery
// and App Spec validation therefore share this closed vocabulary, rather than drifting apart.
// Types 3/4 are unsupported complex values; type 5 is a structural lookup at call time, not a
// declared kind. Numeric keys are customapirequestparameter.type option values:
// https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/customapirequestparameter
const PARAMETER_KIND_BY_TYPE = Object.freeze({
  0: 'Boolean',
  1: 'DateTime',
  2: 'Decimal',
  6: 'Float',
  7: 'Integer',
  8: 'Money',
  9: 'Picklist',
  10: 'String',
  11: 'StringArray',
  12: 'Guid',
});

const PARAMETER_KINDS = Object.freeze(Object.values(PARAMETER_KIND_BY_TYPE));

module.exports = { PARAMETER_KIND_BY_TYPE, PARAMETER_KINDS };
