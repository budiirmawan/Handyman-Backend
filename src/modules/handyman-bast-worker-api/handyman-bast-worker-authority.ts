import type { HandymanBastRecord } from '../handyman-bast';
import {
  handymanBastNotAuthorizedError,
  handymanBastNotFoundError,
  handymanBastVersionConflictError,
  nextHandymanBastStatus,
  computeBastArtifactVersion,
  handymanBastRepository,
} from '../handyman-bast';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { handymanExecutionScopeNotFoundError } from '../handyman-quotations';
import {
  handymanScopeAssignmentRepository,
  resolveHandymanAssignmentLead,
} from '../handyman-scope-assignments';

/**
 * CR-HM-BAST-HTTP-01 — worker BAST transport authority preamble.
 *
 * The worker lane is gated by ALL of the following (never a persona name,
 * never a generic login, never the permission alone):
 *
 *   1. an authenticated local session (`req.auth.userId` is the ONLY actor
 *      identity — no caller-supplied actor field exists on the transport);
 *   2. the dedicated `handyman.bast.manage` capability (route middleware),
 *      registered by migration 0446 and granted to NO role by default;
 *   3. exact BE-02G Building access to the authoritative server-derived
 *      execution-scope Building (same wall the PART 01 service enforces
 *      inside its transaction — no same-Client sibling shortcut);
 *   4. the CURRENT authoritative Crew Lead binding for the execution scope
 *      (`resolveHandymanAssignmentLead` — scope → ACTIVE assignment → crew →
 *      current CR-HM-04 Lead). This is the Provider/Operations assignment:
 *      a reassignment moves the lane to the new Lead, and no admin role,
 *      Operations title or frontend label can stand in for it.
 *
 * Lifecycle state, QC-PASS admission, idempotency and audit remain the sole
 * authority of the frozen CR-HM-11 PART 01 service (`prepareHandymanBast`,
 * `issueHandymanBast`, `voidHandymanBast`) — this module never mutates.
 */

/** Dedicated capability gating the worker BAST command transport. */
export const HANDYMAN_BAST_MANAGE_PERMISSION = 'handyman.bast.manage';

export type WorkerBastLaneScope = {
  id: string;
  clientId: string;
  buildingId: string;
};

export type WorkerBastAction = 'ISSUE' | 'VOID';

/**
 * Resolves + authorizes the worker lane for one execution scope.
 * 404 on unknown scope, 403 BUILDING_ACCESS_DENIED without exact Building
 * access, 403 HANDYMAN_BAST_NOT_AUTHORIZED when the actor is not the
 * CURRENT Crew Lead.
 */
export async function loadWorkerBastLaneScope(
  executionScopeId: string,
  actorUserId: string,
): Promise<WorkerBastLaneScope> {
  const scope = await handymanScopeAssignmentRepository.findScopeById(
    undefined,
    executionScopeId,
  );
  if (!scope) {
    throw handymanExecutionScopeNotFoundError();
  }
  // BE-02G: exact Building wall on the server-derived scope Building.
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  });
  const resolution = await resolveHandymanAssignmentLead(
    executionScopeId,
    actorUserId,
  );
  if (!resolution || resolution.leadUserId !== actorUserId) {
    throw handymanBastNotAuthorizedError();
  }
  return { id: scope.id, clientId: scope.clientId, buildingId: scope.buildingId };
}

/**
 * Resolves + authorizes the worker lane for one BAST document.
 * 404 on unknown BAST, then the scope-level wall (Building + CURRENT Lead)
 * on the authoritative scope derived from the document itself.
 */
export async function loadWorkerBastLaneBast(
  bastId: string,
  actorUserId: string,
): Promise<HandymanBastRecord> {
  const bast = await handymanBastRepository.findBastById(undefined, bastId);
  if (!bast) {
    throw handymanBastNotFoundError();
  }
  await loadWorkerBastLaneScope(bast.executionScopeId, actorUserId);
  return bast;
}

/**
 * CR-HM-BAST-HTTP-01 — transport-level optimistic concurrency guard.
 *
 * `expectedVersion` is the artifact version the client last observed
 * (`artifact.version` in every read/command payload: DRAFT → 1, ISSUED → 2,
 * ACCEPTED/REJECTED → 3, VOID → 2). When supplied AND the current status is
 * still a legal from-state for the action, a mismatch is a 409
 * HANDYMAN_BAST_VERSION_CONFLICT before any mutation. When the status is no
 * longer a legal from-state this guard stays silent so the frozen state
 * machine decides: an idempotent replay (same key) still returns 200 with the
 * original event, anything else is 409 HANDYMAN_BAST_ILLEGAL_TRANSITION.
 * Legality is derived from `nextHandymanBastStatus` itself — the frozen
 * transition table is never duplicated.
 */
export function assertWorkerBastExpectedVersion(
  bast: HandymanBastRecord,
  action: WorkerBastAction,
  expectedVersion: number | null | undefined,
): void {
  if (expectedVersion === undefined || expectedVersion === null) {
    return;
  }
  let legalFromState = true;
  try {
    nextHandymanBastStatus(bast.status, action);
  } catch {
    legalFromState = false;
  }
  if (!legalFromState) {
    return;
  }
  const actualVersion = computeBastArtifactVersion(bast.status);
  if (actualVersion !== expectedVersion) {
    throw handymanBastVersionConflictError(expectedVersion, actualVersion);
  }
}

/**
 * Worker-lane available actions, derived solely from the frozen lifecycle
 * (no separate transition table): what a CURRENT Lead may still do to this
 * document. Customer ACCEPT/REJECT stays on the Customer Care lane.
 */
export function computeWorkerBastAvailableActions(
  status: HandymanBastRecord['status'],
): WorkerBastAction[] {
  const actions: WorkerBastAction[] = [];
  for (const action of ['ISSUE', 'VOID'] as const) {
    try {
      nextHandymanBastStatus(status, action);
      actions.push(action);
    } catch {
      // Not a legal transition from this status — omit.
    }
  }
  return actions;
}
