// Screenshot-seeing judge for the design grade. Vally's text judge cannot attach images, so this
// opens its own Copilot SDK session with the judge model, attaches screenshots as image blobs, and
// accepts the verdict only through one forced tool. Nothing else is available to the session.
import { CopilotClient, defineTool, RuntimeConnection } from '@github/copilot-sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clientEnvironment } from './offline-executor.mjs';
import { assertModelSupport } from './models.mjs';

const require = createRequire(import.meta.url);
const cliLoader = path.join(path.dirname(require.resolve('@github/copilot/package.json')), 'npm-loader.js');
const MAX_REMINDERS = 2;

export function assertVisionSupport(models, model, images) {
  const entry = models.find(item => item.id === model);
  if (!entry?.capabilities?.supports?.vision) throw new Error(`Judge model ${model} cannot read images; choose a vision-capable --judge-model for design grading`);
  const limits = entry.capabilities.limits?.vision ?? {};
  const types = limits.supported_media_types ?? ['image/jpeg', 'image/png'];
  const usable = images.filter(image => types.includes(image.mimeType) &&
    (!limits.max_prompt_image_size || Buffer.byteLength(image.data, 'base64') <= limits.max_prompt_image_size));
  // First screens carry the most judgment weight, so they are kept before full pages.
  usable.sort((a, b) => Number(/-full\./.test(a.name)) - Number(/-full\./.test(b.name)));
  return limits.max_prompt_images ? usable.slice(0, limits.max_prompt_images) : usable;
}

export function createDesignJudge({ token, useLoggedInUser = false, clientFactory = options => new CopilotClient(options) } = {}) {
  const active = new Set();
  return {
    async judge({ model, reasoningEffort = 'medium', systemMessage, userMessage, images, tool, signal, timeoutMs = 240_000 }) {
      const home = await mkdtemp(path.join(tmpdir(), 'pp-design-judge-'));
      const client = clientFactory({
        mode: useLoggedInUser ? 'copilot-cli' : 'empty', baseDirectory: home,
        connection: RuntimeConnection.forStdio({ path: process.execPath, args: [cliLoader] }),
        workingDirectory: home, env: clientEnvironment(home, process.env, useLoggedInUser),
        ...(token ? { gitHubToken: token } : {}), useLoggedInUser,
      });
      active.add(client);
      let session;
      const usage = { inputTokens: 0, outputTokens: 0, reported: false };
      try {
        signal?.throwIfAborted();
        await client.start();
        const models = await client.listModels();
        assertModelSupport(models, model, reasoningEffort);
        const attached = assertVisionSupport(models, model, images);
        if (!attached.length) throw new Error(`No screenshot fits judge model ${model}'s image limits`);
        let submitted;
        const submit = defineTool(tool.name, {
          description: tool.description, parameters: tool.parameters,
          handler: async args => { submitted = args; return 'Recorded.'; },
        });
        session = await client.createSession({
          model, reasoningEffort, workingDirectory: home, configDirectory: home,
          tools: [submit], availableTools: [tool.name],
          systemMessage: { mode: 'replace', content: systemMessage },
          enableConfigDiscovery: false, enableFileHooks: false, requestExtensions: false,
          enableOnDemandInstructionDiscovery: false, enableHostGitOperations: false, enableSessionStore: false,
          requestCanvasRenderer: false, mcpServers: {}, disabledMcpServers: ['github'],
          includedBuiltinSkills: [], enableSkills: false,
          onPermissionRequest: request => request.kind === 'custom-tool' && request.toolName === tool.name
            ? { kind: 'approve-once' } : { kind: 'reject', feedback: 'Design judge: only the verdict tool is available' },
          onEvent: event => {
            if (event.type !== 'assistant.usage') return;
            const { inputTokens, outputTokens } = event.data ?? {};
            if (Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens)) {
              usage.inputTokens += inputTokens; usage.outputTokens += outputTokens; usage.reported = true;
            }
          },
        });
        const abort = () => { void session?.abort().catch(() => {}); };
        signal?.addEventListener('abort', abort, { once: true });
        try {
          const note = attached.length < images.length
            ? `\n\nOnly these screenshots fit the model's limits and are attached: ${attached.map(image => image.name).join(', ')}. Judge items that need a missing screenshot from the attached ones, and say so in the evidence.`
            : '';
          await session.sendAndWait({
            prompt: userMessage + note,
            attachments: attached.map(image => ({ type: 'blob', data: image.data, mimeType: image.mimeType, displayName: image.name })),
          }, timeoutMs);
          for (let reminder = 0; !submitted && reminder < MAX_REMINDERS; reminder++) {
            signal?.throwIfAborted();
            await session.sendAndWait({ prompt: `You must call ${tool.name} exactly once with the complete verdict.` }, timeoutMs);
          }
        } finally {
          signal?.removeEventListener('abort', abort);
        }
        if (!submitted) throw new Error(`Design judge did not call ${tool.name}`);
        return { args: submitted, tokenUsage: usage.reported ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : undefined };
      } finally {
        try { await session?.disconnect(); }
        finally {
          try { await client.stop(); }
          finally {
            active.delete(client);
            await rm(home, { recursive: true, force: true });
          }
        }
      }
    },
    async shutdown() {
      await Promise.all([...active].map(client => client.stop()));
      active.clear();
    },
  };
}
