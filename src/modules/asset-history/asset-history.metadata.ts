import type { AssetHistoryMetadata } from './asset-history.types';

/**
 * BE-05I — central metadata sanitizer.
 *
 * History metadata must never carry credentials, tokens, session material,
 * or Authorization headers. Rather than trusting every call site to remember
 * that, filtering happens HERE, once, so a careless caller cannot leak a
 * secret into permanent history.
 *
 * The rule is deny-by-key-name: any key whose name suggests secret material
 * is dropped (recursively, including inside nested objects and arrays).
 * Values are additionally length-capped, because history is not a place to
 * dump payloads.
 */
const SENSITIVE_KEY_PATTERN =
  /pass(word|phrase)?|secret|token|credential|authorization|auth[-_]?header|cookie|session|bearer|api[-_]?key|private[-_]?key|salt|hash|otp|pin\b/i;

const MAX_STRING_LENGTH = 512;
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 25;
const MAX_KEYS = 50;

export function isSensitiveMetadataKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Returns a copy of `metadata` with sensitive keys removed and values
 * normalized to safe, compact JSON primitives.
 */
export function sanitizeHistoryMetadata(
  metadata: AssetHistoryMetadata | undefined,
): AssetHistoryMetadata {
  if (!metadata) {
    return {};
  }

  const sanitized = sanitizeValue(metadata, 0);
  if (sanitized === undefined || typeof sanitized !== 'object' || sanitized === null) {
    return {};
  }

  return Array.isArray(sanitized) ? {} : (sanitized as AssetHistoryMetadata);
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null) {
    return null;
  }

  if (depth > MAX_DEPTH) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…`
      : value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1))
      .filter((item) => item !== undefined);
    return items;
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    let keyCount = 0;

    for (const [key, nested] of Object.entries(value)) {
      if (keyCount >= MAX_KEYS) {
        break;
      }
      if (isSensitiveMetadataKey(key)) {
        continue;
      }

      const sanitized = sanitizeValue(nested, depth + 1);
      if (sanitized !== undefined) {
        result[key] = sanitized;
        keyCount += 1;
      }
    }

    return result;
  }

  // Functions, symbols, bigints, undefined: not representable safely.
  return undefined;
}

/**
 * Builds a `{ field: { from, to } }` change map for the fields that actually
 * changed. Sensitive keys are dropped by the sanitizer downstream.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): AssetHistoryMetadata {
  const changes: AssetHistoryMetadata = {};

  for (const [key, nextValue] of Object.entries(after)) {
    if (nextValue === undefined) {
      continue;
    }

    const previousValue = before[key as keyof T];
    const normalizedPrevious =
      previousValue instanceof Date
        ? previousValue.toISOString().slice(0, 10)
        : previousValue;

    if (normalizedPrevious === nextValue) {
      continue;
    }

    changes[key] = { from: normalizedPrevious ?? null, to: nextValue };
  }

  return changes;
}

/** The list of field names that changed, for a compact summary line. */
export function changedFieldNames(changes: AssetHistoryMetadata): string[] {
  return Object.keys(changes);
}
