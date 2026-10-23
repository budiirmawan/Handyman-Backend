import { withTransaction } from '../../database';
import { satisfyClock } from '../applied-slas/sla-clock-lifecycle.service';
import {
  assignmentResponseConflictError,
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
  workOrderAssignmentAlreadyAssignedError,
  workOrderAssignmentBuildingMismatchError,
  workOrderAssignmentClientMismatchError,
  workOrderAssignmentInvalidStateError,
  workOrderAssignmentNotFoundError,
  workOrderAssignmentVendorWorkforceMismatchError,
} from './work-order-assignment.errors';
import { workOrderAssignmentRepository } from './work-order-assignment.repository';
import {
  isWorkOrderAssignableStatus,
  type AssignWorkOrderInput,
  type NewWorkOrderAssignment,
  type PublicWorkOrderAssignment,
  type RespondToWorkOrderAssignmentInput,
  type WorkOrderAssignmentRecord,
} from './work-order-assignment.types';

export function toPublicWorkOrderAssignment(
  record: WorkOrderAssignmentRecord,
  response?: HandymanAssignmentResponseRecord | null,
): PublicWorkOrderAssignment {
  const responseStatus = response?.responseStatus ?? 'PENDING';
  return {
    id: record.id,
    workOrderId: record.workOrderId,
    assigneeType: record.assigneeType,
    workforceProfileId: record.workforceProfileId,
    teamId: record.teamId,
    vendorId: record.vendorId,
    assignedByUserId: record.assignedByUserId,
    assignedAt: record.assignedAt.toISOString(),
    status: record.status,
    responseStatus,
    respondedByUserId: response?.respondedByUserId ?? null,
    respondedAt: response?.respondedAt
      ? response.respondedAt.toISOString()
      : null,
    declineReason: response?.declineReason ?? null,
    responseNotes: response?.responseNotes ?? null,
    reassignmentRequired:
      record.status === 'ACTIVE' && responseStatus === 'TIDAK_BISA',
  };
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
  const relationship =
    await vendorBuildingRepository.findActiveByVendorAndBuilding(
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
  const relationship =
    await vendorBuildingRepository.findActiveByVendorAndBuilding(
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
    throw workOrderAssignmentVendorWorkforceMismatchError();
  }
  return value;
}

async function loadAssignableWorkOrder(
  workOrderId: string,
): Promise<WorkOrderRecord> {
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  if (!isWorkOrderAssignableStatus(workOrder.status)) {
    throw workOrderAssignmentInvalidStateError(workOrder.status);
  }
  return workOrder;
}

/**
 * Assigns a Work Order to a Workforce / Team / Vendor / Vendor Workforce.
 * The Work Order must be in an assignable lifecycle state, and the assignee
 * must resolve to the same Client (and, where applicable, Building) context.
 * A Work Order with an existing ACTIVE assignment is rejected (409) — it must
 * be reassigned through the dedicated reassign flow.
 *
 * Atomically creates the assignment, initializes its `PENDING` response state
 * and `ASSIGNMENT_PENDING_CREATED` history event, records the operational
 * event, and writes the `IN_APP` notification(s) inside a single transaction.
 */
export async function assignWorkOrder(
  input: AssignWorkOrderInput,
): Promise<PublicWorkOrderAssignment> {
  const workOrder = await loadAssignableWorkOrder(input.workOrderId);

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
          metadata: {
            assignmentId: record.id,
            assigneeType: input.assigneeType,
            responseStatus: pendingResponse.responseStatus,
          },
        },
        tx,
      );

      await notifyWorkOrderAssignedPending(workOrder, record, tx);

      return toPublicWorkOrderAssignment(record, pendingResponse);
    });
  } catch (error) {
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
 * historical response, creates the new ACTIVE assignment with a `PENDING`
 * response, and emits deduplicated `IN_APP` notifications in a single
 * transaction.
 */
export async function reassignWorkOrder(
  workOrderId: string,
  input: AssignWorkOrderInput,
  expectedAssignmentId?: string,
): Promise<PublicWorkOrderAssignment> {
  const workOrder = await loadAssignableWorkOrder(workOrderId);

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
            assignmentId: record.id,
            assigneeType: input.assigneeType,
            responseStatus: pendingResponse.responseStatus,
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

      return toPublicWorkOrderAssignment(record, pendingResponse);
    });
  } catch (error) {
    if (isActiveAssignmentUniqueViolation(error)) {
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

export const workOrderAssignmentService = {
  assignWorkOrder,
  deactivateWorkOrderAssignment,
  getCurrentWorkOrderAssignment,
  isActorAuthorizedForAssignment,
  listWorkOrderAssignmentResponseHistory,
  listWorkOrderAssignments,
  reassignWorkOrder,
  respondToWorkOrderAssignment,
  toPublicWorkOrderAssignment,
};
