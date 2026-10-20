import { randomUUID } from 'node:crypto';
import { getPool, withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import {
  isEvidenceStorageKey,
  createEvidenceStorage,
  evidenceStorageKey,
  type EvidenceStorage,
} from '../evidence/storage';
import {
  computeEvidenceSha256,
  EVIDENCE_HASH_ALGORITHM,
} from '../evidence/evidence-integrity';
import { EVIDENCE_MIME_BY_TYPE } from '../evidence/evidence.service';
import { applyRetentionToEvidence } from '../evidence-retention-policies/evidence-retention-application.service';
import { recordOperationalEvent } from '../operational-events';
import { isValidUuid } from '../clients';
import {
  canAccessBuildingScopedResource,
} from '../context-access';
import {
  handymanCustomerTransactionNotAuthorizedError,
  handymanCustomerTransactionNotFoundError,
  handymanCustomerTransactionScopeNotFoundError,
} from '../handyman-customer-transactions';
import {
  handymanCustomerPaymentConflictError,
  handymanCustomerPaymentNotFoundError,
} from '../handyman-customer-payments/handyman-customer-payment.errors';
import { handymanCustomerPaymentRepository }
  from '../handyman-customer-payments';
import { handymanExecutionScopeRepository }
  from '../handyman-quotations';
import {
  handymanPaymentProofIntegrityConflictError,
  handymanPaymentProofNotFoundError,
} from './handyman-payment-proof.errors';

/**
 * CR-HM-FIN-DOCUMENTS-01 — Finance payment-proof READ contract.
 *
 * The missing secure retrieval door over the authoritative 0433 proof
 * row (`evidence_submissions` with `execution_type =
 * 'HANDYMAN_CUSTOMER_PAYMENT'`, written only by the Care workspace
 * upload through the shared evidence storage boundary). Storage and
 * ownership are already authoritative: this service reads, never
 * writes. No row, status, retention, integrity or financial state is
 * ever mutated from these reads.
 *
 * Authority law (same law as the CR-HM-13 payment surface):
 *  1. an unknown execution scope is a bounded 404 (never fabricated);
 *  2. an actor without access to the scope's EXACT Building is a
 *     bounded 403 `HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED`
 *     (BE-02G — no same-Client sibling shortcut, no tenant-wide grant);
 *  3. a payment that is not anchored on the scope's own ledger
 *     transaction is a bounded 404 (no cross-payment resolution);
 *  4. the proof is resolved STRICTLY as the ACTIVE evidence child of
 *     that exact payment — `execution_type = 'HANDYMAN_CUSTOMER_PAYMENT'`
 *     + `execution_id = payment.id` + `client_id = payment.client_id`
 *     + allowed `evidence_type` (PHOTO / DOCUMENT) + managed storage key
 *     + positive size + authoritative `content_sha256`. Generic Field
 *     Evidence, `WORK_ORDER` / `HANDYMAN_REQUEST` attachments, REMOVED
 *     rows, purged tombstones and rows bound to any other payment are
 *     uniformly 404 — never inferred, never substituted.
 *
 * Byte delivery validates existence, size and checksum against the
 * authoritative upload-time metadata BEFORE anything is served; corrupt
 * content is a bounded 409 and is never streamed. The response exposes
 * no storage key, no storage URL and no credential.
 */

export type HandymanPaymentProofRecord = {
  id: string;
  client_id: string;
  execution_type: string;
  execution_id: string;
  evidence_type: string;
  file_reference: string | null;
  original_file_name: string | null;
  mime_type: string | null;
  file_size: number;
  captured_at: Date | string | null;
  created_at: Date | string;
  status: string;
  content_sha256: string | null;
  hash_algorithm: string | null;
  retention_state: string | null;
};

/** Minimal payment-proof metadata: identity + integrity, never storage. */
export type HandymanPaymentProofMetadata = {
  paymentId: string;
  evidenceId: string;
  executionType: 'HANDYMAN_CUSTOMER_PAYMENT';
  executionId: string;
  clientId: string;
  evidenceType: string;
  originalFileName: string;
  mimeType: string;
  fileSize: number;
  contentSha256: string;
  hashAlgorithm: string;
  status: string;
  retentionState: string;
  capturedAt: string | null;
  createdAt: string;
};

export type HandymanPaymentProofContent = {
  metadata: HandymanPaymentProofMetadata;
  buffer: Buffer;
};

function ensureUuid(value: string, field: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(trimmed)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return trimmed;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function toPaymentProofMetadata(
  paymentId: string,
  row: HandymanPaymentProofRecord,
): HandymanPaymentProofMetadata {
  return {
    paymentId,
    evidenceId: row.id,
    executionType: 'HANDYMAN_CUSTOMER_PAYMENT',
    executionId: row.execution_id,
    clientId: row.client_id,
    evidenceType: row.evidence_type,
    originalFileName: row.original_file_name ?? 'payment-proof',
    mimeType: row.mime_type ?? 'application/octet-stream',
    fileSize: Number(row.file_size),
    contentSha256: row.content_sha256 ?? '',
    hashAlgorithm: row.hash_algorithm ?? EVIDENCE_HASH_ALGORITHM,
    status: row.status,
    retentionState: row.retention_state ?? 'ACTIVE',
    capturedAt: toIso(row.captured_at),
    createdAt: toIso(row.created_at) as string,
  };
}

/**
 * The one authorization + binding seam, shared by metadata and content
 * reads. Returns the validated proof row for the EXACT authorized
 * payment only.
 */
export async function loadAuthorizedPaymentProof(
  executionScopeId: string,
  paymentId: string,
  actorUserId: string,
): Promise<{ paymentId: string; proof: HandymanPaymentProofRecord }> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const paymentUuid = ensureUuid(paymentId, 'paymentId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');

  // CR-HM-13 access wall: unknown scope → bounded 404; no exact-Building
  // grant → bounded 403. Scope 404 precedes the access wall (module law).
  const scope = await handymanExecutionScopeRepository.findScopeById(
    undefined,
    scopeUuid,
  );
  if (!scope) throw handymanCustomerTransactionScopeNotFoundError();
  if (!(await canAccessBuildingScopedResource(actorUuid, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  }))) {
    throw handymanCustomerTransactionNotAuthorizedError();
  }

  // The payment must be anchored on the scope's own ledger transaction —
  // exactly the `decide()` identity law. A payment id belonging to any
  // other transaction/scope/client is a bounded 404, never resolved.
  const anchor = await getPool().query<{ id: string }>(
    `SELECT id FROM handyman_customer_transactions WHERE execution_scope_id = $1`,
    [scopeUuid],
  );
  const transactionId = anchor.rows[0]?.id;
  if (!transactionId) throw handymanCustomerTransactionNotFoundError();
  const payment = await handymanCustomerPaymentRepository.findPaymentById(
    undefined,
    paymentUuid,
  );
  if (
    !payment ||
    payment.transactionId !== transactionId ||
    payment.clientId !== scope.clientId
  ) {
    throw handymanCustomerPaymentNotFoundError();
  }

  // The proof is resolved STRICTLY as the bound evidence child of this
  // exact payment (0433 authority + the discovery provenance boundary).
  // Field Evidence and generic attachments never match this predicate.
  const result = await getPool().query<HandymanPaymentProofRecord>(
    `SELECT id, client_id, execution_type, execution_id, evidence_type,
            file_reference, original_file_name, mime_type, file_size,
            captured_at, created_at, status, content_sha256, hash_algorithm,
            retention_state
       FROM evidence_submissions
      WHERE execution_type = 'HANDYMAN_CUSTOMER_PAYMENT'
        AND execution_id = $1
        AND client_id = $2
        AND status = 'ACTIVE'
        AND evidence_type IN ('PHOTO', 'DOCUMENT')
        AND file_reference = 'evidence/' || id::text
        AND file_size > 0
        AND content_sha256 IS NOT NULL
        AND (retention_state IS NULL OR retention_state <> 'PURGED')
      LIMIT 1`,
    [paymentUuid, payment.clientId],
  );
  const proof = result.rows[0];
  if (!proof || !isEvidenceStorageKey(proof.file_reference ?? '')) {
    throw handymanPaymentProofNotFoundError();
  }
  return { paymentId: payment.id, proof };
}

/** Read-only proof metadata for the exact authorized payment. */
export async function getHandymanPaymentProofMetadata(
  executionScopeId: string,
  paymentId: string,
  actorUserId: string,
): Promise<HandymanPaymentProofMetadata> {
  const { paymentId: resolvedPaymentId, proof } =
    await loadAuthorizedPaymentProof(executionScopeId, paymentId, actorUserId);
  return toPaymentProofMetadata(resolvedPaymentId, proof);
}

/**
 * Read-only proof content: validates byte existence, size and checksum
 * against the authoritative upload-time metadata BEFORE returning the
 * buffer. Corrupt or truncated content is a bounded 409 and is never
 * served. Nothing is persisted; no integrity state is transitioned.
 */
export async function readHandymanPaymentProofContent(
  executionScopeId: string,
  paymentId: string,
  actorUserId: string,
  storage: EvidenceStorage = createEvidenceStorage(),
): Promise<HandymanPaymentProofContent> {
  const { paymentId: resolvedPaymentId, proof } =
    await loadAuthorizedPaymentProof(executionScopeId, paymentId, actorUserId);
  const metadata = toPaymentProofMetadata(resolvedPaymentId, proof);

  // `proof.file_reference` is the managed key `evidence/<id>` (validated
  // above and enforced by 0433); an absent object is the evidence
  // engine's own bounded 404 (EVIDENCE_FILE_NOT_FOUND).
  const stored = await storage.get(evidenceStorageKey(proof.id));

  const actualSha256 = computeEvidenceSha256(stored.buffer);
  if (stored.buffer.byteLength !== metadata.fileSize) {
    throw handymanPaymentProofIntegrityConflictError('file-size-mismatch');
  }
  if (actualSha256 !== metadata.contentSha256) {
    throw handymanPaymentProofIntegrityConflictError('checksum-mismatch');
  }
  return { metadata, buffer: stored.buffer };
}

export const HANDYMAN_EXECUTION_SCOPE_PAYMENT_PROOF_MAX_BYTES = 52_428_800;

export type UploadExecutionScopePaymentProofInput = {
  executionScopeId: string;
  paymentId: string;
  actorUserId: string;
  evidenceType: unknown;
  file: {
    buffer: Buffer;
    mimetype: string;
    originalname: string;
    size: number;
  };
};

export async function uploadExecutionScopePaymentProof(
  input: UploadExecutionScopePaymentProofInput,
  storage: EvidenceStorage = createEvidenceStorage(),
): Promise<{ paymentProof: HandymanPaymentProofMetadata; replayed: boolean }> {
  const scopeUuid = ensureUuid(input.executionScopeId, 'executionScopeId');
  const paymentUuid = ensureUuid(input.paymentId, 'paymentId');
  const actorUuid = ensureUuid(input.actorUserId, 'actorUserId');

  const evidenceType =
    typeof input.evidenceType === 'string' ? input.evidenceType.trim() : '';
  if (evidenceType !== 'PHOTO' && evidenceType !== 'DOCUMENT') {
    throw AppError.validation('evidenceType must be PHOTO or DOCUMENT.', [
      { field: 'evidenceType', message: 'evidenceType must be PHOTO or DOCUMENT.' },
    ]);
  }
  if (
    !input.file ||
    !Buffer.isBuffer(input.file.buffer) ||
    input.file.size <= 0 ||
    input.file.size > HANDYMAN_EXECUTION_SCOPE_PAYMENT_PROOF_MAX_BYTES
  ) {
    throw AppError.validation(
      'A non-empty payment proof file of at most 50 MB is required.',
    );
  }
  if (
    !(EVIDENCE_MIME_BY_TYPE[evidenceType] as readonly string[]).includes(
      input.file.mimetype,
    )
  ) {
    throw AppError.badRequest('Unsupported payment proof MIME type.');
  }

  const scope = await handymanExecutionScopeRepository.findScopeById(
    undefined,
    scopeUuid,
  );
  if (!scope) throw handymanCustomerTransactionScopeNotFoundError();
  if (
    !(await canAccessBuildingScopedResource(actorUuid, {
      clientId: scope.clientId,
      buildingId: scope.buildingId,
    }))
  ) {
    throw handymanCustomerTransactionNotAuthorizedError();
  }

  const evidenceId = randomUUID();
  const storageKey = evidenceStorageKey(evidenceId);
  const contentSha256 = computeEvidenceSha256(input.file.buffer);
  let stored = false;
  let replayed = false;
  let row: HandymanPaymentProofRecord;

  try {
    row = await withTransaction(async (tx) => {
      const anchor = await tx.query<{ id: string }>(
        `SELECT id FROM handyman_customer_transactions WHERE execution_scope_id = $1`,
        [scopeUuid],
      );
      const transactionId = anchor.rows[0]?.id;
      if (!transactionId) throw handymanCustomerTransactionNotFoundError();

      const payment = await handymanCustomerPaymentRepository.findPaymentById(
        tx,
        paymentUuid,
        true,
      );
      if (
        !payment ||
        payment.transactionId !== transactionId ||
        payment.clientId !== scope.clientId
      ) {
        throw handymanCustomerPaymentNotFoundError();
      }
      if (payment.status !== 'PENDING') {
        throw handymanCustomerPaymentConflictError(
          'payment-proof-requires-pending-claim',
        );
      }

      const existing = await tx.query<HandymanPaymentProofRecord>(
        `SELECT id, client_id, execution_type, execution_id, evidence_type,
                file_reference, original_file_name, mime_type, file_size,
                captured_at, created_at, status, content_sha256, hash_algorithm,
                retention_state
           FROM evidence_submissions
          WHERE execution_type = 'HANDYMAN_CUSTOMER_PAYMENT'
            AND execution_id = $1
          FOR UPDATE`,
        [paymentUuid],
      );
      if (existing.rows[0]) {
        const cur = existing.rows[0];
        if (
          cur.status === 'ACTIVE' &&
          cur.evidence_type === evidenceType &&
          cur.content_sha256 === contentSha256
        ) {
          replayed = true;
          return cur;
        }
        throw handymanCustomerPaymentConflictError('payment-proof-already-bound');
      }

      await storage.put(storageKey, {
        buffer: input.file.buffer,
        mimeType: input.file.mimetype,
      });
      stored = true;

      const inserted = await tx.query<HandymanPaymentProofRecord>(
        `INSERT INTO evidence_submissions (
           id, client_id, evidence_requirement_id, execution_type, execution_id,
           evidence_type, file_reference, original_file_name, mime_type,
           file_size, captured_at, submitted_by_user_id, content_sha256,
           content_hashed_at, hash_algorithm
         ) VALUES ($1, $2, NULL, 'HANDYMAN_CUSTOMER_PAYMENT', $3,
                   $4, $5, $6, $7, $8, NULL, $9, $10, NOW(), $11)
         RETURNING id, client_id, execution_type, execution_id, evidence_type,
                   file_reference, original_file_name, mime_type, file_size,
                   captured_at, created_at, status, content_sha256, hash_algorithm,
                   retention_state`,
        [
          evidenceId,
          scope.clientId,
          paymentUuid,
          evidenceType,
          storageKey,
          input.file.originalname,
          input.file.mimetype,
          input.file.size,
          actorUuid,
          contentSha256,
          EVIDENCE_HASH_ALGORITHM,
        ],
      );

      await recordOperationalEvent(
        {
          clientId: scope.clientId,
          buildingId: scope.buildingId,
          eventType: 'EVIDENCE_INTEGRITY_HASH_RECORDED',
          entityType: 'EVIDENCE_SUBMISSION',
          entityId: evidenceId,
          actorUserId: actorUuid,
          summary: 'Uploaded a Handyman customer payment proof.',
          metadata: {
            evidenceId,
            paymentId: paymentUuid,
            executionScopeId: scopeUuid,
            requestId: scope.handymanRequestId,
            obligationStage: payment.obligationStage,
            evidenceType,
            mimeType: input.file.mimetype,
            fileSize: input.file.size,
            contentSha256,
          },
        },
        tx,
      );
      return inserted.rows[0];
    });
  } catch (error) {
    if (stored) await storage.remove(storageKey).catch(() => undefined);
    throw error;
  }

  await applyRetentionToEvidence(String(row.id), actorUuid);
  return {
    paymentProof: toPaymentProofMetadata(paymentUuid, row),
    replayed,
  };
}

export const handymanPaymentProofService = {
  getHandymanPaymentProofMetadata,
  loadAuthorizedPaymentProof,
  readHandymanPaymentProofContent,
  toPaymentProofMetadata,
  uploadExecutionScopePaymentProof,
};
