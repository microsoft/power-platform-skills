export const DEFAULT_MODELS = Object.freeze([
  'claude-opus-5', 'claude-sonnet-5.5', 'gpt-6-astra', 'gpt-6.1-sol',
]);
export const REASONING_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const modelId = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function validateModelPair({ model, judgeModel, reasoningEffort, judgeReasoningEffort }) {
  for (const id of [model, judgeModel]) {
    if (!modelId.test(id ?? '') || id === 'auto') throw new Error('Use explicit model IDs for agent and judge');
  }
  if (model === judgeModel) throw new Error('The judge must be a different model from the evaluated agent');
  for (const effort of [reasoningEffort, judgeReasoningEffort]) {
    if (!REASONING_EFFORTS.includes(effort)) throw new Error(`Unsupported reasoning effort: ${effort}`);
  }
}

export function evaluationMatrix({ skills, models = '', judgeModel = '', reasoningEffort = 'medium', judgeReasoningEffort = 'medium' }) {
  const selected = models.trim() ? models.split(',').map(model => model.trim()) : DEFAULT_MODELS;
  if (new Set(selected).size !== selected.length) throw new Error('Duplicate evaluation model');
  return skills.flatMap(skill => selected.map(model => {
    const pair = {
      model, judgeModel: judgeModel.trim() || (model === 'claude-opus-5' ? 'gpt-6.1-sol' : 'claude-opus-5'),
      reasoningEffort, judgeReasoningEffort,
    };
    validateModelPair(pair);
    return { skill, ...pair };
  }));
}

export function assertModelSupport(models, model, effort) {
  const entry = models.find(item => item.id === model);
  if (!entry || entry.policy?.state === 'disabled') throw new Error(`Copilot model is unavailable: ${model}`);
  if (!entry.capabilities?.supports?.reasoningEffort || !entry.supportedReasoningEfforts?.includes(effort)) {
    throw new Error(`Copilot model ${model} does not support ${effort} reasoning effort`);
  }
}
