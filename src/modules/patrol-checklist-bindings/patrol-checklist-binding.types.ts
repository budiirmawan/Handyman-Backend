/**
 * BE-12E — Patrol Checklist Binding domain types.
 *
 * The minimal Security binding that associates a BE-07 Checklist Template
 * with a BE-12B Patrol Route plus an optional BE-12A Start Post inside
 * the same Building. Checklist execution stays BE-07's; the binding is
 * a join row that records the Security context. Workflow, evidence,
 * verification, and finding semantics all remain owned by BE-07 / BE-09.
 */
export const PATROL_CHECKLIST_BINDING_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;

export type PatrolChecklistBindingStatus =
  (typeof PATROL_CHECKLIST_BINDING_STATUSES)[number];

export function isPatrolChecklistBindingStatus(
  value: unknown,
): value is PatrolChecklistBindingStatus {
  return (
    typeof value === 'string' &&
    (PATROL_CHECKLIST_BINDING_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type PatrolChecklistBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  patrolRouteId: string;
  startSecurityPostId: string | null;
  checklistTemplateId: string;
  status: PatrolChecklistBindingStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation. */
export type PublicPatrolChecklistBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  patrolRouteId: string;
  startSecurityPostId: string | null;
  checklistTemplateId: string;
  status: PatrolChecklistBindingStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/** The shared BE-07 execution, as started from a patrol checklist binding. */
export type PublicPatrolChecklistExecution = {
  id: string;
  checklistTemplateId: string;
  patrolChecklistBindingId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Resolved context for a checklist execution that was started from a
 * patrol checklist binding: the authoritative Building / Template / Route
 * / Start Post. Derived from the binding — never stored a second time.
 */
export type PublicPatrolChecklistExecutionContext = {
  execution: PublicPatrolChecklistExecution;
  building: {
    id: string;
    code: string;
    name: string;
  };
  template: {
    id: string;
    code: string;
    name: string;
    status: string;
  };
  patrolRoute: {
    id: string;
    code: string;
    name: string;
    status: string;
  };
  startSecurityPost: {
    id: string | null;
    code: string | null;
    name: string | null;
  };
};

export type CreatePatrolChecklistBindingInput = {
  buildingId: string;
  patrolRouteId: string;
  startSecurityPostId?: string | null;
  checklistTemplateId: string;
  status?: PatrolChecklistBindingStatus;
  createdByUserId: string;
};

export type UpdatePatrolChecklistBindingInput = {
  startSecurityPostId?: string | null;
  status?: PatrolChecklistBindingStatus;
};

export type PatrolChecklistBindingFilter = {
  buildingId?: string;
  patrolRouteId?: string;
  checklistTemplateId?: string;
  status?: PatrolChecklistBindingStatus;
};
