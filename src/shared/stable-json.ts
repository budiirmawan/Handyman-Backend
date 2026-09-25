/**
 * CR-BE-IDEMPOTENCY-CORE-01 PART 01 — shared canonical JSON helper.
 *
 * Stable canonical JSON: object-key ordering recursively sorted,
 * arrays preserve order. Lifted from established repository precedent
 * (reporting-archive service) — deterministic fingerprinting for the
 * generic idempotency foundation.
 *
 * Do not canonicalize semantic values beyond what callers already normalized.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}
