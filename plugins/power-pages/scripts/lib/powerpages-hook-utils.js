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
  'configure-env-variables': {
    validatorScript: 'skills/configure-env-variables/scripts/validate-env-variables.js',
  },
  'create-site': {
    validatorScript: 'skills/create-site/scripts/validate-site.js',
  },
  'create-webroles': {
    validatorScript: 'skills/create-webroles/scripts/validate-webroles.js',
  },
  'deploy-pipeline': {
    validatorScript: 'skills/deploy-pipeline/scripts/validate-deploy-pipeline.js',
  },
  'ensure-pipelines-host': {
    validatorScript: 'skills/ensure-pipelines-host/scripts/validate-ensure-host.js',
  },
  'force-link-environment': {
    validatorScript: 'skills/force-link-environment/scripts/validate-force-link.js',
  },
  'export-solution': {
    validatorScript: 'skills/export-solution/scripts/validate-export.js',
  },
  'import-solution': {
    validatorScript: 'skills/import-solution/scripts/validate-import.js',
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
  'plan-alm': {
    validatorScript: 'skills/plan-alm/scripts/validate-plan-alm.js',
  },
  'setup-auth': {
    validatorScript: 'skills/setup-auth/scripts/validate-auth.js',
  },
  'setup-datamodel': {
    validatorScript: 'skills/setup-datamodel/scripts/validate-datamodel.js',
  },
  'setup-pipeline': {
    validatorScript: 'skills/setup-pipeline/scripts/validate-pipeline.js',
  },
  'setup-solution': {
    validatorScript: 'skills/setup-solution/scripts/validate-solution.js',
  },
  'test-site': {},

  // ───── Inner Dev Loop skills (Dataverse Git integration) ─────
  // 12-skill family that automates the Connect-to-Git workflow. Validators
  // live alongside each skill and write markers to `docs/inner-loop/`.
  // `connect-solution-to-git` shares the `setup-git-integration` validator
  // (both skills write the same `.git-integration-manifest.json` + marker).
  'plan-inner-loop': {
    validatorScript: 'skills/plan-inner-loop/scripts/validate-plan-inner-loop.js',
  },
  'setup-git-integration': {
    validatorScript: 'skills/setup-git-integration/scripts/validate-setup-git-integration.js',
  },
  'connect-solution-to-git': {
    validatorScript: 'skills/connect-solution-to-git/scripts/validate-connect-solution-to-git.js',
  },
  // NOTE: 'validate-pending-changes' was folded into 'commit-to-git --dry-run'.
  // The merged validator (skills/commit-to-git/scripts/validate-commit-to-git.js)
  // accepts BOTH last-commit.json (real-commit) AND last-validation.json
  // (dry-run) markers — see references/approval-gates.md §6A.7.
  'commit-to-git': {
    validatorScript: 'skills/commit-to-git/scripts/validate-commit-to-git.js',
  },
  'sync-from-git': {
    validatorScript: 'skills/sync-from-git/scripts/validate-sync-from-git.js',
  },
  'resolve-conflicts': {
    validatorScript: 'skills/resolve-conflicts/scripts/validate-resolve-conflicts.js',
  },
  'branch-switch': {
    validatorScript: 'skills/branch-switch/scripts/validate-branch-switch.js',
  },
  'revert-workspace': {
    validatorScript: 'skills/revert-workspace/scripts/validate-revert-workspace.js',
  },
  'revert-branch': {
    validatorScript: 'skills/revert-branch/scripts/validate-revert-branch.js',
  },
  'open-pr': {
    validatorScript: 'skills/open-pr/scripts/validate-open-pr.js',
  },
  'diagnose-git-integration': {
    validatorScript: 'skills/diagnose-git-integration/scripts/validate-diagnose-git-integration.js',
  },
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
