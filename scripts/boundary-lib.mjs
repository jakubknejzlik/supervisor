import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only these deliberately value-free errors may be printed by the CLI.
export class BoundaryError extends Error {}

export const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const boundary = JSON.parse(readFileSync(join(toolRoot, 'scripts/export-boundary.json'), 'utf8'));
export const destinations = new Set(boundary.files.map(file => file.to));
export function git(repo, args, options = {}) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024, env: scannerEnv(), ...options,
    });
  } catch { throw new BoundaryError('Git object/ref read failed; values redacted'); }
}
export function validPath(path) {
  return typeof path === 'string' && /^[A-Za-z0-9._/-]+$/.test(path) &&
    !path.split('/').some(part => !part || part === '..' || part === '.git');
}
export function validateBoundary(manifest) {
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new BoundaryError('Invalid boundary');
  const seen = new Set();
  for (const { from, to } of manifest.files) {
    if (!validPath(from) || !validPath(to) || seen.has(to) ||
        /^(live|dashboard|projects|reports|docs\/self-hosted)(\/|$)|(^|\/)(AGENTS\.md|project-register\.json|decisions\.json|deploy\.config\.json|\.env.*)$/.test(to)) {
      throw new BoundaryError('Unsafe or duplicate boundary path');
    }
    seen.add(to);
  }
}
validateBoundary(boundary);

export function scannerEnv() {
  // No config overrides, ignore files, credentials or Git replacement objects.
  return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' };
}
export function runGitleaks(repo, directory, config = join(toolRoot, '.gitleaks.toml')) {
  const env = scannerEnv();
  const version = spawnSync('gitleaks', ['version'], { encoding: 'utf8', env });
  if (version.status !== 0 || version.stdout.trim() !== '8.30.1') throw new BoundaryError('Gitleaks 8.30.1 is required');
  for (const args of [
    ['git', repo, '--log-opts=--all --full-history HEAD'], ['dir', '.'],
  ]) {
    const result = spawnSync('gitleaks', [...args, '--config', config, '--redact', '--no-banner',
      '--ignore-gitleaks-allow', '--gitleaks-ignore-path', '/dev/null'], { cwd: directory, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
    // Never echo scanner diagnostics: errors may contain source or policy values.
    if (result.status !== 0) throw new BoundaryError(`Gitleaks ${args[0]} failed (exit ${result.status ?? 'unavailable'}); values redacted`);
  }
  return { version: version.stdout.trim(), historyExit: 0, directoryExit: 0 };
}

const reviewedUppercaseWords = new Set(['DASHBOARD', 'CONDITIONS', 'DISTRIBUTION', 'WARRANTIES']);
const reservedEmail = /^[A-Za-z0-9_.+%-]+@(?:[A-Za-z0-9-]+\.)*example\.(?:invalid|com|org|net)$/i;
export function inspectText(text, label, policy) {
  const findings = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const categories = new Set();
    const lower = line.toLowerCase();
    for (const [category, literals] of Object.entries(policy ?? {})) {
      if (literals.some(literal => lower.includes(literal.toLowerCase()))) categories.add(category);
    }
    for (const match of line.matchAll(/[A-Za-z0-9_.+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      if (!reservedEmail.test(match[0])) categories.add('email');
    }
    for (const match of line.matchAll(/\b[CDUGWT][A-Z0-9]{8,}\b/g)) {
      // Reviewed shape collisions: the product label and Apache-2.0 LICENSE wording.
      if (!reviewedUppercaseWords.has(match[0])) categories.add('slack-id');
    }
    for (const match of line.matchAll(/\b(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/gi)) {
      if (!/^0{32}$|^00000000-0000-4000-8000-000000000001$/.test(match[0])) categories.add('account-id');
    }
    if (/plugin_asdk_app_[a-z0-9]+|agent[_-]id\b/i.test(line)) categories.add('integration-id');
    if (/https?:\/\/[^\s/"'<>]+\.slack\.com(?:\/|\b)|https?:\/\/[^\s/"'<>]+\.(?:internal|corp|lan)(?:\/|\b)/i.test(line)) categories.add('private-url');
    for (const category of categories) findings.push({ object: label, line: index + 1, category });
  }
  return findings;
}

export function loadPolicy(file) {
  if (!file) throw new BoundaryError('Protected policy required; use --generic only for an incomplete precheck');
  let policy;
  try { policy = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new BoundaryError('Protected policy unreadable'); }
  if (policy.version !== 1 || !policy.literals ||
      !['A', 'D', 'C', 'S', 'P', 'E'].every(category => Array.isArray(policy.literals[category]) &&
        policy.literals[category].length > 0 && policy.literals[category].every(value => typeof value === 'string' && value.length >= 3)) ||
      Object.keys(policy.literals).some(category => !['A', 'D', 'C', 'S', 'P', 'E'].includes(category))) {
    throw new BoundaryError('Protected policy incomplete (six nonempty audit categories required)');
  }
  return policy.literals;
}

/**
 * @param {string} repo
 * @param {{policyFile?: string, generic?: boolean, scratch?: string, reportFile?: string}} options
 */
export function scanBoundary(repo, { policyFile, generic = false, scratch, reportFile } = {}) {
  repo = resolve(repo);
  if (!scratch) throw new BoundaryError('An explicit --scratch directory is required');
  mkdirSync(scratch, { recursive: true });
  const policy = generic ? undefined : loadPolicy(policyFile);
  // The materialized current-content scan must describe the actual release tree.
  // Ignored build/dependency/local-config state is outside the distributed boundary.
  if (git(repo, ['status', '--porcelain=v1', '--untracked-files=all']).trim()) {
    throw new BoundaryError('Release content differs from HEAD; commit or remove changes before scanning');
  }
  // Reject incomplete graphs and alternate object databases before enumerating.
  if (git(repo, ['rev-parse', '--is-shallow-repository']).trim() !== 'false' ||
      git(repo, ['replace', '-l']).trim() ||
      /partialclone|promisor/i.test(git(repo, ['config', '--local', '--list'])) ||
      ['objects/info/alternates', 'info/grafts'].some(path => existsSync(resolve(repo, git(repo, ['rev-parse', '--git-path', path]).trim())))) throw new BoundaryError('Incomplete or replaced Git graph');
  // Never retain names in the report, even for accepted refs. The sorted index,
  // object SHA and SHA-256 of the full ref name let an operator verify identity.
  const refs = git(repo, ['for-each-ref', '--sort=refname', '--format=%(refname) %(objectname)'])
    .trim().split('\n').filter(Boolean).map((row, index) => {
      const [name, oid] = row.split(' ');
      return { name, identity: { index, oid, nameDigest: createHash('sha256').update(name).digest('hex') } };
    });
  const commits = git(repo, ['rev-list', '--all', 'HEAD']).trim().split('\n').filter(Boolean);
  if (!refs.length || !commits.length) throw new BoundaryError('Empty ref/history scan');
  const objects = git(repo, ['rev-list', '--objects', '--all', '--no-object-names', 'HEAD']).trim().split('\n').filter(Boolean);
  // Include annotated tags themselves, not just their peeled commit.
  const ids = [...new Set([...objects, ...refs.map(ref => ref.identity.oid)])];
  const findings = [];
  const checkedBlobs = new Set();
  const metadata = [];
  for (const { name, identity } of refs) {
    const { oid } = identity;
    findings.push(...inspectText(name, identity, policy));
    if (git(repo, ['cat-file', '-t', `${oid}^{}`]).trim() !== 'commit') {
      findings.push({ object: identity, line: 0, category: 'non-commit-ref' });
    }
  }
  for (const commit of commits) {
    for (const row of git(repo, ['ls-tree', '-rz', commit]).split('\0').filter(Boolean)) {
      const [header, path] = row.split('\t');
      if (!validPath(path) || !destinations.has(path) || !/^100(644|755) blob /.test(header)) {
        findings.push({ object: commit, line: 0, category: 'path-or-mode' });
      }
      findings.push(...inspectText(path, commit, policy));
    }
  }
  const batch = git(repo, ['cat-file', '--batch'], {
    input: ids.join('\n') + '\n', encoding: null, maxBuffer: 256 * 1024 * 1024,
  });
  let offset = 0;
  for (const expected of ids) {
    const end = batch.indexOf(10, offset);
    const [oid, type, size] = batch.subarray(offset, end).toString().split(' ');
    if (oid !== expected || !/^\d+$/.test(size)) throw new BoundaryError('Missing Git object');
    const content = batch.subarray(end + 1, end + 1 + Number(size));
    offset = end + 2 + Number(size);
    if (type === 'tree') continue;
    if (!['blob', 'commit', 'tag'].includes(type)) throw new BoundaryError('Unsupported Git object');
    // The approved boundary contains text only (including SVG). Reject binary/invalid UTF-8.
    const text = content.toString('utf8');
    if (content.includes(0) || !Buffer.from(text).equals(content)) findings.push({ object: oid, line: 0, category: 'binary' });
    findings.push(...inspectText(text, oid, policy));
    if (type === 'blob') checkedBlobs.add(oid);
    else metadata.push({ oid, content });
  }
  const temp = mkdtempSync(join(scratch, 'boundary-'));
  let gitleaks;
  try {
    if (!generic) {
      // Scan the protected input itself for accidental credentials, without its contents in logs.
      const result = spawnSync('gitleaks', ['dir', resolve(policyFile), '--config', join(toolRoot, '.gitleaks.toml'),
        '--redact', '--no-banner', '--ignore-gitleaks-allow', '--gitleaks-ignore-path', '/dev/null'], { env: scannerEnv() });
      if (result.status !== 0) throw new BoundaryError('Protected policy secrets scan failed; values redacted');
    }
    // Materialize tracked HEAD bytes only, avoiding ignored build/dependency/local state.
    for (const row of git(repo, ['ls-tree', '-rz', 'HEAD']).split('\0').filter(Boolean)) {
      const [header, path] = row.split('\t');
      if (!validPath(path) || !destinations.has(path) || !/^100(644|755) blob /.test(header)) continue;
      const target = join(temp, path); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, git(repo, ['cat-file', 'blob', header.split(' ')[2]], { encoding: null }));
    }
    // Patch scans do not cover commit/tag messages or identities. Scan those as files too.
    mkdirSync(join(temp, 'git-metadata'));
    for (const { oid, content } of metadata) writeFileSync(join(temp, 'git-metadata', oid), content);
    gitleaks = runGitleaks(repo, temp);
  } finally { rmSync(temp, { recursive: true, force: true }); }
  const report = { complete: !generic, refs: refs.map(ref => ref.identity), commits: commits.length, objects: ids.length, blobs: checkedBlobs.size, gitleaks, findings };
  if (reportFile) writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  if (findings.length) throw new BoundaryError(`Boundary failed: ${findings.length} findings (object/line/category only in report)`);
  return report;
}
