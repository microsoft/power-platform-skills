import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, lstat, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const { validateSummary } = require('../../site/lib/evaluations.js');
const execute = promisify(execFile);
const workflow = 'power-pages-evals.yml';
// Older artifacts name only the skill; matrix artifacts use
// "power-pages-evals-setup-auth--claude-opus-5.5". The double hyphen separates
// the single-hyphen skill slug from the explicit model ID without guessing.
const artifactPattern = /^power-pages-evals-([a-z0-9]+(?:-[a-z0-9]+)*)(?:--([a-z0-9][a-z0-9._-]{0,127}))?$/;

export async function fetchResults({ repo, out, exec = execute }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('GITHUB_REPOSITORY must identify the source repository');
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(out);
  const scratch = await mkdtemp(path.join(tmpdir(), 'pp-published-evals-'));
  const gh = async args => {
    const { stdout } = await exec('gh', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  };
  try {
    let runs;
    try {
      runs = JSON.parse(await gh([
        'api', `repos/${repo}/actions/workflows/${workflow}/runs`,
        '--method', 'GET', '-f', 'branch=main', '-f', 'event=workflow_dispatch', '-f', 'per_page=20',
      ])).workflow_runs;
    } catch (error) {
      // A 404 can also hide an authorization failure. Confirm the workflow is
      // absent from an accessible Actions listing before publishing an empty page.
      if (/\(HTTP 404\)/.test(error.stderr ?? '')) {
        const pages = JSON.parse(await gh([
          'api', `repos/${repo}/actions/workflows?per_page=100`, '--paginate', '--slurp',
        ]));
        if (!Array.isArray(pages) || !pages.length ||
            pages.some(page => !Array.isArray(page.workflows) ||
              page.workflows.some(item => typeof item.path !== 'string'))) {
          throw new Error('Malformed workflow listing response');
        }
        if (pages.some(page => page.workflows.some(item => item.path === `.github/workflows/${workflow}`))) throw error;
        console.log('Evaluation workflow is not published yet; dashboard remains untested.');
        return 0;
      }
      throw error;
    }
    if (!Array.isArray(runs)) throw new Error('Malformed workflow run response');
    let count = 0;
    for (const run of runs) {
      if (run.status !== 'completed' || run.event !== 'workflow_dispatch' || run.head_branch !== 'main' ||
          run.repository?.full_name !== repo || run.head_repository?.full_name !== repo) continue;
      if (!Number.isSafeInteger(run.id) || run.id < 1 || !/^[a-f0-9]{40}$/.test(run.head_sha)) {
        throw new Error('Invalid source run provenance');
      }
      const response = JSON.parse(await gh(['api', `repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`]));
      if (!Array.isArray(response.artifacts)) throw new Error('Malformed artifact response');
      const artifacts = response.artifacts.filter(artifact => !artifact.expired && artifactPattern.test(artifact.name));
      if (!artifacts.length) continue;
      if (artifacts.some(artifact => artifact.size_in_bytes > 2 * 1024 * 1024)) {
        throw new Error('Evaluation summary artifact exceeds the publication limit');
      }
      const downloaded = path.join(scratch, String(run.id));
      await gh(['run', 'download', String(run.id), '--repo', repo, '--pattern', 'power-pages-evals-*', '--dir', downloaded]);
      const roots = await readdir(downloaded);
      for (const artifact of artifacts) {
        // gh can flatten a single selected artifact into --dir. Multiple
        // artifacts use named subdirectories; support both without guessing
        // that an arbitrary downloaded JSON file is the requested summary.
        const directory = roots.includes(artifact.name) ? path.join(downloaded, artifact.name)
          : artifacts.length === 1 ? downloaded : null;
        if (!directory) throw new Error('Missing named evaluation artifact directory');
        const directoryStat = await lstat(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Invalid artifact directory');
        const entries = await readdir(directory);
        if (entries.length !== 1 || entries[0] !== 'summary.json') {
          throw new Error('Only summary.json may appear in a public evaluation artifact');
        }
        const file = path.join(directory, 'summary.json');
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
          throw new Error('Invalid summary artifact file');
        }
        const summary = validateSummary(JSON.parse(await readFile(file, 'utf8')));
        const [, skill, model] = artifactPattern.exec(artifact.name);
        if (summary.plugin !== 'power-pages' || summary.commit !== run.head_sha ||
            summary.runUrl !== `https://github.com/${repo}/actions/runs/${run.id}` ||
            summary.suites.length !== 1 || summary.suites[0].skill !== skill ||
            (model !== undefined && summary.model !== model)) {
          throw new Error('Summary does not match its trusted workflow run and skill');
        }
        await writeFile(path.join(out, `${run.id}-${artifact.name.slice('power-pages-evals-'.length)}.summary.json`), `${JSON.stringify(summary)}\n`, { flag: 'wx' });
        count++;
      }
    }
    console.log(`Fetched ${count} sanitized summaries from the latest 20 default-branch dispatch runs.`);
    return count;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--out')) {
    console.error('Usage: node evals/runtime/fetch-results.mjs [--out DIR]');
    process.exitCode = 2;
  } else {
    fetchResults({
      repo: process.env.GITHUB_REPOSITORY,
      out: path.resolve(args[1] ?? 'evals/reports/published'),
    }).catch(error => { console.error(error.message); process.exitCode = 2; });
  }
}
