import { getPool } from '../../database';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { getTaskPublic } from '../task-execution/task-execution.service';
import { loadChecklistExecutionRow } from '../checklist-executions/checklist-execution.service';
import { loadEvidenceExecution } from '../evidence/evidence.service';
import { loadTaskAssignmentTask } from '../task-assignments/task-assignment.service';
import { patrolExecutionService } from '../patrol-executions/patrol-execution.service';
import { meterReadingBindingService } from '../meter-reading-bindings/meter-reading-binding.service';
import { getMobileUtilityMeterContext } from '../mobile-utility-meter-context/mobile-utility-meter-context.service';
import type { MobileSyncRequestItem } from './mobile-sync.types';
import type {
  MobileSyncConflict,
  MobileSyncConflictGuidance,
} from './mobile-sync-conflict.types';

/**
 * BE-25I — Sync conflict detection.
 *
 * Detects stale client updates by comparing the client-provided
 * `baseVersion` (the resource's `updatedAt` the client last saw) with the
 * CURRENT authoritative `updatedAt` of the resource. The comparison uses the
 * existing resource version/timestamp patterns (`updated_at` on every
 * synced resource) — no new version engine.
 *
 * The current server state/reference is returned with the conflict so the
 * client can reload and re-apply (the backend never merges automatically).
 *
 * IMPORTANT: conflicts are only detected for operations that carry
 * `baseVersion`. Operations without one behave exactly as before (the
 * existing endpoint semantics apply); the backend remains authoritative in
 * both cases.
 */

type UpdatedAtRow = { updated_at: Date };

const RELOAD_ENDPOINTS: Record<MobileSyncRequestItem['resourceType'], string> = {
  TASK_EXECUTION: '/tasks/{taskId}',
  CHECKLIST_RESPONSES: '/mobile/checklist-executions/{executionId}',
  EVIDENCE_SUBMISSION: '/evidence/{evidenceId}',
  TASK_ASSIGNMENT: '/tasks/{taskId}/assignments',
  // PART 06 — reload targets are the published read operations.
  PATROL_EXECUTION: '/security/patrol-executions/{executionId}',
  PATROL_POINT_VISIT: '/security/patrol-executions/{executionId}/points',
  METER_READING: '/engineering/meter-reading-executions/{executionId}',
  // CR-BE-RN12-METER-FIELD-01 PART 03 — the BE-18 field execution read.
  UTILITY_METER_READING: '/mobile/utility-reading-dues/{readingDueId}/meter-context',
};

/**
 * Loads the CURRENT authoritative state of the operation's resource and
 * enforces the BE-02G scope (identical to the shared write services).
 * Returns null when the resource does not exist (the write path will then
 * fail with the usual NOT_FOUND, which is not a conflict).
 */
export async function loadCurrentResourceState(
  operation: MobileSyncRequestItem,
  userId: string,
): Promise<{ current: unknown; updatedAt: string } | null> {
  switch (operation.resourceType) {
    case 'TASK_EXECUTION': {
      // STRAND-ADJ-01 FIX-01 — a conflict probe READS the task another device
      // last wrote, so it carries the same BE-02G scope the shared write service
      // (`executeTaskAction`) and every other case here already enforce. The
      // access decision is taken FIRST, on the authoritative row, by the one
      // existing scoped loader; the public view below is only reachable once
      // that has passed, so a refusal can never carry a `current` payload and a
      // stale baseVersion is not a cross-Client read primitive.
      // Unknown id → NOT_FOUND 'Task not found.'; actor without Building/Client
      // access → BUILDING_ACCESS_DENIED. The dispatcher maps either to a
      // per-item FAILED result (mobile-sync.service.ts, BE-25I).
      await loadTaskAssignmentTask(operation.resourceId, userId);
      const task = await getTaskPublic(operation.resourceId);
      return {
        current: task,
        updatedAt: task.updatedAt,
      };
    }
    case 'CHECKLIST_RESPONSES': {
      const execution = await loadChecklistExecutionRow(
        operation.resourceId,
        userId,
      );
      return {
        current: {
          id: execution.id,
          clientId: execution.client_id,
          checklistTemplateId: execution.checklist_template_id,
          status: execution.status,
          startedAt: execution.started_at?.toISOString() ?? null,
          completedAt: execution.completed_at?.toISOString() ?? null,
          createdAt: execution.created_at.toISOString(),
          updatedAt: execution.updated_at.toISOString(),
        },
        updatedAt: execution.updated_at.toISOString(),
      };
    }
    case 'EVIDENCE_SUBMISSION': {
      // The evidence resource is the submission the client is creating;
      // there is no existing row to conflict with (a replay is handled by
      // BE-25H idempotency). No conflict is possible.
      return null;
    }
    case 'PATROL_EXECUTION': {
      // The patrol execution IS a BE-07 generated task, so its authoritative
      // version is that task's `updated_at`. The public view is loaded through
      // the scoped service, which asserts BE-02G Building access.
      const result = await getPool().query<UpdatedAtRow>(
        'SELECT updated_at FROM generated_tasks WHERE id = $1',
        [operation.resourceId],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      const execution = await patrolExecutionService.getPatrolExecutionById(
        operation.resourceId,
        userId,
      );
      return { current: execution, updatedAt: row.updated_at.toISOString() };
    }
    case 'PATROL_POINT_VISIT': {
      // A checkpoint visit is a create against the execution; there is no
      // prior row to conflict with (a replay is handled by BE-25H
      // idempotency, and the service rejects a terminal execution).
      return null;
    }
    case 'METER_READING': {
      // The synced resource is the BE-07 form instance carrying the reading.
      const result = await getPool().query<UpdatedAtRow>(
        'SELECT updated_at FROM form_instances WHERE id = $1',
        [operation.resourceId],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      const context = await meterReadingBindingService.resolveMeterReadingContext(
        operation.resourceId,
        userId,
      );
      return { current: context, updatedAt: row.updated_at.toISOString() };
    }
    case 'UTILITY_METER_READING': {
      // CR-BE-RN12-METER-FIELD-01 PART 03 — the synced resource is the BE-18
      // Reading Due, i.e. the field execution the reading is recorded against,
      // so the authoritative version is that due's `updated_at`: it moves when
      // the due is completed by another device, re-pointed, or cancelled. The
      // current state is loaded through PART 00's published scoped read, which
      // asserts the SAME field authority the write does, so a stale baseVersion
      // is not a cross-Building read primitive. An unknown due → null (the write
      // path produces the canonical 404); a caller without field authority →
      // the seam's own refusal, mapped to a per-item FAILED result.
      const result = await getPool().query<UpdatedAtRow>(
        'SELECT updated_at FROM utility_reading_dues WHERE id = $1',
        [operation.resourceId],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      const current = await getMobileUtilityMeterContext(
        operation.resourceId,
        userId,
      );
      return { current, updatedAt: row.updated_at.toISOString() };
    }
    case 'TASK_ASSIGNMENT': {
      const task = await loadTaskAssignmentTask(operation.resourceId, userId);
      const assignment = await getPool().query<UpdatedAtRow>(
        'SELECT updated_at FROM task_assignments WHERE id = $1 AND task_id = $2',
        [operation.data?.assignmentId, operation.resourceId],
      );
      if (!assignment.rowCount) {
        return null;
      }
      return {
        current: {
          taskId: task.id,
          assignmentId: operation.data?.assignmentId,
          assignmentUpdatedAt: assignment.rows[0].updated_at.toISOString(),
        },
        updatedAt: assignment.rows[0].updated_at.toISOString(),
      };
    }
  }
}

function buildGuidance(
  operation: MobileSyncRequestItem,
): MobileSyncConflictGuidance {
  const reloadEndpoint = RELOAD_ENDPOINTS[operation.resourceType].replace(
    '{taskId}',
    operation.resourceId,
  ).replace('{executionId}', operation.resourceId).replace(
    // CR-BE-RN12-METER-FIELD-01 PART 03 — the BE-18 kind is addressed by its
    // own authoritative resource name rather than borrowing a placeholder.
    '{readingDueId}',
    operation.resourceId,
  );
  return {
    action: 'reload',
    reloadEndpoint,
    message:
      'The resource changed on the server since the client last saw it. Reload the current state and re-apply the change.',
  };
}

/**
 * Detects a stale client update. Returns a conflict payload when the
 * client's `baseVersion` is older than the current server `updatedAt`
 * (exact equality or a newer base means no conflict). When `baseVersion` is
 * absent, no conflict is detected (BE-25G behavior preserved).
 */
export async function detectConflict(
  operation: MobileSyncRequestItem,
  userId: string,
): Promise<MobileSyncConflict | null> {
  const baseVersion = operation.data?.baseVersion;
  if (typeof baseVersion !== 'string') {
    return null;
  }

  const current = await loadCurrentResourceState(operation, userId);
  if (!current) {
    // No existing resource: nothing to conflict with (the write path
    // produces the usual NOT_FOUND).
    return null;
  }

  const baseTime = Date.parse(baseVersion);
  if (Number.isNaN(baseTime)) {
    // An invalid baseVersion is a client contract violation — treated as a
    // conflict so the client reloads instead of writing blind.
    return {
      code: 'SYNC_CONFLICT' as const,
      message: 'baseVersion must be a valid ISO-8601 timestamp of the last seen server state.',
      current: current.current,
      guidance: buildGuidance(operation),
    };
  }

  const serverTime = Date.parse(current.updatedAt);
  if (baseTime < serverTime) {
    // Stale client update: never silently overwrite newer server data.
    return {
      code: 'SYNC_CONFLICT' as const,
      message:
        'The client state is stale (baseVersion is older than the current server version).',
      current: current.current,
      guidance: buildGuidance(operation),
    };
  }

  return null;
}
