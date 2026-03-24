const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectTrackedSkill,
  getTrackedSkillFromToolInput,
  getValidatorScript,
} = require('../lib/powerpages-hook-utils');

test('detectTrackedSkill recognizes tracked skill references', () => {
  assert.equal(detectTrackedSkill('create-site'), 'create-site');
  assert.equal(detectTrackedSkill('/power-pages:setup-auth'), 'setup-auth');
  assert.equal(detectTrackedSkill('power-pages:add-seo'), 'add-seo');
  assert.equal(detectTrackedSkill('/power-pages:deploy-site'), null);
});

test('detectTrackedSkill recognizes slash command aliases without plugin prefix', () => {
  assert.equal(detectTrackedSkill('/create-site'), 'create-site');
  assert.equal(detectTrackedSkill('/setup-auth'), 'setup-auth');
  assert.equal(detectTrackedSkill('/integrate-webapi'), 'integrate-webapi');
  assert.equal(detectTrackedSkill('/audit-permissions'), 'audit-permissions');
  assert.equal(detectTrackedSkill('/deploy-site'), null);
});

test('getTrackedSkillFromToolInput finds a tracked skill in common fields', () => {
  assert.equal(getTrackedSkillFromToolInput({ skill_name: 'create-site' }), 'create-site');
  assert.equal(getTrackedSkillFromToolInput({ name: '/power-pages:setup-auth' }), 'setup-auth');
  assert.equal(
    getTrackedSkillFromToolInput({ command: 'run /power-pages:integrate-webapi for this repo' }),
    'integrate-webapi'
  );
  assert.equal(getTrackedSkillFromToolInput({ name: 'deploy-site' }), null);
});

test('getValidatorScript returns validator paths only for command-backed skills', () => {
  assert.match(getValidatorScript('create-site'), /validate-site\.js$/);
  assert.equal(getValidatorScript('test-site'), null);
  assert.equal(getValidatorScript('missing-skill'), null);
});
