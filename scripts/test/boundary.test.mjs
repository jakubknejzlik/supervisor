import { createHash } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { boundary, inspectText, loadPolicy, scanBoundary, validateBoundary } from '../boundary-lib.mjs';

const scratchParent = resolve(process.env.TMPDIR ?? '.local/tmp'); mkdirSync(scratchParent, { recursive: true });
const scratch = mkdtempSync(join(scratchParent, 'boundary-tests-'));
const env = { PATH: process.env.PATH, HOME: join(scratch, 'home'), TMPDIR: scratch,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'author@example.invalid',
  GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'author@example.invalid' };
mkdirSync(env.HOME);
const policy = join(scratch, 'policy.json');
const literals = Object.fromEntries(['A', 'D', 'C', 'S', 'P', 'E'].map(category => [category, [`synthetic-forbidden-${category.toLowerCase()}`]]));
writeFileSync(policy, JSON.stringify({ version: 1, literals }));
const scan = repo => scanBoundary(repo, { policyFile: policy, scratch });
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function fixture(name) {
  const repo = join(scratch, name); mkdirSync(repo);
  git(repo, 'init', '--quiet', '--initial-branch=main', '--template=');
  writeFileSync(join(repo, 'README.md'), 'Synthetic fixture\n');
  git(repo, 'add', '.'); git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial');
  return repo;
}
function commit(repo, message) {
  git(repo, 'add', '--all'); git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
}
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

it('fails closed on missing/incomplete policy, missing scanner and shallow history', () => {
  expect(() => loadPolicy()).toThrow('Protected policy required');
  const bad = join(scratch, 'empty.json'); writeFileSync(bad, '{}');
  expect(() => loadPolicy(bad)).toThrow('incomplete');
  const repo = fixture('clean');
  expect(scan(repo)).toMatchObject({ complete: true, commits: 1, findings: [], gitleaks: { version: '8.30.1' } });
  writeFileSync(join(repo, 'README.md'), 'Uncommitted synthetic content');
  expect(() => scan(repo)).toThrow('differs from HEAD');
  git(repo, 'checkout', '--', 'README.md');
  writeFileSync(join(repo, 'project-register.json'), '{}');
  expect(() => scan(repo)).toThrow('differs from HEAD');
  rmSync(join(repo, 'project-register.json'));
  const result = spawnSync(process.execPath, ['scripts/scan-public-history.mjs', '--repo', repo, '--scratch', scratch], { env, encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Protected policy required');
  const shallow = join(scratch, 'shallow');
  execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${repo}`, shallow], { env });
  expect(() => scan(shallow)).toThrow('Incomplete');
  const noScanner = spawnSync(process.execPath, ['scripts/scan-public-history.mjs', '--repo', repo, '--generic', '--scratch', scratch], {
    env: { ...env, PATH: '' }, encoding: 'utf8',
  });
  expect(noScanner.status).not.toBe(0);
});

it.each(['history', 'branch', 'tag'])('gitleaks rejects a synthetic secret reachable only through %s', mode => {
  const repo = fixture(`secret-${mode}`);
  if (mode !== 'history') git(repo, 'checkout', '-qb', 'side');
  // This exact synthetic value is allowed only at its reviewed fixture path.
  copyFileSync('scripts/test/fixtures/synthetic-secret.txt', join(repo, 'README.md'));
  commit(repo, 'Synthetic planted fixture');
  if (mode === 'history') {
    writeFileSync(join(repo, 'README.md'), 'Clean current content\n'); commit(repo, 'Remove fixture');
  } else {
    if (mode === 'tag') git(repo, '-c', 'tag.gpgsign=false', 'tag', '-a', 'synthetic-tag', '-m', 'Retained fixture');
    git(repo, 'checkout', '-q', 'main');
    if (mode === 'tag') git(repo, 'branch', '-D', 'side');
  }
  const result = spawnSync(process.execPath, ['scripts/scan-public-history.mjs', '--repo', repo,
    '--policy', policy, '--scratch', scratch], { env, encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Gitleaks git failed');
  console.log(`synthetic-${mode}: complete boundary exit ${result.status} (gitleaks history rejection)`);
});

it.each(['history', 'branch', 'tag-metadata', 'commit-metadata', 'ref', 'path'])('exact policy rejects %s markers', mode => {
  const repo = fixture(`marker-${mode}`);
  if (mode === 'history' || mode === 'branch') {
    if (mode === 'branch') git(repo, 'checkout', '-qb', 'side');
    writeFileSync(join(repo, 'README.md'), literals.A[0]); commit(repo, 'Plant marker');
    if (mode === 'history') { writeFileSync(join(repo, 'README.md'), 'Clean\n'); commit(repo, 'Remove marker'); }
    else git(repo, 'checkout', '-q', 'main');
  } else if (mode === 'tag-metadata') git(repo, '-c', 'tag.gpgsign=false', 'tag', '-a', 'synthetic-tag', '-m', literals.A[0]);
  else if (mode === 'commit-metadata') git(repo, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', literals.A[0]);
  else if (mode === 'ref') git(repo, 'branch', literals.A[0]);
  else { writeFileSync(join(repo, 'project-register.json'), '{}'); commit(repo, 'Forbidden path'); }
  const report = join(scratch, `${mode}.json`);
  expect(() => scanBoundary(repo, { policyFile: policy, scratch, reportFile: report })).toThrow('Boundary failed');
  expect(JSON.parse(readFileSync(report)).findings.some(item => mode === 'path' ? item.category === 'path-or-mode' : item.category === 'A')).toBe(true);
});

it('rejects binary files, symlinks, unapproved files and unsafe manifest mappings', () => {
  const repo = fixture('binary'); writeFileSync(join(repo, 'README.md'), Buffer.from([0, 255])); commit(repo, 'Binary');
  expect(() => scan(repo)).toThrow('Boundary failed');
  const linkRepo = fixture('symlink'); rmSync(join(linkRepo, 'README.md'));
  symlinkSync('synthetic-target', join(linkRepo, 'README.md')); commit(linkRepo, 'Symlink');
  expect(() => scan(linkRepo)).toThrow('Boundary failed');
  const blobRepo = fixture('blob-ref');
  const blob = execFileSync('git', ['-C', blobRepo, 'hash-object', '-w', '--stdin'], { input: 'Synthetic blob', env, encoding: 'utf8' }).trim();
  git(blobRepo, 'update-ref', 'refs/tags/blob-tag', blob);
  expect(() => scan(blobRepo)).toThrow('Boundary failed');
  for (const to of ['../escape', 'live/source.ts', 'project-register.json', '.git/config']) {
    expect(() => validateBoundary({ version: 1, files: [{ from: 'README.md', to }] })).toThrow();
  }
  expect(() => validateBoundary({ ...boundary, files: [boundary.files[0], boundary.files[0]] })).toThrow();
  expect(inspectText('example@example.invalid', 'sample', literals)).toEqual([]);
  expect(inspectText(['C', '0123456789'].join(''), 'sample', literals)[0].category).toBe('slack-id');
});

it('scans annotated tag secrets as metadata, beyond the patch history', () => {
  const repo = fixture('tag-secret-metadata');
  git(repo, '-c', 'tag.gpgsign=false', 'tag', '-a', 'synthetic-tag', '-m', readFileSync('scripts/test/fixtures/synthetic-secret.txt', 'utf8'));
  expect(() => scan(repo)).toThrow('Gitleaks dir failed');
});

// Construct the non-example address so the test source itself is exportable.
const rejectedEmail = ['synthetic-boundary-probe', 'synthetic.invalid'].join('@');
function capturedScan(repo, mode, label) {
  const report = join(scratch, `${label}.json`);
  const result = spawnSync(process.execPath, ['scripts/scan-public-history.mjs', '--repo', repo,
    ...(mode === 'generic' ? ['--generic'] : ['--policy', policy]), '--scratch', scratch, '--report', report],
  { env, encoding: 'utf8' });
  const outputs = [readFileSync(report, 'utf8'), result.stdout, result.stderr];
  outputs.forEach(output => expect(output).not.toContain(rejectedEmail));
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Boundary failed');
  return JSON.parse(outputs[0]);
}

it.each(['generic', 'complete'].flatMap(mode => ['branch', 'tag'].map(kind => ({ mode, kind }))))(
  'redacts rejected $kind names with verifiable ref identities in $mode mode', ({ mode, kind }) => {
    const repo = fixture(`redacted-${mode}-${kind}`);
    const name = `synthetic-${rejectedEmail}`;
    if (kind === 'branch') git(repo, 'branch', '-m', name);
    else git(repo, '-c', 'tag.gpgsign=false', 'tag', '-a', name, '-m', 'Synthetic tag');
    const fullName = `refs/${kind === 'branch' ? 'heads' : 'tags'}/${name}`;
    const oid = git(repo, 'rev-parse', fullName);
    const names = git(repo, 'for-each-ref', '--sort=refname', '--format=%(refname)').split('\n');
    const identity = { index: names.indexOf(fullName), oid,
      nameDigest: createHash('sha256').update(fullName).digest('hex') };
    const report = capturedScan(repo, mode, `ref-${mode}-${kind}`);
    expect(report.complete).toBe(mode === 'complete');
    expect(report.refs).toContainEqual(identity);
    expect(report.refs.every(ref => Object.keys(ref).sort().join(',') === 'index,nameDigest,oid')).toBe(true);
    expect(report.findings).toContainEqual({ object: identity, line: 1, category: 'email' });
    if (kind === 'branch') expect(report.refs).toHaveLength(1);
  },
);

it.each(['generic', 'complete'].flatMap(mode => ['path', 'commit-message', 'tag-message', 'content'].map(kind => ({ mode, kind }))))(
  'never echoes rejected $kind values in $mode mode', ({ mode, kind }) => {
    const repo = fixture(`redacted-${mode}-${kind}`);
    if (kind === 'path') { writeFileSync(join(repo, rejectedEmail), 'Synthetic path'); commit(repo, 'Path fixture'); }
    else if (kind === 'commit-message') git(repo, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', rejectedEmail);
    else if (kind === 'tag-message') git(repo, '-c', 'tag.gpgsign=false', 'tag', '-a', 'synthetic-tag', '-m', rejectedEmail);
    else { writeFileSync(join(repo, 'README.md'), rejectedEmail); commit(repo, 'Content fixture'); }
    expect(capturedScan(repo, mode, `value-${mode}-${kind}`).findings.some(item => item.category === 'email')).toBe(true);
  },
);

it.each(['git', 'filesystem', 'report'])('redacts scanner %s failure diagnostics', kind => {
  const repo = kind === 'git' ? join(scratch, rejectedEmail) : fixture(`error-${kind}`);
  const blocked = join(scratch, `blocked-${kind}-${rejectedEmail}`);
  if (kind === 'filesystem') writeFileSync(blocked, 'Synthetic non-directory');
  const result = spawnSync(process.execPath, ['scripts/scan-public-history.mjs', '--repo', repo,
    '--generic', '--scratch', kind === 'filesystem' ? blocked : scratch,
    ...(kind === 'report' ? ['--report', join(blocked, 'report.json')] : [])], { env, encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).not.toContain(rejectedEmail);
  expect(result.stderr).toContain('values redacted');
});

// Extract and execute the actual pre-scan shell blocks, rather than copies of
// individual fetch commands. A new empty destination exercises the first fetch.
const checkoutBlocks = ['checks', 'boundary'].flatMap(template => {
  const workflow = readFileSync(`scripts/export-templates/${template}.yml`, 'utf8');
  if (workflow.includes('actions/checkout@')) throw new Error('Pre-scan checkout action must not log candidate data');
  return [...workflow.matchAll(/      - name: (Quiet checkout [^\n]+)\n([\s\S]*?)(?=      - |$)/g)].map(match => {
    const path = /CHECKOUT_PATH: (.+)/.exec(match[2])[1];
    const script = match[2].split('        run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n');
    return { template, name: match[1], path, script };
  });
});
it.each(checkoutBlocks)('workflow $template / $name hides refs, subjects and Git errors on first fetch', ({ template, name, path, script }) => {
  const id = `${template}-${name.replaceAll(' ', '-')}`;
  const source = fixture(`workflow-source-${id}`);
  git(source, 'branch', '-m', `synthetic-${rejectedEmail}`);
  git(source, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', `Synthetic subject ${rejectedEmail}`);
  git(source, 'tag', `synthetic-${rejectedEmail}`);
  const sha = git(source, 'rev-parse', 'HEAD');
  const remote = join(scratch, `remote-${id}.git`);
  execFileSync('git', ['clone', '--quiet', '--bare', source, remote], { env, stdio: 'pipe' });
  for (const failure of [false, true]) {
    const cwd = join(scratch, `checkout-${id}-${failure}`); mkdirSync(cwd);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
      cwd, env: { ...env, SCAN_SHA: sha, CHECKOUT_PATH: path, GH_TOKEN: '',
        SOURCE_URL: failure ? join(scratch, `missing-${rejectedEmail}.git`) : remote }, encoding: 'utf8',
    });
    expect(result.stdout + result.stderr).not.toContain(rejectedEmail);
    expect(result.status).toBe(failure ? 1 : 0);
    if (failure) expect(result.stderr).toBe('Boundary checkout failed; values redacted\n');
    else {
      expect(result.stdout + result.stderr).toBe('');
      const checkout = join(cwd, path);
      expect(git(checkout, 'rev-parse', 'HEAD')).toBe(sha);
      expect(git(checkout, 'log', '-1', '--format=%s')).toContain(rejectedEmail);
      expect(git(checkout, 'for-each-ref', '--format=%(refname)')).toContain(rejectedEmail);
      expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('false');
    }
  }
});

it('accepts reviewed Apache-2.0 uppercase wording but still flags Slack-shaped IDs', () => {
  for (const line of ['TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
    'WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND', 'DASHBOARD']) expect(inspectText(line, 'LICENSE')).toEqual([]);
  expect(inspectText(['owner U0', 'ABCDEFGH'].join(''), 'x').map(f => f.category)).toEqual(['slack-id']);
  expect(inspectText(['CONDITIONS', 'X'].join(''), 'x').map(f => f.category)).toEqual(['slack-id']);
});
