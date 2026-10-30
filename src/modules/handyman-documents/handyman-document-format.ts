/**
 * CR-HM-DOCUMENT-PDF-01 PART 01 — pure presentation primitives of the shared
 * business-document renderer (Indonesian-first, English fallback).
 *
 * These helpers exist so the layout engine never inlines formatting rules:
 *  - `handymanDocumentText` makes ANY caller string safe for the Standard PDF
 *    fonts (WinAnsi alphabet): accents are folded, typographic punctuation is
 *    mapped to ASCII, control characters and format characters are dropped and
 *    runs of whitespace collapse. It is an escape/normalization step, not a
 *    sanitizer that rewrites meaning - nothing is inserted and nothing is
 *    translated.
 *  - money and quantity formatting is a hand-rolled grouping algorithm with
 *    fixed currency decimals, because `Intl` output depends on the ICU build
 *    of the runtime and would break byte-determinism.
 *  - dates are formatted from explicit month tables and an explicit UTC
 *    offset, so no host locale or timezone can change the bytes.
 */

import { HandymanDocumentPdfError } from './handyman-document-pdf.errors';
import type { HandymanDocumentLocale } from './handyman-document-pdf.types';

/** Neutral marker for an optional field the caller did not supply. */
export const HANDYMAN_DOCUMENT_MISSING = '-';

const MONTHS: Record<HandymanDocumentLocale, readonly string[]> = {
  id: [
    'Januari',
    'Februari',
    'Maret',
    'April',
    'Mei',
    'Juni',
    'Juli',
    'Agustus',
    'September',
    'Oktober',
    'November',
    'Desember',
  ],
  en: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
};

/** Symbols for the currencies this platform issues documents in. */
const CURRENCY_SYMBOLS: Record<string, string> = {
  IDR: 'Rp',
  USD: 'US$',
  SGD: 'S$',
  MYR: 'RM',
  AUD: 'A$',
  EUR: 'EUR ',
  GBP: 'GBP ',
  JPY: 'JPY ',
  CNY: 'CNY ',
};

/** Fixed decimals per currency (IDR has no minor unit in practice). */
const CURRENCY_DECIMALS: Record<string, number> = {
  IDR: 0,
  JPY: 0,
  CNY: 2,
  USD: 2,
  SGD: 2,
  MYR: 2,
  AUD: 2,
  EUR: 2,
  GBP: 2,
};

/** Absolute ceiling that still fits the numeric columns of the layout. */
const MAX_MONEY_ABS = 999_999_999_999_999;

/**
 * Normalizes free text for WinAnsi-encoded Standard fonts. Deterministic,
 * idempotent and length-preserving enough to stay readable, but never
 * meaning-changing: it folds accents, maps typographic punctuation to ASCII
 * and drops code points the font cannot encode.
 */
export function handymanDocumentText(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : String(value);
  let out = '';
  for (const character of raw.normalize('NFKC')) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x2018 || code === 0x2019 || code === 0x02bc) out += "'";
    else if (code === 0x201c || code === 0x201d) out += '"';
    else if (code === 0x2013 || code === 0x2014 || code === 0x2212) out += '-';
    else if (code === 0x00a0 || code === 0x2007 || code === 0x202f) out += ' ';
    else if (code === 0x2022 || code === 0x00b7) out += '*';
    else if (code === 0x2026) out += '...';
    else if (code >= 0x200b && code <= 0x200f) continue; // zero-width / bidi
    else if (code >= 0x2028 && code <= 0x202f) continue; // line/para separators
    else if (code === 0x00ad) continue; // soft hyphen
    else if (code === 0x0a) out += '\n';
    else if (code === 0x09) out += ' ';
    else if (code === 0x0d) continue;
    else if (code >= 0x20 && code <= 0x7e) out += character;
    else if (code === 0xb0) out += ' deg';
    else if (code >= 0xa1 && code <= 0xff) out += foldLatin1(character);
    else if (/\s/u.test(character)) out += ' ';
    // anything else (emoji, CJK, RTL, control) is dropped, never guessed
  }
  return collapseBlankRuns(out);
}

/**
 * Latin-1 range folded to ASCII so accented Latin input (common in names)
 * survives WinAnsi without a custom font.
 */
function foldLatin1(character: string): string {
  const folded = character
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u1ab0-\u1aff]/g, '');
  return handymanAsciiOnly(folded);
}

function handymanAsciiOnly(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) out += character;
  }
  return out;
}

function collapseBlankRuns(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter((line, index, lines) => line !== '' || (index > 0 && lines[index - 1] !== ''))
    .join('\n')
    .trim();
}

/** Splits normalized text into renderable lines (explicit newlines honoured). */
export function handymanDocumentLines(value: unknown): string[] {
  const text = handymanDocumentText(value);
  return text ? text.split('\n') : [];
}

/**
 * Money rendering: `Rp1.500.000` for Indonesian readers, `IDR 1.500.000`
 * style fallback for codes without a known symbol, `-Rp250.000` for a
 * reduction (variation deltas), with `.`/`,` swapped for the `en` locale.
 * The ONLY arithmetic performed here is rounding to the currency's own minor
 * unit (half-up), so a figure is never re-priced - an IDR amount therefore
 * renders on whole rupiah.
 */
export function formatHandymanDocumentMoney(
  amount: number,
  currency: string,
  locale: HandymanDocumentLocale,
): string {
  const code = validateCurrency(currency);
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new HandymanDocumentPdfError(
      'INVALID_MONEY_VALUE',
      'Document amounts must be finite numbers.',
    );
  }
  if (Math.abs(amount) > MAX_MONEY_ABS) {
    throw new HandymanDocumentPdfError(
      'INVALID_MONEY_VALUE',
      `Document amounts must stay below ${MAX_MONEY_ABS}.`,
    );
  }
  const decimals = CURRENCY_DECIMALS[code] ?? 2;
  const negative = amount < 0;
  const scaled = Math.round(Math.abs(amount) * 10 ** decimals);
  const unit = 10 ** decimals;
  const whole = Math.floor(scaled / unit).toString();
  const fraction = decimals > 0 ? (scaled % unit).toString().padStart(decimals, '0') : '';
  const grouped = groupDigits(
    whole,
    locale === 'id' ? '.' : ',',
  );
  const number = decimals > 0 ? `${grouped}${locale === 'id' ? ',' : '.'}${fraction}` : grouped;
  const symbol = CURRENCY_SYMBOLS[code] ?? `${code} `;
  return `${negative ? '-' : ''}${symbol}${number}`;
}

/** Quantity rendering (up to 3 decimals, trailing zeros trimmed). */
export function formatHandymanDocumentQuantity(
  value: number,
  locale: HandymanDocumentLocale,
): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HandymanDocumentPdfError(
      'INVALID_LAYOUT',
      'Quantities must be finite numbers.',
    );
  }
  const rounded = Math.round(value * 1000) / 1000;
  const negative = rounded < 0;
  const [whole, fraction = ''] = Math.abs(rounded).toFixed(3).split('.');
  const trimmed = fraction.replace(/0+$/, '');
  const grouped = groupDigits(whole, locale === 'id' ? '.' : ',');
  return `${negative ? '-' : ''}${grouped}${
    trimmed ? `${locale === 'id' ? ',' : '.'}${trimmed}` : ''
  }`;
}

function groupDigits(digits: string, separator: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

function validateCurrency(currency: string): string {
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) {
    throw new HandymanDocumentPdfError(
      'INVALID_LAYOUT',
      'Currency must be an ISO-4217 alpha-3 code.',
    );
  }
  return currency.toUpperCase();
}

/**
 * `26 Oktober 2026` or `26 Oktober 2026, 13.45 (UTC+07:00)` when an offset was
 * supplied. Accepts an ISO string or a Date; anything unparseable is refused
 * rather than silently printed.
 */
export function formatHandymanDocumentDate(
  value: string | Date | null | undefined,
  locale: HandymanDocumentLocale,
  utcOffsetMinutes = 0,
  withTime = false,
): string {
  if (value === null || value === undefined || value === '') return HANDYMAN_DOCUMENT_MISSING;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HandymanDocumentPdfError(
      'INVALID_DATE_VALUE',
      'Document dates must be an ISO-8601 string or a Date.',
    );
  }
  const shifted = new Date(date.getTime() + utcOffsetMinutes * 60_000);
  const day = shifted.getUTCDate();
  const month = MONTHS[locale][shifted.getUTCMonth()] as string;
  const year = shifted.getUTCFullYear();
  const datePart = `${day} ${month} ${year}`;
  if (!withTime) return datePart;
  const hh = shifted.getUTCHours().toString().padStart(2, '0');
  const mm = shifted.getUTCMinutes().toString().padStart(2, '0');
  return `${datePart}, ${hh}${locale === 'id' ? '.' : ':'}${mm}${offsetLabel(utcOffsetMinutes)}`;
}

function offsetLabel(utcOffsetMinutes: number): string {
  if (utcOffsetMinutes === 0) return '';
  const sign = utcOffsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(utcOffsetMinutes);
  const hh = Math.floor(abs / 60)
    .toString()
    .padStart(2, '0');
  const mm = (abs % 60).toString().padStart(2, '0');
  return ` (UTC${sign}${hh}:${mm})`;
}

/** Numeric display for a non-money count (line count, size in bytes). */
export function formatHandymanDocumentInteger(
  value: number | string,
  locale: HandymanDocumentLocale,
): string {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
    throw new HandymanDocumentPdfError(
      'INVALID_LAYOUT',
      'Integer fields must be whole numbers.',
    );
  }
  return groupDigits(Math.abs(numeric).toString(), locale === 'id' ? '.' : ',');
}
