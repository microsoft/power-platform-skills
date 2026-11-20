export const DEFAULT_MODELS = Object.freeze([
  'claude-opus-4.8', 'claude-sonnet-5.5', 'gpt-6-sol', 'gpt-6.1-sol',
]);
export const REASONING_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const modelId = /^[a-z0-9][a-z0-9._-]{0,127}$/;

// Agent turn budget per effort. Low and medium keep the 10m every suite
// declares. At max effort, multi-step create-site trials did real work for
// over 10 minutes and failed with "Timeout after 600000ms waiting for
// session.idle", an infrastructure error that measured nothing. Longer budgets
// let deeper reasoning finish; graders and thresholds are unchanged.
const AGENT_TIMEOUT_MINUTES = Object.freeze({ none: 10, low: 10, medium: 10, high: 20, xhigh: 30, max: 30 });

export function agentTimeoutMs(reasoningEffort) {
  const minutes = AGENT_TIMEOUT_MINUTES[reasoningEffort];
  if (!minutes) throw new Error(`Unsupported reasoning effort: ${reasoningEffort}`);
  return minutes * 60_000;
}

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
      model, judgeModel: judgeModel.trim() || (model === 'claude-opus-4.8' ? 'gpt-6.1-sol' : 'claude-opus-4.8'),
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
