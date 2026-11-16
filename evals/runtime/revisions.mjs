import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { confinedPath } from './paths.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const git = (root, args, encoding) => execFileSync('git', args, {
  cwd: root, encoding, maxBuffer: 128 * 1024 * 1024, windowsHide: true,
});

export async function snapshotPlugin(root, ref, destination) {
  if (typeof ref !== 'string' || ref.startsWith('-') || !ref.trim()) throw new Error('Invalid source revision');
  const commit = git(root, ['rev-parse', '--verify', `${ref}^{commit}`], 'utf8').trim();
  const prefix = 'plugins/power-pages/';
  // ls-tree emits "100644 blob <oid>\t<path>\0". Paths may contain tabs or
  // newlines, so split only at the first tab and the NUL record delimiter.
  // Read Git objects rather than checking out a branch: no hooks, smudge filters,
  // platform newline conversion, or writes to someone else's checkout can run.
  const entries = git(root, ['ls-tree', '-rz', commit, '--', prefix], 'utf8')
    .split('\0').filter(Boolean).map(record => {
      const tab = record.indexOf('\t');
      const [mode, type, oid] = record.slice(0, tab).split(' ');
      const name = record.slice(tab + 1);
      if (!['100644', '100755'].includes(mode) || type !== 'blob' || !name.startsWith(prefix)) {
        throw new Error('Revision plugin must contain only regular files');
      }
      return { oid, name: name.slice(prefix.length) };
    });
  if (!entries.length) throw new Error('Revision has no Power Pages plugin');
  const data = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root, input: entries.map(entry => entry.oid).join('\n') + '\n',
    maxBuffer: 128 * 1024 * 1024, windowsHide: true,
  });
  await mkdir(destination, { recursive: false });
  let offset = 0;
  for (const entry of entries) {
    // cat-file --batch returns "<oid> blob <size>\n<raw bytes>\n".
    // A blob can contain any delimiter; its declared byte count is authoritative.
    const end = data.indexOf(10, offset);
    const [oid, type, count] = data.subarray(offset, end).toString('utf8').split(' ');
    const size = Number(count);
    if (oid !== entry.oid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0 ||
        end < 0 || end + 1 + size >= data.length || data[end + 1 + size] !== 10) {
      throw new Error('Invalid Git object batch');
    }
    const target = await confinedPath(destination, entry.name, { missing: true });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data.subarray(end + 1, end + 1 + size));
    offset = end + size + 2;
  }
  if (offset !== data.length) throw new Error('Unexpected Git object batch data');
  return commit;
}

export async function pairedInputIdentity(suite, settings) {
  const inputs = [];
  for (const stimulus of suite.stimuli) {
    const files = [];
    for (const file of stimulus.environment?.files ?? []) {
      files.push({ dest: file.dest, sha256: digest(await readFile(await confinedPath(suite.suiteDir, file.src))) });
    }
    inputs.push({ name: stimulus.name, prompt: stimulus.prompt, files });
  }
  return digest(JSON.stringify({ inputs, settings }));
}
