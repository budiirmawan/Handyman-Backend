import { Router } from 'express';
import { authenticationMiddleware } from '../auth/authentication.middleware';
import { requirePermission } from '../auth/rbac.middleware';
import { getMobileUtilityMeterReadingLifecycleDetailHandler } from '../mobile-utility-meter-reading-lifecycle/mobile-utility-meter-reading-lifecycle.controller';
import {
  listMobileUtilityMeterReadingsHandler,
  recordMobileUtilityMeterReadingHandler,
} from './mobile-utility-meter-reading.controller';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 01 — mobile field meter readings.
 *
 *   POST /mobile/utility-reading-dues/:readingDueId/readings
 *       utility_meter.field.record   (Idempotency-Key REQUIRED)
 *   GET  /mobile/utility-reading-dues/:readingDueId/readings
 *       utility_meter.field.read
 *   GET  /mobile/utility-reading-dues/:readingDueId/readings/:readingId
 *       utility_meter.field.read
 *
 * ROUTE SHAPE
 * -----------
 * Extends the PART 00 identity rather than introducing a second one: the same
 * `/mobile/utility-reading-dues/:readingDueId/...` prefix, addressed by the FIELD
 * EXECUTION (the Reading Due) and never by a bare meter id. Several OPEN dues may
 * coexist for one meter, so a meter id alone cannot say which execution the actor
 * is standing in. This is also why the management BE-18 routes
 * (`POST /utility/meters/:id/readings`) are NOT re-exposed as the mobile contract:
 * they are addressed by meter, gated on `utility_meter.manage`, and carry no
 * field-execution correlation at all.
 *
 * THREE GATES ON EVERY ROUTE
 * --------------------------
 *   1. `authenticationMiddleware` — an authenticated session.
 *   2. `requirePermission(...)` — the DEDICATED field code. Writing is
 *      `utility_meter.field.record`, reading is `utility_meter.field.read`.
 *      Neither is `utility_meter.manage`, `utility_meter.read` or
 *      `meter_reading_binding.manage`: administering meter master data, seeing
 *      meters on a dashboard, and administering BE-10C engineering bindings are
 *      all different authorities from standing in front of a meter. No role name
 *      is consulted anywhere in this chain.
 *   3. `assertUtilityMeterFieldActor(readingDueId, actorUserId)` in the service —
 *      the PART 00 seam proving the actor is an assigned executor of THIS due's
 *      generated task, plus BE-02G Building access. Gate 3 runs before the
 *      idempotency claim, so it is revalidated on every attempt including
 *      same-key replays, and a foreign id can never poison a key.
 *
 * IDEMPOTENCY
 * -----------
 * The POST requires an `Idempotency-Key` header, parsed by the generic
 * CR-BE-IDEMPOTENCY-CORE-01 foundation (trim, reject CR/LF/NUL, max 200 chars,
 * 400 `IDEMPOTENCY_KEY_REQUIRED` when missing or blank). Identity is
 * actorUserId + the server-defined operation key
 * `recordMobileUtilityMeterReading` + SHA-256(normalized key); equivalence is
 * SHA-256 of the canonical semantic fingerprint `{readingDueId, readingValue,
 * readingAt, notes}`. Same actor/op/key/fingerprint replays the stored 201 with
 * no second write; same actor/op/key with a different fingerprint is 409
 * `IDEMPOTENCY_CONFLICT`; a different actor is an independent namespace. The raw
 * key is never stored, logged or returned.
 *
 * WHAT THIS ROUTE SURFACE IS NOT
 * ------------------------------
 * No evidence, no OCR candidate, no abnormality evaluation, no recheck or
 * correction, no `availableActions`, no QR resolution, no mobile-sync resource
 * kind, and no consumption / delta / billing calculation. BE-25H `METER_READING`
 * and `meterReadingBindingService` (BE-10C) are untouched: a field reading
 * recorded here is an ordinary canonical BE-18E reading, not an engineering
 * execution result.
 */
export function createMobileUtilityMeterReadingRouter(): Router {
  const router = Router();

  router.post(
    '/mobile/utility-reading-dues/:readingDueId/readings',
    authenticationMiddleware,
    requirePermission('utility_meter.field.record'),
    recordMobileUtilityMeterReadingHandler,
  );

  router.get(
    '/mobile/utility-reading-dues/:readingDueId/readings',
    authenticationMiddleware,
    requirePermission('utility_meter.field.read'),
    listMobileUtilityMeterReadingsHandler,
  );

  // CR-BE-RN12-METER-FIELD-01 PART 02 / PART 03 — the DETAIL is extended, never
  // replaced. The path, its `utility_meter.field.read` gate and PART 01's
  // authority chain are unchanged; the handler is PART 03's, which returns PART
  // 02's detail — PART 01's bounded reading DTO plus the four additive
  // verification projections (`evidenceValidation`, `evidenceSummary`,
  // `ocrCandidates`, `abnormalSignals`) — plus PART 03's two additive lifecycle
  // keys (`rechecks`, `availableActions`). PART 03 delegates to PART 02's
  // function, which delegates to PART 01's, so the authority chain runs exactly
  // once and in exactly the pinned order. Registered HERE rather than in a later
  // PART's router so this path has exactly one registration and no duplicate can
  // shadow it. The LIST route above deliberately stays on the lightweight PART 01
  // DTO: neither PART 02 nor PART 03 enrichment is projected into a list.
  router.get(
    '/mobile/utility-reading-dues/:readingDueId/readings/:readingId',
    authenticationMiddleware,
    requirePermission('utility_meter.field.read'),
    getMobileUtilityMeterReadingLifecycleDetailHandler,
  );

  return router;
}
