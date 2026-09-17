import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanMaterialAddendumStatus,
  HandymanMaterialApprovalRecord,
  HandymanMaterialApprovalStatus,
  HandymanMaterialCancellationReason,
  HandymanMaterialCommercialAddendumRecord,
  HandymanMaterialDemandRecord,
  HandymanMaterialDemandStatus,
  HandymanMaterialSupplySource,
} from './handyman-material-demand.types';

type Executor = Pick<PoolClient, 'query'>;

const ADDENDUM_SELECT = `
  id,
  client_id AS "clientId",
  handyman_job_id AS "handymanJobId",
  handyman_request_id AS "handymanRequestId",
  building_id AS "buildingId",
  supply_source AS "supplySource",
  commercial_basis AS "commercialBasis",
  inventory_item_id AS "inventoryItemId",
  uom_id AS "uomId",
  description,
  quantity,
  currency,
  unit_commercial_amount AS "unitCommercialAmount",
  total_commercial_amount AS "totalCommercialAmount",
  reference_price_catalog_entry_id AS "referencePriceCatalogEntryId",
  reference_scope_tier AS "referenceScopeTier",
  reference_as_of AS "referenceAsOf",
  status,
  supersedes_addendum_id AS "supersedesAddendumId",
  superseded_at AS "supersededAt",
  superseded_by_user_id AS "supersededByUserId",
  cancelled_at AS "cancelledAt",
  cancelled_by_user_id AS "cancelledByUserId",
  cancellation_reason AS "cancellationReason",
  idempotency_key AS "idempotencyKey",
  idempotency_fingerprint AS "idempotencyFingerprint",
  cancellation_idempotency_key AS "cancellationIdempotencyKey",
  cancellation_idempotency_fingerprint AS "cancellationIdempotencyFingerprint",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const APPROVAL_SELECT = `
  id,
  client_id AS "clientId",
  handyman_job_id AS "handymanJobId",
  handyman_request_id AS "handymanRequestId",
  building_id AS "buildingId",
  commercial_addendum_id AS "commercialAddendumId",
  status,
  method,
  approved_for_type AS "approvedForType",
  approved_for_tenant_company_id AS "approvedForTenantCompanyId",
  approved_for_tenant_pic_id AS "approvedForTenantPicId",
  approved_for_name AS "approvedForName",
  decision_notes AS "decisionNotes",
  recorded_by_user_id AS "recordedByUserId",
  decided_at AS "decidedAt",
  cancelled_at AS "cancelledAt",
  cancelled_by_user_id AS "cancelledByUserId",
  decision_idempotency_key AS "decisionIdempotencyKey",
  decision_idempotency_fingerprint AS "decisionIdempotencyFingerprint",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const DEMAND_SELECT = `
  id,
  client_id AS "clientId",
  handyman_job_id AS "handymanJobId",
  handyman_request_id AS "handymanRequestId",
  building_id AS "buildingId",
  supply_source AS "supplySource",
  commercial_basis AS "commercialBasis",
  source_context AS "sourceContext",
  inventory_item_id AS "inventoryItemId",
  uom_id AS "uomId",
  description,
  quantity,
  handyman_service_visit_id AS "handymanServiceVisitId",
  quotation_revision_id AS "quotationRevisionId",
  handyman_quotation_line_id AS "handymanQuotationLineId",
  commercial_addendum_id AS "commercialAddendumId",
  handyman_material_approval_id AS "handymanMaterialApprovalId",
  status,
  supersedes_demand_id AS "supersedesDemandId",
  superseded_at AS "supersededAt",
  superseded_by_user_id AS "supersededByUserId",
  cancelled_at AS "cancelledAt",
  cancelled_by_user_id AS "cancelledByUserId",
  cancellation_reason AS "cancellationReason",
  idempotency_key AS "idempotencyKey",
  idempotency_fingerprint AS "idempotencyFingerprint",
  cancellation_idempotency_key AS "cancellationIdempotencyKey",
  cancellation_idempotency_fingerprint AS "cancellationIdempotencyFingerprint",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export type NewHandymanMaterialCommercialAddendum = {
  clientId: string;
  handymanJobId: string;
  handymanRequestId: string;
  buildingId: string;
  supplySource: HandymanMaterialSupplySource;
  inventoryItemId: string | null;
  uomId: string;
  description: string;
  quantity: string;
  currency: string | null;
  unitCommercialAmount: string | null;
  referencePriceCatalogEntryId: string | null;
  referenceScopeTier: string | null;
  referenceAsOf: Date | null;
  supersedesAddendumId: string | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdByUserId: string;
};

export type NewHandymanMaterialDemand = {
  clientId: string;
  handymanJobId: string;
  handymanRequestId: string;
  buildingId: string;
  supplySource: HandymanMaterialSupplySource;
  commercialBasis: string;
  sourceContext: string;
  inventoryItemId: string | null;
  uomId: string;
  description: string;
  quantity: string;
  handymanServiceVisitId: string | null;
  quotationRevisionId: string | null;
  handymanQuotationLineId: string | null;
  commercialAddendumId: string | null;
  handymanMaterialApprovalId: string | null;
  supersedesDemandId: string | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdByUserId: string;
};

async function findAddendumById(
  id: string,
  executor: Executor = getPool(),
): Promise<HandymanMaterialCommercialAddendumRecord | null> {
  const result = await executor.query<HandymanMaterialCommercialAddendumRecord>(
    `SELECT ${ADDENDUM_SELECT}
     FROM handyman_material_commercial_addenda
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function lockAddendumById(
  id: string,
  executor: Executor,
): Promise<HandymanMaterialCommercialAddendumRecord | null> {
  const result = await executor.query<HandymanMaterialCommercialAddendumRecord>(
    `SELECT ${ADDENDUM_SELECT}
     FROM handyman_material_commercial_addenda
     WHERE id = $1
     FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findAddendumByIdempotencyKey(
  clientId: string,
  idempotencyKey: string,
  executor: Executor = getPool(),
): Promise<HandymanMaterialCommercialAddendumRecord | null> {
  const result = await executor.query<HandymanMaterialCommercialAddendumRecord>(
    `SELECT ${ADDENDUM_SELECT}
     FROM handyman_material_commercial_addenda
     WHERE client_id = $1 AND idempotency_key = $2`,
    [clientId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function findAddendumByCancellationIdempotencyKey(
  clientId: string,
  idempotencyKey: string,
  executor: Executor = getPool(),
): Promise<HandymanMaterialCommercialAddendumRecord | null> {
  const result = await executor.query<HandymanMaterialCommercialAddendumRecord>(
    `SELECT ${ADDENDUM_SELECT}
     FROM handyman_material_commercial_addenda
     WHERE client_id = $1 AND cancellation_idempotency_key = $2`,
    [clientId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function listAddendaByJob(
  handymanJobId: string,
  executor: Executor = getPool(),
): Promise<HandymanMaterialCommercialAddendumRecord[]> {
  const result = await executor.query<HandymanMaterialCommercialAddendumRecord>(
    `SELECT ${ADDENDUM_SELECT}
     FROM handyman_material_commercial_addenda
     WHERE handyman_job_id = $1
     ORDER BY created_at ASC, id ASC`,
    [handymanJobId],
  );
  return result.rows;
}

/** Inserts one immutable PENDING addendum; returns null only on same-key race. */
async function createAddendum(
  input: NewHandymanMaterialCommercialAddendum,
  executor: Executor,
): Promise<HandymanMaterialCommercialAddendumRecord | null> {
  const result = await executor.query<HandymanMaterialCommercialAddendumRecord>(
    `INSERT INTO handyman_material_commercial_addenda
       (id, client_id, handyman_job_id, handyman_request_id, building_id,
        supply_source, inventory_item_id, uom_id, description, quantity,
        currency, unit_commercial_amount, reference_price_catalog_entry_id,
        reference_scope_tier, reference_as_of, supersedes_addendum_id,
        idempotency_key, idempotency_fingerprint, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17, $18, $19)
     ON CONFLICT (client_id, idempotency_key) DO NOTHING
     RETURNING ${ADDENDUM_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.handymanJobId,
      input.handymanRequestId,
      input.buildingId,
      input.supplySource,
      input.inventoryItemId,
      input.uomId,
      input.description,
      input.quantity,
      input.currency,
      input.unitCommercialAmount,
      input.referencePriceCatalogEntryId,
      input.referenceScopeTier,
      input.referenceAsOf,
      input.supersedesAddendumId,
      input.idempotencyKey,
      input.idempotencyFingerprint,
      input.createdByUserId,
    ],
  );
  return result.rows[0] ?? null;
}

async function createPendingApproval(
  input: {
    clientId: string;
    handymanJobId: string;
    handymanRequestId: string;
    buildingId: string;
    commercialAddendumId: string;
    createdByUserId: string;
  },
  executor: Executor,
): Promise<HandymanMaterialApprovalRecord> {
  const result = await executor.query<HandymanMaterialApprovalRecord>(
    `INSERT INTO handyman_material_approvals
       (id, client_id, handyman_job_id, handyman_request_id, building_id,
        commercial_addendum_id, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${APPROVAL_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.handymanJobId,
      input.handymanRequestId,
      input.buildingId,
      input.commercialAddendumId,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findApprovalById(
  id: string,
  executor: Executor = getPool(),
): Promise<HandymanMaterialApprovalRecord | null> {
  const result = await executor.query<HandymanMaterialApprovalRecord>(
    `SELECT ${APPROVAL_SELECT}
     FROM handyman_material_approvals
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function lockApprovalById(
  id: string,
  executor: Executor,
): Promise<HandymanMaterialApprovalRecord | null> {
  const result = await executor.query<HandymanMaterialApprovalRecord>(
    `SELECT ${APPROVAL_SELECT}
     FROM handyman_material_approvals
     WHERE id = $1
     FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findApprovalByAddendumId(
  commercialAddendumId: string,
  executor: Executor = getPool(),
): Promise<HandymanMaterialApprovalRecord | null> {
  const result = await executor.query<HandymanMaterialApprovalRecord>(
    `SELECT ${APPROVAL_SELECT}
     FROM handyman_material_approvals
     WHERE commercial_addendum_id = $1`,
    [commercialAddendumId],
  );
  return result.rows[0] ?? null;
}

async function lockApprovalByAddendumId(
  commercialAddendumId: string,
  executor: Executor,
): Promise<HandymanMaterialApprovalRecord | null> {
  const result = await executor.query<HandymanMaterialApprovalRecord>(
    `SELECT ${APPROVAL_SELECT}
     FROM handyman_material_approvals
     WHERE commercial_addendum_id = $1
     FOR UPDATE`,
    [commercialAddendumId],
  );
  return result.rows[0] ?? null;
}

async function findApprovalByDecisionIdempotencyKey(
  clientId: string,
  idempotencyKey: string,
  executor: Executor = getPool(),
): Promise<HandymanMaterialApprovalRecord | null> {
  const result = await executor.query<HandymanMaterialApprovalRecord>(
    `SELECT ${APPROVAL_SELECT}
     FROM handyman_material_approvals
     WHERE client_id = $1 AND decision_idempotency_key = $2`,
    [clientId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function decideApprovalFromPending(
  id: string,
  fields: {
    status: Extract<HandymanMaterialApprovalStatus, 'APPROVED' | 'REJECTED'>;
    method: 'IN_APP' | 'ASSISTED';
    approvedForType: string;
    approvedForTenantCompanyId: string | null;
    approvedForTenantPicId: string | null;
    approvedForName: string;
    decisionNotes: string | null;
    recordedByUserId: string | null;
    decisionIdempotencyKey: string;
    decisionIdempotencyFingerprint: string;
  },
  executor: Executor,
): Promise<HandymanMaterialApprovalRecord | null> {
  const result = await executor.query<HandymanMaterialApprovalRecord>(
    `UPDATE handyman_material_approvals
     SET status = $2,
         method = $3,
         approved_for_type = $4,
         approved_for_tenant_company_id = $5,
         approved_for_tenant_pic_id = $6,
         approved_for_name = $7,
         decision_notes = $8,
         recorded_by_user_id = $9,
         decided_at = NOW(),
         decision_idempotency_key = $10,
         decision_idempotency_fingerprint = $11,
         updated_at = NOW()
     WHERE id = $1 AND status = 'PENDING'
     RETURNING ${APPROVAL_SELECT}`,
    [
      id,
      fields.status,
      fields.method,
      fields.approvedForType,
      fields.approvedForTenantCompanyId,
      fields.approvedForTenantPicId,
      fields.approvedForName,
      fields.decisionNotes,
      fields.recordedByUserId,
      fields.decisionIdempotencyKey,
      fields.decisionIdempotencyFingerprint,
    ],
  );
  return result.rows[0] ?? null;
}

async function cancelPendingApproval(
  id: string,
  actorUserId: string,
  executor: Executor,
): Promise<HandymanMaterialApprovalRecord | null> {
  const result = await executor.query<HandymanMaterialApprovalRecord>(
    `UPDATE handyman_material_approvals
     SET status = 'CANCELLED',
         cancelled_at = NOW(),
         cancelled_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'PENDING'
     RETURNING ${APPROVAL_SELECT}`,
    [id, actorUserId],
  );
  return result.rows[0] ?? null;
}

async function transitionPendingAddendum(
  id: string,
  status: Extract<
    HandymanMaterialAddendumStatus,
    'APPROVED' | 'REJECTED' | 'SUPERSEDED'
  >,
  actorUserId: string,
  executor: Executor,
): Promise<HandymanMaterialCommercialAddendumRecord | null> {
  const sets =
    status === 'SUPERSEDED'
      ? `status = 'SUPERSEDED',
         superseded_at = NOW(),
         superseded_by_user_id = $2,
         updated_at = NOW()`
      : `status = $2,
         updated_at = NOW()`;
  const values =
    status === 'SUPERSEDED' ? [id, actorUserId] : [id, status];
  const result = await executor.query<HandymanMaterialCommercialAddendumRecord>(
    `UPDATE handyman_material_commercial_addenda
     SET ${sets}
     WHERE id = $1 AND status = 'PENDING'
     RETURNING ${ADDENDUM_SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

async function cancelPendingAddendum(
  id: string,
  fields: {
    actorUserId: string;
    reason: HandymanMaterialCancellationReason;
    idempotencyKey: string;
    idempotencyFingerprint: string;
  },
  executor: Executor,
): Promise<HandymanMaterialCommercialAddendumRecord | null> {
  const result = await executor.query<HandymanMaterialCommercialAddendumRecord>(
    `UPDATE handyman_material_commercial_addenda
     SET status = 'CANCELLED',
         cancelled_at = NOW(),
         cancelled_by_user_id = $2,
         cancellation_reason = $3,
         cancellation_idempotency_key = $4,
         cancellation_idempotency_fingerprint = $5,
         updated_at = NOW()
     WHERE id = $1 AND status = 'PENDING'
     RETURNING ${ADDENDUM_SELECT}`,
    [
      id,
      fields.actorUserId,
      fields.reason,
      fields.idempotencyKey,
      fields.idempotencyFingerprint,
    ],
  );
  return result.rows[0] ?? null;
}

async function findDemandById(
  id: string,
  executor: Executor = getPool(),
): Promise<HandymanMaterialDemandRecord | null> {
  const result = await executor.query<HandymanMaterialDemandRecord>(
    `SELECT ${DEMAND_SELECT}
     FROM handyman_material_demands
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function lockDemandById(
  id: string,
  executor: Executor,
): Promise<HandymanMaterialDemandRecord | null> {
  const result = await executor.query<HandymanMaterialDemandRecord>(
    `SELECT ${DEMAND_SELECT}
     FROM handyman_material_demands
     WHERE id = $1
     FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findDemandByIdempotencyKey(
  clientId: string,
  idempotencyKey: string,
  executor: Executor = getPool(),
): Promise<HandymanMaterialDemandRecord | null> {
  const result = await executor.query<HandymanMaterialDemandRecord>(
    `SELECT ${DEMAND_SELECT}
     FROM handyman_material_demands
     WHERE client_id = $1 AND idempotency_key = $2`,
    [clientId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function findDemandByCancellationIdempotencyKey(
  clientId: string,
  idempotencyKey: string,
  executor: Executor = getPool(),
): Promise<HandymanMaterialDemandRecord | null> {
  const result = await executor.query<HandymanMaterialDemandRecord>(
    `SELECT ${DEMAND_SELECT}
     FROM handyman_material_demands
     WHERE client_id = $1 AND cancellation_idempotency_key = $2`,
    [clientId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function findDemandByQuotationLine(
  handymanJobId: string,
  handymanQuotationLineId: string,
  executor: Executor = getPool(),
): Promise<HandymanMaterialDemandRecord | null> {
  const result = await executor.query<HandymanMaterialDemandRecord>(
    `SELECT ${DEMAND_SELECT}
     FROM handyman_material_demands
     WHERE handyman_job_id = $1
       AND handyman_quotation_line_id = $2
       AND commercial_basis = 'QUOTATION_INCLUDED'
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [handymanJobId, handymanQuotationLineId],
  );
  return result.rows[0] ?? null;
}

async function findDemandByApprovalId(
  handymanMaterialApprovalId: string,
  executor: Executor = getPool(),
): Promise<HandymanMaterialDemandRecord | null> {
  const result = await executor.query<HandymanMaterialDemandRecord>(
    `SELECT ${DEMAND_SELECT}
     FROM handyman_material_demands
     WHERE handyman_material_approval_id = $1`,
    [handymanMaterialApprovalId],
  );
  return result.rows[0] ?? null;
}

async function listDemandsByJob(
  handymanJobId: string,
  executor: Executor = getPool(),
): Promise<HandymanMaterialDemandRecord[]> {
  const result = await executor.query<HandymanMaterialDemandRecord>(
    `SELECT ${DEMAND_SELECT}
     FROM handyman_material_demands
     WHERE handyman_job_id = $1
     ORDER BY created_at ASC, id ASC`,
    [handymanJobId],
  );
  return result.rows;
}

/** Inserts one ACTIVE demand; null is exclusively same client-key convergence. */
async function createDemand(
  input: NewHandymanMaterialDemand,
  executor: Executor,
): Promise<HandymanMaterialDemandRecord | null> {
  const result = await executor.query<HandymanMaterialDemandRecord>(
    `INSERT INTO handyman_material_demands
       (id, client_id, handyman_job_id, handyman_request_id, building_id,
        supply_source, commercial_basis, source_context, inventory_item_id,
        uom_id, description, quantity, handyman_service_visit_id,
        quotation_revision_id, handyman_quotation_line_id,
        commercial_addendum_id, handyman_material_approval_id,
        supersedes_demand_id, idempotency_key, idempotency_fingerprint,
        created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (client_id, idempotency_key) DO NOTHING
     RETURNING ${DEMAND_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.handymanJobId,
      input.handymanRequestId,
      input.buildingId,
      input.supplySource,
      input.commercialBasis,
      input.sourceContext,
      input.inventoryItemId,
      input.uomId,
      input.description,
      input.quantity,
      input.handymanServiceVisitId,
      input.quotationRevisionId,
      input.handymanQuotationLineId,
      input.commercialAddendumId,
      input.handymanMaterialApprovalId,
      input.supersedesDemandId,
      input.idempotencyKey,
      input.idempotencyFingerprint,
      input.createdByUserId,
    ],
  );
  return result.rows[0] ?? null;
}

async function supersedeActiveDemand(
  id: string,
  actorUserId: string,
  executor: Executor,
): Promise<HandymanMaterialDemandRecord | null> {
  const result = await executor.query<HandymanMaterialDemandRecord>(
    `UPDATE handyman_material_demands
     SET status = 'SUPERSEDED',
         superseded_at = NOW(),
         superseded_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${DEMAND_SELECT}`,
    [id, actorUserId],
  );
  return result.rows[0] ?? null;
}

async function cancelActiveDemand(
  id: string,
  fields: {
    actorUserId: string;
    reason: HandymanMaterialCancellationReason;
    idempotencyKey: string;
    idempotencyFingerprint: string;
  },
  executor: Executor,
): Promise<HandymanMaterialDemandRecord | null> {
  const result = await executor.query<HandymanMaterialDemandRecord>(
    `UPDATE handyman_material_demands
     SET status = 'CANCELLED',
         cancelled_at = NOW(),
         cancelled_by_user_id = $2,
         cancellation_reason = $3,
         cancellation_idempotency_key = $4,
         cancellation_idempotency_fingerprint = $5,
         updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${DEMAND_SELECT}`,
    [
      id,
      fields.actorUserId,
      fields.reason,
      fields.idempotencyKey,
      fields.idempotencyFingerprint,
    ],
  );
  return result.rows[0] ?? null;
}

export const handymanMaterialDemandRepository = {
  createAddendum,
  findAddendumByCancellationIdempotencyKey,
  findAddendumById,
  findAddendumByIdempotencyKey,
  listAddendaByJob,
  lockAddendumById,
  transitionPendingAddendum,
  cancelPendingAddendum,
  createPendingApproval,
  findApprovalByAddendumId,
  findApprovalByDecisionIdempotencyKey,
  findApprovalById,
  lockApprovalByAddendumId,
  lockApprovalById,
  decideApprovalFromPending,
  cancelPendingApproval,
  createDemand,
  findDemandByQuotationLine,
  findDemandByApprovalId,
  findDemandByCancellationIdempotencyKey,
  findDemandById,
  findDemandByIdempotencyKey,
  listDemandsByJob,
  lockDemandById,
  supersedeActiveDemand,
  cancelActiveDemand,
};
