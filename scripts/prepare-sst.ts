import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import patches from './sst-compatibility.json';

export function applyCompatibilityPatch(source: string, patch: typeof patches[number]) {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  if (hash(source) === patch.after) return source;
  if (hash(source) !== patch.before || source.split(patch.old).length !== 2) throw new Error(`Unreviewed SST SDK source: ${patch.file}`);
  const next = source.replace(patch.old, patch.replacement);
  if (hash(next) !== patch.after) throw new Error('SST compatibility patch checksum mismatch');
  return next;
}
export function prepareSst() {
  if (!existsSync('.sst/platform/config.d.ts')) {
    const result = spawnSync('bunx', ['--no-install', 'sst', 'install'], { stdio: 'inherit', env: { ...process.env, SUPERVISOR_SDK_INSTALL: '1' } });
    if (result.status !== 0) throw new Error('Local SST SDK installation failed');
  }
  const platform = JSON.parse(readFileSync('.sst/platform/package.json', 'utf8'));
  if (platform.dependencies['@pulumi/cloudflare'] !== '6.24.0') throw new Error('Unexpected SST platform provider pin');
  for (const patch of patches) {
    const file = `.sst/platform/${patch.file}`;
    const source = readFileSync(file, 'utf8');
    const next = applyCompatibilityPatch(source, patch);
    if (next === source) continue;
    writeFileSync(file, next);
  }
  console.log('SST 4.17.1 / Cloudflare 6.24.0: verified local compatibility patches');
}
