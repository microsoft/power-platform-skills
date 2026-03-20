const { validateTablePermissionsWithOptions } = require('./table-permissions-validator');
const { validateSiteSettings } = require('./site-settings-validator');
const { validateWebRoles } = require('./web-roles-validator');
const { summarize } = require('./powerpages-validation-utils');

function validatePowerPagesSchema(projectRoot, options = {}) {
  const tablePermissions = validateTablePermissionsWithOptions(projectRoot, options);
  const siteSettings = validateSiteSettings(projectRoot);
  const webRoles = validateWebRoles(projectRoot);
  const findings = [
    ...tablePermissions.findings,
    ...siteSettings.findings,
    ...webRoles.findings,
  ];

  return {
    projectRoot,
    tablePermissions,
    siteSettings,
    webRoles,
    findings,
    summary: summarize(findings),
  };
}

module.exports = {
  validatePowerPagesSchema,
};
