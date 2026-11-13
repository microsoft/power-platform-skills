import { CopilotClient, defineTool, RuntimeConnection } from '@github/copilot-sdk';
import { computeMetrics } from '@microsoft/vally';
import { CopilotAdapter } from '@microsoft/vally/trajectory';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { confinedPath } from './paths.mjs';
import { assertModelSupport } from './models.mjs';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const cliLoader = path.join(path.dirname(require.resolve('@github/copilot/package.json')), 'npm-loader.js');
const networkGuard = fileURLToPath(new URL('./renderer-network-guard.cjs', import.meta.url));

// These wrappers only read JSON and render a bundled template. No CLI, API,
// project build, plugin hook, or agent-authored script is executable.
const wrapperNames = [
  'render-add-localization-plan', 'render-audit-report', 'render-auth-report', 'render-backend-plan',
  'render-cloudflow-plan', 'render-createsite-plan', 'render-data-model-plan',
  'render-edit-site-plan', 'render-permissions-plan', 'render-review', 'render-serverlogic-plan',
];
export const RENDERER_PATHS = Object.freeze({
  ...Object.fromEntries(wrapperNames.map(name => [name, `scripts/${name}.js`])),
  'render-migration-report': 'skills/migrate-webapi-selectall/scripts/render-migration-report.js',
  'render-alm-plan': 'skills/plan-alm/scripts/render-alm-plan.js',
});
export const RENDERERS = Object.freeze(Object.keys(RENDERER_PATHS));
export const TOOL_NAMES = Object.freeze([
  'skill', 'eval_list', 'eval_read', 'eval_write', 'eval_render',
  'eval_compare_sites', 'eval_analyze_performance',
]);

export function clientEnvironment(home, source = process.env, useLoggedInUser = false) {
  const env = {
    HOME: home, USERPROFILE: home, COPILOT_HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    APPDATA: path.join(home, 'AppData'), LOCALAPPDATA: path.join(home, 'LocalAppData'),
    PATH: source.PATH ?? '', NODE_NO_WARNINGS: '1',
    POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: '1',
  };
  // Windows needs its loader/system paths. Do not inherit shell preloads, Azure
  // profiles, provider overrides, npm credentials, proxies, or arbitrary secrets.
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (source[key]) env[key] = source[key];
  }
  // Local smoke runs may use the host's standard Copilot authentication
  // environment. Never pass it to file helpers or Actions trials, and never
  // copy the user's credential/config files into an evaluation workspace.
  if (useLoggedInUser) {
    for (const key of ['GH_TOKEN', 'COPILOT_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GITHUB_COPILOT_API_TOKEN']) {
      if (source[key]) env[key] = source[key];
    }
  }
  return env;
}

const parameters = properties => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const string = { type: 'string' };
const blockedResource = name => name.split('/').some(part =>
  ['SKILL.md', 'AGENTS.md', 'CLAUDE.md', '.git', '.copilot', '.claude', 'node_modules'].includes(part));

export function createOfflineTools(workDir, pluginRoot) {
  const runLocal = async (scriptName, args, signal) => {
    const script = await confinedPath(pluginRoot, scriptName);
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [
        '--require', networkGuard, script, ...args,
      ], {
        cwd: workDir, env: clientEnvironment(workDir, process.env),
        timeout: 15_000, maxBuffer: 512_000, signal, windowsHide: true,
      });
      return { stdout, stderr };
    } catch (error) {
      // SDK dispatch hides thrown handler errors behind "Tool execution failed".
      // Preserve the helper diagnostic so the agent can correct its local input.
      return { resultType: 'failure', textResultForLlm: `Offline helper failed: ${error.stderr || error.message}` };
    }
  };
  const locate = async (root, name, missing = false) => {
    if (!['workspace', 'plugin'].includes(root)) throw new Error('Unknown file root');
    if (root === 'plugin' && blockedResource(name)) {
      throw new Error('Skill instructions are available only through the session skill catalog');
    }
    return confinedPath(root === 'workspace' ? workDir : pluginRoot, name, { missing });
  };
  return [
    defineTool('eval_list', {
      description: 'List files in a workspace or read-only plugin resource directory. Use an empty path for its root.',
      parameters: parameters({ root: { enum: ['workspace', 'plugin'] }, path: string }),
      handler: async ({ root, path: name }) => {
        const directory = name ? await locate(root, name) : root === 'workspace' ? workDir : pluginRoot;
        if (!['workspace', 'plugin'].includes(root)) throw new Error('Unknown file root');
        return (await readdir(directory, { withFileTypes: true }))
          .filter(entry => !entry.isSymbolicLink() && !blockedResource(entry.name))
          .map(entry => ({ name: entry.name, directory: entry.isDirectory() }));
      },
    }),
    defineTool('eval_read', {
      description: 'Read UTF-8 input or plugin reference/template/script source. Does not execute code.',
      parameters: parameters({ root: { enum: ['workspace', 'plugin'] }, path: string }),
      handler: async ({ root, path: name }) => {
        const content = await readFile(await locate(root, name), 'utf8');
        if (Buffer.byteLength(content) > 512_000) throw new Error('File exceeds the 512 KB read limit');
        return content;
      },
    }),
    defineTool('eval_write', {
      description: 'Write a UTF-8 artifact inside the task workspace. No remote or plugin files can be changed.',
      parameters: parameters({ path: string, content: string }),
      handler: async ({ path: name, content }) => {
        if (Buffer.byteLength(content) > 512_000) throw new Error('Artifact exceeds the 512 KB write limit');
        const target = await confinedPath(workDir, name, { missing: true });
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, { encoding: 'utf8', flag: 'w' });
        return { written: name };
      },
    }),
    defineTool('eval_render', {
      description: `Render an HTML document using a bundled offline renderer: ${RENDERERS.join(', ')}. Read its script for required JSON keys first. Input is a workspace JSON file; output is a workspace HTML path.`,
      parameters: parameters({ renderer: { enum: RENDERERS }, data: string, output: string }),
      handler: async ({ renderer, data, output }, invocation) => {
        if (!RENDERERS.includes(renderer)) throw new Error('Renderer is not allowlisted');
        const input = await confinedPath(workDir, data);
        const target = await confinedPath(workDir, output, { missing: true });
        if (!target.endsWith('.html')) throw new Error('Renderer output must be HTML');
        return runLocal(RENDERER_PATHS[renderer], ['--data', input, '--output', target], invocation?.signal);
      },
    }),
    defineTool('eval_compare_sites', {
      description: 'Compare two local exported site folders. Writes the report and receipts. Does not connect to an environment or launch a browser.',
      parameters: parameters({
        source: string, target: string, output: string,
        sourceCodeSite: { type: 'boolean' }, targetCodeSite: { type: 'boolean' },
      }),
      handler: async ({ source, target, output, sourceCodeSite, targetCodeSite }, invocation) => runLocal(
        'skills/compare-site-configurations/scripts/compare-site-configurations.js', [
          '--source', await confinedPath(workDir, source),
          '--target', await confinedPath(workDir, target),
          '--output', await confinedPath(workDir, output, { missing: true }),
          '--sourceCodeSite', String(sourceCodeSite), '--targetCodeSite', String(targetCodeSite),
          '--open', 'false',
        ], invocation?.signal,
      ),
    }),
    defineTool('eval_analyze_performance', {
      description: 'Analyze local website source for performance issues. Returns JSON observations without connecting to a running website.',
      parameters: parameters({ path: string }),
      handler: async ({ path: name }, invocation) => runLocal(
        'skills/analyze-performance/scripts/analyze-performance.js',
        ['--projectRoot', name ? await confinedPath(workDir, name) : workDir], invocation?.signal,
      ),
    }),
  ];
}

export function offlineSessionConfig({ home, workDir, pluginRoot, skills, model, reasoningEffort = 'medium', tools }) {
  const ownedTools = new Set(tools.map(tool => tool.name).filter(name => name !== 'skill' && TOOL_NAMES.includes(name)));
  return {
    model, reasoningEffort, workingDirectory: workDir, configDirectory: home,
    availableTools: [...TOOL_NAMES], tools,
    enableConfigDiscovery: false, enableFileHooks: false, requestExtensions: false,
    enableOnDemandInstructionDiscovery: false, enableHostGitOperations: false,
    enableSessionStore: false,
    requestCanvasRenderer: false, mcpServers: {}, disabledMcpServers: ['github'],
    skillDirectories: skills.map(skill => path.dirname(skill.path)),
    includedBuiltinSkills: [], enableSkills: skills.length > 0,
    // SDK custom-tool dispatch also requests permission. Approve only our
    // registered, contained handlers, which enforce paths/operations themselves;
    // granting native read/write/shell permissions would bypass that confinement.
    onPermissionRequest: request => request.kind === 'custom-tool' && ownedTools.has(request.toolName)
      ? { kind: 'approve-once' }
      : { kind: 'reject', feedback: 'Restricted offline evaluation' },
    systemMessage: {
      mode: 'append',
      content: `This is an offline artifact evaluation, not a live Power Pages session.
Use eval_list, eval_read, eval_write, eval_render, eval_compare_sites and eval_analyze_performance for local work.
Plugin resources are read-only under the plugin root (${pluginRoot}); task inputs and outputs use the workspace root.
Interpret Read/Write/Glob/Bash references in skills through these tools.
Only the documented eval_render wrappers can run; other commands, network, MCP, browser, deployment, authentication and cloud writes are unavailable.
Treat exported snapshots as supplied evidence, never as proof of live state.
Produce the requested local deliverable where possible. If a necessary operation is unavailable, state that boundary rather than inventing its result.
Approval boundaries remain in force. The task prompt may authorize specific local file work; it grants nothing else.
Stop with the proposed action when any other approval is required.`,
    },
  };
}

export async function assertOfflineCatalog(session, skills) {
  // Validate the runtime's actual catalog, not just the requested SDK config.
  // Fail closed after a CLI/SDK update that reintroduces an ambient capability.
  await session.rpc.tools.initializeAndValidate();
  const { tools } = await session.rpc.tools.getCurrentMetadata();
  const expectedTools = TOOL_NAMES.filter(name => name !== 'skill' || skills.length);
  if (!Array.isArray(tools) || tools.length !== expectedTools.length ||
      tools.some(tool => !expectedTools.includes(tool.name))) {
    throw new Error('Runtime tool catalog differs from the offline allowlist');
  }
  const catalog = await session.rpc.skills.list();
  const expected = new Set(skills.map(skill => skill.name));
  if (catalog.skills.length !== expected.size || catalog.skills.some(skill => !expected.has(skill.name))) {
    throw new Error('Runtime skill catalog differs from the selected evaluation arm');
  }
}

async function stopClient(client) {
  const errors = await client.stop();
  if (errors?.length) throw new AggregateError(errors, 'Copilot runtime cleanup failed');
}

function reportedTokenUsage(events) {
  if (!events.length) return null;
  const sum = key => {
    let total = 0;
    for (const event of events) {
      const value = event?.[key];
      if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) return null;
      total += value;
    }
    return total;
  };
  return Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .map(key => [key, sum(key)]));
}

export class OfflineExecutor {
  name = 'power-pages-offline';
  supportsEnvVars = false;
  #active = new Set();
  constructor({ pluginRoot, token, useLoggedInUser = false, judgeModel, judgeReasoningEffort, clientFactory } = {}) {
    this.pluginRoot = pluginRoot;
    this.token = token;
    this.useLoggedInUser = useLoggedInUser;
    this.judgeModel = judgeModel;
    this.judgeReasoningEffort = judgeReasoningEffort;
    this.clientFactory = clientFactory ?? (options => new CopilotClient(options));
  }
  async execute(stimulus, options) {
    if (stimulus.turns || stimulus.simulation || options.mcpServers) {
      throw new Error('The offline executor supports single-turn local artifact tasks only');
    }
    if (!options.registerCleanup) throw new Error('Vally per-trial cleanup support is required');
    const home = await mkdtemp(path.join(tmpdir(), 'pp-eval-home-'));
    options.registerCleanup(() => rm(home, { recursive: true, force: true }));
    const adapter = new CopilotAdapter();
    const usageEvents = [];
    const startedAt = new Date();
    const client = this.clientFactory({
      // Local runs opt into the SDK's normal sign-in; Actions use only their
      // explicitly supplied token. Both paths retain the same per-session isolation.
      mode: this.useLoggedInUser ? 'copilot-cli' : 'empty', baseDirectory: home,
      connection: RuntimeConnection.forStdio({ path: process.execPath, args: [cliLoader] }),
      workingDirectory: options.workDir, env: clientEnvironment(home, process.env, this.useLoggedInUser),
      ...(this.token ? { gitHubToken: this.token } : {}),
      useLoggedInUser: this.useLoggedInUser,
    });
    this.#active.add(client);
    let session;
    try {
      await client.start();
      const models = await client.listModels();
      assertModelSupport(models, options.model, options.reasoningEffort ?? 'medium');
      if (this.judgeModel) assertModelSupport(models, this.judgeModel, this.judgeReasoningEffort);
      session = await client.createSession({
        ...offlineSessionConfig({
          home, workDir: options.workDir, pluginRoot: this.pluginRoot,
          skills: options.skills ?? [], model: options.model, reasoningEffort: options.reasoningEffort,
          tools: createOfflineTools(options.workDir, this.pluginRoot),
        }),
        onEvent: event => {
          // Vally substitutes zero for absent SDK input/output fields, so retain
          // the raw counters separately to distinguish unknown usage from zero.
          if (event.type === 'assistant.usage') usageEvents.push(event.data);
          adapter.on(event);
          options.onRawEvent?.(event);
        },
      });
      await assertOfflineCatalog(session, options.skills ?? []);
      const response = await session.sendAndWait({ prompt: stimulus.prompt }, options.timeout);
      adapter.stampConversationTurns();
      const completedAt = new Date();
      return {
        id: randomUUID(), stimulus, events: adapter.events,
        output: response?.data?.content ?? '', workDir: options.workDir,
        endReason: 'completed',
        metadata: {
          model: adapter.model ?? options.model, executor: this.name,
          skillsLoaded: adapter.skillsLoaded, sessionID: session.sessionId,
          startedAt, completedAt,
        },
        metrics: {
          ...computeMetrics(adapter.events),
          reportedTokenUsage: reportedTokenUsage(usageEvents),
          wallTimeMs: completedAt.getTime() - startedAt.getTime(),
        },
      };
    } finally {
      try { await session?.disconnect(); }
      finally {
        try { await stopClient(client); }
        finally { this.#active.delete(client); }
      }
    }
  }
  async shutdown() {
    await Promise.all([...this.#active].map(stopClient));
    this.#active.clear();
  }
}
