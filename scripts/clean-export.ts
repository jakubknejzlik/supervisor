import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { boundary, git, scanBoundary, validateBoundary } from './boundary-lib.mjs';

const args = process.argv.slice(2);
const options: Record<string, string> = {};
const flags = new Set<string>();
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (['--generic', '--skip-proof'].includes(arg)) flags.add(arg);
  else if (['--commit', '--output', '--policy'].includes(arg)) {
    const value = args[++index];
    if (!value || value.startsWith('--') || options[arg]) throw new Error('Missing or repeated export option');
    options[arg] = value;
  } else if (!arg.startsWith('--') && !options['--output']) options['--output'] = arg;
  else throw new Error('Unknown export argument');
}
if (flags.has('--generic') && options['--policy']) throw new Error('Choose complete or generic export');
if (!flags.has('--generic') && !options['--policy']) throw new Error('Protected --policy required (or explicit --generic precheck)');
const source = process.cwd();
const commit = options['--commit'] ?? git(source, ['rev-parse', 'HEAD']).trim();
if (!/^[a-f0-9]{40}$/.test(commit) || git(source, ['rev-parse', `${commit}^{commit}`]).trim() !== commit) throw new Error('Use an exact full commit SHA');
const manifest = JSON.parse(git(source, ['show', `${commit}:scripts/export-boundary.json`]));
validateBoundary(manifest);
if (JSON.stringify(manifest) !== JSON.stringify(boundary)) throw new Error('Run the exporter from the selected commit');
const parent = resolve(options['--output'] ?? '.local'); mkdirSync(parent, { recursive: true });
const target = mkdtempSync(join(parent, 'clean-export-'));
const repo = join(target, 'repository'); mkdirSync(repo);
const sandboxHome = join(target, 'home'); mkdirSync(sandboxHome);
const temp = join(target, 'tmp'); mkdirSync(temp);
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: temp, HOME: sandboxHome,
  XDG_CONFIG_HOME: join(target, 'config'), SST_TELEMETRY_DISABLED: '1', CI: 'true',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1',
  GIT_AUTHOR_NAME: 'Export', GIT_AUTHOR_EMAIL: 'export@example.invalid',
  GIT_COMMITTER_NAME: 'Export', GIT_COMMITTER_EMAIL: 'export@example.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
// Preserve the supplied shared cache exactly, including in the credential-free clone.
if (process.env.BUN_INSTALL_CACHE_DIR) env.BUN_INSTALL_CACHE_DIR = process.env.BUN_INSTALL_CACHE_DIR;
const gitExport = (command: string[]) => execFileSync('git', ['-C', repo, ...command], { env, encoding: 'utf8' }).trim();
const files: { from: string; to: string; blob: string; mode: string }[] = [];
for (const { from, to } of manifest.files) {
  const entry = git(source, ['ls-tree', commit, '--', from]).trim();
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t/.exec(entry);
  if (!match) throw new Error('Boundary source missing or not a regular Git blob');
  const destination = join(repo, to); mkdirSync(dirname(destination), { recursive: true });
  // Read committed object bytes, never working-tree/index bytes or symlink targets.
  writeFileSync(destination, execFileSync('git', ['-C', source, 'cat-file', 'blob', match[2]]));
  chmodSync(destination, match[1] === '100755' ? 0o755 : 0o644);
  files.push({ from, to, blob: match[2], mode: match[1] });
}
gitExport(['init', '--quiet', '--initial-branch=main', '--template=']);
gitExport(['config', 'core.autocrlf', 'false']);
gitExport(['add', '--all']);
gitExport(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Initial sanitized source export']);
const rootCommit = gitExport(['rev-parse', 'HEAD']);
const tree = gitExport(['rev-parse', 'HEAD^{tree}']);
if (gitExport(['rev-list', '--all', '--count']) !== '1' ||
    gitExport(['rev-list', '--parents', 'HEAD']) !== rootCommit ||
    gitExport(['for-each-ref', '--format=%(refname)']) !== 'refs/heads/main' ||
    gitExport(['remote']).length) throw new Error('Fresh history invariant failed');
const exportedRows = gitExport(['ls-tree', '-r', 'HEAD']).split('\n');
if (exportedRows.length !== files.length) throw new Error('Export file count mismatch');
for (const file of files) {
  if (!exportedRows.includes(`${file.mode} blob ${file.blob}\t${file.to}`)) throw new Error('Export byte/mode equivalence failed');
}
const scan = scanBoundary(repo, { generic: flags.has('--generic'), policyFile: options['--policy'], scratch: temp,
  reportFile: join(target, 'boundary.json') });
const bundle = join(target, 'export.bundle'); gitExport(['bundle', 'create', bundle, 'refs/heads/main']);
gitExport(['bundle', 'verify', bundle]);
const clone = join(target, 'clone');
execFileSync('git', ['clone', '--quiet', '--no-tags', '--single-branch', '--branch', 'main', bundle, clone], { env });
execFileSync('git', ['-C', clone, 'remote', 'remove', 'origin'], { env });
if (git(clone, ['rev-parse', 'HEAD^{tree}']).trim() !== tree) throw new Error('Bundle clone tree mismatch');
const proof: { sourceCommit: string; tree: string; rootCommit: string; fileCount: number; bundle: string; clone: string;
  files: typeof files; scan: typeof scan; results: { command: string[]; exitCode: number | null; output: string }[] } =
  { sourceCommit: commit, tree, rootCommit, fileCount: files.length, bundle, clone, files, scan, results: [] };
const reportPath = join(target, 'verification.json');
const save = () => writeFileSync(reportPath, JSON.stringify(proof, null, 2) + '\n'); save();
console.log(`Export ${target}\nSource ${commit}\nTree ${tree}\nRoot ${rootCommit}\nFiles ${files.length}\nBoundary ${scan.complete ? 'complete' : 'GENERIC ONLY'} @ ${commit}`);
if (!flags.has('--skip-proof')) {
  const commands = [['bun', 'install', '--frozen-lockfile'], ['bun', 'run', 'dev', '--', '--smoke'],
    ['bun', 'run', 'dev', '--', '--smoke', '--sample'], ['bun', 'run', 'test'],
    ['bun', 'run', 'typecheck'], ['bun', 'run', 'build'], ['bun', 'run', 'bundle:check'],
    ['bunx', '--no-install', 'playwright', 'install', 'chromium'], ['bun', 'run', 'test:e2e']];
  for (const [command, ...parameters] of commands) {
    const result = spawnSync(command, parameters, { cwd: clone, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    console.log(`$ ${[command, ...parameters].join(' ')}\n${output}Exit: ${result.status}`);
    proof.results.push({ command: [command, ...parameters], exitCode: result.status, output }); save();
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log(`Export proof: ${reportPath}`);
