import en from './locales/en';
import cs from './locales/cs';

export type Locale = 'en' | 'cs';
export const dictionaries = { en, cs };
export const isLocale = (value: unknown): value is Locale => value === 'en' || value === 'cs';
export function supportedLanguage(value: string): Locale | undefined {
  const match = /^(en|cs)(?:-[a-z0-9]+)*$/i.exec(value);
  return match?.[1].toLowerCase() as Locale | undefined;
}
// Invalid weights and explicitly unacceptable languages never win negotiation.
export function negotiateLocale(header: string | null): Locale {
  const choices = (header ?? '').split(',').map((part, index) => {
    const match = /^\s*([a-z0-9*-]+)\s*(?:;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/i.exec(part);
    return { locale: match ? supportedLanguage(match[1]) : undefined, quality: match ? Number(match[2] ?? 1) : 0, index };
  }).filter(choice => choice.locale && choice.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  return choices[0]?.locale ?? 'en';
}
export function resolveLocale(storage: () => Pick<StorageLike, 'getItem'>, serverLocale?: unknown, languages: readonly string[] = []): Locale {
  try { const saved = storage().getItem('supervisor.locale'); if (isLocale(saved)) return saved; } catch { /* blocked storage */ }
  if (isLocale(serverLocale)) return serverLocale;
  return languages.map(supportedLanguage).find(isLocale) ?? 'en';
}
type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void };
export function persistLocale(storage: () => Pick<StorageLike, 'setItem'>, locale: Locale) {
  try { storage().setItem('supervisor.locale', locale); } catch { /* keep the in-memory selection */ }
}
export function translate(locale: Locale, key: string, values: Record<string, unknown> = {}): string {
  const dictionary: Record<string, string> = dictionaries[locale];
  return (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
}
export function stateKey(state: unknown): string {
  const key = 'state_' + String(state);
  return Object.hasOwn(en, key) ? key : 'state_unknown';
}
export function displayTimezone(value?: string): string {
  try { if (value) { new Intl.DateTimeFormat('en', { timeZone: value }); return value; } } catch { /* invalid optional configuration */ }
  return 'UTC';
}
export function formatTimestamp(value: string | null | undefined, locale: Locale, timezone: string): string {
  const date = value ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime())) return translate(locale, 'missing');
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value!);
  return new Intl.DateTimeFormat(locale, {
    timeZone: dateOnly ? 'UTC' : displayTimezone(timezone), day: 'numeric', month: 'numeric', year: 'numeric',
    ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit' }),
  }).format(date);
}
