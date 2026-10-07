/**
 * BE-25G / BE-25H / BE-25I — Offline Sync Contract types.
 *
 * The backend contract for mobile offline synchronization. A lightweight
 * batch of client-generated operations; each operation carries a
 * client-generated operation ID, a resource type/reference, an operation
 * type, and a client timestamp. The server executes every operation through
 * the SAME shared services the REST endpoints use (no separate mobile
 * business engine) and returns a per-item result with server status,
 * server timestamp, and the written result or a failure code.
 *
 * BE-25H adds idempotency (operation identifiers dedupe replays); BE-25I
 * adds conflict handling (stale `baseVersion` → SYNC_CONFLICT with current
 * state + reload guidance).
 */

import type { MobileSyncConflictGuidance } from './mobile-sync-conflict.types';

/**
 * CR-BE-MOB-01 PART 06 — the resource kinds the offline batch can execute.
 *
 * A kind may only appear here when an EXISTING backend operation provides a
 * faithful authoritative write target: an authoritative resource id, the same
 * shared service the published REST operation uses, the same RBAC permission,
 * the same tenant/Building scope, and an explicit per-kind `data` contract.
 * Kinds are never added for client-side simulation records — an offline record
 * with no authoritative backend write stays local and must not be advertised
 * here.
 *
 * BE-25G: TASK_EXECUTION, CHECKLIST_RESPONSES, EVIDENCE_SUBMISSION,
 * TASK_ASSIGNMENT.
 * PART 06: PATROL_EXECUTION (BE-12D `startPatrolExecution` /
 * `completePatrolExecution`), PATROL_POINT_VISIT (BE-12D
 * `recordPatrolPointVisit`), METER_READING (BE-10C `submitMeterReading`).
 * CR-BE-RN12-METER-FIELD-01 PART 03: UTILITY_METER_READING (BE-18
 * `recordMobileUtilityMeterReading`).
 *
 * METER_READING AND UTILITY_METER_READING ARE DIFFERENT DOMAINS, BOTH KEPT
 * ------------------------------------------------------------------------
 * `METER_READING` is BE-10C: an engineering meter-reading BINDING executed
 * through a BE-07 Form Instance, gated by `meter_reading_binding.manage`, and it
 * is unchanged here. `UTILITY_METER_READING` is BE-18: a utility Meter Reading
 * recorded against a Reading Due by the field executor of that due's generated
 * task, gated by `utility_meter.field.record`, writing a canonical BE-18E
 * reading and completing the due. They share no resource id, no permission, no
 * service and no write target, so neither is repurposed for the other and a
 * client can never reach BE-18 through the BE-10C kind or vice versa.
 */
export const MOBILE_SYNC_RESOURCE_TYPES = [
  'TASK_EXECUTION',
  'CHECKLIST_RESPONSES',
  'EVIDENCE_SUBMISSION',
  'TASK_ASSIGNMENT',
  'PATROL_EXECUTION',
  'PATROL_POINT_VISIT',
  'METER_READING',
  'UTILITY_METER_READING',
] as const;

export type MobileSyncResourceType = (typeof MOBILE_SYNC_RESOURCE_TYPES)[number];

export const MOBILE_SYNC_OPERATIONS = [
  'START',
  'COMPLETE',
  'CANCEL',
  'SAVE',
  'SUBMIT',
  'UPDATE',
] as const;

export type MobileSyncOperation = (typeof MOBILE_SYNC_OPERATIONS)[number];

/** One client-generated sync operation. */
export type MobileSyncRequestItem = {
  /** Client-generated operation identifier (echoed in the result). */
  operationId: string;
  resourceType: MobileSyncResourceType;
  /**
   * Authoritative resource reference — always an id the backend already owns,
   * never a client-fabricated one: taskId (TASK_EXECUTION, TASK_ASSIGNMENT),
   * checklist executionId (CHECKLIST_RESPONSES, EVIDENCE_SUBMISSION),
   * patrol execution id = BE-07 taskId (PATROL_EXECUTION,
   * PATROL_POINT_VISIT), BE-07 form instance id (METER_READING), BE-18 Reading
   * Due id (UTILITY_METER_READING) — the field execution, never a bare meter id.
   */
  resourceId: string;
  operation: MobileSyncOperation;
  /** Client timestamp of when the operation happened on-device. */
  clientTimestamp: string;
  /** Type-specific payload (see the OpenAPI contract). */
  data: Record<string, unknown>;
};

export type MobileSyncBatchRequest = {
  operations: MobileSyncRequestItem[];
};

export type MobileSyncResultItem = {
  operationId: string;
  clientTimestamp: string;
  success: boolean;
  /** Server result/status of the operation. */
  status: 'SUCCESS' | 'FAILED';
  /** The written result (public resource) on success; null on failure. */
  result: unknown;
  error: {
    code: string;
    message: string;
    /**
     * BE-25K — resource/context reference where useful
     * (the operation's resource type/id).
     */
    resource?: { type: string; id: string };
    /**
     * BE-25I conflict payload: present on SYNC_CONFLICT failures. Carries
     * the current server state/reference and retry/reload guidance.
     */
    conflict?: {
      current: unknown;
      guidance: MobileSyncConflictGuidance;
    };
  } | null;
  /** Server timestamp of when the operation was executed. */
  serverTimestamp: string;
};

export type MobileSyncBatchResponse = {
  /** Server-generated batch id for correlation. */
  batchId: string;
  /** Server timestamp of when the batch was received. */
  receivedAt: string;
  results: MobileSyncResultItem[];
};
