import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fixture, issuer } from '../../../worker/test/fixture.mjs';
import { runtime } from '../../../worker/test/runtime.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
let mf, base, token, client;
test.beforeAll(async () => {
  const keys = await fixture(); token = await keys.token();
  mf = await runtime(keys.jwks, { extraBindings: { DISPLAY_TIMEZONE: 'Europe/Prague' } }); base = String(await mf.ready);
  client = new Client({ name: 'locale-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { 'Cf-Access-Jwt-Assertion': token } } }));
  await client.callTool({ name: 'upsert_record', arguments: { id: 'locale:record', expectedRev: 0, patch: {
    name: 'Původní název / Original name', status: 'Původní důkaz / Original evidence', state: 'review', agent: 'all',
    requestedFrom: [{ issuer, sub: 'test-subject' }], links: { preview: [{ label: 'Původní odkaz', url: 'https://example.com/test' }] },
  } } });
});
test.afterAll(async () => { await client?.close(); await mf?.dispose(); });
async function contextFor(browser, header = 'en;q=1,cs;q=0.3', languages = ['en-US']) {
  const context = await browser.newContext({ ...test.info().project.use, extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': token, 'Accept-Language': header } });
  await context.route('**/*', route => route.continue({ headers: { ...route.request().headers(), 'accept-language': header } }));
  await context.addInitScript(languages => Object.defineProperty(navigator, 'languages', { value: languages }), languages);
  return context;
}
const labels = {
  en: { search: 'Search dashboard', close: 'Close details', copy: 'Copy link', next: 'Next step', waiting: 'Waiting on you', state: 'Review', live: 'Live', language: 'Interface language' },
  cs: { search: 'Hledat v přehledu', close: 'Zavřít detail', copy: 'Kopírovat odkaz', next: 'Další krok', waiting: 'Čeká na tebe', state: 'Ke kontrole', live: 'Živě', language: 'Jazyk rozhraní' },
};
for (const locale of ['en', 'cs']) test(`${locale}: reload and WS refresh preserve locale, generated labels and viewer projection`, async ({ browser }) => {
  const context = await contextFor(browser, locale === 'cs' ? 'en;q=1,cs;q=0.1' : 'cs;q=1,en;q=0.1', [locale === 'cs' ? 'en' : 'cs']);
  try {
    const page = await context.newPage();
    await page.goto(base);
    let navigations = 0; page.on('request', req => { if (req.resourceType() === 'document') navigations++; });
    await page.evaluate(() => { window.__sameDocument = true; });
    await page.locator(`[data-locale="${locale}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    expect(await page.evaluate(() => window.__sameDocument)).toBe(true); expect(navigations).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('supervisor.locale'))).toBe(locale);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator(`[data-locale="${locale}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('group', { name: labels[locale].language })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: labels[locale].search })).toBeVisible();
    await page.getByLabel(labels[locale].waiting, { exact: true }).check();
    const row = page.locator('[data-record-id="locale:record"]');
    await expect(row).toHaveClass(/needs-you/);
    await expect(row.getByRole('button', { name: labels[locale].copy + ': Původní název / Original name' })).toBeVisible();
    await expect(row.locator('.state-review')).toHaveText(labels[locale].state);
    await expect(page.locator('#published')).toContainText('Europe/Prague');
    await row.getByRole('button', { name: 'Původní název / Original name', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: labels[locale].close })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: labels[locale].next, exact: true })).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Původní odkaz' }).first()).toBeVisible();
    await expect(page.locator('#connection-status')).toHaveText(labels[locale].live);
    const current = JSON.parse((await client.callTool({ name: 'get_record', arguments: { id: 'locale:record' } })).content[0].text);
    const status = `Original WS evidence ${locale} ${test.info().project.name}`;
    await client.callTool({ name: 'upsert_record', arguments: { id: current.id, expectedRev: current.rev, patch: { status } } });
    await expect(dialog).toContainText(status);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('#waiting-you')).toBeChecked();
    await expect(dialog.getByRole('heading', { name: labels[locale].next, exact: true })).toBeVisible();
    expect(navigations).toBe(1);
    const opposite = locale === 'cs' ? 'en' : 'cs';
    // Verify even an already-open dialog rerenders its labels on language change.
    await page.locator(`[data-locale="${opposite}"]`).dispatchEvent('click');
    await expect(dialog.getByRole('button', { name: labels[opposite].close })).toBeVisible();
    await expect(dialog).toContainText(status);
    await dialog.getByRole('button', { name: labels[opposite].close }).click();
    await expect(row).toHaveClass(/needs-you/);
    await page.locator(`[data-locale="${locale}"]`).click();
    expect(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await page.locator(`[data-locale="${locale}"]`).boundingBox();
    expect(bounds.width).toBeGreaterThanOrEqual(44); expect(bounds.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: test.info().outputPath(`locale-${locale}.png`), fullPage: true });
  } finally { await context.close(); }
});

test('missing/corrupt/valid storage wins over weighted server preferences, then navigator', async ({ browser }) => {
  for (const [saved, header, languages, expected] of [
    [null, 'en;q=0.2,cs-CZ;q=0.9', ['en'], 'cs'],
    ['broken', 'cs;q=0.1,en-US;q=0.8', ['cs'], 'en'],
    ['cs', 'en;q=1,cs;q=0.1', ['en'], 'cs'],
    ['en', 'cs;q=1,en;q=0.1', ['cs'], 'en'],
    ['"cs"', 'de,private-canary', ['cs'], 'en'],
  ]) {
    const context = await contextFor(browser, header, languages);
    try {
      if (saved !== null) await context.addInitScript(saved => localStorage.setItem('supervisor.locale', saved), saved);
      const page = await context.newPage(); const response = await page.goto(base);
      await expect(page.locator('html')).toHaveAttribute('lang', expected);
      expect(await response.text()).not.toContain('private-canary');
      expect(await response.text()).not.toContain(header);
    } finally { await context.close(); }
  }
});

test('blocked storage getter and failed writes keep choice in memory through WS updates', async ({ browser }) => {
  for (const mode of ['getter', 'write']) {
    const context = await contextFor(browser);
    try {
      await context.addInitScript(mode => {
        if (mode === 'getter') Object.defineProperty(window, 'localStorage', { get() { throw new Error('Blocked'); } });
        else Storage.prototype.setItem = () => { throw new Error('Quota'); };
      }, mode);
      const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(base); await page.locator('[data-locale="cs"]').click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
      await expect(page.locator('#connection-status')).toHaveText('Živě');
      await page.getByRole('button', { name: 'Původní název / Original name', exact: true }).click();
      const current = JSON.parse((await client.callTool({ name: 'get_record', arguments: { id: 'locale:record' } })).content[0].text);
      const status = `In-memory evidence ${mode}`;
      await client.callTool({ name: 'upsert_record', arguments: { id: current.id, expectedRev: current.rev, patch: { status } } });
      await expect(page.getByRole('dialog')).toContainText(status);
      await expect(page.locator('html')).toHaveAttribute('lang', 'cs'); expect(errors).toEqual([]);
      await page.reload(); await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    } finally { await context.close(); }
  }
});

test('static fallback negotiates navigator.languages and errors remain switchable', async ({ browser }) => {
  const context = await contextFor(browser, 'en', ['de', 'cs-CZ', 'en']);
  try {
    const page = await context.newPage();
    const html = readFileSync(new URL('../../dist/index.html', import.meta.url), 'utf8').replace(/<meta name="supervisor-ws-url"[^>]+>/, '');
    await page.route('http://locale.test/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (path === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL('../../dist/app.js', import.meta.url), 'utf8') });
      return route.fulfill({ status: 503, body: '' });
    });
    await page.goto('http://locale.test/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'cs');
    await expect(page.locator('#result-count')).toHaveText('Data přehledu se nepodařilo načíst. Obnovte stránku.');
    await page.locator('[data-locale="en"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#result-count')).toHaveText('Dashboard data could not be loaded. Refresh the page.');
    await expect(page.getByRole('searchbox', { name: 'Search dashboard' })).toBeVisible();
  } finally { await context.close(); }
});

async function keyboardChoose(page, selector, key = 'Enter') {
  // Reach the control using the actual tab sequence, including focus visibility.
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    if (await page.locator(selector).evaluate(node => node === document.activeElement)) {
      expect(await page.locator(selector).evaluate(node => node.matches(':focus-visible'))).toBe(true);
      await page.keyboard.press(key);
      return;
    }
  }
  throw new Error('Control was unreachable by keyboard');
}

test('keyboard theme and locale choices persist; System follows live changes at 360px', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, colorScheme: 'light', extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': token, 'Accept-Language': 'en' } });
  try {
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    const root = page.locator('html');
    await expect(root).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('[data-theme-choice="system"]')).toHaveAttribute('aria-pressed', 'true');
    await keyboardChoose(page, '[data-locale="cs"]', 'Space');
    await expect(root).toHaveAttribute('lang', 'cs');
    await expect(page.getByRole('group', { name: 'Barevný režim' })).toBeVisible();
    await expect(page.locator('.theme-control button')).toHaveText(['Světlý', 'Tmavý', 'Systém']);
    await keyboardChoose(page, '[data-theme-choice="dark"]');
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('[data-theme-choice="dark"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('supervisor.theme'))).toBe('dark');
    await page.reload();
    await expect(root).toHaveAttribute('lang', 'cs');
    await expect(root).toHaveAttribute('data-theme', 'dark');
    expect(await root.evaluate(node => getComputedStyle(node).colorScheme)).toBe('dark');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await keyboardChoose(page, '[data-theme-choice="system"]', 'Space');
    await expect(root).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('[data-theme-choice="system"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(root).toHaveAttribute('data-theme', 'light');
    for (const locale of ['cs', 'en']) {
      await page.locator(`[data-locale="${locale}"]`).click();
      for (const theme of ['light', 'dark', 'system']) {
        await page.locator(`[data-theme-choice="${theme}"]`).click();
        expect(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth)).toBe(true);
        const bar = await page.locator('.top-bar').boundingBox();
        for (const button of await page.locator('.preferences button').all()) {
          const box = await button.boundingBox();
          expect(box.x + box.width).toBeLessThanOrEqual(360);
          expect(box.y).toBeGreaterThanOrEqual(bar.y);
          expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height);
        }
      }
    }
    await expect(page.getByRole('group', { name: 'Color theme' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('blocked theme storage stays usable in memory', async ({ browser }) => {
  for (const mode of ['getter', 'write', 'corrupt']) {
    const context = await browser.newContext({ colorScheme: 'light', extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': token } });
    try {
      await context.addInitScript(mode => {
        if (mode === 'getter') Object.defineProperty(window, 'localStorage', { get() { throw new Error('Blocked'); } });
        else if (mode === 'write') Storage.prototype.setItem = () => { throw new Error('Quota'); };
        else localStorage.setItem('supervisor.theme', 'invalid');
      }, mode);
      const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await page.locator('[data-theme-choice="dark"]').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.emulateMedia({ colorScheme: 'light' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }
});
