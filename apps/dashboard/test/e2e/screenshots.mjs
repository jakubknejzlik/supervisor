// Local-only visual proof. No production credentials, data, or infrastructure.
// node apps/dashboard/test/e2e/screenshots.mjs [--source /absolute/worktree] [--output /absolute/shots] [--before]
// Install root dependencies in the selected source worktree before running.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture } from '../../../worker/test/fixture.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const source = resolve(option('--source', fileURLToPath(new URL('../../../../', import.meta.url))));
const output = resolve(option('--output', join(source, '.local/screenshots')));
const before = args.includes('--before');
execFileSync('bun', ['run', 'build:assets'], { cwd: source, stdio: 'inherit' });
const { runtime } = await import(pathToFileURL(join(source, 'apps/worker/test/runtime.mjs')));
const keys = await fixture(), assertion = await keys.token();
const mf = await runtime(keys.jwks, {});
const client = new Client({ name: 'local-screenshot-fixture', version: '1' });
let browser;
try {
  const base = String(await mf.ready);
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { 'Cf-Access-Jwt-Assertion': assertion } } }));
  const id = 'sample:modal-proof';
  const names = ['Přímý odkaz na úkol a přehledný detail', 'Přehled návazností a pracovních vláken', 'Mobilní přehled otevřených úkolů', 'Podklady pro další uživatelské ověření', 'Kontrola odkazů a zdrojových důkazů', 'Předání výsledků k závěrečnému review', 'Obnova připojení k živému přehledu', 'Sjednocení stavových štítků'];
  const links = {
    slack: [{ label: 'Pracovní vlákno k úpravě přehledu', url: 'https://example.com/slack/modal' }],
    changes: [{ label: 'PR #42 — detail úkolu', url: 'https://example.com/pull/42' }],
    preview: [{ label: 'Lokální ukázka rozhraní', url: 'https://example.com/preview/modal', revisionVerified: false }],
    issues: [{ label: 'Zadání úpravy', url: 'https://example.com/issues/42' }],
    other: [{ label: 'Doplňující podklady a poznámky k ověření delších odkazů na malém displeji', url: 'https://example.com/evidence/mobile-layout' }],
  };
  for (const [i, name] of names.entries()) {
    const result = await client.callTool({ name: 'upsert_record', arguments: { id: i ? `sample:proof-${i}` : id, expectedRev: 0, patch: {
      name, agent: ['Agent A', 'Agent B', 'Agent C'][i % 3], project: ['sample-a', 'sample-b', 'sample-c'][i % 3],
      kind: 'Úkol', owner: 'Agent A', state: i ? 'running' : 'review', stateLabel: i ? 'Rozpracováno' : 'K review',
      priority: i ? 'medium' : 'high', waitingOn: i ? 'Agent A' : 'Viewer',
      status: 'Detail se otevírá v samostatném modalu. Přímé odkazy, živé aktualizace i zachování filtrů jsou připravené k ověření. Vizuální kontrola zahrnuje desktop i mobilní zobrazení.',
      nextStep: 'Projít hotovou úpravu na desktopu a telefonu, ověřit čitelnost detailu a předat připomínky ve pracovním vlákně.',
      goal: 'Přehled má umožnit rychlé nalezení úkolu a pohodlné čtení jeho kontextu. Název slouží jako hlavní vstup do detailu; menší ikona vedle řádku zkopíruje přímý odkaz. Po otevření jsou nejdříve vidět další krok a odpovědnost, poté poslední výsledek a zdrojové podklady. Delší text se zalamuje v přirozené délce řádku, aby se dal číst i na telefonu. Při živé aktualizaci zůstávají filtry, otevřený detail a pozice čtení zachované. Odkazy na pracovní vlákno, změnu a testovací prostředí jsou vedené odděleně. Dostupnost ukázky sama nepotvrzuje ověření konkrétní revize.',
      sourceAt: '2026-11-23T12:00:00Z', links,
    } } });
    if (result.isError) throw new Error(JSON.stringify(result));
  }
  browser = await chromium.launch();
  for (const [device, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } })) {
    const directory = join(output, device); mkdirSync(directory, { recursive: true });
    const context = await browser.newContext({ viewport, isMobile: device === 'mobile', hasTouch: device === 'mobile', deviceScaleFactor: 1, permissions: ['clipboard-read', 'clipboard-write'], extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': assertion } });
    try {
      const page = await context.newPage();
      const shot = async name => { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' }); };
      await page.goto(base); await page.locator('#connection-status').getByText('live', { exact: true }).waitFor();
      if (device === 'mobile') await page.locator('.agent-tabs').evaluate(node => node.scrollIntoView({ block: 'start' }));
      await shot('01-list');
      const row = page.locator(`[data-record-id="${id}"]`);
      await row.locator(before ? '.open-record-button' : '.record-title-button').click();
      await page.getByRole('dialog').waitFor(); await shot('02-modal-from-row');
      if (before) continue;
      await page.getByRole('dialog').getByRole('button', { name: 'Kopírovat odkaz', exact: true }).click();
      await page.locator('#modal-link-status').getByText('Odkaz zkopírován', { exact: true }).waitFor();
      await shot('03-modal-copied');
      // A genuinely fresh page exercises the URL entry path.
      await page.close();
      const fresh = await context.newPage();
      await fresh.goto(`${base}?record=${encodeURIComponent(id)}`); await fresh.getByRole('dialog').waitFor();
      await fresh.screenshot({ path: join(directory, '04-direct-link.png') });
      if (device === 'mobile') {
        await fresh.locator('.record-modal-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await fresh.screenshot({ path: join(directory, '06-modal-bottom.png') });
      }
      await fresh.goto(`${base}?record=sample%3Aunknown-proof`); await fresh.getByRole('heading', { name: 'Úkol nenalezen', exact: true }).waitFor();
      await fresh.screenshot({ path: join(directory, '05-unknown-id.png') });
    } finally { await context.close(); }
  }
  console.log(`Screenshots saved to ${output} (${before ? 'base list + modal' : 'current full set'})`);
} finally { await browser?.close(); await client.close(); await mf.dispose(); }
