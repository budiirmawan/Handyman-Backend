import { getPool } from '../../database';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { recordOperationalEvent } from '../operational-events';
import { buildingUtilityReconciliationRepository } from '../building-utility-reconciliations';
import { utilityAbnormalConsumptionRepository } from '../utility-abnormal-consumptions';
import { utilityMeterConsumptionRepository } from '../utility-meter-consumptions';
import { utilityMeterReadingRepository } from '../utility-meter-readings';
import { utilityMeterRepository, type UtilityType } from '../utility-meters';
import { utilityOcrCandidateRepository } from '../utility-ocr-candidates';
import { utilityReadingDueRepository } from '../utility-reading-dues';
import {
  utilityExceptionDuplicateError,
  utilityExceptionNotFoundError,
  utilityExceptionReferenceInvalidError,
  utilityExceptionTransitionError,
} from './utility-operational-exception.errors';
import { utilityOperationalExceptionRepository as repository } from './utility-operational-exception.repository';
import type {
  CreateUtilityOperationalExceptionInput,
  PublicUtilityOperationalException,
  ResolvedUtilityExceptionContext,
  UtilityExceptionExecutor,
  UtilityExceptionFilters,
  UtilityExceptionReadingReread,
  UtilityOperationalExceptionRecord,
  ResolveUtilityExceptionOptions,
  StartUtilityExceptionReviewOptions,
} from './utility-operational-exception.types';

type Context = { clientId: string; buildingId: string; utilityType: UtilityType; meterId?: string | null };
const toPublic = (record: UtilityOperationalExceptionRecord): PublicUtilityOperationalException => ({
  ...record,
  detectedAt: record.detectedAt.toISOString(),
  reviewStartedAt: record.reviewStartedAt?.toISOString() ?? null,
  resolvedAt: record.resolvedAt?.toISOString() ?? null,
  cancelledAt: record.cancelledAt?.toISOString() ?? null,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
  // CR-BE-RN12-METER-FIELD-01 PART 03 — the recheck payload, converted once
  // here (NUMERIC arrives as text) and null for every non-recheck exception.
  proposedReadingValue:
    record.proposedReadingValue === null ? null : Number(record.proposedReadingValue),
  proposedReadingAt: record.proposedReadingAt?.toISOString() ?? null,
});
function same(left: Context, right: Context) {
  return left.clientId === right.clientId && left.buildingId === right.buildingId &&
    left.utilityType === right.utilityType &&
    (!left.meterId || !right.meterId || left.meterId === right.meterId);
}
async function meterContext(id: string): Promise<Context> {
  const meter = await utilityMeterRepository.findById(id);
  if (!meter) throw utilityExceptionReferenceInvalidError('Referenced Utility Meter does not exist.');
  return { clientId: meter.clientId, buildingId: meter.buildingId,
    utilityType: meter.utilityType, meterId: meter.id };
}
async function resolveContext(input: CreateUtilityOperationalExceptionInput): Promise<ResolvedUtilityExceptionContext> {
  const contexts: Context[] = [];
  let meterId = input.meterId ?? null;
  if (input.meterId) contexts.push(await meterContext(input.meterId));
  if (input.meterReadingId) {
    const reading = await utilityMeterReadingRepository.findById(input.meterReadingId);
    if (!reading) throw utilityExceptionReferenceInvalidError('Referenced Meter Reading does not exist.');
    const context = await meterContext(reading.meterId);
    if (context.clientId !== reading.clientId || context.buildingId !== reading.buildingId) throw utilityExceptionReferenceInvalidError();
    contexts.push(context); meterId ??= reading.meterId;
  }
  if (input.readingDueId) {
    const due = await utilityReadingDueRepository.findById(input.readingDueId);
    if (!due) throw utilityExceptionReferenceInvalidError('Referenced Reading Due does not exist.');
    contexts.push({ clientId: due.clientId, buildingId: due.buildingId,
      utilityType: due.utilityType, meterId: due.meterId }); meterId ??= due.meterId;
  }
  if (input.consumptionId) {
    const consumption = await utilityMeterConsumptionRepository.findById(input.consumptionId);
    if (!consumption) throw utilityExceptionReferenceInvalidError('Referenced Consumption does not exist.');
    const context = await meterContext(consumption.meterId);
    if (context.clientId !== consumption.clientId || context.buildingId !== consumption.buildingId) throw utilityExceptionReferenceInvalidError();
    contexts.push(context); meterId ??= consumption.meterId;
  }
  if (input.abnormalConsumptionId) {
    const abnormal = await utilityAbnormalConsumptionRepository.findById(input.abnormalConsumptionId);
    if (!abnormal) throw utilityExceptionReferenceInvalidError('Referenced abnormal consumption does not exist.');
    contexts.push({ clientId: abnormal.clientId, buildingId: abnormal.buildingId,
      utilityType: abnormal.utilityType, meterId: abnormal.meterId }); meterId ??= abnormal.meterId;
  }
  if (input.ocrCandidateId) {
    const candidate = await utilityOcrCandidateRepository.findById(input.ocrCandidateId);
    if (!candidate) throw utilityExceptionReferenceInvalidError('Referenced OCR candidate does not exist.');
    const context = await meterContext(candidate.meterId);
    if (context.clientId !== candidate.clientId || context.buildingId !== candidate.buildingId) throw utilityExceptionReferenceInvalidError();
    contexts.push(context); meterId ??= candidate.meterId;
  }
  if (input.reconciliationId) {
    const reconciliation = await buildingUtilityReconciliationRepository.findById(input.reconciliationId);
    if (!reconciliation) throw utilityExceptionReferenceInvalidError('Referenced reconciliation does not exist.');
    contexts.push({ clientId: reconciliation.clientId,
      buildingId: reconciliation.buildingId, utilityType: reconciliation.utilityType });
  }
  const first = contexts[0];
  if (!first || contexts.some((context) => !same(first, context))) throw utilityExceptionReferenceInvalidError();
  return {
    clientId: first.clientId, buildingId: first.buildingId,
    utilityType: first.utilityType, meterId,
    meterReadingId: input.meterReadingId ?? null,
    readingDueId: input.readingDueId ?? null,
    consumptionId: input.consumptionId ?? null,
    abnormalConsumptionId: input.abnormalConsumptionId ?? null,
    ocrCandidateId: input.ocrCandidateId ?? null,
    reconciliationId: input.reconciliationId ?? null,
  };
}
function isDuplicate(error: unknown) {
  const candidate = error as { code?: string; constraint?: string };
  return candidate?.code === '23505' && candidate.constraint === 'utility_exception_active_source_unique';
}
export async function createUtilityOperationalException(input: CreateUtilityOperationalExceptionInput, actorUserId: string) {
  const context = await resolveContext(input);
  await contextAccessService.assertBuildingAccess(actorUserId, context.buildingId);
  try {
    const record = await repository.create({ ...input, ...context, detectedByUserId: actorUserId });
    await audit(record, actorUserId, 'UTILITY_EXCEPTION_CREATED', 'Utility operational exception opened');
    return toPublic(record);
  } catch (error) {
    if (isDuplicate(error)) throw utilityExceptionDuplicateError();
    throw error;
  }
}
async function accessible(id: string, actorUserId: string) {
  const record = await repository.findById(id);
  if (!record) throw utilityExceptionNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return record;
}
export async function getUtilityOperationalException(id: string, actorUserId: string) {
  return toPublic(await accessible(id, actorUserId));
}
export async function listUtilityOperationalExceptions(filters: UtilityExceptionFilters, actorUserId: string) {
  if (filters.buildingId) await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  if (filters.clientId && !(await contextAccessService.canAccessClient(actorUserId, filters.clientId))) throw buildingAccessDeniedError();
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(actorUserId);
  return (await repository.list(filters, buildingIds)).map(toPublic);
}
/**
 * OPEN → UNDER_REVIEW.
 *
 * CR-BE-RN12-METER-FIELD-01 PART 03 adds one OPTIONAL `options.executor`, so a
 * caller that owns a transaction can perform this transition and a following
 * resolve atomically. The guard, the stamps and the canonical
 * `UTILITY_EXCEPTION_REVIEW_STARTED` event are unchanged, and every existing
 * caller — which omits the argument — behaves exactly as before.
 */
export async function startUtilityExceptionReview(
  id: string,
  notes: string | null,
  actorUserId: string,
  options?: StartUtilityExceptionReviewOptions,
) {
  await accessible(id, actorUserId);
  const record = await repository.startReview(
    id,
    actorUserId,
    notes,
    options?.executor ?? getPool(),
  );
  if (!record) throw utilityExceptionTransitionError();
  await audit(
    record,
    actorUserId,
    'UTILITY_EXCEPTION_REVIEW_STARTED',
    'Utility exception review started',
    options?.executor,
  );
  return toPublic(record);
}
/**
 * CR-BE-RN12-METER-FIELD-01 PART 03 — stage a field reread against an OPEN (or
 * already reviewing) `READING_RECHECK`.
 *
 * This is the register's OWN OPEN → UNDER_REVIEW transition with the recheck
 * payload written by the same guarded statement, so no second lifecycle path and
 * no new state exists. It is a separate function — not an extra argument on
 * `startUtilityExceptionReview` — so that generic transition keeps its exact SQL
 * and meaning for every other exception type.
 *
 * A re-stage while the review is open is permitted deliberately: it is the field
 * analogue of retrying an online submit whose value the canonical BE-18E rules
 * would refuse (decimal precision, meter + instant duplicate). Without it a
 * technician could strand their own recheck and need a management cancellation
 * to correct a typo. Reviewer stamps are kept from the first transition.
 */
export async function stageUtilityExceptionReadingReread(
  id: string,
  reread: UtilityExceptionReadingReread,
  actorUserId: string,
) {
  const existing = await accessible(id, actorUserId);
  const record = await repository.stageReadingReread(id, actorUserId, reread);
  if (!record) throw utilityExceptionTransitionError();
  await audit(
    record,
    actorUserId,
    'UTILITY_EXCEPTION_REVIEW_STARTED',
    existing.status === 'OPEN'
      ? 'Utility exception review started'
      : 'Utility exception reread re-staged during review',
  );
  return toPublic(record);
}
/**
 * UNDER_REVIEW → RESOLVED.
 *
 * CR-BE-RN12-METER-FIELD-01 PART 03 adds one OPTIONAL argument: the replacement
 * reading an accepted reread became, plus the executor of the transaction that
 * created it. The transition guard, the resolution stamps and the canonical
 * event are unchanged; `replacementMeterReadingId` is written by the same
 * guarded UPDATE, so a replacement can only ever be linked by a resolve that
 * succeeded, and — because the caller's transaction owns both writes — a
 * replacement reading can never commit without the row that makes it auditable.
 * Every existing caller omits it and resolves on the pool exactly as before.
 */
export async function resolveUtilityException(
  id: string,
  notes: string,
  actorUserId: string,
  options?: ResolveUtilityExceptionOptions,
) {
  await accessible(id, actorUserId);
  const record = await repository.resolve(
    id,
    actorUserId,
    notes,
    options?.replacementMeterReadingId ?? null,
    options?.executor ?? getPool(),
  );
  if (!record) throw utilityExceptionTransitionError();
  await audit(record, actorUserId, 'UTILITY_EXCEPTION_RESOLVED', 'Utility exception resolved', options?.executor);
  return toPublic(record);
}
export async function cancelUtilityException(id: string, reason: string, actorUserId: string) {
  await accessible(id, actorUserId);
  const record = await repository.cancel(id, actorUserId, reason);
  if (!record) throw utilityExceptionTransitionError();
  await audit(record, actorUserId, 'UTILITY_EXCEPTION_CANCELLED', 'Utility exception cancelled');
  return toPublic(record);
}
async function audit(
  record: UtilityOperationalExceptionRecord,
  actorUserId: string,
  eventType: string,
  summary: string,
  executor?: UtilityExceptionExecutor,
) {
  await recordOperationalEvent({ clientId: record.clientId, buildingId: record.buildingId,
    eventType, entityType: 'UTILITY_OPERATIONAL_EXCEPTION', entityId: record.id,
    actorUserId, summary, metadata: { exceptionType: record.exceptionType,
      severity: record.severity, status: record.status, meterId: record.meterId,
      reconciliationId: record.reconciliationId,
      // PART 03 — the original and its accepted replacement, so the correction
      // is auditable from the event stream too (null for every other exception).
      meterReadingId: record.meterReadingId,
      replacementMeterReadingId: record.replacementMeterReadingId } },
    executor);
}
export const utilityOperationalExceptionService = {
  cancelUtilityException, createUtilityOperationalException,
  getUtilityOperationalException, listUtilityOperationalExceptions,
  resolveUtilityException, stageUtilityExceptionReadingReread,
  startUtilityExceptionReview,
};
