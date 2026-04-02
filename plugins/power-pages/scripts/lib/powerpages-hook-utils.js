const TRACKED_SKILLS = {
  'activate-site': {
    validatorScript: 'skills/activate-site/scripts/validate-activation.js',
  },
  'add-sample-data': {},
  'add-seo': {
    validatorScript: 'skills/add-seo/scripts/validate-seo.js',
  },
  'audit-permissions': {
    validatorScript: 'skills/audit-permissions/scripts/validate-audit.js',
  },
  'create-site': {
    validatorScript: 'skills/create-site/scripts/validate-site.js',
  },
  'create-webroles': {
    validatorScript: 'skills/create-webroles/scripts/validate-webroles.js',
  },
  'add-cloud-flow': {
    validatorScript: 'skills/add-cloud-flow/scripts/validate-cloudflow.js',
  },
  'add-server-logic': {
    validatorScript: 'skills/add-server-logic/scripts/validate-serverlogic.js',
  },
  'integrate-webapi': {
    validatorScript: 'skills/integrate-webapi/scripts/validate-webapi-integration.js',
  },
  'setup-auth': {
    validatorScript: 'skills/setup-auth/scripts/validate-auth.js',
  },
  'setup-datamodel': {
    validatorScript: 'skills/setup-datamodel/scripts/validate-datamodel.js',
  },
  'test-site': {},
};

function detectTrackedSkill(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (TRACKED_SKILLS[trimmed]) {
    return trimmed;
  }

  // Strip leading slash and optional plugin prefix: /create-site, /power-pages:create-site
  const normalized = trimmed.replace(/^\/?(?:power-pages:)?/, '').toLowerCase();
  if (TRACKED_SKILLS[normalized]) {
    return normalized;
  }

  // Fall back to searching for power-pages:<skill> anywhere in the string
  const commandMatch = trimmed.match(/power-pages:([a-z0-9-]+)/i);
  if (!commandMatch) {
    return null;
  }

  const skillName = commandMatch[1].toLowerCase();
  return TRACKED_SKILLS[skillName] ? skillName : null;
}

function getTrackedSkillFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') {
    return null;
  }

  for (const field of ['skill', 'skill_name', 'skillName', 'name', 'commandName', 'command']) {
    const skillName = detectTrackedSkill(toolInput[field]);
    if (skillName) {
      return skillName;
    }
  }

  try {
    return detectTrackedSkill(JSON.stringify(toolInput));
  } catch {
    return null;
  }
}

function getValidatorScript(skillName) {
  return TRACKED_SKILLS[skillName]?.validatorScript ?? null;
}

module.exports = {
  TRACKED_SKILLS,
  detectTrackedSkill,
  getTrackedSkillFromToolInput,
  getValidatorScript,
};
