// Local-only visual proof. No production credentials, data, or infrastructure.
// node apps/dashboard/test/e2e/screenshots.mjs [--source /absolute/worktree] [--output /absolute/shots] [--before] [--narrow] [--unified] [--headed]
// Install root dependencies in the selected source worktree before running.
import { chromium, webkit, expect } from '@playwright/test';
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
  if (args.includes('--narrow') || args.includes('--unified')) {
    for (const [engine, browserType] of Object.entries({ chromium, webkit })) {
      browser = await browserType.launch({ headless: !args.includes('--headed') });
      for (const width of [320, 360]) {
        const context = await browser.newContext({ viewport: { width, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': assertion } });
        try {
          const page = await context.newPage();
          await page.goto(base);
          for (const locale of ['en', 'cs']) {
            await page.locator('#locale').selectOption(locale);
            await expect(page.locator('#locale option:checked')).toHaveText(locale === 'en' ? 'EN' : 'CZ');
            const control = page.locator('#locale');
            const arrow = await page.locator('.locale-chevron').boundingBox();
            await page.evaluate(() => {
              window.__localeClick = null;
              document.querySelector('#locale').addEventListener('pointerdown', event => { window.__localeClick = { target: event.target.id, trusted: event.isTrusted }; }, { once: true });
            });
            await page.mouse.click(arrow.x + arrow.width / 2, arrow.y + arrow.height / 2);
            if (await control.evaluate(() => CSS.supports('selector(:open)'))) {
              await expect.poll(() => control.evaluate(node => node.matches(':open'))).toBe(true);
            }
            const picker = await control.evaluate(node => ({ supported: CSS.supports('selector(:open)'), open: CSS.supports('selector(:open)') ? node.matches(':open') : null, focused: node === document.activeElement }));
            if (picker.supported) expect(picker.open).toBe(true);
            expect(picker.focused).toBe(true);
            await control.selectOption(locale === 'en' ? 'cs' : 'en');
            await page.keyboard.press('Escape');
            await expect(control).toHaveValue(locale === 'en' ? 'cs' : 'en');
            expect(await page.evaluate(() => window.__localeClick)).toEqual({ target: 'locale', trusted: true });
            await page.reload();
            await page.locator('.skip').focus(); await page.keyboard.press('Tab');
            await expect(control).toBeFocused();
            await page.keyboard.press(locale === 'en' ? 'e' : 'c'); await page.keyboard.press('Tab');
            await expect(control).toHaveValue(locale);
            console.log('PICKER_PROOF ' + JSON.stringify({ engine, viewport: width, language: locale, headed: args.includes('--headed'), ...picker, clickTarget: 'locale', trusted: true, selectOptionChanged: true, keyboardChanged: true }));
            for (const theme of ['light', 'dark']) {
              await page.locator('#theme').selectOption(theme);
              await page.locator('#theme').blur();
              await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
              const measurement = await page.evaluate(() => {
                const box = selector => {
                  const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
                  return { x, y, width, height };
                };
                const locale = document.querySelector('#locale'), style = getComputedStyle(locale);
                const language = box('#locale'), theme = box('.theme-control');
                const probe = document.createElement('span');
                probe.className = 'sr-only'; probe.style.font = style.font; probe.textContent = locale.selectedOptions[0].text;
                document.body.append(probe);
                const range = document.createRange(); range.selectNodeContents(probe);
                const textWidth = range.getBoundingClientRect().width; probe.remove();
                const textLeft = language.x + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
                const chevron = selector => {
                  const node = document.querySelector(selector), css = getComputedStyle(node), rect = node.getBoundingClientRect();
                  const parent = node.closest('.locale-control, .theme-control').getBoundingClientRect();
                  return { ...box(selector), cssWidth: css.width, cssHeight: css.height, path: node.querySelector('path').getAttribute('d'), color: css.stroke, right: parent.right - rect.right, center: rect.y + rect.height / 2, controlCenter: parent.y + parent.height / 2 };
                };
                const localeChevron = chevron('.locale-chevron'), themeChevron = chevron('.theme-chevron');
                return {
                  textWidth, textRight: textLeft + textWidth, availableTextWidth: locale.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
                  localeChevron, themeChevron, localeChevronTarget: document.elementFromPoint(localeChevron.x + localeChevron.width / 2, localeChevron.y + localeChevron.height / 2)?.id,
                  locale: language, theme, gap: theme.x - language.x - language.width,
                  pair: box('.preferences'), brand: box('.brand'), row: box('.top-bar'),
                  localeScrollWidth: locale.scrollWidth, localeClientWidth: locale.clientWidth,
                  scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
                  selectHeight: document.querySelector('#theme').getBoundingClientRect().height,
                  centerTarget: document.elementFromPoint(theme.x + theme.width / 2, theme.y + theme.height / 2)?.id,
                };
              });
              console.log('NARROW_WIDTHS ' + JSON.stringify({ engine, viewport: width, language: locale, scheme: theme, ...measurement }));
              expect(measurement.localeChevronTarget).toBe('locale');
              expect(measurement.textWidth).toBeLessThanOrEqual(measurement.availableTextWidth);
              expect(measurement.textRight).toBeLessThanOrEqual(measurement.localeChevron.x);
              for (const property of ['width', 'height', 'cssWidth', 'cssHeight', 'path', 'color', 'right']) expect(measurement.localeChevron[property]).toBe(measurement.themeChevron[property]);
              expect(measurement.localeChevron.center).toBe(measurement.localeChevron.controlCenter);
              expect(measurement.pair.width).toBeLessThanOrEqual(100);
              expect(measurement.locale.height).toBeGreaterThanOrEqual(44);
              expect(measurement.theme.height).toBeGreaterThanOrEqual(44);
              expect(measurement.selectHeight).toBeGreaterThanOrEqual(44);
              expect(measurement.gap).toBe(6);
              expect(measurement.localeScrollWidth).toBeLessThanOrEqual(measurement.localeClientWidth);
              expect(measurement.scrollWidth).toBe(measurement.clientWidth);
              expect(measurement.centerTarget).toBe('theme');
              expect(measurement.brand.x + measurement.brand.width).toBeLessThanOrEqual(measurement.locale.x);
              for (const box of [measurement.brand, measurement.locale, measurement.theme]) {
                expect(box.y).toBeGreaterThanOrEqual(measurement.row.y);
                expect(box.y + box.height).toBeLessThanOrEqual(measurement.row.y + measurement.row.height);
              }
              mkdirSync(output, { recursive: true });
              const { x, y, width: rowWidth, height } = measurement.row;
              await page.screenshot({ path: join(output, `${engine}-${width}-${locale === 'cs' ? 'cz' : 'en'}-${theme}.png`), clip: { x: x - 8, y: y - 8, width: rowWidth + 16, height: height + 16 } });
              if (width === 360 && locale === 'en') {
                await page.locator('.skip').focus(); await page.keyboard.press('Tab');
                await expect(control).toBeFocused();
                const ring = await control.evaluate(node => {
                  const css = getComputedStyle(node), rect = node.getBoundingClientRect();
                  return { width: parseFloat(css.outlineWidth), offset: parseFloat(css.outlineOffset), color: css.outlineColor, focusVisible: node.matches(':focus-visible'), x: rect.x, y: rect.y, controlWidth: rect.width };
                });
                expect(ring.width).toBe(3); expect(ring.focusVisible).toBe(true);
                const path = join(output, `${engine}-${width}-en-${theme}-locale-focus.png`);
                await page.screenshot({ path, clip: { x: x - 8, y: y - 8, width: rowWidth + 16, height: height + 16 } });
                console.log('LOCALE_FOCUS ' + JSON.stringify({ engine, scheme: theme, path, clipX: x - 8, clipY: y - 8, ...ring }));
                await control.blur();
              }
            }
          }
        } finally { await context.close(); }
      }
      await browser.close(); browser = undefined;
    }
  } else {
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
  }
  console.log(`Screenshots saved to ${output} (${args.includes('--narrow') || args.includes('--unified') ? 'native pair measurements' : before ? 'base list + modal' : 'current full set'})`);
} finally { await browser?.close(); await client.close(); await mf.dispose(); }
