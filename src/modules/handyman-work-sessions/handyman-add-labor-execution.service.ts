import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { assignmentResponseRepository, handymanAssignmentDeclinedError } from '../assignment-responses';
import { handymanDispatchService } from '../handyman-dispatch';
import { assertVerifiedManagedEvidenceReference } from '../handyman-field-evidence/handyman-field-evidence.service';
import { handymanExecutionScopeNotFoundError } from '../handyman-quotations';
import { handymanScopeAssignmentRepository, resolveHandymanAssignmentLead } from '../handyman-scope-assignments';
import { resolveApprovedAddLabor } from '../handyman-scope-variations/handyman-scope-variation-labor-authority';
import {
  handymanWorkSessionIllegalTransitionError, handymanWorkSessionNotAuthorizedError,
  handymanWorkSessionNotFoundError, handymanWorkSessionScopeNotEligibleError,
} from './handyman-work-session.errors';

/** Exactly one measured declaration per variation/session. Partial work may be
 * recorded in different real sessions, never inferred from the session clock or
 * helper attendance. The quotation line is the immutable service identity. */
export type RecordAddLaborInput = {
  executionScopeId: string;
  sessionId: string;
  variationId: unknown;
  approvedVariationVersion: unknown;
  quotationLineId: unknown;
  workOrderId: unknown;
  quantity: unknown;
  evidenceReference: unknown;
  idempotencyKey: unknown;
};

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) throw AppError.validation(`${field} must be a UUID.`);
  return value.trim().toLowerCase();
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > max) {
    throw AppError.validation(`${field} is required (maximum ${max} characters).`);
  }
  return value.trim();
}
function safeRecord(row: QueryResultRow) {
  return {
    id: row.id as string,
    executionScopeId: row.execution_scope_id as string,
    variationId: row.variation_id as string,
    approvedVariationVersion: Number(row.approved_variation_version),
    quotationVersionId: row.quotation_version_id as string,
    quotationLineId: row.quotation_line_id as string,
    workOrderId: row.work_order_id as string,
    workSessionId: row.work_session_id as string,
    assignmentId: row.assignment_id as string,
    leadWorkerId: row.lead_worker_id as string,
    leadUserId: row.lead_user_id as string,
    uomId: row.uom_id as string,
    approvedQty: Number(row.approved_qty),
    actualQty: Number(row.actual_qty),
    evidenceReference: row.evidence_reference as string,
    evidenceSha256: row.evidence_sha256 as string,
    recordedAt: (row.recorded_at as Date).toISOString(),
  };
}

async function lockedAuthority(tx: PoolClient, scopeId: string, actorId: string) {
  const scope = await handymanScopeAssignmentRepository.lockScopeById(tx, scopeId);
  if (!scope) throw handymanExecutionScopeNotFoundError();
  const lead = await resolveHandymanAssignmentLead(scopeId, actorId, tx);
  if (!lead || lead.leadUserId !== actorId) throw handymanWorkSessionNotAuthorizedError();
  const response = await assignmentResponseRepository.findByAssignmentId(lead.assignmentId, tx);
  if (response?.responseStatus === 'TIDAK_BISA') throw handymanAssignmentDeclinedError();
  return { scope, lead };
}

export async function recordAddLaborExecution(input: RecordAddLaborInput, actorUserId: string) {
  const scopeId = uuid(input.executionScopeId, 'executionScopeId');
  const sessionId = uuid(input.sessionId, 'sessionId');
  const variationId = uuid(input.variationId, 'variationId');
  const quotationLineId = uuid(input.quotationLineId, 'quotationLineId');
  const workOrderId = uuid(input.workOrderId, 'workOrderId');
  const actorId = uuid(actorUserId, 'actorUserId');
  const idempotencyKey = text(input.idempotencyKey, 'idempotencyKey', 128);
  const evidenceReference = text(input.evidenceReference, 'evidenceReference', 500);
  const approvedVersion = input.approvedVariationVersion;
  if (typeof approvedVersion !== 'number' || !Number.isSafeInteger(approvedVersion) || approvedVersion < 1) {
    throw AppError.validation('approvedVariationVersion must be a positive integer.');
  }
  const quantity = input.quantity;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0.001 ||
      quantity > 99999999999.999 || Number(quantity.toFixed(3)) !== quantity) {
    throw AppError.validation('quantity must be positive with at most three decimal places.');
  }

  return withTransaction(async (tx) => {
    const { scope, lead } = await lockedAuthority(tx, scopeId, actorId);
    if (scope.status !== 'AUTHORIZED') throw handymanWorkSessionScopeNotEligibleError();
    const sessionResult = await tx.query(`SELECT id, assignment_id, lead_worker_id, lead_user_id, status, started_work_at
      FROM handyman_work_sessions WHERE id=$1 AND execution_scope_id=$2 FOR UPDATE`, [sessionId, scopeId]);
    const session = sessionResult.rows[0];
    if (!session) throw handymanWorkSessionNotFoundError();
    if (session.assignment_id !== lead.assignmentId || session.lead_user_id !== actorId ||
        session.lead_worker_id !== lead.leadWorkerContextId) {
      throw handymanWorkSessionNotAuthorizedError();
    }
    const authority = await resolveApprovedAddLabor(tx, scopeId, variationId, approvedVersion);
    if (authority.binding.revisedQuotationLineId !== quotationLineId || authority.binding.workOrderId !== workOrderId) {
      throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_ADD_LABOR_BINDING_MISMATCH,
        message: 'Labor must match the exact consented quotation line and Work Order.' });
    }

    const previous = await tx.query(`SELECT * FROM handyman_add_labor_executions
      WHERE variation_id=$1 AND idempotency_key=$2`, [variationId, idempotencyKey]);
    if (previous.rows[0]) {
      const row = previous.rows[0];
      if (row.work_session_id !== sessionId || row.lead_user_id !== actorId ||
          Number(row.approved_variation_version) !== approvedVersion || row.quotation_line_id !== quotationLineId ||
          row.work_order_id !== workOrderId || Number(row.actual_qty) !== quantity || row.evidence_reference !== evidenceReference) {
        throw new AppError({ statusCode: 409, code: ERROR_CODES.IDEMPOTENCY_CONFLICT,
          message: 'The idempotency key is already bound to different labor execution facts.' });
      }
      return { execution: safeRecord(row), replayed: true };
    }
    if (session.status !== 'IN_PROGRESS' || !session.started_work_at) {
      throw handymanWorkSessionIllegalTransitionError(session.status, 'ADD_LABOR_EXECUTION');
    }
    // Reuse the same current dispatch, roster-lock, permit and access contract
    // as START_WORK/RESUME. This also locks the crew against lead transfers.
    await handymanDispatchService.assertDispatchExecutionClearance(tx, scopeId, actorId, lead.assignmentId);
    const confirmed = await resolveHandymanAssignmentLead(scopeId, actorId, tx);
    if (!confirmed || confirmed.leadUserId !== actorId || confirmed.assignmentId !== lead.assignmentId ||
        confirmed.leadWorkerContextId !== session.lead_worker_id) throw handymanWorkSessionNotAuthorizedError();

    const evidence = await assertVerifiedManagedEvidenceReference(tx, {
      clientId: scope.clientId, buildingId: scope.buildingId,
      handymanRequestId: scope.handymanRequestId, executionScopeId: scopeId,
    }, evidenceReference);
    if (!evidence || evidence.purpose !== 'BEFORE_AFTER_WORK') {
      throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_ADD_LABOR_EVIDENCE_INVALID,
        message: 'ADD labor requires verified before/after work evidence.' });
    }
    const evidenceBinding = await tx.query(`SELECT 1 FROM handyman_field_evidence_uploads
      WHERE id=$1 AND execution_scope_id=$2 AND (variation_id IS NULL OR variation_id=$3)
        AND verified_at >= $4`, [evidence.id, scopeId, variationId, session.started_work_at]);
    if (!evidenceBinding.rows[0]) {
      throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_ADD_LABOR_EVIDENCE_INVALID,
        message: 'Work evidence must match this scope and variation and be verified after work started.' });
    }
    const duplicates = await tx.query(`SELECT 1 FROM handyman_add_labor_executions
      WHERE (variation_id=$1 AND work_session_id=$2) OR evidence_id=$3
      UNION ALL SELECT 1 FROM handyman_completion_declarations d
      LEFT JOIN handyman_completion_revocations r ON r.declaration_id=d.id
      WHERE d.execution_scope_id=$4 AND r.id IS NULL
        AND (d.evidence_id=$3 OR (d.variation_id=$1 AND d.actual_qty=0)) LIMIT 1`,
    [variationId, sessionId, evidence.id, scopeId]);
    if (duplicates.rows[0]) {
      throw new AppError({ statusCode: 409, code: ERROR_CODES.HANDYMAN_ADD_LABOR_DUPLICATE,
        message: 'This variation already has a declaration for the session or this work evidence has been used.' });
    }
    const amount = await tx.query<{ allowed: boolean }>(`SELECT
      COALESCE(SUM(actual_qty), 0) + $2::numeric <= $3::numeric AS allowed
      FROM handyman_add_labor_executions WHERE variation_id=$1`, [variationId, quantity, authority.variation.quantity]);
    if (!amount.rows[0].allowed) {
      throw new AppError({ statusCode: 400, code: ERROR_CODES.HANDYMAN_ADD_LABOR_QUANTITY_EXCEEDED,
        message: 'Actual ADD labor cannot exceed its approved quantity.' });
    }
    const inserted = await tx.query(`INSERT INTO handyman_add_labor_executions
      (id,client_id,execution_scope_id,variation_id,approved_variation_version,quotation_version_id,
       quotation_line_id,work_order_id,work_session_id,assignment_id,lead_worker_id,lead_user_id,uom_id,
       approved_qty,actual_qty,evidence_id,evidence_reference,evidence_sha256,idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [randomUUID(), scope.clientId, scopeId, variationId, approvedVersion, authority.variation.revisedQuotationVersionId,
      quotationLineId, workOrderId, sessionId, lead.assignmentId, lead.leadWorkerContextId, actorId, authority.variation.uomId,
      authority.variation.quantity, quantity, evidence.id, evidenceReference, evidence.sha256Checksum, idempotencyKey]);
    return { execution: safeRecord(inserted.rows[0]), replayed: false };
  });
}

export async function listAddLaborExecutions(executionScopeId: string, workSessionId: string, actorUserId: string) {
  const scopeId = uuid(executionScopeId, 'executionScopeId');
  const sessionId = uuid(workSessionId, 'sessionId');
  const actorId = uuid(actorUserId, 'actorUserId');
  return withTransaction(async (tx) => {
    await lockedAuthority(tx, scopeId, actorId);
    const session = await tx.query('SELECT id FROM handyman_work_sessions WHERE id=$1 AND execution_scope_id=$2', [sessionId, scopeId]);
    if (!session.rows[0]) throw handymanWorkSessionNotFoundError();
    const rows = await tx.query(`SELECT * FROM handyman_add_labor_executions
      WHERE execution_scope_id=$1 AND work_session_id=$2 ORDER BY recorded_at,id`, [scopeId, sessionId]);
    return rows.rows.map(safeRecord);
  });
}
