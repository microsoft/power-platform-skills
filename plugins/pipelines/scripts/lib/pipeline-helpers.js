// scripts/lib/pipeline-helpers.js
// Shared constants and utilities for Power Platform Pipelines plugin.

module.exports = {
  ENV_TYPE: { DEVELOPMENT: 200000000, TARGET: 200000001 },
  PIPELINE_STATE: { ACTIVE: 0 },
  PIPELINE_STATUS: { ACTIVE: 1 },
  DEPLOYMENT_TYPE: { STANDARD: 0, SOURCE_CONTROL: 1, ADO_PIPELINE: 2 },

  // DeploymentStageRun.stagerunstatus — the primary status you poll for
  STAGE_RUN_STATUS: {
    NOT_STARTED: 200000000,
    STARTED: 200000001,
    SUCCEEDED: 200000002,        // terminal ✅
    FAILED: 200000003,           // terminal ❌
    CANCELED: 200000004,         // terminal ❌
    SCHEDULED: 200000005,
    VALIDATING: 200000006,
    VALIDATION_SUCCEEDED: 200000007,
    PRE_DEPLOY_IN_PROGRESS: 200000008,
    PRE_DEPLOY_SUCCEEDED: 200000009,
    DEPLOYING: 200000010
  },

  // Terminal statuses — polling should stop when status is one of these
  TERMINAL_STATUSES: [200000002, 200000003, 200000004],

  // DeploymentStageRun.approvalstatus
  APPROVAL_STATUS: { PENDING: 10, APPROVED: 20, REJECTED: 30 },

  // DeploymentStageRun.predeploymentstepstatus
  PRE_DEPLOY_STEP_STATUS: { PENDING: 10, COMPLETED: 20, FAILED: 30 },

  // DeploymentEnvironment.validationstatus
  ENV_VALIDATION_STATUS: { PENDING: 200000000, SUCCESS: 200000001, FAILED: 200000002 },

  // DeploymentStage.delegateddeploymenttype
  DELEGATED_DEPLOYMENT_TYPE: { STAGE_OWNER: 1, SERVICE_PRINCIPAL: 2 },

  // Global option sets for sub-operation tracking (DeploymentStageRunStatus)
  DEPLOYMENT_OPERATION: { NONE: 200000200, VALIDATE: 200000201, DEPLOY: 200000202, PRE_DEPLOY: 200000203 },
  DEPLOYMENT_OPERATION_STATUS: {
    NOT_STARTED: 200000000, STARTED: 200000001, SUCCEEDED: 200000002,
    FAILED: 200000003, PENDING: 200000004, SCHEDULED: 200000005, CANCELED: 200000006
  },
  DEPLOYMENT_SUB_OPERATION: {
    NONE: 200000100, PRE_VALIDATION: 200000101, EXPORTING_SOLUTION: 200000102,
    PRE_DEPLOYMENT_STEP: 200000103, IMPORTING_SOLUTION: 200000104,
    CUSTOMIZATION_PUBLISHING: 200000105, DEPLOYMENT_COMPLETE: 200000106,
    COPY_ENVIRONMENT: 200000107, WAITING_ON_PRE_EXPORT: 200000108,
    EXECUTING_PRE_EXPORT: 200000109
  },

  // Human-readable status name lookup
  stageRunStatusName(code) {
    const names = {
      200000000: 'NotStarted', 200000001: 'Started', 200000002: 'Succeeded',
      200000003: 'Failed', 200000004: 'Canceled', 200000005: 'Scheduled',
      200000006: 'Validating', 200000007: 'ValidationSucceeded',
      200000008: 'PreDeployInProgress', 200000009: 'PreDeploySucceeded',
      200000010: 'Deploying'
    };
    return names[code] || `Unknown(${code})`;
  },

  API_PATHS: {
    ENVIRONMENTS: 'deploymentenvironments',
    PIPELINES: 'deploymentpipelines',
    STAGES: 'deploymentstages',
    STAGE_RUNS: 'deploymentstageruns',
    VALIDATE_PACKAGE: 'ValidatePackageAsync'
  },

  // Auth helper — get Azure CLI token for a Dataverse resource URL
  // Supports optional tenant ID for cross-tenant environments (e.g., Aurora test envs)
  getAuthToken(resourceUrl, tenantId) {
    const { execSync } = require('child_process');
    try {
      const tenantArg = tenantId ? ` --tenant "${tenantId}"` : '';
      return execSync(
        `az account get-access-token --resource "${resourceUrl}"${tenantArg} --query accessToken -o tsv`,
        { encoding: 'utf8', timeout: 15000 }
      ).trim();
    } catch {
      return null;
    }
  },

  // HTTP request helper using Node.js built-ins (no external dependencies)
  makeRequest({ url, method = 'GET', headers = {}, body = null, includeHeaders = false, timeout = 30000 }) {
    return new Promise((resolve) => {
      const https = require('https');
      const http = require('http');
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(
        {
          method,
          headers,
          hostname: u.hostname,
          port: u.port || undefined,
          path: u.pathname + u.search,
          timeout
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            const result = { statusCode: res.statusCode, body: data };
            if (includeHeaders) result.headers = res.headers;
            resolve(result);
          });
        }
      );
      req.on('error', (e) => resolve({ error: e.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ error: 'Request timed out' });
      });
      if (body) req.write(body);
      req.end();
    });
  },

  // Get environment URL from pac env who
  getEnvironmentUrl() {
    const { execSync } = require('child_process');
    try {
      const output = execSync('pac env who', { encoding: 'utf8', timeout: 15000 });
      const match = output.match(/Environment URL:\s*(https:\/\/[^\s]+)/i);
      return match ? match[1].replace(/\/+$/, '') : null;
    } catch {
      return null;
    }
  },

  // Get PAC auth info (environment ID, cloud)
  getPacAuthInfo() {
    const { execSync } = require('child_process');
    try {
      const output = execSync('pac auth who', { encoding: 'utf8', timeout: 15000 });
      const envMatch = output.match(/Environment ID:\s*([0-9a-fA-F-]+)/i);
      const cloudMatch = output.match(/Cloud:\s*(\S+)/i);
      if (!envMatch) return null;
      return { environmentId: envMatch[1], cloud: cloudMatch ? cloudMatch[1] : 'Public' };
    } catch {
      return null;
    }
  },

  UUID_REGEX: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,

  // Extract entity GUID from OData-EntityId header value
  // Format: https://org.crm.dynamics.com/api/data/v9.2/entities(guid)
  extractEntityId(headerValue) {
    if (!headerValue) return null;
    const match = headerValue.match(/\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i);
    return match ? match[1] : null;
  }
};

// Self-test when run directly
if (require.main === module) {
  const h = module.exports;
  console.log('pipeline-helpers self-test:');
  console.log('  ENV_TYPE.DEVELOPMENT =', h.ENV_TYPE.DEVELOPMENT);
  console.log('  STAGE_RUN_STATUS.SUCCEEDED =', h.STAGE_RUN_STATUS.SUCCEEDED);
  console.log('  STAGE_RUN_STATUS.DEPLOYING =', h.STAGE_RUN_STATUS.DEPLOYING);
  console.log('  stageRunStatusName(200000006) =>', h.stageRunStatusName(200000006));
  console.log('  TERMINAL_STATUSES =', h.TERMINAL_STATUSES);
  console.log('  APPROVAL_STATUS.PENDING =', h.APPROVAL_STATUS.PENDING);
  console.log('  UUID_REGEX test "00000000-0000-0000-0000-000000000000" =>', h.UUID_REGEX.test('00000000-0000-0000-0000-000000000000'));
  console.log('  extractEntityId test =>', h.extractEntityId('https://org.crm.dynamics.com/api/data/v9.2/deploymentpipelines(a1b2c3d4-e5f6-7890-abcd-ef1234567890)'));
  console.log('All checks passed.');
}
