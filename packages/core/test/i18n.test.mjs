import { expect, it } from 'vitest';
import { dictionaries, negotiateLocale, resolveLocale, persistLocale, translate, formatTimestamp } from '../src/i18n.ts';

it('has identical complete, nonempty dictionaries and matching interpolation fields', () => {
  const keys = Object.keys(dictionaries.en).sort();
  expect(Object.keys(dictionaries.cs).sort()).toEqual(keys);
  for (const key of keys) {
    for (const locale of ['en', 'cs']) expect(dictionaries[locale][key].trim(), `${locale}.${key}`).not.toBe('');
    const fields = text => [...text.matchAll(/\{\w+\}/g)].map(match => match[0]).sort();
    expect(fields(dictionaries.cs[key]), key).toEqual(fields(dictionaries.en[key]));
  }
});

it.each([
  [null, 'en'], ['', 'en'], ['de, fr;q=0.9', 'en'],
  ['cs-CZ, en;q=0.8', 'cs'], ['en-GB;q=0.2, cs-SK;q=0.9', 'cs'],
  ['cs;q=0.2, en-US;q=0.9', 'en'], ['cs;q=0, en;q=0.1', 'en'],
  ['en;q=0.5, cs;q=0.5', 'en'], ['cs;q=0.5, en;q=0.5', 'cs'],
  ['de;q=1, cs;q=0.7, en;q=0.4', 'cs'], ['*;q=1, cs;q=0.8', 'cs'],
  ['cs;q=2, en;q=0.5', 'en'], ['cs;q=NaN', 'en'], ['cs;q=-1', 'en'],
  ['cs;q=0.1234, en;q=0.1', 'en'], ['EN-us;q=0.8, CS-cz;q=1', 'cs'],
  ['cs;<script>canary</script>', 'en'], ['cs;q=1.001', 'en'],
])('negotiates weighted Accept-Language %s as %s', (header, expected) => {
  expect(negotiateLocale(header)).toBe(expected);
});

it.each([
  ['cs', 'en', ['en'], 'cs'], ['en', 'cs', ['cs'], 'en'],
  [null, 'cs', ['en'], 'cs'], ['broken', 'cs', ['en'], 'cs'],
  ['"cs"', 'en', ['cs'], 'en'], ['', 'en', ['cs'], 'en'],
  [null, undefined, ['de', 'cs-CZ', 'en'], 'cs'],
  ['CS', undefined, ['en-GB', 'cs'], 'en'],
  [null, undefined, ['de', 'fr'], 'en'], [null, undefined, [], 'en'],
])('resolves storage=%s, server=%s, navigator=%s to %s', (saved, server, languages, expected) => {
  expect(resolveLocale(() => ({ getItem: () => saved }), server, languages)).toBe(expected);
});
it('catches unavailable storage and failed writes while keeping in-memory choice', () => {
  const denied = () => { throw new Error('Blocked'); };
  expect(resolveLocale(denied, 'cs', ['en'])).toBe('cs');
  expect(resolveLocale(denied, undefined, ['cs'])).toBe('cs');
  expect(() => persistLocale(denied, 'cs')).not.toThrow();
  expect(() => persistLocale(() => ({ setItem() { throw new Error('Quota'); } }), 'en')).not.toThrow();
});
it('formats immutable UTC timestamps and date-only values with the selected locale and configured zone', () => {
  const value = '2026-11-27T23:30:00Z';
  for (const locale of ['en', 'cs']) {
    expect(formatTimestamp(value, locale, 'Europe/Prague')).toBe(new Intl.DateTimeFormat(locale, {
      timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(value)));
    expect(formatTimestamp('2026-11-27', locale, 'America/Los_Angeles')).toBe(new Intl.DateTimeFormat(locale, {
      timeZone: 'UTC', day: 'numeric', month: 'numeric', year: 'numeric',
    }).format(new Date('2026-11-27')));
    expect(formatTimestamp('bad', locale, 'UTC')).toBe(translate(locale, 'missing'));
  }
  expect(value).toBe('2026-11-27T23:30:00Z');
});
