import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { fixture, issuer } from '../../../worker/test/fixture.mjs';
import { runtime } from '../../../worker/test/runtime.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
function staticHtml() {
  return readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
    .replace(/  <meta name="supervisor-(?:data|ws)-url"[^>]+>\n/g, '')
    .replace('  <script src="./app.js"', '  <script src="./data.js" defer></script>\n  <script src="./app.js"');
}
let mf, base, keys, assertion, client;
test.beforeAll(async () => {
  keys = await fixture(); assertion = await keys.token();
  mf = await runtime(keys.jwks, {}); base = await mf.ready;
  client = new Client({ name: 'playwright-seed', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { 'Cf-Access-Jwt-Assertion': assertion } } }));
  for (let i = 0; i < 35; i++) await client.callTool({ name: 'upsert_record', arguments: { id: `sample:browser-${i}`, expectedRev: 0, patch: { name: `Browser ${String(i).padStart(2, '0')}`, status: 'Before update', agent: 'Agent A', state: 'running', stateLabel: 'Rozpracováno' } } });
});
test.afterAll(async () => { await client?.close(); await mf?.dispose(); });
test('two pages: MCP write pushes without reload, preserving filters, open modal and scroll', async ({ browser }) => {
  const project = test.info().project.use;
  const authContext = await browser.newContext({ ...project, extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': assertion } });
  try {
    const pageA = await authContext.newPage(), pageB = await authContext.newPage();
    const errors = []; pageB.on('pageerror', e => errors.push(e.message));
    let navigations = 0; pageB.on('request', request => { if (request.resourceType() === 'document') navigations++; });
    await Promise.all([pageA.goto(String(base)), pageB.goto(String(base))]);
    await expect(pageB.locator('#connection-status')).toHaveText(/^(Live|Živě)$/);
    await pageB.locator('#search').fill('Browser');
    await pageB.locator('#state').selectOption('running');
    await pageB.locator('#sort').selectOption('name');
    const target = pageB.locator('[data-record-id="sample:browser-0"]');
    await target.getByRole('button', { name: 'Browser 00', exact: true }).click();
    const dialog = pageB.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(pageB.locator('#rows .detail-row, #rows tr:not(.summary-row)')).toHaveCount(0);
    await pageB.evaluate(() => { window.__noReload = 'same-document'; window.scrollTo(0, 600); });
    const before = await pageB.evaluate(() => ({ scroll: scrollY, query: location.search }));
    expect(before.scroll).toBeGreaterThan(200);
    const response = await pageA.evaluate(async () => {
      // MCP JSON-RPC over Streamable HTTP, issued by context A. Auth headers are
      // test-only assertions, installed by Playwright at the network boundary.
      return fetch('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'upsert_record', arguments: { id: 'sample:browser-0', expectedRev: 1, patch: { status: 'Pushed by MCP context A' } } } }) }).then(r => r.json());
    });
    expect(response.result.isError).not.toBe(true);
    await expect(dialog).toContainText('Pushed by MCP context A', { timeout: 5000 });
    expect(await pageB.locator('#search').inputValue()).toBe('Browser');
    expect(await pageB.locator('#state').inputValue()).toBe('running');
    expect(await pageB.locator('#sort').inputValue()).toBe('name');
    await expect(dialog).toBeVisible();
    expect(await pageB.evaluate(() => window.__noReload)).toBe('same-document');
    expect(await pageB.evaluate(() => location.search)).toBe(before.query);
    expect(Math.abs(await pageB.evaluate(() => scrollY) - before.scroll)).toBeLessThanOrEqual(2);
    expect(navigations).toBe(1); expect(errors).toEqual([]);
    await pageB.screenshot({ path: test.info().outputPath("dashboard.png"), fullPage: false });
  } finally { await authContext.close(); }
});
test('static build renders and polls without attempting a websocket', async ({ page }) => {
  const html = staticHtml();
  const app = readFileSync(new URL('../../dist/app.js', import.meta.url), 'utf8');
  const row = { id: 'static:1', recordId: '1', name: 'Static row', project: 'sample-a', agent: 'Agent A', kind: 'Úkol', state: 'running', stateLabel: 'Rozpracováno', status: 'Static status', links: { slack: [], changes: [], preview: [], issues: [], other: [] } };
  const doc = { schemaVersion: 1, records: [row], generatedAt: '2026-11-23T00:00:00Z' };
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/style.css') { response.setHeader('Content-Type', 'text/css'); response.end(readFileSync(new URL('../../src/style.css', import.meta.url))); }
    else if (path === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(app); }
    else if (path === '/data.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(`window.SUPERVISOR_DATA=${JSON.stringify(doc)}`); }
    else if (path === '/data.json') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ...doc, generatedAt: new Date().toISOString(), records: [{ ...row, status: 'Polled static update' }] })); }
    else if (path === '/') response.end(html);
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let connections = 0; page.on('websocket', () => connections++);
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.locator('[data-record-id="static:1"]')).toContainText('Static row');
    await page.getByRole('button', { name: 'Static row', exact: true }).click();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByRole('dialog')).toContainText('Polled static update');
    expect(connections).toBe(0); await expect(page.locator('#connection-status')).toHaveCount(0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

async function filterFixture(page, records) {
  const doc = { schemaVersion: 1, generatedAt: '2026-11-23T00:00:00Z', records };
  await page.route('http://filters.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: staticHtml() });
    if (path === '/data.js') return route.fulfill({ contentType: 'text/javascript', body: `window.SUPERVISOR_DATA=${JSON.stringify(doc)}` });
    if (path === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL('../../dist/app.js', import.meta.url), 'utf8') });
    return route.fulfill({ body: '' });
  });
  await page.goto('http://filters.test/');
}

test('literal agent all has distinct tab labels, counts, filtering and exact URL round-trip', async ({ page }) => {
  const row = { kind: 'Task', state: 'running', stateLabel: 'Running', links: {} };
  await filterFixture(page, [
    { ...row, id: 'filter:literal-agent', name: 'Literal agent', agent: 'all' },
    { ...row, id: 'filter:other-agent', name: 'Other agent', agent: 'Agent Z' },
  ]);
  const tabs = page.locator('.agent-tabs button');
  await expect(tabs).toHaveText(['All 2', 'Agent Z 1', 'all 1']);
  await expect(page.locator('#rows .summary-row')).toHaveCount(2);
  const literal = page.locator('[data-agent="all"]');
  await literal.click();
  await expect(literal).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.agent-tabs [aria-pressed="true"]')).toHaveCount(1);
  await expect(page.locator('#rows .summary-row')).toHaveCount(1);
  await expect(page.locator('#rows [data-record-id="filter:literal-agent"]')).toBeVisible();
  await expect(page).toHaveURL('http://filters.test/?agent=all');
  await page.reload();
  await expect(literal).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#rows .summary-row')).toHaveCount(1);
  await expect(page.locator('#rows [data-record-id="filter:literal-agent"]')).toBeVisible();
  await expect(page).toHaveURL('http://filters.test/?agent=all');
  await tabs.first().click();
  await expect(page.locator('#rows .summary-row')).toHaveCount(2);
  await expect(page).toHaveURL('http://filters.test/');
  await literal.click();
  await page.locator('#reset').click();
  await expect(tabs.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#rows .summary-row')).toHaveCount(2);
  await expect(page).toHaveURL('http://filters.test/');
});

test('literal state all has its own option, filtering and exact URL round-trip', async ({ page }) => {
  const row = { kind: 'Task', agent: 'Agent Z', links: {} };
  await filterFixture(page, [
    { ...row, id: 'filter:literal-state', name: 'Literal state', state: 'all', stateLabel: 'all' },
    { ...row, id: 'filter:other-state', name: 'Other state', state: 'running', stateLabel: 'Running' },
  ]);
  const state = page.locator('#state');
  await expect(state.locator('option')).toHaveText(['All states', 'all', 'Running']);
  await expect(state.locator('option[value="all"]')).toHaveCount(1);
  await expect(page.locator('#rows .summary-row')).toHaveCount(2);
  await state.selectOption('all');
  await expect(page.locator('#rows .summary-row')).toHaveCount(1);
  await expect(page.locator('#rows [data-record-id="filter:literal-state"]')).toBeVisible();
  await expect(page).toHaveURL('http://filters.test/?state=all');
  await page.reload();
  await expect(state).toHaveValue('all');
  await expect(page.locator('#rows .summary-row')).toHaveCount(1);
  await expect(page.locator('#rows [data-record-id="filter:literal-state"]')).toBeVisible();
  await expect(page).toHaveURL('http://filters.test/?state=all');
  await state.selectOption({ index: 0 });
  await expect(page.locator('#rows .summary-row')).toHaveCount(2);
  await expect(page).toHaveURL('http://filters.test/');
  await state.selectOption('all');
  await page.locator('#reset').click();
  expect(await state.evaluate(select => select.selectedIndex)).toBe(0);
  await expect(page.locator('#rows .summary-row')).toHaveCount(2);
  await expect(page).toHaveURL('http://filters.test/');
});

async function withDashboard(browser, run, options = {}) {
  const context = await browser.newContext({ ...test.info().project.use, extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': assertion }, ...options });
  try { const page = await context.newPage(); await page.addInitScript(() => localStorage.setItem('supervisor.locale', 'cs')); await run(page, context); } finally { await context.close(); }
}
const directUrl = id => `${new URL(base).origin}/?record=${encodeURIComponent(id)}`;
const taskRow = page => page.locator('[data-record-id="sample:browser-1"]');

test('row and modal copy canonical links; fresh page opens exact record even with filters', async ({ browser }) => {
  await withDashboard(browser, async (page, context) => {
    await page.goto(`${base}?q=Browser&state=running&sort=name`);
    const copy = taskRow(page).getByRole('button', { name: 'Kopírovat odkaz: Browser 01', exact: true });
    await expect(copy).toHaveText('');
    await expect(copy.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    await expect(copy).toHaveAttribute('title', 'Kopírovat odkaz');
    await copy.click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    const expected = directUrl('sample:browser-1');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
    await expect(page.locator('#link-status')).toHaveText('Odkaz zkopírován');
    const fresh = await context.newPage(); await fresh.goto(expected);
    const dialog = fresh.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Browser 01');
    await expect(dialog.locator('#record-modal-id')).toHaveText('sample:browser-1');
    await dialog.getByRole('button', { name: 'Kopírovat odkaz', exact: true }).click();
    await expect.poll(() => fresh.evaluate(() => navigator.clipboard.readText())).toBe(expected);
    await expect(dialog.getByRole('status')).toHaveText('Odkaz zkopírován');
    await expect(dialog.getByRole('status')).toHaveText('', { timeout: 4000 });
    await fresh.goto(`${expected}&q=does-not-match`);
    await expect(fresh.getByRole('dialog')).toContainText('Browser 01');
    expect(new URL(fresh.url()).searchParams.get('record')).toBe('sample:browser-1');
    await fresh.getByRole('button', { name: 'Zavřít detail' }).click();
    expect(new URL(fresh.url()).searchParams.get('q')).toBe('does-not-match');
    expect(new URL(fresh.url()).searchParams.has('record')).toBe(false);
  }, { permissions: ['clipboard-read', 'clipboard-write'] });
});

test('modal fits viewport, scrolls under reachable close button, traps and returns focus', async ({ browser }) => {
  await withDashboard(browser, async page => {
    await page.goto(String(base));
    const trigger = taskRow(page).getByRole('button', { name: 'Browser 01', exact: true });
    await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(page.locator('#rows .detail-row, #rows tr:not(.summary-row)')).toHaveCount(0);
    await expect(taskRow(page).getByRole('button')).toHaveCount(2);
    const historyLength = await page.evaluate(() => history.length);
    await trigger.click();
    const dialog = page.getByRole('dialog'), close = dialog.getByRole('button', { name: 'Zavřít detail' });
    await expect(dialog).toBeVisible();
    await expect(close).toHaveAccessibleName('Zavřít detail');
    await expect(close).toHaveAttribute('title', 'Zavřít');
    await expect(close).toHaveText('×');
    await expect(close.locator('span')).toHaveAttribute('aria-hidden', 'true');
    expect(new URL(page.url()).searchParams.get('record')).toBe('sample:browser-1');
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    const bounds = await dialog.boundingBox(), viewport = page.viewportSize();
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    await dialog.locator('.record-modal-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(close).toBeInViewport();
    const closeBounds = await close.boundingBox();
    expect(closeBounds.width).toBeGreaterThanOrEqual(40); expect(closeBounds.height).toBeGreaterThanOrEqual(40);
    expect(closeBounds.x + closeBounds.width).toBeLessThanOrEqual(viewport.width);
    expect(closeBounds.y + closeBounds.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("record-modal.png") });
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement.closest('dialog'))).toBe(true);
    }
    await close.click();
    await expect(dialog).not.toBeVisible();
    expect(new URL(page.url()).searchParams.has('record')).toBe(false);
    await expect(trigger).toBeFocused();
    await trigger.click(); await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible(); await expect(trigger).toBeFocused();
    expect(new URL(page.url()).searchParams.has('record')).toBe(false);
    await trigger.press('Enter'); await expect(dialog).toBeVisible();
    await close.click(); await expect(trigger).toBeFocused();
    await taskRow(page).locator('.status-cell').click();
    await expect(dialog).toBeVisible(); await close.click();
    await expect(trigger).toBeFocused();
    if (test.info().project.name === 'desktop') {
      await trigger.click(); await page.mouse.click(1, 1);
      await expect(dialog).not.toBeVisible();
      expect(new URL(page.url()).searchParams.has('record')).toBe(false);
    }
  });
});

test('mobile sheet and rows fit 375px with reachable touch controls', async ({ browser }) => {
  test.skip(test.info().project.name !== 'mobile', 'Mobile sheet only');
  const id = 'sample:mobile-' + 'long-id-'.repeat(18);
  const name = 'Mobilní úkol s dlouhým názvem pro ověření zalamování na malém displeji';
  const result = await client.callTool({ name: 'upsert_record', arguments: { id, expectedRev: 0, patch: {
    name, goal: 'Delší kontext pro skutečné posouvání obsahu. '.repeat(100),
    links: { slack: [], changes: [], preview: [], issues: [], other: [{ label: 'Dlouhý zdroj '.repeat(10), url: 'https://example.com/evidence' }] },
  } } });
  expect(result.isError).not.toBe(true);
  await withDashboard(browser, async page => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${base}?q=Mobilní`);
    expect(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth)).toBe(true);
    const row = page.locator(`[data-record-id="${id}"]`), copy = row.getByRole('button', { name: 'Kopírovat odkaz: ' + name, exact: true });
    await row.scrollIntoViewIfNeeded(); await expect(copy).toBeInViewport();
    const copyBounds = await copy.boundingBox();
    expect(copyBounds.width).toBeGreaterThanOrEqual(44); expect(copyBounds.height).toBeGreaterThanOrEqual(44);
    const title = row.getByRole('button', { name, exact: true });
    expect(await title.evaluate(node => node.scrollHeight <= node.clientHeight)).toBe(true);
    await title.click();
    const dialog = page.getByRole('dialog'), close = dialog.getByRole('button', { name: 'Zavřít detail' });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox(); expect(bounds.width).toBe(375); expect(bounds.height).toBe(812);
    const content = dialog.locator('.record-modal-content');
    expect(await content.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(close).toBeInViewport();
    expect(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await close.click(); await expect(dialog).not.toBeVisible();
  });
});

test('native share uses the canonical link when available', async ({ browser }) => {
  await withDashboard(browser, async page => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'share', { configurable: true, value: async data => { window.__shared = data; } }));
    await page.goto(directUrl('sample:browser-1'));
    await page.getByRole('dialog').getByRole('button', { name: 'Sdílet', exact: true }).click();
    expect(await page.evaluate(() => window.__shared)).toEqual({ title: 'Browser 01', url: directUrl('sample:browser-1') });
  });
});

test('untrusted missing id is text; matching record arriving via MCP updates open modal', async ({ browser }) => {
  const id = 'sample:<img src=x onerror=alert(1)> & č';
  await withDashboard(browser, async page => {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(directUrl(id));
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Záznam neexistuje v aktuálních datech.');
    await expect(dialog.locator('#record-modal-id')).toHaveText(id);
    await expect(dialog.locator('img, script')).toHaveCount(0);
    await expect(page.locator('#connection-status')).toHaveText(/^(Live|Živě)$/);
    const result = await client.callTool({ name: 'upsert_record', arguments: { id, expectedRev: 0, patch: { name: 'Arrived later' } } });
    expect(result.isError).not.toBe(true);
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Arrived later');
    expect(errors).toEqual([]);
  });
});

test('MCP snapshot updates modal rev and details without losing filters, focus or scroll', async ({ browser }) => {
  await withDashboard(browser, async page => {
    const seed = JSON.parse((await client.callTool({ name: 'get_record', arguments: { id: 'sample:browser-1' } })).content[0].text);
    await client.callTool({ name: 'upsert_record', arguments: { id: seed.id, expectedRev: seed.rev, patch: {
      goal: 'Long context for scrolling. '.repeat(160),
      links: { slack: [], changes: [], preview: [], issues: [], other: [
        { label: 'Unsafe source', url: 'javascript:alert(1)' }, { label: 'Evidence', url: 'https://example.com/evidence' },
      ] },
    } } });
    await page.goto(`${base}?q=Browser&state=running&sort=name`);
    await expect(page.locator('#connection-status')).toHaveText(/^(Live|Živě)$/);
    const row = taskRow(page);
    await row.getByRole('button', { name: 'Browser 01', exact: true }).click();
    const dialog = page.getByRole('dialog'), close = dialog.getByRole('button', { name: 'Zavřít detail' });
    await close.focus(); await page.evaluate(() => { window.__noReload = true; });
    await dialog.locator('.record-modal-content').evaluate(node => { node.scrollTop = 60; });
    const before = await page.evaluate(() => ({ query: location.search, scroll: scrollY, modalScroll: document.querySelector('.record-modal-content').scrollTop }));
    expect(before.modalScroll).toBeGreaterThan(0);
    await expect(dialog.getByRole('link', { name: 'Unsafe source' })).toHaveCount(0);
    await expect(dialog.getByRole('link', { name: 'Evidence' })).toHaveAttribute('rel', 'noopener noreferrer');
    const current = JSON.parse((await client.callTool({ name: 'get_record', arguments: { id: 'sample:browser-1' } })).content[0].text);
    const result = await client.callTool({ name: 'upsert_record', arguments: { id: current.id, expectedRev: current.rev, patch: { status: 'Updated inside modal', nextStep: 'Next live action' } } });
    expect(result.isError).not.toBe(true);
    await expect(dialog).toContainText('Updated inside modal'); await expect(dialog).toContainText('Next live action');
    await expect(dialog.locator('[data-field="rev"]')).toHaveText(String(current.rev + 1));
    await expect(close).toBeFocused();
    expect(await page.evaluate(() => window.__noReload)).toBe(true);
    expect(await page.evaluate(() => location.search)).toBe(before.query);
    expect(await page.evaluate(() => scrollY)).toBe(before.scroll);
    expect(await dialog.locator('.record-modal-content').evaluate(node => node.scrollTop)).toBe(before.modalScroll);
    await close.click();
    await expect(page.locator('#rows .detail-row, #rows tr:not(.summary-row)')).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Browser 01', exact: true })).toBeFocused();
    expect(new URL(page.url()).searchParams.get('q')).toBe('Browser');
  });
});

test('unavailable and denied clipboard exposes selectable link in row and modal', async ({ browser }) => {
  await withDashboard(browser, async page => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    await page.goto(String(base));
    const row = taskRow(page);
    await row.getByRole('button', { name: 'Kopírovat odkaz: Browser 01', exact: true }).click();
    const fallback = row.getByLabel('Odkaz ke zkopírování');
    await expect(fallback).toBeVisible(); await expect(fallback).toBeFocused();
    await expect(fallback).toHaveValue(directUrl('sample:browser-1'));
    expect(await fallback.evaluate(node => node.selectionEnd - node.selectionStart)).toBe(directUrl('sample:browser-1').length);
    await row.getByRole('button', { name: 'Browser 01', exact: true }).click();
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } }));
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Kopírovat odkaz', exact: true }).click();
    await expect(dialog.getByLabel('Odkaz ke zkopírování')).toBeFocused();
    await expect(dialog.getByLabel('Odkaz ke zkopírování')).toHaveValue(directUrl('sample:browser-1'));
  });
});

test('file demo opens and closes direct detail without errors or network access', async ({ page }) => {
  const directory = test.info().outputPath('file-demo'); mkdirSync(directory, { recursive: true });
  for (const file of ['index.html', 'app.js', 'style.css', 'favicon.svg', 'favicon-review.svg']) {
    writeFileSync(`${directory}/${file}`, file === 'index.html' ? staticHtml() : readFileSync(new URL(`../../${file.endsWith('.svg') ? 'public' : file === 'app.js' ? 'dist' : 'src'}/${file}`, import.meta.url)));
  }
  const record = { id: 'static:file demo', name: 'File demo', agent: 'Agent A', kind: 'Úkol', state: 'running', stateLabel: 'Rozpracováno', links: { slack: [], changes: [], preview: [], issues: [], other: [] } };
  writeFileSync(`${directory}/data.js`, `window.SUPERVISOR_DATA=${JSON.stringify({ schemaVersion: 1, records: [record], generatedAt: '2026-11-23T00:00:00Z' })}`);
  const errors = [], network = []; page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  await page.goto(`${pathToFileURL(`${directory}/index.html`)}?record=${encodeURIComponent(record.id)}`);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible(); await expect(dialog).toContainText('File demo');
  await dialog.getByRole('button', { name: 'Close details' }).click();
  await expect(dialog).not.toBeVisible();
  await page.locator('.record-title-button').click(); await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect(errors).toEqual([]); expect(network).toEqual([]);
});

test('attention UI consumes only the server projection', async ({ page }) => {
  const directory = test.info().outputPath('attention'); mkdirSync(directory, { recursive: true });
  for (const file of ['index.html', 'app.js', 'style.css', 'favicon.svg', 'favicon-review.svg']) {
    writeFileSync(`${directory}/${file}`, file === 'index.html' ? staticHtml() : readFileSync(new URL(`../../${file.endsWith('.svg') ? 'public' : file === 'app.js' ? 'dist' : 'src'}/${file}`, import.meta.url)));
  }
  const base = { agent: 'Agent A', kind: 'Task', state: 'decision', stateLabel: 'Decision', links: {} };
  const records = [
    { ...base, id: 'attention:yes', name: 'Requested', waitingOnYou: true, nextAction: { label: 'Review', links: {} } },
    { ...base, id: 'attention:no', name: 'Other', waitingOnYou: false, waitingOn: 'Viewer', nextAction: { isViewer: true, label: 'Legacy text', links: {} } },
    { ...base, id: 'attention:missing', name: 'Missing', waitingOn: 'Viewer' },
  ];
  writeFileSync(`${directory}/data.js`, `window.SUPERVISOR_DATA=${JSON.stringify({ schemaVersion: 1, records, generatedAt: '2026-11-23T00:00:00Z' })}`);
  await page.goto(String(pathToFileURL(`${directory}/index.html`)));
  await expect(page.locator('[data-record-id="attention:yes"]')).toHaveClass(/needs-you/);
  await expect(page.locator('.attention-tag')).toHaveCount(1);
  await expect(page.locator('.badge.waiting-you')).toHaveCount(1);
  await expect(page).toHaveTitle('(1) Supervisor Dashboard');
  await page.locator('#waiting-you').check();
  await expect(page.locator('#rows .summary-row')).toHaveCount(1);
  await expect(page.locator('[data-record-id="attention:yes"]')).toBeVisible();
});
test('partial MCP links (production Agent C shapes) render in every agent tab and modal without errors', async ({ browser }) => {
  const shapes = {
    'sample-c:partial-two-slots': { slack: [{ label: 'Slack', url: 'https://slack.example.invalid/a' }], changes: [{ label: 'PR 18', url: 'https://github.com/o/r/pull/18' }] },
    'sample-c:partial-empty': { slack: [], changes: [] },
    'sample-c:partial-one-slot': { slack: [] },
    'sample-c:partial-four-slots': { slack: [], changes: [], preview: [], issues: [] },
  };
  for (const [id, links] of Object.entries(shapes)) await client.callTool({ name: 'upsert_record', arguments: { id, expectedRev: 0, patch: { name: id, agent: 'Agent C', project: 'sample-c', state: 'running', stateLabel: 'Rozpracováno', links } } });
  await client.callTool({ name: 'upsert_record', arguments: { id: 'agent-b:full-links', expectedRev: 0, patch: { name: 'agent-b:full-links', agent: 'Agent B', state: 'running', stateLabel: 'Rozpracováno', links: { slack: [], changes: [], preview: [], issues: [], other: [] } } } });
  const project = test.info().project.use;
  const context = await browser.newContext({ ...project, extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': assertion } });
  try {
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(String(base));
    for (const agent of ['', 'Agent A', 'Agent B', 'Agent C']) {
      await page.locator(`[data-agent="${agent}"]`).click();
      await expect(page.locator(`[data-agent="${agent}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#rows tr.summary-row').first()).toBeVisible();
    }
    await expect(page.locator('#rows tr.summary-row')).toHaveCount(Object.keys(shapes).length);
    for (const id of Object.keys(shapes)) {
      await page.locator(`[data-record-id="${id}"]`).getByRole('button', { name: id, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Next step');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('two authenticated viewers refetch their own attention after WS invalidation', async ({ browser }) => {
  const id = 'identity:live-browser';
  await client.callTool({ name: 'upsert_record', arguments: { id, expectedRev: 0, patch: {
    name: 'Viewer request', agent: 'Initial actor', state: 'review',
    requestedFrom: [{ issuer, sub: 'test-subject' }],
  } } });
  const tokens = [assertion, await keys.token({ sub: 'second-subject', email: 'reader@example.invalid' })];
  const contexts = await Promise.all(tokens.map(token => browser.newContext({ ...test.info().project.use, extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': token } })));
  try {
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    for (const page of pages) {
      await page.addInitScript(() => localStorage.setItem('supervisor.identity', JSON.stringify({ sub: 'test-subject' })));
      await page.goto(`${base}?q=Viewer&sub=test-subject&email=owner%40example.invalid`);
      await expect(page.locator('#connection-status')).toHaveText(/^(Live|Živě)$/);
      await expect(page.locator('[data-agent="Initial actor"]')).toBeVisible();
    }
    const row = page => page.locator(`[data-record-id="${id}"]`);
    await expect(row(pages[0])).toHaveClass(/needs-you/);
    await expect(row(pages[1])).not.toHaveClass(/needs-you/);
    for (const page of pages) await page.locator('#waiting-you').check();
    await expect(row(pages[0])).toBeVisible();
    await expect(row(pages[1])).toHaveCount(0);
    await client.callTool({ name: 'upsert_record', arguments: { id, expectedRev: 1, patch: {
      agent: 'New actor', requestedFrom: [{ issuer, sub: 'second-subject' }],
    } } });
    await expect(row(pages[0])).toHaveCount(0);
    await expect(row(pages[1])).toBeVisible();
    await expect(row(pages[1])).toHaveClass(/needs-you/);
    for (const page of pages) {
      await expect(page.locator('#waiting-you')).toBeChecked();
      await expect(page.locator('#search')).toHaveValue('Viewer');
      await expect(page.locator('[data-agent="New actor"]')).toBeVisible();
      await expect(page.locator('[data-agent="Initial actor"]')).toHaveCount(0);
    }
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
test('empty store displays only the All actor tab', async ({ browser }) => {
  const empty = await runtime(keys.jwks);
  const context = await browser.newContext({ ...test.info().project.use, extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': assertion } });
  try {
    const page = await context.newPage();
    await page.goto(String(await empty.ready));
    await expect(page.locator('[data-agent]')).toHaveCount(1);
    await expect(page.locator('[data-agent=""]')).toBeVisible();
    await expect(page.locator('#empty')).toBeVisible();
    await expect(page).toHaveTitle('Supervisor Dashboard');
  } finally { await context.close(); await empty.dispose(); }
});
