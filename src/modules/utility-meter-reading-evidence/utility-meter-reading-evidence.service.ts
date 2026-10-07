import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { utilityMeterNotFoundError } from '../utility-meters/utility-meter.errors';
import { utilityMeterRepository } from '../utility-meters/utility-meter.repository';
import { utilityMeterReadingNotFoundError } from '../utility-meter-readings/utility-meter-reading.errors';
import { utilityMeterReadingRepository } from '../utility-meter-readings/utility-meter-reading.repository';
import type { UtilityMeterReadingRecord } from '../utility-meter-readings/utility-meter-reading.types';
import {
  utilityMeterReadingEvidenceBuildingMismatchError,
  utilityMeterReadingEvidenceCountViolationError,
  utilityMeterReadingEvidenceNotFoundError,
  utilityMeterReadingEvidenceRequirementMismatchError,
} from './utility-meter-reading-evidence.errors';
import { utilityMeterReadingEvidenceRepository } from './utility-meter-reading-evidence.repository';
import type {
  PublicUtilityMeterReadingEvidence,
  PublicUtilityMeterReadingEvidenceRequirement,
  SubmitUtilityMeterReadingEvidenceInput,
  UtilityMeterReadingEvidenceFilters,
  UtilityMeterReadingEvidenceReadiness,
} from './utility-meter-reading-evidence.types';
import { applyRetentionToEvidence } from '../evidence-retention-policies/evidence-retention-application.service';

/**
 * BE-18F — Reading Evidence service.
 *
 * Binds a BE-18E Meter Reading to the existing BE-07 shared evidence engine.
 * There is deliberately NO utility evidence engine: requirements and
 * submissions are BE-07 rows (`target_type` / `execution_type` =
 * 'UTILITY_METER_READING'), and all file metadata, MIME rules, the 50 MB size
 * ceiling, the `file_reference` storage-pointer convention, and the
 * soft-remove rule stay in BE-07.
 *
 * Authorities reused, never re-derived:
 *   - the reading, its Client and its Building → BE-18E `utility_meter_readings`
 *   - the meter behind the reading             → BE-18A `utility_meters`
 *   - requirement / submission semantics       → BE-07 evidence engine
 *   - Building access                          → BE-02G context access
 *
 * Evidence history is preserved: removal is BE-07's soft `status → 'REMOVED'`,
 * never a DELETE, and the BE-18E reading itself remains append-only and
 * untouched by this module.
 *
 * Consumption (BE-18G) is out of scope.
 */

/** The same MIME rules as BE-07 / BE-08G / BE-15E. */
const ALLOWED_MIME: Record<string, readonly string[]> = {
  PHOTO: ['image/jpeg', 'image/png', 'image/webp'],
  DOCUMENT: ['application/pdf', 'image/jpeg', 'image/png'],
  SIGNATURE: ['image/png', 'image/svg+xml'],
};

type ResolvedReading = {
  id: string;
  clientId: string;
  buildingId: string;
  meterId: string;
};

/**
 * Loads a BE-18E reading and takes its Client / Building as authoritative.
 *
 * The reading's Building is cross-checked against its Meter: the two are
 * written together by BE-18E, so a divergence means the evidence would be
 * filed against a context that no longer holds, and it is refused rather than
 * silently trusted.
 */
async function resolveReading(meterReadingId: string): Promise<ResolvedReading> {
  const reading: UtilityMeterReadingRecord | null =
    await utilityMeterReadingRepository.findById(meterReadingId);
  if (!reading) {
    throw utilityMeterReadingNotFoundError();
  }

  const meter = await utilityMeterRepository.findById(reading.meterId);
  if (!meter) {
    throw utilityMeterNotFoundError();
  }
  if (meter.buildingId !== reading.buildingId) {
    throw utilityMeterReadingEvidenceBuildingMismatchError();
  }

  return {
    id: reading.id,
    clientId: reading.clientId,
    buildingId: reading.buildingId,
    meterId: reading.meterId,
  };
}

/** Resolves the ACTIVE BE-07 requirements bound to a Meter Reading. */
export async function resolveReadingEvidenceRequirements(
  meterReadingId: string,
  userId: string,
): Promise<PublicUtilityMeterReadingEvidenceRequirement[]> {
  const reading = await resolveReading(meterReadingId);
  await contextAccessService.assertBuildingAccess(userId, reading.buildingId);
  return utilityMeterReadingEvidenceRepository.listRequirementsForReading(
    reading.id,
  );
}

/**
 * Binds a PHOTO / DOCUMENT / SIGNATURE submission to a Meter Reading through
 * the BE-07 evidence engine.
 *
 * Validation order:
 *   1. unknown reading                  → 404 UTILITY_METER_READING_NOT_FOUND
 *   2. reading/meter building divergence → 400 ..._EVIDENCE_BUILDING_MISMATCH
 *   3. no Building access               → 403 BUILDING_ACCESS_DENIED
 *   4. unknown / foreign requirement    → 400 ..._EVIDENCE_REQUIREMENT_MISMATCH
 *   5. evidence type mismatch           → 400 ..._EVIDENCE_REQUIREMENT_MISMATCH
 *   6. requirement of another Client    → 400 ..._EVIDENCE_BUILDING_MISMATCH
 *   7. MIME mismatch                    → 400 ..._EVIDENCE_REQUIREMENT_MISMATCH
 *   8. max-count exceeded               → 400 ..._EVIDENCE_COUNT_VIOLATION
 */
export async function submitReadingEvidence(
  input: SubmitUtilityMeterReadingEvidenceInput,
): Promise<PublicUtilityMeterReadingEvidence> {
  const reading = await resolveReading(input.meterReadingId);
  await contextAccessService.assertBuildingAccess(
    input.submittedByUserId,
    reading.buildingId,
  );

  let requirement: PublicUtilityMeterReadingEvidenceRequirement | null = null;
  if (input.evidenceRequirementId !== undefined) {
    requirement =
      await utilityMeterReadingEvidenceRepository.findRequirementByIdForReading(
        reading.id,
        input.evidenceRequirementId,
      );
    // A requirement raised against a different reading is not "close enough":
    // accepting it would file the evidence under the wrong obligation.
    if (!requirement) {
      throw utilityMeterReadingEvidenceRequirementMismatchError();
    }
    if (requirement.evidenceType !== input.evidenceType) {
      throw utilityMeterReadingEvidenceRequirementMismatchError();
    }
    if (requirement.clientId !== reading.clientId) {
      throw utilityMeterReadingEvidenceBuildingMismatchError();
    }
  }

  const allowed = ALLOWED_MIME[input.evidenceType];
  if (!allowed || !allowed.includes(input.mimeType)) {
    throw utilityMeterReadingEvidenceRequirementMismatchError(
      'The submitted MIME type is not allowed for this evidence type.',
    );
  }

  if (requirement && requirement.maximumCount !== null) {
    const count =
      await utilityMeterReadingEvidenceRepository.countActiveSubmissionsForRequirement(
        requirement.id,
      );
    if (count >= requirement.maximumCount) {
      throw utilityMeterReadingEvidenceCountViolationError();
    }
  }

  const evidence =
    await utilityMeterReadingEvidenceRepository.createSubmission({
      ...input,
      clientId: reading.clientId,
    });

  // CR-BE-DOC-CONTROL-01 PART 03 — attach retention governance at creation.
  await applyRetentionToEvidence(String(evidence.id), input.submittedByUserId);

  await recordOperationalEvent({
    clientId: reading.clientId,
    eventType: 'UTILITY_METER_READING_EVIDENCE_ADDED',
    entityType: 'UTILITY_METER_READING',
    entityId: reading.id,
    actorUserId: input.submittedByUserId,
    buildingId: reading.buildingId,
    summary: `Meter reading evidence added (${input.evidenceType})`,
    metadata: {
      evidenceType: input.evidenceType,
      evidenceId: evidence.id,
      meterId: reading.meterId,
      evidenceRequirementId: evidence.evidenceRequirementId,
    },
  });

  return evidence;
}

/** Lists the ACTIVE evidence bound to a Meter Reading. */
export async function listReadingEvidence(
  meterReadingId: string,
  userId: string,
): Promise<PublicUtilityMeterReadingEvidence[]> {
  const reading = await resolveReading(meterReadingId);
  await contextAccessService.assertBuildingAccess(userId, reading.buildingId);
  return utilityMeterReadingEvidenceRepository.listSubmissionsForReading(
    reading.id,
  );
}

/**
 * Lists the full evidence history of a reading, REMOVED rows included, so a
 * soft-removed submission remains auditable.
 */
export async function listReadingEvidenceHistory(
  meterReadingId: string,
  userId: string,
): Promise<PublicUtilityMeterReadingEvidence[]> {
  const reading = await resolveReading(meterReadingId);
  await contextAccessService.assertBuildingAccess(userId, reading.buildingId);
  return utilityMeterReadingEvidenceRepository.listSubmissionHistoryForReading(
    reading.id,
  );
}

/** Fetches a single Reading Evidence submission. */
export async function getReadingEvidence(
  evidenceId: string,
  userId: string,
): Promise<PublicUtilityMeterReadingEvidence> {
  const existing =
    await utilityMeterReadingEvidenceRepository.findSubmissionById(evidenceId);
  if (!existing) {
    throw utilityMeterReadingEvidenceNotFoundError();
  }
  const reading = await resolveReading(existing.meterReadingId);
  await contextAccessService.assertBuildingAccess(userId, reading.buildingId);
  return existing;
}

/**
 * Lists evidence across the caller's accessible Buildings, narrowed by
 * reading / Meter / Building. A Meter + Building combination that contradicts
 * the meter's own Building is rejected rather than quietly returning nothing.
 */
export async function listReadingEvidenceByFilters(
  filters: UtilityMeterReadingEvidenceFilters,
  userId: string,
  accessibleBuildingIds: string[],
): Promise<PublicUtilityMeterReadingEvidence[]> {
  let effectiveFilters = filters;

  if (filters.meterReadingId) {
    const reading = await resolveReading(filters.meterReadingId);
    await contextAccessService.assertBuildingAccess(userId, reading.buildingId);
    effectiveFilters = { ...filters, buildingId: reading.buildingId };
  }

  if (effectiveFilters.meterId) {
    const meter = await utilityMeterRepository.findById(
      effectiveFilters.meterId,
    );
    if (!meter) {
      throw utilityMeterNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, meter.buildingId);
    if (
      effectiveFilters.buildingId &&
      effectiveFilters.buildingId !== meter.buildingId
    ) {
      throw utilityMeterReadingEvidenceBuildingMismatchError();
    }
  }

  const buildingIds =
    effectiveFilters.buildingId !== undefined
      ? [effectiveFilters.buildingId]
      : accessibleBuildingIds;

  if (buildingIds.length === 0) {
    return [];
  }

  return utilityMeterReadingEvidenceRepository.listSubmissions({
    ...(effectiveFilters.meterReadingId === undefined
      ? {}
      : { meterReadingId: effectiveFilters.meterReadingId }),
    ...(effectiveFilters.meterId === undefined
      ? {}
      : { meterId: effectiveFilters.meterId }),
    ...(effectiveFilters.buildingId === undefined
      ? {}
      : { buildingId: effectiveFilters.buildingId }),
    buildingIds,
  });
}

/**
 * Validates required evidence for a reading: for each ACTIVE BE-07
 * requirement, whether the ACTIVE submission count meets its minimum.
 *
 * This reports readiness; it never mutates the reading. BE-18E readings are
 * append-only and are not gated on evidence — a missing photo must not erase
 * a measurement that was genuinely taken.
 */
export async function validateReadingEvidence(
  meterReadingId: string,
  userId: string,
): Promise<UtilityMeterReadingEvidenceReadiness> {
  const reading = await resolveReading(meterReadingId);
  await contextAccessService.assertBuildingAccess(userId, reading.buildingId);

  const [requirements, submissions] = await Promise.all([
    utilityMeterReadingEvidenceRepository.listRequirementsForReading(reading.id),
    utilityMeterReadingEvidenceRepository.listSubmissionsForReading(reading.id),
  ]);

  const missingEvidenceTypes: string[] = [];
  const detail = requirements.map((requirement) => {
    const activeCount = submissions.filter(
      (submission) =>
        submission.evidenceRequirementId === requirement.id &&
        submission.status === 'ACTIVE',
    ).length;
    // Only a *required* requirement can make a reading not ready; an optional
    // one is tracked but never blocks.
    const satisfied = !requirement.required
      ? true
      : activeCount >= requirement.minimumCount;
    if (!satisfied) {
      missingEvidenceTypes.push(requirement.evidenceType);
    }
    return {
      evidenceRequirementId: requirement.id,
      evidenceType: requirement.evidenceType,
      required: requirement.required,
      minimumCount: requirement.minimumCount,
      maximumCount: requirement.maximumCount,
      activeCount,
      satisfied,
    };
  });

  return {
    meterReadingId: reading.id,
    ready: missingEvidenceTypes.length === 0,
    missingEvidenceTypes,
    requirements: detail,
  };
}

/**
 * Removes (soft-deactivates) a Reading Evidence submission following the
 * BE-07 rule (`status → 'REMOVED'`). The row is preserved, so evidence
 * history survives removal.
 */
export async function removeReadingEvidence(
  evidenceId: string,
  userId: string,
): Promise<PublicUtilityMeterReadingEvidence> {
  const existing =
    await utilityMeterReadingEvidenceRepository.findSubmissionById(evidenceId);
  if (!existing) {
    throw utilityMeterReadingEvidenceNotFoundError();
  }
  const reading = await resolveReading(existing.meterReadingId);
  await contextAccessService.assertBuildingAccess(userId, reading.buildingId);

  const removed =
    await utilityMeterReadingEvidenceRepository.removeSubmission(evidenceId);
  if (!removed) {
    throw utilityMeterReadingEvidenceNotFoundError();
  }

  await recordOperationalEvent({
    clientId: reading.clientId,
    eventType: 'UTILITY_METER_READING_EVIDENCE_REMOVED',
    entityType: 'UTILITY_METER_READING',
    entityId: reading.id,
    actorUserId: userId,
    buildingId: reading.buildingId,
    summary: 'Meter reading evidence removed',
    metadata: {
      evidenceType: removed.evidenceType,
      evidenceId: removed.id,
      meterId: reading.meterId,
    },
  });

  return removed;
}

export const utilityMeterReadingEvidenceService = {
  getReadingEvidence,
  listReadingEvidence,
  listReadingEvidenceByFilters,
  listReadingEvidenceHistory,
  removeReadingEvidence,
  resolveReadingEvidenceRequirements,
  submitReadingEvidence,
  validateReadingEvidence,
};
