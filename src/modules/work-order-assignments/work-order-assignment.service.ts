import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { satisfyClock } from '../applied-slas/sla-clock-lifecycle.service';
import {
  assertClientKeyAvailableForAssignment,
  assignmentResponseConflictError,
  normalizeAssignmentResponseClientKey,
  assignmentResponseLateError,
  assignmentResponseRepository,
  assignmentResponseSupersededError,
  notifyWorkOrderAssignedPending,
  notifyWorkOrderAssignmentAccepted,
  notifyWorkOrderAssignmentDeclined,
  notifyWorkOrderAssignmentSuperseded,
  toPublicAssignmentResponseEvent,
  type HandymanAssignmentResponseRecord,
  type PublicAssignmentResponseEvent,
} from '../assignment-responses';
import { departmentRepository } from '../departments';
import { organizationRepository } from '../organizations';
import {
  teamInactiveError,
  teamNotFoundError,
  teamRepository,
} from '../teams';
import { vendorBuildingRepository } from '../vendor-buildings';
import { vendorWorkforceRepository } from '../vendor-workforce';
import {
  vendorInactiveError,
  vendorNotFoundError,
  vendorRepository,
} from '../vendors';
import { workOrderExecutionUnauthorizedError } from '../work-order-actions/work-order-action.errors';
import { workOrderActionRepository } from '../work-order-actions/work-order-action.repository';
import { recordWorkOrderEvent } from '../work-order-history';
import {
  workOrderNotFoundError,
  workOrderRepository,
  type WorkOrderRecord,
} from '../work-orders';
import {
  workforceProfileInactiveError,
  workforceProfileNotFoundError,
  workforceRepository,
} from '../workforce';
import { workforceBuildingAssignmentRepository } from '../workforce-building-assignments';
import {
  workOrderCompetencyService,
  type WorkOrderCompetencyDecisionAction,
  type WorkOrderCompetencySubject,
} from '../worker-competency-eligibility';
// Direct file imports (not the module index) so the trade registry and the
// assignment authority can reference each other without a load-order cycle.
import { workOrderTradeCategoryRepository } from '../work-order-trade-categories/work-order-trade-category.repository';
import type { WorkOrderTradeRiskLevel } from '../work-order-trade-categories/work-order-trade-category.types';
import {
  workOrderAssignmentAlreadyAssignedError,
  workOrderAssignmentBuildingMismatchError,
  workOrderAssignmentClientMismatchError,
  workOrderAssignmentCompetencyRequiredError,
  workOrderAssignmentInvalidStateError,
  workOrderAssignmentNotFoundError,
  workOrderAssignmentVendorWorkforceMismatchError,
  workOrderClassificationConflictError,
  workOrderClassificationRequiredError,
} from './work-order-assignment.errors';
import { workOrderAssignmentRepository } from './work-order-assignment.repository';
import {
  isWorkOrderAssignableStatus,
  type AssignWorkOrderInput,
  type NewWorkOrderAssignment,
  type PublicWorkOrderAssignment,
  type RespondToWorkOrderAssignmentInput,
  type WorkOrderAssignmentCompetencyOutcome,
  type WorkOrderAssignmentCompetencyWarning,
  type WorkOrderAssignmentRecord,
} from './work-order-assignment.types';

/**
 * Projection of an assignment record plus its two orthogonal authorities:
 *
 *  - `response` — the field response lifecycle (CR-HM-ASSIGNMENT-RESPONSE-01).
 *    Omitted on plain reads, where the previous payload must stay untouched;
 *    supplied on every response-bearing read/write.
 *  - `competency` — the competency decision just taken at assign/reassign time
 *    (CR-HM-WORKER-COMPETENCY-01). Omitted on plain reads for the same reason.
 */
export function toPublicWorkOrderAssignment(
  record: WorkOrderAssignmentRecord,
  response?: HandymanAssignmentResponseRecord | null,
  competency?: WorkOrderAssignmentCompetencyOutcome | null,
): PublicWorkOrderAssignment {
  const assignment: PublicWorkOrderAssignment = {
    id: record.id,
    workOrderId: record.workOrderId,
    assigneeType: record.assigneeType,
    workforceProfileId: record.workforceProfileId,
    teamId: record.teamId,
    vendorId: record.vendorId,
    assignedByUserId: record.assignedByUserId,
    assignedAt: record.assignedAt.toISOString(),
    status: record.status,
    responseStatus: response?.responseStatus ?? 'PENDING',
    respondedByUserId: response?.respondedByUserId ?? null,
    respondedAt: response?.respondedAt
      ? response.respondedAt.toISOString()
      : null,
    declineReason: response?.declineReason ?? null,
    responseNotes: response?.responseNotes ?? null,
    reassignmentRequired:
      record.status === 'ACTIVE' &&
      (response?.responseStatus ?? 'PENDING') === 'TIDAK_BISA',
  };
  // PART 03B2B — the RECOMMENDED warnings of the decision just taken. Omitted
  // on plain reads so the pre-existing payload stays untouched there.
  if (competency !== undefined) {
    assignment.competency = competency;
  }
  return assignment;
}

/**
 * Checks whether `actorUserId` is the authorized assignee (or member of the
 * assigned team / bound to the assigned vendor) of the given assignment.
 */
export async function isActorAuthorizedForAssignment(
  actorUserId: string,
  assignment: WorkOrderAssignmentRecord,
): Promise<boolean> {
  const profile = await workforceRepository.findByUserId(actorUserId);
  if (!profile || profile.status !== 'ACTIVE') {
    return false;
  }

  switch (assignment.assigneeType) {
    case 'WORKFORCE':
      return profile.id === assignment.workforceProfileId;
    case 'TEAM':
      return profile.teamId !== null && profile.teamId === assignment.teamId;
    case 'VENDOR':
      return (
        assignment.vendorId !== null &&
        (await vendorWorkforceRepository.findActiveByVendorAndWorkforce(
          assignment.vendorId,
          profile.id,
        )) !== null
      );
    case 'VENDOR_WORKFORCE':
      return (
        profile.id === assignment.workforceProfileId &&
        assignment.vendorId !== null &&
        (await vendorWorkforceRepository.findActiveByVendorAndWorkforce(
          assignment.vendorId,
          profile.id,
        )) !== null
      );
  }
}

/** Resolves the Client that owns a Workforce Profile (Profile → Org → Client). */
async function resolveWorkforceClient(
  workforceProfileId: string,
): Promise<string> {
  const profile = await workforceRepository.findById(workforceProfileId);
  if (!profile) {
    throw workforceProfileNotFoundError();
  }
  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization) {
    throw workforceProfileNotFoundError();
  }
  return organization.clientId;
}

/** Resolves the Client that owns a Team (Team → Dept → Org → Client). */
async function resolveTeamClient(teamId: string): Promise<string> {
  const team = await teamRepository.findById(teamId);
  if (!team) {
    throw teamNotFoundError();
  }
  const department = await departmentRepository.findById(team.departmentId);
  if (!department) {
    throw teamNotFoundError();
  }
  const organization = await organizationRepository.findById(
    department.organizationId,
  );
  if (!organization) {
    throw teamNotFoundError();
  }
  return organization.clientId;
}

/**
 * Validates a WORKFORCE assignment: the profile must exist, be ACTIVE, belong
 * to the Work Order's Client, and be placed (operational assignment) in the
 * Work Order's Building.
 */
async function validateWorkforce(
  workOrder: { clientId: string; buildingId: string },
  workforceProfileId: string,
): Promise<void> {
  const profile = await workforceRepository.findById(workforceProfileId);
  if (!profile) {
    throw workforceProfileNotFoundError();
  }
  if (profile.status !== 'ACTIVE') {
    throw workforceProfileInactiveError();
  }
  const profileClientId = await resolveWorkforceClient(workforceProfileId);
  if (profileClientId !== workOrder.clientId) {
    throw workOrderAssignmentClientMismatchError();
  }
  const placement =
    await workforceBuildingAssignmentRepository.findActiveByProfileAndBuilding(
      workforceProfileId,
      workOrder.buildingId,
    );
  if (!placement) {
    throw workOrderAssignmentBuildingMismatchError();
  }
}

/**
 * Validates a TEAM assignment: the team must exist, be ACTIVE, and belong to
 * the Work Order's Client. Teams are organization-grouping concepts, not
 * Building-scoped, so no building placement is required.
 */
async function validateTeam(
  workOrder: { clientId: string },
  teamId: string,
): Promise<void> {
  const team = await teamRepository.findById(teamId);
  if (!team) {
    throw teamNotFoundError();
  }
  if (team.status !== 'ACTIVE') {
    throw teamInactiveError();
  }
  const teamClientId = await resolveTeamClient(teamId);
  if (teamClientId !== workOrder.clientId) {
    throw workOrderAssignmentClientMismatchError();
  }
}

/**
 * Validates a VENDOR assignment: the vendor must exist, be ACTIVE, belong to
 * the Work Order's Client, and hold an ACTIVE relationship to the Work
 * Order's Building.
 */
async function validateVendor(
  workOrder: { clientId: string; buildingId: string },
  vendorId: string,
): Promise<void> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }
  if (vendor.status !== 'ACTIVE') {
    throw vendorInactiveError();
  }
  if (vendor.clientId !== workOrder.clientId) {
    throw workOrderAssignmentClientMismatchError();
  }
  const relationship = await vendorBuildingRepository.findActiveByVendorAndBuilding(
    vendorId,
    workOrder.buildingId,
  );
  if (!relationship) {
    throw workOrderAssignmentBuildingMismatchError();
  }
}

/**
 * Validates a VENDOR_WORKFORCE assignment: the vendor must exist, be ACTIVE,
 * belong to the Work Order's Client, hold an ACTIVE relationship to the Work
 * Order's Building, and the Workforce Profile must be bound to that Vendor.
 */
async function validateVendorWorkforce(
  workOrder: { clientId: string; buildingId: string },
  vendorId: string,
  workforceProfileId: string,
): Promise<void> {
  const vendor = await vendorRepository.findById(vendorId);
  if (!vendor) {
    throw vendorNotFoundError();
  }
  if (vendor.status !== 'ACTIVE') {
    throw vendorInactiveError();
  }
  if (vendor.clientId !== workOrder.clientId) {
    throw workOrderAssignmentClientMismatchError();
  }
  const relationship = await vendorBuildingRepository.findActiveByVendorAndBuilding(
    vendorId,
    workOrder.buildingId,
  );
  if (!relationship) {
    throw workOrderAssignmentBuildingMismatchError();
  }
  const binding = await vendorWorkforceRepository.findByVendorAndWorkforce(
    vendorId,
    workforceProfileId,
  );
  if (!binding || binding.status !== 'ACTIVE') {
    throw workOrderAssignmentVendorWorkforceMismatchError();
  }
}

/**
 * Validates an assignee payload against the Work Order's Client/Building
 * context and resolves it into persistence-ready fields.
 */
async function resolveAssignee(
  workOrder: { clientId: string; buildingId: string },
  input: AssignWorkOrderInput,
): Promise<NewWorkOrderAssignment> {
  const base = {
    workOrderId: input.workOrderId,
    assignedByUserId: input.assignedByUserId,
  };

  switch (input.assigneeType) {
    case 'WORKFORCE': {
      const workforceProfileId = requireId(input.workforceProfileId);
      await validateWorkforce(workOrder, workforceProfileId);
      return {
        ...base,
        assigneeType: input.assigneeType,
        workforceProfileId,
        teamId: null,
        vendorId: null,
      };
    }
    case 'TEAM': {
      const teamId = requireId(input.teamId);
      await validateTeam(workOrder, teamId);
      return {
        ...base,
        assigneeType: input.assigneeType,
        workforceProfileId: null,
        teamId,
        vendorId: null,
      };
    }
    case 'VENDOR': {
      const vendorId = requireId(input.vendorId);
      await validateVendor(workOrder, vendorId);
      return {
        ...base,
        assigneeType: input.assigneeType,
        workforceProfileId: null,
        teamId: null,
        vendorId,
      };
    }
    case 'VENDOR_WORKFORCE': {
      const vendorId = requireId(input.vendorId);
      const workforceProfileId = requireId(input.workforceProfileId);
      await validateVendorWorkforce(workOrder, vendorId, workforceProfileId);
      return {
        ...base,
        assigneeType: input.assigneeType,
        workforceProfileId,
        teamId: null,
        vendorId,
      };
    }
  }
}

function requireId(value: string | undefined): string {
  if (!value) {
    // Validation guarantees presence per assignee type before reaching here.
    throw workOrderAssignmentVendorWorkforceMismatchError();
  }
  return value;
}

/**
 * The assignable Work Order. The FULL row is kept (not a narrowed projection)
 * because the assignment-response notifications need the Work Order's title
 * and number; the classification fields are added on top of it.
 */
type AssignableWorkOrder = WorkOrderRecord & {
  /** PART 03B2A — the authoritative trade classification, if any. */
  tradeCategoryId: string | null;
  tradeCategoryCode: string | null;
  riskLevel: WorkOrderTradeRiskLevel | null;
  /**
   * PART 03B2E — true when the Work Order belongs to the Handyman lifecycle
   * (Customer Care origin). Such a Work Order may not be assigned before
   * Operations has classified it.
   */
  classificationRequired: boolean;
};

async function loadAssignableWorkOrder(
  workOrderId: string,
): Promise<AssignableWorkOrder> {
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  if (!isWorkOrderAssignableStatus(workOrder.status)) {
    throw workOrderAssignmentInvalidStateError(workOrder.status);
  }
  const classification =
    await workOrderTradeCategoryRepository.findClassification(
      undefined,
      workOrderId,
    );
  return {
    ...workOrder,
    tradeCategoryId: classification?.tradeCategoryId ?? null,
    tradeCategoryCode: classification?.tradeCategoryCode ?? null,
    riskLevel: classification?.riskLevel ?? null,
    classificationRequired: classification?.classificationRequired ?? false,
  };
}

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2E — the competency gate may only run
 * when there is something to gate against.
 *
 * For a Handyman-lifecycle Work Order, "unclassified" is not "unrestricted":
 * it means Operations has not yet decided what the job is. Letting that pass
 * would report a successful assignment as competency-checked when no check was
 * possible, so it is refused with a dedicated domain error instead.
 *
 * Work Orders from other domains (engineering/breakdown, direct preventive
 * work) keep their pre-03B2E behaviour: classification stays optional, because
 * the trade registry is Handyman's and those flows never used it.
 */
function assertClassificationPresent(workOrder: AssignableWorkOrder): void {
  if (workOrder.classificationRequired && workOrder.tradeCategoryId === null) {
    throw workOrderClassificationRequiredError();
  }
}

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2A — the people an assignment actually
 * commits to. A company (VENDOR) names no person, so the rule is ANY (at least
 * one bound worker must qualify); a team works as one unit, so EVERY active
 * member must qualify — exactly the crew rule of PART 03A.
 */
type AssignmentSubjects = {
  subjects: WorkOrderCompetencySubject[];
  rule: 'ALL' | 'ANY';
};

type AssignmentSubjectTarget = {
  assigneeType: AssignWorkOrderInput['assigneeType'];
  workforceProfileId?: string | undefined;
  teamId?: string | undefined;
  vendorId?: string | undefined;
};

async function resolveAssignmentSubjects(
  workOrder: Pick<
    AssignableWorkOrder,
    'id' | 'clientId' | 'tradeCategoryId' | 'tradeCategoryCode' | 'riskLevel'
  >,
  input: AssignmentSubjectTarget,
): Promise<AssignmentSubjects> {
  switch (input.assigneeType) {
    case 'WORKFORCE':
    case 'VENDOR_WORKFORCE': {
      const workforceProfileId = requireId(input.workforceProfileId);
      const profile = await workforceRepository.findById(workforceProfileId);
      return {
        subjects: [
          {
            workforceProfileId,
            workforceProfileName: profile?.fullName ?? null,
            role: 'ASSIGNEE',
          },
        ],
        rule: 'ALL',
      };
    }
    case 'TEAM': {
      const teamId = requireId(input.teamId);
      const members = await workforceRepository.listByTeamId(teamId);
      return {
        subjects: members
          .filter((member) => member.status === 'ACTIVE')
          .map((member) => ({
            workforceProfileId: member.id,
            workforceProfileName: member.fullName,
            role: 'TEAM_MEMBER' as const,
          })),
        rule: 'ALL',
      };
    }
    case 'VENDOR': {
      const vendorId = requireId(input.vendorId);
      const bindings = await vendorWorkforceRepository.listByVendorId(vendorId);
      const candidates: WorkOrderCompetencySubject[] = [];
      for (const binding of bindings) {
        if (binding.status !== 'ACTIVE') continue;
        const profile = await workforceRepository.findById(
          binding.workforceProfileId,
        );
        if (!profile || profile.status !== 'ACTIVE') continue;
        // The vendor is already proven to be inside the Work Order's Client;
        // the worker binding is re-checked so a mis-bound profile can never be
        // used to satisfy another Client's requirement.
        const workerClient = await resolveWorkforceClient(profile.id);
        if (workerClient !== workOrder.clientId) continue;
        candidates.push({
          workforceProfileId: profile.id,
          workforceProfileName: profile.fullName,
          role: 'VENDOR_CANDIDATE',
        });
      }
      return { subjects: candidates, rule: 'ANY' };
    }
  }
}

/**
 * The single competency gate for Work Order assignment/reassignment.
 *
 * Runs INSIDE the assignment transaction: the decision ledger row, the
 * assignment row and its `PENDING` assignment-response row commit together, so
 * a refused assignment leaves neither a half-written assignment, nor a
 * response awaiting an answer that can never come, nor a decision that never
 * happened. When the Work Order is unclassified (or its trade has no ACTIVE
 * requirement) the decision is unrestricted and nothing is written.
 */
type CompetencyGateWorkOrder = Pick<
  AssignableWorkOrder,
  | 'id'
  | 'clientId'
  | 'tradeCategoryId'
  | 'tradeCategoryCode'
  | 'riskLevel'
>;

async function applyCompetencyGate(
  executor: Pick<PoolClient, 'query'>,
  workOrder: CompetencyGateWorkOrder,
  input: AssignmentSubjectTarget,
  assignmentId: string,
  action: WorkOrderCompetencyDecisionAction,
): Promise<WorkOrderAssignmentCompetencyOutcome> {
  const { subjects, rule } = await resolveAssignmentSubjects(workOrder, input);

  const decision = await workOrderCompetencyService.evaluateWorkOrderCompetency(
    executor,
    {
      clientId: workOrder.clientId,
      tradeCategoryId: workOrder.tradeCategoryId,
      tradeCategoryCode: workOrder.tradeCategoryCode,
      subjects,
      rule,
    },
  );

  if (!decision.satisfied) {
    throw workOrderAssignmentCompetencyRequiredError(
      decision.blocking.map((gap) => ({
        workforceProfileId: gap.workforceProfileId,
        workforceProfileName: gap.workforceProfileName,
        requirementId: gap.requirementId,
        requirementType: gap.requirementType,
        enforcementLevel: gap.enforcementLevel,
        skillCode: gap.skillCode,
        certificateName: gap.certificateName,
        minimumProficiencyLevel: gap.minimumProficiencyLevel,
        reason: gap.reason,
        rule: decision.rule,
      })),
    );
  }

  await workOrderCompetencyService.recordWorkOrderCompetencyDecision(executor, {
    clientId: workOrder.clientId,
    workOrderId: workOrder.id,
    assignmentId,
    action,
    assigneeType: input.assigneeType,
    tradeCategoryId: decision.tradeCategoryId,
    tradeCategoryCode: decision.tradeCategoryCode,
    riskLevel: workOrder.riskLevel,
    rows: decision.rows,
  });

  // PART 03B2B — every unsatisfied RECOMMENDED requirement becomes a warning on
  // the response. It never blocks: the assignment already succeeded above.
  const subjectNames = new Map(
    subjects.map((subject) => [
      subject.workforceProfileId,
      subject.workforceProfileName,
    ]),
  );
  const advisory: WorkOrderAssignmentCompetencyWarning[] = decision.rows
    .filter((row) => !row.satisfied && row.enforcementLevel === 'RECOMMENDED')
    .map((row) => ({
      workforceProfileId: row.workforceProfileId,
      workforceProfileName: subjectNames.get(row.workforceProfileId) ?? null,
      requirementId: row.requirementId,
      requirementType: row.requirementType,
      skillCode: row.skillCode,
      certificateName: row.certificateName,
      minimumProficiencyLevel: row.minimumProficiencyLevel,
      reason: row.reason ?? 'REQUIREMENT_NOT_MET',
    }));

  return {
    tradeCategoryId: decision.tradeCategoryId,
    tradeCategoryCode: decision.tradeCategoryCode,
    rule: decision.rule,
    satisfied: decision.satisfied,
    mandatoryRequirementCount: decision.summary.mandatoryRequirementCount,
    advisory,
  };
}

/**
 * The audit metadata of an assignment event. Both release lines describe the
 * same fact from a different angle, so the SAME event carries both: what the
 * competency gate decided and which response state the assignee now owes.
 */
function assignmentEventMetadata(input: {
  assigneeType: AssignWorkOrderInput['assigneeType'];
  workOrder: AssignableWorkOrder;
  assignmentId: string;
  responseStatus: string;
  competency: WorkOrderAssignmentCompetencyOutcome;
}): Record<string, unknown> {
  return {
    assignmentId: input.assignmentId,
    assigneeType: input.assigneeType,
    tradeCategoryId: input.workOrder.tradeCategoryId,
    tradeCategoryCode: input.workOrder.tradeCategoryCode,
    riskLevel: input.workOrder.riskLevel,
    responseStatus: input.responseStatus,
    competency: {
      rule: input.competency.rule,
      satisfied: input.competency.satisfied,
      mandatoryRequirementCount: input.competency.mandatoryRequirementCount,
      advisoryCount: input.competency.advisory.length,
    },
  };
}

/**
 * Assigns a Work Order to a Workforce / Team / Vendor / Vendor Workforce.
 * The Work Order must be in an assignable lifecycle state, and the assignee
 * must resolve to the same Client (and, where applicable, Building) context.
 * A Work Order with an existing ACTIVE assignment is rejected (409) — it must
 * be reassigned through the dedicated reassign flow.
 *
 * Atomically, in ONE transaction:
 *  - the competency gate runs (a MANDATORY gap refuses and rolls everything
 *    back),
 *  - the assignment is created,
 *  - its `PENDING` response state and `ASSIGNMENT_PENDING_CREATED` history
 *    event are initialised,
 *  - the operational event is recorded, and
 *  - the `IN_APP` notification(s) are written.
 */
export async function assignWorkOrder(
  input: AssignWorkOrderInput,
): Promise<PublicWorkOrderAssignment> {
  const workOrder = await loadAssignableWorkOrder(input.workOrderId);
  // PART 03B2E — no silent pass through the competency gate.
  assertClassificationPresent(workOrder);

  const existing = await workOrderAssignmentRepository.findActiveByWorkOrderId(
    input.workOrderId,
  );
  if (existing) {
    throw workOrderAssignmentAlreadyAssignedError();
  }

  const newAssignment = await resolveAssignee(workOrder, input);

  try {
    return await withTransaction(async (tx) => {
      await tx.query(`SELECT id FROM work_orders WHERE id = $1 FOR UPDATE`, [
        workOrder.id,
      ]);

      const activeInTx =
        await workOrderAssignmentRepository.findActiveByWorkOrderIdForUpdate(
          input.workOrderId,
          tx,
        );
      if (activeInTx) {
        throw workOrderAssignmentAlreadyAssignedError();
      }

      const record = await workOrderAssignmentRepository.create(
        newAssignment,
        tx,
      );

      // PART 03B2A — the competency gate runs BEFORE the response/notification
      // seam so a refusal leaves no orphaned PENDING response behind.
      const competency = await applyCompetencyGate(
        tx,
        workOrder,
        input,
        record.id,
        'ASSIGNED',
      );

      const pendingResponse =
        await assignmentResponseRepository.ensurePendingForAssignment(
          {
            clientId: workOrder.clientId,
            buildingId: workOrder.buildingId,
            assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
            assignmentId: record.id,
            workOrderId: workOrder.id,
            assignedByUserId: input.assignedByUserId,
            assignedAt: record.assignedAt,
          },
          tx,
        );

      await recordWorkOrderEvent(
        {
          workOrderId: input.workOrderId,
          clientId: workOrder.clientId,
          buildingId: workOrder.buildingId,
          eventType: 'WORK_ORDER_ASSIGNED',
          actorUserId: input.assignedByUserId,
          summary: `Work order assigned to ${input.assigneeType}`,
          metadata: assignmentEventMetadata({
            assigneeType: input.assigneeType,
            workOrder,
            assignmentId: record.id,
            responseStatus: pendingResponse.responseStatus,
            competency,
          }),
        },
        tx,
      );

      await notifyWorkOrderAssignedPending(workOrder, record, tx);

      return toPublicWorkOrderAssignment(record, pendingResponse, competency);
    });
  } catch (error) {
    // The partial ACTIVE unique index is the final authority for races.
    if (isActiveAssignmentUniqueViolation(error)) {
      throw workOrderAssignmentAlreadyAssignedError();
    }
    throw error;
  }
}

/** Returns the current ACTIVE assignment, or null if none exists. */
export async function getCurrentWorkOrderAssignment(
  workOrderId: string,
): Promise<PublicWorkOrderAssignment | null> {
  const record = await workOrderAssignmentRepository.findActiveByWorkOrderId(
    workOrderId,
  );
  if (!record) {
    return null;
  }
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) {
    return toPublicWorkOrderAssignment(record, null);
  }
  const response =
    await assignmentResponseRepository.ensurePendingForAssignment({
      clientId: workOrder.clientId,
      buildingId: workOrder.buildingId,
      assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
      assignmentId: record.id,
      workOrderId: workOrder.id,
      assignedByUserId: record.assignedByUserId,
      assignedAt: record.assignedAt,
    });
  return toPublicWorkOrderAssignment(record, response);
}

/** Lists all (active + historical) assignments of a Work Order. */
export async function listWorkOrderAssignments(
  workOrderId: string,
): Promise<PublicWorkOrderAssignment[]> {
  const records = await workOrderAssignmentRepository.listByWorkOrderId(
    workOrderId,
  );
  const responseMap = await assignmentResponseRepository.findByAssignmentIds(
    records.map((r) => r.id),
  );
  return records.map((record) =>
    toPublicWorkOrderAssignment(record, responseMap.get(record.id) ?? null),
  );
}

/**
 * Deactivates an ACTIVE assignment (it is never deleted — history is kept).
 * Re-deactivating an already-INACTIVE assignment is a no-op success.
 */
export async function deactivateWorkOrderAssignment(
  workOrderId: string,
  assignmentId: string,
  actorUserId?: string,
): Promise<PublicWorkOrderAssignment> {
  const workOrder = await workOrderRepository.findById(workOrderId);
  const record = await workOrderAssignmentRepository.findById(assignmentId);
  if (!record || record.workOrderId !== workOrderId) {
    throw workOrderAssignmentNotFoundError();
  }

  return withTransaction(async (tx) => {
    const locked = await workOrderAssignmentRepository.findByIdForUpdate(
      assignmentId,
      tx,
    );
    if (!locked || locked.workOrderId !== workOrderId) {
      throw workOrderAssignmentNotFoundError();
    }

    const updated = await workOrderAssignmentRepository.updateStatus(
      assignmentId,
      'INACTIVE',
      tx,
    );

    let response: HandymanAssignmentResponseRecord | null = null;
    if (workOrder) {
      response =
        locked.status === 'ACTIVE'
          ? await assignmentResponseRepository.recordSupersededEvent(
              {
                clientId: workOrder.clientId,
                buildingId: workOrder.buildingId,
                assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
                assignmentId: locked.id,
                workOrderId: workOrder.id,
                assignedByUserId: locked.assignedByUserId,
                assignedAt: locked.assignedAt,
              },
              actorUserId ?? locked.assignedByUserId,
              'Assignment deactivated.',
              tx,
            )
          : await assignmentResponseRepository.ensurePendingForAssignment(
              {
                clientId: workOrder.clientId,
                buildingId: workOrder.buildingId,
                assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
                assignmentId: locked.id,
                workOrderId: workOrder.id,
                assignedByUserId: locked.assignedByUserId,
                assignedAt: locked.assignedAt,
              },
              tx,
            );

      await recordWorkOrderEvent(
        {
          workOrderId,
          clientId: workOrder.clientId,
          buildingId: workOrder.buildingId,
          eventType: 'WORK_ORDER_ASSIGNMENT_DEACTIVATED',
          actorUserId: actorUserId ?? null,
          summary: 'Work order assignment deactivated',
          metadata: {
            assignmentId: locked.id,
            assigneeType: locked.assigneeType,
          },
        },
        tx,
      );
    }

    return toPublicWorkOrderAssignment(
      updated as WorkOrderAssignmentRecord,
      response,
    );
  });
}

/**
 * Reassigns a Work Order: atomically deactivates its current ACTIVE assignment
 * (if any), marks its response history as superseded while preserving its
 * historical response, runs the SAME competency gate as a first assignment,
 * creates the new ACTIVE assignment with a `PENDING` response, and emits
 * deduplicated `IN_APP` notifications in a single transaction.
 */
export async function reassignWorkOrder(
  workOrderId: string,
  input: AssignWorkOrderInput,
  expectedAssignmentId?: string,
): Promise<PublicWorkOrderAssignment> {
  const workOrder = await loadAssignableWorkOrder(workOrderId);
  // PART 03B2E — a reassignment is a NEW assignment decision, so the
  // classification must already exist (an unclassified Work Order is not an
  // unrestricted one).
  assertClassificationPresent(workOrder);

  if (expectedAssignmentId !== undefined) {
    const targetRecord =
      await workOrderAssignmentRepository.findById(expectedAssignmentId);
    if (!targetRecord || targetRecord.workOrderId !== workOrderId) {
      throw workOrderAssignmentNotFoundError();
    }
  }

  const newAssignment = await resolveAssignee(workOrder, {
    ...input,
    workOrderId,
  });

  try {
    return await withTransaction(async (tx) => {
      await tx.query(`SELECT id FROM work_orders WHERE id = $1 FOR UPDATE`, [
        workOrderId,
      ]);

      const current =
        await workOrderAssignmentRepository.findActiveByWorkOrderIdForUpdate(
          workOrderId,
          tx,
        );

      let currentResponse: HandymanAssignmentResponseRecord | null = null;
      if (current) {
        currentResponse =
          await assignmentResponseRepository.ensurePendingForAssignment(
            {
              clientId: workOrder.clientId,
              buildingId: workOrder.buildingId,
              assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
              assignmentId: current.id,
              workOrderId: workOrder.id,
              assignedByUserId: current.assignedByUserId,
              assignedAt: current.assignedAt,
            },
            tx,
            true,
          );

        const sameAssignee =
          current.assigneeType === newAssignment.assigneeType &&
          current.workforceProfileId === newAssignment.workforceProfileId &&
          current.teamId === newAssignment.teamId &&
          current.vendorId === newAssignment.vendorId;

        if (sameAssignee && currentResponse.responseStatus === 'PENDING') {
          return toPublicWorkOrderAssignment(current, currentResponse);
        }

        if (
          expectedAssignmentId !== undefined &&
          expectedAssignmentId !== current.id
        ) {
          throw assignmentResponseSupersededError(
            'Cannot reassign from a superseded or inactive Work Order assignment.',
          );
        }

        await workOrderAssignmentRepository.updateStatus(
          current.id,
          'INACTIVE',
          tx,
        );

        await assignmentResponseRepository.recordSupersededEvent(
          {
            clientId: workOrder.clientId,
            buildingId: workOrder.buildingId,
            assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
            assignmentId: current.id,
            workOrderId: workOrder.id,
            assignedByUserId: current.assignedByUserId,
            assignedAt: current.assignedAt,
          },
          input.assignedByUserId,
          'Assignment superseded by reassignment.',
          tx,
        );
      }

      const record = await workOrderAssignmentRepository.create(
        newAssignment,
        tx,
      );

      // PART 03B2A — the gate of the NEW assignment, inside the same
      // transaction as the supersede of the previous one. A MANDATORY gap
      // rolls BOTH back, so the Work Order keeps its previous assignee.
      const competency = await applyCompetencyGate(
        tx,
        workOrder,
        input,
        record.id,
        'REASSIGNED',
      );

      const pendingResponse =
        await assignmentResponseRepository.ensurePendingForAssignment(
          {
            clientId: workOrder.clientId,
            buildingId: workOrder.buildingId,
            assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
            assignmentId: record.id,
            workOrderId: workOrder.id,
            assignedByUserId: input.assignedByUserId,
            assignedAt: record.assignedAt,
          },
          tx,
        );

      await recordWorkOrderEvent(
        {
          workOrderId,
          clientId: workOrder.clientId,
          buildingId: workOrder.buildingId,
          eventType: 'WORK_ORDER_REASSIGNED',
          actorUserId: input.assignedByUserId,
          summary: `Work order reassigned to ${input.assigneeType}`,
          metadata: {
            previousAssignmentId: current?.id ?? null,
            previousResponseStatus: currentResponse?.responseStatus ?? null,
            ...assignmentEventMetadata({
              assigneeType: input.assigneeType,
              workOrder,
              assignmentId: record.id,
              responseStatus: pendingResponse.responseStatus,
              competency,
            }),
          },
        },
        tx,
      );

      if (current) {
        await notifyWorkOrderAssignmentSuperseded(
          workOrder,
          current,
          record,
          tx,
        );
      }
      await notifyWorkOrderAssignedPending(workOrder, record, tx);

      return toPublicWorkOrderAssignment(record, pendingResponse, competency);
    });
  } catch (error) {
    if (isActiveAssignmentUniqueViolation(error)) {
      // Extremely unlikely (we just deactivated); surface as already assigned.
      throw workOrderAssignmentAlreadyAssignedError();
    }
    throw error;
  }
}

/**
 * Records an explicit worker/PIC response (`TERIMA` | `TIDAK_BISA`) against a
 * specific Work Order `assignmentId` (`POST /work-orders/:id/assignments/:assignmentId/respond`).
 *
 * - `TERIMA` integrates with `ACKNOWLEDGE` (`work_order_actions` + SLA +
 *   `operational_events`) in the same transaction without duplicating actions,
 *   events, or SLA clock fulfillment.
 * - `TIDAK_BISA` requires a non-empty `declineReason`, never cancels the Tenant
 *   Work Order, marks the assignment `reassignmentRequired: true`, blocks
 *   `START` under that assignment, and sends an `IN_APP` notification to
 *   Operations.
 * - Rejects responses against superseded (`INACTIVE`) assignments (`409`),
 *   unauthorized callers (`403`), late lifecycle states (`409`), and
 *   contradictory transitions (`TERIMA <-> TIDAK_BISA`) on the same assignment
 *   (`409`), while handling duplicate replays of the same decision idempotently.
 */
export async function respondToWorkOrderAssignment(
  input: RespondToWorkOrderAssignmentInput,
): Promise<PublicWorkOrderAssignment> {
  const clientKey = normalizeAssignmentResponseClientKey(input.idempotencyKey);
  const workOrder = await workOrderRepository.findById(input.workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }

  const assignment = await workOrderAssignmentRepository.findById(
    input.assignmentId,
  );
  if (!assignment || assignment.workOrderId !== workOrder.id) {
    throw workOrderAssignmentNotFoundError();
  }

  const authorized = await isActorAuthorizedForAssignment(
    input.actorUserId,
    assignment,
  );
  if (!authorized) {
    throw workOrderExecutionUnauthorizedError();
  }

  return withTransaction(async (tx) => {
    const lockedWoResult = await tx.query<{ status: string }>(
      `SELECT status FROM work_orders WHERE id = $1 FOR UPDATE`,
      [workOrder.id],
    );
    const currentWoStatus = lockedWoResult.rows[0]?.status ?? workOrder.status;

    const lockedAssignment =
      await workOrderAssignmentRepository.findByIdForUpdate(assignment.id, tx);
    if (!lockedAssignment || lockedAssignment.workOrderId !== workOrder.id) {
      throw workOrderAssignmentNotFoundError();
    }

    const existingResponse =
      await assignmentResponseRepository.ensurePendingForAssignment(
        {
          clientId: workOrder.clientId,
          buildingId: workOrder.buildingId,
          assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
          assignmentId: lockedAssignment.id,
          workOrderId: workOrder.id,
          assignedByUserId: lockedAssignment.assignedByUserId,
          assignedAt: lockedAssignment.assignedAt,
        },
        tx,
        true,
      );

    if (lockedAssignment.status !== 'ACTIVE') {
      throw assignmentResponseSupersededError(
        'Cannot respond to an inactive or superseded Work Order assignment.',
      );
    }

    // Idempotent replay of the exact same decision on the active assignment.
    if (existingResponse.responseStatus === input.decision) {
      return toPublicWorkOrderAssignment(lockedAssignment, existingResponse);
    }

    // Contradictory transition on the same assignment (TERIMA <-> TIDAK_BISA).
    if (existingResponse.responseStatus !== 'PENDING') {
      throw assignmentResponseConflictError(
        `Assignment response has already been finalized as '${existingResponse.responseStatus}' and cannot transition to '${input.decision}'.`,
      );
    }

    if (currentWoStatus !== 'OPEN' && currentWoStatus !== 'ASSIGNED') {
      throw assignmentResponseLateError(
        `Cannot respond to Work Order assignment when Work Order is in status '${currentWoStatus}'.`,
      );
    }

    // CR-HM-FIELD-OPS-ACK-01 PART 01 — a device key may finalize ONE
    // assignment per actor. The Standard Work Order lane has no Handyman
    // appointment window, so its existing Work Order status guard above is
    // the sole lifecycle/expiry gate (no deadline is invented here).
    await assertClientKeyAvailableForAssignment(
      {
        actorUserId: input.actorUserId,
        assignmentId: lockedAssignment.id,
        clientIdempotencyKey: clientKey,
      },
      tx,
    );

    if (input.decision === 'TERIMA') {
      if (currentWoStatus === 'OPEN') {
        await workOrderRepository.updateStatus(workOrder.id, 'ASSIGNED', tx);
      }

      const action = await workOrderActionRepository.create(
        {
          workOrderId: workOrder.id,
          actionType: 'ACKNOWLEDGED',
          actorUserId: input.actorUserId,
          notes: input.notes ?? null,
        },
        tx,
      );

      await satisfyClock(workOrder, 'RESPONSE', action.occurredAt, tx);

      if (currentWoStatus === 'OPEN') {
        await recordWorkOrderEvent(
          {
            workOrderId: workOrder.id,
            clientId: workOrder.clientId,
            buildingId: workOrder.buildingId,
            eventType: 'WORK_ORDER_STATUS_CHANGED',
            summary: `Work order status changed from ${currentWoStatus} to ASSIGNED`,
            metadata: { from: currentWoStatus, to: 'ASSIGNED' },
          },
          tx,
        );
      }

      await recordWorkOrderEvent(
        {
          workOrderId: workOrder.id,
          clientId: workOrder.clientId,
          buildingId: workOrder.buildingId,
          eventType: 'WORK_ORDER_EXECUTION_ACTION',
          actorUserId: input.actorUserId,
          summary: 'Work order execution action: ACKNOWLEDGED',
          metadata: {
            actionType: 'ACKNOWLEDGED',
            assignmentId: lockedAssignment.id,
            responseStatus: 'TERIMA',
          },
        },
        tx,
      );

      const updatedResponse = await assignmentResponseRepository.recordDecision(
        {
          assignmentId: lockedAssignment.id,
          decision: 'TERIMA',
          actorUserId: input.actorUserId,
          respondedAt: action.occurredAt,
          notes: input.notes ?? null,
          linkedWorkOrderActionId: action.id,
          idempotencyKey: input.idempotencyKey ?? null,
          clientIdempotencyKey: clientKey,
        },
        tx,
      );

      await notifyWorkOrderAssignmentAccepted(
        workOrder,
        lockedAssignment,
        input.actorUserId,
        action.occurredAt,
        tx,
      );

      return toPublicWorkOrderAssignment(lockedAssignment, updatedResponse);
    }

    // input.decision === 'TIDAK_BISA'
    const declineReason = input.declineReason!.trim();
    const respondedAt = new Date();
    const updatedResponse = await assignmentResponseRepository.recordDecision(
      {
        assignmentId: lockedAssignment.id,
        decision: 'TIDAK_BISA',
        actorUserId: input.actorUserId,
        respondedAt,
        declineReason,
        notes: input.notes ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        clientIdempotencyKey: clientKey,
      },
      tx,
    );

    await recordWorkOrderEvent(
      {
        workOrderId: workOrder.id,
        clientId: workOrder.clientId,
        buildingId: workOrder.buildingId,
        eventType: 'WORK_ORDER_ASSIGNMENT_DECLINED',
        actorUserId: input.actorUserId,
        summary: 'Work order assignment declined (TIDAK_BISA)',
        metadata: {
          assignmentId: lockedAssignment.id,
          responseStatus: 'TIDAK_BISA',
          declineReason,
          notes: input.notes ?? null,
          reassignmentRequired: true,
        },
      },
      tx,
    );

    await notifyWorkOrderAssignmentDeclined(
      workOrder,
      lockedAssignment,
      input.actorUserId,
      respondedAt,
      declineReason,
      tx,
    );

    return toPublicWorkOrderAssignment(lockedAssignment, updatedResponse);
  });
}

export async function listWorkOrderAssignmentResponseHistory(
  workOrderId: string,
  assignmentId: string,
): Promise<PublicAssignmentResponseEvent[]> {
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  const assignment =
    await workOrderAssignmentRepository.findById(assignmentId);
  if (!assignment || assignment.workOrderId !== workOrder.id) {
    throw workOrderAssignmentNotFoundError();
  }

  await assignmentResponseRepository.ensurePendingForAssignment({
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
    assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
    assignmentId: assignment.id,
    workOrderId: workOrder.id,
    assignedByUserId: assignment.assignedByUserId,
    assignedAt: assignment.assignedAt,
  });

  const events = await assignmentResponseRepository.listEventsByAssignmentId(
    assignment.id,
  );
  return events.map(toPublicAssignmentResponseEvent);
}

function isActiveAssignmentUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'work_order_active_assignment_unique'
  );
}

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2E — revalidate the ACTIVE assignment
 * against a NEW trade classification.
 *
 * Called by the classification authority (`classifyWorkOrder`) INSIDE its own
 * transaction, after the new classification columns are written and before the
 * commit. The SAME evaluator, the SAME subject rules (ALL for a person/team,
 * ANY for a company) and the SAME ledger as assignment/reassignment are used —
 * this is not a second workflow, it is the existing gate applied to a fact
 * that changed after the gate ran.
 *
 * Outcomes:
 *   no ACTIVE assignment  → nothing to revalidate (classification is only
 *                           future-facing);
 *   MANDATORY gap         → `WORK_ORDER_CLASSIFICATION_CONFLICT` (409), thrown
 *                           so the classification itself rolls back. The
 *                           running job is never silently invalidated;
 *   any other outcome     → the classification stands and the evaluation is
 *                           appended to the ledger as `RECLASSIFIED`
 *                           (RECOMMENDED gaps included, as warnings).
 */
export async function revalidateActiveAssignmentForClassification(
  executor: Pick<PoolClient, 'query'>,
  input: {
    workOrderId: string;
    clientId: string;
    tradeCategoryId: string;
    tradeCategoryCode: string;
    riskLevel: WorkOrderTradeRiskLevel | null;
  },
): Promise<{
  assignmentId: string | null;
  satisfied: boolean;
  mandatoryRequirementCount: number;
  advisory: WorkOrderAssignmentCompetencyWarning[];
}> {
  const active = await workOrderAssignmentRepository.findActiveByWorkOrderId(
    input.workOrderId,
    executor,
  );
  if (!active) {
    return {
      assignmentId: null,
      satisfied: true,
      mandatoryRequirementCount: 0,
      advisory: [],
    };
  }

  const gateWorkOrder: CompetencyGateWorkOrder = {
    id: input.workOrderId,
    clientId: input.clientId,
    tradeCategoryId: input.tradeCategoryId,
    tradeCategoryCode: input.tradeCategoryCode,
    riskLevel: input.riskLevel,
  };

  const target: AssignmentSubjectTarget = {
    assigneeType: active.assigneeType,
    workforceProfileId: active.workforceProfileId ?? undefined,
    teamId: active.teamId ?? undefined,
    vendorId: active.vendorId ?? undefined,
  };

  const { subjects, rule } = await resolveAssignmentSubjects(gateWorkOrder, target);
  const decision = await workOrderCompetencyService.evaluateWorkOrderCompetency(
    executor,
    {
      clientId: input.clientId,
      tradeCategoryId: input.tradeCategoryId,
      tradeCategoryCode: input.tradeCategoryCode,
      subjects,
      rule,
    },
  );

  if (!decision.satisfied) {
    throw workOrderClassificationConflictError(
      decision.blocking.map((gap) => ({
        workforceProfileId: gap.workforceProfileId,
        workforceProfileName: gap.workforceProfileName,
        requirementId: gap.requirementId,
        requirementType: gap.requirementType,
        enforcementLevel: gap.enforcementLevel,
        skillCode: gap.skillCode,
        certificateName: gap.certificateName,
        minimumProficiencyLevel: gap.minimumProficiencyLevel,
        reason: gap.reason,
        rule: decision.rule,
      })),
    );
  }

  await workOrderCompetencyService.recordWorkOrderCompetencyDecision(executor, {
    clientId: input.clientId,
    workOrderId: input.workOrderId,
    assignmentId: active.id,
    action: 'RECLASSIFIED',
    assigneeType: active.assigneeType,
    tradeCategoryId: decision.tradeCategoryId,
    tradeCategoryCode: decision.tradeCategoryCode,
    riskLevel: input.riskLevel,
    rows: decision.rows,
  });

  const subjectNames = new Map(
    subjects.map((subject) => [
      subject.workforceProfileId,
      subject.workforceProfileName,
    ]),
  );

  return {
    assignmentId: active.id,
    satisfied: decision.satisfied,
    mandatoryRequirementCount: decision.summary.mandatoryRequirementCount,
    advisory: decision.rows
      .filter((row) => !row.satisfied && row.enforcementLevel === 'RECOMMENDED')
      .map((row) => ({
        workforceProfileId: row.workforceProfileId,
        workforceProfileName: subjectNames.get(row.workforceProfileId) ?? null,
        requirementId: row.requirementId,
        requirementType: row.requirementType,
        skillCode: row.skillCode,
        certificateName: row.certificateName,
        minimumProficiencyLevel: row.minimumProficiencyLevel,
        reason: row.reason ?? 'REQUIREMENT_NOT_MET',
      })),
  };
}

export const workOrderAssignmentService = {
  assignWorkOrder,
  deactivateWorkOrderAssignment,
  getCurrentWorkOrderAssignment,
  isActorAuthorizedForAssignment,
  listWorkOrderAssignmentResponseHistory,
  listWorkOrderAssignments,
  reassignWorkOrder,
  respondToWorkOrderAssignment,
  revalidateActiveAssignmentForClassification,
  toPublicWorkOrderAssignment,
};
