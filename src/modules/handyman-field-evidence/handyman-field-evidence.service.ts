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
  HANDYMAN_FIELD_EVIDENCE_MAX_BYTES,
  HANDYMAN_FIELD_EVIDENCE_MIME_TYPES,
  HANDYMAN_FIELD_EVIDENCE_PURPOSES,
  type HandymanFieldEvidenceMimeType,
  type HandymanFieldEvidencePurpose,
  type HandymanFieldEvidenceUploadRecord,
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

/** Recheck write authority under the existing execution-scope lock before
 * accepting evidence mutations. Evidence may precede dispatch or follow completion/QC, but a
 * cancelled release/visit must not authorize NEW uploads by its field Lead.
 */
async function resolveEvidenceWriteActorRole(
  tx: PoolClient, actor: string, target: EvidenceTargetContext,
) {
  if (target.executionScopeId) {
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
        existing.buildingId !== target.buildingId
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
      return { replayed: true, evidence: existing };
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
        existing.declaredByteSize !== declaredByteSize
      ) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_EVIDENCE_UPLOAD_IDEMPOTENCY_CONFLICT,
          message:
            'idempotencyKey was already used with a different evidence upload intent.',
        });
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

    const evidenceId = randomUUID();
    const storageKey = evidenceStorageKey(evidenceId);

    const record = await handymanFieldEvidenceRepository.insertUpload(tx, {
      id: evidenceId,
      clientId: target.clientId,
      tenantCompanyId: target.tenantCompanyId,
      buildingId: target.buildingId,
      handymanRequestId: target.handymanRequestId,
      executionScopeId: target.executionScopeId,
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

  await resolveEvidenceActorRole(
    actorUserId,
    {
      clientId: record.clientId,
      tenantCompanyId: record.tenantCompanyId,
      buildingId: record.buildingId,
      handymanRequestId: record.handymanRequestId,
      executionScopeId: record.executionScopeId,
    },
    true,
    undefined,
    record.purpose,
  );

  return record;
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
