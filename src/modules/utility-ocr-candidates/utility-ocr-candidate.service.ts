import { getPool } from '../../database';
import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { utilityMeterReadingEvidenceRepository } from '../utility-meter-reading-evidence/utility-meter-reading-evidence.repository';
import { utilityMeterRepository } from '../utility-meters';
import {
  recordUtilityMeterReading,
  utilityMeterReadingRepository,
} from '../utility-meter-readings';
import { completeUtilityReadingDue } from '../utility-reading-dues/utility-reading-due.service';
import {
  utilityOcrCandidateDuplicateError,
  utilityOcrCandidateNotFoundError,
  utilityOcrDecisionFinalError,
  utilityOcrEvidenceInvalidError,
  utilityOcrReadingMismatchError,
} from './utility-ocr-candidate.errors';
import { utilityOcrCandidateRepository as repository } from './utility-ocr-candidate.repository';
import type {
  AcceptUtilityOcrCandidateInput,
  CreateUtilityOcrCandidateInput,
  PublicUtilityOcrCandidate,
  UtilityOcrCandidateRecord,
} from './utility-ocr-candidate.types';

const toPublic = (record: UtilityOcrCandidateRecord): PublicUtilityOcrCandidate => ({
  ...record,
  candidateReadingValue: Number(record.candidateReadingValue),
  confidence: record.confidence === null ? null : Number(record.confidence),
  verifiedAt: record.verifiedAt?.toISOString() ?? null,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});
async function evidenceContext(evidenceId: string) {
  const evidence = await utilityMeterReadingEvidenceRepository.findSubmissionById(evidenceId);
  if (!evidence || evidence.status !== 'ACTIVE' || evidence.evidenceType !== 'PHOTO') {
    throw utilityOcrEvidenceInvalidError();
  }
  const reading = await utilityMeterReadingRepository.findById(evidence.meterReadingId);
  if (!reading) throw utilityOcrEvidenceInvalidError();
  const meter = await utilityMeterRepository.findById(reading.meterId);
  if (!meter || meter.clientId !== reading.clientId || meter.buildingId !== reading.buildingId) {
    throw utilityOcrEvidenceInvalidError();
  }
  return { evidence, reading, meter };
}
export async function createUtilityOcrCandidate(
  input: CreateUtilityOcrCandidateInput,
  userId: string,
) {
  const context = await evidenceContext(input.evidenceId);
  await contextAccessService.assertBuildingAccess(userId, context.reading.buildingId);
  try {
    const record = await repository.create({
      clientId: context.reading.clientId,
      buildingId: context.reading.buildingId,
      meterId: context.reading.meterId,
      evidenceId: input.evidenceId,
      candidateReadingValue: input.candidateReadingValue,
      confidence: input.confidence ?? null,
      createdByUserId: userId,
    });
    await recordOperationalEvent({
      clientId: record.clientId,
      buildingId: record.buildingId,
      eventType: 'UTILITY_OCR_CANDIDATE_CREATED',
      entityType: 'UTILITY_OCR_CANDIDATE',
      entityId: record.id,
      actorUserId: userId,
      summary: 'Utility PHOTO OCR candidate staged for human review',
      metadata: { evidenceId: record.evidenceId, meterId: record.meterId },
    });
    return toPublic(record);
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') throw utilityOcrCandidateDuplicateError();
    throw error;
  }
}
async function accessible(id: string, userId: string) {
  const record = await repository.findById(id);
  if (!record) throw utilityOcrCandidateNotFoundError();
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return record;
}
export async function getUtilityOcrCandidate(id: string, userId: string) {
  return toPublic(await accessible(id, userId));
}

/**
 * Serializes acceptance per candidate with a PostgreSQL advisory lock. This
 * prevents two concurrent accepts from creating two authoritative readings
 * before the terminal candidate decision is stored. A retry at the same
 * instant reuses the already-created equal-value reading.
 */
export async function acceptUtilityOcrCandidate(
  id: string,
  input: AcceptUtilityOcrCandidateInput,
  userId: string,
) {
  const lockClient = await getPool().connect();
  await lockClient.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [id]);
  try {
    const candidate = await accessible(id, userId);
    if (candidate.status !== 'PENDING_REVIEW') throw utilityOcrDecisionFinalError();
    const evidence = await evidenceContext(candidate.evidenceId);

    let reading: { id: string; meterId: string; buildingId: string; readingValue: number };
    if (input.readingAt) {
      const existing = await utilityMeterReadingRepository.findByMeterAndInstant(
        candidate.meterId,
        input.readingAt,
      );
      if (existing) {
        reading = {
          id: existing.id,
          meterId: existing.meterId,
          buildingId: existing.buildingId,
          readingValue: Number(existing.readingValue),
        };
      } else {
        const created = await recordUtilityMeterReading({
          meterId: candidate.meterId,
          readingValue: Number(candidate.candidateReadingValue),
          readingAt: input.readingAt,
          recordedByUserId: userId,
          source: 'MANUAL',
          readingType: 'ACTUAL',
          notes: input.notes ?? `Accepted OCR candidate ${candidate.id}`,
        }, userId);
        reading = created;
      }
    } else {
      const readingId = input.meterReadingId ?? evidence.reading.id;
      const existing = await utilityMeterReadingRepository.findById(readingId);
      if (!existing) throw utilityOcrReadingMismatchError();
      reading = {
        id: existing.id,
        meterId: existing.meterId,
        buildingId: existing.buildingId,
        readingValue: Number(existing.readingValue),
      };
    }
    if (
      reading.meterId !== candidate.meterId ||
      reading.buildingId !== candidate.buildingId ||
      reading.readingValue !== Number(candidate.candidateReadingValue)
    ) throw utilityOcrReadingMismatchError();

    // Complete through the Reading Due service before making the OCR decision
    // terminal. If the Due was concurrently cancelled, acceptance remains
    // pending and can be retried without creating a duplicate reading.
    if (input.readingDueId) {
      await completeUtilityReadingDue(input.readingDueId, reading.id, userId);
    }
    const decided = await repository.decide(
      id, 'ACCEPTED', userId, reading.id, input.notes ?? null,
    );
    if (!decided) throw utilityOcrDecisionFinalError();
    await recordOperationalEvent({
      clientId: decided.clientId,
      buildingId: decided.buildingId,
      eventType: 'UTILITY_OCR_CANDIDATE_ACCEPTED',
      entityType: 'UTILITY_OCR_CANDIDATE',
      entityId: decided.id,
      actorUserId: userId,
      summary: 'Human accepted Utility PHOTO OCR candidate',
      metadata: {
        evidenceId: decided.evidenceId,
        meterId: decided.meterId,
        meterReadingId: reading.id,
      },
    });
    return toPublic(decided);
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [id])
      .catch(() => undefined);
    lockClient.release();
  }
}
export async function rejectUtilityOcrCandidate(id: string, notes: string, userId: string) {
  const lockClient = await getPool().connect();
  await lockClient.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [id]);
  try {
    const candidate = await accessible(id, userId);
    if (candidate.status !== 'PENDING_REVIEW') throw utilityOcrDecisionFinalError();
    const decided = await repository.decide(id, 'REJECTED', userId, null, notes);
    if (!decided) throw utilityOcrDecisionFinalError();
    await recordOperationalEvent({
      clientId: decided.clientId,
      buildingId: decided.buildingId,
      eventType: 'UTILITY_OCR_CANDIDATE_REJECTED',
      entityType: 'UTILITY_OCR_CANDIDATE',
      entityId: decided.id,
      actorUserId: userId,
      summary: 'Human rejected Utility PHOTO OCR candidate',
      metadata: { evidenceId: decided.evidenceId, meterId: decided.meterId },
    });
    return toPublic(decided);
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [id])
      .catch(() => undefined);
    lockClient.release();
  }
}
export const utilityOcrCandidateService = {
  acceptUtilityOcrCandidate,
  createUtilityOcrCandidate,
  getUtilityOcrCandidate,
  rejectUtilityOcrCandidate,
};
