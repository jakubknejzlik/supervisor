import { BoundaryError, scanBoundary } from './boundary-lib.mjs';
const args = process.argv.slice(2);
function value(flag) { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; }
try {
  const allowed = new Set(['--repo', '--policy', '--scratch', '--report', '--generic', '--all-refs']);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new BoundaryError('Unknown scanner argument');
    if (!['--generic', '--all-refs'].includes(args[i])) {
      if (!args[++i] || args[i].startsWith('--')) throw new BoundaryError('Missing scanner argument');
    }
  }
  if (args.includes('--generic') && args.includes('--policy')) throw new BoundaryError('Choose complete or generic scan');
  const report = scanBoundary(value('--repo') ?? '.', {
    generic: args.includes('--generic'), policyFile: value('--policy'), scratch: value('--scratch'), reportFile: value('--report'),
  });
  console.log(`${report.complete ? 'Complete boundary PASS' : 'GENERIC PRECHECK ONLY'}: ${report.commits} commits, ${report.objects} objects, ${report.blobs} blobs, ${report.refs.length} refs; gitleaks ${report.gitleaks.version}`);
} catch (error) {
  console.error(error instanceof BoundaryError ? error.message : 'Boundary scan failed; values redacted'); process.exitCode = 1;
}
