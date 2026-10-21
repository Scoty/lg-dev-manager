/**
 * Formatting shared by every page: sizes and counted nouns. One place to change when the app gets translations — the
 * unit names and the plural forms below are the English ones, and the numbers already follow the browser's locale.
 */

const number = (digits: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
const n0 = number(0);
const n1 = number(1);

/** 512 B, 3.4 KB, 120 KB, 5.0 MB, 1.2 GB (powers of 1024, as the TV and the bridge count them). */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n0.format(n)} B`;
  if (n < 1024 ** 2) return `${(n < 10 * 1024 ? n1 : n0).format(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${n1.format(n / 1024 ** 2)} MB`;
  return `${n1.format(n / 1024 ** 3)} GB`;
}

/** Sizes the TV reports in KB (df). */
export const fmtKilobytes = (kb: number) => fmtBytes(kb * 1024);

const rules = new Intl.PluralRules('en');

/** "1 TV", "3 TVs": the noun for one, and for many (default: one + "s"). */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n0.format(n)} ${rules.select(n) === 'one' ? one : many}`;
}

/** A plain number in the browser's locale: 12,345. */
export const fmtNumber = (n: number) => n0.format(n);
