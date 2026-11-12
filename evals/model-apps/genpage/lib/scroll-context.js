// The Layer 2 grade for "the page establishes a scroll context" (AB#6793599): a generated page renders
// inside a host container of fixed height that never scrolls, so a page whose top element is not bounded
// by that container and made to scroll clips everything below the fold, with no error anywhere.
//
// It grades with the plugin's own rule (plugins/model-apps/scripts/lib/page-scroll.js), the one the
// /genpage gate runs through check-griffel-styles.js, so the eval and the gate cannot drift apart.
//
// The pages captured before the rule existed are real outputs and are not rewritten, so they are listed
// below with the verdict the rule gives them today and report SKIP with that verdict as the reason: the
// report still shows which captures clip. A page that is not listed (a new capture) is graded.
// scripts/tests/page-scroll.test.js pins this list against the files, so a parser change that flips a
// verdict, or a new capture that does not pass, fails the plugin suite rather than drifting silently.

'use strict';

const path = require('node:path');
const { analyzePageScroll } = require('../../../../plugins/model-apps/scripts/lib/page-scroll.js');

const SCROLL_CONTEXT_ASSERTION = 'Generated .tsx establishes a scroll context: its top element is bounded by the host (height 100%) and scrolls, or holds a bounded scrolling body, so content below the fold is reachable';

// Keyed by the page's path below evals/model-apps/genpage/fixtures/, with forward slashes. The verdict
// words are the ones verdictOf returns: fail, padding, unproven:<reason>.
const CAPTURED_BEFORE_THE_RULE = Object.freeze({
  '11-recruitment-multi-page/candidate-list.tsx': 'padding',
  '11-recruitment-multi-page/hiring-metrics.tsx': 'fail',
  '11-recruitment-multi-page/interview-schedule.tsx': 'padding',
  '11-recruitment-pages-real/candidate-list.tsx': 'fail',
  '11-recruitment-pages-real/hiring-metrics-dashboard.tsx': 'fail',
  '15-support-tickets-real/support-tickets.tsx': 'fail',
  '17-weather-mock-data/weather-dashboard.tsx': 'fail',
  '18-sharepoint-connectors/sharepoint-docs.tsx': 'fail',
  '19-add-weather-connector/weather-panel.tsx': 'fail',
  '2-mock-dashboard-real/sales-dashboard.tsx': 'unproven:style-expression',
  '2-mock-dashboard/dashboard.tsx': 'fail',
  '20-upload-preservation/revenue.tsx': 'fail',
  '22-navigation-contract/before/overview.tsx': 'fail',
  '22-navigation-contract/before/pet-gallery.tsx': 'fail',
  '22-navigation-contract/before/pet.tsx': 'fail',
  '22-navigation-contract/overview.tsx': 'fail',
  '22-navigation-contract/pet-gallery.tsx': 'fail',
  '22-navigation-contract/pet.tsx': 'fail',
  '23-worker-completeness/page.tsx': 'fail',
  '24-custom-api-lifecycle/page.tsx': 'fail',
  '24-custom-api-lifecycle/stages/with-api.tsx': 'fail',
  '25-solution-package/list.tsx': 'fail',
  '25-solution-package/metrics.tsx': 'fail',
  '25-solution-package/schedule.tsx': 'fail',
  '26-customer-lookup/customer-lookup.tsx': 'fail',
  '27-page-error-helper/order-approvals.tsx': 'fail',
  '4-case-wizard/page.tsx': 'fail',
  '5-kanban-task-board/task-board.tsx': 'fail',
  '6-traffic-analytics-mock/traffic-dashboard.tsx': 'fail',
  '8-account-metrics-new-app/account-metrics.tsx': 'fail',
  '9-project-tracker-new-entities/project-tracker.tsx': 'fail',
  'stable-turn-retry/ordinary/revenue.tsx': 'fail',
  'stable-turn-retry/revenue.tsx': 'fail',
});

// One word for what the rule says about a page: pass, fail (no scroll context), unproven:<reason> (the
// rule cannot read the top element), padding (it scrolls, but a padded box overhangs the host), or
// "not judged: <why>" (no default export the rule can find, or it renders nothing).
function verdictOf(source) {
  const r = analyzePageScroll(source);
  if (!r.judged) return { verdict: `not judged: ${r.why}`, problem: null };
  const fail = r.problems.find((p) => p.code === 'no-scroll-context');
  if (fail) return { verdict: 'fail', problem: fail };
  const unproven = r.problems.find((p) => p.code === 'scroll-context-unproven');
  if (unproven) return { verdict: `unproven:${unproven.reason}`, problem: unproven };
  const padded = r.problems.find((p) => p.code === 'scroll-context-padding');
  if (padded) return { verdict: 'padding', problem: padded };
  return { verdict: 'pass', problem: null };
}

// `fixture.dir` is the fixture's own folder (fixtures/<dirName>); a page's key is its path below the
// fixtures root, so a page in a subfolder of the fixture keeps that subfolder.
function capturedKey(fixture, file) {
  const rel = fixture && fixture.dir ? path.relative(fixture.dir, file.path) : file.name;
  return `${fixture && fixture.dirName ? fixture.dirName : ''}/${rel}`.replace(/\\/g, '/').replace(/^\//, '');
}

function gradeScrollContext({ files, fixture }) {
  const skipped = [];
  let graded = 0;
  for (const file of files) {
    const key = capturedKey(fixture, file);
    const { verdict, problem } = verdictOf(file.content);
    if (Object.prototype.hasOwnProperty.call(CAPTURED_BEFORE_THE_RULE, key)) {
      skipped.push(`${file.name}: captured before the rule (${verdict})`);
      continue;
    }
    if (verdict.startsWith('not judged')) continue;
    graded += 1;
    if (problem) return { status: 'fail', reason: `${file.name}:${problem.line}:${problem.column}: ${problem.code}: ${problem.message}` };
  }
  if (graded) return { status: 'pass', reason: '' };
  return { status: 'skip', reason: skipped.length ? skipped.join('; ') : 'no page the rule judges' };
}

module.exports = { SCROLL_CONTEXT_ASSERTION, CAPTURED_BEFORE_THE_RULE, gradeScrollContext, verdictOf };
