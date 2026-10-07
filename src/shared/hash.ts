import { createHash } from 'node:crypto';

/**
 * CR-BE-IDEMPOTENCY-CORE-01 PART 01 — shared crypto helper.
 *
 * Returns lowercase hex SHA-256 of the UTF-8 value.
 * Lifted from established repository precedent (reporting-archive,
 * price-catalog, evidence integrity) — single source for the generic
 * idempotency foundation.
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
