import type {
  UtilityMeterPurpose,
  UtilityMeterStatus,
  UtilityType,
} from '../utility-meters';
import type {
  UtilityMeterReadingSource,
  UtilityMeterReadingType,
} from '../utility-meter-readings';
import type { UtilityReadingDueStatus } from '../utility-reading-dues';
import type { MobileUtilityMeterReading } from '../mobile-utility-meter-reading';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 00 — mobile field meter-context contract.
 *
 * The mobile-safe READ that lets a field actor identify the BE-18 utility
 * meter they have been issued a Reading Due for, before any capture happens.
 *
 * IDENTITY + AUTHORITY ONLY
 * -------------------------
 * This is a context read. It exposes canonical BE-18 facts and nothing else.
 * PART 00 deliberately does NOT expose:
 *   - any `availableActions` / action vocabulary (PARTs 01–03 own command
 *     semantics, so freezing tokens now would pre-empt them);
 *   - any reading write, Idempotency-Key, or reconciliation record;
 *   - evidence, OCR candidates, abnormality classification, or recheck state.
 *
 * NO DERIVED ARITHMETIC
 * ---------------------
 * `latestReading` is BACKEND CONTEXT ONLY. It is not a baseline the client may
 * subtract from, not a `previousReading`, and not a reconciliation record for a
 * future write. Consumption remains BE-18G's (`current − previous`, persisted,
 * backend-commanded) and this DTO exposes no tariff, rate, currency, amount, or
 * delta of any kind — billing never lives in BE-18, and RN-12 field contract
 * calculates no money.
 *
 * RESOLVED FROM A FIELD EXECUTION IDENTITY
 * ----------------------------------------
 * The context is addressed by `readingDueId`, never by a bare meter id. Several
 * OPEN dues may coexist for one meter (`UNIQUE (meter_id, period_start,
 * period_end)`), so a meter id alone cannot identify which field execution the
 * actor is standing in; the due id can.
 */

/** BE-07 unit of measure the meter is configured to report in. */
export type MobileMeterContextUom = {
  id: string;
  code: string;
  name: string;
  symbol: string;
};

/** The Reading Due that is the field execution identity for this context. */
export type MobileMeterContextReadingDue = {
  id: string;
  /**
   * Canonical BE-18 due status. `OVERDUE` is not stored — it is derived by the
   * existing reading-due repository (`status = 'DUE' AND due_at < NOW()`), so
   * this field carries exactly the value the management routes already return.
   */
  status: UtilityReadingDueStatus;
  dueAt: string;
  periodStart: string;
  periodEnd: string;
  /**
   * The generated task the actor's field authority was proven against. Always
   * non-null on this route: a due without a task is rejected by
   * `assertUtilityMeterFieldActor` before any context is assembled.
   */
  generatedTaskId: string;
};

/** BE-18A meter identity facts. */
export type MobileMeterContextMeter = {
  id: string;
  /** Stable machine-readable identifier, unique per Client (`client_id, code`). */
  code: string;
  name: string;
  /** Manufacturer serial / utility reference number; not every meter has one. */
  serialNumber: string | null;
  utilityType: UtilityType;
  purpose: UtilityMeterPurpose;
  status: UtilityMeterStatus;
  buildingId: string;
  spaceId: string | null;
  functionalLocationId: string | null;
  uom: MobileMeterContextUom;
  /**
   * Reading decimal precision governed by BE-18B `utility_type_configurations`
   * for this meter's (client, utilityType).
   *
   * `null` is a MEANINGFUL value, not a missing one: BE-18B is opt-in, and the
   * existing BE-18E rule (`assertConfiguredPrecision`) applies NO precision
   * constraint when the Client has no configuration for the utility type or has
   * left `decimal_precision` null. This DTO reproduces that exact canonical
   * behaviour and invents no default.
   */
  decimalPrecision: number | null;
};

/** The chronologically latest BE-18E reading, resolved by the backend. */
export type MobileMeterContextLatestReading = {
  id: string;
  readingValue: number;
  readingAt: string;
  readingType: UtilityMeterReadingType;
  source: UtilityMeterReadingSource;
};

/** The full mobile field meter-context response. */
export type MobileUtilityMeterContext = {
  readingDue: MobileMeterContextReadingDue;
  meter: MobileMeterContextMeter;
  /** `null` when the meter has never been read — a valid state, not an error. */
  latestReading: MobileMeterContextLatestReading | null;
  /**
   * CR-BE-RN12-METER-FIELD-01 PART 01 — the reading THIS due is definitively
   * linked to, or `null` when it has not been completed.
   *
   * This is the RECONCILIATION read for an ambiguous field submit outcome, and it
   * is derived from the due's canonical `meter_reading_id` — never from
   * `latestReading`. The distinction is the whole point: another legitimate actor
   * or an engineering round may post a later reading on the same meter, which
   * changes `latestReading` while leaving `submittedReading` exact. A client can
   * therefore determine "this exact reading due is linked to reading X" without a
   * second arbitrary lookup, and without ever inferring success from a matching
   * value or a nearby timestamp.
   *
   * Projected with the SAME mapper as the field reading routes, so one submitted
   * reading has exactly one shape platform-wide. Still no `availableActions`:
   * command semantics remain PARTs 02–03.
   */
  submittedReading: MobileUtilityMeterReading | null;
};
