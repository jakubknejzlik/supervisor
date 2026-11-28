export const CATEGORY_MAX_LENGTH = 64;
export const CATEGORY_CHARACTERS = /^[^\u0000-\u001f\u007f]*$/;

// A read-time projection only. Never write this fallback into stored data.
export function effectiveCategory(record: { category?: unknown; agent?: string; project?: string }) {
  const value = record.category;
  if (typeof value === 'string' && CATEGORY_CHARACTERS.test(value)) {
    const category = value.trim();
    if (category.length > 0 && category.length <= CATEGORY_MAX_LENGTH) return category;
  }
  return record.agent || record.project || null;
}
