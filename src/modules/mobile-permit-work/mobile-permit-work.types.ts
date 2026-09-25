import type {
  PermitWorkAction,
  PermitWorkStartReadiness,
  PermitWorkStatusView,
} from '../permit-work-lifecycle/permit-work-lifecycle.types';

/**
 * CR-BE-RN20-PERMIT-FIELD-01 — Work Permit Field Execution contract types.
 *
 * A read-model + thin-command surface over the EXISTING BE-20K Permit Work
 * lifecycle (`permit_work_lifecycles`), addressed by the authoritative
 * `permits.id`. No permit, application, approval, validity, worker, equipment,
 * evidence or lifecycle model is added here; the field surface only changes
 * WHO may see and drive the existing READY → IN_PROGRESS → CLOSED transitions.
 */

/** Permission gating every field GET. Never `permit.read`. */
export const PERMIT_WORK_FIELD_READ_PERMISSION = 'permit_work_field.read';
/** Permission gating field START / CLOSE. Never `permit.manage`. */
export const PERMIT_WORK_FIELD_EXECUTE_PERMISSION = 'permit_work_field.execute';

/**
 * The only lifecycle statuses the field feed returns. CLOSED and CANCELLED
 * work is finished and is deliberately NOT a field-execution item; the field
 * CONTEXT read still resolves a CLOSED permit so the canonical post-CLOSE
 * state can be read back.
 */
export const MOBILE_PERMIT_WORK_FEED_STATUSES = ['READY', 'IN_PROGRESS'] as const;
export type MobilePermitWorkFeedStatus =
  (typeof MOBILE_PERMIT_WORK_FEED_STATUSES)[number];

/** Raw feed row — one row per `permits.id` (see repository grain proof). */
export type MobilePermitWorkFeedRow = {
  permitId: string;
  permitApplicationId: string;
  permitReference: string;
  buildingId: string;
  title: string;
  workDescription: string | null;
  status: MobilePermitWorkFeedStatus;
  validFrom: Date | null;
  validUntil: Date | null;
};

/** One `GET /mobile/permit-work` item. `availableActions` is backend-derived. */
export type MobilePermitWorkFeedItem = {
  permitId: string;
  permitApplicationId: string;
  permitReference: string;
  buildingId: string;
  title: string;
  workDescription: string | null;
  status: MobilePermitWorkFeedStatus;
  validFrom: string | null;
  validUntil: string | null;
  availableActions: PermitWorkAction[];
};

/**
 * Bounded projection of the existing BE-20K `PermitWorkStartReadiness`. The
 * blocker vocabulary is the lifecycle's own (APPLICATION_NOT_SUBMITTED,
 * APPROVAL_NOT_READY, PERMIT_NOT_VALID, PERMIT_EXPIRED, PERMIT_REVOKED,
 * SAFETY_NOT_READY, WORKER_LIST_NOT_READY, EQUIPMENT_NOT_READY,
 * EVIDENCE_NOT_READY, PERMIT_CANCELLED, WORK_ALREADY_TRANSITIONED) — nothing
 * is added, renamed or re-derived here.
 */
export type MobilePermitWorkReadiness = Pick<
  PermitWorkStartReadiness,
  | 'ready'
  | 'blockers'
  | 'approvalReady'
  | 'validityStatus'
  | 'safetyReady'
  | 'workerListReady'
  | 'equipmentReady'
  | 'evidenceReady'
>;

/** `GET /mobile/permit-work/{permitId}` and the body of both field commands. */
export type MobilePermitWorkFieldContext = {
  /**
   * The canonical BE-20K status view. Its `availableActions` are the FIELD
   * actions (identical to the top-level `availableActions`), never the
   * management (`permit.manage`) projection.
   */
  workStatus: PermitWorkStatusView;
  readiness: MobilePermitWorkReadiness;
  availableActions: PermitWorkAction[];
};
