/**
 * BE-08A — Work Request domain types.
 *
 * A Work Request is an operational request for work captured BEFORE a formal
 * Work Order is created. It is intentionally lightweight: intake and basic
 * state only. It becomes a Work Order in BE-08B (the CONVERTED terminal state
 * is the bridge); it does NOT carry Asset, priority, assignee, execution,
 * evidence, or lifecycle concerns here.
 *
 * `request_type` is a data-driven code string (never a hardcoded
 * Engineering/Housekeeping/Security model).
 */
export const WORK_REQUEST_STATUSES = ['OPEN', 'CANCELLED', 'CONVERTED'] as const;

export type WorkRequestStatus = (typeof WORK_REQUEST_STATUSES)[number];

export function isWorkRequestStatus(value: unknown): value is WorkRequestStatus {
  return (
    typeof value === 'string' &&
    (WORK_REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type WorkRequestRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  requestNumber: string;
  title: string;
  description: string | null;
  requestType: string;
  requestedByUserId: string;
  requestedAt: Date;
  status: WorkRequestStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicWorkRequest = {
  id: string;
  clientId: string;
  buildingId: string;
  requestNumber: string;
  title: string;
  description: string | null;
  requestType: string;
  requestedByUserId: string;
  requestedAt: string;
  status: WorkRequestStatus;
  createdAt: string;
  updatedAt: string;
};

/** Input supplied by the API consumer when creating a Work Request. */
export type CreateWorkRequestInput = {
  clientId: string;
  buildingId: string;
  requestNumber: string;
  title: string;
  description?: string;
  requestType: string;
  requestedByUserId: string;
};

/** Fully-resolved Work Request data ready for persistence. */
export type NewWorkRequest = {
  clientId: string;
  buildingId: string;
  requestNumber: string;
  title: string;
  description: string | null;
  requestType: string;
  requestedByUserId: string;
};

/** Partial update input (PATCH /work-requests/:id). */
export type UpdateWorkRequestInput = {
  title?: string;
  description?: string | null;
  requestType?: string;
};

/** List filters for GET /buildings/:buildingId/work-requests. */
export type WorkRequestFilters = {
  status?: WorkRequestStatus;
  requestType?: string;
};
