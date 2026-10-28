import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { recordOperationalEvent } from '../operational-events';
import { applyRetentionToEvidence } from '../evidence-retention-policies/evidence-retention-application.service';
import {
  computeEvidenceSha256,
  EVIDENCE_HASH_ALGORITHM,
} from '../evidence/evidence-integrity';
import { EVIDENCE_MIME_BY_TYPE } from '../evidence/evidence.service';
import {
  createEvidenceStorage,
  evidenceStorageKey,
} from '../evidence/storage';
import { handymanCustomerPaymentConflictError } from '../handyman-customer-payments/handyman-customer-payment.errors';
import type { CareWorkspacePrincipal } from './care-workspace.service';
import { WORKSPACE_OCCUPANCY_CTES } from './care-workspace-occupancies.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HANDYMAN_PAYMENT_PROOF_MAX_BYTES = 52_428_800;

export type HandymanPaymentProofSelection = {
  propertyId: string;
  tenantCompanyId: string;
  buildingId: string;
  spaceId: string | null;
};

export type CareProofUploadFile = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
};

export function parseCareHandymanPaymentProofSelection(query: unknown): HandymanPaymentProofSelection {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw invalid();
  const q = query as Record<string, unknown>;
  if (Object.keys(q).some(key => !['propertyId', 'tenantCompanyId', 'buildingId', 'spaceId'].includes(key))) throw invalid();
  return {
    propertyId: uuid(q.propertyId, 'propertyId'),
    tenantCompanyId: uuid(q.tenantCompanyId, 'tenantCompanyId'),
    buildingId: uuid(q.buildingId, 'buildingId'),
    spaceId: q.spaceId === undefined ? null : uuid(q.spaceId, 'spaceId'),
  };
}

function invalid(message = 'Invalid Handyman payment proof request.'): AppError {
  return AppError.validation(message);
}
function notFound(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_RESOURCE_NOT_FOUND,
    message: 'Care workspace resource not found.', statusCode: 404,
  });
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw AppError.validation('Invalid Care workspace payment proof context.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return uuid(value, field);
}

/** Validate the selected represented scope without trusting any caller-owned
 * tenant/building identity. The current Care grant and occupancy are evaluated
 * in the same statement as the request -> scope -> payment -> invoice join. */
async function findBoundPayment(
  executor: Pick<PoolClient, 'query'> | ReturnType<typeof getPool>,
  principal: CareWorkspacePrincipal,
  selection: HandymanPaymentProofSelection,
  requestId: string,
  invoiceId: string | null,
  paymentId: string,
  lockPayment: boolean,
) {
  const result = await executor.query<{
    authenticated: boolean;
    selectedPropertyAvailable: boolean;
    item: {
      clientId: string; requestId: string; executionScopeId: string;
      transactionId: string; paymentId: string; paymentStatus: string;
      paymentCurrency: string; invoiceId: string | null; invoiceStatus: string | null;
      tenantCompanyId: string; buildingId: string; spaceId: string | null;
    } | null;
  }>(`
    ${WORKSPACE_OCCUPANCY_CTES}, matched AS (
      SELECT r.client_id AS "clientId", r.id AS "requestId",
             es.id AS "executionScopeId", tx.id AS "transactionId",
             p.id AS "paymentId", p.status AS "paymentStatus",
             tx.currency AS "paymentCurrency", COALESCE(oi.id, i.id) AS "invoiceId",
             CASE WHEN oi.id IS NOT NULL THEN 'ISSUED' ELSE i.status END AS "invoiceStatus",
             r.tenant_company_id AS "tenantCompanyId",
             r.building_id AS "buildingId", r.space_id AS "spaceId"
        FROM handyman_service_requests r
        JOIN records c ON c."clientId" = r.client_id
          AND c."tenantCompanyId" = r.tenant_company_id
          AND c."buildingId" = r.building_id
          AND c."spaceId" IS NOT DISTINCT FROM r.space_id
        JOIN handyman_execution_scopes es ON es.handyman_request_id = r.id
          AND es.client_id = r.client_id
        JOIN handyman_customer_transactions tx ON tx.execution_scope_id = es.id
          AND tx.client_id = es.client_id
        JOIN handyman_customer_payments p ON p.transaction_id = tx.id
          AND p.client_id = tx.client_id
        LEFT JOIN tenant_invoices i ON i.handyman_execution_scope_id = es.id
          AND i.client_id = es.client_id
          AND i.tenant_company_id = r.tenant_company_id
          AND i.building_id = r.building_id
          AND i.space_id IS NOT DISTINCT FROM r.space_id
          AND i.currency_code = tx.currency
          AND i.status = 'FINALIZED'
        LEFT JOIN handyman_official_invoice_payment_links link ON link.payment_id=p.id
        LEFT JOIN handyman_official_invoices oi ON oi.id=link.invoice_id AND oi.execution_scope_id=es.id
          AND oi.transaction_id=tx.id AND oi.client_id=r.client_id AND oi.request_id=r.id
          AND oi.tenant_company_id=r.tenant_company_id AND oi.building_id=r.building_id AND oi.currency=tx.currency
       WHERE $5::text IS NULL AND $6::integer = 1
         AND r.id = $10 AND p.id = $12
         AND r.tenant_company_id = $7 AND r.building_id = $8
         AND r.space_id IS NOT DISTINCT FROM $9::uuid
         AND (
           $11::uuid IS NULL
           OR oi.id = $11::uuid
           OR (
             i.id = $11::uuid
             AND EXISTS (
               SELECT 1 FROM tenant_invoice_lines il
               WHERE il.invoice_id = i.id AND il.source_type = 'HANDYMAN_CHARGE'
             )
             AND NOT EXISTS (
               SELECT 1 FROM tenant_invoice_lines il
               WHERE il.invoice_id = i.id AND il.source_type <> 'HANDYMAN_CHARGE'
             )
           )
         )
       LIMIT 1${lockPayment ? ' FOR UPDATE OF p' : ''}
    )
    SELECT EXISTS(SELECT 1 FROM authority) AS authenticated,
      EXISTS(SELECT 1 FROM granted) AS "selectedPropertyAvailable",
      (SELECT to_jsonb(matched) FROM matched) AS item`,
    [principal.sessionId, principal.careActorId, principal.integrationId,
      selection.propertyId, null, 1, selection.tenantCompanyId,
      selection.buildingId, selection.spaceId, requestId, invoiceId, paymentId]);
  return result.rows[0];
}

async function assertCareWriteAuthority(
  tx: Pick<PoolClient, 'query'>,
  principal: CareWorkspacePrincipal,
  selection: HandymanPaymentProofSelection,
): Promise<void> {
  // Follow the established invalidation lock order: integration/actor before
  // session. These locks hold the authenticated Care identity for the upload
  // transaction; no local User or bearer identity is manufactured.
  const authority = await tx.query(
    `SELECT a.id
       FROM handyman_care_workspace_sessions s
       JOIN handyman_handoff_integrations i ON i.id = s.integration_id
       JOIN handyman_handoff_care_actors a
         ON a.id = s.care_actor_id AND a.integration_id = i.id
      WHERE s.id = $1 AND s.care_actor_id = $2 AND s.integration_id = $3
        AND s.revoked_at IS NULL AND s.expires_at > statement_timestamp()
        AND a.status = 'ACTIVE' AND i.status = 'ACTIVE'
        AND i.actor_capability = 'CUSTOMER_CARE'
      FOR SHARE OF i, a`,
    [principal.sessionId, principal.careActorId, principal.integrationId]);
  if (authority.rowCount !== 1) throw new AppError({
    code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED,
    message: 'Care workspace authentication failed.', statusCode: 401,
  });
  const session = await tx.query(
    `SELECT id FROM handyman_care_workspace_sessions
      WHERE id = $1 AND care_actor_id = $2 AND integration_id = $3
        AND revoked_at IS NULL AND expires_at > statement_timestamp()
      FOR SHARE`,
    [principal.sessionId, principal.careActorId, principal.integrationId]);
  if (session.rowCount !== 1) throw new AppError({
    code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED,
    message: 'Care workspace authentication failed.', statusCode: 401,
  });
  const grant = await tx.query(
    `SELECT g.id
       FROM handyman_care_property_grants g
       JOIN properties p ON p.id = g.property_id AND p.status = 'ACTIVE'
       JOIN clients c ON c.id = p.client_id AND c.status = 'ACTIVE'
      WHERE g.care_actor_id = $1 AND g.property_id = $2 AND g.status = 'ACTIVE'
      FOR SHARE OF g, p, c`,
    [principal.careActorId, selection.propertyId]);
  if (grant.rowCount !== 1) throw notFound();

  // Hold the current represented occupancy through commit. This closes the
  // turnover race between the in-transaction authority check and evidence
  // insertion; the binding query below re-reads the same context while these
  // rows are locked. Building-only requests deliberately require no space row.
  const unitJoin = selection.spaceId === null ? '' : `
      JOIN tenant_space_relationships tsr
        ON tsr.tenant_company_id = tc.id AND tsr.building_id = b.id
       AND tsr.space_id = $4 AND tsr.status = 'ACTIVE'
       AND (tsr.effective_from IS NULL OR tsr.effective_from <= statement_timestamp())
       AND (tsr.effective_until IS NULL OR tsr.effective_until >= statement_timestamp())
      JOIN spaces sp ON sp.id = tsr.space_id AND sp.status = 'ACTIVE'
      JOIN rooms rm ON rm.id = sp.room_id AND rm.status = 'ACTIVE'
      JOIN areas ar ON ar.id = rm.area_id AND ar.status = 'ACTIVE'
      JOIN floors fl ON fl.id = ar.floor_id AND fl.status = 'ACTIVE'
       AND fl.building_id = b.id`;
  const lockTargets = selection.spaceId === null
    ? 'p, c, b, tc, tbc'
    : 'p, c, b, tc, tbc, tsr, sp, rm, ar, fl';
  const occupancy = await tx.query(
    `SELECT tbc.id
       FROM properties p
       JOIN clients c ON c.id = p.client_id AND c.status = 'ACTIVE'
       JOIN buildings b ON b.property_id = p.id AND b.id = $2 AND b.status = 'ACTIVE'
       JOIN tenant_companies tc ON tc.id = $3 AND tc.client_id = c.id AND tc.status = 'ACTIVE'
       JOIN tenant_building_contexts tbc
         ON tbc.tenant_company_id = tc.id AND tbc.building_id = b.id
        AND tbc.status = 'ACTIVE'
        AND (tbc.effective_from IS NULL OR tbc.effective_from <= statement_timestamp())
        AND (tbc.effective_until IS NULL OR tbc.effective_until >= statement_timestamp())
       ${unitJoin}
      WHERE p.id = $1 AND p.status = 'ACTIVE'
      FOR SHARE OF ${lockTargets}`,
    [selection.propertyId, selection.buildingId, selection.tenantCompanyId, selection.spaceId]);
  if (occupancy.rowCount !== 1) throw notFound();
}

/** Shared exact-occupancy read wall for a payment, independent of proof status. */
export async function assertCareHandymanPaymentReadContext(input: {
  principal: CareWorkspacePrincipal;
  selection: HandymanPaymentProofSelection;
  requestId: unknown;
  invoiceId?: unknown;
  paymentId: unknown;
}, executor: Pick<PoolClient, 'query'> | ReturnType<typeof getPool> = getPool()) {
  const requestId = uuid(input.requestId, 'requestId');
  const invoiceId = optionalUuid(input.invoiceId, 'invoiceId');
  const paymentId = uuid(input.paymentId, 'paymentId');
  const binding = await findBoundPayment(executor, input.principal,
    input.selection, requestId, invoiceId, paymentId, false);
  if (!binding.authenticated) throw new AppError({
    code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED,
    message: 'Care workspace authentication failed.', statusCode: 401,
  });
  if (!binding.selectedPropertyAvailable || !binding.item) throw notFound();
  return binding.item;
}

export async function assertCareHandymanPaymentProofContext(input: {
  principal: CareWorkspacePrincipal;
  selection: HandymanPaymentProofSelection;
  requestId: unknown;
  invoiceId?: unknown;
  paymentId: unknown;
}) {
  const item = await assertCareHandymanPaymentReadContext(input);
  if (item.paymentStatus !== 'PENDING') {
    throw handymanCustomerPaymentConflictError('payment-proof-requires-pending-claim');
  }
  return item;
}

export async function uploadCareHandymanPaymentProof(input: {
  principal: CareWorkspacePrincipal;
  selection: HandymanPaymentProofSelection;
  requestId: unknown;
  invoiceId?: unknown;
  paymentId: unknown;
  evidenceType: unknown;
  file: CareProofUploadFile;
}) {
  const requestId = uuid(input.requestId, 'requestId');
  const invoiceId = optionalUuid(input.invoiceId, 'invoiceId');
  const paymentId = uuid(input.paymentId, 'paymentId');
  if (!input.selection || !UUID.test(input.selection.propertyId) ||
      !UUID.test(input.selection.tenantCompanyId) || !UUID.test(input.selection.buildingId) ||
      (input.selection.spaceId !== null && !UUID.test(input.selection.spaceId))) throw invalid();
  const evidenceType = input.evidenceType;
  if (evidenceType !== 'PHOTO' && evidenceType !== 'DOCUMENT') {
    throw AppError.validation('evidenceType must be PHOTO or DOCUMENT.');
  }
  if (!input.file || !Buffer.isBuffer(input.file.buffer) || input.file.size <= 0 ||
      input.file.size > HANDYMAN_PAYMENT_PROOF_MAX_BYTES) throw invalid('A non-empty payment proof file of at most 50 MB is required.');
  if (!(EVIDENCE_MIME_BY_TYPE[evidenceType] as readonly string[]).includes(input.file.mimetype)) {
    throw AppError.badRequest('Unsupported payment proof MIME type.');
  }

  // Early deny before handling object bytes; the same join is repeated under
  // the payment row lock immediately before the durable write.
  await assertCareHandymanPaymentProofContext({
    principal: input.principal, selection: input.selection,
    requestId, invoiceId, paymentId,
  });

  const evidenceId = randomUUID();
  const storageKey = evidenceStorageKey(evidenceId);
  const contentSha256 = computeEvidenceSha256(input.file.buffer);
  const storage = createEvidenceStorage();
  let stored = false;
  let evidence: Record<string, unknown>;
  let replayed = false;
  try {
    evidence = await withTransaction(async (tx) => {
      await assertCareWriteAuthority(tx, input.principal, input.selection);
      const binding = await findBoundPayment(tx, input.principal,
        input.selection, requestId, invoiceId, paymentId, true);
      if (!binding.authenticated) throw new AppError({
        code: ERROR_CODES.HANDYMAN_CARE_WORKSPACE_UNAUTHORIZED,
        message: 'Care workspace authentication failed.', statusCode: 401,
      });
      if (!binding.selectedPropertyAvailable || !binding.item) throw notFound();
      if (binding.item.paymentStatus !== 'PENDING') {
        throw handymanCustomerPaymentConflictError('payment-proof-requires-pending-claim');
      }
      const existing = await tx.query<Record<string, unknown>>(
        `SELECT * FROM evidence_submissions
          WHERE execution_type = 'HANDYMAN_CUSTOMER_PAYMENT'
            AND execution_id = $1 FOR UPDATE`, [paymentId]);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.status === 'ACTIVE' && row.evidence_type === evidenceType &&
            row.content_sha256 === contentSha256) {
          replayed = true;
          return row;
        }
        throw handymanCustomerPaymentConflictError('payment-proof-already-bound');
      }

      await storage.put(storageKey, {
        buffer: input.file.buffer, mimeType: input.file.mimetype,
      });
      stored = true;
      const inserted = await tx.query<Record<string, unknown>>(
        `INSERT INTO evidence_submissions (
           id, client_id, evidence_requirement_id, execution_type, execution_id,
           evidence_type, file_reference, original_file_name, mime_type,
           file_size, captured_at, submitted_by_user_id, content_sha256,
           content_hashed_at, hash_algorithm
         ) VALUES ($1, $2, NULL, 'HANDYMAN_CUSTOMER_PAYMENT', $3,
                   $4, $5, $6, $7, $8, NULL, NULL, $9, NOW(), $10)
         RETURNING *`,
        [evidenceId, binding.item.clientId, paymentId, evidenceType,
          storageKey, input.file.originalname, input.file.mimetype,
          input.file.size, contentSha256, EVIDENCE_HASH_ALGORITHM]);
      await recordOperationalEvent({
        clientId: binding.item.clientId,
        buildingId: binding.item.buildingId,
        eventType: 'EVIDENCE_INTEGRITY_HASH_RECORDED',
        entityType: 'EVIDENCE_SUBMISSION',
        entityId: evidenceId,
        actorUserId: null,
        summary: 'Care uploaded a Handyman customer payment proof.',
        metadata: {
          evidenceId, paymentId, invoiceId, requestId,
          executionScopeId: binding.item.executionScopeId,
          careActorId: input.principal.careActorId,
          evidenceType, mimeType: input.file.mimetype,
          fileSize: input.file.size, contentSha256,
        },
      }, tx);
      return inserted.rows[0];
    });
  } catch (error) {
    if (stored) await storage.remove(storageKey).catch(() => undefined);
    throw error;
  }

  await applyRetentionToEvidence(String(evidence.id), null);
  return {
    proof: {
      id: evidence.id,
      executionType: evidence.execution_type,
      executionId: evidence.execution_id,
      evidenceType: evidence.evidence_type,
      originalFileName: evidence.original_file_name,
      mimeType: evidence.mime_type,
      fileSize: Number(evidence.file_size),
      submittedByUserId: evidence.submitted_by_user_id,
      status: evidence.status,
      createdAt: evidence.created_at,
      contentSha256: evidence.content_sha256,
    },
    replayed,
  };
}
