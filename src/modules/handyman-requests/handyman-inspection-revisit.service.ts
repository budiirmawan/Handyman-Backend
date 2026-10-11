import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../database';
import { recordOperationalEvent } from '../operational-events';
import { handymanRequestInspectionRepository as inspections } from './handyman-request-inspection.repository';
import { handymanRequestInspectionReportRepository as reports } from './handyman-request-inspection-report.repository';
import { handymanRequestInspectionAssignmentRepository as assignments } from './handyman-request-inspection-assignment.repository';
import { handymanSchedulingReadinessRepository as readiness } from '../handyman-scheduling/handyman-scheduling.repository';
import { handymanInspectionAssignmentTargetInvalidError } from './handyman-request-inspection-assignment.errors';
import { assertPrequotation, lockScopedRequest, prequotationConflict, requireOperations, requireReason, requireUuid } from './handyman-prequotation-operations.service';

export type PlanInspectionRevisitInput = {
  handymanRequestId: string;
  precedingInspectionId: string;
  precedingReportId: string;
  assignedFieldUserId: string;
  schedulingReadinessId: string;
  reason: string;
};

/** Request lock serializes review, cancellation, preparation and each retry.
 * Readiness is a preferred window VERSION, never a confirmed scope booking.
 */
export async function planHandymanInspectionRevisit(input: PlanInspectionRevisitInput, actor: string) {
  for (const field of ['handymanRequestId','precedingInspectionId','precedingReportId','assignedFieldUserId','schedulingReadinessId'] as const) requireUuid(input[field], field);
  const reason = requireReason(input.reason);
  return withTransaction(async tx => {
    await requireOperations(tx, actor, ['handyman.operations.inspection.assign', 'handyman.operations.inspection.report.review']);
    const request = await lockScopedRequest(tx, input.handymanRequestId, actor);
    await assertPrequotation(tx, request);
    const inspection = await inspections.findByRequest(tx, request.id);
    const latest = await reports.findLatestByRequest(tx, request.id);
    const review = latest ? await reports.findReviewByReport(tx, latest.id) : null;
    const diagnosed = await tx.query('SELECT 1 FROM handyman_request_diagnoses WHERE handyman_request_id=$1', [request.id]);
    if (request.status !== 'DIAGNOSIS' || !inspection || inspection.id !== input.precedingInspectionId ||
        inspection.inspectionResult !== 'NOT_INSPECTABLE' || !latest || latest.id !== input.precedingReportId ||
        latest.handymanRequestInspectionId !== inspection.id || review?.decision !== 'ACCEPTED' || diagnosed.rowCount) {
      throw prequotationConflict('Revisit requires the latest unsuccessful physical attempt and its accepted report, before diagnosis or quotation.');
    }
    const window = await readiness.findById(tx, input.schedulingReadinessId);
    if (!window || window.handymanRequestId !== request.id || window.clientId !== request.clientId || window.status !== 'ACTIVE') {
      throw prequotationConflict('Select the active preferred-window readiness version of this request.');
    }
    if (!(await assignments.isActiveUser(tx, input.assignedFieldUserId)) ||
        !(await assignments.hasActivePermission(tx, input.assignedFieldUserId, 'handyman.field.inspection.report.submit')) ||
        !(await assignments.hasActiveBuildingAssignment(tx, input.assignedFieldUserId, request.buildingId))) {
      throw handymanInspectionAssignmentTargetInvalidError();
    }
    const previous = await assignments.findActiveByRequest(tx, request.id);
    if (!previous) throw prequotationConflict('The preceding attempt must retain its assignment chain.');
    const assignmentId = randomUUID();
    // Always a NEW assignment, even if Operations selects the same Field user.
    await assignments.supersedeAssignment(tx, { assignmentId: previous.id, supersededByAssignmentId: assignmentId, reason });
    await assignments.insertAssignment(tx, { id: assignmentId, clientId: request.clientId,
      handymanRequestId: request.id, channelAttributionId: request.channelAttributionId, buildingId: request.buildingId,
      assignedFieldUserId: input.assignedFieldUserId, assignedByUserId: actor,
      supersedesAssignmentId: previous.id, supersessionReason: null });
    const id = randomUUID();
    const result = await tx.query(`INSERT INTO handyman_inspection_revisit_attempts
      (id,handyman_request_id,attempt_number,preceding_inspection_id,preceding_report_id,
       inspection_assignment_id,scheduling_readiness_id,reason,planned_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING planned_at AS "plannedAt"`,
      [id, request.id, inspection.attemptNumber+1, inspection.id, latest.id, assignmentId, window.id, reason, actor]);
    await recordOperationalEvent({ clientId: request.clientId, buildingId: request.buildingId,
      entityType: 'HANDYMAN_SERVICE_REQUEST', entityId: request.id, actorUserId: actor,
      eventType: 'HANDYMAN_INSPECTION_REVISIT_PLANNED', summary: 'Operations planned an inspection revisit using preferred-window readiness.',
      metadata: { revisitAttemptId: id, attemptNumber: inspection.attemptNumber+1, precedingInspectionId: inspection.id,
        precedingReportId: latest.id, assignmentId, supersededAssignmentId: previous.id, schedulingReadinessId: window.id, reason } }, tx);
    return { id, handymanRequestId: request.id, attemptNumber: inspection.attemptNumber+1,
      precedingInspectionId: inspection.id, precedingReportId: latest.id, inspectionAssignmentId: assignmentId,
      schedulingReadinessId: window.id, reason, plannedByUserId: actor, plannedAt: result.rows[0].plannedAt,
      schedulingAuthority: 'PREFERRED_WINDOW_ONLY' as const };
  });
}

export async function getHandymanInspectionAttempts(id: string, actor: string) {
  return withTransaction(async tx => {
    await lockScopedRequest(tx, id, actor);
    const attempts = await tx.query(`SELECT ra.*, sr.preferred_window_start, sr.preferred_window_end, sr.timezone
      FROM handyman_inspection_revisit_attempts ra JOIN handyman_scheduling_readiness sr ON sr.id=ra.scheduling_readiness_id
      WHERE ra.handyman_request_id=$1 ORDER BY ra.attempt_number`, [id]);
    const physical = await tx.query('SELECT * FROM handyman_request_inspections WHERE handyman_request_id=$1 ORDER BY attempt_number', [id]);
    return { schedulingAuthority: 'PREFERRED_WINDOW_ONLY', revisits: attempts.rows, inspections: physical.rows };
  });
}
