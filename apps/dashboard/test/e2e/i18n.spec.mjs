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
    await page.locator('#locale').selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    expect(await page.evaluate(() => window.__sameDocument)).toBe(true); expect(navigations).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('supervisor.locale'))).toBe(locale);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('#locale')).toHaveValue(locale);
    await expect(page.getByRole('combobox', { name: labels[locale].language })).toBeVisible();
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
    await page.locator('#locale').evaluate((node, value) => { node.value = value; node.dispatchEvent(new Event('change')); }, opposite);
    await expect(dialog.getByRole('button', { name: labels[opposite].close })).toBeVisible();
    await expect(dialog).toContainText(status);
    await dialog.getByRole('button', { name: labels[opposite].close }).click();
    await expect(row).toHaveClass(/needs-you/);
    await page.locator('#locale').selectOption(locale);
    expect(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await page.locator('#locale').boundingBox();
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
      await page.goto(base); await page.locator('#locale').selectOption('cs');
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
    await page.locator('#locale').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#result-count')).toHaveText('Dashboard data could not be loaded. Refresh the page.');
    await expect(page.getByRole('searchbox', { name: 'Search dashboard' })).toBeVisible();
  } finally { await context.close(); }
});

async function expectThemeIcon(page, choice) {
  await expect(page.locator('.theme-control')).toHaveAttribute('data-theme-choice', choice);
  for (const value of ['light', 'dark', 'system']) {
    const icon = page.locator(`[data-theme-icon="${value}"]`);
    if (value === choice) await expect(icon).toBeVisible();
    else await expect(icon).toBeHidden();
  }
}

async function keyboardFocus(page, selector) {
  // Reach each native select through the actual tab sequence.
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    if (await page.locator(selector).evaluate(node => node === document.activeElement)) {
      expect(await page.locator(selector).evaluate(node => node.matches(':focus-visible'))).toBe(true);
      return;
    }
  }
  throw new Error('Control was unreachable by keyboard');
}

async function expectFocusRing(page, selector) {
  const ring = await page.locator(selector).evaluate(node => {
    const target = node.id === 'theme' ? node.closest('.theme-control') : node;
    const style = getComputedStyle(target);
    const rendered = target.getBoundingClientRect().width > 0 && target.getBoundingClientRect().height > 0;
    return { rendered, width: parseFloat(style.outlineWidth), style: style.outlineStyle, color: style.outlineColor, offset: parseFloat(style.outlineOffset) };
  });
  expect(ring.rendered).toBe(true);
  expect(ring.width).toBe(3);
  expect(ring.style).toBe('solid');
  expect(ring.color).not.toBe('rgba(0, 0, 0, 0)');
  expect(ring.offset).toBeGreaterThanOrEqual(3);
}

for (const locale of ['en', 'cs']) test(`${locale}: native keyboard typeahead changes choice, applied theme and icon`, async ({ browser }) => {
  const context = await contextFor(browser);
  try {
    const page = await context.newPage();
    await page.goto(base);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.locator('#locale').selectOption(locale);
    const choices = locale === 'en' ? [['d', 'dark', 'dark'], ['l', 'light', 'light']] : [['t', 'dark', 'dark'], ['sv', 'light', 'light']];
    for (const [key, choice, applied] of choices) {
      // A fresh control clears WebKit's native prefix buffer between choices.
      await page.reload();
      await keyboardFocus(page, '#theme');
      for (const letter of key) await page.keyboard.press(letter);
      await page.keyboard.press('Tab');
      await expect(page.locator('#theme')).toHaveValue(choice);
      await expect(page.locator('html')).toHaveAttribute('data-theme', applied);
      await expectThemeIcon(page, choice);
    }
  } finally { await context.close(); }
});

test('native selects render separate 3px keyboard focus rings in both themes', async ({ browser }) => {
  const context = await contextFor(browser);
  try {
    const page = await context.newPage();
    await page.goto(base);
    for (const choice of ['light', 'dark']) {
      await page.locator('#theme').selectOption(choice);
      for (const selector of ['#locale', '#theme']) {
        await keyboardFocus(page, selector);
        await expectFocusRing(page, selector);
      }
    }
  } finally { await context.close(); }
});

test('keyboard select choices persist; System follows live changes at 360px', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, colorScheme: 'light', extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': token, 'Accept-Language': 'en' } });
  try {
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    const root = page.locator('html'), language = page.locator('#locale'), theme = page.locator('#theme');
    await expect(page.locator('.preferences select')).toHaveCount(2);
    await expect(page.locator('.preferences button')).toHaveCount(0);
    await expect(root).toHaveAttribute('data-theme', 'light');
    await expect(language).toHaveValue('en');
    await expect(theme).toHaveValue('system');
    await expectThemeIcon(page, 'system');
    await keyboardFocus(page, '#locale');
    // Native select behavior varies by OS; selectOption after keyboard focus is portable.
    await language.selectOption('cs');
    await expect(root).toHaveAttribute('lang', 'cs');
    await expect(language).toHaveValue('cs');
    await expect(language).toHaveAccessibleName('Jazyk rozhraní');
    await expect(theme).toHaveAccessibleName('Barevný režim');
    await expect(language.locator('option')).toHaveText(['EN', 'CZ']);
    await expect(theme.locator('option')).toHaveText(['Světlý', 'Tmavý', 'Systém']);
    await keyboardFocus(page, '#theme');
    // Native type-ahead selects the localized Dark option on desktop and mobile.
    await page.keyboard.press('t');
    await page.keyboard.press('Tab');
    await expectThemeIcon(page, 'dark');
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await expect(theme).toHaveValue('dark');
    expect(await page.evaluate(() => localStorage.getItem('supervisor.theme'))).toBe('dark');
    await page.reload();
    await expect(root).toHaveAttribute('lang', 'cs');
    await expect(language).toHaveValue('cs');
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await expect(theme).toHaveValue('dark');
    await expectThemeIcon(page, 'dark');
    expect(await theme.evaluate(node => getComputedStyle(node).colorScheme)).toBe('dark');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await keyboardFocus(page, '#theme');
    await theme.selectOption('system');
    await expect(theme).toHaveValue('system');
    await expectThemeIcon(page, 'system');
    await expect(root).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await expect(theme).toHaveValue('system');
    await expectThemeIcon(page, 'system');
    await page.reload();
    await expect(theme).toHaveValue('system');
    await expectThemeIcon(page, 'system');
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(root).toHaveAttribute('data-theme', 'light');
    for (const locale of ['cs', 'en']) {
      await language.selectOption(locale);
      await expect(language).toHaveValue(locale);
      for (const choice of ['light', 'dark', 'system']) {
        await theme.selectOption(choice);
        await expect(theme).toHaveValue(choice);
        await expectThemeIcon(page, choice);
        await page.reload();
        await expect(theme).toHaveValue(choice);
        await expectThemeIcon(page, choice);
        expect(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth)).toBe(true);
        const bar = await page.locator('.top-bar').boundingBox();
        const boxes = await page.locator('.brand, .preferences select').evaluateAll(nodes => nodes.map(node => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        }));
        for (const box of boxes) {
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(360);
          expect(box.y).toBeGreaterThanOrEqual(bar.y);
          expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height);
        }
        expect(boxes[0].x + boxes[0].width).toBeLessThanOrEqual(boxes[1].x);
        expect(boxes[1].x + boxes[1].width).toBeLessThanOrEqual(boxes[2].x);
      }
    }
    await expect(theme).toHaveAccessibleName('Color theme');
    await expect(language).toHaveAccessibleName('Interface language');
    await expect(theme.locator('option')).toHaveText(['Light', 'Dark', 'System']);
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
      await expectThemeIcon(page, 'system');
      await page.locator('#theme').selectOption('dark');
      await expectThemeIcon(page, 'dark');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.emulateMedia({ colorScheme: 'light' });
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect(page.locator('#theme')).toHaveValue('dark');
      await page.reload();
      await expect(page.locator('#theme')).toHaveValue('system');
      await expectThemeIcon(page, 'system');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }
});


for (const width of [320, 360, 1280]) test(`native theme target and header geometry at ${width}px`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width, height: 800 }, extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': token } });
  try {
    const page = await context.newPage();
    await page.goto(base);
    await expect(page.locator('.theme-visual')).toHaveAttribute('aria-hidden', 'true');
    for (const locale of ['en', 'cs']) {
      await page.locator('#locale').selectOption(locale);
      const measurement = await page.evaluate(() => {
        const box = selector => {
          const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
          return { x, y, width, height };
        };
        const theme = box('.theme-control');
        return {
          locale: box('#locale'), theme, brand: box('.brand'), row: box('.top-bar'),
          pair: box('.preferences'), gap: theme.x - box('#locale').x - box('#locale').width,
          localeScrollWidth: document.querySelector('#locale').scrollWidth, localeClientWidth: document.querySelector('#locale').clientWidth,
          scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
          centerTarget: document.elementFromPoint(theme.x + theme.width / 2, theme.y + theme.height / 2)?.id,
          cornerTarget: document.elementFromPoint(theme.x + 3, theme.y + 3)?.id,
          visualPointerEvents: getComputedStyle(document.querySelector('.theme-visual')).pointerEvents,
          selectHeight: document.querySelector('#theme').getBoundingClientRect().height,
        };
      });
      console.log('HEADER_WIDTHS ' + JSON.stringify({ viewport: width, language: locale, ...measurement }));
      if (width <= 480) expect(measurement.pair.width).toBeLessThanOrEqual(100);
      expect(measurement.localeScrollWidth).toBeLessThanOrEqual(measurement.localeClientWidth);
      expect(measurement.locale.height).toBeGreaterThanOrEqual(44);
      expect(measurement.theme.height).toBeGreaterThanOrEqual(44);
      expect(measurement.selectHeight).toBeGreaterThanOrEqual(44);
      expect(measurement.centerTarget).toBe('theme');
      expect(measurement.cornerTarget).toBe('theme');
      expect(measurement.visualPointerEvents).toBe('none');
      expect(measurement.scrollWidth).toBe(measurement.clientWidth);
      const boxes = [measurement.brand, measurement.locale, measurement.theme];
      for (const box of boxes) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y).toBeGreaterThanOrEqual(measurement.row.y);
        expect(box.y + box.height).toBeLessThanOrEqual(measurement.row.y + measurement.row.height);
      }
      expect(boxes[0].x + boxes[0].width).toBeLessThanOrEqual(boxes[1].x);
      expect(boxes[1].x + boxes[1].width).toBeLessThanOrEqual(boxes[2].x);
    }
  } finally { await context.close(); }
});

test('locale chevron preserves native hit testing, text space and keyboard input', async ({ browser }) => {
  const context = await contextFor(browser);
  try {
    const page = await context.newPage();
    await page.goto(base);
    for (const width of [320, 360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      for (const choice of ['en', 'cs']) {
        const locale = page.locator('#locale');
        await locale.selectOption(choice);
        const geometry = await page.evaluate(() => {
          const select = document.querySelector('#locale'), style = getComputedStyle(select), rect = select.getBoundingClientRect();
          const probe = document.createElement('span');
          probe.className = 'sr-only'; probe.style.font = style.font; probe.textContent = select.selectedOptions[0].text;
          document.body.append(probe);
          const range = document.createRange(); range.selectNodeContents(probe);
          const textWidth = range.getBoundingClientRect().width; probe.remove();
          const textLeft = rect.x + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
          const chevron = selector => {
            const node = document.querySelector(selector), css = getComputedStyle(node), box = node.getBoundingClientRect();
            const control = node.closest('.locale-control, .theme-control').getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height, cssWidth: css.width, cssHeight: css.height, color: css.stroke, path: node.querySelector('path').getAttribute('d'), right: control.right - box.right, center: box.y + box.height / 2, controlCenter: control.y + control.height / 2 };
          };
          const language = chevron('.locale-chevron'), theme = chevron('.theme-chevron');
          return { language, theme, textLeft, textWidth, textRight: textLeft + textWidth, availableTextWidth: select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), target: document.elementFromPoint(language.x + language.width / 2, language.y + language.height / 2)?.id, appearance: style.appearance, pointerEvents: getComputedStyle(document.querySelector('.locale-chevron')).pointerEvents };
        });
        expect(geometry.target).toBe('locale');
        expect(geometry.appearance).toBe('none');
        expect(geometry.pointerEvents).toBe('none');
        await expect(page.locator('.locale-chevron')).toHaveAttribute('aria-hidden', 'true');
        expect(geometry.textWidth).toBeLessThanOrEqual(geometry.availableTextWidth);
        expect(geometry.textRight).toBeLessThanOrEqual(geometry.language.x);
        for (const property of ['width', 'height', 'cssWidth', 'cssHeight', 'color', 'path', 'right']) expect(geometry.language[property]).toBe(geometry.theme[property]);
        expect(geometry.language.center).toBe(geometry.language.controlCenter);
        await page.evaluate(() => {
          window.__localeClicks = [];
          document.querySelector('#locale').addEventListener('pointerdown', event => window.__localeClicks.push({ target: event.target.id, trusted: event.isTrusted }), { once: true });
        });
        await page.mouse.click(geometry.language.x + geometry.language.width / 2, geometry.language.y + geometry.language.height / 2);
        if (await locale.evaluate(() => CSS.supports('selector(:open)'))) {
          await expect.poll(() => locale.evaluate(node => node.matches(':open'))).toBe(true);
        }
        const open = await locale.evaluate(node => ({ supported: CSS.supports('selector(:open)'), open: CSS.supports('selector(:open)') ? node.matches(':open') : null, focused: node === document.activeElement }));
        if (open.supported) expect(open.open).toBe(true);
        expect(open.focused).toBe(true);
        await locale.selectOption(choice === 'en' ? 'cs' : 'en');
        await page.keyboard.press('Escape');
        await expect(locale).toHaveValue(choice === 'en' ? 'cs' : 'en');
        expect(await page.evaluate(() => window.__localeClicks)).toEqual([{ target: 'locale', trusted: true }]);
        console.log('LOCALE_CLICK ' + JSON.stringify({ engine: browser.browserType().name(), width, choice, ...open }));
        await page.reload();
        await page.locator('.skip').focus();
        await keyboardFocus(page, '#locale');
        await expectFocusRing(page, '#locale');
        await page.keyboard.press(choice === 'en' ? 'e' : 'c');
        await page.keyboard.press('Tab');
        await expect(locale).toHaveValue(choice);
        await expect(page.locator('html')).toHaveAttribute('lang', choice);
      }
    }
  } finally { await context.close(); }
});
