import { AppError } from '../../shared/errors';
import { getAccessibleBuildingIds } from '../context-access';
import type {
  PermitWorkAuthority,
  PermitWorkAuthorityResolver,
} from '../permit-work-lifecycle/permit-work-lifecycle.authority';
import {
  closePermitWork,
  getPermitWorkStatus,
  resolvePermitWorkStartReadiness,
  startPermitWork,
} from '../permit-work-lifecycle/permit-work-lifecycle.service';
import type {
  PermitWorkAction,
  PermitWorkNotesInput,
  PermitWorkStartReadiness,
} from '../permit-work-lifecycle/permit-work-lifecycle.types';
import { resolvePermitWorkFieldAuthority } from './mobile-permit-work.authority';
import { mobilePermitWorkRepository } from './mobile-permit-work.repository';
import type {
  MobilePermitWorkFeedItem,
  MobilePermitWorkFeedRow,
  MobilePermitWorkFieldContext,
  MobilePermitWorkReadiness,
} from './mobile-permit-work.types';

/**
 * CR-BE-RN20-PERMIT-FIELD-01 — Work Permit Field Execution service.
 *
 * Everything that decides state lives in BE-20K and is CALLED, not copied:
 *   - status view        → `getPermitWorkStatus`
 *   - readiness/blockers → `resolvePermitWorkStartReadiness`
 *   - START transition   → `startPermitWork`  (same repository INSERT, same
 *                          409 / 400 rules, same PERMIT_WORK_STARTED event)
 *   - CLOSE transition   → `closePermitWork`  (same repository UPDATE, same
 *                          400 / 409 rules, same PERMIT_WORK_CLOSED event)
 * The only thing this module supplies to those functions is the FIELD
 * authority resolver, through the lifecycle's `PermitWorkAuthorityResolver`
 * seam. The management routes keep their default resolver and are untouched.
 */

const PERMIT_WORK_ACTION_ORDER: readonly PermitWorkAction[] = ['START', 'CLOSE'];

/** A resolver that returns one already-resolved authority (denial-first, resolve-once). */
const memoized = (authority: PermitWorkAuthority): PermitWorkAuthorityResolver =>
  async () => authority;

function toReadiness(readiness: PermitWorkStartReadiness): MobilePermitWorkReadiness {
  return {
    ready: readiness.ready,
    blockers: readiness.blockers,
    approvalReady: readiness.approvalReady,
    validityStatus: readiness.validityStatus,
    safetyReady: readiness.safetyReady,
    workerListReady: readiness.workerListReady,
    equipmentReady: readiness.equipmentReady,
    evidenceReady: readiness.evidenceReady,
  };
}

function toFeedItem(
  row: MobilePermitWorkFeedRow,
  availableActions: PermitWorkAction[],
): MobilePermitWorkFeedItem {
  return {
    permitId: row.permitId,
    permitApplicationId: row.permitApplicationId,
    permitReference: row.permitReference,
    buildingId: row.buildingId,
    title: row.title,
    workDescription: row.workDescription,
    status: row.status,
    validFrom: row.validFrom?.toISOString() ?? null,
    validUntil: row.validUntil?.toISOString() ?? null,
    availableActions,
  };
}

/**
 * Builds the field context from ONE resolved field authority. Both views are
 * produced by the existing BE-20K service functions, handed the memoized
 * authority so the field actor is asserted exactly once per request and the
 * `availableActions` inside `workStatus` and at the top level can never
 * disagree.
 */
async function buildFieldContext(
  permitId: string,
  actorUserId: string,
  authority: PermitWorkAuthority,
): Promise<MobilePermitWorkFieldContext> {
  const resolver = memoized(authority);
  const workStatus = await getPermitWorkStatus(permitId, actorUserId, resolver);
  const readiness = await resolvePermitWorkStartReadiness(
    permitId,
    actorUserId,
    resolver,
  );
  return {
    workStatus,
    readiness: toReadiness(readiness),
    availableActions: workStatus.availableActions,
  };
}

/**
 * GET /mobile/permit-work
 *
 * Every READY / IN_PROGRESS permit the caller is a field actor of, within the
 * caller's accessible Buildings (BE-02G, fail-closed). Each item's
 * `availableActions` comes from the SAME field authority resolver the context
 * and the commands use — the feed never derives an action of its own.
 *
 * The per-item resolution re-asserts the same facts the feed query selected
 * on; if a fact has changed in between (worker deactivated, Building access
 * revoked, permit cancelled), the item is no longer executable by this caller
 * and is omitted rather than shown with stale authority.
 */
export async function listMobilePermitWork(
  actorUserId: string,
): Promise<MobilePermitWorkFeedItem[]> {
  const accessibleBuildingIds = await getAccessibleBuildingIds(actorUserId);
  const rows = await mobilePermitWorkRepository.listFieldFeed(
    actorUserId,
    accessibleBuildingIds,
  );
  const items: MobilePermitWorkFeedItem[] = [];
  for (const row of rows) {
    let authority: PermitWorkAuthority;
    try {
      authority = await resolvePermitWorkFieldAuthority(row.permitId, actorUserId);
    } catch (error) {
      if (error instanceof AppError) continue;
      throw error;
    }
    items.push(toFeedItem(row, PERMIT_WORK_ACTION_ORDER.filter(authority.isAllowed)));
  }
  return items;
}

/** GET /mobile/permit-work/:permitId — field-authorized canonical state. */
export async function getMobilePermitWorkFieldContext(
  permitId: string,
  actorUserId: string,
): Promise<MobilePermitWorkFieldContext> {
  const authority = await resolvePermitWorkFieldAuthority(permitId, actorUserId);
  return buildFieldContext(permitId, actorUserId, authority);
}

/**
 * POST /mobile/permit-work/:permitId/start
 *
 * Field authority is asserted FIRST (a non-field-actor is 403 before any
 * lifecycle fact is disclosed), then the existing BE-20K `startPermitWork`
 * runs with that authority: its 409 `PERMIT_WORK_ALREADY_STARTED` /
 * `PERMIT_WORK_ALREADY_CLOSED`, 400 `PERMIT_WORK_NOT_READY` (with the full
 * blocker list) and 403 `PERMIT_WORK_ACTION_NOT_ALLOWED` rules apply
 * unchanged. The response is the fresh field context — canonical state after
 * the transition, never the client's assumption of it.
 */
export async function startMobilePermitWork(
  permitId: string,
  input: PermitWorkNotesInput,
  actorUserId: string,
): Promise<MobilePermitWorkFieldContext> {
  const authority = await resolvePermitWorkFieldAuthority(permitId, actorUserId);
  await startPermitWork(permitId, input, actorUserId, memoized(authority));
  return getMobilePermitWorkFieldContext(permitId, actorUserId);
}

/**
 * POST /mobile/permit-work/:permitId/close
 *
 * Same shape as START: field authority first, then the existing BE-20K
 * `closePermitWork` with its 400 `PERMIT_WORK_CLOSE_BEFORE_START`, 409
 * `PERMIT_WORK_ALREADY_CLOSED` and IN_PROGRESS → CLOSED rule unchanged, then
 * the fresh field context.
 */
export async function closeMobilePermitWork(
  permitId: string,
  input: PermitWorkNotesInput,
  actorUserId: string,
): Promise<MobilePermitWorkFieldContext> {
  const authority = await resolvePermitWorkFieldAuthority(permitId, actorUserId);
  await closePermitWork(permitId, input, actorUserId, memoized(authority));
  return getMobilePermitWorkFieldContext(permitId, actorUserId);
}

export const mobilePermitWorkService = {
  closeMobilePermitWork,
  getMobilePermitWorkFieldContext,
  listMobilePermitWork,
  startMobilePermitWork,
};
