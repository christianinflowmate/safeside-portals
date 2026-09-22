/** Joins class names, dropping anything falsy. No variant engine needed. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
