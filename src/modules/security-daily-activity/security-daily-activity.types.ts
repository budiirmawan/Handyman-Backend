/**
 * BE-12F — Security Daily Activity domain types.
 *
 * A lightweight Security read-model that composes existing authoritative
 * records (BE-12A/B/C/D/E + BE-07 + BE-09) into a single per-Building,
 * per-operational-date view. No new authoritative tables are created; the
 * service only reads from the existing operational stores and projects a
 * compact summary suitable for a daily-activity surface.
 */

export type SecurityDailyActivityShift = {
  id: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  status: 'ACTIVE' | 'INACTIVE';
};

export type SecurityDailyActivityPost = {
  id: string;
  code: string;
  name: string;
  postType: string;
  status: 'ACTIVE' | 'INACTIVE';
};

export type SecurityDailyActivityRoute = {
  id: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  startSecurityPostId: string | null;
};

export type SecurityDailyActivityPatrol = {
  /** The shared BE-07 generated_tasks.id (Patrol Execution id). */
  id: string;
  patrolRouteId: string;
  patrolRoute: SecurityDailyActivityRoute;
  startSecurityPostId: string | null;
  startSecurityPost: SecurityDailyActivityPost | null;
  status:
    | 'OPEN'
    | 'ASSIGNED'
    | 'IN_PROGRESS'
    | 'COMPLETED'
    | 'CANCELLED';
  operationalDate: string;
  occurrenceAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type SecurityDailyActivityChecklist = {
  id: string;
  checklistTemplateId: string;
  checklistTemplateCode: string;
  checklistTemplateName: string;
  patrolChecklistBindingId: string;
  patrolRouteId: string;
  status: 'DRAFT' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  startedAt: string | null;
  completedAt: string | null;
  operationalDate: string;
  createdAt: string;
};

export type SecurityDailyActivityFinding = {
  id: string;
  findingNumber: string;
  title: string;
  status: 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'PENDING_REVIEW' | 'REJECTED' | 'REWORK_REQUIRED' | 'RESUBMITTED' | 'VERIFIED' | 'CLOSED' | 'CANCELLED';
  classificationId: string | null;
  severityId: string | null;
  createdAt: string;
  reportedByUserId: string;
  availableActions: string[];
};

export type SecurityDailyActivitySummary = {
  scheduledPatrols: number;
  inProgressPatrols: number;
  completedPatrols: number;
  cancelledPatrols: number;
  openChecklists: number;
  completedChecklists: number;
  openFindings: number;
};

export type PublicSecurityDailyActivity = {
  buildingId: string;
  operationalDate: string;
  shift: SecurityDailyActivityShift | null;
  securityPost: SecurityDailyActivityPost | null;
  summary: SecurityDailyActivitySummary;
  patrols: SecurityDailyActivityPatrol[];
  checklists: SecurityDailyActivityChecklist[];
  findings: SecurityDailyActivityFinding[];
};

export type SecurityDailyActivityFilter = {
  date?: string;
  shiftId?: string;
  securityPostId?: string;
};
