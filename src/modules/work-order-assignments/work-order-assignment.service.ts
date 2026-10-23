import {
  teamInactiveError,
  teamNotFoundError,
  teamRepository,
} from '../teams';
import {
  vendorInactiveError,
  vendorNotFoundError,
  vendorRepository,
} from '../vendors';
import {
  vendorWorkforceRepository,
} from '../vendor-workforce';
import {
  workOrderNotFoundError,
  workOrderRepository,
} from '../work-orders';
import { recordWorkOrderEvent } from '../work-order-history';
import {
  workforceProfileInactiveError,
  workforceProfileNotFoundError,
  workforceRepository,
} from '../workforce';
import { withTransaction } from '../../database';
import type { PoolClient } from 'pg';
import { departmentRepository } from '../departments';
import { organizationRepository } from '../organizations';
import { workforceBuildingAssignmentRepository } from '../workforce-building-assignments';
import { vendorBuildingRepository } from '../vendor-buildings';
import {
  workOrderCompetencyService,
  type WorkOrderCompetencyDecision,
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
  type UpdateWorkOrderAssignmentInput,
  type WorkOrderAssignmentCompetencyOutcome,
  type WorkOrderAssignmentCompetencyWarning,
  type WorkOrderAssignmentRecord,
} from './work-order-assignment.types';

export function toPublicWorkOrderAssignment(
  record: WorkOrderAssignmentRecord,
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
  };
  // PART 03B2B — the RECOMMENDED warnings of the decision just taken. Omitted
  // on plain reads so the pre-existing payload stays untouched there.
  if (competency !== undefined) {
    assignment.competency = competency;
  }
  return assignment;
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

type AssignableWorkOrder = {
  id: string;
  clientId: string;
  buildingId: string;
  status: string;
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
    id: workOrder.id,
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
    status: workOrder.status,
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
 * Runs INSIDE the assignment transaction: the decision ledger row and the
 * assignment commit together, so a refused assignment leaves neither a
 * half-written assignment nor a decision that never happened. When the Work
 * Order is unclassified (or its trade has no ACTIVE requirement) the decision
 * is unrestricted and nothing is written.
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
  input: AssignWorkOrderInput,
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
    subjects.map((subject) => [subject.workforceProfileId, subject.workforceProfileName]),
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
 * Assigns a Work Order to a Workforce / Team / Vendor / Vendor Workforce.
 * The Work Order must be in an assignable lifecycle state, and the assignee
 * must resolve to the same Client (and, where applicable, Building) context.
 * A Work Order with an existing ACTIVE assignment is rejected (409) — it must
 * be reassigned through the dedicated reassign flow.
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
    // PART 03B2A — assignment + audit event + competency decision are ONE
    // transaction. A competency refusal (409) rolls the assignment back, so a
    // Work Order can never end up assigned to someone the gate rejected.
    return await withTransaction(async (tx) => {
      const record = await workOrderAssignmentRepository.create(
        newAssignment,
        tx,
      );
      const competency = await applyCompetencyGate(
        tx,
        workOrder,
        input,
        record.id,
        'ASSIGNED',
      );
      await recordWorkOrderEvent(
        {
          workOrderId: input.workOrderId,
          clientId: workOrder.clientId,
          buildingId: workOrder.buildingId,
          eventType: 'WORK_ORDER_ASSIGNED',
          actorUserId: input.assignedByUserId,
          summary: `Work order assigned to ${input.assigneeType}`,
          metadata: {
            assigneeType: input.assigneeType,
            tradeCategoryId: workOrder.tradeCategoryId,
            tradeCategoryCode: workOrder.tradeCategoryCode,
            riskLevel: workOrder.riskLevel,
            competency: {
              rule: competency.rule,
              satisfied: competency.satisfied,
              mandatoryRequirementCount: competency.mandatoryRequirementCount,
              advisoryCount: competency.advisory.length,
            },
          },
        },
        tx,
      );
      return toPublicWorkOrderAssignment(record, competency);
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
  return record ? toPublicWorkOrderAssignment(record) : null;
}

/** Lists all (active + historical) assignments of a Work Order. */
export async function listWorkOrderAssignments(
  workOrderId: string,
): Promise<PublicWorkOrderAssignment[]> {
  const records = await workOrderAssignmentRepository.listByWorkOrderId(
    workOrderId,
  );
  return records.map((record) => toPublicWorkOrderAssignment(record));
}

/**
 * Deactivates an ACTIVE assignment (it is never deleted — history is kept).
 * Re-deactivating an already-INACTIVE assignment is a no-op success.
 */
export async function deactivateWorkOrderAssignment(
  workOrderId: string,
  assignmentId: string,
): Promise<PublicWorkOrderAssignment> {
  const record = await workOrderAssignmentRepository.findById(assignmentId);
  if (!record) {
    throw workOrderAssignmentNotFoundError();
  }
  if (record.workOrderId !== workOrderId) {
    throw workOrderAssignmentNotFoundError();
  }
  const updated = await workOrderAssignmentRepository.updateStatus(
    assignmentId,
    'INACTIVE',
  );
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (workOrder) {
    await recordWorkOrderEvent({
      workOrderId,
      clientId: workOrder.clientId,
      buildingId: workOrder.buildingId,
      eventType: 'WORK_ORDER_ASSIGNMENT_DEACTIVATED',
      summary: 'Work order assignment deactivated',
      metadata: { assigneeType: record.assigneeType },
    });
  }
  return toPublicWorkOrderAssignment(updated as WorkOrderAssignmentRecord);
}

/**
 * Reassigns a Work Order: deactivates its current ACTIVE assignment (if any)
 * and assigns the new assignee. Reusing the assignee validation, this keeps
 * one active assignment invariant intact.
 */
export async function reassignWorkOrder(
  workOrderId: string,
  input: AssignWorkOrderInput,
): Promise<PublicWorkOrderAssignment> {
  const workOrder = await loadAssignableWorkOrder(workOrderId);
  // PART 03B2E — a reassignment is a NEW assignment decision, so the
  // classification must already exist (an unclassified Work Order is not an
  // unrestricted one).
  assertClassificationPresent(workOrder);

  const newAssignment = await resolveAssignee(workOrder, {
    ...input,
    workOrderId,
  });

  try {
    return await withTransaction(async (tx) => {
      const current =
        await workOrderAssignmentRepository.findActiveByWorkOrderId(
          workOrderId,
          tx,
        );
      if (current) {
        await workOrderAssignmentRepository.updateStatus(
          current.id,
          'INACTIVE',
          tx,
        );
      }

      const record = await workOrderAssignmentRepository.create(
        newAssignment,
        tx,
      );
      const competency = await applyCompetencyGate(
        tx,
        workOrder,
        input,
        record.id,
        'REASSIGNED',
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
            assigneeType: input.assigneeType,
            tradeCategoryId: workOrder.tradeCategoryId,
            tradeCategoryCode: workOrder.tradeCategoryCode,
            riskLevel: workOrder.riskLevel,
            competency: {
              rule: competency.rule,
              satisfied: competency.satisfied,
              mandatoryRequirementCount: competency.mandatoryRequirementCount,
              advisoryCount: competency.advisory.length,
            },
          },
        },
        tx,
      );
      return toPublicWorkOrderAssignment(record, competency);
    });
  } catch (error) {
    if (isActiveAssignmentUniqueViolation(error)) {
      // Extremely unlikely (we just deactivated); surface as already assigned.
      throw workOrderAssignmentAlreadyAssignedError();
    }
    throw error;
  }
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
  listWorkOrderAssignments,
  reassignWorkOrder,
  revalidateActiveAssignmentForClassification,
  toPublicWorkOrderAssignment,
};
