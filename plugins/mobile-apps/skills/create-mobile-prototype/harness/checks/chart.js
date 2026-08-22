'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { adoptedTypeRoles, typeRole } = require('./discipline');

function chartTokenNames(source) {
  const block = String(source || '').match(/export const chartTokens\s*=\s*\{([\s\S]*?)\}\s*as const/)?.[1] || '';
  return new Set([...block.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:/gm)].map((match) => match[1]));
}

function descendants(element, byParent) {
  const output = [];
  const queue = [...(byParent.get(element.id) || [])];
  while (queue.length > 0) {
    const child = queue.shift();
    output.push(child);
    queue.push(...(byParent.get(child.id) || []));
  }
  return output;
}

function run(snapshot, context) {
  const contract = context.chartContract;
  const roots = snapshot.elements.filter((element) => element.visible && element.testId.startsWith('chart:'));
  if (!contract) {
    if (roots.some((element) => /^chart:(sparkline|series-chart:)/.test(element.testId))) return { pass: false, failures: ['screen renders a chart without an approved Chart contract'] };
    return { pass: true, failures: [], reportOnly: true, report: { applicable: false } };
  }
  const failures = [];
  const packagePath = path.join(context.projectDir, 'package.json');
  const dependencies = fs.existsSync(packagePath) ? JSON.parse(fs.readFileSync(packagePath, 'utf8')).dependencies || {} : {};
  if (dependencies['d3-scale'] !== '4.0.2') failures.push('chart requires exact d3-scale@4.0.2');
  if (dependencies['@types/d3-scale'] !== '4.0.9') failures.push('chart requires exact @types/d3-scale@4.0.9');

  const expectedTestId = contract.kind === 'sparkline' ? 'chart:sparkline' : `chart:series-chart:${contract.form}`;
  const root = snapshot.elements.find((element) => element.visible && element.testId === expectedTestId);
  if (!root) return { pass: false, failures: [...failures, `missing ${expectedTestId}`] };
  const byParent = new Map();
  for (const element of snapshot.elements) {
    const children = byParent.get(element.parentId) || [];
    children.push(element);
    byParent.set(element.parentId, children);
  }
  const children = descendants(root, byParent);
  const points = children.filter((element) => element.testId.startsWith('chart-point:'));
  if (points.length !== contract.points) failures.push(`chart renders ${points.length} points, planned ${contract.points}`);
  if (points.length > 12) failures.push('chart exceeds 12-point v1 limit');
  if (contract.kind === 'sparkline' && points.length < 4) failures.push('sparkline requires at least 4 ordered points');

  const tokens = chartTokenNames(context.brandTokenSource);
  const seriesToken = root.attributes?.['data-chart-series-token'];
  if (!seriesToken || !tokens.has(seriesToken) || !/^series/.test(seriesToken)) failures.push(`chart series token ${seriesToken || '<missing>'} is absent from chartTokens`);
  if (contract.kind === 'series-chart') {
    const gridToken = root.attributes?.['data-chart-grid-token'];
    if (gridToken !== 'grid' || !tokens.has(gridToken)) failures.push('series chart grid must resolve to chartTokens.grid');
    const adopted = adoptedTypeRoles(context.brandTokenSource);
    const axisLabels = children.filter((element) => element.testId === 'chart-axis-label');
    if (axisLabels.length === 0) failures.push('series chart requires labelled axes');
    for (const label of axisLabels) {
      if (typeRole(label, adopted) !== 'labelSmall') failures.push(`axis label ${JSON.stringify(label.text)} must use labelSmall`);
    }
    if (contract.form === 'area' && !children.some((element) => element.testId === 'gradient:chartArea:magnitude')) failures.push('area chart requires gradient:chartArea:magnitude');
  } else if (!points.some((point) => point.attributes?.['data-chart-endpoint'] === 'true')) {
    failures.push('sparkline must emphasize its endpoint');
  }

  const caption = children.find((element) => element.testId === 'chart-caption' && String(element.text || '').trim());
  if (!caption) failures.push('chart requires a visible chart-caption');
  if (!String(root.ariaLabel || '').trim()) failures.push('chart root requires an accessible text summary');
  return {
    pass: failures.length === 0,
    failures,
    reportOnly: failures.length === 0,
    report: { applicable: true, kind: contract.kind, form: contract.form, pointCount: points.length, seriesToken, caption: caption?.text || null },
  };
}

module.exports = { chartTokenNames, run };