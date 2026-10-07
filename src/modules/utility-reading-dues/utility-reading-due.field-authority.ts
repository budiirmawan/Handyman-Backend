import { getPool } from '../../database';
import { contextAccessService } from '../context-access';
import { isBoundTaskExecutableByUser } from '../mobile-task-authority';
import {
  utilityMeterNotFoundError,
  utilityMeterRepository,
} from '../utility-meters';
import type { UtilityMeterRecord } from '../utility-meters';
import {
  utilityReadingDueFieldTaskMismatchError,
  utilityReadingDueFieldUnauthorizedError,
  utilityReadingDueNoFieldTaskError,
  utilityReadingDueNotFoundError,
} from './utility-reading-due.errors';
import { utilityReadingDueRepository } from './utility-reading-due.repository';
import type { UtilityReadingDueRecord } from './utility-reading-due.types';

/**
 * CR-BE-RN12-METER-FIELD-01 PART 00 — Utility Meter FIELD-ACTOR authority seam.
 *
 * "Is this authenticated actor currently authorized to perform field work on
 * the Meter behind this Reading Due?"
 *
 * WHY THIS SEAM EXISTS
 * --------------------
 * BE-18 is the authoritative utility-meter domain, and every one of its
 * existing routes is management-facing (`utility_meter.read` /
 * `utility_meter.manage`). Those permissions are flat RBAC grants: they say a
 * role may administer meters, never that a particular technician is the person
 * standing in front of a particular meter right now. Building access
 * (`context-access`) is weaker still — it says the actor may operate somewhere
 * in the Building, not that this measurement was issued to them.
 *
 * RN-12 needs a technician to identify a BE-18 Meter and prove field authority
 * over it. The repository ALREADY contains exactly that chain, so this seam
 * composes it instead of inventing a second authority:
 *
 *   utility_reading_dues.id
 *     → .meter_id            (NOT NULL → utility_meters)   exactly one Meter
 *     → .generated_task_id   (UNIQUE → generated_tasks)    at most one task
 *       → task_assignments   (status = 'ACTIVE')           WORKFORCE / TEAM
 *         → workforce_profiles.user_id                     the actor
 *
 * Cardinality, proven against the schema (0281 / 0077 / 0078):
 *   - a due identifies EXACTLY ONE meter (`meter_id` NOT NULL);
 *   - a due carries AT MOST ONE generated task, and a task belongs to AT MOST
 *     ONE due (`utility_reading_due_task_unique UNIQUE (generated_task_id)`),
 *     so task → due → meter is recoverable canonically in both directions;
 *   - `generated_tasks.target_type` / `.target_id` independently name the Meter
 *     (`'UTILITY_METER'` + meter id), which `createUtilityReadingDue` already
 *     validates on write;
 *   - several OPEN dues for one meter CAN coexist (the unique key is
 *     `(meter_id, period_start, period_end)`), which is why the field execution
 *     identity is the DUE id — never a bare meter id. The due id is
 *     unambiguous; a meter id is not.
 *
 * REUSE, NEVER DUPLICATE
 * ----------------------
 * Actor executability is delegated verbatim to `isBoundTaskExecutableByUser`
 * (MOB-C04 / MOB-C07 / R06 PART 02), the same rule `mobile-checklist` and
 * `mobile-form-instances` already gate on. Its semantics are therefore
 * inherited unchanged and are NOT re-implemented here:
 *   - no ACTIVE assignment              → not executable
 *   - WORKFORCE assigned to another     → not executable
 *     profile
 *   - WORKFORCE assigned to this        → executable
 *     profile
 *   - TEAM-only assignment to the       → executable
 *     caller's team
 *   - any ACTIVE WORKFORCE assignment   → TEAM is ignored (the work is held by
 *     a specific profile)
 *   - inactive / missing workforce      → not executable
 *     profile
 * That rule contains NO role-name check, and none is added here: authorization
 * is derived from assignment data, never from a role called TECHNICIAN,
 * ENGINEER or SUPERVISOR.
 *
 * This mirrors the CR-BE-RN11-MATERIAL-FIELD-01 PART 01 precedent exactly,
 * where `assertWorkOrderFieldActor` reused the BE-08F execution gate rather
 * than granting material writes through `work_order.manage`.
 *
 * SCOPE OF PART 00
 * ----------------
 * Identity and authority only. This seam authorizes NO command: not a reading
 * submission, not evidence, not OCR, not a recheck. It is a read-side gate that
 * later PARTs will compose with their own command semantics.
 */

export type UtilityMeterFieldActorContext = {
  /** The authoritative BE-18 reading due (field execution identity). */
  due: UtilityReadingDueRecord;
  /** The authoritative BE-18A meter the due was issued for. */
  meter: UtilityMeterRecord;
  /** The generated task the actor's assignment authority was proven against. */
  generatedTaskId: string;
};

type GeneratedTaskTargetRow = {
  target_type: string;
  target_id: string;
  client_id: string;
  building_id: string | null;
};

/**
 * Proves the actor is field-authorized for the Meter behind a Reading Due.
 *
 * Validation order (pinned by tests):
 *   1. unknown Reading Due                     → 404 UTILITY_READING_DUE_NOT_FOUND
 *   2. due has no generated task               → 403 UTILITY_READING_DUE_NO_FIELD_TASK
 *   3. actor not the task assignee             → 403 UTILITY_READING_DUE_FIELD_UNAUTHORIZED
 *   4. task no longer targets meter/building/  → 403 UTILITY_READING_DUE_FIELD_TASK_MISMATCH
 *      client
 *   5. actor has no access to the Building     → 403 BUILDING_ACCESS_DENIED
 *   6. meter row missing (FK-defensive)        → 404 UTILITY_METER_NOT_FOUND
 *
 * Step 2 is the load-bearing one. A due without a generated task has no
 * assignment to check, and the ONLY alternatives would be `utility_meter.manage`,
 * a role name, or Building access — all three are explicitly rejected as field
 * authority. Such a due remains fully reachable through the existing management
 * routes; it is simply not field-accessible.
 *
 * Step 4 re-asserts on read the invariant `createUtilityReadingDue` asserts on
 * write, so a task re-pointed after issuance cannot be used to reach a Meter it
 * was never issued for.
 *
 * Step 5 keeps BE-02G Building isolation as an additional gate, never as the
 * primary one: assignment first, Building second.
 */
export async function assertUtilityMeterFieldActor(
  readingDueId: string,
  actorUserId: string,
): Promise<UtilityMeterFieldActorContext> {
  const due = await utilityReadingDueRepository.findById(readingDueId);
  if (!due) {
    throw utilityReadingDueNotFoundError();
  }

  if (due.generatedTaskId === null) {
    throw utilityReadingDueNoFieldTaskError();
  }

  const executable = await isBoundTaskExecutableByUser(
    due.generatedTaskId,
    actorUserId,
  );
  if (!executable) {
    throw utilityReadingDueFieldUnauthorizedError();
  }

  const taskResult = await getPool().query<GeneratedTaskTargetRow>(
    `SELECT target_type, target_id, client_id, building_id
       FROM generated_tasks
      WHERE id = $1`,
    [due.generatedTaskId],
  );
  const task = taskResult.rows[0];
  if (
    !task ||
    task.target_type !== 'UTILITY_METER' ||
    task.target_id !== due.meterId ||
    task.client_id !== due.clientId ||
    task.building_id !== due.buildingId
  ) {
    throw utilityReadingDueFieldTaskMismatchError();
  }

  await contextAccessService.assertBuildingAccess(actorUserId, due.buildingId);

  const meter = await utilityMeterRepository.findById(due.meterId);
  if (!meter) {
    throw utilityMeterNotFoundError();
  }

  return { due, meter, generatedTaskId: due.generatedTaskId };
}

export const utilityMeterFieldAuthority = {
  assertUtilityMeterFieldActor,
};
