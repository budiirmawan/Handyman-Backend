import { AppError } from '../../shared/errors';
import { dailyCleaningRepository } from '../daily-cleaning';
import { housekeepingFindingRepository } from '../housekeeping-findings';
import { publicAreaInspectionRepository } from '../public-area-inspections';
import { supervisorInspectionRepository } from '../supervisor-inspections';
import { toiletInspectionRepository } from '../toilet-inspections';
import {
  housekeepingEvidenceClientMismatchError,
  housekeepingEvidenceCountViolationError,
  housekeepingEvidenceFieldUnauthorizedError,
  housekeepingEvidenceSourceNotFoundError,
  housekeepingEvidenceSourceTerminalError,
  housekeepingEvidenceTypeMismatchError,
} from './housekeeping-evidence.errors';
import { housekeepingEvidenceRepository } from './housekeeping-evidence.repository';
import type {
  HousekeepingEvidenceSourceType,
  PublicHousekeepingEvidenceRequirement,
  PublicHousekeepingEvidenceSubmission,
  SubmitHousekeepingEvidenceInput,
} from './housekeeping-evidence.types';
import { applyRetentionToEvidence } from '../evidence-retention-policies/evidence-retention-application.service';
import { isBoundTaskExecutableByUser } from '../mobile-task-authority';

export type ResolvedEvidenceSource = {
  clientId: string;
  buildingId: string;
  targetType: string;
  targetId: string;
  executionType: string;
  executionId: string;
  status: string;
};

export async function resolveHousekeepingEvidenceSource(
  sourceType: HousekeepingEvidenceSourceType,
  sourceId: string,
): Promise<ResolvedEvidenceSource> {
  if (sourceType === 'daily-cleaning') {
    const task = await dailyCleaningRepository.findById(sourceId);
    if (!task) {
      throw housekeepingEvidenceSourceNotFoundError();
    }
    if (task.status === 'CANCELLED') {
      throw housekeepingEvidenceSourceTerminalError();
    }
    return {
      clientId: task.client_id,
      buildingId: task.building_id,
      targetType: task.target_type,
      targetId: task.target_id,
      executionType: 'CHECKLIST_EXECUTION',
      executionId: task.task_id,
      status: task.status,
    };
  }

  if (sourceType === 'toilet-inspections') {
    const context = await toiletInspectionRepository.findExecutionContext(
      sourceId,
    );
    if (!context) {
      throw housekeepingEvidenceSourceNotFoundError();
    }
    if (context.execution_status === 'CANCELLED') {
      throw housekeepingEvidenceSourceTerminalError();
    }
    return {
      clientId: context.client_id,
      buildingId: context.building_id,
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: context.checklist_template_id,
      executionType: 'CHECKLIST_EXECUTION',
      executionId: context.execution_id,
      status: context.execution_status,
    };
  }

  if (sourceType === 'public-area-inspections') {
    const context =
      await publicAreaInspectionRepository.findExecutionContext(sourceId);
    if (!context) {
      throw housekeepingEvidenceSourceNotFoundError();
    }
    if (context.execution_status === 'CANCELLED') {
      throw housekeepingEvidenceSourceTerminalError();
    }
    return {
      clientId: context.client_id,
      buildingId: context.building_id,
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: context.checklist_template_id,
      executionType: 'CHECKLIST_EXECUTION',
      executionId: context.execution_id,
      status: context.execution_status,
    };
  }

  if (sourceType === 'supervisor-inspections') {
    const inspection = await supervisorInspectionRepository.findById(sourceId);
    if (!inspection) {
      throw housekeepingEvidenceSourceNotFoundError();
    }
    return {
      clientId: inspection.clientId,
      buildingId: inspection.buildingId,
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: inspection.targetId,
      executionType: 'CHECKLIST_EXECUTION',
      executionId: inspection.targetId,
      status: inspection.status,
    };
  }

  if (sourceType === 'findings') {
    const finding = await housekeepingFindingRepository.findById(sourceId);
    if (!finding) {
      throw housekeepingEvidenceSourceNotFoundError();
    }
    return {
      clientId: finding.client_id,
      buildingId: finding.building_id,
      targetType: 'CHECKLIST_TEMPLATE',
      targetId: finding.source_id,
      executionType: 'CHECKLIST_EXECUTION',
      executionId: finding.source_id,
      status: finding.finding_status,
    };
  }

  throw housekeepingEvidenceSourceNotFoundError();
}

/**
 * CR-BE-RN13-CLEANING-FIELD-01 PART 02 — the smallest field-authority seam that
 * makes the EXISTING BE-11I evidence engine safely usable by the assigned field
 * actor of a canonical cleaning execution.
 *
 * Scope is deliberately one source type. Only `daily-cleaning` is the RN-13
 * cleaning execution; toilet / public-area / supervisor inspections and
 * findings keep their existing authority untouched (supervisor inspection and
 * quality score are out of RN-13 entirely).
 *
 * What this adds, and only this: proof that the caller is the actor the work is
 * assigned to. Everything else was already enforced and is NOT duplicated:
 *   - task exists and is a canonical cleaning task — `resolveHousekeepingEvidenceSource`
 *     resolves `daily-cleaning` through `dailyCleaningRepository.findById`, whose
 *     query INNER JOINs `cleaning_schedule_bindings` (status = 'ACTIVE') and
 *     `cleaning_areas` (status = 'ACTIVE'). A task with no ACTIVE cleaning
 *     binding resolves to nothing and 404s, so a non-cleaning task can never
 *     masquerade as a daily-cleaning evidence parent.
 *   - Building isolation (BE-02G) — the controller already calls
 *     `assertBuildingAccess` on the resolved source Building.
 *
 * REUSE, NEVER DUPLICATE. Actor executability is delegated verbatim to
 * `isBoundTaskExecutableByUser`, the same rule the mobile checklist / form
 * execution commands and the BE-18 reading-due field gate use. Its semantics
 * are inherited unchanged and not re-implemented:
 *   - no ACTIVE assignment            → not executable
 *   - WORKFORCE assigned to another   → not executable
 *   - WORKFORCE assigned to this      → executable
 *   - TEAM-only assignment to the     → executable
 *     caller's team
 *   - any ACTIVE WORKFORCE assignment → TEAM ignored
 *   - inactive / missing profile      → not executable
 * That rule contains NO role-name check and none is added here.
 *
 * Applied to evidence SUBMISSION only. Submission records `submittedByUserId`,
 * so attributing a cleaning execution's evidence to someone who was never
 * assigned it is a data-integrity fault. Reads are intentionally left on the
 * existing read permission + Building scope so supervisor and BE-11M reporting
 * access is not regressed.
 *
 * No new route, no new uploader and no new evidence table: this is the same
 * `POST /housekeeping/daily-cleaning/{taskId}/evidence` engine.
 */
export async function assertDailyCleaningEvidenceFieldActor(
  sourceType: HousekeepingEvidenceSourceType,
  source: ResolvedEvidenceSource,
  actorUserId: string,
): Promise<void> {
  if (sourceType !== 'daily-cleaning') {
    return;
  }

  // `executionId` for daily-cleaning is `generated_tasks.id` (see
  // resolveHousekeepingEvidenceSource), which is exactly the canonical RN-13
  // field execution id `reference.taskId`.
  const executable = await isBoundTaskExecutableByUser(
    source.executionId,
    actorUserId,
  );
  if (!executable) {
    throw housekeepingEvidenceFieldUnauthorizedError();
  }
}

export async function listEvidenceRequirements(
  sourceType: HousekeepingEvidenceSourceType,
  sourceId: string,
): Promise<PublicHousekeepingEvidenceRequirement[]> {
  const source = await resolveHousekeepingEvidenceSource(sourceType, sourceId);
  return housekeepingEvidenceRepository.findRequirements(
    source.targetType,
    source.targetId,
  );
}

export async function listEvidenceSubmissions(
  sourceType: HousekeepingEvidenceSourceType,
  sourceId: string,
): Promise<PublicHousekeepingEvidenceSubmission[]> {
  const source = await resolveHousekeepingEvidenceSource(sourceType, sourceId);
  return housekeepingEvidenceRepository.listSubmissions(
    source.executionType,
    source.executionId,
  );
}

export async function submitEvidence(
  input: SubmitHousekeepingEvidenceInput,
): Promise<PublicHousekeepingEvidenceSubmission> {
  const source = await resolveHousekeepingEvidenceSource(
    input.sourceType,
    input.sourceId,
  );

  let requirementId: string | null = null;
  if (input.evidenceRequirementId) {
    const req = await housekeepingEvidenceRepository.findRequirementById(
      input.evidenceRequirementId,
    );
    if (!req) {
      throw AppError.badRequest('Evidence requirement does not exist.');
    }
    if (req.status !== 'ACTIVE') {
      throw AppError.badRequest('Evidence requirement is inactive.');
    }
    if (req.client_id !== source.clientId) {
      throw housekeepingEvidenceClientMismatchError();
    }
    if (req.evidence_type !== input.evidenceType) {
      throw housekeepingEvidenceTypeMismatchError();
    }

    if (req.maximum_count !== null) {
      const activeCount =
        await housekeepingEvidenceRepository.countActiveSubmissions(req.id);
      if (activeCount >= req.maximum_count) {
        throw housekeepingEvidenceCountViolationError();
      }
    }
    requirementId = req.id;
  }

  const created = await housekeepingEvidenceRepository.createSubmission({
    clientId: source.clientId,
    evidenceRequirementId: requirementId,
    executionType: source.executionType,
    executionId: source.executionId,
    evidenceType: input.evidenceType,
    fileReference: input.fileReference,
    originalFileName: input.originalFileName,
    mimeType: input.mimeType,
    fileSize: input.fileSize,
    capturedAt: input.capturedAt,
    submittedByUserId: input.submittedByUserId,
  });
  // CR-BE-DOC-CONTROL-01 PART 03 — attach retention governance at creation.
  await applyRetentionToEvidence(String(created.id), input.submittedByUserId);
  return created;
}

export const housekeepingEvidenceService = {
  assertDailyCleaningEvidenceFieldActor,
  listEvidenceRequirements,
  listEvidenceSubmissions,
  resolveHousekeepingEvidenceSource,
  submitEvidence,
};
