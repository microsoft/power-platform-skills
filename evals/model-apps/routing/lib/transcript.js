'use strict';

// Incremental parser for a headless agent transcript — the ONE place that knows each CLI's
// JSONL event shapes. The routing runner feeds it stdout line by line and stops the agent as
// soon as `decided` is true, so a trial costs one model turn rather than a whole skill run.
//
// Claude Code (`claude -p --output-format stream-json --verbose`), one JSON object per line:
//   {"type":"system","subtype":"init","skills":["model-apps:genpage","design",...],"plugins":[...]}
//   {"type":"assistant","message":{"content":[
//       {"type":"text","text":"..."},
//       {"type":"tool_use","id":"toolu_…","name":"Skill","input":{"skill":"model-apps:genpage","args":"…"}}]}}
//   {"type":"result","subtype":"success","num_turns":3,"total_cost_usd":0.064}
// Plugin skills are namespaced `<plugin>:<skill>`; built-in skills are bare (`design`).
//
// GitHub Copilot CLI (`copilot -p … --output-format json`), one JSON object per line:
//   {"type":"assistant.message","data":{"toolRequests":[
//       {"toolCallId":"toolu_…","name":"skill","arguments":{"skill":"genpage"}}],"content":""}}
//   {"type":"tool.execution_start","data":{"toolCallId":"toolu_…","toolName":"skill","arguments":{"skill":"genpage"}}}
//   {"type":"assistant.message_delta","data":{"deltaContent":"…"}}      ← streamed text, ignored
//   {"type":"result","exitCode":0,"usage":{"premiumRequests":1,…}}
// Skill names are NOT namespaced. `assistant.message` is the earliest COMPLETE tool request;
// `tool.execution_start` repeats it, so calls are de-duplicated by toolCallId.
//
// Non-JSON lines (CLI banners, warnings on stderr merged into stdout) are ignored rather than
// treated as errors: a transcript is evidence, and one noisy line must not void a trial.

const AGENTS = ['claude', 'copilot'];

class TranscriptParser {
  /**
   * @param {'claude'|'copilot'} agent
   * @param {{pluginName: string, pluginSkills: string[]}} plugin - the plugin under test. A skill
   *   counts as a ROUTING DECISION only when it belongs to this plugin; a built-in skill (Claude's
   *   `design`, say) is recorded but does not end the trial, because the model may still route.
   */
  constructor(agent, { pluginName, pluginSkills }) {
    if (!AGENTS.includes(agent)) throw new Error(`unknown agent ${JSON.stringify(agent)} (expected ${AGENTS.join('|')})`);
    this.agent = agent;
    this.pluginName = pluginName;
    this.pluginSkills = new Set(pluginSkills);
    this.skillCalls = [];        // every skill invocation, in order: { raw, name, ofPlugin }
    this.loadedSkills = null;    // Claude only: the init event's skill list (isolation evidence)
    this.text = '';              // final assistant text (best-effort; for diagnostics only)
    this.result = null;          // the terminal `result` event, when the run got that far
    this.eventCount = 0;         // JSON events accepted — 0 means the agent never really ran
    this._seen = new Set();
  }

  /** First skill of the plugin under test, normalized (`genpage`), or null. */
  get routedTo() {
    const hit = this.skillCalls.find((c) => c.ofPlugin);
    return hit ? hit.name : null;
  }

  /** True once the trial's outcome cannot change: a plugin skill was chosen, or the run ended. */
  get decided() {
    return this.routedTo !== null || this.result !== null;
  }

  /**
   * Why the terminal `result` says the run FAILED, or null. A failed run that chose no plugin
   * skill has not decided "none" — it never got to decide — so the runner turns this into a trial
   * error instead of grading it (graded, it would pass every negative case).
   *   Claude:  {"type":"result","subtype":"error_during_execution","is_error":true,...}
   *            (success is subtype "success" with is_error false; other subtypes include
   *            "error_max_turns")
   *   Copilot: {"type":"result","exitCode":1,...}
   */
  get resultError() {
    const r = this.result;
    if (!r) return null;
    if (this.agent === 'claude') {
      if (r.subtype !== 'success' || r.isError) return `claude result ${r.subtype || 'error'}${r.isError ? ' (is_error)' : ''}`;
      return null;
    }
    return typeof r.exitCode === 'number' && r.exitCode !== 0 ? `copilot result exitCode ${r.exitCode}` : null;
  }

  push(line) {
    const s = String(line).trim();
    if (!s.startsWith('{')) return;
    let ev;
    try { ev = JSON.parse(s); } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    this.eventCount += 1;
    if (this.agent === 'claude') this._claude(ev);
    else this._copilot(ev);
  }

  _skill(id, rawName) {
    if (typeof rawName !== 'string' || !rawName) return;
    if (id) {
      if (this._seen.has(id)) return;
      this._seen.add(id);
    }
    // `model-apps:genpage` → plugin skill `genpage`; a bare name is the plugin's only when the
    // plugin actually ships a skill by that name (Copilot does not namespace).
    const m = rawName.match(/^([^:]+):(.+)$/);
    const name = m ? m[2] : rawName;
    const ofPlugin = m ? m[1] === this.pluginName && this.pluginSkills.has(name) : this.pluginSkills.has(name);
    this.skillCalls.push({ raw: rawName, name, ofPlugin });
  }

  _claude(ev) {
    if (ev.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.skills)) {
      this.loadedSkills = ev.skills.slice();
    } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type === 'tool_use' && c.name === 'Skill' && c.input) this._skill(c.id, c.input.skill);
        else if (c.type === 'text' && typeof c.text === 'string') this.text = c.text;
      }
    } else if (ev.type === 'result') {
      this.result = { subtype: ev.subtype, isError: ev.is_error === true, turns: ev.num_turns, costUsd: ev.total_cost_usd };
    }
  }

  _copilot(ev) {
    const d = ev.data || {};
    if (ev.type === 'assistant.message') {
      for (const r of d.toolRequests || []) {
        if (r.name === 'skill' && r.arguments) this._skill(r.toolCallId, r.arguments.skill);
      }
      if (typeof d.content === 'string' && d.content) this.text = d.content;
    } else if (ev.type === 'tool.execution_start' && d.toolName === 'skill' && d.arguments) {
      this._skill(d.toolCallId, d.arguments.skill);
    } else if (ev.type === 'result') {
      this.result = { exitCode: ev.exitCode, premiumRequests: ev.usage && ev.usage.premiumRequests };
    }
  }
}

/** Parse a whole transcript at once (tests, and re-grading saved transcripts). */
function parseTranscript(agent, text, plugin) {
  const p = new TranscriptParser(agent, plugin);
  for (const line of String(text).split(/\r?\n/)) p.push(line);
  return p;
}

module.exports = { TranscriptParser, parseTranscript, AGENTS };
