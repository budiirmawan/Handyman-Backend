/**
 * CR-BE-RN12-METER-FIELD-01 PART 01 — mobile field meter reading.
 *
 * Bounded module: src/modules/mobile-utility-meter-reading/
 *
 * The technician-safe field WRITE over canonical BE-18E Meter Readings, plus the
 * canonical reads that make its outcome definitively knowable:
 *
 *   POST /mobile/utility-reading-dues/:readingDueId/readings      (field.record)
 *   GET  /mobile/utility-reading-dues/:readingDueId/readings      (field.read)
 *   GET  /mobile/utility-reading-dues/:readingDueId/readings/:id  (field.read)
 *
 * It owns addressing (Reading Due execution identity), authority (the PART 00
 * `assertUtilityMeterFieldActor` seam), server-derived provenance, atomicity and
 * the one-reading-per-due concurrency invariant. It does NOT own a second reading
 * store, a second event type, or a second completion semantic — a field submission
 * writes exactly the rows a management submission would write for the same facts.
 *
 * PART 01 scope: no evidence, no OCR, no abnormality evaluation, no recheck, no
 * `availableActions`, no QR, no mobile-sync kind, and no consumption / delta /
 * billing calculation. CR-BE-RN12-METER-FIELD-01 PART 02
 * (src/modules/mobile-utility-meter-reading-verification/) later added the
 * evidence / OCR-suggestion / abnormal-signal surface on top of it; that module
 * supplies the enriched handler for the reading DETAIL route below, which stays
 * registered HERE so the path has exactly one registration. The POST and LIST
 * routes, the reading DTO and the write semantics are untouched by PART 02.
 */

export {
  getMobileUtilityMeterReadingHandler,
  listMobileUtilityMeterReadingsHandler,
  recordMobileUtilityMeterReadingHandler,
} from './mobile-utility-meter-reading.controller';

export { createMobileUtilityMeterReadingRouter } from './mobile-utility-meter-reading.routes';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 02 — the READING-keyed field authority seam.
 *
 * PART 00's seam answers "is this actor the field executor of THIS DUE?". This
 * one answers the same question addressed from the reading the due produced,
 * which is what every PART 02 concern hangs off (BE-18F evidence, OCR
 * `accepted_reading_id`, BE-18G `current_reading_id`). It delegates to PART 00
 * verbatim and invents no rule of its own — one field authority, two addresses
 * for it.
 */
export {
  assertUtilityMeterReadingFieldActor,
  mobileUtilityMeterReadingFieldAuthority,
} from './mobile-utility-meter-reading.field-authority';

export type { MobileUtilityMeterReadingFieldContext } from './mobile-utility-meter-reading.field-authority';

export {
  findSubmittedReadingForDue,
  toMobileUtilityMeterReading,
  getMobileUtilityMeterReading,
  listMobileUtilityMeterReadings,
  mobileUtilityMeterReadingService,
  recordMobileUtilityMeterReading,
} from './mobile-utility-meter-reading.service';

export {
  parseMobileReadingDueIdParam,
  parseMobileReadingIdParam,
  parseMobileReadingLimitQuery,
  parseMobileUtilityMeterReadingBody,
} from './mobile-utility-meter-reading.validation';

export {
  MOBILE_FIELD_READING_SOURCE,
  MOBILE_FIELD_READING_TYPE,
  MOBILE_UTILITY_METER_READING_BODY_FIELDS,
  MOBILE_UTILITY_METER_READING_DERIVED_FIELDS,
  RECORD_MOBILE_UTILITY_METER_READING_OPERATION_KEY,
} from './mobile-utility-meter-reading.types';

export type {
  MobileUtilityMeterReading,
  MobileUtilityMeterReadingInput,
  MobileUtilityMeterReadingResult,
} from './mobile-utility-meter-reading.types';
