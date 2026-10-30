import { lockReworkDispatchLineage } from '../handyman-dispatch/handyman-rework-dispatch';
import { handymanDispatchService } from '../handyman-dispatch';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { contextAccessService } from '../context-access/context-access.service';
import { permissionService } from '../permissions';
import { recordOperationalEvent } from '../operational-events';
import {
  createEvidenceStorage,
  evidenceStorageKey,
} from '../evidence/storage';
import { computeEvidenceSha256 } from '../evidence/evidence-integrity';
import { resolveHandymanAssignmentLead } from '../handyman-scope-assignments/handyman-scope-assignment.service';
import { findEligibleHandymanWorker } from '../handyman-providers/handyman-worker-eligibility.repository';
import { handymanFieldEvidenceRepository } from './handyman-field-evidence.repository';
import {
  buildPaginationMeta,
  parsePagination,
  type PaginationMeta,
} from '../../shared/pagination';
import {
  handymanWorkSessionNotAuthorizedError,
  handymanWorkSessionNotFoundError,
} from '../handyman-work-sessions';
import {
  HANDYMAN_FIELD_EVIDENCE_MAX_BYTES,
  HANDYMAN_FIELD_EVIDENCE_MIME_TYPES,
  HANDYMAN_FIELD_EVIDENCE_PURPOSES,
  type HandymanFieldEvidenceMimeType,
  type HandymanFieldEvidencePurpose,
  type HandymanFieldEvidenceUploadRecord,
  type HandymanFieldEvidenceUploadStatus,
  type HandymanScopeEvidenceItem,
} from './handyman-field-evidence.types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw AppError.validation(`${field} must be a valid UUID.`);
  }
  return value;
}

function assertNonEmptyText(
  value: unknown,
  field: string,
  maxLen: number,
): string {
  if (typeof value !== 'string') {
    throw AppError.validation(`${field} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maxLen) {
    throw AppError.validation(
      `${field} must be between 1 and ${maxLen} characters.`,
    );
  }
  return trimmed;
}

function assertPurpose(value: unknown): HandymanFieldEvidencePurpose {
  if (
    typeof value !== 'string' ||
    !(HANDYMAN_FIELD_EVIDENCE_PURPOSES as readonly string[]).includes(value)
  ) {
    throw AppError.validation(
      `purpose must be one of: ${HANDYMAN_FIELD_EVIDENCE_PURPOSES.join(', ')}.`,
    );
  }
  return value as HandymanFieldEvidencePurpose;
}

function assertMimeType(value: unknown): HandymanFieldEvidenceMimeType {
  if (
    typeof value !== 'string' ||
    !(HANDYMAN_FIELD_EVIDENCE_MIME_TYPES as readonly string[]).includes(value)
  ) {
    throw AppError.validation(
      `mimeType must be one of: ${HANDYMAN_FIELD_EVIDENCE_MIME_TYPES.join(', ')}.`,
    );
  }
  return value as HandymanFieldEvidenceMimeType;
}

function verifyBinaryMagicSignature(
  bytes: Buffer,
  mimeType: HandymanFieldEvidenceMimeType,
): void {
  if (!bytes || bytes.byteLength === 0) {
    throw new AppError({
      statusCode: 400,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED,
      message:
        'Metadata-only payload rejected: genuine non-empty binary file bytes are required.',
    });
  }
  if (bytes.byteLength > HANDYMAN_FIELD_EVIDENCE_MAX_BYTES) {
    throw AppError.validation(
      `Evidence file exceeds maximum allowed size (${HANDYMAN_FIELD_EVIDENCE_MAX_BYTES} bytes).`,
    );
  }

  if (mimeType === 'image/jpeg') {
    if (
      bytes.byteLength < 3 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[2] !== 0xff
    ) {
      throw AppError.validation(
        'Binary file content does not match declared image/jpeg signature.',
      );
    }
    return;
  }

  if (mimeType === 'image/png') {
    const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (
      bytes.byteLength < 8 ||
      !pngSig.every((b, idx) => bytes[idx] === b)
    ) {
      throw AppError.validation(
        'Binary file content does not match declared image/png signature.',
      );
    }
    return;
  }

  if (mimeType === 'image/webp') {
    if (
      bytes.byteLength < 12 ||
      bytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
      bytes.subarray(8, 12).toString('ascii') !== 'WEBP'
    ) {
      throw AppError.validation(
        'Binary file content does not match declared image/webp signature.',
      );
    }
    return;
  }

  if (mimeType === 'application/pdf') {
    if (
      bytes.byteLength < 5 ||
      bytes.subarray(0, 5).toString('ascii') !== '%PDF-'
    ) {
      throw AppError.validation(
        'Binary file content does not match declared application/pdf signature.',
      );
    }
  }
}

function extensionForMime(mimeType: HandymanFieldEvidenceMimeType): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'application/pdf':
      return 'pdf';
  }
}

interface EvidenceTargetContext {
  clientId: string;
  tenantCompanyId: string;
  buildingId: string;
  handymanRequestId: string;
  executionScopeId: string | null;
}

async function resolveEvidenceTargetContext(
  input: {
    executionScopeId?: unknown;
    handymanRequestId?: unknown;
  },
  tx?: PoolClient,
): Promise<EvidenceTargetContext> {
  const db = tx ?? getPool();

  if (input.executionScopeId !== undefined && input.executionScopeId !== null) {
    const scopeId = assertUuid(input.executionScopeId, 'executionScopeId');
    const res = await db.query<{
      id: string;
      client_id: string;
      tenant_company_id: string;
      building_id: string;
      handyman_request_id: string;
    }>(
      `SELECT id, client_id, tenant_company_id, building_id, handyman_request_id
         FROM handyman_execution_scopes
        WHERE id = $1`,
      [scopeId],
    );
    const scope = res.rows[0];
    if (!scope) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_NOT_FOUND,
        message: 'Handyman execution scope not found.',
      });
    }
    if (
      input.handymanRequestId !== undefined &&
      input.handymanRequestId !== null
    ) {
      const reqId = assertUuid(input.handymanRequestId, 'handymanRequestId');
      if (reqId !== scope.handyman_request_id) {
        throw AppError.validation(
          'handymanRequestId does not match the executionScopeId service request.',
        );
      }
    }
    return {
      clientId: scope.client_id,
      tenantCompanyId: scope.tenant_company_id,
      buildingId: scope.building_id,
      handymanRequestId: scope.handyman_request_id,
      executionScopeId: scope.id,
    };
  }

  if (
    input.handymanRequestId !== undefined &&
    input.handymanRequestId !== null
  ) {
    const reqId = assertUuid(input.handymanRequestId, 'handymanRequestId');
    const res = await db.query<{
      id: string;
      client_id: string;
      tenant_company_id: string;
      building_id: string;
    }>(
      `SELECT id, client_id, tenant_company_id, building_id
         FROM handyman_service_requests
        WHERE id = $1`,
      [reqId],
    );
    const reqRow = res.rows[0];
    if (!reqRow) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_SERVICE_REQUEST_NOT_FOUND,
        message: 'Handyman service request not found.',
      });
    }
    return {
      clientId: reqRow.client_id,
      tenantCompanyId: reqRow.tenant_company_id,
      buildingId: reqRow.building_id,
      handymanRequestId: reqRow.id,
      executionScopeId: null,
    };
  }

  throw AppError.validation(
    'Either executionScopeId or handymanRequestId is required.',
  );
}

/** Staged rework uploads must lock their owner before locking the evidence row. */
async function lockReworkEvidenceOwner(tx: PoolClient, evidenceId: string): Promise<void> {
  const owner=(await tx.query<{execution_scope_id:string}>(`SELECT e.execution_scope_id FROM handyman_field_evidence_uploads e
    JOIN handyman_warranty_rework_executions x ON x.execution_scope_id=e.execution_scope_id WHERE e.id=$1`,[evidenceId])).rows[0];
  if (!owner) return;
  await lockReworkDispatchLineage(tx,owner.execution_scope_id);
  await tx.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE',[owner.execution_scope_id]);
}

/** Recheck write authority under the existing execution-scope lock before
 * accepting evidence mutations. Evidence may precede dispatch or follow completion/QC, but a
 * cancelled release/visit must not authorize NEW uploads by its field Lead.
 */
async function resolveEvidenceWriteActorRole(
  tx: PoolClient, actor: string, target: EvidenceTargetContext,
) {
  if (target.executionScopeId) {
    await lockReworkDispatchLineage(tx, target.executionScopeId);
    await tx.query('SELECT id FROM handyman_execution_scopes WHERE id=$1 FOR UPDATE', [target.executionScopeId]);
  }
  const role = await resolveEvidenceActorRole(actor, target, false, tx);
  if (role === 'PIC_PEKERJAAN' && target.executionScopeId) {
    const lead = await resolveHandymanAssignmentLead(target.executionScopeId, actor, tx);
    if (!lead) throw new AppError({statusCode:403, code:ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN,
      message:'Current execution assignment is required for evidence writes.'});
    const release = (await tx.query<{status:string; state:string | null}>(
      `SELECT dr.status, v.state FROM handyman_dispatch_releases dr
       LEFT JOIN handyman_visit_appointments v ON v.id=dr.appointment_id
       WHERE dr.execution_scope_id=$1 AND dr.assignment_id=$2
       ORDER BY dr.released_at DESC, dr.id DESC LIMIT 1`,
      [target.executionScopeId, lead.assignmentId],
    )).rows[0];
    if (release && (['CANCELLED','SUPERSEDED'].includes(release.status) || release.state === 'CANCELLED')) {
      // Reuse the execution guard for bounded denial; do not invent a new
      // revocation status or treat helperPresence as assignment authority.
      await handymanDispatchService.assertDispatchExecutionClearance(tx, target.executionScopeId, actor, lead.assignmentId);
    }
  }
  return role;
}

async function resolveEvidenceActorRole(
  actorUserId: string,
  target: EvidenceTargetContext,
  allowReadOnlyOps = false,
  tx?: PoolClient,
  purpose?: HandymanFieldEvidencePurpose,
): Promise<'PIC_PEKERJAAN' | 'INSPECTOR' | 'OPERATIONS_MANAGER'> {
  const allowedBuilding =
    await contextAccessService.canAccessBuildingScopedResource(actorUserId, {
      clientId: target.clientId,
      buildingId: target.buildingId,
    });
  if (!allowedBuilding) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.BUILDING_ACCESS_DENIED,
      message: 'Access to the requested building context is denied.',
    });
  }

  const db = tx ?? getPool();

  if (target.executionScopeId) {
    try {
      const lead = await resolveHandymanAssignmentLead(
        target.executionScopeId,
        actorUserId,
        tx,
      );
      if (lead && lead.leadUserId === actorUserId) {
        return 'PIC_PEKERJAAN';
      }
    } catch {
      // Fall through
    }
  }

  const inspRes = await db.query<{ id: string }>(
    `SELECT id
       FROM handyman_visit_appointments
      WHERE client_id = $1
        AND handyman_request_id = $2
        AND kind = 'INSPECTION'
        AND resource_type = 'INSPECTOR_USER'
        AND resource_id = $3
        AND state IN ('CONFIRMED', 'IN_PROGRESS', 'COMPLETED')
      LIMIT 1`,
    [target.clientId, target.handymanRequestId, actorUserId],
  );
  if (inspRes.rows[0]) {
    const eligible = await findEligibleHandymanWorker(db, {
      clientId: target.clientId,
      buildingId: target.buildingId,
      userId: actorUserId,
      requireLogin: true,
    });
    if (eligible) {
      return 'INSPECTOR';
    }
  }

  const perms = await permissionService.resolvePermissionsForUser(actorUserId);
  if (
    perms.includes('tenant_company.manage') ||
    (allowReadOnlyOps && perms.includes('tenant_company.read')) ||
    (allowReadOnlyOps &&
      purpose === 'MATERIAL_RECEIPT' &&
      (perms.includes('handyman.finance.read') ||
        perms.includes('handyman.finance.manage')))
  ) {
    return 'OPERATIONS_MANAGER';
  }

  throw new AppError({
    statusCode: 403,
    code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN,
    message:
      'Actor is not authorized to upload or access evidence for this Work Order / Request.',
  });
}

/**
 * CR-HM-MOBILE-EVIDENCE-E2E-01 PART 01B-BE — READ authority for field
 * evidence metadata/content/listing.
 *
 * The pre-existing field-role resolution runs FIRST and unchanged
 * (Crew Leader, assigned Inspector, Operations — preserving every existing
 * access path). Only when it denies with 403 does the appointed QC
 * Supervisor fallback apply, and only under ALL of:
 *   - the target is bound to an exact execution scope,
 *   - (when a concrete record is being read) the record is VERIFIED —
 *     incomplete upload intents stay undiscoverable/unreadable to QC,
 *   - `assertHandymanQcSupervisor` establishes the full BE-03F authority:
 *     explicit ACTIVE Building assignment, `handyman.qc.manage`, an active
 *     scope assignment of the same Client, and an effective reporting line
 *     to the scope's CURRENT Crew Lead (the permission alone is never
 *     sufficient — no tenant_company.read is granted or implied).
 *
 * A failed QC resolution rethrows the ORIGINAL field-read denial (bounded
 * 403 surface); non-403 infrastructure failures propagate unchanged.
 */
async function authorizeEvidenceRead(
  actorUserId: string,
  target: EvidenceTargetContext,
  record?: {
    purpose: HandymanFieldEvidencePurpose;
    uploadStatus: HandymanFieldEvidenceUploadStatus;
  },
): Promise<void> {
  try {
    await resolveEvidenceActorRole(
      actorUserId,
      target,
      true,
      undefined,
      record?.purpose,
    );
    return;
  } catch (error) {
    if (
      !(error instanceof AppError) ||
      error.statusCode !== 403 ||
      !target.executionScopeId ||
      (record && record.uploadStatus !== 'VERIFIED')
    ) {
      throw error;
    }
    const scopeId = target.executionScopeId;
    try {
      await withTransaction(async (tx) => {
        // Lazy load: the QC authority module transitively imports the
        // quotation surface, which imports this service (function-level
        // cycle only — resolved at call time, never at module init).
        const { assertHandymanQcSupervisor, lockHandymanQcScope } =
          await import('../handyman-evidence-qc/handyman-qc-authority');
        await lockHandymanQcScope(tx, scopeId);
        await assertHandymanQcSupervisor(
          {
            id: scopeId,
            clientId: target.clientId,
            buildingId: target.buildingId,
          },
          actorUserId,
          tx,
        );
      });
    } catch (qcError) {
      if (qcError instanceof AppError && qcError.statusCode === 403) {
        throw error;
      }
      throw qcError;
    }
  }
}

async function assertDomainObjectOwnership(
  tx: PoolClient,
  target: EvidenceTargetContext,
  input: {
    variationId: string | null;
    materialPurchaseRecordId: string | null;
  },
): Promise<void> {
  if (input.variationId) {
    const varRes = await tx.query<{
      id: string;
      client_id: string;
      building_id: string;
      handyman_request_id: string;
      execution_scope_id: string;
    }>(
      `SELECT id, client_id, building_id, handyman_request_id, execution_scope_id
         FROM handyman_scope_variations
        WHERE id = $1`,
      [input.variationId],
    );
    const v = varRes.rows[0];
    if (!v) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_VARIATION_NOT_FOUND,
        message: 'Linked variationId not found.',
      });
    }
    if (
      v.client_id !== target.clientId ||
      v.building_id !== target.buildingId ||
      v.handyman_request_id !== target.handymanRequestId ||
      (target.executionScopeId !== null &&
        v.execution_scope_id !== target.executionScopeId)
    ) {
      throw new AppError({
        statusCode: 403,
        code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN,
        message:
          'Linked variationId does not belong to the authorized Work Order / building scope.',
      });
    }
  }

  if (input.materialPurchaseRecordId) {
    const matRes = await tx.query<{
      id: string;
      client_id: string;
      building_id: string;
      handyman_request_id: string;
      execution_scope_id: string;
    }>(
      `SELECT id, client_id, building_id, handyman_request_id, execution_scope_id
         FROM handyman_material_purchase_records
        WHERE id = $1`,
      [input.materialPurchaseRecordId],
    );
    const m = matRes.rows[0];
    if (!m) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_NOT_FOUND,
        message: 'Linked materialPurchaseRecordId not found.',
      });
    }
    if (
      m.client_id !== target.clientId ||
      m.building_id !== target.buildingId ||
      m.handyman_request_id !== target.handymanRequestId ||
      (target.executionScopeId !== null &&
        m.execution_scope_id !== target.executionScopeId)
    ) {
      throw new AppError({
        statusCode: 403,
        code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN,
        message:
          'Linked materialPurchaseRecordId does not belong to the authorized Work Order / building scope.',
      });
    }
  }
}

/**
 * CR-HM-MOBILE-EVIDENCE-E2E-01 PART 01A-BE — authoritative Work Session
 * binding for Crew Leader execution-photo evidence.
 *
 * Validates, inside the caller's locked evidence transaction, that the
 * referenced Work Session:
 *   - exists (fabricated ids are bounded 404s),
 *   - belongs to the EXACT execution scope and Work Order request of this
 *     evidence target (cross-scope / cross-request references refused),
 *   - matches the evidence's Client and Building (cross-Client /
 *     cross-Building references refused),
 *   - is associated with the required Crew Lead identity — the
 *     authenticated actor at presign/upload, or the recorded initiating
 *     uploader at finalization (wrong-Leader references refused),
 *   - is in a lifecycle state that still permits submission: only the
 *     terminal CHECKED_OUT state closes the session's presence window
 *     (governance §5), so stale/completed-ineligible references are
 *     refused.
 *
 * The same helper revalidates at finalization (and idempotent replay) so
 * a stale upload intent cannot bypass authorization. Sessions are never
 * invented: a submission without an explicit workSessionId keeps the
 * historical unbound contract (arrival/inspection/pre-session evidence).
 */
async function assertWorkSessionEvidenceBinding(
  tx: PoolClient,
  target: EvidenceTargetContext,
  workSessionId: string,
  expectedLeadUserId: string,
): Promise<void> {
  if (!target.executionScopeId) {
    throw AppError.validation(
      'workSessionId requires the evidence to be targeted at an executionScopeId.',
    );
  }

  const res = await tx.query<{
    id: string;
    client_id: string;
    execution_scope_id: string;
    lead_user_id: string;
    status: string;
    building_id: string;
    handyman_request_id: string;
  }>(
    `SELECT ws.id, ws.client_id, ws.execution_scope_id, ws.lead_user_id,
            ws.status, s.building_id, s.handyman_request_id
       FROM handyman_work_sessions ws
       JOIN handyman_execution_scopes s ON s.id = ws.execution_scope_id
      WHERE ws.id = $1`,
    [workSessionId],
  );
  const session = res.rows[0];
  if (!session) {
    throw handymanWorkSessionNotFoundError();
  }
  if (
    session.execution_scope_id !== target.executionScopeId ||
    session.handyman_request_id !== target.handymanRequestId
  ) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN,
      message:
        'Referenced workSessionId does not belong to the exact execution scope and Work Order request of this evidence.',
    });
  }
  if (session.client_id !== target.clientId) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN,
      message: 'Referenced workSessionId belongs to a different Client.',
    });
  }
  if (session.building_id !== target.buildingId) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN,
      message: 'Referenced workSessionId belongs to a different Building.',
    });
  }
  if (session.lead_user_id !== expectedLeadUserId) {
    throw handymanWorkSessionNotAuthorizedError();
  }
  // Governance §5: CHECKED_OUT is the only terminal state — the presence
  // window is closed, so the session is stale for any new submission or
  // finalization of an upload intent.
  if (session.status === 'CHECKED_OUT') {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN,
      message:
        'Referenced workSessionId is stale: a CHECKED_OUT Work Session no longer permits evidence submission.',
    });
  }
}

/**
 * P0-C — evidence binding is an explicit, versioned, audited mutation of the
 * owning aggregate, never a silent side effect of uploading bytes:
 *  - the aggregate `version` is incremented (optimistic-concurrency visible),
 *  - an append-only operational event records actor, previous and new
 *    reference and the resulting version,
 *  - re-binding the identical reference is an idempotent no-op (no version
 *    bump, no duplicate audit event).
 * The binding runs in the caller's transaction, so a failed bind rolls the
 * evidence verification back with it.
 */
async function bindVerifiedAttachmentToDomainObjects(
  tx: PoolClient,
  target: EvidenceTargetContext,
  input: {
    variationId: string | null;
    materialPurchaseRecordId: string | null;
    attachmentReference: string;
    actorUserId: string;
    purpose: HandymanFieldEvidencePurpose;
    sha256Checksum: string;
  },
): Promise<void> {
  await assertDomainObjectOwnership(tx, target, {
    variationId: input.variationId,
    materialPurchaseRecordId: input.materialPurchaseRecordId,
  });

  if (input.variationId) {
    const res = await tx.query<{ version: number | string }>(
      `UPDATE handyman_scope_variations
          SET latest_evidence_reference = $5,
              version = version + 1,
              updated_at = NOW()
        WHERE id = $1
          AND client_id = $2
          AND building_id = $3
          AND handyman_request_id = $4
          AND latest_evidence_reference IS DISTINCT FROM $5
        RETURNING version`,
      [
        input.variationId,
        target.clientId,
        target.buildingId,
        target.handymanRequestId,
        input.attachmentReference,
      ],
    );
    if (res.rows[0]) {
      await recordOperationalEvent(
        {
          clientId: target.clientId,
          buildingId: target.buildingId,
          actorUserId: input.actorUserId,
          eventType: 'handyman_field_evidence.bound_to_variation',
          entityType: 'handyman_scope_variation',
          entityId: input.variationId,
          summary: 'Verified field evidence bound to scope variation',
          metadata: {
            attachmentReference: input.attachmentReference,
            executionScopeId: target.executionScopeId,
            handymanRequestId: target.handymanRequestId,
            aggregateVersion: Number(res.rows[0].version),
          },
        },
        tx,
      );
    }
  }

  if (input.materialPurchaseRecordId) {
    const curRes = await tx.query<{
      id: string;
      status: string;
      reimbursement_status: string;
    }>(
      `SELECT id, status, reimbursement_status
         FROM handyman_material_purchase_records
        WHERE id = $1
          AND client_id = $2
          AND building_id = $3
          AND handyman_request_id = $4
        FOR UPDATE`,
      [
        input.materialPurchaseRecordId,
        target.clientId,
        target.buildingId,
        target.handymanRequestId,
      ],
    );
    const cur = curRes.rows[0];
    if (
      cur &&
      (cur.status === 'RECONCILIATION' ||
        cur.reimbursement_status === 'FINANCE_APPROVED' ||
        cur.reimbursement_status === 'DISBURSED')
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_MATERIAL_PURCHASE_ILLEGAL_TRANSITION,
        message:
          'Cannot rebind evidence onto a reconciled, finance-approved, or disbursed material purchase record.',
      });
    }

    const isMaterialReceipt = input.purpose === 'MATERIAL_RECEIPT';
    if (isMaterialReceipt) {
      const dupRes = await tx.query<{
        id: string;
        execution_scope_id: string;
      }>(
        `SELECT id, execution_scope_id
           FROM handyman_material_purchase_records
          WHERE client_id = $1
            AND id <> $2
            AND (
              receipt_evidence_reference = $3
              OR receipt_sha256_checksum = $4
            )
          LIMIT 1`,
        [
          target.clientId,
          input.materialPurchaseRecordId,
          input.attachmentReference,
          input.sha256Checksum,
        ],
      );
      if (dupRes.rows[0]) {
        if (
          target.executionScopeId &&
          dupRes.rows[0].execution_scope_id !== target.executionScopeId
        ) {
          throw new AppError({
            statusCode: 409,
            code: ERROR_CODES.HANDYMAN_REIMBURSEMENT_CROSS_WORK_ORDER_CLAIM,
            message:
              'Receipt photo has already been claimed on another Work Order.',
          });
        }
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_MATERIAL_RECEIPT_DUPLICATE,
          message:
            'Duplicate receipt photo binary digest cannot be bound to multiple material purchase records.',
        });
      }
    }

    const res = await tx.query<{ version: number | string }>(
      isMaterialReceipt
        ? `UPDATE handyman_material_purchase_records
              SET receipt_evidence_reference = $5,
                  receipt_sha256_checksum = $6,
                  latest_evidence_reference = $5,
                  version = version + 1,
                  updated_at = NOW()
            WHERE id = $1
              AND client_id = $2
              AND building_id = $3
              AND handyman_request_id = $4
              AND latest_evidence_reference IS DISTINCT FROM $5
            RETURNING version`
        : `UPDATE handyman_material_purchase_records
              SET latest_evidence_reference = $5,
                  version = version + 1,
                  updated_at = NOW()
            WHERE id = $1
              AND client_id = $2
              AND building_id = $3
              AND handyman_request_id = $4
              AND latest_evidence_reference IS DISTINCT FROM $5
            RETURNING version`,
      isMaterialReceipt
        ? [
            input.materialPurchaseRecordId,
            target.clientId,
            target.buildingId,
            target.handymanRequestId,
            input.attachmentReference,
            input.sha256Checksum,
          ]
        : [
            input.materialPurchaseRecordId,
            target.clientId,
            target.buildingId,
            target.handymanRequestId,
            input.attachmentReference,
          ],
    );
    if (res.rows[0]) {
      await recordOperationalEvent(
        {
          clientId: target.clientId,
          buildingId: target.buildingId,
          actorUserId: input.actorUserId,
          eventType: 'handyman_field_evidence.bound_to_material_purchase',
          entityType: 'handyman_material_purchase_record',
          entityId: input.materialPurchaseRecordId,
          summary: 'Verified field evidence bound to material purchase record',
          metadata: {
            attachmentReference: input.attachmentReference,
            executionScopeId: target.executionScopeId,
            handymanRequestId: target.handymanRequestId,
            aggregateVersion: Number(res.rows[0].version),
          },
        },
        tx,
      );
    }
  }
}

export interface VerifiedManagedEvidenceAssertionResult {
  id: string;
  purpose: HandymanFieldEvidencePurpose;
  sha256Checksum: string;
  verifiedByteSize: number;
  attachmentReference: string;
}

/**
 * Verifies that any managed `hm-ev://<uuid>` evidence reference exists, belongs
 * to the exact same tenant/building/Work Order, and has verified binary bytes
 * in storage before being bound to a domain object.
 */
export async function assertVerifiedManagedEvidenceReference(
  tx: PoolClient,
  scope: {
    clientId: string;
    buildingId: string;
    handymanRequestId: string;
    executionScopeId: string | null;
  },
  reference: string | null | undefined,
  options?: {
    requiredPurpose?: HandymanFieldEvidencePurpose;
  },
): Promise<VerifiedManagedEvidenceAssertionResult | null> {
  if (!reference) {
    return null;
  }
  // P0-A: unmanaged/legacy references (any non-hm-ev:// string) are rejected;
  // there is no independently verifiable legacy authority for free-text refs.
  if (!reference.startsWith('hm-ev://')) {
    throw new AppError({
      statusCode: 400,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_REFERENCE_UNVERIFIED,
      message:
        'evidenceReference must be a managed hm-ev://<evidenceId> reference to a VERIFIED field evidence upload; unmanaged or legacy references are not accepted.',
    });
  }
  const rawId = reference.slice('hm-ev://'.length).trim();
  const evidenceId = assertUuid(rawId, 'evidenceReference');

  const record = await handymanFieldEvidenceRepository.findByIdForUpdate(
    tx,
    evidenceId,
  );
  if (!record) {
    throw new AppError({
      statusCode: 404,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_NOT_FOUND,
      message: 'Referenced field evidence upload does not exist.',
    });
  }

  if (
    record.clientId !== scope.clientId ||
    record.buildingId !== scope.buildingId ||
    record.handymanRequestId !== scope.handymanRequestId ||
    (record.executionScopeId !== null &&
      record.executionScopeId !== scope.executionScopeId)
  ) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN,
      message:
        'Referenced field evidence upload belongs to a different tenant, building, or Work Order.',
    });
  }

  if (record.attachmentReference !== reference) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED,
      message:
        'Referenced field evidence upload has no finalized attachment reference.',
    });
  }

  if (
    record.uploadStatus !== 'VERIFIED' ||
    record.verifiedByteSize <= 0 ||
    !record.sha256Checksum
  ) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED,
      message:
        'Cannot bind unverified or metadata-only field evidence upload: binary bytes must be uploaded and verified first.',
    });
  }

  const storage = createEvidenceStorage();
  let storedBuffer: Buffer | null = null;
  try {
    const stored = await storage.get(record.storageKey);
    storedBuffer = stored.buffer;
  } catch {
    storedBuffer = null;
  }
  if (
    !storedBuffer ||
    storedBuffer.byteLength !== record.verifiedByteSize ||
    computeEvidenceSha256(storedBuffer) !== record.sha256Checksum
  ) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED,
      message:
        'Referenced field evidence upload failed storage byte verification.',
    });
  }

  if (options?.requiredPurpose && record.purpose !== options.requiredPurpose) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_MATERIAL_RECEIPT_PURPOSE_INVALID,
      message: `Referenced field evidence upload must have purpose ${options.requiredPurpose} (received ${record.purpose}).`,
    });
  }

  return {
    id: record.id,
    purpose: record.purpose,
    sha256Checksum: record.sha256Checksum,
    verifiedByteSize: record.verifiedByteSize,
    attachmentReference: record.attachmentReference,
  };
}

/**
 * Flow A: Direct authorized multipart/binary upload with immediate byte
 * verification, SHA-256 digest, and domain object binding.
 */
export async function uploadFieldEvidenceBinary(
  actorUserId: string,
  input: {
    executionScopeId?: unknown;
    handymanRequestId?: unknown;
    variationId?: unknown;
    materialPurchaseRecordId?: unknown;
    workSessionId?: unknown;
    purpose?: unknown;
    originalFileName?: unknown;
    mimeType?: unknown;
    notes?: unknown;
    idempotencyKey?: unknown;
    file?: {
      originalname?: string;
      mimetype?: string;
      buffer?: Buffer;
      size?: number;
    } | null;
  },
): Promise<{
  replayed: boolean;
  evidence: HandymanFieldEvidenceUploadRecord;
}> {
  if (
    !input.file ||
    !input.file.buffer ||
    input.file.buffer.byteLength === 0
  ) {
    throw new AppError({
      statusCode: 400,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED,
      message:
        'Metadata-only payload rejected: genuine non-empty binary file bytes are required.',
    });
  }

  const target = await resolveEvidenceTargetContext({
    executionScopeId: input.executionScopeId,
    handymanRequestId: input.handymanRequestId,
  });
  let actorRole = await resolveEvidenceActorRole(actorUserId, target, false);

  const purpose = assertPurpose(input.purpose);
  const rawMime = input.mimeType ?? input.file.mimetype;
  const mimeType = assertMimeType(rawMime);
  const bytes = input.file.buffer;

  verifyBinaryMagicSignature(bytes, mimeType);

  const originalFileName = assertNonEmptyText(
    input.originalFileName ?? input.file.originalname ?? 'evidence.bin',
    'originalFileName',
    255,
  );
  const idempotencyKey = assertNonEmptyText(
    input.idempotencyKey,
    'idempotencyKey',
    128,
  );
  const variationId =
    input.variationId !== undefined && input.variationId !== null
      ? assertUuid(input.variationId, 'variationId')
      : null;
  const materialPurchaseRecordId =
    input.materialPurchaseRecordId !== undefined &&
    input.materialPurchaseRecordId !== null
      ? assertUuid(
          input.materialPurchaseRecordId,
          'materialPurchaseRecordId',
        )
      : null;
  const workSessionId =
    input.workSessionId !== undefined && input.workSessionId !== null
      ? assertUuid(input.workSessionId, 'workSessionId')
      : null;
  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim()
      : null;

  const sha256Checksum = computeEvidenceSha256(bytes);
  const verifiedByteSize = bytes.byteLength;

  return withTransaction(async (tx) => {
    actorRole = await resolveEvidenceWriteActorRole(tx, actorUserId, target);
    const existing =
      await handymanFieldEvidenceRepository.findByIdempotencyKey(
        tx,
        target.clientId,
        actorUserId,
        idempotencyKey,
      );
    if (existing) {
      if (
        existing.handymanRequestId !== target.handymanRequestId ||
        existing.executionScopeId !== target.executionScopeId ||
        existing.buildingId !== target.buildingId ||
        existing.workSessionId !== workSessionId
      ) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_IDEMPOTENCY_CONFLICT,
          message:
            'idempotencyKey was already used for evidence in a different Work Order / execution scope.',
        });
      }
      if (
        existing.purpose !== purpose ||
        existing.mimeType !== mimeType ||
        (existing.sha256Checksum &&
          existing.sha256Checksum !== sha256Checksum)
      ) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_IDEMPOTENCY_CONFLICT,
          message:
            'idempotencyKey was already used with a different evidence upload payload or binary content.',
        });
      }
      // CR-HM-MOBILE-EVIDENCE-E2E-01 PART 01A-BE — replay of a bound
      // intent revalidates the stored Work Session linkage (existence,
      // exact scope, identity, currentness) instead of trusting it.
      if (existing.workSessionId) {
        await assertWorkSessionEvidenceBinding(
          tx,
          target,
          existing.workSessionId,
          existing.uploadedByUserId,
        );
      }
      return { replayed: true, evidence: existing };
    }

    // CR-HM-MOBILE-EVIDENCE-E2E-01 PART 01A-BE — validate the explicit
    // execution-photo Work Session binding before any bytes are stored.
    if (workSessionId) {
      await assertWorkSessionEvidenceBinding(
        tx,
        target,
        workSessionId,
        actorUserId,
      );
    }

    const evidenceId = randomUUID();
    const storageKey = evidenceStorageKey(evidenceId);
    const storage = createEvidenceStorage();

    await storage.put(storageKey, {
      buffer: bytes,
      mimeType,
    });

    const stored = await storage.get(storageKey);
    if (
      !stored ||
      stored.size !== verifiedByteSize ||
      computeEvidenceSha256(stored.buffer) !== sha256Checksum
    ) {
      throw new AppError({
        statusCode: 500,
        code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_VERIFICATION_FAILED,
        message: 'Storage verification failed after binary write.',
      });
    }

    const attachmentReference = `hm-ev://${evidenceId}`;

    await bindVerifiedAttachmentToDomainObjects(tx, target, {
      variationId,
      materialPurchaseRecordId,
      attachmentReference,
      actorUserId,
      purpose,
      sha256Checksum,
    });

    const record = await handymanFieldEvidenceRepository.insertUpload(tx, {
      id: evidenceId,
      clientId: target.clientId,
      tenantCompanyId: target.tenantCompanyId,
      buildingId: target.buildingId,
      handymanRequestId: target.handymanRequestId,
      executionScopeId: target.executionScopeId,
      workSessionId,
      variationId,
      materialPurchaseRecordId,
      purpose,
      uploadStatus: 'VERIFIED',
      originalFileName,
      mimeType,
      storageKey,
      declaredByteSize: verifiedByteSize,
      verifiedByteSize,
      sha256Checksum,
      attachmentReference,
      uploadedByUserId: actorUserId,
      uploadedByRole: actorRole,
      notes,
      idempotencyKey,
      verifiedAt: new Date(),
    });

    await recordOperationalEvent(
      {
        clientId: target.clientId,
        buildingId: target.buildingId,
        actorUserId,
        eventType: 'handyman_field_evidence.uploaded_verified',
        entityType: 'handyman_field_evidence_upload',
        entityId: record.id,
        summary: `Verified binary evidence uploaded (${purpose}, ${verifiedByteSize} bytes)`,
        metadata: {
          executionScopeId: target.executionScopeId,
          handymanRequestId: target.handymanRequestId,
          workSessionId,
          purpose,
          mimeType,
          verifiedByteSize,
          sha256Checksum,
          attachmentReference,
        },
      },
      tx,
    );

    return { replayed: false, evidence: record };
  });
}

/**
 * Flow B Step 1: Create presigned / staged upload intent (PENDING_BYTES).
 * Metadata-only row has uploadCompleted = false and attachmentReference = null.
 */
export async function createPresignedFieldEvidenceIntent(
  actorUserId: string,
  input: {
    executionScopeId?: unknown;
    handymanRequestId?: unknown;
    variationId?: unknown;
    materialPurchaseRecordId?: unknown;
    workSessionId?: unknown;
    purpose: unknown;
    originalFileName: unknown;
    mimeType: unknown;
    declaredByteSize: unknown;
    notes?: unknown;
    idempotencyKey: unknown;
  },
): Promise<{
  replayed: boolean;
  evidence: HandymanFieldEvidenceUploadRecord;
  uploadUrl: string;
  confirmUrl: string;
}> {
  const target = await resolveEvidenceTargetContext({
    executionScopeId: input.executionScopeId,
    handymanRequestId: input.handymanRequestId,
  });
  let actorRole = await resolveEvidenceActorRole(actorUserId, target, false);

  const purpose = assertPurpose(input.purpose);
  const mimeType = assertMimeType(input.mimeType);
  const originalFileName = assertNonEmptyText(
    input.originalFileName,
    'originalFileName',
    255,
  );
  const declaredByteSize = Number(input.declaredByteSize);
  if (
    !Number.isInteger(declaredByteSize) ||
    declaredByteSize <= 0 ||
    declaredByteSize > HANDYMAN_FIELD_EVIDENCE_MAX_BYTES
  ) {
    throw AppError.validation(
      `declaredByteSize must be an integer between 1 and ${HANDYMAN_FIELD_EVIDENCE_MAX_BYTES}.`,
    );
  }
  const idempotencyKey = assertNonEmptyText(
    input.idempotencyKey,
    'idempotencyKey',
    128,
  );
  const variationId =
    input.variationId !== undefined && input.variationId !== null
      ? assertUuid(input.variationId, 'variationId')
      : null;
  const materialPurchaseRecordId =
    input.materialPurchaseRecordId !== undefined &&
    input.materialPurchaseRecordId !== null
      ? assertUuid(
          input.materialPurchaseRecordId,
          'materialPurchaseRecordId',
        )
      : null;
  const workSessionId =
    input.workSessionId !== undefined && input.workSessionId !== null
      ? assertUuid(input.workSessionId, 'workSessionId')
      : null;
  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim()
      : null;

  return withTransaction(async (tx) => {
    actorRole = await resolveEvidenceWriteActorRole(tx, actorUserId, target);
    const existing =
      await handymanFieldEvidenceRepository.findByIdempotencyKey(
        tx,
        target.clientId,
        actorUserId,
        idempotencyKey,
      );
    if (existing) {
      if (
        existing.handymanRequestId !== target.handymanRequestId ||
        existing.executionScopeId !== target.executionScopeId ||
        existing.purpose !== purpose ||
        existing.mimeType !== mimeType ||
        existing.declaredByteSize !== declaredByteSize ||
        existing.workSessionId !== workSessionId
      ) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_IDEMPOTENCY_CONFLICT,
          message:
            'idempotencyKey was already used with a different evidence upload intent.',
        });
      }
      // CR-HM-MOBILE-EVIDENCE-E2E-01 PART 01A-BE — a replayed bound
      // intent revalidates its Work Session linkage (existence, exact
      // scope, identity, currentness) before it is handed back.
      if (existing.workSessionId) {
        await assertWorkSessionEvidenceBinding(
          tx,
          target,
          existing.workSessionId,
          existing.uploadedByUserId,
        );
      }
      return {
        replayed: true,
        evidence: existing,
        uploadUrl: `/api/v1/handyman/field/evidence/${existing.id}/bytes`,
        confirmUrl: `/api/v1/handyman/field/evidence/${existing.id}/confirm`,
      };
    }

    await assertDomainObjectOwnership(tx, target, {
      variationId,
      materialPurchaseRecordId,
    });

    // CR-HM-MOBILE-EVIDENCE-E2E-01 PART 01A-BE — validate the explicit
    // execution-photo Work Session binding for this presigned intent.
    if (workSessionId) {
      await assertWorkSessionEvidenceBinding(
        tx,
        target,
        workSessionId,
        actorUserId,
      );
    }

    const evidenceId = randomUUID();
    const storageKey = evidenceStorageKey(evidenceId);

    const record = await handymanFieldEvidenceRepository.insertUpload(tx, {
      id: evidenceId,
      clientId: target.clientId,
      tenantCompanyId: target.tenantCompanyId,
      buildingId: target.buildingId,
      handymanRequestId: target.handymanRequestId,
      executionScopeId: target.executionScopeId,
      workSessionId,
      variationId,
      materialPurchaseRecordId,
      purpose,
      uploadStatus: 'PENDING_BYTES',
      originalFileName,
      mimeType,
      storageKey,
      declaredByteSize,
      verifiedByteSize: 0,
      sha256Checksum: null,
      attachmentReference: null,
      uploadedByUserId: actorUserId,
      uploadedByRole: actorRole,
      notes,
      idempotencyKey,
      verifiedAt: null,
    });

    return {
      replayed: false,
      evidence: record,
      uploadUrl: `/api/v1/handyman/field/evidence/${record.id}/bytes`,
      confirmUrl: `/api/v1/handyman/field/evidence/${record.id}/confirm`,
    };
  });
}

/**
 * Flow B Step 2: Upload binary bytes to a staged intent.
 */
export async function putStagedFieldEvidenceBytes(
  actorUserId: string,
  evidenceId: string,
  bytes: Buffer | undefined,
): Promise<HandymanFieldEvidenceUploadRecord> {
  const validId = assertUuid(evidenceId, 'evidenceId');
  if (!bytes || bytes.byteLength === 0) {
    throw new AppError({
      statusCode: 400,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED,
      message: 'Non-empty binary file bytes are required.',
    });
  }

  return withTransaction(async (tx) => {
    await lockReworkEvidenceOwner(tx, validId);
    const record = await handymanFieldEvidenceRepository.findByIdForUpdate(
      tx,
      validId,
    );
    if (!record) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_NOT_FOUND,
        message: 'Handyman field evidence record not found.',
      });
    }

    await resolveEvidenceWriteActorRole(
      tx,
      actorUserId,
      {
        clientId: record.clientId,
        tenantCompanyId: record.tenantCompanyId,
        buildingId: record.buildingId,
        handymanRequestId: record.handymanRequestId,
        executionScopeId: record.executionScopeId,
      },
    );

    if (record.uploadedByUserId !== actorUserId) {
      throw new AppError({
        statusCode: 403,
        code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN,
        message:
          'Only the initiating uploader may stream bytes to this upload session.',
      });
    }

    verifyBinaryMagicSignature(bytes, record.mimeType);
    const sha256Checksum = computeEvidenceSha256(bytes);

    // P0-B — VERIFIED bytes are immutable. An exact retry (same SHA-256 and
    // byte size) is a safe no-op; any conflicting re-upload is a typed 409
    // and the finalized bytes, digest and size are preserved.
    if (record.uploadStatus === 'VERIFIED') {
      if (
        record.sha256Checksum === sha256Checksum &&
        record.verifiedByteSize === bytes.byteLength
      ) {
        return record;
      }
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_IMMUTABLE,
        message:
          'Evidence upload is VERIFIED and its bytes are immutable; conflicting re-upload rejected.',
      });
    }

    const storage = createEvidenceStorage();
    await storage.put(record.storageKey, {
      buffer: bytes,
      mimeType: record.mimeType,
    });

    return handymanFieldEvidenceRepository.updateStagedBytes(tx, {
      evidenceId: record.id,
      verifiedByteSize: bytes.byteLength,
      sha256Checksum,
    });
  });
}

/**
 * Flow B Step 3: Confirm staged upload after verifying storage bytes exist.
 * Rejects metadata-only rows where no binary bytes were uploaded.
 */
export async function confirmFieldEvidenceUpload(
  actorUserId: string,
  evidenceId: string,
): Promise<HandymanFieldEvidenceUploadRecord> {
  const validId = assertUuid(evidenceId, 'evidenceId');

  return withTransaction(async (tx) => {
    await lockReworkEvidenceOwner(tx, validId);
    const record = await handymanFieldEvidenceRepository.findByIdForUpdate(
      tx,
      validId,
    );
    if (!record) {
      throw new AppError({
        statusCode: 404,
        code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_NOT_FOUND,
        message: 'Handyman field evidence record not found.',
      });
    }

    const target: EvidenceTargetContext = {
      clientId: record.clientId,
      tenantCompanyId: record.tenantCompanyId,
      buildingId: record.buildingId,
      handymanRequestId: record.handymanRequestId,
      executionScopeId: record.executionScopeId,
    };
    const actorRole = await resolveEvidenceWriteActorRole(tx, actorUserId, target);
    if (
      record.uploadedByUserId !== actorUserId &&
      actorRole !== 'OPERATIONS_MANAGER'
    ) {
      throw new AppError({
        statusCode: 403,
        code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_FORBIDDEN,
        message:
          'Only the initiating uploader or Operations Manager may confirm this upload session.',
      });
    }

    if (record.uploadStatus === 'VERIFIED') {
      return record;
    }

    // CR-HM-MOBILE-EVIDENCE-E2E-01 PART 01A-BE — revalidate the stored
    // Work Session linkage at finalization (existence, exact scope,
    // Client/Building, source-identity lead, current lifecycle state) so
    // an upload intent staged while the session was open cannot be
    // confirmed after the session's presence window has closed.
    if (record.workSessionId) {
      await assertWorkSessionEvidenceBinding(
        tx,
        target,
        record.workSessionId,
        record.uploadedByUserId,
      );
    }

    const storage = createEvidenceStorage();
    let storedBuffer: Buffer | null = null;
    try {
      const stored = await storage.get(record.storageKey);
      storedBuffer = stored.buffer;
    } catch {
      storedBuffer = null;
    }

    if (
      !storedBuffer ||
      storedBuffer.byteLength <= 0 ||
      record.verifiedByteSize <= 0 ||
      !record.sha256Checksum ||
      computeEvidenceSha256(storedBuffer) !== record.sha256Checksum
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED,
        message:
          'Cannot confirm upload: metadata-only record has no verified binary file bytes in storage.',
      });
    }

    const attachmentReference = `hm-ev://${record.id}`;
    await bindVerifiedAttachmentToDomainObjects(tx, target, {
      variationId: record.variationId,
      materialPurchaseRecordId: record.materialPurchaseRecordId,
      attachmentReference,
      actorUserId,
      purpose: record.purpose,
      sha256Checksum: record.sha256Checksum,
    });

    const verified = await handymanFieldEvidenceRepository.markVerified(tx, {
      evidenceId: record.id,
      attachmentReference,
    });

    await recordOperationalEvent(
      {
        clientId: target.clientId,
        buildingId: target.buildingId,
        actorUserId,
        eventType: 'handyman_field_evidence.confirmed',
        entityType: 'handyman_field_evidence_upload',
        entityId: verified.id,
        summary: `Staged binary evidence upload confirmed (${verified.purpose}, ${verified.verifiedByteSize} bytes)`,
        metadata: {
          executionScopeId: target.executionScopeId,
          handymanRequestId: target.handymanRequestId,
          workSessionId: record.workSessionId,
          purpose: verified.purpose,
          verifiedByteSize: verified.verifiedByteSize,
          sha256Checksum: verified.sha256Checksum,
          attachmentReference,
        },
      },
      tx,
    );

    return verified;
  });
}

/**
 * Read Evidence Metadata & Safe Attachment Reference
 */
export async function getFieldEvidenceMetadata(
  actorUserId: string,
  evidenceId: string,
): Promise<HandymanFieldEvidenceUploadRecord> {
  const validId = assertUuid(evidenceId, 'evidenceId');
  const record = await handymanFieldEvidenceRepository.findById(validId);
  if (!record) {
    throw new AppError({
      statusCode: 404,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_NOT_FOUND,
      message: 'Handyman field evidence record not found.',
    });
  }

  await authorizeEvidenceRead(
    actorUserId,
    {
      clientId: record.clientId,
      tenantCompanyId: record.tenantCompanyId,
      buildingId: record.buildingId,
      handymanRequestId: record.handymanRequestId,
      executionScopeId: record.executionScopeId,
    },
    record,
  );

  return record;
}

/**
 * CR-HM-MOBILE-EVIDENCE-E2E-01 PART 01B-BE — read-only, bounded discovery
 * of CONFIRMED field evidence for one exact execution scope.
 *
 * Authorization: the existing field-read roles first (Operations /
 * Crew Leader / Inspector, unchanged), then the appointed QC Supervisor
 * authority (see authorizeEvidenceRead). Only VERIFIED rows are returned
 * (incomplete upload intents are never discoverable); historical unbound
 * evidence stays discoverable with workSessionId null. The projection
 * never embeds photo bytes, storage keys or download paths.
 */
export async function listScopeFieldEvidence(
  actorUserId: string,
  executionScopeId: unknown,
  query: Record<string, unknown>,
): Promise<{
  evidence: HandymanScopeEvidenceItem[];
  pagination: PaginationMeta;
}> {
  const scopeId = assertUuid(executionScopeId, 'executionScopeId');
  const target = await resolveEvidenceTargetContext({
    executionScopeId: scopeId,
  });
  const pagination = parsePagination(query);
  await authorizeEvidenceRead(actorUserId, target);

  const evidence = await handymanFieldEvidenceRepository
    .listVerifiedByExecutionScope(scopeId, {
      limit: pagination.limit,
      offset: pagination.offset,
    });
  const total =
    await handymanFieldEvidenceRepository.countVerifiedByExecutionScope(
      scopeId,
    );
  return {
    evidence,
    pagination: buildPaginationMeta(
      pagination.page,
      pagination.pageSize,
      total,
    ),
  };
}

/**
 * Read Verified Binary Content (Download / Preview)
 */
export async function readFieldEvidenceBytes(
  actorUserId: string,
  evidenceId: string,
): Promise<{
  record: HandymanFieldEvidenceUploadRecord;
  buffer: Buffer;
}> {
  const record = await getFieldEvidenceMetadata(actorUserId, evidenceId);
  if (record.uploadStatus !== 'VERIFIED') {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_BYTES_REQUIRED,
      message:
        'Evidence file is not verified: binary bytes have not been confirmed.',
    });
  }

  const storage = createEvidenceStorage();
  try {
    const stored = await storage.get(record.storageKey);
    return { record, buffer: stored.buffer };
  } catch {
    throw new AppError({
      statusCode: 404,
      code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_NOT_FOUND,
      message: 'Evidence binary object not found in storage.',
    });
  }
}
