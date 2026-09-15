const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(pluginRoot, ...parts), 'utf8');

test('top-level skill owns every planner discovery and compile MCP tool', () => {
    const skill = read('skills', 'canvas-app', 'SKILL.md');
    const requiredTools = [
        'compile_canvas',
        'list_controls',
        'describe_control',
        'list_apis',
        'describe_api',
        'list_data_sources',
        'get_data_source_schema',
    ];

    for (const tool of requiredTools) {
        assert.match(
            skill,
            new RegExp(`allowed-tools:.*mcp__canvas-authoring__${tool}`),
            `${tool} must be available in the MCP-owning skill context`,
        );
    }
    assert.match(skill, /Perform all MCP discovery required[\s\S]*before\s+invoking the planner/);
    assert.match(skill, /Run every `compile_canvas` operation in this top-level context/);
});

test('planner consumes a discovery packet and never claims delegated MCP ownership', () => {
    const planner = read('agents', 'canvas-app-planner.md');
    const frontmatter = planner.match(/^---\r?\n([\s\S]*?)\r?\n---/);

    assert.ok(frontmatter, 'planner frontmatter must exist');
    assert.doesNotMatch(frontmatter[1], /canvas-authoring|compile_canvas|describe_control/);
    assert.match(planner, /Do not call MCP tools/);
    assert.match(planner, /Status: Discovery Packet Blocked/);
    assert.doesNotMatch(planner, /Status: Tooling Blocked/);
    assert.match(planner, /App compile: Pending orchestrator validation/);
});

test('create and edit workflows pass discovery before planner delegation', () => {
    for (const workflow of ['CreateWorkflow.md', 'EditWorkflow.md']) {
        const contents = read('references', workflow);
        const discovery = contents.indexOf("top-level skill's MCP connection");
        const delegation = contents.indexOf('Invoke the `canvas-app-planner` agent');

        assert.ok(discovery >= 0, `${workflow} must define top-level MCP discovery`);
        assert.ok(delegation > discovery, `${workflow} must discover before delegation`);
        assert.match(contents, /Discovery packet: \[complete results gathered above\]/);
    }
});
