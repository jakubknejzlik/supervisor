import { exercise } from './exercise.mjs';
const base = new URL(process.argv[2] ?? process.env.SAMPLE_ACCOUNT_URL ?? (() => { throw new Error('Set SAMPLE_ACCOUNT_URL explicitly'); })());
if (base.protocol !== 'https:' || base.username || base.password) throw new Error('An explicit HTTPS sample-account endpoint is required');
if (!process.env.SUPERVISOR_ACCESS_TOKEN) throw new Error('Set SUPERVISOR_ACCESS_TOKEN to the interactively obtained opaque Access OAuth token');
await exercise(base, { Authorization: `Bearer ${process.env.SUPERVISOR_ACCESS_TOKEN}` }, 'remote-authorized');
