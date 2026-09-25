import { contextAccessService } from '../context-access';
import { permissionService } from '../permissions';
import { permitApplicationRepository } from '../permit-applications/permit-application.repository';
import { permitRepository } from '../permits/permit.repository';
import type { PermitWorkAuthority } from '../permit-work-lifecycle/permit-work-lifecycle.authority';
import { permitWorkContextInvalidError } from '../permit-work-lifecycle/permit-work-lifecycle.errors';
import { permitWorkLifecycleRepository } from '../permit-work-lifecycle/permit-work-lifecycle.repository';
import type { PermitWorkStatus } from '../permit-work-lifecycle/permit-work-lifecycle.types';
import { resolvePermitWorkPrerequisites } from '../permit-work-lifecycle/permit-work-readiness.service';
import { permitWorkFieldUnauthorizedError } from './mobile-permit-work.errors';
import { mobilePermitWorkRepository } from './mobile-permit-work.repository';
import { PERMIT_WORK_FIELD_EXECUTE_PERMISSION } from './mobile-permit-work.types';

/**
 * CR-BE-RN20-PERMIT-FIELD-01 — the FIELD authority resolver.
 *
 * Same shape as the BE-20K management resolver (`resolvePermitWorkAuthority`)
 * so the existing lifecycle service consumes it unchanged through its
 * `PermitWorkAuthorityResolver` seam. What differs is WHO is authorized:
 *
 *   management: `permit.read` + `permit.manage` + Building access
 *   field:      `permit_work_field.execute` + ACTIVE Permit Worker chain
 *               resolving to the caller + Building access + Permit not CANCELLED
 *
 * What does NOT differ — and is therefore never re-derived here — is the
 * state rule and the readiness rule:
 *
 *   START ⇔ status READY  ∧ resolvePermitWorkPrerequisites(...).ready === true
 *   CLOSE ⇔ status IN_PROGRESS
 *
 * `resolvePermitWorkPrerequisites` is the SAME function the management route
 * uses, so every existing blocker (APPLICATION_NOT_SUBMITTED, APPROVAL_NOT_READY,
 * PERMIT_NOT_VALID / PERMIT_EXPIRED / PERMIT_REVOKED, SAFETY_NOT_READY,
 * WORKER_LIST_NOT_READY, EQUIPMENT_NOT_READY, EVIDENCE_NOT_READY,
 * PERMIT_CANCELLED, WORK_ALREADY_TRANSITIONED) applies verbatim to the field
 * START. No HOLD, RESUME or CANCEL action exists on either resolver.
 *
 * Denials fail closed in this order:
 *   400 PERMIT_WORK_CONTEXT_INVALID   unknown permit / permit without application
 *   403 BUILDING_ACCESS_DENIED        BE-02G — the permit's Building is not accessible
 *   403 PERMIT_WORK_FIELD_UNAUTHORIZED no ACTIVE worker chain → caller, or Permit CANCELLED
 *
 * A missing `permit_work_field.execute` is NOT a denial of this resolver: the
 * caller may still READ (feed / context, gated by `permit_work_field.read` at
 * the route) and simply receives `availableActions: []`. The command routes
 * additionally require the execute permission up front.
 *
 * No current-shift gate: RN-20 does not require the caller to be on shift, and
 * this resolver consults no shift, roster or role data.
 */
export async function resolvePermitWorkFieldAuthority(
  permitId: string,
  actorUserId: string,
): Promise<PermitWorkAuthority> {
  const permit = await permitRepository.findById(permitId);
  if (!permit) throw permitWorkContextInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  const application = await permitApplicationRepository.findByPermitId(permit.id);
  if (!application) throw permitWorkContextInvalidError();

  const isFieldActor = await mobilePermitWorkRepository.isFieldActor(
    application.id,
    actorUserId,
  );
  if (!isFieldActor || permit.status === 'CANCELLED') {
    throw permitWorkFieldUnauthorizedError();
  }

  const lifecycle = await permitWorkLifecycleRepository.findByPermitId(permit.id);
  // Permit is proven non-CANCELLED above, so status is the lifecycle's own
  // (or READY when no lifecycle row exists) — the BE-20K derivation.
  const status: PermitWorkStatus = lifecycle?.status ?? 'READY';

  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  const canExecute = permissions.has(PERMIT_WORK_FIELD_EXECUTE_PERMISSION);

  const readiness = status === 'READY'
    ? await resolvePermitWorkPrerequisites(permit.id, actorUserId)
    : null;

  return {
    permitId: permit.id,
    status,
    readiness,
    isAllowed: (action) =>
      canExecute &&
      ((action === 'START' && status === 'READY' && readiness?.ready === true) ||
        (action === 'CLOSE' && status === 'IN_PROGRESS')),
  };
}
