import { AppError } from '../../shared/errors';
import { dailyCleaningRepository } from '../daily-cleaning';
import { housekeepingFindingRepository } from '../housekeeping-findings';
import { publicAreaInspectionRepository } from '../public-area-inspections';
import { supervisorInspectionRepository } from '../supervisor-inspections';
import { toiletInspectionRepository } from '../toilet-inspections';
import {
  housekeepingEvidenceClientMismatchError,
  housekeepingEvidenceCountViolationError,
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
  listEvidenceRequirements,
  listEvidenceSubmissions,
  resolveHousekeepingEvidenceSource,
  submitEvidence,
};
