import { contextAccessService } from '../context-access';
import { permitApplicationRepository } from '../permit-applications/permit-application.repository';
import { permitApprovalRepository } from '../permit-approvals/permit-approval.repository';
import { listPermitEquipmentForPermit, resolveActivePermitEquipment } from '../permit-equipment/permit-equipment.service';
import { validatePermitEvidenceReadiness } from '../permit-evidence/permit-evidence.service';
import { resolvePermitSafetyReadiness } from '../permit-safety-requirements/permit-safety-requirement.service';
import { resolveCurrentPermitValidity } from '../permit-validities/permit-validity.service';
import { listPermitWorkersForPermit, resolveActivePermitWorkers } from '../permit-workers/permit-worker.service';
import { permitRepository } from '../permits/permit.repository';
import { permitWorkContextInvalidError } from './permit-work-lifecycle.errors';
import { permitWorkLifecycleRepository } from './permit-work-lifecycle.repository';
import type { PermitWorkStartReadiness } from './permit-work-lifecycle.types';

export type PermitWorkPrerequisites = Omit<PermitWorkStartReadiness, 'availableActions'>;

/** Resolves every backend-owned prerequisite used by Work Start authority. */
export async function resolvePermitWorkPrerequisites(
  permitId: string,
  actorUserId: string,
): Promise<PermitWorkPrerequisites> {
  const permit = await permitRepository.findById(permitId);
  if (!permit) throw permitWorkContextInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  const application = await permitApplicationRepository.findByPermitId(permit.id);
  if (!application) throw permitWorkContextInvalidError();
  const lifecycle = await permitWorkLifecycleRepository.findByPermitId(permit.id);
  const workStatus = permit.status === 'CANCELLED'
    ? 'CANCELLED'
    : lifecycle?.status ?? 'READY';

  const [approvals, validity, safety, configuredWorkers, activeWorkers,
    configuredEquipment, activeEquipment, evidence] = await Promise.all([
    permitApprovalRepository.listByApplication(application.id),
    resolveCurrentPermitValidity(permit.id, actorUserId),
    resolvePermitSafetyReadiness(permit.id, actorUserId),
    listPermitWorkersForPermit(permit.id, actorUserId),
    resolveActivePermitWorkers(permit.id, actorUserId),
    listPermitEquipmentForPermit(permit.id, actorUserId),
    resolveActivePermitEquipment(permit.id, actorUserId),
    validatePermitEvidenceReadiness(permit.id, actorUserId),
  ]);

  const approvalReady = approvals.length > 0 && approvals.every(
    (approval) => approval.reviewStatus === 'COMPLETED' &&
      approval.decision === 'APPROVED',
  );
  const validityStatus = validity.currentValidity?.status ?? null;
  const activeConfiguredWorkers = configuredWorkers.filter(
    (worker) => worker.status === 'ACTIVE',
  );
  const workerListReady = activeConfiguredWorkers.length > 0 &&
    activeWorkers.workerCount === activeConfiguredWorkers.length;
  const activeConfiguredEquipment = configuredEquipment.filter(
    (equipment) => equipment.status === 'ACTIVE',
  );
  const equipmentRequired = activeConfiguredEquipment.length > 0;
  const equipmentReady = !equipmentRequired ||
    activeEquipment.equipmentCount === activeConfiguredEquipment.length;

  const blockers: string[] = [];
  if (application.status !== 'SUBMITTED') blockers.push('APPLICATION_NOT_SUBMITTED');
  if (!approvalReady) blockers.push('APPROVAL_NOT_READY');
  if (validityStatus !== 'VALID') blockers.push(
    validityStatus === 'EXPIRED'
      ? 'PERMIT_EXPIRED'
      : validityStatus === 'REVOKED'
        ? 'PERMIT_REVOKED'
        : 'PERMIT_NOT_VALID',
  );
  if (!safety.ready) blockers.push('SAFETY_NOT_READY');
  if (!workerListReady) blockers.push('WORKER_LIST_NOT_READY');
  if (!equipmentReady) blockers.push('EQUIPMENT_NOT_READY');
  if (!evidence.ready) blockers.push('EVIDENCE_NOT_READY');
  if (permit.status === 'CANCELLED') blockers.push('PERMIT_CANCELLED');
  if (workStatus !== 'READY') blockers.push('WORK_ALREADY_TRANSITIONED');

  return {
    permitId: permit.id,
    permitApplicationId: application.id,
    permitReference: permit.permitNumber,
    buildingId: permit.buildingId,
    contractorContextType: permit.contractorContextType,
    contractorVendorId: permit.contractorVendorId,
    workStatus,
    ready: blockers.length === 0,
    approvalReady,
    validityStatus,
    safetyReady: safety.ready,
    safetyReadinessStatus: safety.readinessStatus,
    workerListReady,
    activeWorkerCount: activeWorkers.workerCount,
    configuredWorkerCount: activeConfiguredWorkers.length,
    equipmentRequired,
    equipmentReady,
    activeEquipmentCount: activeEquipment.equipmentCount,
    configuredEquipmentCount: activeConfiguredEquipment.length,
    evidenceConfigured: evidence.configured,
    evidenceReady: evidence.ready,
    blockers,
  };
}
